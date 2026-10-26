//! Legacy bytes (`spec/store` §3.4 step 17 (16), §5.11, §8 C9; store 17.4 —
//! modular-core Phase 5a-ii, finding F1 of the migration qualification). A
//! document ingested before the store kept block trivia (schema v6 added
//! `blocks.trivia_hash`; v7 `docs.frontmatter_trivia`) has rows whose `raw`s
//! are right but whose separators are gone: the 16.x `reconstruct` assumed a
//! NULL trivia meant empty trailing bytes and read `# H\n\n## T\n` as
//! `# H## T`, while the file and `docs.file_hash` were correct. Migration 17
//! copies the rows as they are, so the 17 rows reproduce the same wrong
//! bytes. The store records the condition as the `legacy_bytes` alert —
//! raised by the migration (both entry points), re-derived by `doctor` and by
//! every sweep while it is active — and `omg sync` repairs the rows from the
//! files (`omgbase_sync::legacy_bytes`). No column is spent on it: the
//! alert's detail carries the count and a bounded sample of ids, and the
//! condition is re-derived where it is cheap enough. Port of
//! `packages/core/src/core/store/legacy-bytes.ts`.

use omgbase_format::hash::sha256;
use rusqlite::{Connection, params};
use serde_json::{Map, Value as Json};

use crate::core::alerts::{
    AlertInput, AlertSeverity, clear_alert, list_active_alerts, raise_alert,
};
use crate::core::read::reconstruct;
use crate::error::Result;

/// The alert code (a `warning`).
pub const LEGACY_BYTES_ALERT: &str = "legacy_bytes";

/// How many document ids the alert's `detail.sample` carries at most.
pub const LEGACY_BYTES_SAMPLE: usize = 20;

/// The alert's message, byte for byte in both engines.
#[must_use]
pub fn legacy_bytes_message(docs: usize) -> String {
    format!(
        "{docs} document(s) carry bytes the engine cannot reproduce from its rows (imported before block trivia was stored); omg sync repairs them from the files"
    )
}

/// A live document whose rows do not reproduce its `file_hash`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnreproducibleDoc {
    pub doc_id: String,
    pub path: String,
}

/// The fidelity check (`spec/store` §5.11 "The condition"): every live
/// document of the repository with a `file_hash` whose rows do NOT reproduce
/// it — `sha256(reconstruct(doc)) != file_hash` (§6.1) — in bytewise `path`
/// order. O(the repository's bytes): the migration runs it once, `doctor` on
/// demand, the sweep only while the alert is active.
pub fn unreproducible_docs(conn: &Connection, repo_id: &str) -> Result<Vec<UnreproducibleDoc>> {
    let rows: Vec<(String, String, Vec<u8>)> = {
        let mut stmt = conn.prepare(
            "SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND file_hash IS NOT NULL ORDER BY path",
        )?;
        let it = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    for (doc_id, path, file_hash) in rows {
        let Some(content) = reconstruct(conn, &doc_id)? else {
            continue;
        };
        if sha256(content.as_bytes())[..] != file_hash[..] {
            out.push(UnreproducibleDoc { doc_id, path });
        }
    }
    Ok(out)
}

/// The cheap signature of legacy rows (`spec/store` §3.4 step 17 (16), the
/// on-open entry point): a live top-level block with a NULL `trivia` that has
/// a later top-level sibling in its document, or a live document with a
/// `frontmatter_raw` and no `frontmatter_trivia`. The current ingest never
/// writes either — `spec/format` §1 rule 4: a block's `raw` never ends in a
/// line ending, so the bytes between two top-level blocks are at least one,
/// and the frontmatter's separator is always stored. A metadata scan of
/// `blocks`, no bytes hashed; when it fires the full check runs.
pub fn legacy_bytes_suspected(conn: &Connection, repo_id: &str) -> Result<bool> {
    let block = conn
        .prepare(
            "SELECT 1 FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
        WHERE d.repo_id = ?1 AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND b.parent_block IS NULL AND b.trivia IS NULL
          AND EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block IS NULL AND c.deleted_at IS NULL AND c.order_key > b.order_key)
        LIMIT 1",
        )?
        .exists(params![repo_id])?;
    if block {
        return Ok(true);
    }
    Ok(conn
        .prepare(
            "SELECT 1 FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND frontmatter_raw IS NOT NULL AND frontmatter_trivia IS NULL LIMIT 1",
        )?
        .exists(params![repo_id])?)
}

/// The alert's detail: `{ docs: <n>, sample: [<the first 20 ids>] }`.
#[must_use]
pub fn legacy_bytes_detail(docs: &[UnreproducibleDoc]) -> Map<String, Json> {
    let mut detail = Map::new();
    detail.insert("docs".to_owned(), Json::from(docs.len()));
    detail.insert(
        "sample".to_owned(),
        Json::Array(
            docs.iter()
                .take(LEGACY_BYTES_SAMPLE)
                .map(|d| Json::String(d.doc_id.clone()))
                .collect(),
        ),
    );
    detail
}

/// Re-derive the condition at `now` and write the channel (`spec/store`
/// §5.8): some unreproducible document → `legacy_bytes` raised (`warning`,
/// detail `{ docs: <n>, sample: [<the first 20 ids in path order>] }`); none
/// → cleared. `docs` may be supplied by a caller that just computed it.
/// Returns the list.
pub fn refresh_legacy_bytes_alert(
    conn: &Connection,
    repo_id: &str,
    now: &str,
    docs: Option<Vec<UnreproducibleDoc>>,
) -> Result<Vec<UnreproducibleDoc>> {
    let docs = match docs {
        Some(d) => d,
        None => unreproducible_docs(conn, repo_id)?,
    };
    if docs.is_empty() {
        clear_alert(conn, repo_id, LEGACY_BYTES_ALERT, now)?;
    } else {
        let detail = legacy_bytes_detail(&docs);
        raise_alert(
            conn,
            repo_id,
            &AlertInput {
                code: LEGACY_BYTES_ALERT,
                severity: AlertSeverity::Warning,
                message: &legacy_bytes_message(docs.len()),
                detail: Some(&detail),
            },
            now,
        )?;
    }
    Ok(docs)
}

/// Whether the repository's `legacy_bytes` alert is active (the sweep's gate
/// for the repair, `spec/sync` §4.3 step 5).
pub fn legacy_bytes_active(conn: &Connection, repo_id: &str) -> Result<bool> {
    Ok(list_active_alerts(conn, repo_id)?
        .iter()
        .any(|a| a.code == LEGACY_BYTES_ALERT))
}
