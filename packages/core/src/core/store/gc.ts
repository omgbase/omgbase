import type { Store } from "./store.js";

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

  const treeNode = store.db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?");
  const walk = (hashHex: string): void => {
    if (trees.has(hashHex)) return;
    trees.add(hashHex);
    const node = treeNode.get(Buffer.from(hashHex, "hex")) as { entries: string } | undefined;
    if (!node) return;
    const entries = JSON.parse(node.entries) as [string, string, string | null, string, string, string | null][];
    for (const [, rawHashHex, childHashHex, , , triviaHashHex] of entries) {
      blobs.add(rawHashHex);
      if (triviaHashHex) blobs.add(triviaHashHex);
      if (childHashHex) walk(childHashHex);
    }
  };

  const roots = store.db.prepare("SELECT DISTINCT root_tree FROM revisions WHERE root_tree IS NOT NULL").all() as { root_tree: Buffer }[];
  for (const r of roots) walk(r.root_tree.toString("hex"));

  return { trees, blobs };
}

/**
 * The sweep: delete every `tree_nodes` and `blobs` row the mark did not reach
 * (count only when `dry`). Runs in the caller's transaction — `runGc` and the
 * retention squash both call it.
 */
export function sweepUnreachable(store: Store, dry = false): { blobsSwept: number; treeNodesSwept: number } {
  const db = store.db;
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
 */
export function runGc(store: Store, opts: { enabled?: boolean; dryRun?: boolean } = {}): GcResult {
  if (!opts.enabled) return { blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0 };
  return store.write((db): GcResult => {
    const dry = Boolean(opts.dryRun);
    const { blobsSwept, treeNodesSwept } = sweepUnreachable(store, dry);

    const sameDispositionsSwept = countSameDispositions(store);
    if (!dry && sameDispositionsSwept > 0) {
      db.prepare("DELETE FROM block_changes WHERE kind = 'same'").run();
      db.prepare("DELETE FROM dispositions WHERE kind = 'same'").run();
    }

    return { blobsSwept, treeNodesSwept, sameDispositionsSwept };
  });
}

/** Resurrection-pool expiry sweep (02 §7): drop rows past their expires_ts.
 * Runs routinely (lazy, at checkpoint time). */
export function sweepResurrectionPool(store: Store, nowIso: string): number {
  const res = store.db.prepare("DELETE FROM resurrection_pool WHERE expires_ts <= ?").run(nowIso);
  return res.changes;
}
