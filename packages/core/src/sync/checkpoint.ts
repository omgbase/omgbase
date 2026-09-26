import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { mintId } from "../core/ids.js";
import { observeBatch, type BatchOutcome } from "./observe.js";
import { sweepResurrectionPool } from "../core/store/gc.js";

// In-process filesystem checkpoint (01 §6, 03 §8). A checkpoint is one batch of
// filesystem changes. This is the synchronous one-shot/reconcile fast-path
// (freshness sweep, crash recovery, tests) — it reads files directly with the
// node:fs builtin. LIVE watching is separate: chokidar lives only in the
// external @omgbase/fs-adapter, driven through the async SyncSource seam
// (driver.ts / watcher.ts). Both paths hand their bytes to `observeBatch`, so
// echo-suppression + the two-pass reconcile (per-doc, then cross-document moves,
// then commits) + convergence are one implementation.

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
 * echo (no commit). Otherwise ingest as an observed commit. A path gone from
 * disk tombstones its live doc (drop FTS, tombstone blocks + doc, pool blocks
 * for resurrection) so it stops being served as a ghost. Every member is
 * reconciled before any commits, so a block cut from one file and pasted into
 * another in the same checkpoint keeps its id (`observeBatch`).
 */
export function processCheckpoint(
  store: Store,
  repoId: string,
  rootPath: string,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): CheckpointResult {
  const ts = opts.ts ?? new Date().toISOString();
  const items = changes.map((change) => {
    const abs = join(rootPath, change.path);
    return { path: change.path, content: existsSync(abs) ? readFileSync(abs, "utf8") : null };
  });
  return finishCheckpoint(store, repoId, observeBatch(store, repoId, items, ts), { ts, gitHead: opts.gitHead ?? null });
}

/**
 * Turn a batch's outcomes into the checkpoint row + result, then sweep the
 * resurrection pool. Shared with the external-source driver (driver.ts), which
 * obtains its bytes asynchronously but records its checkpoint the same way.
 */
export function finishCheckpoint(
  store: Store,
  repoId: string,
  outcomes: BatchOutcome[],
  opts: { ts: string; gitHead: string | null },
): CheckpointResult {
  const checkpointId = mintId("cp");
  const ingested: string[] = [];
  const suppressed: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];
  const fileEntries: [string, string | null, string | null][] = [];

  for (const o of outcomes) {
    if (o.kind === "deleted") {
      if (o.docId) deleted.push(o.path);
      fileEntries.push([o.path, o.oldHashHex, null]);
      continue;
    }
    if (o.echo) suppressed.push(o.path);
    else if (o.conflicted) conflicted.push(o.path);
    else ingested.push(o.path);
    fileEntries.push([o.path, o.oldHashHex, o.newHashHex]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, opts.ts, JSON.stringify(fileEntries), opts.gitHead);

  sweepResurrectionPool(store, opts.ts);

  return { checkpointId, ingested, suppressed, deleted, conflicted };
}
