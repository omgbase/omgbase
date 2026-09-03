import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { mintId } from "../core/ids.js";
import { ingestFile } from "../core/ingest.js";

// Checkpoint processing (01 §6, 03 §8). A checkpoint is one debounced batch of
// filesystem changes. For each changed file: if the on-disk hash already equals
// the stored file_hash, the change is an engine echo — suppressed (no commit).
// Otherwise ingest (Stage 1: re-mint; Stage 2 adds reconciliation).
//
// This module is pure w.r.t. timers — the watcher (watcher.ts) supplies batches.

export interface FileChange {
  /** repo-relative canonical path */
  path: string;
}

export interface CheckpointResult {
  checkpointId: string;
  ingested: string[]; // paths that produced observed commits
  suppressed: string[]; // echo-suppressed paths (hash already matched)
  deleted: string[]; // paths gone from disk
}

/**
 * Process a batch of changed paths against a repo as one checkpoint.
 * `expectedHashes` lets the engine mark writes it just made (echo suppression);
 * any on-disk hash matching the stored file_hash is also suppressed.
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
  const fileEntries: [string, string | null, string | null][] = [];

  for (const change of changes) {
    const abs = join(rootPath, change.path);
    const existing = store.db
      .prepare("SELECT doc_id, file_hash FROM documents WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
      .get(repoId, change.path) as { doc_id: string; file_hash: Buffer | null } | undefined;

    if (!existsSync(abs)) {
      if (existing) deleted.push(change.path);
      fileEntries.push([change.path, existing?.file_hash?.toString("hex") ?? null, null]);
      continue;
    }

    const content = readFileSync(abs, "utf8");
    const diskHash = sha256(content);
    const oldHex = existing?.file_hash?.toString("hex") ?? null;

    if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
      // Echo: on-disk bytes already match the stored revision. No commit.
      suppressed.push(change.path);
      fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
      continue;
    }

    ingestFile(store, repoId, change.path, content, { ts });
    ingested.push(change.path);
    fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, ts, JSON.stringify(fileEntries), opts.gitHead ?? null);

  return { checkpointId, ingested, suppressed, deleted };
}
