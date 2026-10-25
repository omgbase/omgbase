//! `spec/search` §1.3 `text_search`: the FTS5 index over the live leaves is
//! current state (search 1.2), so the text search is the core's — and so is
//! the §4 fusion (`fuse_and_boost`, `resolve`) over an FTS ranking and a
//! vector ranking **handed in**: the core never reads a vector; the semantic
//! extension (`semantic::search`) computes the vector half through its own
//! cache and calls down here, and `blocks_resolve` without a provider is
//! this module alone. The embedding half of the search module is
//! `semantic::search`, which re-exports these names under their old path.

use omgbase_search::{
    BoostFacts, Evidence, HYBRID_PASS_LIMIT, RESOLVE_DEFAULT_LIMIT, apply_boosts, compute_boosts,
    default_terms, fuse, locator, lower_terms, preview, property_to_string, sanitize_fts_query,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::Store;
use crate::core::properties;
use crate::core::semantic_shapes::{HybridHit, ResolveHit};
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

// ---- fusion and resolve (§4) — the FTS half ---------------------------------------------

/// §4 step 4's facts for one block.
fn boost_facts(conn: &Connection, doc_id: &str, block_id: &str, path: &str) -> Result<BoostFacts> {
    let props = omgbase_properties::merged(&properties::read_doc_properties(conn, doc_id)?);
    let headings: Vec<String> = {
        let mut stmt = conn.prepare_cached(
            "SELECT hb.text FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
             JOIN blocks b ON b.doc_id = s.doc_id AND b.ordinal BETWEEN s.first_ordinal AND s.last_ordinal
             WHERE b.block_id = ?1",
        )?;
        let it = stmt.query_map(params![block_id], |r| r.get(0))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok(BoostFacts {
        title: property_to_string(props.get("title")),
        layer: property_to_string(props.get("layer")),
        path: path.to_owned(),
        headings,
    })
}

/// §4: RRF-fuse the FTS ranking of `text` (capped at 200) with `vector_hits`
/// — `(block_id, cosine)` in rank order, already capped by whoever scored
/// them — drop candidates whose block no longer exists, apply the boosts
/// (`terms`, default `text` split on whitespace), sort by score then
/// `block_id`, limit. The core's half of `hybrid_search`: it reads no vector.
pub fn fuse_and_boost(
    conn: &Connection,
    repo_id: &str,
    text: Option<&str>,
    vector_hits: &[(String, f64)],
    terms: Option<&[String]>,
    limit: usize,
) -> Result<Vec<HybridHit>> {
    let terms = lower_terms(&terms.map_or_else(|| default_terms(text), <[String]>::to_vec));
    let fts_ids: Vec<String> = match text.filter(|t| !t.is_empty()) {
        Some(text) => text_search(conn, repo_id, text, HYBRID_PASS_LIMIT)?
            .hits
            .into_iter()
            .map(|h| h.block_id)
            .collect(),
        None => Vec::new(),
    };
    let mut meta = conn.prepare_cached(
        "SELECT doc_id, (SELECT path FROM docs WHERE doc_id = blocks.doc_id) FROM blocks WHERE block_id = ?1",
    )?;
    let mut hits = Vec::new();
    for c in fuse(&fts_ids, vector_hits) {
        let m: Option<(String, Option<String>)> = meta
            .query_row(params![c.block_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((doc_id, path)) = m else {
            continue;
        };
        let path = path.unwrap_or_default();
        let boosts = compute_boosts(&boost_facts(conn, &doc_id, &c.block_id, &path)?, &terms);
        let evidence = Evidence {
            fts_rank: c.fts_rank,
            vector_rank: c.vector_rank,
            cosine: c.cosine,
            rrf: c.rrf,
            boosts,
        };
        hits.push(HybridHit {
            block_id: c.block_id,
            doc_id,
            path,
            score: apply_boosts(c.rrf, &boosts),
            evidence,
        });
    }
    omgbase_search::sort_by_score(&mut hits, |h| h.score, |h| &h.block_id);
    hits.truncate(limit);
    Ok(hits)
}

/// §4 `resolve`: [`fuse_and_boost`] over `query` and the vector ranking
/// handed in (empty for the FTS-only form), limit default 10, reshaped to
/// `{ _id, locator, preview, evidence }` (`id` is the block's `_id` on the
/// wire — `spec/surface` §1.2, 5.0; the role keys stay bare).
pub fn resolve(
    conn: &Connection,
    repo_id: &str,
    query: &str,
    vector_hits: &[(String, f64)],
    limit: Option<usize>,
) -> Result<Vec<ResolveHit>> {
    let hits = fuse_and_boost(
        conn,
        repo_id,
        Some(query),
        vector_hits,
        None,
        limit.unwrap_or(RESOLVE_DEFAULT_LIMIT),
    )?;
    let mut row = conn.prepare_cached(
        "SELECT d.path, b.ordinal, b.type, b.text FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
         WHERE b.block_id = ?1",
    )?;
    let mut out = Vec::with_capacity(hits.len());
    for h in hits {
        let r: Option<(String, i64, String, String)> = row
            .query_row(params![h.block_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        let (loc, prev) = match r {
            Some((path, ordinal, ty, text)) => (
                locator(&path, &ty, ordinal),
                preview(&text, omgbase_search::PREVIEW_WORDS),
            ),
            None => (h.block_id.clone(), String::new()),
        };
        out.push(ResolveHit {
            id: h.block_id,
            locator: loc,
            preview: prev,
            evidence: h.evidence,
        });
    }
    Ok(out)
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

    /// `spec/search` §4 `resolve`, the FTS-only form (`blocks_resolve` with
    /// no provider; `find --no-semantic`). The form with a query vector is
    /// the semantic capability's
    /// ([`SemanticProvider::resolve`](crate::core::capabilities::SemanticProvider::resolve)).
    pub fn resolve(
        &self,
        repo_id: &str,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<ResolveHit>> {
        resolve(&self.conn, repo_id, query, &[], limit)
    }
}
