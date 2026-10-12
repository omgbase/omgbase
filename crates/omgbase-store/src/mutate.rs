//! Changesets over the store (`spec/mutate/README.md` §1, §4): loading a
//! document into the working tree, applying the ops in order across the
//! documents they touch, and the commit protocol — the on-disk bytes read,
//! the `api` ingest of every document with the ops' **known ids** under one
//! commit in one transaction ([`crate::effects`], 2.1) that re-validates
//! every document's `(path, current_rev, file_hash)` and the bytes read
//! before minting anything (2.2) and records the files it owes, then the
//! files materialized after COMMIT ([`crate::materialize`], store 14.0).

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
use crate::effects::{CommitHead, DocBase, Effect, Outcome, doc_base, touched_paths};
use crate::error::{Error, Result};
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
    pub(crate) before: String,
    /// The live ids before any op (labels the `api` dispositions).
    pub(crate) prior_ids: Vec<String>,
    /// The row's `(path, current_rev, file_hash)` as loaded — the
    /// precondition the commit re-validates inside its transaction (2.2).
    pub(crate) base: DocBase,
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

    /// §4 steps 1–3: load on first touch, apply every op in order (the
    /// frontmatter overrides first).
    pub(crate) fn apply_ops(&mut self, req: &ApplyRequest) -> Result<Applied> {
        let mut runner = OpsRunner::new(&req.repo_id);
        // §4 step 2: frontmatter overrides load their documents first.
        for fm in &req.set_frontmatter {
            runner.set_frontmatter(self, &fm.doc, fm.raw.clone())?;
        }
        for raw_op in &req.ops {
            runner.push(self, raw_op)?;
        }
        Ok(runner.finish())
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
    /// commit phase (step 5, 2.2 / store 14.0): **(a)** read every loaded
    /// document's file from `doc_store`; **(b)** one `BEGIN IMMEDIATE`
    /// transaction that first re-validates every document's `(path,
    /// current_rev, file_hash)` and the bytes (a) read — `stale_plan` with
    /// the current truth when the database moved, `sync_conflict` after an
    /// `observed` ingest of the disk bytes when the file did, nothing minted
    /// or written either way — then one `api` commit row, the known-id
    /// ingest of every document in load order (`spec/store` §5.4) and one
    /// `pending_materializations` row per document; **(c)** after COMMIT,
    /// the rendered files, each row deleted as its file lands
    /// ([`Store::materialize_pending`]). Atomic per request in the
    /// database; a failure in (b) rolls every document back with no file
    /// touched, a crash in (c) leaves the rows for the next materializer.
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
        // (a) A row an earlier request left at a touched path is landed
        //     first, so a stale file reads as the engine's own bytes.
        let touched: Vec<String> = loaded.iter().map(|d| d.doc.path.clone()).collect();
        self.materialize_paths(&req.repo_id, &touched, doc_store)?;
        let on_disk = read_on_disk(&loaded, doc_store)?;
        let staged = stage(&loaded, on_disk, |d| d.doc.path.clone());
        let head = CommitHead {
            origin: Origin::Api,
            actor: Some(req.origin.actor.as_str()),
            reason: req.origin.reason.as_deref(),
            clear_pending: false,
            ops: None,
        };
        let effects: Vec<Effect> = staged.into_iter().map(Staged::into_effect).collect();
        // (b) The transaction.
        match self.commit_effects(&req.repo_id, &head, &effects, ts)? {
            Outcome::Committed(_) => {}
            Outcome::Conflict(c) => {
                return Err(self.disk_conflict(&req.repo_id, &c.path, &c.bytes, ts));
            }
        }
        // (c) The files this request recorded.
        self.materialize_paths(&req.repo_id, &touched_paths(&effects), doc_store)?;
        Ok(ApplyResult {
            results,
            revisions,
            diffs: None,
            committed: true,
        })
    }

    /// The file at `path` no longer hashes to its document's `file_hash`:
    /// ingest `bytes` as an `observed` commit in a transaction of its own
    /// (the file wins, ADR-004 — a pending row at the path goes with it,
    /// §5.7) and build the `sync_conflict` (retriable) the request fails
    /// with — or the error that ingest itself raised.
    pub(crate) fn disk_conflict(
        &mut self,
        repo_id: &str,
        path: &str,
        bytes: &str,
        ts: &str,
    ) -> Error {
        let head = CommitHead {
            origin: Origin::Observed,
            actor: None,
            reason: None,
            clear_pending: true,
            ops: None,
        };
        if let Err(e) = self
            .reconciling_commit(
                repo_id,
                path,
                bytes,
                ts,
                &head,
                &Config::default(),
                crate::effects::Guard::None,
            )
            .and_then(Outcome::committed)
        {
            return e;
        }
        merr_data(
            ErrorCode::SyncConflict,
            format!("file {path} changed on disk; re-ingested — retry"),
            json!({ "retriable": true }),
        )
        .into()
    }
}

/// The op loop of §4 steps 1–4 as an incremental runner (the reference's
/// `ChangesetPlanner`): [`OpsRunner::push`] applies one op to the in-memory
/// trees — loading a document at first touch and remembering its
/// pre-mutation render, live ids and row triple — and [`OpsRunner::finish`]
/// hands back the loaded documents and every op's result. [`Store::apply_ops`]
/// is `push` over a whole request; the effect planner (`spec/mutate` §11,
/// 2.3) pushes an effect's lowered ops one effect at a time so it can read
/// the ids each op minted before lowering the next, and sets a document's
/// file head for a frontmatter effect.
pub(crate) struct OpsRunner {
    repo_id: String,
    pub(crate) loaded: Vec<LoadedDoc>,
    /// Per op, in push order (`$n.ids[i]` placeholders resolve against these).
    pub(crate) results: Vec<OpResult>,
}

impl OpsRunner {
    pub(crate) fn new(repo_id: &str) -> Self {
        Self {
            repo_id: repo_id.to_owned(),
            loaded: Vec::new(),
            results: Vec::new(),
        }
    }

    /// The loaded documents and results (§4 step 4 renders them).
    pub(crate) fn finish(self) -> Applied {
        Applied {
            loaded: self.loaded,
            results: self.results,
        }
    }

    fn index_of(&self, doc_id: &str) -> Option<usize> {
        self.loaded.iter().position(|d| d.doc.doc_id == doc_id)
    }

    /// Load `doc_id` at first touch (§4 step 1); `doc_missing` for an
    /// unknown or tombstoned document. Returns its index in `loaded`.
    pub(crate) fn ensure_doc(&mut self, store: &Store, doc_id: &str) -> Result<usize> {
        if let Some(i) = self.index_of(doc_id) {
            return Ok(i);
        }
        let Some(doc) = load_mut_doc(&store.conn, doc_id)? else {
            return Err(merr(ErrorCode::DocMissing, format!("doc {doc_id} not found")).into());
        };
        let Some(base) = doc_base(&store.conn, doc_id)? else {
            return Err(merr(ErrorCode::DocMissing, format!("doc {doc_id} not found")).into());
        };
        let before = render(&doc);
        let prior_ids: Vec<String> = {
            let mut stmt = store.conn.prepare(
                "SELECT block_id FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL",
            )?;
            let it = stmt.query_map(params![doc_id], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        };
        self.loaded.push(LoadedDoc {
            doc,
            before,
            prior_ids,
            base,
        });
        Ok(self.loaded.len() - 1)
    }

    /// Where a block sits in the LOADED trees (an id an earlier op minted
    /// included): the document and the block. Never loads a document.
    pub(crate) fn locate_loaded(&self, block_id: &str) -> Option<(&LoadedDoc, &MutBlock)> {
        self.loaded
            .iter()
            .find_map(|d| d.doc.locate(block_id).map(|path| (d, d.doc.block(&path))))
    }

    /// The document holding `block_id`: a loaded tree first, else the live row.
    fn doc_for_block(&self, store: &Store, block_id: &str) -> Result<Option<String>> {
        if let Some(d) = self.loaded.iter().find(|d| d.doc.contains(block_id)) {
            return Ok(Some(d.doc.doc_id.clone()));
        }
        store.doc_id_for_block(block_id)
    }

    /// The document a placement's parent or anchor names (`parent_missing`
    /// when unknown; a top-level `start`/`end` without `doc` is
    /// `target_missing`).
    fn parent_doc(&self, store: &Store, to: &To) -> Result<String> {
        let anchor: Option<&str> = match &to.parent {
            Parent::Block(id) => Some(id.as_str()),
            Parent::Section { heading } => Some(heading.as_str()),
            Parent::Doc => to.at.anchor(),
        };
        match anchor {
            Some(id) => self.doc_for_block(store, id)?.ok_or_else(|| {
                merr(ErrorCode::ParentMissing, format!("parent {id} not found")).into()
            }),
            None => Err(merr(
                ErrorCode::TargetMissing,
                "insert at top-level start/end requires an explicit doc",
            )
            .into()),
        }
    }

    /// `ApplyRequest.set_frontmatter`'s semantics: replace the frontmatter
    /// bytes (fences + separator), leaving the leading trivia.
    pub(crate) fn set_frontmatter(
        &mut self,
        store: &Store,
        doc_id: &str,
        raw: Option<String>,
    ) -> Result<()> {
        let i = self.ensure_doc(store, doc_id)?;
        self.loaded[i].doc.frontmatter_raw = raw;
        Ok(())
    }

    /// `spec/mutate` §11.3 (2.3): replace everything before the first block
    /// — the leading trivia AND the frontmatter — with `raw` (the file head).
    pub(crate) fn set_head(&mut self, store: &Store, doc_id: &str, raw: &str) -> Result<()> {
        let i = self.ensure_doc(store, doc_id)?;
        self.loaded[i].doc.leading_trivia = String::new();
        self.loaded[i].doc.frontmatter_raw = Some(raw.to_owned());
        Ok(())
    }

    /// Apply one op (§2); its `op_index` is its position in `results`.
    pub(crate) fn push(&mut self, store: &mut Store, raw_op: &Op) -> Result<&OpResult> {
        let i = self.results.len();
        let op = resolve_op(raw_op, &self.results)?;
        let missing = |block: &str| -> Error {
            merr_data(
                ErrorCode::BlockMissing,
                format!("block {block} not found"),
                json!({ "op_index": i }),
            )
            .into()
        };
        let result = match &op {
            Op::Insert {
                doc,
                to,
                markdown,
                expect,
            } => {
                let doc_id = match doc {
                    Some(r) => store.resolve_doc_ref(&self.repo_id, r)?,
                    None => self.parent_doc(store, to)?,
                };
                let d = self.ensure_doc(store, &doc_id)?;
                let mut mint = store.ids.at(&store.conn);
                let mut minter = mint.deferred("b");
                let result = op_insert(
                    &mut self.loaded[d].doc,
                    to,
                    markdown,
                    i,
                    expect.as_ref(),
                    &mut minter,
                );
                minter.finish()?;
                result?
            }
            Op::Update {
                block,
                markdown,
                attrs,
                expect,
                trivia,
                child_ids,
            } => {
                let doc_id = self
                    .doc_for_block(store, block)?
                    .ok_or_else(|| missing(block))?;
                let d = self.ensure_doc(store, &doc_id)?;
                let args = UpdateArgs {
                    markdown: markdown.clone(),
                    attrs: attrs.clone(),
                    expect: expect.clone(),
                    trivia: trivia.clone(),
                    child_ids: child_ids.clone(),
                };
                let mut mint = store.ids.at(&store.conn);
                let mut minter = mint.deferred("b");
                let result = op_update(&mut self.loaded[d].doc, block, i, &args, &mut minter);
                minter.finish()?;
                result?
            }
            Op::Move { blocks, to, expect } => {
                let first = blocks.first().map(String::as_str).unwrap_or("");
                let src = self
                    .doc_for_block(store, first)?
                    .ok_or_else(|| missing(first))?;
                let top_level_same_doc =
                    to.parent == Parent::Doc && matches!(to.at, At::Start | At::End);
                let dst = if top_level_same_doc {
                    src.clone()
                } else {
                    self.parent_doc(store, to)?
                };
                if dst == src {
                    let d = self.ensure_doc(store, &src)?;
                    op_move(&mut self.loaded[d].doc, blocks, to, i, expect.as_ref())?
                } else {
                    let s = self.ensure_doc(store, &src)?;
                    let t = self.ensure_doc(store, &dst)?;
                    let (a, b) = two_mut(&mut self.loaded, s, t);
                    cross_doc_move(&mut a.doc, &mut b.doc, blocks, to, i, expect.as_ref())?
                }
            }
            Op::Remove { blocks, expect } => {
                let first = blocks.first().map(String::as_str).unwrap_or("");
                let doc_id = self
                    .doc_for_block(store, first)?
                    .ok_or_else(|| missing(first))?;
                let d = self.ensure_doc(store, &doc_id)?;
                op_remove(&mut self.loaded[d].doc, blocks, i, expect.as_ref())?
            }
            Op::Split { block, at, expect } => {
                let doc_id = self
                    .doc_for_block(store, block)?
                    .ok_or_else(|| missing(block))?;
                let d = self.ensure_doc(store, &doc_id)?;
                let mut mint = store.ids.at(&store.conn);
                let mut minter = mint.deferred("b");
                let result = op_split(
                    &mut self.loaded[d].doc,
                    block,
                    at,
                    i,
                    expect.as_ref(),
                    &mut minter,
                );
                minter.finish()?;
                result?
            }
            Op::Merge {
                blocks,
                separator,
                expect,
            } => {
                let first = blocks.first().map(String::as_str).unwrap_or("");
                let doc_id = self
                    .doc_for_block(store, first)?
                    .ok_or_else(|| missing(first))?;
                let d = self.ensure_doc(store, &doc_id)?;
                op_merge(
                    &mut self.loaded[d].doc,
                    blocks,
                    i,
                    separator.as_deref(),
                    expect.as_ref(),
                )?
            }
        };
        self.results.push(result);
        Ok(self.results.last().expect("just pushed"))
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
    /// The row as loaded, re-validated inside the commit (2.2).
    base: DocBase,
    /// The file as phase (a) read it at the loaded path.
    on_disk: Option<String>,
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
            base: self.base,
            on_disk: self.on_disk,
        }
    }
}

/// Render every loaded document, each to live at `path_of(doc)`, carrying
/// the bytes [`read_on_disk`] read for it (one entry per loaded document,
/// in order).
pub(crate) fn stage(
    loaded: &[LoadedDoc],
    on_disk: Vec<Option<String>>,
    path_of: impl Fn(&LoadedDoc) -> String,
) -> Vec<Staged> {
    debug_assert_eq!(loaded.len(), on_disk.len());
    loaded
        .iter()
        .zip(on_disk)
        .map(|(d, on_disk)| Staged {
            doc_id: d.doc.doc_id.clone(),
            path: path_of(d),
            rendered: render(&d.doc),
            by_key: positional_ids(&d.doc.children),
            prior_ids: d.prior_ids.clone(),
            base: d.base.clone(),
            on_disk,
        })
        .collect()
}

/// §4 step 5 (a): the file of every loaded document at the path it was
/// loaded under, in order (`None`: no file) — read here, outside the
/// transaction, and compared with the row's `file_hash` inside it (2.2): a
/// file that no longer hashes to what the document's revision renders is a
/// `sync_conflict` the caller raises after ingesting the disk bytes as
/// `observed`. Nothing is written before the commit (14.0).
pub(crate) fn read_on_disk(
    loaded: &[LoadedDoc],
    doc_store: &dyn DocStore,
) -> Result<Vec<Option<String>>> {
    loaded.iter().map(|d| doc_store.read(&d.doc.path)).collect()
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
