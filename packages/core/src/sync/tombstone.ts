import type { Store } from "../core/store/store.js";
import { requireHistory } from "../core/capabilities/registry.js";
import { ftsDeleteDoc } from "../core/store/fts.js";

// Observed-deletion tombstone (01 §6, 02 §3/§7). Shared by BOTH observed-change
// paths — the synchronous filesystem fast-path (checkpoint.ts::processCheckpoint,
// used by the freshness sweep / one-shot / recovery) and the async SyncSource
// path (driver.ts::reconcileChanges, used by the live watcher). Factored into ONE
// helper so the two loops cannot drift apart: a file that leaves the source scope
// (existsSync false / source.fetch → null) MUST tombstone the doc, not linger as a
// live, queryable, FTS-indexed ghost.
//
// This mirrors the DB effects of the API delete path (mutate/docs.ts::docsDelete)
// — mint a commit, drop FTS rows, tombstone the doc's live blocks + the doc row —
// with two deliberate differences:
//   1. origin is "observed", not "api": the engine witnessed the disk change; it
//      did not author it (writers.ts NewCommitInput.origin; ingestFile defaults to
//      "observed"). No actor.
//   2. the live blocks are snapshotted into the resurrection_pool BEFORE they are
//      tombstoned. An API delete is an intentional, permanent removal, so
//      docsDelete pools nothing. An observed disk deletion is the opposite: a file
//      vanishing is overwhelmingly a move/rename/transient (editor swap, git
//      checkout), which is exactly the delete→recreate case the pool exists for
//      (core/ingest.ts snapshots deleted blocks the same way; makeReconcilingResolver
//      consumes the pool to resurrect ids when the file reappears). Pooling with the
//      standard ~30-day expiry keeps sweepResurrectionPool semantics intact.
//
// Transaction: the commit row, the pool snapshot, the FTS deletes and the two
// tombstone UPDATEs are ONE `store.write` transaction (spec/store §5.6) — a
// failure midway leaves the doc live with no commit minted, never a doc whose
// blocks are pooled but still indexed, or tombstoned under a commit that is
// not there. better-sqlite3 nests an inner `transaction` as a savepoint, so this
// still composes inside a caller that already holds one. The unlink of the
// on-disk file that docsDelete performs is intentionally absent here — the file
// is ALREADY gone (that is what triggered the tombstone).

/**
 * Tombstone a doc the engine observed as gone from its source (deleted on disk /
 * left the scope). Pools the doc's live blocks for later resurrection, then drops
 * FTS rows and tombstones the blocks + the doc with an "observed"-origin commit.
 * Returns the minted commit id. Idempotent-safe: if the doc has no live blocks the
 * UPDATEs simply affect zero rows.
 */
export function tombstoneObservedDeletion(store: Store, repoId: string, docId: string, ts: string): string {
  return store.write((db) => {
    const commit = requireHistory(db).newCommit({ repoId, ts, origin: "observed", reason: "observed deletion" });

    // Snapshot the doc's live blocks into the resurrection pool BEFORE tombstoning,
    // mirroring core/ingest.ts's reconciling-delete snapshot (~30-day expiry) so a
    // recreate of the same file can resurrect these block identities — each
    // carrying its `created_at` (D6) and `deleted_at = ts` (17.0: the expiry is
    // anchored on the row's own timestamp, I6).
    const expires = new Date(Date.parse(ts) + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts)
       SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, ?, ?
         FROM blocks WHERE doc_id = ? AND deleted_at IS NULL`,
    ).run(ts, expires, docId);

    // Drop FTS index rows (external-content: delete with the original text before the
    // blocks change), then tombstone the live blocks and the doc row (spec/store
    // §5.6, 17.0: `deleted_at = ts`, `updated_at = ts` — liveness is a change of
    // the document's own; the head is KEPT and no new one is minted, D11).
    ftsDeleteDoc(db, docId);
    db.prepare("UPDATE blocks SET deleted_at = ? WHERE doc_id = ? AND deleted_at IS NULL").run(ts, docId);
    db.prepare("UPDATE docs SET deleted_at = ?, updated_at = ? WHERE doc_id = ?").run(ts, ts, docId);

    return commit.commitId;
  });
}
