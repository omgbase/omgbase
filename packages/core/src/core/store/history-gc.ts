import type { Database } from "better-sqlite3";
import type { Store } from "./store.js";
import { explicitEntries, parseNodeText } from "./delta.js";
import { checkpointDependents } from "./archive.js";
import { HOLDER_RECORDER } from "../capabilities/claims.js";

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

// ---- `history purge` (spec/store §7.6, Phase 4b; phase-1-contracts §1.14, D2 step two) ----

/** The history bundle's tables, in the order the purge counts and the drop removes them. */
export const HISTORY_TABLES = ["commits", "revisions", "blobs", "tree_nodes", "dispositions", "block_changes", "edge_transitions", "archives"] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];

/** What the purge removed, per table (spec/store §7.6 — the receipt's `purged`). */
export type PurgedCounts = Record<HistoryTable, number>;

/**
 * The recorder's half of `history purge` (spec/store §7.6): remove the
 * repository's history rows — every commit (`before` null) or every commit
 * with `ts < before` — EXCEPT, while `protectHeads` (capture is on), the
 * commit a live document's head revision belongs to (the head's row is never
 * purged: H1 holds and `docs_history` keeps the head retained, so an enabled
 * repository can trim its past without losing its present; a disabled one
 * owes nothing and purges all). In one order, inside the caller's transaction:
 * (1) the retained revisions whose base is purged are re-written in checkpoint
 * form while the base is still readable (`checkpointDependents`, the squash's
 * rule); (2) the purged commits' `revisions`, `dispositions` and
 * `block_changes` rows go; (3) `edge_transitions`: a row whose `to_commit` is
 * purged goes (an interval that closed before the cut), a row whose
 * `from_commit` is purged but which is open or closes after the cut is
 * RE-ANCHORED at the earliest retained commit of the repository (the interval
 * was already open at the cut — what `history enable`'s baseline does for an
 * edge it finds open), and every row goes when no commit remains; (4) the
 * `commits` rows go; (5) an `archives` row no revision names any more goes
 * (the segment is detached, its file untouched); (6) the unreachable bodies
 * are swept (`sweepUnreachable`). Returns the rows removed per table.
 */
export function purgeHistoryRows(store: Store, repoId: string, before: string | null, protectHeads: boolean): PurgedCounts {
  const db = store.db;
  const purged: PurgedCounts = { commits: 0, revisions: 0, blobs: 0, tree_nodes: 0, dispositions: 0, block_changes: 0, edge_transitions: 0, archives: 0 };
  const candidates = (before === null
    ? db.prepare("SELECT commit_id FROM commits WHERE repo_id = ? ORDER BY ts, seq").all(repoId)
    : db.prepare("SELECT commit_id FROM commits WHERE repo_id = ? AND ts < ? ORDER BY ts, seq").all(repoId, before)) as { commit_id: string }[];
  // While capture is on, the live heads' commits stay (their revision is the
  // present, not the past — H1 holds); a disabled repository owes nothing.
  const protectedCommits = new Set(
    protectHeads
      ? (db.prepare("SELECT r.commit_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id AND d.head = r.rev_id WHERE d.repo_id = ? AND d.deleted_at IS NULL").all(repoId) as { commit_id: string }[]).map((r) => r.commit_id)
      : [],
  );
  const victims = candidates.map((c) => c.commit_id).filter((id) => !protectedCommits.has(id));
  if (victims.length === 0) return purged;
  const inVictims = `IN (${victims.map(() => "?").join(", ")})`;

  // (1) Re-checkpoint the survivors whose base goes.
  const purgedRevs = (db.prepare(`SELECT rev_id FROM revisions WHERE commit_id ${inVictims}`).all(...victims) as { rev_id: string }[]).map((r) => r.rev_id);
  checkpointDependents(store, new Set(purgedRevs));

  // (2) The purged commits' revisions and evidence.
  purged.revisions = db.prepare(`DELETE FROM revisions WHERE commit_id ${inVictims}`).run(...victims).changes;
  purged.dispositions = db.prepare(`DELETE FROM dispositions WHERE commit_id ${inVictims}`).run(...victims).changes;
  purged.block_changes = db.prepare(`DELETE FROM block_changes WHERE commit_id ${inVictims}`).run(...victims).changes;

  // (3) The interval record, trimmed to the cut.
  const anchor = db.prepare(`SELECT commit_id FROM commits WHERE repo_id = ? AND commit_id NOT ${inVictims} ORDER BY ts, seq LIMIT 1`).get(repoId, ...victims) as { commit_id: string } | undefined;
  if (anchor) {
    purged.edge_transitions = db.prepare(`DELETE FROM edge_transitions WHERE repo_id = ? AND to_commit ${inVictims}`).run(repoId, ...victims).changes;
    db.prepare(`UPDATE edge_transitions SET from_commit = ? WHERE repo_id = ? AND from_commit ${inVictims}`).run(anchor.commit_id, repoId, ...victims);
  } else {
    purged.edge_transitions = db.prepare("DELETE FROM edge_transitions WHERE repo_id = ?").run(repoId).changes;
  }

  // (4) The commits; (5) the segments nothing names; (6) the bodies.
  purged.commits = db.prepare(`DELETE FROM commits WHERE commit_id ${inVictims}`).run(...victims).changes;
  purged.archives = db.prepare("DELETE FROM archives WHERE repo_id = ? AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.archive = archives.segment_id)").run(repoId).changes;
  const swept = sweepUnreachable(store);
  purged.blobs = swept.blobsSwept;
  purged.tree_nodes = swept.treeNodesSwept;
  return purged;
}

/**
 * Release the recorder's hold (bit 1) on every claim of the repository that
 * no history row names any more (spec/store §7.6 step 7): `revisions.rev_id`/
 * `doc_id`, `block_changes.block_id`, `dispositions.block_id`,
 * `edge_transitions.edge_id`, `commits.commit_id`. While capture is on
 * (`keepLive`) the hold also SURVIVES on every id a live core row names — a
 * live document, its head, a live block, an open edge — exactly the set a
 * baseline holds (§5.9), so I7/H6 keep holding after a trim; with capture off
 * every unreferenced hold goes. A claim left with no holder is deleted.
 * Returns the holds released. Runs in the caller's transaction; the core's
 * hold (bit 0) is never touched here (§7.3).
 */
export function releaseRecorderHolds(db: Database, repoId: string, keepLive: boolean): number {
  const live = keepLive
    ? `AND NOT EXISTS (SELECT 1 FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND (doc_id = id_claims.id OR head = id_claims.id))
       AND NOT EXISTS (SELECT 1 FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ? AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND b.block_id = id_claims.id)
       AND NOT EXISTS (SELECT 1 FROM edges WHERE repo_id = ? AND edge_id = id_claims.id)`
    : "";
  const released = db.prepare(
    `UPDATE id_claims SET holders = holders & ~${HOLDER_RECORDER}
     WHERE repo_id = ? AND (holders & ${HOLDER_RECORDER}) != 0
       AND NOT EXISTS (SELECT 1 FROM revisions WHERE rev_id = id_claims.id OR doc_id = id_claims.id)
       AND NOT EXISTS (SELECT 1 FROM block_changes WHERE block_id = id_claims.id)
       AND NOT EXISTS (SELECT 1 FROM dispositions WHERE block_id = id_claims.id)
       AND NOT EXISTS (SELECT 1 FROM edge_transitions WHERE edge_id = id_claims.id)
       AND NOT EXISTS (SELECT 1 FROM commits WHERE commit_id = id_claims.id)
       ${live}`,
  ).run(...(keepLive ? [repoId, repoId, repoId, repoId] : [repoId])).changes;
  if (released > 0) db.prepare("DELETE FROM id_claims WHERE holders = 0").run();
  return released;
}

/** Is every history table empty (the drop's precondition, spec/store §7.6)? */
export function historyTablesEmpty(db: Database): boolean {
  for (const t of HISTORY_TABLES) {
    const r = db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
    if (r) return false;
  }
  return true;
}

/** Drop the history bundle's tables (spec/store §7.6: only when no repository is enabled and every table is empty — the caller decides). Indexes go with their tables. */
export function dropHistoryBundle(db: Database): void {
  for (const t of HISTORY_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
}
