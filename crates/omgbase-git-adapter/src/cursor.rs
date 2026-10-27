//! The worker's cursor (`spec/sync` §6 "The `$git` cursor row", 4.5; 4.6): one
//! row of `sync_state` per repository — `(repo_id, '$git', '')`, like the
//! semantic watermark's `$semantic` — `revision` the branch tip sha, `cursor`
//! JSON `{ epoch, seq, pushed? }`. `{ epoch, seq }` is a CACHE of what the
//! tip's `omgbase-seq` trailer says, refined (17.6) past it when the tip is
//! not one of the worker's own commits (a fast-forward to the remote's tip)
//! or when rows folded into no commit (their bytes were already in the
//! tree): the worker resumes from the trailer, or from the row when the row
//! names the tip and stands further on. `pushed` (17.6, Phase 6b) records
//! the last push — the tip pushed and the seq its trailer covers,
//! `pushed_through` on the wire. The worker writes the row after every
//! commit; a crash between the ref and the row leaves the row behind the
//! tip, which the next run reads past.

use omgbase_store::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

/// The sentinel source id of the cursor row.
pub const GIT_CURSOR_SOURCE: &str = "$git";

/// The last push (17.6): the tip the remote holds and the feed seq its
/// `omgbase-seq` trailer covers (`None` when the tip has no trailer of this
/// epoch).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitPushed {
    pub tip: String,
    pub seq: Option<i64>,
}

/// The cursor as read: the tip, the feed position it covers, the last push.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitCursor {
    pub tip: String,
    pub epoch: String,
    pub seq: i64,
    pub pushed: Option<GitPushed>,
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
    let pushed = c
        .get("pushed")
        .and_then(Json::as_object)
        .and_then(|p| p.get("tip").and_then(Json::as_str).map(|t| (t, p)))
        .map(|(t, p)| GitPushed {
            tip: t.to_owned(),
            seq: p.get("seq").and_then(Json::as_i64),
        });
    Ok(Some(GitCursor {
        tip,
        epoch: epoch.to_owned(),
        seq,
        pushed,
    }))
}

fn write_row(conn: &Connection, repo_id: &str, cursor: &GitCursor) -> Result<()> {
    let mut c = Map::new();
    c.insert("epoch".to_owned(), Json::String(cursor.epoch.clone()));
    c.insert("seq".to_owned(), Json::from(cursor.seq));
    if let Some(p) = &cursor.pushed {
        c.insert("pushed".to_owned(), json!({ "tip": p.tip, "seq": p.seq }));
    }
    conn.execute(
        "INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?1, ?2, '', ?3, ?4)
         ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor",
        params![
            repo_id,
            GIT_CURSOR_SOURCE,
            cursor.tip,
            Json::Object(c).to_string(),
        ],
    )?;
    Ok(())
}

/// Upsert the position (`tip`, `epoch`, `seq`); `pushed` is kept from the
/// existing row (the reference's `writeGitCursor` without `pushed`).
pub fn write_git_cursor(
    conn: &Connection,
    repo_id: &str,
    tip: &str,
    epoch: &str,
    seq: i64,
) -> Result<()> {
    let pushed = read_git_cursor(conn, repo_id)?.and_then(|c| c.pushed);
    write_row(
        conn,
        repo_id,
        &GitCursor {
            tip: tip.to_owned(),
            epoch: epoch.to_owned(),
            seq,
            pushed,
        },
    )
}

/// Record a push (17.6): the row's position is kept, `pushed` replaced; a
/// repository with no row yet gets one at the pushed tip.
pub fn write_git_pushed(
    conn: &Connection,
    repo_id: &str,
    epoch: &str,
    pushed: Option<GitPushed>,
) -> Result<()> {
    match (read_git_cursor(conn, repo_id)?, pushed) {
        (Some(existing), pushed) => write_row(conn, repo_id, &GitCursor { pushed, ..existing }),
        (None, Some(p)) => write_row(
            conn,
            repo_id,
            &GitCursor {
                tip: p.tip.clone(),
                epoch: epoch.to_owned(),
                seq: p.seq.unwrap_or(0),
                pushed: Some(p),
            },
        ),
        (None, None) => Ok(()),
    }
}

/// `history purge`: the cursor row leaves with the repository.
pub fn clear_git_cursor(conn: &Connection, repo_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE repo_id = ?1 AND source_id = ?2 AND path = ''",
        params![repo_id, GIT_CURSOR_SOURCE],
    )?;
    Ok(())
}
