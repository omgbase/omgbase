import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { mintId } from "../core/ids.js";
import { observeOne } from "./observe.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import { tombstoneObservedDeletion } from "./tombstone.js";

// In-process filesystem checkpoint (01 §6, 03 §8). A checkpoint is one batch of
// filesystem changes. This is the synchronous one-shot/reconcile fast-path
// (freshness sweep, crash recovery, tests) — it reads files directly with the
// node:fs builtin. LIVE watching is separate: chokidar lives only in the
// external @omgbase/fs-adapter, driven through the async SyncSource seam
// (driver.ts / watcher.ts). Engine echo-suppression + reconcile + commit +
// convergence are identical on both paths.

export interface FileChange {
  /** repo-relative canonical path */
  path: string;
}

export interface CheckpointResult {
  checkpointId: string;
  ingested: string[]; // paths that produced observed commits
  suppressed: string[]; // echo-suppressed paths (hash already matched)
  deleted: string[]; // paths gone from disk
  conflicted: string[]; // paths flagged with git conflict markers
}

/**
 * Process a batch of changed paths against a repo as one checkpoint. On-disk
 * bytes are read directly; a hash equal to the stored file_hash is an engine
 * echo (no commit). Otherwise ingest as an observed commit.
 */
export function processCheckpoint(
  store: Store,
  repoId: string,
  rootPath: string,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): CheckpointResult {
  const ts = opts.ts ?? new Date().toISOString();
  const checkpointId = mintId("cp");
  const ingested: string[] = [];
  const suppressed: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];
  const fileEntries: [string, string | null, string | null][] = [];

  for (const change of changes) {
    const abs = join(rootPath, change.path);

    if (!existsSync(abs)) {
      // File gone from disk: tombstone the live doc (drop FTS, tombstone blocks +
      // doc, pool blocks for resurrection) so it stops being served as a ghost.
      const existing = store.db
        .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
        .get(repoId, change.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
      if (existing) {
        tombstoneObservedDeletion(store, repoId, existing.doc_id, ts);
        deleted.push(change.path);
      }
      fileEntries.push([change.path, existing?.file_hash?.toString("hex") ?? null, null]);
      continue;
    }

    // Reconcile the disk bytes through the shared observe primitive (echo gate,
    // identity threading, conflict-marker flagging — the one implementation).
    const r = observeOne(store, repoId, change.path, readFileSync(abs, "utf8"), ts);
    if (r.echo) suppressed.push(change.path);
    else if (r.conflicted) conflicted.push(change.path);
    else ingested.push(change.path);
    fileEntries.push([change.path, r.oldHashHex, r.newHashHex]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, ts, JSON.stringify(fileEntries), opts.gitHead ?? null);

  sweepResurrectionPool(store, ts);

  return { checkpointId, ingested, suppressed, deleted, conflicted };
}
