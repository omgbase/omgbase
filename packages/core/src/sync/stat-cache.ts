import type { Store } from "../core/store/store.js";
import { nodeFs, type FileStat } from "./fs-util.js";

// The `file_stats` writers (spec/sync §4.3 step 4), split out of freshness.ts
// so the mutation write target (`mutate/doc-store.ts`, which refreshes a row
// after each file it materializes) and the sweep (which imports the doc store
// for its step 0) do not import each other. freshness.ts re-exports both.

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
