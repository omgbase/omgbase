import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { mintId } from "../core/ids.js";
import { ingestFile } from "../core/ingest.js";
import { ensureRepo } from "../core/attach.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import type { SyncSource } from "./plugin.js";

// Source-agnostic reconciliation driver (13-sync-plugins §5). One loop for every
// source: fetch each changed member, engine-hash it for the authoritative echo
// gate, reconcile+commit non-echoes, record one checkpoint row. Everything here
// is engine-owned; the SyncSource only transports bytes and reports membership.
// The filesystem specifics (walk, stat, chokidar) live in FilesystemSource.

export interface FileChange {
  /** repo-relative canonical path (storage key) */
  path: string;
}

export interface CheckpointResult {
  checkpointId: string;
  ingested: string[]; // paths that produced observed commits
  suppressed: string[]; // echo-suppressed paths (hash already matched)
  deleted: string[]; // paths gone from the source scope
  conflicted: string[]; // paths flagged with git conflict markers
}

/**
 * Reconcile a batch of changed members against a repo as one checkpoint.
 * `source.fetch(path)` supplies current bytes (or null = left the scope). The
 * engine hashes the bytes itself: a hash equal to the stored file_hash is an
 * echo (no commit); otherwise the member is ingested as an observed commit.
 */
export function reconcileChanges(
  store: Store,
  repoId: string,
  source: SyncSource,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): CheckpointResult {
  const ts = opts.ts ?? new Date().toISOString();
  const inferred = source.capabilities().identity === "inferred";
  const checkpointId = mintId("cp");
  const ingested: string[] = [];
  const suppressed: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];
  const fileEntries: [string, string | null, string | null][] = [];

  for (const change of changes) {
    const existing = store.db
      .prepare("SELECT doc_id, file_hash FROM documents WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
      .get(repoId, change.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    const oldHex = existing?.file_hash?.toString("hex") ?? null;

    const item = source.fetch(change.path);
    if (item === null) {
      if (existing) deleted.push(change.path);
      fileEntries.push([change.path, oldHex, null]);
      continue;
    }

    const content = item.content;
    const diskHash = sha256(content);

    if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
      // Echo: the source's current bytes already match the stored revision.
      suppressed.push(change.path);
      fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
      continue;
    }

    // Identity-inferred sources reconcile block identity against the prior
    // revision (dispositions); a borne-identity source would map ids directly
    // (v1: no borne source exists, so this is always the reconciling path).
    const resolveIds = inferred
      ? makeReconcilingResolver(store, repoId, { ts, path: change.path })
      : undefined;

    // Git conflict markers: flag the doc conflicted (mutations refused until
    // clean) but still ingest the marker soup as opaque so the file tracks.
    if (hasConflictMarkers(content)) {
      ingestFile(store, repoId, change.path, content, { ts, ...(resolveIds ? { resolveIds } : {}) });
      store.db.prepare("UPDATE documents SET conflicted = 1 WHERE repo_id = ? AND path = ?").run(repoId, change.path);
      conflicted.push(change.path);
      fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
      continue;
    }

    ingestFile(store, repoId, change.path, content, { ts, ...(resolveIds ? { resolveIds } : {}) });
    store.db.prepare("UPDATE documents SET conflicted = 0 WHERE repo_id = ? AND path = ?").run(repoId, change.path);
    ingested.push(change.path);
    fileEntries.push([change.path, oldHex, diskHash.toString("hex")]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, ts, JSON.stringify(fileEntries), opts.gitHead ?? null);

  sweepResurrectionPool(store, ts);

  return { checkpointId, ingested, suppressed, deleted, conflicted };
}

export interface AttachResult {
  repoId: string;
  fileCount: number;
  allConverged: boolean;
}

/**
 * Attach a source scope as a repo: create/reuse the repo row, then ingest every
 * member the source enumerates (identity-inferred sources thread the reconciling
 * resolver so edges + identity are established on the initial walk).
 */
export function attachSource(store: Store, slug: string, rootPath: string, source: SyncSource): AttachResult {
  const repoId = ensureRepo(store, slug, rootPath);
  const inferred = source.capabilities().identity === "inferred";
  const ts = new Date().toISOString();
  let fileCount = 0;
  let allConverged = true;
  for (const entry of source.enumerate()) {
    const item = source.fetch(entry.path);
    if (!item) continue;
    const res = ingestFile(store, repoId, entry.path, item.content, {
      ts,
      ...(inferred ? { resolveIds: makeReconcilingResolver(store, repoId, { ts, path: entry.path }) } : {}),
    });
    fileCount++;
    if (!res.converged) allConverged = false;
  }
  return { repoId, fileCount, allConverged };
}
