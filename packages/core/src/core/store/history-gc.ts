import type { Database } from "better-sqlite3";
import type { Store } from "./store.js";
import { explicitEntries, parseNodeText } from "./delta.js";

// The recorder's collection (spec/store §7 — the history bundle, modular-core
// Phase 4a; `gc.ts` kept this through Phase 3). Mark-and-sweep from the LIVE
// revision roots removes unreachable blobs and tree_nodes. Through 14.x nothing
// was ever unreachable (revisions were never pruned); since 15.0 the retention
// squash (`archive.ts`) NULLs an archived revision's `root_tree`/
// `frontmatter_blob` after copying its bodies to a segment, so the mark —
// which walks every non-NULL root — leaves exactly those bodies behind, and
// the squash runs the same sweep inside its transaction. The `same` rows a
// 14.1 store persisted are swept here too (14.2). Reached by the core only
// through `HistoryRecorder.collect`.

/**
 * The mark (spec/store §7): every tree node reachable from a live revision's
 * `root_tree` (walking `child_tree_hash_hex`) and every blob those nodes name
 * (raw + trivia) plus every live `frontmatter_blob`. An archived revision
 * (`root_tree IS NULL`, 15.0) contributes nothing — its bodies live in its
 * segment.
 */
export function markReachable(store: Store): { trees: Set<string>; blobs: Set<string> } {
  const trees = new Set<string>();
  const blobs = new Set<string>();

  const fmRows = store.db.prepare("SELECT DISTINCT frontmatter_blob FROM revisions WHERE frontmatter_blob IS NOT NULL").all() as { frontmatter_blob: Buffer }[];
  for (const r of fmRows) blobs.add(r.frontmatter_blob.toString("hex"));

  const walk = explicitWalker(store.db, trees, blobs);
  const roots = store.db.prepare("SELECT DISTINCT root_tree FROM revisions WHERE root_tree IS NOT NULL").all() as { root_tree: Buffer }[];
  for (const r of roots) walk(r.root_tree.toString("hex"));

  return { trees, blobs };
}

/**
 * The EXPLICIT mark (spec/store §7, 16.0): a walk from a node over the objects
 * its text names on its own — every entry of a `[`-node, the `+`/`~` entries of
 * a `{`-node — recursing into the child hashes those entries carry. What a
 * delta keeps "as the base" is the base revision's to mark, and the
 * base-liveness rule (§4.4) keeps that revision live while the delta is.
 * Returns the walker; `trees`/`blobs` collect hex hashes.
 */
export function explicitWalker(db: Database, trees: Set<string>, blobs: Set<string>, onNode?: (hashHex: string, entries: string) => void): (hashHex: string) => void {
  const treeNode = db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?");
  const walk = (hashHex: string): void => {
    if (trees.has(hashHex)) return;
    trees.add(hashHex);
    const node = treeNode.get(Buffer.from(hashHex, "hex")) as { entries: string } | undefined;
    if (!node) return;
    onNode?.(hashHex, node.entries);
    const parsed = parseNodeText(node.entries);
    if (!parsed) return;
    for (const [, rawHashHex, childHashHex, , , triviaHashHex] of explicitEntries(parsed)) {
      blobs.add(rawHashHex);
      if (triviaHashHex) blobs.add(triviaHashHex);
      if (childHashHex) walk(childHashHex);
    }
  };
  return walk;
}

/**
 * The sweep: delete every `tree_nodes` and `blobs` row the mark did not reach
 * (count only when `dry`). Runs in the caller's transaction — `runGc` and the
 * retention squash both call it.
 */
export function sweepUnreachable(store: Store, dry = false): { blobsSwept: number; treeNodesSwept: number } {
  const db = store.db;
  // The mark: every body a live revision reaches (the core's rows hold their
  // own bytes since 17.0 — nothing a `blocks` row holds is swept here).
  const { trees, blobs } = markReachable(store);

  let treeNodesSwept = 0;
  const allTrees = db.prepare("SELECT hash FROM tree_nodes").all() as { hash: Buffer }[];
  const delTree = db.prepare("DELETE FROM tree_nodes WHERE hash = ?");
  for (const t of allTrees) if (!trees.has(t.hash.toString("hex"))) { if (!dry) delTree.run(t.hash); treeNodesSwept++; }

  let blobsSwept = 0;
  const allBlobs = db.prepare("SELECT hash FROM blobs").all() as { hash: Buffer }[];
  const delBlob = db.prepare("DELETE FROM blobs WHERE hash = ?");
  for (const b of allBlobs) if (!blobs.has(b.hash.toString("hex"))) { if (!dry) delBlob.run(b.hash); blobsSwept++; }

  return { blobsSwept, treeNodesSwept };
}

/** The `same` rows a store through 14.1 persisted (spec/store §7, 14.2). */
export function countSameDispositions(store: Store): number {
  return (store.db.prepare("SELECT count(*) AS c FROM dispositions WHERE kind = 'same'").get() as { c: number }).c;
}


/**
 * The recorder's half of `omg gc` (spec/store §7, §7.1 — `HistoryRecorder.
 * collect`): the sweep of unreachable bodies and of a 14.1 store's `same`
 * rows, counted only when `dry`. Runs in the caller's transaction.
 */
export function collectHistory(store: Store, dry: boolean): { blobsSwept: number; treeNodesSwept: number; sameDispositionsSwept: number } {
  const { blobsSwept, treeNodesSwept } = sweepUnreachable(store, dry);
  const sameDispositionsSwept = countSameDispositions(store);
  if (!dry && sameDispositionsSwept > 0) {
    store.db.prepare("DELETE FROM block_changes WHERE kind = 'same'").run();
    store.db.prepare("DELETE FROM dispositions WHERE kind = 'same'").run();
  }
  return { blobsSwept, treeNodesSwept, sameDispositionsSwept };
}
