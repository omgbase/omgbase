//! The worker's cursor (`spec/sync` §6 "The `$git` cursor row", 4.5): one row
//! of `sync_state` per repository — `(repo_id, '$git', '')`, like the semantic
//! watermark's `$semantic` — `revision` the branch tip sha, `cursor` JSON
//! `{ epoch, seq }`. A CACHE of what the tip's `omgbase-seq` trailer says: the
//! worker resumes from the trailer (the truth — it moved with the ref), writes
//! the row after every commit, and a crash between the two leaves the row
//! behind the tip, which the next run reads past.

use omgbase_store::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};

/// The sentinel source id of the cursor row.
pub const GIT_CURSOR_SOURCE: &str = "$git";

/// The cursor as read: the tip and the feed position it covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitCursor {
    pub tip: String,
    pub epoch: String,
    pub seq: i64,
}

/// The repository's cursor row, `None` when absent or malformed.
pub fn read_git_cursor(conn: &Connection, repo_id: &str) -> Result<Option<GitCursor>> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT revision, cursor FROM sync_state WHERE repo_id = ?1 AND source_id = ?2 AND path = ''",
            params![repo_id, GIT_CURSOR_SOURCE],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((Some(tip), Some(cursor))) = row else {
        return Ok(None);
    };
    let Ok(c) = serde_json::from_str::<Json>(&cursor) else {
        return Ok(None);
    };
    let (Some(epoch), Some(seq)) = (
        c.get("epoch").and_then(Json::as_str),
        c.get("seq").and_then(Json::as_i64),
    ) else {
        return Ok(None);
    };
    Ok(Some(GitCursor {
        tip,
        epoch: epoch.to_owned(),
        seq,
    }))
}

/// Upsert the cursor row after a commit.
pub fn write_git_cursor(conn: &Connection, repo_id: &str, cursor: &GitCursor) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?1, ?2, '', ?3, ?4)
         ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor",
        params![
            repo_id,
            GIT_CURSOR_SOURCE,
            cursor.tip,
            json!({ "epoch": cursor.epoch, "seq": cursor.seq }).to_string(),
        ],
    )?;
    Ok(())
}

/// `history purge`: the cursor row leaves with the repository.
pub fn clear_git_cursor(conn: &Connection, repo_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE repo_id = ?1 AND source_id = ?2 AND path = ''",
        params![repo_id, GIT_CURSOR_SOURCE],
    )?;
    Ok(())
}
