import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { mintId } from "../core/ids.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
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
    const existing = store.db
      .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
      .get(repoId, change.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    const oldHex = existing?.file_hash?.toString("hex") ?? null;

    if (!existsSync(abs)) {
      // File gone from disk: tombstone the live doc (drop FTS, tombstone blocks +
      // doc, pool blocks for resurrection) so it stops being served as a ghost.
      if (existing) {
        tombstoneObservedDeletion(store, repoId, existing.doc_id, ts);
        deleted.push(change.path);
      }
      fileEntries.push([change.path, oldHex, null]);
      continue;
    }

    const content = readFileSync(abs, "utf8");
    const diskHash = sha256(content);

    if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
      suppressed.push(change.path);
      fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
      continue;
    }

    const resolveIds = makeReconcilingResolver(store, repoId, { ts, path: change.path });
    if (hasConflictMarkers(content)) {
      ingestFile(store, repoId, change.path, content, { ts, resolveIds });
      store.db.prepare("UPDATE docs SET conflicted = 1 WHERE repo_id = ? AND path = ?").run(repoId, change.path);
      conflicted.push(change.path);
      fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
      continue;
    }

    ingestFile(store, repoId, change.path, content, { ts, resolveIds });
    store.db.prepare("UPDATE docs SET conflicted = 0 WHERE repo_id = ? AND path = ?").run(repoId, change.path);
    ingested.push(change.path);
    fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, ts, JSON.stringify(fileEntries), opts.gitHead ?? null);

  sweepResurrectionPool(store, ts);

  return { checkpointId, ingested, suppressed, deleted, conflicted };
}
