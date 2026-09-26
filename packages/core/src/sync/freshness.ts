import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { processCheckpoint, type CheckpointResult } from "./checkpoint.js";
import { nodeFs, type FileStat, type SyncFs } from "./fs-util.js";

// Freshness sweep (11 §3.3, spec/sync §4.3). Without a live watcher the database
// lags human edits since the last ingest. Before a one-shot command runs, this
// sweep walks the repo's *.md files, compares (mtime_ns, size) against the
// file_stats cache, hashes only changed candidates, and ingests non-convergent
// files as one observed checkpoint. At the envelope (≤10⁴ docs) the no-change
// case is a directory walk plus stats — tens of milliseconds.
//
// This is the filesystem source's durable change-detection cache (sync-plugins
// §7): file_stats is the persisted form of the source's `revision` token. It is
// a derived table, rebuildable by a re-stat (rebuildFileStats); the durable
// convergence signal remains docs.file_hash.
//
// The decisions are one pure function, `sweepPlan(cache, snapshot)`, that both
// the sweep and the read-only drift detector run; the I/O around it goes through
// the `SyncFs` seam so spec/sync's fixtures can drive it over an in-memory
// filesystem (README §8 `sweep_plan`).

/** One `file_stats` row (spec/sync §4.3 "the repo's cache rows"). */
export interface StatCacheRow {
  path: string;
  mtime_ns: bigint;
  size: number;
  hash: Buffer;
}

/** One walked file in the current snapshot; `hash()` reads and hashes its bytes on demand (memoized). */
export interface SnapshotEntry {
  path: string;
  mtime_ns: bigint;
  size: number;
  hash: () => Buffer;
}

/**
 * The §4.3 decisions over a cache and a snapshot:
 * - `candidates`: snapshot paths not in the cache or whose `(mtime_ns, size)` differs (snapshot order);
 * - `deletions`: cached paths not in the snapshot (cache order);
 * - `changed`: candidates whose bytes' hash differs from the cached hash, or that have no cache row;
 * - `refreshed`: candidates whose hash equals the cached one (a touch without an edit — the
 *   cache's stat is refreshed, nothing is ingested);
 * - `hashes`: the hash computed for every candidate (the sweep records them).
 */
export interface SweepPlan {
  candidates: string[];
  changed: string[];
  deletions: string[];
  refreshed: string[];
  hashes: Map<string, Buffer>;
}

/** Step 1 of §4.3 alone: the stat-mismatched or new paths, without hashing anything. */
export function sweepCandidates(cache: ReadonlyMap<string, StatCacheRow>, snapshot: readonly SnapshotEntry[]): string[] {
  const out: string[] = [];
  for (const e of snapshot) {
    const cached = cache.get(e.path);
    if (!cached || cached.mtime_ns !== e.mtime_ns || cached.size !== e.size) out.push(e.path);
  }
  return out;
}

/** spec/sync §4.3 steps 1–2 as a pure function (README §8 `sweep_plan`). */
export function sweepPlan(cache: ReadonlyMap<string, StatCacheRow>, snapshot: readonly SnapshotEntry[]): SweepPlan {
  const byPath = new Map(snapshot.map((e) => [e.path, e] as const));
  const candidates = sweepCandidates(cache, snapshot);
  const deletions = [...cache.keys()].filter((p) => !byPath.has(p));
  const changed: string[] = [];
  const refreshed: string[] = [];
  const hashes = new Map<string, Buffer>();
  for (const path of candidates) {
    const hash = byPath.get(path)!.hash();
    hashes.set(path, hash);
    const cached = cache.get(path);
    if (!cached || !cached.hash.equals(hash)) changed.push(path);
    else refreshed.push(path);
  }
  return { candidates, changed, deletions, refreshed, hashes };
}

/** The repo's `file_stats` rows keyed by path. Read with safe integers: an `mtime_ns` is a
 *  64-bit count a JS number cannot hold exactly, and a rounded value would never equal a stat. */
export function loadStatCache(store: Store, repoId: string): Map<string, StatCacheRow> {
  const cache = new Map<string, StatCacheRow>();
  const rows = store.db.prepare("SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?").safeIntegers(true).all(repoId) as {
    path: string;
    mtime_ns: bigint;
    size: bigint;
    hash: Buffer;
  }[];
  for (const row of rows) cache.set(row.path, { path: row.path, mtime_ns: row.mtime_ns, size: Number(row.size), hash: row.hash });
  return cache;
}

/** The current filesystem snapshot: the §4.2 walk with each file's stat and a lazy hash. */
export function snapshotOf(fs: SyncFs, rootPath: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const path of fs.walk(rootPath)) {
    const st = fs.stat(rootPath, path);
    if (!st) continue; // vanished between the walk and the stat
    let memo: Buffer | null = null;
    out.push({
      path,
      mtime_ns: st.mtimeNs,
      size: st.size,
      hash: () => (memo ??= sha256(fs.read(rootPath, path) ?? "")),
    });
  }
  return out;
}

export interface SweepResult extends CheckpointResult {
  scanned: number;
  candidates: number;
  changed: boolean;
}

/** Write a file's stat cache row from a stat (`INSERT … ON CONFLICT DO UPDATE`); a null stat (the
 *  file vanished) deletes the row. The DB half of `record_file_stat` (spec/sync §4.3 step 4). */
export function recordStat(store: Store, repoId: string, path: string, st: FileStat | null, hash: Buffer): void {
  if (!st) {
    store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);
    return;
  }
  store.db
    .prepare(
      `INSERT INTO file_stats (repo_id, path, mtime_ns, size, hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path) DO UPDATE SET mtime_ns = excluded.mtime_ns, size = excluded.size, hash = excluded.hash`,
    )
    .run(repoId, path, st.mtimeNs, st.size, hash);
}

/** Record/refresh a file's stat cache row from its absolute path. Call after any ingest of the file. */
export function recordFileStat(store: Store, repoId: string, path: string, abs: string, hash: Buffer): void {
  recordStat(store, repoId, path, nodeFs.stat(abs, ""), hash);
}

/**
 * Run the freshness sweep for a repo (spec/sync §4.3). Returns the checkpoint
 * result plus scan counters. Idempotent; safe alongside a live watcher
 * (hash-based echo suppression makes a double ingest a no-op). `opts.ts` pins
 * the batch timestamp (default now); `opts.fs` the filesystem seam.
 */
export function freshnessSweep(store: Store, repoId: string, rootPath: string, opts: { ts?: string; gitHead?: string | null; fs?: SyncFs } = {}): SweepResult {
  const fs = opts.fs ?? nodeFs;
  const cache = loadStatCache(store, repoId);
  const snapshot = snapshotOf(fs, rootPath);
  const plan = sweepPlan(cache, snapshot);
  const statOf = new Map(snapshot.map((e) => [e.path, { mtimeNs: e.mtime_ns, size: e.size }] as const));

  // Content unchanged; refresh the stat cache so we don't re-hash next time.
  for (const path of plan.refreshed) {
    const st = statOf.get(path)!;
    store.db.prepare("UPDATE file_stats SET mtime_ns = ?, size = ? WHERE repo_id = ? AND path = ?").run(st.mtimeNs, st.size, repoId, path);
  }

  const result = processCheckpoint(
    store,
    repoId,
    rootPath,
    [...plan.changed, ...plan.deletions].map((path) => ({ path })),
    { fs, ...(opts.ts !== undefined ? { ts: opts.ts } : {}), ...(opts.gitHead !== undefined ? { gitHead: opts.gitHead } : {}) },
  );

  // Refresh stat cache for everything we touched (ingested or echo-suppressed).
  for (const path of plan.changed) recordStat(store, repoId, path, fs.stat(rootPath, path), plan.hashes.get(path)!);
  for (const path of plan.deletions) store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);

  return {
    ...result,
    scanned: snapshot.length,
    candidates: plan.candidates.length,
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
 * READ-ONLY disk-drift detector (spec/sync §4.3 "Disk drift"). Mirrors
 * freshnessSweep's staged cheap approach — the same `sweepCandidates` over the
 * same cache and snapshot, hashing only the stat-mismatched candidates — but
 * never ingests, commits, or touches file_stats. It answers a single question:
 * does the DB still agree with what's on disk right now?
 *
 * `changed` is decided by comparing a candidate's content hash to the doc's
 * stored `file_hash` (the same sha256(bytes) checkpoint writes), so a stat
 * change without a content change is NOT counted as drift.
 */
export function detectDiskDrift(store: Store, repoId: string, rootPath: string, opts: { fs?: SyncFs } = {}): DiskDrift {
  const fs = opts.fs ?? nodeFs;
  const cache = loadStatCache(store, repoId);

  // Live docs keyed by path, with their durable file_hash (the convergence
  // signal). This is the authority for changed/deleted/untracked, independent
  // of the derived file_stats cache.
  const docs = new Map<string, Buffer | null>();
  for (const row of store.db
    .prepare("SELECT path, file_hash FROM docs WHERE repo_id = ? AND deleted_commit IS NULL")
    .all(repoId) as { path: string; file_hash: Buffer | null }[]) {
    docs.set(row.path, row.file_hash);
  }

  const snapshot = snapshotOf(fs, rootPath);
  const byPath = new Map(snapshot.map((e) => [e.path, e] as const));

  let changed = 0;
  let untracked = 0;
  for (const path of sweepCandidates(cache, snapshot)) {
    const doc = docs.get(path);
    if (doc === undefined) {
      // No non-deleted doc for an on-disk *.md ⇒ untracked (new file).
      untracked += 1;
      continue;
    }
    // Genuinely drifted only if content hash differs from the doc's file_hash.
    if (!doc || !doc.equals(byPath.get(path)!.hash())) changed += 1;
  }

  // A doc present in the DB whose path isn't on disk anymore is a pending delete.
  let deleted = 0;
  for (const path of docs.keys()) if (!byPath.has(path)) deleted += 1;

  return { changed, deleted, untracked };
}

/** Rebuild file_stats from scratch by re-statting + re-hashing every file. */
export function rebuildFileStats(store: Store, repoId: string, rootPath: string, opts: { fs?: SyncFs } = {}): number {
  const fs = opts.fs ?? nodeFs;
  store.db.prepare("DELETE FROM file_stats WHERE repo_id = ?").run(repoId);
  const paths = fs.walk(rootPath);
  for (const path of paths) {
    const bytes = fs.read(rootPath, path);
    if (bytes === null) continue;
    recordStat(store, repoId, path, fs.stat(rootPath, path), sha256(bytes));
  }
  return paths.length;
}
