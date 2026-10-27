import type { Store } from "@omgbase/core";

type Database = Store["db"];

// The worker's cursor (spec/sync §6 "The `$git` cursor row", 4.5): one row of
// `sync_state` per repository — `(repo_id, '$git', '')`, like the semantic
// watermark's `$semantic` — `revision` the branch tip sha, `cursor` JSON
// `{ epoch, seq }`. A CACHE of what the tip's `omgbase-seq` trailer says: the
// worker resumes from the trailer (the truth — it moved with the ref), writes
// the row after every commit, and a crash between the two leaves the row behind
// the tip, which the next run reads past.

export const GIT_CURSOR_SOURCE = "$git";

export interface GitCursor {
  tip: string;
  epoch: string;
  seq: number;
}

export function readGitCursor(db: Database, repoId: string): GitCursor | null {
  const row = db.prepare("SELECT revision, cursor FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''").get(repoId, GIT_CURSOR_SOURCE) as { revision: string | null; cursor: string | null } | undefined;
  if (!row?.revision || !row.cursor) return null;
  try {
    const c = JSON.parse(row.cursor) as { epoch?: unknown; seq?: unknown };
    if (typeof c.epoch !== "string" || typeof c.seq !== "number") return null;
    return { tip: row.revision, epoch: c.epoch, seq: c.seq };
  } catch {
    return null;
  }
}

export function writeGitCursor(db: Database, repoId: string, cursor: GitCursor): void {
  db.prepare(
    `INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?, ?, '', ?, ?)
     ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor`,
  ).run(repoId, GIT_CURSOR_SOURCE, cursor.tip, JSON.stringify({ epoch: cursor.epoch, seq: cursor.seq }));
}

export function clearGitCursor(db: Database, repoId: string): void {
  db.prepare("DELETE FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''").run(repoId, GIT_CURSOR_SOURCE);
}
