import type { Store } from "./store.js";

// Garbage collection (02 §7). GC MUST NOT run in v1.0 — it ships behind a flag,
// off by default. Mark-and-sweep from live revision roots removes unreachable
// blobs and tree_nodes. The resurrection-pool expiry sweep is the one collection
// that runs routinely (lazy, at checkpoint time).

export interface GcResult {
  blobsSwept: number;
  treeNodesSwept: number;
  /** spec/store §7 (14.2): `same` rows a 14.1 store wrote into `dispositions`/`block_changes` — history nothing reads. */
  sameDispositionsSwept: number;
}

// Collect the set of tree-node hashes reachable from every revision root, and
// the blob hashes referenced by those nodes (raw + trivia) plus frontmatter.
function markReachable(store: Store): { trees: Set<string>; blobs: Set<string> } {
  const trees = new Set<string>();
  const blobs = new Set<string>();

  // Frontmatter blobs referenced by revisions.
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

  const roots = store.db.prepare("SELECT DISTINCT root_tree FROM revisions").all() as { root_tree: Buffer }[];
  for (const r of roots) walk(r.root_tree.toString("hex"));

  return { trees, blobs };
}

/** The `same` rows a store through 14.1 persisted (spec/store §7, 14.2). */
export function countSameDispositions(store: Store): number {
  return (store.db.prepare("SELECT count(*) AS c FROM dispositions WHERE kind = 'same'").get() as { c: number }).c;
}

/**
 * Mark-and-sweep GC (flag-gated; enabled must be true to run — v1.0 ships it
 * off). Removes blobs/tree_nodes unreachable from any revision root. Because
 * revisions are append-only and never pruned in v1, nothing is actually
 * unreachable unless revision pruning ran first — so that half is a no-op in a
 * default v1 repo, exactly as specified. Rebuild-equivalence is preserved.
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
    const { trees, blobs } = markReachable(store);
    const dry = Boolean(opts.dryRun);

    let treeNodesSwept = 0;
    const allTrees = db.prepare("SELECT hash FROM tree_nodes").all() as { hash: Buffer }[];
    const delTree = db.prepare("DELETE FROM tree_nodes WHERE hash = ?");
    for (const t of allTrees) if (!trees.has(t.hash.toString("hex"))) { if (!dry) delTree.run(t.hash); treeNodesSwept++; }

    let blobsSwept = 0;
    const allBlobs = db.prepare("SELECT hash FROM blobs").all() as { hash: Buffer }[];
    const delBlob = db.prepare("DELETE FROM blobs WHERE hash = ?");
    for (const b of allBlobs) if (!blobs.has(b.hash.toString("hex"))) { if (!dry) delBlob.run(b.hash); blobsSwept++; }

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
