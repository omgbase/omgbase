import type { Store } from "../core/store/store.js";

// Admin surface (06 §Admin): repos_status, sync_status. sync_flush lives on the
// Watcher (force a checkpoint). These are read-your-own-writes helpers for
// agents to confirm state after telling a human to save.

export interface RepoStatus {
  repoId: string;
  slug: string;
  rootPath: string;
  documents: number;
  blocks: number;
  commits: number;
  openEdges: number;
  /** docs whose file_hash != current revision rendered_hash (unconverged) */
  unconverged: number;
}

export function reposStatus(store: Store, repoId: string): RepoStatus {
  const repo = store.db.prepare("SELECT slug, root_path FROM repos WHERE repo_id = ?").get(repoId) as { slug: string; root_path: string } | undefined;
  const count = (sql: string): number => (store.db.prepare(sql).get(repoId) as { c: number }).c;
  const unconverged = (store.db.prepare(
    `SELECT count(*) c FROM documents d JOIN revisions r ON r.rev_id = d.current_rev
     WHERE d.repo_id = ? AND d.deleted_commit IS NULL AND d.file_hash IS NOT r.rendered_hash`,
  ).get(repoId) as { c: number }).c;
  return {
    repoId,
    slug: repo?.slug ?? "",
    rootPath: repo?.root_path ?? "",
    documents: count("SELECT count(*) c FROM documents WHERE repo_id = ? AND deleted_commit IS NULL"),
    blocks: count("SELECT count(*) c FROM blocks WHERE repo_id = ? AND deleted_commit IS NULL"),
    commits: count("SELECT count(*) c FROM commits WHERE repo_id = ?"),
    openEdges: count("SELECT count(*) c FROM edges WHERE repo_id = ? AND to_commit IS NULL"),
    unconverged,
  };
}

export interface SyncStatus {
  lastCommitSeq: number;
  lastCheckpoint: string | null;
  convergent: boolean;
}

export function syncStatus(store: Store, repoId: string): SyncStatus {
  const lastCommit = store.db.prepare("SELECT MAX(seq) s FROM commits WHERE repo_id = ?").get(repoId) as { s: number | null };
  const lastCp = store.db.prepare("SELECT id FROM checkpoints WHERE repo_id = ? ORDER BY ts DESC LIMIT 1").get(repoId) as { id: string } | undefined;
  const status = reposStatus(store, repoId);
  return {
    lastCommitSeq: lastCommit.s ?? 0,
    lastCheckpoint: lastCp?.id ?? null,
    convergent: status.unconverged === 0,
  };
}
