import type { Store } from "../core/store/store.js";
import { batchIdOf, observeBatch, type BatchOutcome } from "./observe.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import { nodeFs, type SyncFs } from "./fs-util.js";

// In-process filesystem batch (01 §6, 03 §8; spec/sync §4.1). A batch is one
// set of filesystem changes observed together. This is the synchronous
// one-shot/reconcile fast-path (freshness sweep, crash recovery, tests) — it
// reads files directly with the node:fs builtin. LIVE watching is separate:
// chokidar lives only in the external @omgbase/fs-adapter, driven through the
// async SyncSource seam (driver.ts / watcher.ts). Both paths hand their bytes to
// `observeBatch`, so echo-suppression + the two-pass reconcile (per-doc, then
// cross-document moves, then commits) + convergence are one implementation. The
// reads go through the `SyncFs` seam (`opts.fs`, default `nodeFs`) so spec/sync's
// runner can supply an in-memory filesystem. Since store 17.0 (D4) a batch
// records no row of its own: the `checkpoints` table is gone, its id is the
// feed's `batch_id` (the first committing member's commit id — every member's
// feed row carries it), and what remains of it is the repository's STATUS ROW
// of `sync_state` — `(repo_id, '', '')` with `last_batch_ts`, `last_batch_id`,
// `last_batch_files` — written with the pool sweep in one transaction.

export interface FileChange {
  /** repo-relative canonical path */
  path: string;
}

/** The result of one observed batch (spec/sync §4.1, 4.0): `batchId` is the feed's `batch_id` — null when nothing committed. */
export interface BatchResult {
  batchId: string | null;
  ingested: string[]; // paths that produced observed commits
  suppressed: string[]; // echo-suppressed paths (hash already matched)
  deleted: string[]; // paths gone from disk
  conflicted: string[]; // paths flagged with git conflict markers
}

/** The name the result carried through spec/sync 3.x (`checkpointId` then; `batchId` since 4.0). */
export type CheckpointResult = BatchResult;

/**
 * Process a batch of changed paths against a repo. On-disk bytes are read
 * directly; a hash equal to the stored file_hash is an engine echo (no commit).
 * Otherwise ingest as an observed commit. A path gone from disk tombstones its
 * live doc (drop FTS, tombstone blocks + doc, pool blocks for resurrection) so
 * it stops being served as a ghost. Every member is reconciled before any
 * commits, so a block cut from one file and pasted into another in the same
 * batch keeps its id (`observeBatch`). spec/sync §4.1
 * `process_checkpoint(repo, root, paths, ts)`.
 */
export function processCheckpoint(
  store: Store,
  repoId: string,
  rootPath: string,
  changes: FileChange[],
  opts: { ts?: string; fs?: SyncFs } = {},
): BatchResult {
  const ts = opts.ts ?? new Date().toISOString();
  const fs = opts.fs ?? nodeFs;
  const items = changes.map((change) => ({ path: change.path, content: fs.read(rootPath, change.path) }));
  return finishCheckpoint(store, repoId, observeBatch(store, repoId, items, ts), { ts });
}

/**
 * Turn a batch's outcomes into the status row + result, then sweep the
 * resurrection pool — the row and the sweep in ONE transaction (spec/sync §4.1),
 * so a batch is never recorded without its sweep or swept without its row
 * (the member commits before it are one transaction each, as before). Shared
 * with the external-source driver (driver.ts), which obtains its bytes
 * asynchronously but records its batch the same way.
 */
export function finishCheckpoint(
  store: Store,
  repoId: string,
  outcomes: BatchOutcome[],
  opts: { ts: string },
): BatchResult {
  const batchId = batchIdOf(outcomes);
  const ingested: string[] = [];
  const suppressed: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];

  for (const o of outcomes) {
    if (o.kind === "deleted") {
      if (o.docId) deleted.push(o.path);
      continue;
    }
    if (o.echo) suppressed.push(o.path);
    else if (o.conflicted) conflicted.push(o.path);
    else ingested.push(o.path);
  }

  store.write((db) => {
    writeStatusRow(db, repoId, { ts: opts.ts, batchId, files: outcomes.length });
    sweepResurrectionPool(store, opts.ts);
  });

  return { batchId, ingested, suppressed, deleted, conflicted };
}

/** The repository's status row (spec/sync §4.1; spec/store §3.1 `sync_state`): `(repo_id, '', '')` with the last batch's `ts`, `batch_id` and member count. */
export function writeStatusRow(db: import("better-sqlite3").Database, repoId: string, batch: { ts: string; batchId: string | null; files: number }): void {
  db.prepare(
    `INSERT INTO sync_state (repo_id, source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files) VALUES (?, '', '', NULL, NULL, ?, ?, ?)
     ON CONFLICT(repo_id, source_id, path) DO UPDATE SET last_batch_ts = excluded.last_batch_ts, last_batch_id = excluded.last_batch_id, last_batch_files = excluded.last_batch_files`,
  ).run(repoId, batch.ts, batch.batchId, batch.files);
}

/** The last observed batch of the repository (the status row), or null when none ran. */
export function lastBatch(db: import("better-sqlite3").Database, repoId: string): { ts: string; batchId: string | null; files: number } | null {
  const row = db.prepare("SELECT last_batch_ts, last_batch_id, last_batch_files FROM sync_state WHERE repo_id = ? AND source_id = '' AND path = ''").get(repoId) as
    | { last_batch_ts: string | null; last_batch_id: string | null; last_batch_files: number | null }
    | undefined;
  if (!row || row.last_batch_ts === null) return null;
  return { ts: row.last_batch_ts, batchId: row.last_batch_id, files: row.last_batch_files ?? 0 };
}
