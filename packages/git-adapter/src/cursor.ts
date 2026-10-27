import type { Store } from "@omgbase/core";

type Database = Store["db"];

// The worker's cursor (spec/sync §6 "The `$git` cursor row", 4.5; 4.6): one
// row of `sync_state` per repository — `(repo_id, '$git', '')`, like the
// semantic watermark's `$semantic` — `revision` the branch tip sha, `cursor`
// JSON `{ epoch, seq, pushed? }`. `{ epoch, seq }` is a CACHE of what the tip's
// `omgbase-seq` trailer says, refined (17.6) past it when the tip is not one of
// the worker's own commits (a fast-forward to the remote's tip) or when rows
// folded into no commit (their bytes were already in the tree): the worker
// resumes from the trailer, or from the row when the row names the tip and
// stands further on. `pushed` (17.6, Phase 6b) records the last push — the tip
// pushed and the seq its trailer covers, `pushed_through` on the wire. The
// worker writes the row after every commit; a crash between the ref and the
// row leaves the row behind the tip, which the next run reads past.

export const GIT_CURSOR_SOURCE = "$git";

export interface GitPushed {
  /** the tip the remote holds since the last push */
  tip: string;
  /** the feed seq that tip's `omgbase-seq` trailer covers — `pushed_through`; null when the tip has no trailer of this epoch */
  seq: number | null;
}

export interface GitCursor {
  tip: string;
  epoch: string;
  seq: number;
  pushed: GitPushed | null;
}

export function readGitCursor(db: Database, repoId: string): GitCursor | null {
  const row = db.prepare("SELECT revision, cursor FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''").get(repoId, GIT_CURSOR_SOURCE) as { revision: string | null; cursor: string | null } | undefined;
  if (!row?.revision || !row.cursor) return null;
  try {
    const c = JSON.parse(row.cursor) as { epoch?: unknown; seq?: unknown; pushed?: unknown };
    if (typeof c.epoch !== "string" || typeof c.seq !== "number") return null;
    const p = c.pushed as { tip?: unknown; seq?: unknown } | undefined;
    const pushed = p && typeof p.tip === "string" ? { tip: p.tip, seq: typeof p.seq === "number" ? p.seq : null } : null;
    return { tip: row.revision, epoch: c.epoch, seq: c.seq, pushed };
  } catch {
    return null;
  }
}

/** Write the position; `pushed` is kept from the existing row unless given. */
export function writeGitCursor(db: Database, repoId: string, cursor: Omit<GitCursor, "pushed"> & { pushed?: GitPushed | null }): void {
  const pushed = cursor.pushed !== undefined ? cursor.pushed : (readGitCursor(db, repoId)?.pushed ?? null);
  db.prepare(
    `INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?, ?, '', ?, ?)
     ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor`,
  ).run(repoId, GIT_CURSOR_SOURCE, cursor.tip, JSON.stringify({ epoch: cursor.epoch, seq: cursor.seq, ...(pushed ? { pushed } : {}) }));
}

/** Record a push (17.6): the row's position is kept, `pushed` replaced; a repository with no row yet gets one at the tip. */
export function writeGitPushed(db: Database, repoId: string, epoch: string, pushed: GitPushed | null): void {
  const existing = readGitCursor(db, repoId);
  if (existing) writeGitCursor(db, repoId, { ...existing, pushed });
  else if (pushed) writeGitCursor(db, repoId, { tip: pushed.tip, epoch, seq: pushed.seq ?? 0, pushed });
}

export function clearGitCursor(db: Database, repoId: string): void {
  db.prepare("DELETE FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''").run(repoId, GIT_CURSOR_SOURCE);
}
