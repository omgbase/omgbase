//! The semantic half of search over the store (`spec/search`, store 13.3):
//! the embedding tasks and the drain over the `embeddings`/`doc_embeddings`
//! caches (§2), `vector_search`/`doc_vector_search` (§3), and the vector
//! side of `hybrid_search` and `resolve` (§4) — the fusion itself is the
//! core's (`core::text_search::fuse_and_boost`), handed the vector ranking
//! computed here. The pure pieces — sanitizer, inputs, pooling, cosine,
//! fusion — are `omgbase-search`; this module runs the SQL around them. The
//! only way in from outside `semantic/` is the
//! [`SemanticProvider`](crate::core::capabilities::SemanticProvider) trait
//! ([`super::Provider`]); `text_search` is the core's and re-exported here
//! under its old path.

use std::collections::{HashMap, HashSet};

use omgbase_search::{
    DocEmbedBlockRef, DocEmbedMethod, DocEmbedTask, EMBED_BATCH, EmbedTask, EmbeddingProvider,
    HYBRID_PASS_LIMIT, blob_to_f32, context_prefix, cosine_f32, ctx_hash, doc_header, doc_input,
    estimate_tokens, f32_to_blob, hex, should_embed, sort_by_score, token_budget,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;

use crate::core::codec::from_hex;
use crate::core::text_search::{fuse_and_boost, resolve as core_resolve};
use crate::derived::LIVE_LEAF_SQL;
use crate::error::Result;
use crate::properties;
use crate::read::reconstruct;

pub use crate::core::capabilities::{DocEmbedStats, EmbedStats, ForeignVectors};
pub use crate::core::semantic_shapes::{
    DocVectorHit, DrainStats, HybridHit, HybridQuery, QueryVector, ResolveHit, VectorHit,
};
pub use crate::core::text_search::{DEFAULT_LIMIT, TextHit, TextSearchResult, text_search};

// ---- embed tasks (§2.2, §2.4) ----------------------------------------------------------

struct SectionRow {
    heading_text: String,
    level: i64,
    first_ordinal: i64,
    last_ordinal: i64,
}

/// The scope of a [`BlockContexts`] load: every doc of a repo, or one doc.
#[derive(Clone, Copy, Debug)]
pub enum ContextScope<'a> {
    Repo(&'a str),
    Doc(&'a str),
}

/// A block's *current* embedding context (§2.2) — the one rule every reader of
/// the `embeddings` cache keys with: the drain (tasks), the pooled document
/// vector, `vector_search` (§3) and `semantic()` (`spec/surface` §1.3). Loaded
/// once per scope (one scan of the frontmatter titles and one of the
/// sections), then a per-block walk of the doc's sections for the chain.
pub struct BlockContexts {
    title_by_doc: HashMap<String, String>,
    sections_by_doc: HashMap<String, Vec<SectionRow>>,
}

impl BlockContexts {
    /// Load the title and section facts of `scope`.
    pub fn load(conn: &Connection, scope: ContextScope<'_>) -> Result<Self> {
        let (by_repo, key) = match scope {
            ContextScope::Repo(r) => (true, r),
            ContextScope::Doc(d) => (false, d),
        };
        // The frontmatter `title` per doc: source frontmatter, card scalar, type
        // string, non-empty.
        let mut title_by_doc: HashMap<String, String> = HashMap::new();
        {
            let sql = format!(
                "SELECT p.doc_id, p.val_text FROM properties p
                 WHERE {} AND p.source = 'frontmatter' AND p.key = 'title'
                   AND p.card = 'scalar' AND p.type = 'string'
                 ORDER BY p.rowid",
                if by_repo {
                    "p.repo_id = ?1"
                } else {
                    "p.doc_id = ?1"
                }
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let it = stmt.query_map(params![key], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?;
            for row in it {
                let (doc_id, title) = row?;
                if let Some(t) = title.filter(|t| !t.is_empty()) {
                    title_by_doc.insert(doc_id, t);
                }
            }
        }

        // Every section in scope with its heading text, in first_ordinal order
        // per doc (the first is the title fallback).
        let mut sections_by_doc: HashMap<String, Vec<SectionRow>> = HashMap::new();
        {
            let sql = format!(
                "SELECT s.doc_id, hb.text, s.level, s.first_ordinal, s.last_ordinal
                 FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
                 WHERE {}
                 ORDER BY s.doc_id, s.first_ordinal, s.rowid",
                if by_repo {
                    "hb.repo_id = ?1"
                } else {
                    "s.doc_id = ?1"
                }
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let it = stmt.query_map(params![key], |r| {
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
        Ok(Self {
            title_by_doc,
            sections_by_doc,
        })
    }

    /// §2.2: the context prefix of a block of `doc_id` at `ordinal`.
    pub fn ctx(&self, doc_id: &str, path: &str, ordinal: i64, block_type: &str) -> String {
        let sections = self
            .sections_by_doc
            .get(doc_id)
            .map_or(&[][..], Vec::as_slice);
        let doc_title = match self.title_by_doc.get(doc_id) {
            Some(t) if !t.trim_matches(omgbase_search::is_js_whitespace).is_empty() => t.clone(),
            _ => sections
                .first()
                .map_or_else(|| path.to_owned(), |s| s.heading_text.clone()),
        };
        let mut containing: Vec<&SectionRow> = sections
            .iter()
            .filter(|s| ordinal >= s.first_ordinal && ordinal <= s.last_ordinal)
            .collect();
        containing.sort_by_key(|s| s.level);
        let chain: Vec<String> = containing.iter().map(|s| s.heading_text.clone()).collect();
        context_prefix(&doc_title, path, &chain, block_type)
    }
}

/// §2.1–§2.2: an [`EmbedTask`] for every embeddable live block of the repo —
/// the live **leaves** (1.2: a container's text is its children's text, so
/// embedding it would pool the same words twice) that clear `should_embed` —
/// in `(path, ordinal, block_id)` order.
pub fn build_embed_tasks(conn: &Connection, repo_id: &str) -> Result<Vec<EmbedTask>> {
    embed_tasks(conn, ContextScope::Repo(repo_id))
}

/// [`build_embed_tasks`] over one live document (the catch-up's unit, Phase
/// 2): a block's task depends on its document alone — the path, the title,
/// the heading chain — so a document is re-scanned by itself.
pub fn build_embed_tasks_for_doc(conn: &Connection, doc_id: &str) -> Result<Vec<EmbedTask>> {
    embed_tasks(conn, ContextScope::Doc(doc_id))
}

fn embed_tasks(conn: &Connection, scope: ContextScope<'_>) -> Result<Vec<EmbedTask>> {
    struct BlockRow {
        block_id: String,
        doc_id: String,
        path: String,
        ordinal: i64,
        block_type: String,
        text: String,
        raw_hash: Vec<u8>,
    }
    let (by_repo, key) = match scope {
        ContextScope::Repo(r) => (true, r),
        ContextScope::Doc(d) => (false, d),
    };
    let blocks: Vec<BlockRow> = {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT b.block_id, b.doc_id, d.path, b.ordinal, b.type, b.text, b.raw_hash
             FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
             WHERE {} AND {LIVE_LEAF_SQL}
             ORDER BY d.path, b.ordinal, b.block_id",
            if by_repo {
                "b.repo_id = ?1"
            } else {
                "b.doc_id = ?1 AND d.deleted_at IS NULL"
            }
        ))?;
        let it = stmt.query_map(params![key], |r| {
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
    let contexts = BlockContexts::load(conn, scope)?;

    let mut tasks = Vec::new();
    for b in &blocks {
        if !should_embed(&b.text) {
            continue;
        }
        tasks.push(EmbedTask {
            block_id: b.block_id.clone(),
            content_hash: hex(&b.raw_hash),
            ctx: contexts.ctx(&b.doc_id, &b.path, b.ordinal, &b.block_type),
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
    let docs: Vec<(String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT doc_id, path FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL ORDER BY path",
        )?;
        let it = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    doc_embed_tasks(conn, docs, build_embed_tasks(conn, repo_id)?)
}

/// [`build_doc_embed_tasks`] over a set of documents (the catch-up's unit):
/// the live ones among `doc_ids`, in `path` order.
pub fn build_doc_embed_tasks_for_docs(
    conn: &Connection,
    doc_ids: &[String],
) -> Result<Vec<DocEmbedTask>> {
    let mut docs: Vec<(String, String)> = Vec::new();
    let mut block_tasks: Vec<EmbedTask> = Vec::new();
    let mut live =
        conn.prepare_cached("SELECT path FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL")?;
    for id in doc_ids {
        let path: Option<String> = live.query_row(params![id], |r| r.get(0)).optional()?;
        if let Some(path) = path {
            docs.push((id.clone(), path));
            block_tasks.extend(build_embed_tasks_for_doc(conn, id)?);
        }
    }
    docs.sort();
    docs.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    doc_embed_tasks(conn, docs, block_tasks)
}

/// §2.4 over `docs` (live, `(doc_id, path)` in path order) given their
/// blocks' tasks.
fn doc_embed_tasks(
    conn: &Connection,
    docs: Vec<(String, String)>,
    block_tasks: Vec<EmbedTask>,
) -> Result<Vec<DocEmbedTask>> {
    let mut doc_of_block = conn
        .prepare_cached("SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_at IS NULL")?;
    let mut blocks_by_doc: HashMap<String, Vec<DocEmbedBlockRef>> = HashMap::new();
    for t in &block_tasks {
        let doc_id: Option<String> = doc_of_block
            .query_row(params![t.block_id], |r| r.get(0))
            .optional()?;
        let Some(doc_id) = doc_id else {
            continue;
        };
        blocks_by_doc
            .entry(doc_id)
            .or_default()
            .push(DocEmbedBlockRef {
                content_hash: t.content_hash.clone(),
                ctx: t.ctx.clone(),
                tokens: estimate_tokens(&t.text),
            });
    }
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

/// The head token (`docs.head`) of every task's document, read with
/// the tasks (Phase 2's "late result" rule): a document vector is written
/// only while the document's head is still the one its task was built from
/// — a vector embedded from an input the document has since left behind is
/// never published (the next drain re-tasks the document). Block vectors
/// need no such check: their key *is* the content (`spec/search` §2.3).
pub type DocHeads = HashMap<String, Option<String>>;

/// The current heads of `tasks`' documents.
pub fn doc_heads(conn: &Connection, tasks: &[DocEmbedTask]) -> Result<DocHeads> {
    let mut stmt = conn.prepare_cached("SELECT head FROM docs WHERE doc_id = ?1")?;
    let mut out = DocHeads::with_capacity(tasks.len());
    for t in tasks {
        let head: Option<Option<String>> =
            stmt.query_row(params![t.doc_id], |r| r.get(0)).optional()?;
        out.insert(t.doc_id.clone(), head.flatten());
    }
    Ok(out)
}

/// Is the document's head still `expected` (inside the write transaction)?
fn head_unchanged(
    tx: &Connection,
    doc_id: &str,
    expected: Option<&Option<String>>,
) -> Result<bool> {
    let Some(expected) = expected else {
        return Ok(true); // no snapshot taken: the full-pass form, caller's choice
    };
    let now: Option<Option<String>> = tx
        .prepare_cached("SELECT head FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL")?
        .query_row(params![doc_id], |r| r.get(0))
        .optional()?;
    Ok(now.as_ref() == Some(expected))
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
    embed_process_docs_at(conn, tasks, provider, None)
}

/// [`embed_process_docs`] under the late-result rule: with `heads` (the
/// documents' heads when `tasks` were built, [`doc_heads`]) a vector is
/// written only if its document's head is unchanged inside the write
/// transaction; a changed document is counted `skipped` and left to the next
/// drain.
pub fn embed_process_docs_at(
    conn: &Connection,
    tasks: &[DocEmbedTask],
    provider: &dyn EmbeddingProvider,
    heads: Option<&DocHeads>,
) -> Result<DocEmbedStats> {
    let head_of = |doc_id: &str| heads.map(|h| h.get(doc_id).cloned().unwrap_or(None));
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
    let mut skipped = 0;
    for chunk in whole.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|t| t.input.clone()).collect();
        let vectors = provider.embed(&inputs)?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut insert = tx.prepare_cached(INSERT)?;
            for (t, v) in chunk.iter().zip(&vectors) {
                if !head_unchanged(&tx, &t.doc_id, head_of(&t.doc_id).as_ref())? {
                    skipped += 1;
                    continue;
                }
                insert.execute(params![
                    t.doc_id,
                    model,
                    &t.input_hash()[..],
                    DocEmbedMethod::Whole.as_str(),
                    provider.dim() as i64,
                    f32_to_blob(v),
                ])?;
                embedded += 1;
            }
        }
        tx.commit()?;
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
                if !head_unchanged(&tx, &t.doc_id, head_of(&t.doc_id).as_ref())? {
                    skipped += 1;
                    continue;
                }
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
        skipped,
    })
}

/// Is a vector cached for the block key under `model` — or, for `None`,
/// under any model (the queue before a provider is known)?
fn block_cached(
    conn: &Connection,
    content_hash_hex: &str,
    ctx: &str,
    model: Option<&str>,
) -> Result<bool> {
    match model {
        Some(m) => Ok(get_cached(conn, content_hash_hex, ctx, m)?.is_some()),
        None => Ok(conn
            .prepare_cached("SELECT 1 FROM embeddings WHERE content_hash = ?1 AND ctx_hash = ?2")?
            .exists(params![from_hex(content_hash_hex)?, &ctx_hash(ctx)[..]])?),
    }
}

/// Is a fresh document vector cached under `model`, or under any for `None`?
fn doc_cached(conn: &Connection, task: &DocEmbedTask, model: Option<&str>) -> Result<bool> {
    match model {
        Some(m) => Ok(get_cached_doc(conn, task, m)?.is_some()),
        None => Ok(conn
            .prepare_cached("SELECT 1 FROM doc_embeddings WHERE doc_id = ?1 AND input_hash = ?2")?
            .exists(params![task.doc_id, &task.input_hash()[..]])?),
    }
}

/// The block ids among `tasks` whose current key has no cached vector under
/// `model` (the worker queue); `None` — under any model.
pub fn stale_blocks(
    conn: &Connection,
    tasks: &[EmbedTask],
    model: Option<&str>,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for t in tasks {
        if should_embed(&t.text) && !block_cached(conn, &t.content_hash, &t.ctx, model)? {
            out.push(t.block_id.clone());
        }
    }
    Ok(out)
}

/// The doc ids among `tasks` with no fresh cached vector under `model`
/// (`None` — under any model).
pub fn stale_docs(
    conn: &Connection,
    tasks: &[DocEmbedTask],
    model: Option<&str>,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for t in tasks {
        if !doc_cached(conn, t, model)? {
            out.push(t.doc_id.clone());
        }
    }
    Ok(out)
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

/// `spec/store` §8 S1 (Phase 2, the rescan's prune): delete every block
/// vector of `model` whose `content_hash` is no live block's `raw_hash` and
/// every document vector of `model` whose document is not live. Other
/// models' rows are `prune_foreign`'s (§2.6, on request); content-addressed
/// rows a heading rename left behind (same content, another `ctx_hash`)
/// stay — the §2.3 rule — unless their content is gone too.
pub fn prune_gone(
    conn: &Connection,
    model: &str,
) -> Result<crate::core::semantic_shapes::PrunedVectors> {
    let tx = conn.unchecked_transaction()?;
    let docs = prune_gone_docs(&tx, model)?;
    let blocks = tx.execute(
        "DELETE FROM embeddings WHERE model = ?1 AND content_hash NOT IN (SELECT raw_hash FROM blocks WHERE deleted_at IS NULL)",
        params![model],
    )?;
    tx.commit()?;
    Ok(crate::core::semantic_shapes::PrunedVectors { blocks, docs })
}

/// S1's document half alone (cheap — identity-keyed): run after every drain.
pub fn prune_gone_docs(conn: &Connection, model: &str) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM doc_embeddings WHERE model = ?1 AND doc_id NOT IN (SELECT doc_id FROM docs WHERE deleted_at IS NULL)",
        params![model],
    )?)
}

/// The live documents among `doc_ids` (the catch-up tells a changed document
/// from a deleted one by this).
pub fn live_docs(conn: &Connection, doc_ids: &HashSet<String>) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare_cached("SELECT 1 FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL")?;
    let mut out = Vec::new();
    for id in doc_ids {
        if stmt.exists(params![id])? {
            out.push(id.clone());
        }
    }
    out.sort();
    Ok(out)
}

// ---- vector search (§3) ---------------------------------------------------------------

/// §3 (1.1): the block's vector is the `embeddings` row for `model` keyed by
/// its *current* `(content_hash, ctx_hash)`, `None` when it is stale (§2.3) —
/// or not a live block at all.
pub fn block_vector(conn: &Connection, block_id: &str, model: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(String, String, i64, String, Vec<u8>)> = conn
        .prepare_cached(
            "SELECT b.doc_id, d.path, b.ordinal, b.type, b.raw_hash
             FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
             WHERE b.block_id = ?1 AND b.deleted_at IS NULL",
        )?
        .query_row(params![block_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .optional()?;
    let Some((doc_id, path, ordinal, block_type, raw_hash)) = row else {
        return Ok(None);
    };
    let ctx = BlockContexts::load(conn, ContextScope::Doc(&doc_id))?.ctx(
        &doc_id,
        &path,
        ordinal,
        &block_type,
    );
    current_vector(conn, &raw_hash, &ctx, model)
}

/// The cache row for `(content_hash, sha256(ctx), model)`, raw blob.
fn current_vector(
    conn: &Connection,
    content_hash: &[u8],
    ctx: &str,
    model: &str,
) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .prepare_cached(
            "SELECT vec FROM embeddings WHERE content_hash = ?1 AND ctx_hash = ?2 AND model = ?3",
        )?
        .query_row(params![content_hash, &ctx_hash(ctx)[..], model], |r| {
            r.get(0)
        })
        .optional()?)
}

/// §3: over every live embeddable block of the repo, the block's vector is the
/// row for its current `(content_hash, ctx_hash)` under `model` (a block with
/// no such row is stale and not a hit — one candidate per block by
/// construction, 1.1); scored by cosine, by score descending then `block_id`
/// bytewise, limited.
pub fn vector_search(
    conn: &Connection,
    repo_id: &str,
    model: &str,
    query: &[f32],
    limit: usize,
) -> Result<Vec<VectorHit>> {
    // The candidates are exactly the drain's tasks (§2.2): one walk of the
    // repo's blocks and sections per query, then an indexed point lookup per
    // embeddable block.
    let tasks = build_embed_tasks(conn, repo_id)?;
    let mut meta = conn.prepare_cached(
        "SELECT b.doc_id, d.path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1",
    )?;
    let mut hits = Vec::new();
    for t in &tasks {
        let Some(vec) = current_vector(conn, &from_hex(&t.content_hash)?, &t.ctx, model)? else {
            continue;
        };
        let m: Option<(String, String)> = meta
            .query_row(params![t.block_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((doc_id, path)) = m else {
            continue;
        };
        hits.push(VectorHit {
            block_id: t.block_id.clone(),
            doc_id,
            path,
            cosine: cosine_f32(query, &blob_to_f32(&vec)),
        });
    }
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
         JOIN docs d ON d.doc_id = e.doc_id AND d.deleted_at IS NULL
         WHERE d.repo_id = ?1 AND e.model = ?2",
    )?;
    let rows = stmt.query_map(params![repo_id, model], |r| {
        Ok(DocVectorHit {
            doc_id: r.get(0)?,
            path: r.get(1)?,
            cosine: cosine_f32(query, &blob_to_f32(&r.get::<_, Vec<u8>>(2)?)),
        })
    })?;
    // `(doc_id, model)` is the primary key: one row per live doc already.
    let mut hits = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    sort_by_score(&mut hits, |h| h.cosine, |h| &h.doc_id);
    hits.truncate(limit);
    Ok(hits)
}

// ---- hybrid and resolve (§4) — the vector half ---------------------------------------------

/// The vector ranking of a hybrid query (§4 step 2): `vector_search` under
/// the query vector's model, capped at 200, as `(block_id, cosine)`.
fn vector_ranking(
    conn: &Connection,
    repo_id: &str,
    vector: Option<&QueryVector>,
) -> Result<Vec<(String, f64)>> {
    Ok(match vector {
        Some(v) => vector_search(conn, repo_id, &v.model, &v.vec, HYBRID_PASS_LIMIT)?
            .into_iter()
            .map(|h| (h.block_id, h.cosine))
            .collect(),
        None => Vec::new(),
    })
}

/// §4: RRF-fuse the FTS and vector rankings (each capped at 200), drop
/// candidates whose block no longer exists, apply the boosts, sort by score
/// then `block_id`, limit — the vector ranking read here, the fusion the
/// core's ([`fuse_and_boost`]).
pub fn hybrid_search(conn: &Connection, repo_id: &str, q: &HybridQuery) -> Result<Vec<HybridHit>> {
    let vector_hits = vector_ranking(conn, repo_id, q.vector.as_ref())?;
    fuse_and_boost(
        conn,
        repo_id,
        q.text.as_deref(),
        &vector_hits,
        q.terms.as_deref(),
        q.limit.unwrap_or(DEFAULT_LIMIT),
    )
}

/// §4 `resolve` with an optional query vector: the vector ranking read here,
/// the rest the core's ([`core_resolve`]).
pub fn resolve(
    conn: &Connection,
    repo_id: &str,
    query: &str,
    vector: Option<QueryVector>,
    limit: Option<usize>,
) -> Result<Vec<ResolveHit>> {
    let vector_hits = vector_ranking(conn, repo_id, vector.as_ref())?;
    core_resolve(conn, repo_id, query, &vector_hits, limit)
}
