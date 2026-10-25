import type { Database } from "better-sqlite3";
import type { Store } from "./store.js";
import { explicitEntries, parseNodeText } from "./delta.js";
import { requireHistory } from "../capabilities/registry.js";

// Garbage collection (spec/store §7). Mark-and-sweep from the LIVE revision
// roots removes unreachable blobs and tree_nodes. Through 14.x nothing was ever
// unreachable (revisions were never pruned); since 15.0 the retention squash
// (`archive.ts`) NULLs an archived revision's `root_tree`/`frontmatter_blob`
// after copying its bodies to a segment, so the mark — which walks every
// non-NULL root — leaves exactly those bodies behind, and the squash runs the
// same sweep inside its transaction. `omg gc` itself still ships behind a flag.
// The resurrection-pool expiry sweep is the one collection that runs routinely.

export interface GcResult {
  blobsSwept: number;
  treeNodesSwept: number;
  /** spec/store §7 (14.2): `same` rows a 14.1 store wrote into `dispositions`/`block_changes` — history nothing reads. */
  sameDispositionsSwept: number;
  /** spec/store §7.3 (17.0): the core holds released from `id_claims` under `identity.claims_retain_days` (0 while the setting is null). */
  claimsReleased: number;
}

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
  // The mark is the recorder's (`HistoryRecorder.markReachable` — M7 adds the
  // core's own roots, live/tombstoned `blocks` and the heads' frontmatter, in
  // Phase 3; inventory-ts §2.2 rows `markReachable`/`sweepUnreachable`).
  const { trees, blobs } = requireHistory(db).markReachable();

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
 * Mark-and-sweep GC (flag-gated; enabled must be true to run — v1.0 ships it
 * off). Removes blobs/tree_nodes unreachable from any live revision root. In a
 * store that never archived, nothing is unreachable — revisions are append-only
 * — so that half is a no-op; after a retention squash (15.0) the squash has
 * already swept, so it is a no-op again unless a crash interrupted one.
 * Rebuild-equivalence is preserved.
 *
 * spec/store §7 (14.2): the same sweep deletes every `same` row of
 * `dispositions` and `block_changes` — what a 14.1 store wrote for every
 * untouched block of every commit, and nothing reads (`updated_at` and
 * `blocks_history` are the block's own changes now). Not a migration: a
 * data-only change needs no `user_version`, and opening a database must never
 * bulk-delete. `dryRun` counts everything and deletes nothing.
 *
 * spec/store §7.3 (17.0): the same run prunes `id_claims` under the
 * installation's `identity.claims_retain_days` (`IdentityClaims.prune` at
 * `now`, the clock) — the one collection the core owns.
 */
export function runGc(store: Store, opts: { enabled?: boolean; dryRun?: boolean; now?: string } = {}): GcResult {
  if (!opts.enabled) return { blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0 };
  return store.write((db): GcResult => {
    const dry = Boolean(opts.dryRun);
    const { blobsSwept, treeNodesSwept } = sweepUnreachable(store, dry);

    const sameDispositionsSwept = countSameDispositions(store);
    if (!dry && sameDispositionsSwept > 0) {
      db.prepare("DELETE FROM block_changes WHERE kind = 'same'").run();
      db.prepare("DELETE FROM dispositions WHERE kind = 'same'").run();
    }

    // spec/store §7.3 (17.0): the claims prune — the core's hold released on
    // every claim older than `identity.claims_retain_days` that names no core
    // row; nothing while the setting is null. A dry run releases nothing and
    // counts nothing (the count is the release's own `changes`).
    const claimsReleased = dry ? 0 : store.capabilities.claims.prune(opts.now ?? new Date().toISOString());

    return { blobsSwept, treeNodesSwept, sameDispositionsSwept, claimsReleased };
  });
}

/** Resurrection-pool expiry sweep (02 §7): drop rows past their expires_ts.
 * Runs routinely (lazy, at checkpoint time). */
export function sweepResurrectionPool(store: Store, nowIso: string): number {
  const res = store.db.prepare("DELETE FROM resurrection_pool WHERE expires_ts <= ?").run(nowIso);
  return res.changes;
}
