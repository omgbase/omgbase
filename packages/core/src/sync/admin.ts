import type { Store } from "../core/store/store.js";
import { detectDiskDrift, type DiskDrift } from "./freshness.js";

// Admin surface (06 §Admin): repos_status, sync_status. sync_flush lives on the
// Watcher (force a checkpoint). These are read-your-own-writes helpers for
// agents to confirm state after telling a human to save.

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
  repoId: string;
  slug: string;
  rootPath: string;
  docs: number;
  blocks: number;
  commits: number;
  openEdges: number;
  /** docs whose file_hash != current revision rendered_hash (unconverged) */
  unconverged: number;
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
  const repo = store.db.prepare("SELECT slug, root_path FROM repos WHERE repo_id = ?").get(repoId) as { slug: string; root_path: string } | undefined;
  const count = (sql: string): number => (store.db.prepare(sql).get(repoId) as { c: number }).c;
  const unconverged = (store.db.prepare(
    `SELECT count(*) c FROM docs d JOIN revisions r ON r.rev_id = d.current_rev
     WHERE d.repo_id = ? AND d.deleted_commit IS NULL AND d.file_hash IS NOT r.rendered_hash`,
  ).get(repoId) as { c: number }).c;
  // Only scan when the caller explicitly supplies a rootPath. We deliberately
  // do NOT fall back to the repo's stored root_path: that column is a stale,
  // filesystem-only hint (NULL for sourceless repos) and using it would blur
  // the "the caller has a live working tree to verify against" signal that
  // `checked` is meant to convey.
  const disk: DiskStatus = rootPath
    ? { ...detectDiskDrift(store, repoId, rootPath), checked: true }
    : { changed: 0, deleted: 0, untracked: 0, checked: false };
  return {
    repoId,
    slug: repo?.slug ?? "",
    rootPath: repo?.root_path ?? "",
    docs: count("SELECT count(*) c FROM docs WHERE repo_id = ? AND deleted_commit IS NULL"),
    blocks: count("SELECT count(*) c FROM blocks WHERE repo_id = ? AND deleted_commit IS NULL"),
    commits: count("SELECT count(*) c FROM commits WHERE repo_id = ?"),
    openEdges: count("SELECT count(*) c FROM edges WHERE repo_id = ? AND to_commit IS NULL"),
    unconverged,
    disk,
  };
}

export interface SyncStatus {
  lastCommitSeq: number;
  lastCheckpoint: string | null;
  /**
   * true ONLY when the DB-internal convergence holds (unconverged === 0) AND a
   * disk scan ran (diskChecked) AND found no drift. When the disk scan could
   * not run, this is false even if the DB signal is clean — we never show green
   * on knowledge we can't confirm is fresh. See `diskChecked` to distinguish
   * "verified stale" from "unverified".
   */
  convergent: boolean;
  /** whether a disk-drift scan actually ran (rootPath available). */
  diskChecked: boolean;
  /** on-disk drift counts from the READ-ONLY scan (all 0 when !diskChecked). */
  disk: DiskStatus;
}

/**
 * @param rootPath optional working-tree root; forwarded to reposStatus so the
 *   disk-drift scan can run. Without it, `convergent` is false and
 *   `diskChecked` is false: disk freshness is UNVERIFIED, which we treat as
 *   non-convergent rather than optimistically green. Reporting the DB-only
 *   signal as convergent could hide a file deleted/edited on disk but not yet
 *   re-ingested — the exact stale-under-green-light failure this guards against.
 */
export function syncStatus(store: Store, repoId: string, rootPath?: string): SyncStatus {
  const lastCommit = store.db.prepare("SELECT MAX(seq) s FROM commits WHERE repo_id = ?").get(repoId) as { s: number | null };
  const lastCp = store.db.prepare("SELECT id FROM checkpoints WHERE repo_id = ? ORDER BY ts DESC LIMIT 1").get(repoId) as { id: string } | undefined;
  const status = reposStatus(store, repoId, rootPath);
  const noDrift = status.disk.changed === 0 && status.disk.deleted === 0 && status.disk.untracked === 0;
  return {
    lastCommitSeq: lastCommit.s ?? 0,
    lastCheckpoint: lastCp?.id ?? null,
    convergent: status.unconverged === 0 && status.disk.checked && noDrift,
    diskChecked: status.disk.checked,
    disk: status.disk,
  };
}
