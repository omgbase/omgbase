//! Search over the store (`spec/search`, store 13.3): `text_search` (§1.3),
//! the embedding tasks and the drain over the `embeddings`/`doc_embeddings`
//! caches (§2), `vector_search`/`doc_vector_search` (§3), `hybrid_search` and
//! `resolve` (§4). The pure pieces — sanitizer, inputs, pooling, cosine,
//! fusion — are `omgbase-search`; this module runs the SQL around them.

use std::collections::HashMap;

use omgbase_search::{
    BoostFacts, DocEmbedBlockRef, DocEmbedMethod, DocEmbedTask, EMBED_BATCH, EmbedTask,
    EmbeddingProvider, Evidence, HYBRID_PASS_LIMIT, RESOLVE_DEFAULT_LIMIT, apply_boosts,
    blob_to_f32, compute_boosts, context_prefix, cosine_f32, ctx_hash, default_terms, doc_header,
    doc_input, estimate_tokens, f32_to_blob, fuse, hex, locator, lower_terms, preview,
    property_to_string, sanitize_fts_query, should_embed, sort_by_score, token_budget,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;

use crate::error::Result;
use crate::read::reconstruct;
use crate::tree::from_hex;
use crate::{Store, properties};

/// §1.3 / §4: the default `limit`.
pub const DEFAULT_LIMIT: usize = 50;

// ---- text search (§1.3) --------------------------------------------------------------

/// One `text_search` hit; `score = −bm25` (higher is better).
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

// ---- embed tasks (§2.2, §2.4) ----------------------------------------------------------

struct SectionRow {
    heading_text: String,
    level: i64,
    first_ordinal: i64,
    last_ordinal: i64,
}

/// §2.2: an [`EmbedTask`] for every embeddable live block of the repo, in
/// `(path, ordinal, block_id)` order.
pub fn build_embed_tasks(conn: &Connection, repo_id: &str) -> Result<Vec<EmbedTask>> {
    struct BlockRow {
        block_id: String,
        doc_id: String,
        path: String,
        ordinal: i64,
        block_type: String,
        text: String,
        raw_hash: Vec<u8>,
    }
    let blocks: Vec<BlockRow> = {
        let mut stmt = conn.prepare_cached(
            "SELECT b.block_id, b.doc_id, d.path, b.ordinal, b.type, b.text, b.raw_hash
             FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
             WHERE b.repo_id = ?1 AND b.deleted_commit IS NULL
             ORDER BY d.path, b.ordinal, b.block_id",
        )?;
        let it = stmt.query_map(params![repo_id], |r| {
            Ok(BlockRow {
                block_id: r.get(0)?,
                doc_id: r.get(1)?,
                path: r.get(2)?,
                ordinal: r.get(3)?,
                block_type: r.get(4)?,
                text: r.get(5)?,
                raw_hash: r.get(6)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };

    // The frontmatter `title` per doc: source frontmatter, card scalar, type
    // string, non-empty.
    let mut title_by_doc: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT p.doc_id, p.val_text FROM properties p
             WHERE p.repo_id = ?1 AND p.source = 'frontmatter' AND p.key = 'title'
               AND p.card = 'scalar' AND p.type = 'string' AND p.deleted_commit IS NULL
             ORDER BY p.rowid",
        )?;
        let it = stmt.query_map(params![repo_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        for row in it {
            let (doc_id, title) = row?;
            if let Some(t) = title.filter(|t| !t.is_empty()) {
                title_by_doc.insert(doc_id, t);
            }
        }
    }

    // Every section of the repo with its heading text, in first_ordinal order
    // per doc (the first is the title fallback).
    let mut sections_by_doc: HashMap<String, Vec<SectionRow>> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT s.doc_id, hb.text, s.level, s.first_ordinal, s.last_ordinal
             FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
             WHERE hb.repo_id = ?1
             ORDER BY s.doc_id, s.first_ordinal, s.rowid",
        )?;
        let it = stmt.query_map(params![repo_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                SectionRow {
                    heading_text: r.get(1)?,
                    level: r.get(2)?,
                    first_ordinal: r.get(3)?,
                    last_ordinal: r.get(4)?,
                },
            ))
        })?;
        for row in it {
            let (doc_id, s) = row?;
            sections_by_doc.entry(doc_id).or_default().push(s);
        }
    }

    let mut tasks = Vec::new();
    for b in &blocks {
        if !should_embed(&b.text) {
            continue;
        }
        let sections = sections_by_doc
            .get(&b.doc_id)
            .map_or(&[][..], Vec::as_slice);
        let doc_title = match title_by_doc.get(&b.doc_id) {
            Some(t) if !t.trim_matches(omgbase_search::is_js_whitespace).is_empty() => t.clone(),
            _ => sections
                .first()
                .map_or_else(|| b.path.clone(), |s| s.heading_text.clone()),
        };
        let mut containing: Vec<&SectionRow> = sections
            .iter()
            .filter(|s| b.ordinal >= s.first_ordinal && b.ordinal <= s.last_ordinal)
            .collect();
        containing.sort_by_key(|s| s.level);
        let chain: Vec<String> = containing.iter().map(|s| s.heading_text.clone()).collect();
        tasks.push(EmbedTask {
            block_id: b.block_id.clone(),
            content_hash: hex(&b.raw_hash),
            ctx: context_prefix(&doc_title, &b.path, &chain, &b.block_type),
            text: b.text.clone(),
        });
    }
    Ok(tasks)
}

/// A merged property when it is a non-blank string.
fn nonblank_string(props: &Json, key: &str) -> Option<String> {
    props
        .get(key)
        .and_then(Json::as_str)
        .filter(|s| !s.trim_matches(omgbase_search::is_js_whitespace).is_empty())
        .map(str::to_owned)
}

/// §2.4: a [`DocEmbedTask`] for every live document with reconstructable
/// content, in `path` order; each carries its embeddable blocks' cache keys
/// and weights for pooling.
pub fn build_doc_embed_tasks(conn: &Connection, repo_id: &str) -> Result<Vec<DocEmbedTask>> {
    let block_tasks = build_embed_tasks(conn, repo_id)?;
    let doc_of_block: HashMap<String, String> = {
        let mut stmt = conn.prepare_cached(
            "SELECT block_id, doc_id FROM blocks WHERE repo_id = ?1 AND deleted_commit IS NULL",
        )?;
        let it = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<HashMap<_, _>, _>>()?
    };
    let mut blocks_by_doc: HashMap<String, Vec<DocEmbedBlockRef>> = HashMap::new();
    for t in &block_tasks {
        let Some(doc_id) = doc_of_block.get(&t.block_id) else {
            continue;
        };
        blocks_by_doc
            .entry(doc_id.clone())
            .or_default()
            .push(DocEmbedBlockRef {
                content_hash: t.content_hash.clone(),
                ctx: t.ctx.clone(),
                tokens: estimate_tokens(&t.text),
            });
    }
    let docs: Vec<(String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT doc_id, path FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL ORDER BY path",
        )?;
        let it = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut tasks = Vec::new();
    for (doc_id, path) in docs {
        let Some(body) = reconstruct(conn, &doc_id)? else {
            continue;
        };
        let props = omgbase_properties::merged(&properties::read_doc_properties(conn, &doc_id)?);
        let title = nonblank_string(&props, "$title")
            .or_else(|| nonblank_string(&props, "title"))
            .unwrap_or_else(|| path.clone());
        let header = doc_header(
            &title,
            &path,
            nonblank_string(&props, "type").as_deref(),
            nonblank_string(&props, "layer").as_deref(),
        );
        let input = doc_input(&header, &body);
        if input
            .trim_matches(omgbase_search::is_js_whitespace)
            .is_empty()
        {
            continue;
        }
        tasks.push(DocEmbedTask {
            doc_id: doc_id.clone(),
            header,
            input,
            blocks: blocks_by_doc.remove(&doc_id).unwrap_or_default(),
        });
    }
    Ok(tasks)
}

// ---- the caches and the drain (§2.3–§2.6) ---------------------------------------------

/// The cached vector for a block cache key under `model`, if any.
pub fn get_cached(
    conn: &Connection,
    content_hash_hex: &str,
    ctx: &str,
    model: &str,
) -> Result<Option<Vec<f32>>> {
    let blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT vec FROM embeddings WHERE content_hash = ?1 AND ctx_hash = ?2 AND model = ?3",
            params![from_hex(content_hash_hex)?, &ctx_hash(ctx)[..], model],
            |r| r.get(0),
        )
        .optional()?;
    Ok(blob.map(|b| blob_to_f32(&b)))
}

/// A cached document vector and how it was computed.
#[derive(Clone, Debug, PartialEq)]
pub struct DocVectorRow {
    pub vec: Vec<f32>,
    pub method: DocEmbedMethod,
}

/// The fresh cached vector for a document task under `model`: `None` when
/// absent or stale (`input_hash` differs from `sha256(task.input)`).
pub fn get_cached_doc(
    conn: &Connection,
    task: &DocEmbedTask,
    model: &str,
) -> Result<Option<DocVectorRow>> {
    let row: Option<(Vec<u8>, String, Vec<u8>)> = conn
        .query_row(
            "SELECT input_hash, method, vec FROM doc_embeddings WHERE doc_id = ?1 AND model = ?2",
            params![task.doc_id, model],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row.and_then(|(input_hash, method, vec)| {
        if input_hash[..] != task.input_hash()[..] {
            return None;
        }
        Some(DocVectorRow {
            vec: blob_to_f32(&vec),
            method: DocEmbedMethod::parse(&method)?,
        })
    }))
}

/// What a block pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EmbedStats {
    /// Cache misses embedded and written.
    pub embedded: usize,
    /// Tasks whose vector was already cached.
    pub cached: usize,
}

/// What a document pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocEmbedStats {
    /// Whole-document inputs embedded and written.
    pub embedded: usize,
    /// Tasks whose fresh vector was already cached.
    pub cached: usize,
    /// Over-budget documents pooled from cached block vectors.
    pub pooled: usize,
}

/// One drain: the block pass, then the document pass (§2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainStats {
    pub blocks: EmbedStats,
    pub docs: DocEmbedStats,
}

/// §2.3 `process`: partition into cached and misses; embed the misses'
/// inputs in batches of 32; `INSERT OR REPLACE` each vector under the
/// provider's `model` and `dim`.
pub fn embed_process(
    conn: &Connection,
    tasks: &[EmbedTask],
    provider: &dyn EmbeddingProvider,
) -> Result<EmbedStats> {
    let model = provider.model();
    let mut misses: Vec<&EmbedTask> = Vec::new();
    let mut cached = 0;
    for t in tasks {
        if get_cached(conn, &t.content_hash, &t.ctx, model)?.is_some() {
            cached += 1;
        } else {
            misses.push(t);
        }
    }
    let mut embedded = 0;
    for chunk in misses.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|t| t.input()).collect();
        let vectors = provider.embed(&inputs)?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO embeddings (content_hash, ctx_hash, model, dim, vec)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (t, v) in chunk.iter().zip(&vectors) {
                insert.execute(params![
                    from_hex(&t.content_hash)?,
                    &ctx_hash(&t.ctx)[..],
                    model,
                    provider.dim() as i64,
                    f32_to_blob(v),
                ])?;
            }
        }
        tx.commit()?;
        embedded += chunk.len();
    }
    Ok(EmbedStats { embedded, cached })
}

/// §2.4–§2.5 `process_docs`: skip fresh cached vectors; within budget →
/// embed the input whole (batches of 32); over budget → pool the cached block
/// vectors with no provider call (a document with nothing cached stays queued).
pub fn embed_process_docs(
    conn: &Connection,
    tasks: &[DocEmbedTask],
    provider: &dyn EmbeddingProvider,
) -> Result<DocEmbedStats> {
    let model = provider.model();
    let budget = token_budget(provider.max_input_tokens());
    let mut misses: Vec<&DocEmbedTask> = Vec::new();
    let mut cached = 0;
    for t in tasks {
        if get_cached_doc(conn, t, model)?.is_some() {
            cached += 1;
        } else {
            misses.push(t);
        }
    }
    let (whole, pooled_tasks): (Vec<&DocEmbedTask>, Vec<&DocEmbedTask>) = misses
        .into_iter()
        .partition(|t| DocEmbedMethod::for_input(&t.input, budget) == DocEmbedMethod::Whole);

    const INSERT: &str =
        "INSERT OR REPLACE INTO doc_embeddings (doc_id, model, input_hash, method, dim, vec)
                          VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
    let mut embedded = 0;
    for chunk in whole.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|t| t.input.clone()).collect();
        let vectors = provider.embed(&inputs)?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut insert = tx.prepare_cached(INSERT)?;
            for (t, v) in chunk.iter().zip(&vectors) {
                insert.execute(params![
                    t.doc_id,
                    model,
                    &t.input_hash()[..],
                    DocEmbedMethod::Whole.as_str(),
                    provider.dim() as i64,
                    f32_to_blob(v),
                ])?;
            }
        }
        tx.commit()?;
        embedded += chunk.len();
    }

    let mut pooled = 0;
    if !pooled_tasks.is_empty() {
        let tx = conn.unchecked_transaction()?;
        {
            let mut insert = tx.prepare_cached(INSERT)?;
            for t in &pooled_tasks {
                let mut lookup_err: Option<crate::Error> = None;
                let v = omgbase_search::pool_block_vectors(provider.dim(), &t.blocks, |r| {
                    match get_cached(&tx, &r.content_hash, &r.ctx, model) {
                        Ok(v) => v,
                        Err(e) => {
                            lookup_err = Some(e);
                            None
                        }
                    }
                });
                if let Some(e) = lookup_err {
                    return Err(e);
                }
                let Some(v) = v else {
                    continue; // nothing cached yet — stays queued
                };
                insert.execute(params![
                    t.doc_id,
                    model,
                    &t.input_hash()[..],
                    DocEmbedMethod::Pooled.as_str(),
                    provider.dim() as i64,
                    f32_to_blob(&v),
                ])?;
                pooled += 1;
            }
        }
        tx.commit()?;
    }
    Ok(DocEmbedStats {
        embedded,
        cached,
        pooled,
    })
}

/// The block ids among `tasks` whose current key has no cached vector under
/// `model` (the worker queue).
pub fn stale_blocks(conn: &Connection, tasks: &[EmbedTask], model: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for t in tasks {
        if should_embed(&t.text) && get_cached(conn, &t.content_hash, &t.ctx, model)?.is_none() {
            out.push(t.block_id.clone());
        }
    }
    Ok(out)
}

/// The doc ids among `tasks` with no fresh cached vector under `model`.
pub fn stale_docs(conn: &Connection, tasks: &[DocEmbedTask], model: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for t in tasks {
        if get_cached_doc(conn, t, model)?.is_none() {
            out.push(t.doc_id.clone());
        }
    }
    Ok(out)
}

/// Counts of `(block, doc)` vectors under a model other than `model`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ForeignVectors {
    pub blocks: usize,
    pub docs: usize,
}

/// §2.6: how many cached vectors belong to another model.
pub fn foreign_vector_count(conn: &Connection, model: &str) -> Result<ForeignVectors> {
    let blocks: i64 = conn.query_row(
        "SELECT count(*) FROM embeddings WHERE model != ?1",
        params![model],
        |r| r.get(0),
    )?;
    let docs: i64 = conn.query_row(
        "SELECT count(*) FROM doc_embeddings WHERE model != ?1",
        params![model],
        |r| r.get(0),
    )?;
    Ok(ForeignVectors {
        blocks: blocks as usize,
        docs: docs as usize,
    })
}

/// §2.6: delete every cached vector not produced by `model`.
pub fn prune_foreign_vectors(conn: &Connection, model: &str) -> Result<ForeignVectors> {
    let tx = conn.unchecked_transaction()?;
    let blocks = tx.execute("DELETE FROM embeddings WHERE model != ?1", params![model])?;
    let docs = tx.execute(
        "DELETE FROM doc_embeddings WHERE model != ?1",
        params![model],
    )?;
    tx.commit()?;
    Ok(ForeignVectors { blocks, docs })
}

// ---- vector search (§3) ---------------------------------------------------------------

/// One `vector_search` hit.
#[derive(Clone, Debug, PartialEq)]
pub struct VectorHit {
    pub block_id: String,
    pub doc_id: String,
    pub path: String,
    pub cosine: f64,
}

/// One `doc_vector_search` hit.
#[derive(Clone, Debug, PartialEq)]
pub struct DocVectorHit {
    pub doc_id: String,
    pub path: String,
    pub cosine: f64,
}

/// One hit per key, keeping the highest cosine among the rows that joined to
/// it (§3: a stale context row beside the current one); first-seen order.
fn best_per_key<T>(rows: Vec<T>, key: impl Fn(&T) -> &str, cosine: impl Fn(&T) -> f64) -> Vec<T> {
    let mut out: Vec<T> = Vec::with_capacity(rows.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in rows {
        match index.get(key(&row)) {
            Some(&i) => {
                if cosine(&row) > cosine(&out[i]) {
                    out[i] = row;
                }
            }
            None => {
                index.insert(key(&row).to_owned(), out.len());
                out.push(row);
            }
        }
    }
    out
}

/// §3: every `embeddings` row of `model` joined to a live block of the repo
/// with `raw_hash = content_hash`, scored by cosine; one hit per block (the
/// highest cosine when several rows join to it), by score descending then
/// `block_id` bytewise, limited.
pub fn vector_search(
    conn: &Connection,
    repo_id: &str,
    model: &str,
    query: &[f32],
    limit: usize,
) -> Result<Vec<VectorHit>> {
    let mut stmt = conn.prepare_cached(
        "SELECT b.block_id, b.doc_id, d.path, e.vec
         FROM embeddings e
         JOIN blocks b ON b.raw_hash = e.content_hash AND b.deleted_commit IS NULL
         JOIN docs d ON d.doc_id = b.doc_id
         WHERE b.repo_id = ?1 AND e.model = ?2",
    )?;
    let rows = stmt.query_map(params![repo_id, model], |r| {
        Ok(VectorHit {
            block_id: r.get(0)?,
            doc_id: r.get(1)?,
            path: r.get(2)?,
            cosine: cosine_f32(query, &blob_to_f32(&r.get::<_, Vec<u8>>(3)?)),
        })
    })?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut hits = best_per_key(rows, |h| &h.block_id, |h| h.cosine);
    sort_by_score(&mut hits, |h| h.cosine, |h| &h.block_id);
    hits.truncate(limit);
    Ok(hits)
}

/// §3: the same over `doc_embeddings` joined to live docs (one hit per doc),
/// ties by `doc_id`.
pub fn doc_vector_search(
    conn: &Connection,
    repo_id: &str,
    model: &str,
    query: &[f32],
    limit: usize,
) -> Result<Vec<DocVectorHit>> {
    let mut stmt = conn.prepare_cached(
        "SELECT d.doc_id, d.path, e.vec
         FROM doc_embeddings e
         JOIN docs d ON d.doc_id = e.doc_id AND d.deleted_commit IS NULL
         WHERE d.repo_id = ?1 AND e.model = ?2",
    )?;
    let rows = stmt.query_map(params![repo_id, model], |r| {
        Ok(DocVectorHit {
            doc_id: r.get(0)?,
            path: r.get(1)?,
            cosine: cosine_f32(query, &blob_to_f32(&r.get::<_, Vec<u8>>(2)?)),
        })
    })?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut hits = best_per_key(rows, |h| &h.doc_id, |h| h.cosine);
    sort_by_score(&mut hits, |h| h.cosine, |h| &h.doc_id);
    hits.truncate(limit);
    Ok(hits)
}

// ---- hybrid and resolve (§4) ------------------------------------------------------------

/// The vector side of a hybrid query: the model whose cache to read and the
/// query vector.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryVector {
    pub model: String,
    pub vec: Vec<f32>,
}

/// The inputs of [`hybrid_search`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HybridQuery {
    /// The FTS query.
    pub text: Option<String>,
    pub vector: Option<QueryVector>,
    /// Boost terms; default: `text` split on whitespace.
    pub terms: Option<Vec<String>>,
    pub limit: Option<usize>,
}

/// One `hybrid_search` hit.
#[derive(Clone, Debug, PartialEq)]
pub struct HybridHit {
    pub block_id: String,
    pub doc_id: String,
    pub path: String,
    pub score: f64,
    pub evidence: Evidence,
}

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

/// §4: RRF-fuse the FTS and vector rankings (each capped at 200), drop
/// candidates whose block no longer exists, apply the boosts, sort by score
/// then `block_id`, limit.
pub fn hybrid_search(conn: &Connection, repo_id: &str, q: &HybridQuery) -> Result<Vec<HybridHit>> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT);
    let terms = lower_terms(
        &q.terms
            .clone()
            .unwrap_or_else(|| default_terms(q.text.as_deref())),
    );
    let fts_ids: Vec<String> = match q.text.as_deref().filter(|t| !t.is_empty()) {
        Some(text) => text_search(conn, repo_id, text, HYBRID_PASS_LIMIT)?
            .hits
            .into_iter()
            .map(|h| h.block_id)
            .collect(),
        None => Vec::new(),
    };
    let vec_hits: Vec<(String, f64)> = match &q.vector {
        Some(v) => vector_search(conn, repo_id, &v.model, &v.vec, HYBRID_PASS_LIMIT)?
            .into_iter()
            .map(|h| (h.block_id, h.cosine))
            .collect(),
        None => Vec::new(),
    };
    let mut meta = conn.prepare_cached(
        "SELECT doc_id, (SELECT path FROM docs WHERE doc_id = blocks.doc_id) FROM blocks WHERE block_id = ?1",
    )?;
    let mut hits = Vec::new();
    for c in fuse(&fts_ids, &vec_hits) {
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
    sort_by_score(&mut hits, |h| h.score, |h| &h.block_id);
    hits.truncate(limit);
    Ok(hits)
}

/// One `resolve` candidate.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolveHit {
    pub id: String,
    /// `path#type[ordinal]`.
    pub locator: String,
    /// The first 12 words of the text (`…` when cut).
    pub preview: String,
    pub evidence: Evidence,
}

/// §4 `resolve`: [`hybrid_search`] over `query` (+ an optional vector),
/// limit default 10, reshaped to `{ id, locator, preview, evidence }`.
pub fn resolve(
    conn: &Connection,
    repo_id: &str,
    query: &str,
    vector: Option<QueryVector>,
    limit: Option<usize>,
) -> Result<Vec<ResolveHit>> {
    let hits = hybrid_search(
        conn,
        repo_id,
        &HybridQuery {
            text: Some(query.to_owned()),
            vector,
            terms: None,
            limit: Some(limit.unwrap_or(RESOLVE_DEFAULT_LIMIT)),
        },
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

// ---- Store surface -------------------------------------------------------------------------

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

    /// `spec/search` §2.2: the embeddable blocks' tasks, `(path, ordinal)` order.
    pub fn build_embed_tasks(&self, repo_id: &str) -> Result<Vec<EmbedTask>> {
        build_embed_tasks(&self.conn, repo_id)
    }

    /// `spec/search` §2.4: the live documents' tasks, `path` order.
    pub fn build_doc_embed_tasks(&self, repo_id: &str) -> Result<Vec<DocEmbedTask>> {
        build_doc_embed_tasks(&self.conn, repo_id)
    }

    /// `spec/search` §2.3: embed the cache misses among `tasks`.
    pub fn embed_process(
        &self,
        tasks: &[EmbedTask],
        provider: &dyn EmbeddingProvider,
    ) -> Result<EmbedStats> {
        embed_process(&self.conn, tasks, provider)
    }

    /// `spec/search` §2.4–§2.5: one vector per document, whole or pooled.
    pub fn embed_process_docs(
        &self,
        tasks: &[DocEmbedTask],
        provider: &dyn EmbeddingProvider,
    ) -> Result<DocEmbedStats> {
        embed_process_docs(&self.conn, tasks, provider)
    }

    /// `spec/search` §2.6: one drain — the block pass, then the document pass.
    pub fn drain(&self, repo_id: &str, provider: &dyn EmbeddingProvider) -> Result<DrainStats> {
        let blocks = self.embed_process(&self.build_embed_tasks(repo_id)?, provider)?;
        let docs = self.embed_process_docs(&self.build_doc_embed_tasks(repo_id)?, provider)?;
        Ok(DrainStats { blocks, docs })
    }

    /// The cached vector for a block cache key under `model`.
    pub fn cached_vector(
        &self,
        content_hash_hex: &str,
        ctx: &str,
        model: &str,
    ) -> Result<Option<Vec<f32>>> {
        get_cached(&self.conn, content_hash_hex, ctx, model)
    }

    /// The fresh cached document vector for a task under `model`.
    pub fn cached_doc_vector(
        &self,
        task: &DocEmbedTask,
        model: &str,
    ) -> Result<Option<DocVectorRow>> {
        get_cached_doc(&self.conn, task, model)
    }

    /// Block ids among `tasks` with no cached vector under `model`.
    pub fn stale_blocks(&self, tasks: &[EmbedTask], model: &str) -> Result<Vec<String>> {
        stale_blocks(&self.conn, tasks, model)
    }

    /// Doc ids among `tasks` with no fresh cached vector under `model`.
    pub fn stale_docs(&self, tasks: &[DocEmbedTask], model: &str) -> Result<Vec<String>> {
        stale_docs(&self.conn, tasks, model)
    }

    /// `spec/search` §2.6: vectors under another model.
    pub fn foreign_vector_count(&self, model: &str) -> Result<ForeignVectors> {
        foreign_vector_count(&self.conn, model)
    }

    /// `spec/search` §2.6: delete vectors under another model.
    pub fn prune_foreign_vectors(&self, model: &str) -> Result<ForeignVectors> {
        prune_foreign_vectors(&self.conn, model)
    }

    /// `spec/search` §3 over blocks.
    pub fn vector_search(
        &self,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<VectorHit>> {
        vector_search(&self.conn, repo_id, model, query, limit)
    }

    /// `spec/search` §3 over documents.
    pub fn doc_vector_search(
        &self,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<DocVectorHit>> {
        doc_vector_search(&self.conn, repo_id, model, query, limit)
    }

    /// `spec/search` §4.
    pub fn hybrid_search(&self, repo_id: &str, q: &HybridQuery) -> Result<Vec<HybridHit>> {
        hybrid_search(&self.conn, repo_id, q)
    }

    /// `spec/search` §4 `resolve`.
    pub fn resolve(
        &self,
        repo_id: &str,
        query: &str,
        vector: Option<QueryVector>,
        limit: Option<usize>,
    ) -> Result<Vec<ResolveHit>> {
        resolve(&self.conn, repo_id, query, vector, limit)
    }
}
