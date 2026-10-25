//! `spec/search` §1.3 `text_search`: the FTS5 index over the live leaves is
//! current state (search 1.2), so the text search is the core's; the
//! embedding half of the search module is `semantic::search`, which
//! re-exports these names under their old path.

use omgbase_search::sanitize_fts_query;
use rusqlite::{Connection, params};

use crate::Store;
use crate::error::Result;

/// §1.3 / §4: the default `limit`.
pub const DEFAULT_LIMIT: usize = 50;

// ---- text search (§1.3) --------------------------------------------------------------

/// One `text_search` hit; `score = −bm25` (higher is better). On the wire
/// (`blocks_search`) it is the block row under its engine names — `{ _id,
/// _doc_id, _path, _type, _text, score }` (`spec/surface` §1.2, 5.0).
#[derive(Clone, Debug, PartialEq)]
pub struct TextHit {
    pub block_id: String,
    pub doc_id: String,
    pub path: String,
    pub block_type: String,
    pub text: String,
    pub score: f64,
}

/// `text_search`'s result.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextSearchResult {
    pub hits: Vec<TextHit>,
    /// More than `limit` blocks matched.
    pub truncated: bool,
}

/// §1.3: the live blocks of the repo whose FTS row matches the sanitized
/// query, by `bm25(blocks_fts)` ascending, limited; no hits when the query
/// sanitizes to nothing.
pub fn text_search(
    conn: &Connection,
    repo_id: &str,
    query: &str,
    limit: usize,
) -> Result<TextSearchResult> {
    let m = sanitize_fts_query(query);
    if m.is_empty() {
        return Ok(TextSearchResult::default());
    }
    let mut stmt = conn.prepare_cached(
        "SELECT b.block_id, b.doc_id, d.path, b.type, b.text, bm25(blocks_fts) AS score
         FROM blocks_fts
         JOIN blocks b ON b.rowid = blocks_fts.rowid
         JOIN docs d ON d.doc_id = b.doc_id
         WHERE blocks_fts MATCH ?1 AND b.repo_id = ?2 AND b.deleted_commit IS NULL
         ORDER BY score
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![m, repo_id, (limit + 1) as i64], |r| {
        Ok(TextHit {
            block_id: r.get(0)?,
            doc_id: r.get(1)?,
            path: r.get(2)?,
            block_type: r.get(3)?,
            text: r.get(4)?,
            score: -r.get::<_, f64>(5)?,
        })
    })?;
    let mut hits = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let truncated = hits.len() > limit;
    hits.truncate(limit);
    Ok(TextSearchResult { hits, truncated })
}

impl Store {
    /// `spec/search` §1.3.
    pub fn text_search(
        &self,
        repo_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<TextSearchResult> {
        text_search(&self.conn, repo_id, query, limit)
    }
}
