import type { Store } from "../core/store/store.js";
import { feedStatus, type FeedStatus } from "../core/store/feed.js";
import { detectDiskDrift, type DiskDrift } from "./freshness.js";
import { lastBatch } from "./checkpoint.js";
import { capabilityStates, type CapabilityStates } from "./capability-state.js";

// Admin surface (06 §Admin; spec/sync §4.4, 4.0): repos_status, sync_status.
// sync_flush lives on the Watcher (force a batch). These are read-your-own-
// writes helpers for agents to confirm state after telling a human to save.
// Since store 17.0 (D7/D9) the counts name the FEED — `{ epoch, oldest, head }`
// in place of a `commits` count and the retired `unconverged` (identically
// zero under I1; `disk.changed` is the signal) — and `sync_status` reports the
// last observed batch from the repository's status row (D4) instead of a
// checkpoint id.

/**
 * On-disk agreement for a repo. Present only when a rootPath was supplied so a
 * READ-ONLY disk-drift scan could run. When absent, disk agreement is UNKNOWN
 * — callers must NOT treat that as "converged" (see syncStatus).
 */
export interface DiskStatus extends DiskDrift {
  /** true iff a disk scan actually ran (rootPath supplied). */
  checked: boolean;
}

export interface RepoStatus {
  /** the repository's own id (spec/surface §1.2, 5.0: the root row's `_id`) */
  _id: string;
  slug: string;
  rootPath: string;
  docs: number;
  blocks: number;
  /** the change feed's position (spec/store §3.1 `feed`): the repository's epoch, the oldest retained `seq`, the head */
  feed: FeedStatus;
  openEdges: number;
  /**
   * On-disk drift vs the DB, from a READ-ONLY scan. `checked` is false when no
   * rootPath was available (disk agreement UNVERIFIED); drift counts are 0 in
   * that case but MUST NOT be read as "no drift".
   */
  disk: DiskStatus;
}

/**
 * @param rootPath optional working-tree root. When provided, a READ-ONLY
 *   disk-drift scan runs and populates `disk`. When omitted, `disk.checked` is
 *   false and disk agreement is unverified (do not infer convergence from it).
 */
export function reposStatus(store: Store, repoId: string, rootPath?: string): RepoStatus {
  const repo = store.db.prepare("SELECT slug FROM repos WHERE repo_id = ?").get(repoId) as { slug: string } | undefined;
  const count = (sql: string): number => (store.db.prepare(sql).get(repoId) as { c: number }).c;
  // Only scan when the caller explicitly supplies a rootPath. We deliberately
  // do NOT fall back to the repo's stored root_path: that column is a stale,
  // filesystem-only hint (NULL for sourceless repos) and using it would blur
  // the "the caller has a live working tree to verify against" signal that
  // `checked` is meant to convey.
  const disk: DiskStatus = rootPath
    ? { ...detectDiskDrift(store, repoId, rootPath), checked: true }
    : { changed: 0, deleted: 0, untracked: 0, checked: false };
  return {
    _id: repoId,
    slug: repo?.slug ?? "",
    rootPath: rootPath ?? "",
    docs: count("SELECT count(*) c FROM docs WHERE repo_id = ? AND deleted_at IS NULL"),
    blocks: count("SELECT count(*) c FROM blocks WHERE repo_id = ? AND deleted_at IS NULL"),
    feed: feedStatus(store.db, repoId),
    openEdges: count("SELECT count(*) c FROM edges WHERE repo_id = ?"),
    disk,
  };
}

export interface SyncStatus {
  /** the feed's epoch (a cursor is `(epoch, seq)`) */
  epoch: string;
  /** the oldest retained feed `seq` (0 when the feed is empty) */
  oldest: number;
  /** the feed's head: the greatest `seq` (0 when empty) */
  head: number;
  /** the last observed batch (the repository's status row, spec/sync §4.1), or null when none ran */
  lastBatch: { ts: string; batchId: string | null; files: number } | null;
  /**
   * true ONLY when a disk scan ran (diskChecked) AND found no drift. When the
   * disk scan could not run, this is false — we never show green on knowledge
   * we can't confirm is fresh. See `diskChecked` to distinguish "verified
   * stale" from "unverified".
   */
  convergent: boolean;
  /** whether a disk-drift scan actually ran (rootPath available). */
  diskChecked: boolean;
  /** on-disk drift counts from the READ-ONLY scan (all 0 when !diskChecked). */
  disk: DiskStatus;
  /** the capabilities as `version` reports them */
  capabilities: CapabilityStates;
}

/**
 * @param rootPath optional working-tree root; forwarded to reposStatus so the
 *   disk-drift scan can run. Without it, `convergent` is false and
 *   `diskChecked` is false: disk freshness is UNVERIFIED, which we treat as
 *   non-convergent rather than optimistically green — a file deleted/edited on
 *   disk but not yet re-ingested is the exact stale-under-green-light failure
 *   this guards against.
 */
export function syncStatus(store: Store, repoId: string, rootPath?: string): SyncStatus {
  const status = reposStatus(store, repoId, rootPath);
  const noDrift = status.disk.changed === 0 && status.disk.deleted === 0 && status.disk.untracked === 0;
  return {
    epoch: status.feed.epoch,
    oldest: status.feed.oldest,
    head: status.feed.head,
    lastBatch: lastBatch(store.db, repoId),
    convergent: status.disk.checked && noDrift,
    diskChecked: status.disk.checked,
    disk: status.disk,
    capabilities: capabilityStates(store, repoId),
  };
}

/** The `repos` tool's result: every repo of the workspace and whether an `fs` source feeds it. */
export interface ReposList {
  repos: { slug: string; hasSource: boolean }[];
}

/**
 * `repos` (spec/surface §4): the workspace's repos by slug, `hasSource` when an
 * `fs` source is attached. Shared by the MCP tool and `omg repos --json` so the
 * shape cannot drift; per-repo counts are `reposStatus`.
 */
export function reposList(store: Store): ReposList {
  const rows = store.db
    .prepare(
      "SELECT r.slug AS slug, MAX(CASE WHEN s.adapter = 'fs' THEN 1 ELSE 0 END) AS has_fs FROM repos r LEFT JOIN attachments a ON a.repo_id = r.repo_id LEFT JOIN sources s ON s.source_id = a.source_id GROUP BY r.repo_id, r.slug ORDER BY r.slug",
    )
    .all() as { slug: string; has_fs: number }[];
  return { repos: rows.map((r) => ({ slug: r.slug, hasSource: r.has_fs === 1 })) };
}
