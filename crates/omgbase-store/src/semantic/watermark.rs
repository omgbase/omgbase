//! The indexer's watermark (modular-core Phase 2): where the last complete
//! drain of a repository stood and under which index identity. Kept, until
//! the `capabilities` manifest table of `spec/store` 17.0 (§1.5) exists, as
//! a row of the semantic bundle's own bookkeeping in `sync_state` — `(repo_id,
//! source_id = '$semantic', path = '')`, an engine-written row under a
//! sentinel source no adapter can be named after (the sync layer reads
//! `sync_state` per attachment and never sees it); no new DDL in this
//! phase. `revision` holds the index identity `{ model, dims, chunking }`
//! the vectors were produced under, `cursor` holds `{ processed_seq }`, the
//! feed sequence. Byte for byte the reference's encoding
//! (`packages/core/src/semantic/indexer.ts`), so a workspace served by both
//! engines shares one watermark.
//!
//! Written only after a drain's every half succeeded; removed by
//! [`invalidate`] (a rebuild) so the next drain bootstraps.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};

use crate::core::semantic_shapes::IndexIdentity;
use crate::error::Result;

/// The `sync_state.source_id` sentinel the watermark row lives under.
pub const WATERMARK_SOURCE: &str = "$semantic";

/// A stored watermark.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watermark {
    /// The feed head (`spec/sync` §6 `seq`) the drain started from.
    pub processed_seq: i64,
    /// The identity the vectors were produced under.
    pub index: IndexIdentity,
}

/// The repository's watermark, `None` when absent or malformed (a malformed
/// one reads as absent: the next drain bootstraps and rewrites it).
pub fn read(conn: &Connection, repo_id: &str) -> Result<Option<Watermark>> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT revision, cursor FROM sync_state WHERE repo_id = ?1 AND source_id = ?2 AND path = ''",
            params![repo_id, WATERMARK_SOURCE],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((Some(revision), Some(cursor))) = row else {
        return Ok(None);
    };
    let index = serde_json::from_str::<Json>(&revision)
        .ok()
        .and_then(|v| IndexIdentity::from_json(&v));
    let processed_seq = serde_json::from_str::<Json>(&cursor)
        .ok()
        .and_then(|v| v.get("processed_seq").and_then(Json::as_i64));
    Ok(match (processed_seq, index) {
        (Some(processed_seq), Some(index)) => Some(Watermark {
            processed_seq,
            index,
        }),
        _ => None,
    })
}

/// Write (replace) the repository's watermark.
pub fn write(conn: &Connection, repo_id: &str, mark: &Watermark) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?1, ?2, '', ?3, ?4)
         ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor",
        params![
            repo_id,
            WATERMARK_SOURCE,
            mark.index.to_json().to_string(),
            json!({ "processed_seq": mark.processed_seq }).to_string(),
        ],
    )?;
    Ok(())
}

/// Remove the repository's watermark (the next drain bootstraps).
pub fn invalidate(conn: &Connection, repo_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE repo_id = ?1 AND source_id = ?2 AND path = ''",
        params![repo_id, WATERMARK_SOURCE],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn identity(model: &str) -> IndexIdentity {
        IndexIdentity {
            model: model.to_owned(),
            dim: 8,
            chunking: 1,
        }
    }

    #[test]
    fn the_watermark_is_the_references_sync_state_row() {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("r").unwrap();
        let conn = store.conn();
        assert_eq!(read(conn, &repo).unwrap(), None);
        let mark = Watermark {
            processed_seq: 7,
            index: identity("m"),
        };
        write(conn, &repo, &mark).unwrap();
        assert_eq!(read(conn, &repo).unwrap(), Some(mark.clone()));
        let (revision, cursor): (String, String) = conn
            .query_row(
                "SELECT revision, cursor FROM sync_state WHERE repo_id = ?1 AND source_id = '$semantic' AND path = ''",
                params![&repo],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(revision, r#"{"model":"m","dims":8,"chunking":1}"#);
        assert_eq!(cursor, r#"{"processed_seq":7}"#);
        // Replace, then invalidate.
        write(
            conn,
            &repo,
            &Watermark {
                processed_seq: 9,
                index: identity("n"),
            },
        )
        .unwrap();
        assert_eq!(read(conn, &repo).unwrap().unwrap().processed_seq, 9);
        invalidate(conn, &repo).unwrap();
        assert_eq!(read(conn, &repo).unwrap(), None);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_malformed_watermark_reads_as_absent() {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("r").unwrap();
        let conn = store.conn();
        conn.execute(
            "INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?1, '$semantic', '', ?2, ?3)",
            params![&repo, r#"{"model":"m","dims":8,"chunking":1}"#, r#"{"processed_seq":"seven"}"#],
        )
        .unwrap();
        assert_eq!(read(conn, &repo).unwrap(), None);
        conn.execute(
            "UPDATE sync_state SET revision = 'not json', cursor = '{\"processed_seq\":1}' WHERE repo_id = ?1",
            params![&repo],
        )
        .unwrap();
        assert_eq!(read(conn, &repo).unwrap(), None);
        conn.execute(
            "UPDATE sync_state SET revision = NULL WHERE repo_id = ?1",
            params![&repo],
        )
        .unwrap();
        assert_eq!(read(conn, &repo).unwrap(), None);
    }
}
