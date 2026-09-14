import { statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { processCheckpoint, type CheckpointResult } from "./checkpoint.js";
import { walkMarkdown } from "./fs-util.js";

// Freshness sweep (11 §3.3). Without a live watcher the database lags human
// edits since the last ingest. Before a one-shot command runs, this sweep walks
// the repo's *.md files, compares (mtime_ns, size) against the file_stats cache,
// hashes only changed candidates, and ingests non-convergent files as one
// observed checkpoint. At the envelope (≤10⁴ docs) the no-change case is a
// directory walk plus stats — tens of milliseconds.
//
// This is the filesystem source's durable change-detection cache (sync-plugins
// §7): file_stats is the persisted form of the source's `revision` token. It is
// a derived table, rebuildable by a re-stat (rebuildFileStats); the durable
// convergence signal remains docs.file_hash.

interface StatRow {
  mtime_ns: bigint;
  size: number;
  hash: Buffer;
}

export interface SweepResult extends CheckpointResult {
  scanned: number;
  candidates: number;
  changed: boolean;
}

/** Record/refresh a file's stat cache row. Call after any ingest of the file. */
export function recordFileStat(store: Store, repoId: string, path: string, abs: string, hash: Buffer): void {
  if (!existsSync(abs)) {
    store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);
    return;
  }
  const st = statSync(abs, { bigint: true });
  store.db
    .prepare(
      `INSERT INTO file_stats (repo_id, path, mtime_ns, size, hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path) DO UPDATE SET mtime_ns = excluded.mtime_ns, size = excluded.size, hash = excluded.hash`,
    )
    .run(repoId, path, st.mtimeNs.toString(), Number(st.size), hash);
}

/**
 * Run the freshness sweep for a repo. Returns the checkpoint result plus scan
 * counters. Idempotent; safe alongside a live watcher (hash-based echo
 * suppression makes a double ingest a no-op).
 */
export function freshnessSweep(store: Store, repoId: string, rootPath: string): SweepResult {
  const cache = new Map<string, StatRow>();
  for (const row of store.db
    .prepare("SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?")
    .all(repoId) as { path: string; mtime_ns: bigint | number; size: number; hash: Buffer }[]) {
    cache.set(row.path, { mtime_ns: BigInt(row.mtime_ns), size: row.size, hash: row.hash });
  }

  const paths = walkMarkdown(rootPath);
  const seen = new Set(paths);

  // Candidates: files whose (mtime_ns, size) differs from cache, or are new.
  const candidates: string[] = [];
  const freshStats = new Map<string, { mtimeNs: bigint; size: number }>();
  for (const path of paths) {
    const st = statSync(join(rootPath, path), { bigint: true });
    freshStats.set(path, { mtimeNs: st.mtimeNs, size: Number(st.size) });
    const cached = cache.get(path);
    if (!cached || cached.mtime_ns !== st.mtimeNs || cached.size !== Number(st.size)) {
      candidates.push(path);
    }
  }
  // Deletions: cached paths no longer on disk.
  const deletedPaths = [...cache.keys()].filter((p) => !seen.has(p));

  // Hash candidates; only those whose content hash actually differs from the
  // cached hash need ingesting (mtime can change without content changing).
  const changedPaths: string[] = [];
  const candHashes = new Map<string, Buffer>();
  for (const path of candidates) {
    const hash = sha256(readFileSync(join(rootPath, path), "utf8"));
    candHashes.set(path, hash);
    const cached = cache.get(path);
    if (!cached || !cached.hash.equals(hash)) changedPaths.push(path);
    else {
      // Content unchanged; refresh the stat cache so we don't re-hash next time.
      const fs = freshStats.get(path)!;
      store.db
        .prepare("UPDATE file_stats SET mtime_ns = ?, size = ? WHERE repo_id = ? AND path = ?")
        .run(fs.mtimeNs.toString(), fs.size, repoId, path);
    }
  }

  const toIngest = [...changedPaths, ...deletedPaths];
  const result = processCheckpoint(
    store,
    repoId,
    rootPath,
    toIngest.map((path) => ({ path })),
  );

  // Refresh stat cache for everything we touched (ingested or echo-suppressed).
  for (const path of changedPaths) {
    recordFileStat(store, repoId, path, join(rootPath, path), candHashes.get(path)!);
  }
  for (const path of deletedPaths) {
    store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);
  }

  return {
    ...result,
    scanned: paths.length,
    candidates: candidates.length,
    changed: result.ingested.length > 0 || result.deleted.length > 0 || result.conflicted.length > 0,
  };
}

/**
 * Counts of ways the DB disagrees with the current filesystem. All fields are
 * "not yet reconciled" states a freshnessSweep/ingest would resolve.
 */
export interface DiskDrift {
  /** non-deleted docs whose on-disk content hash != the doc's stored file_hash (drifted edits). */
  changed: number;
  /** non-deleted docs whose file is no longer on disk (deletes not yet ingested). */
  deleted: number;
  /** *.md files on disk with no corresponding non-deleted doc (new files not yet ingested). */
  untracked: number;
}

/**
 * READ-ONLY disk-drift detector. Mirrors freshnessSweep's staged cheap approach
 * — stat-compare against file_stats first, hash only the stat-mismatched
 * candidates — but never ingests, commits, or touches file_stats. It answers a
 * single question: does the DB still agree with what's on disk right now?
 *
 * `changed` is decided by comparing a candidate's content hash to the doc's
 * stored `file_hash` (the same sha256(bytes) checkpoint writes), so a stat
 * change without a content change is NOT counted as drift. At the envelope
 * (≤10⁴ docs) the clean case is a directory walk plus stats (tens of ms);
 * hashing is bounded to files whose (mtime_ns, size) moved.
 */
export function detectDiskDrift(store: Store, repoId: string, rootPath: string): DiskDrift {
  // Stat cache keyed by path, for cheap change detection.
  const cache = new Map<string, StatRow>();
  for (const row of store.db
    .prepare("SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?")
    .all(repoId) as { path: string; mtime_ns: bigint | number; size: number; hash: Buffer }[]) {
    cache.set(row.path, { mtime_ns: BigInt(row.mtime_ns), size: row.size, hash: row.hash });
  }

  // Live docs keyed by path, with their durable file_hash (the convergence
  // signal). This is the authority for changed/deleted/untracked, independent
  // of the derived file_stats cache.
  const docs = new Map<string, Buffer | null>();
  for (const row of store.db
    .prepare("SELECT path, file_hash FROM docs WHERE repo_id = ? AND deleted_commit IS NULL")
    .all(repoId) as { path: string; file_hash: Buffer | null }[]) {
    docs.set(row.path, row.file_hash);
  }

  const paths = walkMarkdown(rootPath);
  const seen = new Set(paths);

  // Candidates whose (mtime_ns, size) differs from the stat cache (or are new).
  const candidates: string[] = [];
  for (const path of paths) {
    const st = statSync(join(rootPath, path), { bigint: true });
    const cached = cache.get(path);
    if (!cached || cached.mtime_ns !== st.mtimeNs || cached.size !== Number(st.size)) {
      candidates.push(path);
    }
  }

  let changed = 0;
  let untracked = 0;
  for (const path of candidates) {
    const doc = docs.get(path);
    if (doc === undefined) {
      // No non-deleted doc for an on-disk *.md ⇒ untracked (new file).
      untracked += 1;
      continue;
    }
    const hash = sha256(readFileSync(join(rootPath, path), "utf8"));
    // Genuinely drifted only if content hash differs from the doc's file_hash.
    if (!doc || !doc.equals(hash)) changed += 1;
  }

  // A doc present in the DB whose path isn't on disk anymore is a pending delete.
  let deleted = 0;
  for (const path of docs.keys()) {
    if (!seen.has(path)) deleted += 1;
  }

  return { changed, deleted, untracked };
}

/** Rebuild file_stats from scratch by re-statting + re-hashing every file. */
export function rebuildFileStats(store: Store, repoId: string, rootPath: string): number {
  store.db.prepare("DELETE FROM file_stats WHERE repo_id = ?").run(repoId);
  const paths = walkMarkdown(rootPath);
  for (const path of paths) {
    const abs = join(rootPath, path);
    const hash = sha256(readFileSync(abs, "utf8"));
    recordFileStat(store, repoId, path, abs, hash);
  }
  return paths.length;
}
