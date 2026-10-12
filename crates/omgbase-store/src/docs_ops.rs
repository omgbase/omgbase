//! Document operations (`spec/mutate/README.md` §6): create, move, delete,
//! set-meta — `api` commits with generated reasons, each committing first
//! and materializing its files after (store 14.0, [`crate::materialize`]),
//! each re-validating its precondition inside the commit transaction (2.2:
//! a create's path still free, a move's source unchanged and destination
//! free, a delete's document still live at its revision, a set-meta's triple
//! and bytes). Each has a dry run
//! (`spec/surface` §4, 1.3) behind [`Store::dry_run`]: every check the real
//! operation makes runs, nothing is written or committed, and the result
//! carries the per-file [`Diff`]s the operation would produce.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use omgbase_format::hash::hex;
use omgbase_mutate::{ErrorCode, Expect, MutationError, Op};
use omgbase_properties::{Value as YamlValue, parse_document};
use omgbase_reconcile::Config;
use regex::Regex;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::Store;
use crate::doc_store::DocStore;
use crate::effects::{CommitHead, Effect, Guard, Outcome, doc_base, touched_paths};
use crate::error::Result;
use crate::links::{InboundLink, doc_dir_of, inbound_links_to, retarget_links_in_raw};
use crate::mutate::{ApplyOrigin, ApplyRequest, Diff, Staged, find_doc_by_ref};
use crate::read::blob_text;
use crate::writers::Origin;
use crate::yaml_emit::stringify;

/// What a document operation runs with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocOpContext {
    pub repo_id: String,
    /// `commits.actor` (`NULL` when absent).
    pub actor: Option<String>,
    /// The commit timestamp (RFC 3339 UTC).
    pub ts: String,
}

/// The file changes a dry run would make, keyed by repo-relative path in the
/// order the reference builds them (`spec/surface` §4, 1.3): `before` the
/// current bytes (`""` for a file that would be created), `after` the bytes
/// the operation would leave (`""` for a file that would be removed).
pub type Diffs = Vec<(String, Diff)>;

/// `Diffs` on the wire: `{ "<path>": { "before", "after" } }`.
#[must_use]
pub fn diffs_json(diffs: &[(String, Diff)]) -> Value {
    let mut m = Map::new();
    for (path, d) in diffs {
        m.insert(
            path.clone(),
            json!({ "before": d.before, "after": d.after }),
        );
    }
    Value::Object(m)
}

/// The reference's `Object.assign(diffs, more)`: a path already present keeps
/// its position and takes the new diff; a new path is appended.
fn assign_diffs(diffs: &mut Diffs, more: Diffs) {
    for (path, d) in more {
        if let Some(slot) = diffs.iter_mut().find(|(p, _)| *p == path) {
            slot.1 = d;
        } else {
            diffs.push((path, d));
        }
    }
}

/// `{ doc, path, committed, diffs? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocOpResult {
    pub doc_id: String,
    pub path: String,
    pub committed: bool,
    /// With a dry run, the changes the operation would make (a create: `""`
    /// → the composed file; a delete: the file → `""`; a set-meta: before →
    /// after). `None` on a committed result.
    pub diffs: Option<Diffs>,
}

impl DocOpResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("doc".to_owned(), json!(self.doc_id));
        m.insert("path".to_owned(), json!(self.path));
        m.insert("committed".to_owned(), json!(self.committed));
        if let Some(diffs) = &self.diffs {
            m.insert("diffs".to_owned(), diffs_json(diffs));
        }
        Value::Object(m)
    }
}

/// With `retarget_inbound`: the blocks rewritten and the documents they live in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retargeted {
    pub blocks: Vec<String>,
    pub docs: Vec<String>,
}

/// The result of `docs_move`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocMoveResult {
    pub doc_id: String,
    pub path: String,
    pub committed: bool,
    /// With a dry run: the old path emptied, the new path filled, then any
    /// source the `retarget_inbound` rewrite would touch. `None` when committed.
    pub diffs: Option<Diffs>,
    /// Inbound links still naming the old path after the call (with the
    /// retarget: the frontmatter relations, which are never rewritten).
    pub dangling: Vec<InboundLink>,
    /// `None` when the retarget was opted out or nothing linked in; empty
    /// lists when it ran but only frontmatter relations linked in.
    pub retargeted: Option<Retargeted>,
}

impl DocMoveResult {
    /// `{ doc, path, committed, diffs?, dangling, retargeted }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("doc".to_owned(), json!(self.doc_id));
        m.insert("path".to_owned(), json!(self.path));
        m.insert("committed".to_owned(), json!(self.committed));
        if let Some(diffs) = &self.diffs {
            m.insert("diffs".to_owned(), diffs_json(diffs));
        }
        m.insert(
            "dangling".to_owned(),
            Value::Array(self.dangling.iter().map(InboundLink::to_json).collect()),
        );
        m.insert(
            "retargeted".to_owned(),
            json!(
                self.retargeted
                    .as_ref()
                    .map(|r| json!({ "blocks": r.blocks, "docs": r.docs }))
            ),
        );
        Value::Object(m)
    }
}

/// The `retarget_inbound` plan of a move: one coalesced, CAS-pinned `update`
/// per deepest hit block, the blocks and docs it touches, and the inbound
/// links it leaves dangling. Pure over the store's current blocks — the move
/// itself changes no block — so the real move and its dry run plan identically.
struct RetargetPlan {
    ops: Vec<Op>,
    blocks: Vec<String>,
    docs: Vec<String>,
    dangling: Vec<InboundLink>,
}

/// §6: strip leading `/`s, `\` → `/`.
#[must_use]
pub fn canonical(path: &str) -> String {
    path.trim_start_matches('/').replace('\\', "/")
}

/// §6: the file bytes from a body and optional frontmatter (the body's
/// trailing `\n` ensured; a non-empty mapping serialized by the YAML emitter
/// between fences, a blank line before the body unless it starts with one).
#[must_use]
pub fn compose_file(markdown: &str, frontmatter: Option<&Map<String, Value>>) -> String {
    let body = if markdown.ends_with('\n') || markdown.is_empty() {
        markdown.to_owned()
    } else {
        format!("{markdown}\n")
    };
    let Some(fm) = frontmatter.filter(|m| !m.is_empty()) else {
        return body;
    };
    let yaml = stringify(fm);
    let yaml = yaml.strip_suffix('\n').unwrap_or(&yaml);
    let sep = if body.starts_with('\n') { "" } else { "\n" };
    format!("---\n{yaml}\n---\n{sep}{body}")
}

static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?").expect("regex"));

fn yaml_to_json(v: &YamlValue) -> Value {
    v.to_json()
}

/// §6 `docs_set_meta`: `(frontmatter mapping, body)`; missing or malformed
/// frontmatter → `({}, content)`.
#[must_use]
pub fn split_frontmatter(content: &str) -> (Map<String, Value>, String) {
    let Some(caps) = FRONTMATTER.captures(content) else {
        return (Map::new(), content.to_owned());
    };
    let whole = caps.get(0).expect("match");
    let yaml = caps.get(1).map_or("", |m| m.as_str());
    let fm = match parse_document(yaml) {
        Some(YamlValue::Mapping(m)) => match yaml_to_json(&YamlValue::Mapping(m)) {
            Value::Object(o) => o,
            _ => Map::new(),
        },
        _ => Map::new(),
    };
    (fm, content[whole.end()..].to_owned())
}

/// §6 `docs_set_meta`'s rewrite: `set` merged over the file's frontmatter,
/// `unset` removed, recomposed over the same body.
fn patch_frontmatter(original: &str, set: Option<&Map<String, Value>>, unset: &[String]) -> String {
    let (mut merged, body) = split_frontmatter(original);
    if let Some(set) = set {
        for (k, v) in set {
            merged.insert(k.clone(), v.clone());
        }
    }
    if !unset.is_empty() {
        merged = merged
            .into_iter()
            .filter(|(k, _)| !unset.contains(k))
            .collect();
    }
    compose_file(&body, Some(&merged))
}

fn doc_missing(r: &str) -> crate::error::Error {
    MutationError::new(ErrorCode::DocMissing, format!("no document {r}")).into()
}

fn path_taken(msg: String) -> crate::error::Error {
    MutationError::new(ErrorCode::PathTaken, msg).into()
}

/// The dry-run view of the document operations (`spec/surface` §4, 1.3; the
/// reference's `DocOpContext.dryRun`): the same four calls as on [`Store`],
/// each validating exactly as the real run does (`doc_missing`,
/// `path_taken`, …), writing and committing nothing, and returning
/// `committed: false` with the per-file `diffs`. A create still mints its
/// `d_` id (`apply`'s rule: a dry run consumes the id the real run would
/// take next). Obtained from [`Store::dry_run`].
pub struct DryRun<'s>(&'s mut Store);

impl std::fmt::Debug for DryRun<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DryRun(Store)")
    }
}

impl DryRun<'_> {
    /// `docs_create` without writing: `{ "<path>": { before: "", after: bytes } }`.
    pub fn docs_create(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        path: &str,
        markdown: &str,
        frontmatter: Option<&Map<String, Value>>,
    ) -> Result<DocOpResult> {
        self.0
            .create_doc(ctx, doc_store, path, markdown, frontmatter, true)
    }

    /// `docs_move` without renaming: the old path → `""`, the new path ←
    /// bytes; with `retarget_inbound`, `dangling`/`retargeted` as the real
    /// run would report them and the rewritten sources' diffs.
    pub fn docs_move(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        to_path: &str,
        retarget_inbound: bool,
    ) -> Result<DocMoveResult> {
        self.0
            .move_doc(ctx, doc_store, doc_ref, to_path, retarget_inbound, true)
    }

    /// `docs_delete` without deleting: `{ "<path>": { before: bytes, after: "" } }`.
    pub fn docs_delete(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
    ) -> Result<DocOpResult> {
        self.0.delete_doc(ctx, doc_store, doc_ref, true)
    }

    /// `docs_set_meta` without writing: the file before → after the patch.
    pub fn docs_set_meta(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        set: Option<&Map<String, Value>>,
        unset: &[String],
    ) -> Result<DocOpResult> {
        self.0
            .set_meta_doc(ctx, doc_store, doc_ref, set, unset, true)
    }
}

impl Store {
    /// The document operations as previews: see [`DryRun`].
    pub fn dry_run(&mut self) -> DryRun<'_> {
        DryRun(self)
    }

    fn live_doc_at(&self, repo_id: &str, path: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
                params![repo_id, path],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// §6 `docs_create`: a new document from complete bytes (frontmatter as
    /// a mapping); `path_taken` when a live doc or a file exists; ingested
    /// with the reconciling resolver (`reason: "create <path>"`), the file
    /// written after the commit (14.0).
    pub fn docs_create(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        path: &str,
        markdown: &str,
        frontmatter: Option<&Map<String, Value>>,
    ) -> Result<DocOpResult> {
        self.create_doc(ctx, doc_store, path, markdown, frontmatter, false)
    }

    fn create_doc(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        path: &str,
        markdown: &str,
        frontmatter: Option<&Map<String, Value>>,
        dry_run: bool,
    ) -> Result<DocOpResult> {
        let rel = canonical(path);
        if self.live_doc_at(&ctx.repo_id, &rel)? {
            return Err(path_taken(format!("document already exists at {rel}")));
        }
        let content = compose_file(markdown, frontmatter);
        if doc_store.exists(&rel) {
            return Err(path_taken(format!("file already exists on disk at {rel}")));
        }
        if dry_run {
            let doc_id = self.ids.at(&self.conn).mint("d")?;
            let diffs = vec![(
                rel.clone(),
                Diff {
                    before: String::new(),
                    after: content,
                },
            )];
            return Ok(DocOpResult {
                doc_id,
                path: rel,
                committed: false,
                diffs: Some(diffs),
            });
        }
        let touched = vec![rel.clone()];
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        let reason = format!("create {rel}");
        let head = CommitHead {
            origin: Origin::Api,
            actor: ctx.actor.as_deref(),
            reason: Some(&reason),
            clear_pending: false,
        };
        let c = self
            .reconciling_commit(
                &ctx.repo_id,
                &rel,
                &content,
                &ctx.ts,
                &head,
                &Config::default(),
                Guard::Absent,
            )?
            .committed()?
            .pop()
            .ok_or_else(|| {
                crate::error::Error::Other(format!("create: nothing committed for {rel}"))
            })?;
        // B': the file — written only over nothing or over these very bytes;
        // a foreign file that appeared meanwhile keeps the row (file wins).
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        Ok(DocOpResult {
            doc_id: c.doc_id,
            path: rel,
            committed: true,
            diffs: None,
        })
    }

    /// §6 `docs_move`: rename a document (identity kept) in one `api` commit
    /// (`reason: "move <from> -> <to>"`): open edges from other documents
    /// re-pointed to `phantom:<old path>` (a self edge only when its link
    /// names the path), phantoms at the new path adopted, and — with
    /// `retarget_inbound`, the surface's default since mutate 1.3 — the
    /// dangling links rewritten in the same transaction, one revision per
    /// rewritten source under the move's row (2.1; the moved document's own
    /// revision advances only when it is itself a source). `false` leaves
    /// them as written.
    pub fn docs_move(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        to_path: &str,
        retarget_inbound: bool,
    ) -> Result<DocMoveResult> {
        self.move_doc(ctx, doc_store, doc_ref, to_path, retarget_inbound, false)
    }

    fn move_doc(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        to_path: &str,
        retarget_inbound: bool,
        dry_run: bool,
    ) -> Result<DocMoveResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        let to_rel = canonical(to_path);
        if self.live_doc_at(&ctx.repo_id, &to_rel)? {
            return Err(path_taken(format!("a document already exists at {to_rel}")));
        }
        let inbound = inbound_links_to(&self.conn, &ctx.repo_id, &info.doc_id, &info.path)?;
        if doc_store.exists(&to_rel) {
            return Err(path_taken(format!(
                "file already exists on disk at {to_rel}"
            )));
        }
        if dry_run {
            let content = doc_store.read(&info.path)?.unwrap_or_default();
            let mut diffs: Diffs = vec![
                (
                    info.path.clone(),
                    Diff {
                        before: content.clone(),
                        after: String::new(),
                    },
                ),
                (
                    to_rel.clone(),
                    Diff {
                        before: String::new(),
                        after: content,
                    },
                ),
            ];
            if !retarget_inbound || inbound.is_empty() {
                return Ok(DocMoveResult {
                    doc_id: info.doc_id,
                    path: to_rel,
                    committed: false,
                    diffs: Some(diffs),
                    dangling: inbound,
                    retargeted: None,
                });
            }
            let plan = self.plan_inbound_retarget(&info.doc_id, &info.path, &to_rel, &inbound)?;
            if !plan.ops.is_empty() {
                let req = retarget_request(ctx, plan.ops, true);
                let preview = self.apply(&req, doc_store, &ctx.ts)?;
                assign_diffs(&mut diffs, preview.diffs.unwrap_or_default());
            }
            return Ok(DocMoveResult {
                doc_id: info.doc_id,
                path: to_rel,
                committed: false,
                diffs: Some(diffs),
                dangling: plan.dangling,
                retargeted: Some(Retargeted {
                    blocks: plan.blocks,
                    docs: plan.docs,
                }),
            });
        }
        // One request, one transaction, one commit (2.1): the path change
        // and, with `retarget_inbound`, the rewrite of every dangling source
        // — planned over the current blocks (the move itself changes none),
        // run in memory, committed together under `move <from> -> <to>`
        // with the files it owes recorded, then the files (14.0).
        let plan = if retarget_inbound && !inbound.is_empty() {
            Some(self.plan_inbound_retarget(&info.doc_id, &info.path, &to_rel, &inbound)?)
        } else {
            None
        };
        let loaded = match &plan {
            Some(p) if !p.ops.is_empty() => {
                let req = retarget_request(ctx, p.ops.clone(), false);
                self.apply_ops(&req)?.loaded
            }
            _ => Vec::new(),
        };
        // (a) Land any row an earlier request left at a touched path, then
        //     read every source where it was loaded — the moved document,
        //     when it links to itself, under its OLD path, where its file
        //     still is; the transaction compares the bytes with each row.
        let mut touched = vec![info.path.clone(), to_rel.clone()];
        touched.extend(loaded.iter().map(|d| d.doc.path.clone()));
        touched.dedup();
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        let on_disk = crate::mutate::read_on_disk(&loaded, doc_store)?;
        // The moved document was loaded under its old path: its rendered
        // bytes go to, and its ingest names, the new one.
        let staged = crate::mutate::stage(&loaded, on_disk, |d| {
            if d.doc.doc_id == info.doc_id {
                to_rel.clone()
            } else {
                d.doc.path.clone()
            }
        });
        // (b) The transaction: the row changes first, so each source's edges
        //     resolve `[x](<to>)` to the document, then the sources; the
        //     intent recorded is a `rename` at `to` (carrying the revision the
        //     moved document holds after the request) plus a `write` per
        //     other source.
        let reason = format!("move {} -> {to_rel}", info.path);
        let head = CommitHead {
            origin: Origin::Api,
            actor: ctx.actor.as_deref(),
            reason: Some(&reason),
            clear_pending: false,
        };
        let mut effects = vec![Effect::MovePath {
            doc_id: info.doc_id.clone(),
            from: info.path.clone(),
            to: to_rel.clone(),
            current_rev: info.current_rev.clone(),
            inbound: inbound.clone(),
        }];
        effects.extend(staged.into_iter().map(Staged::into_effect));
        match self.commit_effects(&ctx.repo_id, &head, &effects, &ctx.ts)? {
            Outcome::Committed(_) => {}
            Outcome::Conflict(c) => {
                return Err(self.disk_conflict(&ctx.repo_id, &c.path, &c.bytes, &ctx.ts));
            }
        }
        // (c) Files: the rename (or the revision's bytes written at `to`
        //     when the old file is gone or the rename fails), then every
        //     rewritten source.
        self.materialize_paths(&ctx.repo_id, &touched_paths(&effects), doc_store)?;
        let (dangling, retargeted) = match plan {
            Some(p) => (
                p.dangling,
                Some(Retargeted {
                    blocks: p.blocks,
                    docs: p.docs,
                }),
            ),
            None => (inbound, None),
        };
        Ok(DocMoveResult {
            doc_id: info.doc_id,
            path: to_rel,
            committed: true,
            diffs: None,
            dangling,
            retargeted,
        })
    }

    /// The `retarget_inbound` plan of a move `from_path → to_rel` over the
    /// store's current blocks: deepest hit block per inbound link (a
    /// container whose raw includes a hit child's raw is covered by the
    /// child), each rewritten against the source's *current* directory.
    fn plan_inbound_retarget(
        &self,
        doc_id: &str,
        from_path: &str,
        to_rel: &str,
        inbound: &[InboundLink],
    ) -> Result<RetargetPlan> {
        let mut by_block_order: Vec<String> = Vec::new();
        let mut by_block: HashMap<String, &InboundLink> = HashMap::new();
        for l in inbound {
            if let Some(b) = &l.block {
                if !by_block.contains_key(b) {
                    by_block_order.push(b.clone());
                    by_block.insert(b.clone(), l);
                }
            }
        }
        let parent_of = |id: &str| -> Result<Option<String>> {
            Ok(self
                .conn
                .query_row(
                    "SELECT parent_block FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                    params![id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten())
        };
        let mut containers: BTreeSet<String> = BTreeSet::new();
        for block_id in &by_block_order {
            let mut cur = Some(block_id.clone());
            while let Some(c) = cur {
                cur = parent_of(&c)?;
                if let Some(p) = &cur {
                    if by_block.contains_key(p) {
                        containers.insert(p.clone());
                    }
                }
            }
        }
        let mut ops: Vec<Op> = Vec::new();
        let mut blocks: Vec<String> = Vec::new();
        let mut docs: Vec<String> = Vec::new();
        for block_id in &by_block_order {
            if containers.contains(block_id) {
                continue;
            }
            let src = by_block[block_id];
            let row: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                    params![block_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw_hash) = row else {
                continue;
            };
            let raw = blob_text(&self.conn, &raw_hash)?;
            // Match against the directory the link was RESOLVED in (the
            // source's path at extraction time); write relative forms against
            // the source's CURRENT directory — they differ only for links
            // inside the moved doc itself.
            let write_dir = if src.doc == doc_id {
                doc_dir_of(to_rel)
            } else {
                doc_dir_of(&src.path)
            };
            let Some(new_raw) =
                retarget_links_in_raw(&raw, doc_dir_of(&src.path), write_dir, from_path, to_rel)
            else {
                continue;
            };
            ops.push(Op::Update {
                block: block_id.clone(),
                markdown: Some(new_raw),
                attrs: None,
                expect: Some(Expect::content(hex(&raw_hash))),
                trivia: None,
                child_ids: None,
            });
            blocks.push(block_id.clone());
            if !docs.contains(&src.doc) {
                docs.push(src.doc.clone());
            }
        }
        // Containers whose rewritten child covered them count as rewritten too.
        let rewritten: BTreeSet<&str> = blocks
            .iter()
            .map(String::as_str)
            .chain(containers.iter().map(String::as_str))
            .collect();
        let dangling = inbound
            .iter()
            .filter(|l| l.block.as_deref().is_none_or(|b| !rewritten.contains(b)))
            .cloned()
            .collect();
        Ok(RetargetPlan {
            ops,
            blocks,
            docs,
            dangling,
        })
    }

    /// §6 `docs_delete`: one transaction — an `api` commit
    /// (`reason: "delete <path>"`), FTS rows dropped, live blocks and the doc
    /// tombstoned, nothing pooled, a `remove` intent recorded — then the
    /// file unlinked, only if it still holds what the last revision rendered
    /// (14.0: a foreign file is left for the sweep).
    pub fn docs_delete(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
    ) -> Result<DocOpResult> {
        self.delete_doc(ctx, doc_store, doc_ref, false)
    }

    fn delete_doc(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        dry_run: bool,
    ) -> Result<DocOpResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        if dry_run {
            let before = doc_store.read(&info.path)?.unwrap_or_default();
            let diffs = vec![(
                info.path.clone(),
                Diff {
                    before,
                    after: String::new(),
                },
            )];
            return Ok(DocOpResult {
                doc_id: info.doc_id,
                path: info.path,
                committed: false,
                diffs: Some(diffs),
            });
        }
        let touched = vec![info.path.clone()];
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        let reason = format!("delete {}", info.path);
        let head = CommitHead {
            origin: Origin::Api,
            actor: ctx.actor.as_deref(),
            reason: Some(&reason),
            clear_pending: false,
        };
        self.commit_effects(
            &ctx.repo_id,
            &head,
            &[Effect::Tombstone {
                doc_id: info.doc_id.clone(),
                path: info.path.clone(),
                pool: false,
                current_rev: info.current_rev.clone(),
            }],
            &ctx.ts,
        )?
        .committed()?;
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        Ok(DocOpResult {
            doc_id: info.doc_id,
            path: info.path,
            committed: true,
            diffs: None,
        })
    }

    /// §6 `docs_set_meta`: read the file, split the frontmatter, merge `set`,
    /// delete `unset`, compose, ingest with the reconciling resolver
    /// (`reason: "set_meta <path>"`), write after the commit (14.0). The
    /// file read must hash to the document's `file_hash` — compared inside
    /// the transaction with the triple (2.2: a dirty file is ingested
    /// `observed` and the operation fails `sync_conflict`, as a changeset's
    /// does).
    pub fn docs_set_meta(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        set: Option<&Map<String, Value>>,
        unset: &[String],
    ) -> Result<DocOpResult> {
        self.set_meta_doc(ctx, doc_store, doc_ref, set, unset, false)
    }

    fn set_meta_doc(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        set: Option<&Map<String, Value>>,
        unset: &[String],
        dry_run: bool,
    ) -> Result<DocOpResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        let base = doc_base(&self.conn, &info.doc_id)?.ok_or_else(|| doc_missing(doc_ref))?;
        let touched = vec![info.path.clone()];
        if !dry_run {
            self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        }
        let on_disk = doc_store.read(&info.path)?;
        let original = on_disk.clone().unwrap_or_default();
        let content = patch_frontmatter(&original, set, unset);
        if dry_run {
            let diffs = vec![(
                info.path.clone(),
                Diff {
                    before: original,
                    after: content,
                },
            )];
            return Ok(DocOpResult {
                doc_id: info.doc_id,
                path: info.path,
                committed: false,
                diffs: Some(diffs),
            });
        }
        let reason = format!("set_meta {}", info.path);
        let head = CommitHead {
            origin: Origin::Api,
            actor: ctx.actor.as_deref(),
            reason: Some(&reason),
            clear_pending: false,
        };
        let c = match self.reconciling_commit(
            &ctx.repo_id,
            &info.path,
            &content,
            &ctx.ts,
            &head,
            &Config::default(),
            Guard::Doc { base, on_disk },
        )? {
            Outcome::Committed(mut c) => c.pop().ok_or_else(|| {
                crate::error::Error::Other(format!("set_meta: nothing committed for {}", info.path))
            })?,
            Outcome::Conflict(c) => {
                return Err(self.disk_conflict(&ctx.repo_id, &c.path, &c.bytes, &ctx.ts));
            }
        };
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        Ok(DocOpResult {
            doc_id: c.doc_id,
            path: info.path,
            committed: true,
            diffs: None,
        })
    }
}

/// The `retarget_inbound` rewrite of a move as a changeset request — run in
/// memory only (2.1: its documents commit under the move's own row, so the
/// origin here reaches no commit; the dry run previews it as `apply` would).
fn retarget_request(ctx: &DocOpContext, ops: Vec<Op>, dry_run: bool) -> ApplyRequest {
    ApplyRequest {
        repo_id: ctx.repo_id.clone(),
        ops,
        origin: ApplyOrigin {
            actor: ctx.actor.clone().unwrap_or_else(|| "api".to_owned()),
            reason: None,
        },
        dry_run,
        set_frontmatter: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composes_files_with_and_without_frontmatter() {
        assert_eq!(compose_file("# New\n\nHello.", None), "# New\n\nHello.\n");
        assert_eq!(compose_file("", None), "");
        let empty = Map::new();
        assert_eq!(compose_file("Body only.\n", Some(&empty)), "Body only.\n");
        let fm: Map<String, Value> =
            serde_json::from_str(r#"{"title":"Hi","count":2,"draft":true,"tags":["a","b"]}"#)
                .unwrap();
        assert_eq!(
            compose_file("# New\n", Some(&fm)),
            "---\ntitle: Hi\ncount: 2\ndraft: true\ntags:\n  - a\n  - b\n---\n\n# New\n"
        );
        assert!(compose_file("\n# B\n", Some(&fm)).ends_with("---\n\n# B\n"));
    }

    #[test]
    fn splits_frontmatter_like_the_reference_regex() {
        let (fm, body) =
            split_frontmatter("---\ntitle: Hello\ntags:\n  - x\n---\n\n# Body\n\nText.\n");
        assert_eq!(fm["title"], json!("Hello"));
        assert_eq!(fm["tags"], json!(["x"]));
        assert_eq!(body, "\n# Body\n\nText.\n");
        let (fm, body) = split_frontmatter("# No fm\n");
        assert!(fm.is_empty());
        assert_eq!(body, "# No fm\n");
        let (fm, body) = split_frontmatter("---\n- not a map\n---\nbody");
        assert!(fm.is_empty());
        assert_eq!(body, "body");
        let (_, body) = split_frontmatter("---\r\na: 1\r\n---\r\nbody");
        assert_eq!(body, "body");
    }

    #[test]
    fn canonical_paths() {
        assert_eq!(canonical("/dir\\sub\\x.md"), "dir/sub/x.md");
        assert_eq!(canonical("//a.md"), "a.md");
        assert_eq!(canonical("a.md"), "a.md");
    }

    #[test]
    fn diffs_assign_like_object_assign_and_render_in_order() {
        let d = |b: &str, a: &str| Diff {
            before: b.to_owned(),
            after: a.to_owned(),
        };
        let mut diffs: Diffs = vec![
            ("b.md".to_owned(), d("x", "")),
            ("n/b.md".to_owned(), d("", "x")),
        ];
        assign_diffs(
            &mut diffs,
            vec![
                ("a.md".to_owned(), d("[b](b.md)", "[b](n/b.md)")),
                ("b.md".to_owned(), d("x", "y")),
            ],
        );
        let keys: Vec<&str> = diffs.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(keys, ["b.md", "n/b.md", "a.md"]);
        assert_eq!(diffs[0].1, d("x", "y"));
        assert_eq!(
            serde_json::to_string(&diffs_json(&diffs)).unwrap(),
            r#"{"b.md":{"before":"x","after":"y"},"n/b.md":{"before":"","after":"x"},"a.md":{"before":"[b](b.md)","after":"[b](n/b.md)"}}"#
        );
    }

    #[test]
    fn set_meta_patch_merges_sets_and_drops_unsets() {
        let set: Map<String, Value> = serde_json::from_str(r#"{"status":"done","n":2}"#).unwrap();
        let out = patch_frontmatter(
            "---\ntitle: T\nstatus: open\nold: 1\n---\n\n# Body\n",
            Some(&set),
            &["old".to_owned()],
        );
        assert_eq!(out, "---\ntitle: T\nstatus: done\nn: 2\n---\n\n# Body\n");
        assert_eq!(patch_frontmatter("# Plain\n", None, &[]), "# Plain\n");
    }
}
