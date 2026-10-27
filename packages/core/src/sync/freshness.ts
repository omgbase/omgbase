import type { Store } from "../core/store/store.js";
import { historyProviderOf, NATIVE_PROVIDER, providerConfigOf, readCapability, requireProvider } from "../core/store/manifest.js";
import { CapabilityUnavailable } from "../core/capabilities/errors.js";
import type { HistoryCheckpointResult, HistoryRemoteSyncResult, HistoryVaultSink } from "../core/capabilities/types.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "../core/hash.js";
import { processCheckpoint, type BatchResult } from "./checkpoint.js";
import { nodeFs, type SyncFs } from "./fs-util.js";
import { recordStat } from "./stat-cache.js";
import { materializePending } from "../mutate/materialize.js";
import { FsDocStore, type DocStore } from "../mutate/doc-store.js";
import { legacyBytesActive, refreshLegacyBytesAlert, unreproducibleDocs } from "../core/store/legacy-bytes.js";
import { repairLegacyBytes } from "./legacy-bytes.js";

export { recordStat, recordFileStat } from "./stat-cache.js";

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

export interface SweepResult extends BatchResult {
  scanned: number;
  candidates: number;
  changed: boolean;
  /** step 0 (spec/sync §4.3, 2.2): the paths whose pending materialization rows were replayed before the walk. */
  materialized: string[];
  /** step 5 (spec/sync §4.3, 4.4; spec/store §5.11): the legacy documents whose separator bytes this sweep repaired from their files — only while the repository's `legacy_bytes` alert is active. */
  repaired: string[];
}

/**
 * Run the freshness sweep for a repo (spec/sync §4.3). Returns the batch
 * result plus scan counters. Idempotent; safe alongside a live watcher
 * (hash-based echo suppression makes a double ingest a no-op). `opts.ts` pins
 * the batch timestamp (default now); `opts.fs` the filesystem seam;
 * `opts.docStore` the write target step 0 materializes through (default: the
 * filesystem store at `rootPath` — the fixtures' in-memory filesystem never
 * holds a pending row, so the default is never exercised there).
 */
export function freshnessSweep(
  store: Store,
  repoId: string,
  rootPath: string,
  opts: { ts?: string; fs?: SyncFs; docStore?: DocStore } = {},
): SweepResult {
  const fs = opts.fs ?? nodeFs;
  // Step 0 (2.2; spec/store §5.7): replay the api path's recorded file intent
  // before looking at the disk, so a file a crashed or refused write left
  // behind the database is brought forward instead of being read back as a
  // human edit. The production recovery point (priming sweep at `omg mcp`
  // start, the pre-verb sweep of every CLI write).
  const materialized = materializePending(store, repoId, opts.docStore ?? new FsDocStore(rootPath), opts.ts);
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
    { fs, ...(opts.ts !== undefined ? { ts: opts.ts } : {}) },
  );

  // Refresh stat cache for everything we touched (ingested or echo-suppressed)
  // — not for a member whose capture failed (Phase 4a, resolution 18): it was
  // rolled back and must stay a candidate for the next sweep.
  const failed = new Set(result.failed);
  for (const path of plan.changed) if (!failed.has(path)) recordStat(store, repoId, path, fs.stat(rootPath, path), plan.hashes.get(path)!);
  for (const path of plan.deletions) if (!failed.has(path)) store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);

  // Step 5 (4.4; spec/store §5.11 — qualification finding F1): while the
  // repository's `legacy_bytes` alert is active, re-derive the documents whose
  // rows do not reproduce their `file_hash` (a changed candidate above was
  // re-ingested from its file and reproduces now) and repair, from the file,
  // every one whose file is present and hashes to `file_hash` — the bytes the
  // store already agrees with; a missing or diverged file leaves its document
  // listed. Then the alert follows the remainder: cleared when none is left.
  const repaired = legacyBytesActive(store.db, repoId) ? repairLegacy(store, repoId, rootPath, fs, opts.ts ?? new Date().toISOString()) : [];

  // Step 6 (Phase 6a; spec/store §5.12, spec/sync §4.3): a repository whose
  // history is kept by an attached provider is checkpointed by the sweep — the
  // provider's worker runs once over the feed rows this sweep (and every write
  // since the last run) appended. Best effort: a provider that cannot run
  // leaves its alert and the rows wait for the next run; the sweep itself
  // never fails for it.
  runProviderCheckpoint(store, repoId, opts.ts);

  // Steps 7–8 (Phase 6b; spec/store §5.12 "Push"/"Fetch", spec/sync §4.3): the
  // remote half of an attached provider — push when the binding says
  // `periodic`, fetch (and merge the inbound tree through the vault sink below)
  // when it says `periodic`; both pause while a divergence alert stands. Best
  // effort like step 6: a remote that cannot be reached leaves its alert and the
  // sweep itself never fails for it.
  runProviderRemoteSync(store, repoId, fsVaultSink(store, repoId, rootPath, fs), opts.ts);

  return {
    ...result,
    scanned: snapshot.length,
    candidates: plan.candidates.length,
    changed: result.ingested.length > 0 || result.deleted.length > 0 || result.conflicted.length > 0 || result.failed.length > 0 || repaired.length > 0,
    materialized,
    repaired,
  };
}

/**
 * spec/sync §4.3 step 6 (Phase 6a): run the attached provider's checkpoint for a
 * repository whose manifest names one and is `enabled`; a provider that is not
 * attached or cannot run is `capability_unavailable` (its alert raised by
 * `requireProvider`) and swallowed here — writes continue, the next run catches up.
 */
export function runProviderCheckpoint(store: Store, repoId: string, now?: string): HistoryCheckpointResult | null {
  const row = readCapability(store.db, repoId, "history");
  if (!row || row.state !== "enabled" || historyProviderOf(row) === NATIVE_PROVIDER) return null;
  try {
    const provider = requireProvider(store.db, repoId, historyProviderOf(row), now);
    return provider.checkpoint(repoId, providerConfigOf(row), now !== undefined ? { now } : {});
  } catch (e) {
    if (e instanceof CapabilityUnavailable) return null;
    throw e;
  }
}

/**
 * spec/sync §4.3 steps 7–8 (Phase 6b): the attached provider's remote sync for a repository whose row is `enabled`
 * and binds a remote — null when none is attached, bound or usable (the provider's own alert stands; writes continue).
 */
export function runProviderRemoteSync(store: Store, repoId: string, vault: HistoryVaultSink, now?: string): HistoryRemoteSyncResult | null {
  const row = readCapability(store.db, repoId, "history");
  if (!row || row.state !== "enabled" || historyProviderOf(row) === NATIVE_PROVIDER) return null;
  try {
    const provider = requireProvider(store.db, repoId, historyProviderOf(row), now);
    if (!provider.remoteSync) return null;
    return provider.remoteSync(repoId, providerConfigOf(row), { now: now ?? new Date().toISOString(), vault });
  } catch (e) {
    if (e instanceof CapabilityUnavailable) return null;
    throw e;
  }
}

/**
 * The vault sink of a filesystem-backed repository (spec/store §5.12 "Fetch"; `HistoryVaultSink`): inbound content a
 * provider's remote half brings in is written as FILES under the repository's root — exactly what a human edit is —
 * then ingested as one observed batch (`processCheckpoint`: the echo gate, the reconcile, the feed row), with the
 * stat cache refreshed so the next sweep does not re-hash them. The provider never writes a row. `fs` is the sweep's
 * seam for the reads; the writes are `node:fs` (a fixture over an in-memory filesystem binds `observeBatch` instead).
 */
export function fsVaultSink(store: Store, repoId: string, rootPath: string, fs: SyncFs = nodeFs): HistoryVaultSink {
  return {
    apply(changes, ts) {
      if (changes.length === 0) return;
      for (const c of changes) {
        const abs = join(rootPath, c.path);
        if (c.content === null) rmSync(abs, { force: true });
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, c.content);
        }
      }
      const result = processCheckpoint(store, repoId, rootPath, changes.map((c) => ({ path: c.path })), { fs, ts });
      const failed = new Set(result.failed);
      for (const c of changes) {
        if (failed.has(c.path)) continue;
        if (c.content === null) store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, c.path);
        else {
          const st = fs.stat(rootPath, c.path);
          if (st) recordStat(store, repoId, c.path, st, sha256(c.content));
        }
      }
    },
  };
}

/** spec/sync §4.3 step 5: the repair pass over the alert's documents; returns the repaired paths in path order. */
function repairLegacy(store: Store, repoId: string, rootPath: string, fs: SyncFs, ts: string): string[] {
  const listed = unreproducibleDocs(store.db, repoId);
  const repaired: string[] = [];
  const remaining: typeof listed = [];
  for (const d of listed) {
    const bytes = fs.read(rootPath, d.path);
    const want = (store.db.prepare("SELECT file_hash FROM docs WHERE doc_id = ?").get(d.docId) as { file_hash: Buffer | null } | undefined)?.file_hash ?? null;
    if (bytes !== null && want !== null && sha256(bytes).equals(want) && repairLegacyBytes(store, d.docId, d.path, bytes) === "repaired") repaired.push(d.path);
    else remaining.push(d);
  }
  refreshLegacyBytesAlert(store.db, repoId, ts, remaining);
  return repaired;
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
    .prepare("SELECT path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL")
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

/**
 * Rebuild `file_stats` from scratch (spec/sync §4.3, since 1.1): delete the repo's rows, then
 * walk the tree and record a row only for a file whose bytes' hash equals its live doc's
 * `file_hash` — the cache is allowed to say "known" only about bytes the store already holds.
 * A file with no live doc, or whose bytes differ from what was ingested, gets no row, so the
 * next sweep still treats it as a candidate and drift still reports it (a cache rebuild must
 * never change what the next sweep does). Returns the number of files walked, recorded or not.
 */
export function rebuildFileStats(store: Store, repoId: string, rootPath: string, opts: { fs?: SyncFs } = {}): number {
  const fs = opts.fs ?? nodeFs;
  store.db.prepare("DELETE FROM file_stats WHERE repo_id = ?").run(repoId);
  // The live docs' durable convergence signal, keyed by path (one query).
  const live = new Map<string, Buffer>();
  for (const row of store.db
    .prepare("SELECT path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND file_hash IS NOT NULL")
    .all(repoId) as { path: string; file_hash: Buffer }[]) {
    live.set(row.path, row.file_hash);
  }
  const paths = fs.walk(rootPath);
  for (const path of paths) {
    const want = live.get(path);
    if (!want) continue; // no live doc: nothing the cache may vouch for
    const bytes = fs.read(rootPath, path);
    if (bytes === null) continue; // vanished between the walk and the read
    const hash = sha256(bytes);
    if (!hash.equals(want)) continue; // a pending edit: leave it visible
    recordStat(store, repoId, path, fs.stat(rootPath, path), hash);
  }
  return paths.length;
}
