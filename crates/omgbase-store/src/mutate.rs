//! Changesets over the store (`spec/mutate/README.md` §1, §4): loading a
//! document into the working tree, applying the ops in order across the
//! documents they touch, and the commit protocol — file-CAS against the doc
//! store, atomic writes, and the `api` ingest of every document with the
//! ops' **known ids** under one commit in one transaction
//! ([`crate::effects`], 2.1).

use std::collections::{BTreeMap, HashMap, HashSet};

use omgbase_format::Block;
use omgbase_format::hash::sha256;
use omgbase_mutate::{
    At, ErrorCode, MutBlock, MutDoc, MutationError, Op, OpResult, Parent, To, UpdateArgs,
    cross_doc_move, op_insert, op_merge, op_move, op_remove, op_split, op_update, render,
    resolve_op,
};
use omgbase_reconcile::Config;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::Store;
use crate::doc_store::DocStore;
use crate::effects::{CommitHead, Effect};
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
    let map = |row: &rusqlite::Row<'_>| {
        Ok(DocInfo {
            doc_id: row.get(0)?,
            path: row.get(1)?,
            current_rev: row.get(2)?,
        })
    };
    // The id branch binds one parameter, the path branch two (a two-value
    // bind against the one-placeholder query is `InvalidParameterCount`).
    let found = if is_id_ref(r, "d") {
        conn.query_row(
            "SELECT doc_id, path, current_rev FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
            params![r],
            map,
        )
    } else {
        conn.query_row(
            "SELECT doc_id, path, current_rev FROM docs WHERE path = ?1 AND repo_id = ?2 AND deleted_commit IS NULL",
            params![r, repo_id],
            map,
        )
    };
    Ok(found.optional()?)
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

/// `{ id, path, hash }` of a touched document (`spec/mutate` §4, 2.0): the
/// document, its path (storage form; the surface roots it) and the hex sha256
/// of its rendered bytes — the hash the committed revision carries, computed
/// on a dry run too, so an apply revision and a `changes_since` revision are
/// one shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Revision {
    pub doc: String,
    pub path: String,
    pub hash: String,
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
                    .map(|r| json!({ "id": r.doc, "path": r.path, "hash": r.hash }))
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
pub(crate) struct LoadedDoc {
    pub(crate) doc: MutDoc,
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

/// The ops applied to the loaded documents, before the commit phase.
pub(crate) struct Applied {
    pub(crate) loaded: Vec<LoadedDoc>,
    pub(crate) results: Vec<OpResult>,
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
    pub(crate) fn apply_ops(&mut self, req: &ApplyRequest) -> Result<Applied> {
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
                Op::Insert {
                    doc,
                    to,
                    markdown,
                    expect,
                } => {
                    let doc_id = match doc {
                        Some(r) => self.resolve_doc_ref(&req.repo_id, r)?,
                        None => parent_doc!(to),
                    };
                    let d = ensure_doc!(&doc_id);
                    let mut mint = self.ids.at(&self.conn);
                    let mut minter = mint.deferred("b");
                    let result = op_insert(
                        &mut loaded[d].doc,
                        to,
                        markdown,
                        i,
                        expect.as_ref(),
                        &mut minter,
                    );
                    minter.finish()?;
                    results.push(result?);
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
                    let mut mint = self.ids.at(&self.conn);
                    let mut minter = mint.deferred("b");
                    let result = op_update(&mut loaded[d].doc, block, i, &args, &mut minter);
                    minter.finish()?;
                    results.push(result?);
                }
                Op::Move { blocks, to, expect } => {
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
                        results.push(op_move(&mut loaded[d].doc, blocks, to, i, expect.as_ref())?);
                    } else {
                        let s = ensure_doc!(&src);
                        let t = ensure_doc!(&dst);
                        let (a, b) = two_mut(&mut loaded, s, t);
                        results.push(cross_doc_move(
                            &mut a.doc,
                            &mut b.doc,
                            blocks,
                            to,
                            i,
                            expect.as_ref(),
                        )?);
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
                    let mut mint = self.ids.at(&self.conn);
                    let mut minter = mint.deferred("b");
                    let result = op_split(
                        &mut loaded[d].doc,
                        block,
                        at,
                        i,
                        expect.as_ref(),
                        &mut minter,
                    );
                    minter.finish()?;
                    results.push(result?);
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

    /// §4: apply a changeset at `ts` (RFC 3339 UTC, stamped on the commit
    /// the request records). Steps 1–4 in memory; unless `dry_run`, the
    /// commit phase (step 5, 2.1): **(a)** file-CAS every loaded document
    /// against `doc_store` — the first mismatch ingests the on-disk bytes as
    /// `observed` (its own transaction) and raises `sync_conflict`, nothing
    /// written or committed; **(b)** write every rendered file; **(c)** one
    /// transaction, one `api` commit row, the known-id ingest of every
    /// document in load order (`spec/store` §5.4). Atomic per request: a
    /// failure in (c) rolls every document back and leaves the written
    /// files ahead of the database until the next observation heals them
    /// (§10).
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
                hash: omgbase_format::hash::hex(&sha256(render(&d.doc).as_bytes())),
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
        let staged = stage(&loaded, |d| d.doc.path.clone());
        self.file_cas(&req.repo_id, &loaded, doc_store, ts)?;
        write_staged(&staged, doc_store)?;
        let head = CommitHead {
            origin: Origin::Api,
            actor: Some(req.origin.actor.as_str()),
            reason: req.origin.reason.as_deref(),
        };
        let effects: Vec<Effect> = staged.into_iter().map(Staged::into_effect).collect();
        self.commit_effects(&req.repo_id, &head, &effects, ts)?;
        Ok(ApplyResult {
            results,
            revisions,
            diffs: None,
            committed: true,
        })
    }

    /// §4 step 5 (a): file-CAS every loaded document at the path it was
    /// loaded under — the bytes on disk must hash to `docs.file_hash`. The
    /// first mismatch ingests the disk bytes as an `observed` commit in a
    /// transaction of its own and fails `sync_conflict` (retriable); nothing
    /// else is written or committed. A path with no file, or a doc with no
    /// hash yet, passes.
    pub(crate) fn file_cas(
        &mut self,
        repo_id: &str,
        loaded: &[LoadedDoc],
        doc_store: &dyn DocStore,
        ts: &str,
    ) -> Result<()> {
        for d in loaded {
            let path = d.doc.path.as_str();
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
                        repo_id,
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
        }
        Ok(())
    }
}

/// A loaded document rendered for the commit phase: the bytes to write at
/// `path` and what its known-id ingest needs. `path` is where the document
/// will live — the loaded path, or the new one for a document a `docs_move`
/// in the same request renames.
pub(crate) struct Staged {
    pub doc_id: String,
    pub path: String,
    pub rendered: String,
    by_key: BTreeMap<String, String>,
    prior_ids: Vec<String>,
}

impl Staged {
    /// The [`Effect::IngestKnown`] of this document.
    pub(crate) fn into_effect(self) -> Effect {
        Effect::IngestKnown {
            doc_id: self.doc_id,
            path: self.path,
            rendered: self.rendered,
            by_key: self.by_key,
            prior_ids: self.prior_ids,
        }
    }
}

/// Render every loaded document, each to live at `path_of(doc)`.
pub(crate) fn stage(loaded: &[LoadedDoc], path_of: impl Fn(&LoadedDoc) -> String) -> Vec<Staged> {
    loaded
        .iter()
        .map(|d| Staged {
            doc_id: d.doc.doc_id.clone(),
            path: path_of(d),
            rendered: render(&d.doc),
            by_key: positional_ids(&d.doc.children),
            prior_ids: d.prior_ids.clone(),
        })
        .collect()
}

/// §4 step 5 (b): write every staged file, in load order.
pub(crate) fn write_staged(staged: &[Staged], doc_store: &mut dyn DocStore) -> Result<()> {
    for s in staged {
        doc_store.write(&s.path, &s.rendered)?;
    }
    Ok(())
}

/// §4 step 5 (c) for one document: the known-id [`IngestPlan`] over the
/// re-parsed `rendered` bytes — ids by position from the working tree (a
/// position with no id mints `b`, impossible under the round-trip law), the
/// `api` dispositions (`edited` for a prior id, `inserted` otherwise), the
/// prior ids now gone (pooled), and the ids new to this document as
/// `cross_doc_ids` (a cross-document move's source may hold them live or
/// pooled; `spec/store` §5.4 step 8 evicts those rows, and finds nothing for
/// a freshly minted id). An `api` commit never touches `docs.conflicted`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn known_plan<'a>(
    tree: &'a omgbase_format::BlockTree,
    path: &'a str,
    rendered: &'a str,
    by_key: &BTreeMap<String, String>,
    prior_ids: &[String],
    minter: &mut crate::mint::Mint<'_>,
    origin: Origin,
    actor: Option<&'a str>,
    reason: Option<&'a str>,
) -> Result<IngestPlan<'a>> {
    let body: &[Block] = match tree.children.first() {
        Some(b) if b.kind == omgbase_format::BlockKind::Frontmatter => &tree.children[1..],
        _ => &tree.children[..],
    };
    let assigned = assign_known(body, by_key, None, minter)?;
    let mut now_ids = Vec::new();
    collect_ids(&assigned, &mut now_ids);
    let prior: HashSet<&str> = prior_ids.iter().map(String::as_str).collect();
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
    let deleted: Vec<String> = prior_ids
        .iter()
        .filter(|id| !now.contains(id.as_str()))
        .cloned()
        .collect();
    let cross_doc_ids: Vec<String> = now_ids
        .iter()
        .filter(|id| !prior.contains(id.as_str()))
        .cloned()
        .collect();
    Ok(IngestPlan {
        path,
        source: rendered,
        tree,
        assigned,
        dispositions,
        deleted,
        consumed_pool: Vec::new(),
        cross_doc_ids,
        origin,
        actor,
        reason,
        conflicted: None,
    })
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
    minter: &mut crate::mint::Mint<'_>,
) -> Result<Vec<TreeInputBlock>> {
    blocks
        .iter()
        .enumerate()
        .map(|(index, b)| {
            let key = format!("{}/{index}", parent_key.unwrap_or(""));
            let block_id = match by_key.get(&key) {
                Some(id) => id.clone(),
                None => minter.mint("b")?,
            };
            Ok(TreeInputBlock {
                block_id,
                kind: b.kind.as_str().to_owned(),
                raw: b.raw.clone(),
                text: b.text.clone(),
                trivia: b.trivia.clone(),
                attrs: b.attrs.clone(),
                span: b.span,
                children: assign_known(&b.children, by_key, Some(&key), minter)?,
            })
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
