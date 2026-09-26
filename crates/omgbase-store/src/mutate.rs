//! Changesets over the store (`spec/mutate/README.md` §1, §4): loading a
//! document into the working tree, applying the ops in order across the
//! documents they touch, and the commit protocol — file-CAS against the doc
//! store, atomic write, and the `api` ingest with the ops' **known ids**.

use std::collections::{BTreeMap, HashMap, HashSet};

use omgbase_format::hash::sha256;
use omgbase_format::{Block, parse_markdown};
use omgbase_mutate::{
    At, ErrorCode, MutBlock, MutDoc, MutationError, Op, OpResult, Parent, To, UpdateArgs,
    cross_doc_move, op_insert, op_merge, op_move, op_remove, op_split, op_update, render,
    resolve_op,
};
use omgbase_reconcile::{Config, Minter};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::Store;
use crate::doc_store::DocStore;
use crate::error::Result;
use crate::ids::ALPHABET;
use crate::observe::{DispositionRow, IngestPlan};
use crate::read::blob_text;
use crate::writers::{Origin, TreeInputBlock};

/// `^[a-z]+_[alphabet]{1,7}$` with the given prefix: a minted id **or** a
/// fixture-minter id (`d_0`) — the reference's `isValidId` after
/// `spec/mutate` (paths carry an extension, so no path is lost).
#[must_use]
pub fn is_id_ref(s: &str, prefix: &str) -> bool {
    let Some((p, suffix)) = s.split_once('_') else {
        return false;
    };
    p == prefix
        && !p.is_empty()
        && p.bytes().all(|b| b.is_ascii_lowercase())
        && (1..=7).contains(&suffix.len())
        && suffix.bytes().all(|b| ALPHABET.contains(&b))
}

/// A live document's identity (the reference's `DocInfo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocInfo {
    pub doc_id: String,
    pub path: String,
    pub current_rev: Option<String>,
}

/// A live doc by id **or** repo-relative path (`findDocByRef`): a `d_` id is
/// looked up by id only; anything else is a path.
pub fn find_doc_by_ref(conn: &Connection, repo_id: &str, r: &str) -> Result<Option<DocInfo>> {
    let sql = if is_id_ref(r, "d") {
        "SELECT doc_id, path, current_rev FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL"
    } else {
        "SELECT doc_id, path, current_rev FROM docs WHERE path = ?1 AND repo_id = ?2 AND deleted_commit IS NULL"
    };
    Ok(conn
        .query_row(sql, params![r, repo_id], |row| {
            Ok(DocInfo {
                doc_id: row.get(0)?,
                path: row.get(1)?,
                current_rev: row.get(2)?,
            })
        })
        .optional()?)
}

// ---- loading (§1) ---------------------------------------------------------------------

struct BlockRow {
    block_id: String,
    parent_block: Option<String>,
    ordinal: i64,
    kind: String,
    attrs: String,
    raw_hash: Vec<u8>,
    trivia_hash: Option<Vec<u8>>,
}

/// §1: a live document as a working tree — blocks from the live rows
/// (`ORDER BY parent_block, ordinal`; a row whose parent is not loaded is a
/// root), raw/trivia from the blobs, the frontmatter blob + trivia. `None`
/// for an unknown or tombstoned doc.
pub fn load_mut_doc(conn: &Connection, doc_id: &str) -> Result<Option<MutDoc>> {
    type DocRow = (String, String, String, Option<String>, Option<String>);
    let doc: Option<DocRow> = conn
        .query_row(
            "SELECT path, format, leading_trivia, frontmatter_trivia, current_rev FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((path, format, leading_trivia, frontmatter_trivia, current_rev)) = doc else {
        return Ok(None);
    };
    let rows: Vec<BlockRow> = {
        let mut stmt = conn.prepare(
            "SELECT block_id, parent_block, ordinal, type, attrs, raw_hash, trivia_hash
             FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL
             ORDER BY parent_block, ordinal",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(BlockRow {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                ordinal: r.get(2)?,
                kind: r.get(3)?,
                attrs: r.get(4)?,
                raw_hash: r.get(5)?,
                trivia_hash: r.get(6)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let ids: HashSet<&str> = rows.iter().map(|r| r.block_id.as_str()).collect();
    let mut nodes: HashMap<String, MutBlock> = HashMap::with_capacity(rows.len());
    for r in &rows {
        let raw = blob_text(conn, &r.raw_hash)?;
        let trivia = match &r.trivia_hash {
            Some(h) => blob_text(conn, h)?,
            None => String::new(),
        };
        let attrs = match serde_json::from_str::<Value>(&r.attrs) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        nodes.insert(
            r.block_id.clone(),
            MutBlock {
                id: r.block_id.clone(),
                kind: r.kind.clone(),
                raw,
                trivia,
                attrs,
                children: Vec::new(),
                dirty: false,
            },
        );
    }
    // Children by parent, in ordinal order; roots in ordinal order.
    let mut ordered: Vec<&BlockRow> = rows.iter().collect();
    ordered.sort_by_key(|r| r.ordinal);
    let mut children_of: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut roots: Vec<&str> = Vec::new();
    for r in &ordered {
        match r.parent_block.as_deref().filter(|p| ids.contains(p)) {
            Some(p) => children_of.entry(p).or_default().push(&r.block_id),
            None => roots.push(&r.block_id),
        }
    }
    fn build(
        id: &str,
        nodes: &mut HashMap<String, MutBlock>,
        children_of: &HashMap<&str, Vec<&str>>,
    ) -> MutBlock {
        let mut b = nodes.remove(id).expect("every row was loaded");
        if let Some(kids) = children_of.get(id) {
            b.children = kids.iter().map(|k| build(k, nodes, children_of)).collect();
        }
        b
    }
    let children: Vec<MutBlock> = roots
        .iter()
        .map(|id| build(id, &mut nodes, &children_of))
        .collect();

    let mut frontmatter_raw = None;
    if let Some(rev) = current_rev {
        let fm: Option<Option<Vec<u8>>> = conn
            .query_row(
                "SELECT frontmatter_blob FROM revisions WHERE rev_id = ?1",
                params![rev],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(Some(hash)) = fm {
            let exists: bool = conn
                .query_row("SELECT 1 FROM blobs WHERE hash = ?1", params![hash], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if exists {
                let mut raw = blob_text(conn, &hash)?;
                raw.push_str(frontmatter_trivia.as_deref().unwrap_or(""));
                frontmatter_raw = Some(raw);
            }
        }
    }
    Ok(Some(MutDoc {
        doc_id: doc_id.to_owned(),
        path,
        format,
        leading_trivia,
        frontmatter_raw,
        children,
    }))
}

// ---- requests and results (§4) ---------------------------------------------------------

/// Who is writing and why (`commits.actor`, `commits.reason`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyOrigin {
    pub actor: String,
    pub reason: Option<String>,
}

impl ApplyOrigin {
    #[must_use]
    pub fn new(actor: &str, reason: Option<&str>) -> Self {
        Self {
            actor: actor.to_owned(),
            reason: reason.map(str::to_owned),
        }
    }
}

/// A frontmatter override (§4 `set_frontmatter`): the doc id and the new
/// frontmatter raw (fences + separator), or `None` to drop it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetFrontmatter {
    pub doc: String,
    pub raw: Option<String>,
}

/// §4 `Request`.
#[derive(Clone, Debug, PartialEq)]
pub struct ApplyRequest {
    pub repo_id: String,
    pub ops: Vec<Op>,
    pub origin: ApplyOrigin,
    pub dry_run: bool,
    pub set_frontmatter: Vec<SetFrontmatter>,
}

/// `{ doc, path }` of a touched document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
    pub doc: String,
    pub path: String,
}

/// `{ before, after }` of a dry run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diff {
    pub before: String,
    pub after: String,
}

/// §4 `Result`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyResult {
    pub results: Vec<OpResult>,
    pub revisions: Vec<Revision>,
    /// Path → diff, in load order; only on a dry run.
    pub diffs: Option<Vec<(String, Diff)>>,
    pub committed: bool,
}

impl ApplyResult {
    /// `{ results, revisions, diffs?, committed }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(
            "results".to_owned(),
            Value::Array(self.results.iter().map(OpResult::to_json).collect()),
        );
        m.insert(
            "revisions".to_owned(),
            Value::Array(
                self.revisions
                    .iter()
                    .map(|r| json!({ "doc": r.doc, "path": r.path }))
                    .collect(),
            ),
        );
        if let Some(diffs) = &self.diffs {
            let mut d = Map::new();
            for (path, diff) in diffs {
                d.insert(
                    path.clone(),
                    json!({ "before": diff.before, "after": diff.after }),
                );
            }
            m.insert("diffs".to_owned(), Value::Object(d));
        }
        m.insert("committed".to_owned(), json!(self.committed));
        Value::Object(m)
    }
}

/// A document loaded once per request (§4 step 1).
struct LoadedDoc {
    doc: MutDoc,
    /// The pre-mutation render.
    before: String,
    /// The live ids before any op (labels the `api` dispositions).
    prior_ids: Vec<String>,
}

fn merr(code: ErrorCode, msg: impl Into<String>) -> MutationError {
    MutationError::new(code, msg)
}

fn merr_data(code: ErrorCode, msg: impl Into<String>, data: Value) -> MutationError {
    MutationError::with_data(code, msg, data)
}

/// The store's `b` minter as the kernel's [`Minter`].
struct BlockMinter<'a>(&'a mut dyn crate::ids::IdMinter);

impl Minter for BlockMinter<'_> {
    fn mint(&mut self) -> String {
        self.0.mint("b")
    }
}

/// The ops applied to the loaded documents, before the commit phase.
struct Applied {
    loaded: Vec<LoadedDoc>,
    results: Vec<OpResult>,
}

impl Store {
    /// §1: [`load_mut_doc`] on this store.
    pub fn load_mut_doc(&self, doc_id: &str) -> Result<Option<MutDoc>> {
        load_mut_doc(&self.conn, doc_id)
    }

    /// A live doc by id or path.
    pub fn find_doc_by_ref(&self, repo_id: &str, r: &str) -> Result<Option<DocInfo>> {
        find_doc_by_ref(&self.conn, repo_id, r)
    }

    /// Which live document holds `block_id` (any repo).
    fn doc_id_for_block(&self, block_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![block_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// §4 steps 1–3: load on first touch, apply every op in order.
    fn apply_ops(&mut self, req: &ApplyRequest) -> Result<Applied> {
        let mut loaded: Vec<LoadedDoc> = Vec::new();
        let mut results: Vec<OpResult> = Vec::new();

        fn index_of(loaded: &[LoadedDoc], doc_id: &str) -> Option<usize> {
            loaded.iter().position(|d| d.doc.doc_id == doc_id)
        }
        fn doc_id_for_block_loaded(loaded: &[LoadedDoc], block_id: &str) -> Option<String> {
            loaded
                .iter()
                .find(|d| d.doc.contains(block_id))
                .map(|d| d.doc.doc_id.clone())
        }

        macro_rules! ensure_doc {
            ($doc_id:expr) => {{
                let id: &str = $doc_id;
                match index_of(&loaded, id) {
                    Some(i) => i,
                    None => {
                        let Some(doc) = load_mut_doc(&self.conn, id)? else {
                            return Err(merr(ErrorCode::DocMissing, format!("doc {id} not found")).into());
                        };
                        let before = render(&doc);
                        let prior_ids: Vec<String> = {
                            let mut stmt = self.conn.prepare(
                                "SELECT block_id FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL",
                            )?;
                            let it = stmt.query_map(params![id], |r| r.get(0))?;
                            it.collect::<std::result::Result<Vec<_>, _>>()?
                        };
                        loaded.push(LoadedDoc {
                            doc,
                            before,
                            prior_ids,
                        });
                        loaded.len() - 1
                    }
                }
            }};
        }
        macro_rules! doc_for_block {
            ($block:expr) => {{
                let b: &str = $block;
                match doc_id_for_block_loaded(&loaded, b) {
                    Some(id) => Some(id),
                    None => self.doc_id_for_block(b)?,
                }
            }};
        }
        macro_rules! parent_doc {
            ($to:expr) => {{
                let to: &To = $to;
                let anchor: Option<&str> = match &to.parent {
                    Parent::Block(id) => Some(id.as_str()),
                    Parent::Section { heading } => Some(heading.as_str()),
                    Parent::Doc => to.at.anchor(),
                };
                match anchor {
                    Some(id) => match doc_for_block!(id) {
                        Some(d) => d,
                        None => {
                            return Err(merr(
                                ErrorCode::ParentMissing,
                                format!("parent {id} not found"),
                            )
                            .into());
                        }
                    },
                    None => {
                        return Err(merr(
                            ErrorCode::TargetMissing,
                            "insert at top-level start/end requires an explicit doc",
                        )
                        .into());
                    }
                }
            }};
        }

        // §4 step 2: frontmatter overrides load their documents first.
        for fm in &req.set_frontmatter {
            let i = ensure_doc!(&fm.doc);
            loaded[i].doc.frontmatter_raw = fm.raw.clone();
        }

        for (i, raw_op) in req.ops.iter().enumerate() {
            let op = resolve_op(raw_op, &results)?;
            match &op {
                Op::Insert { doc, to, markdown } => {
                    let doc_id = match doc {
                        Some(r) => self.resolve_doc_ref(&req.repo_id, r)?,
                        None => parent_doc!(to),
                    };
                    let d = ensure_doc!(&doc_id);
                    let mut minter = BlockMinter(&mut *self.minter);
                    results.push(op_insert(&mut loaded[d].doc, to, markdown, &mut minter)?);
                }
                Op::Update {
                    block,
                    markdown,
                    attrs,
                    expect,
                    trivia,
                    child_ids,
                } => {
                    let Some(doc_id) = doc_for_block!(block) else {
                        return Err(merr_data(
                            ErrorCode::BlockMissing,
                            format!("block {block} not found"),
                            json!({ "op_index": i }),
                        )
                        .into());
                    };
                    let d = ensure_doc!(&doc_id);
                    let args = UpdateArgs {
                        markdown: markdown.clone(),
                        attrs: attrs.clone(),
                        expect: expect.clone(),
                        trivia: trivia.clone(),
                        child_ids: child_ids.clone(),
                    };
                    let mut minter = BlockMinter(&mut *self.minter);
                    results.push(op_update(&mut loaded[d].doc, block, i, &args, &mut minter)?);
                }
                Op::Move { blocks, to } => {
                    let first = blocks.first().map(String::as_str).unwrap_or("");
                    let Some(src) = doc_for_block!(first) else {
                        return Err(merr_data(
                            ErrorCode::BlockMissing,
                            format!("block {first} not found"),
                            json!({ "op_index": i }),
                        )
                        .into());
                    };
                    let top_level_same_doc =
                        to.parent == Parent::Doc && matches!(to.at, At::Start | At::End);
                    let dst = if top_level_same_doc {
                        src.clone()
                    } else {
                        parent_doc!(to)
                    };
                    if dst == src {
                        let d = ensure_doc!(&src);
                        results.push(op_move(&mut loaded[d].doc, blocks, to, i)?);
                    } else {
                        let s = ensure_doc!(&src);
                        let t = ensure_doc!(&dst);
                        let (a, b) = two_mut(&mut loaded, s, t);
                        results.push(cross_doc_move(&mut a.doc, &mut b.doc, blocks, to, i)?);
                    }
                }
                Op::Remove { blocks, expect } => {
                    let first = blocks.first().map(String::as_str).unwrap_or("");
                    let Some(doc_id) = doc_for_block!(first) else {
                        return Err(merr_data(
                            ErrorCode::BlockMissing,
                            format!("block {first} not found"),
                            json!({ "op_index": i }),
                        )
                        .into());
                    };
                    let d = ensure_doc!(&doc_id);
                    results.push(op_remove(&mut loaded[d].doc, blocks, i, expect.as_ref())?);
                }
                Op::Split { block, at, expect } => {
                    let Some(doc_id) = doc_for_block!(block) else {
                        return Err(merr_data(
                            ErrorCode::BlockMissing,
                            format!("block {block} not found"),
                            json!({ "op_index": i }),
                        )
                        .into());
                    };
                    let d = ensure_doc!(&doc_id);
                    let mut minter = BlockMinter(&mut *self.minter);
                    results.push(op_split(
                        &mut loaded[d].doc,
                        block,
                        at,
                        i,
                        expect.as_ref(),
                        &mut minter,
                    )?);
                }
                Op::Merge {
                    blocks,
                    separator,
                    expect,
                } => {
                    let first = blocks.first().map(String::as_str).unwrap_or("");
                    let Some(doc_id) = doc_for_block!(first) else {
                        return Err(merr_data(
                            ErrorCode::BlockMissing,
                            format!("block {first} not found"),
                            json!({ "op_index": i }),
                        )
                        .into());
                    };
                    let d = ensure_doc!(&doc_id);
                    results.push(op_merge(
                        &mut loaded[d].doc,
                        blocks,
                        i,
                        separator.as_deref(),
                        expect.as_ref(),
                    )?);
                }
            }
        }
        Ok(Applied { loaded, results })
    }

    /// §4 step 1: an `insert.doc` — a `d_` id passes through (the document
    /// is loaded, and `doc_missing` raised, at first touch), a path resolves
    /// to a live doc or `doc_missing`.
    fn resolve_doc_ref(&self, repo_id: &str, r: &str) -> Result<String> {
        if is_id_ref(r, "d") {
            return Ok(r.to_owned());
        }
        match find_doc_by_ref(&self.conn, repo_id, r)? {
            Some(info) => Ok(info.doc_id),
            None => Err(merr_data(
                ErrorCode::DocMissing,
                format!("doc {r} not found"),
                json!({ "doc": r }),
            )
            .into()),
        }
    }

    /// §4: apply a changeset at `ts` (RFC 3339 UTC, stamped on every commit
    /// the request records). Steps 1–4 in memory; unless `dry_run`, the
    /// commit phase per loaded document in load order — file-CAS against
    /// `doc_store` (a mismatch ingests the on-disk bytes as `observed` and
    /// raises `sync_conflict`), the atomic write, the `api` ingest with the
    /// known ids. Atomic up to the commit phase; a `sync_conflict` on the
    /// *n*-th document leaves the earlier ones committed (§10).
    pub fn apply(
        &mut self,
        req: &ApplyRequest,
        doc_store: &mut dyn DocStore,
        ts: &str,
    ) -> Result<ApplyResult> {
        let Applied { loaded, results } = self.apply_ops(req)?;
        let revisions: Vec<Revision> = loaded
            .iter()
            .map(|d| Revision {
                doc: d.doc.doc_id.clone(),
                path: d.doc.path.clone(),
            })
            .collect();
        if req.dry_run {
            let diffs = loaded
                .iter()
                .map(|d| {
                    (
                        d.doc.path.clone(),
                        Diff {
                            before: d.before.clone(),
                            after: render(&d.doc),
                        },
                    )
                })
                .collect();
            return Ok(ApplyResult {
                results,
                revisions,
                diffs: Some(diffs),
                committed: false,
            });
        }
        let expires = crate::time::pool_expiry(ts)?;
        for d in &loaded {
            let rendered = render(&d.doc);
            let path = d.doc.path.as_str();
            // File-CAS (§4 step 5).
            let current: Option<Option<Vec<u8>>> = self
                .conn
                .query_row(
                    "SELECT file_hash FROM docs WHERE doc_id = ?1",
                    params![d.doc.doc_id],
                    |r| r.get(0),
                )
                .optional()?;
            let on_disk = doc_store.read(path)?;
            if let (Some(bytes), Some(Some(hash))) = (&on_disk, &current) {
                if sha256(bytes.as_bytes())[..] != hash[..] {
                    self.reconciling_ingest(
                        &req.repo_id,
                        path,
                        bytes,
                        ts,
                        Origin::Observed,
                        None,
                        None,
                        &Config::default(),
                    )?;
                    return Err(merr_data(
                        ErrorCode::SyncConflict,
                        format!("file {path} changed on disk; re-ingested — retry"),
                        json!({ "retriable": true }),
                    )
                    .into());
                }
            }
            doc_store.write(path, &rendered)?;
            // The known-id `api` ingest.
            let tree = parse_markdown(&rendered);
            let body: &[Block] = match tree.children.first() {
                Some(b) if b.kind == omgbase_format::BlockKind::Frontmatter => &tree.children[1..],
                _ => &tree.children[..],
            };
            let by_key = positional_ids(&d.doc.children);
            let assigned = assign_known(body, &by_key, None, &mut *self.minter);
            let mut now_ids = Vec::new();
            collect_ids(&assigned, &mut now_ids);
            let prior: HashSet<&str> = d.prior_ids.iter().map(String::as_str).collect();
            let now: HashSet<&str> = now_ids.iter().map(String::as_str).collect();
            let dispositions = now_ids
                .iter()
                .map(|id| DispositionRow {
                    block_id: id.clone(),
                    kind: if prior.contains(id.as_str()) {
                        "edited".to_owned()
                    } else {
                        "inserted".to_owned()
                    },
                    confidence: Some(1.0),
                    reason: Some("api".to_owned()),
                    matcher_v: None,
                    detail: "{}".to_owned(),
                })
                .collect();
            let deleted: Vec<String> = d
                .prior_ids
                .iter()
                .filter(|id| !now.contains(id.as_str()))
                .cloned()
                .collect();
            // Ids new to this document may be live (or pooled) elsewhere — a
            // cross-document move whose source commits later, or already did.
            // spec/store §5.4 step 8 evicts the foreign row and the pool row;
            // for a freshly minted id it finds nothing.
            let cross_doc_ids: Vec<String> = now_ids
                .iter()
                .filter(|id| !prior.contains(id.as_str()))
                .cloned()
                .collect();
            let plan = IngestPlan {
                path,
                source: &rendered,
                tree: &tree,
                assigned,
                dispositions,
                deleted,
                consumed_pool: Vec::new(),
                cross_doc_ids,
                origin: Origin::Api,
                actor: Some(req.origin.actor.as_str()),
                reason: req.origin.reason.as_deref(),
            };
            self.commit_ingest(&req.repo_id, &plan, ts, &expires)?;
        }
        Ok(ApplyResult {
            results,
            revisions,
            diffs: None,
            committed: true,
        })
    }
}

/// Two distinct elements of a slice, mutably.
fn two_mut<T>(v: &mut [T], i: usize, j: usize) -> (&mut T, &mut T) {
    assert_ne!(i, j, "a cross-document move names two documents");
    if i < j {
        let (a, b) = v.split_at_mut(j);
        (&mut a[i], &mut b[0])
    } else {
        let (a, b) = v.split_at_mut(i);
        (&mut b[0], &mut a[j])
    }
}

/// The working tree's ids by positional key (`"/i/j"`).
fn positional_ids(children: &[MutBlock]) -> BTreeMap<String, String> {
    fn walk(list: &[MutBlock], parent_key: &str, out: &mut BTreeMap<String, String>) {
        for (i, b) in list.iter().enumerate() {
            let key = format!("{parent_key}/{i}");
            out.insert(key.clone(), b.id.clone());
            if !b.children.is_empty() {
                walk(&b.children, &key, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(children, "", &mut out);
    out
}

/// §4 step 5: the re-parsed body with the tree's ids by positional key; a
/// position with no id mints (impossible under the round-trip law).
fn assign_known(
    blocks: &[Block],
    by_key: &BTreeMap<String, String>,
    parent_key: Option<&str>,
    minter: &mut dyn crate::ids::IdMinter,
) -> Vec<TreeInputBlock> {
    blocks
        .iter()
        .enumerate()
        .map(|(index, b)| {
            let key = format!("{}/{index}", parent_key.unwrap_or(""));
            let block_id = by_key
                .get(&key)
                .cloned()
                .unwrap_or_else(|| minter.mint("b"));
            TreeInputBlock {
                block_id,
                kind: b.kind.as_str().to_owned(),
                raw: b.raw.clone(),
                text: b.text.clone(),
                trivia: b.trivia.clone(),
                attrs: b.attrs.clone(),
                children: assign_known(&b.children, by_key, Some(&key), minter),
            }
        })
        .collect()
}

fn collect_ids(blocks: &[TreeInputBlock], out: &mut Vec<String>) {
    for b in blocks {
        out.push(b.block_id.clone());
        collect_ids(&b.children, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_refs_accept_production_and_fixture_ids() {
        assert!(is_id_ref("d_0", "d"));
        assert!(is_id_ref("d_k7z2p9q", "d"));
        assert!(!is_id_ref("d_k7z2p9qq", "d"));
        assert!(!is_id_ref("b_0", "d"));
        assert!(!is_id_ref("a.md", "d"));
        assert!(!is_id_ref("d_", "d"));
        assert!(!is_id_ref("d_i", "d"), "i is not Crockford");
    }

    #[test]
    fn positional_keys_follow_the_flatten_convention() {
        let mut l = MutBlock::new("l", "list", "- a", "\n");
        l.children.push(MutBlock::new("a", "list_item", "- a", ""));
        let keys = positional_ids(&[MutBlock::new("h", "heading", "# H", "\n\n"), l]);
        assert_eq!(keys["/0"], "h");
        assert_eq!(keys["/1"], "l");
        assert_eq!(keys["/1/0"], "a");
    }
}
