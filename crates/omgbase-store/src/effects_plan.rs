//! The effect planner and executor (`spec/mutate/README.md` §11, mutate 3.0;
//! ADR-021): the public effects of [`omgbase_mutate::effects`] resolved
//! against this store, classified for conflicts, lowered **in order** to the
//! kernel ops, file heads and document operations the existing executor
//! already runs ([`crate::effects`]), and frozen as a [`Plan`] whose identity
//! is the digest of its executable core. The reference is
//! `packages/core/src/mutate/{effects,plan}.ts`; every rule here mirrors it.
//!
//! **`plan`** ([`Store::plan_effects`]) lowers under the **symbolic**
//! minter ([`Capture::Symbolic`]: every `b`/`d` mint returns the next
//! `$new.<n>`, nothing is issued), so a plan burns no id and — the kernel
//! being id-agnostic for rendering — its preview is exact. A `$new.<n>` a
//! later effect names is lowered to the kernel placeholder `$k.ids[i]` of the
//! op that minted it; a `create` (3.0) is its composed file parsed into a
//! loaded tree — the document symbol, then one block symbol per block in
//! pre-order — so later effects address the new document and its blocks like
//! any other (the ops carry those block symbols as they are). `set
//! document.content` runs the §7 whole-document planner and surfaces its
//! decision as `preview.identity[doc]`; a `retarget` surfaces its hits as
//! `preview.retarget[]`.
//!
//! **`execute`** ([`Store::execute_plan`], the plan form) admits the plan
//! (version, shape, digest), pre-checks its `preconditions.docs` triples and
//! `absent_paths`, then **replays the opset** under the **recording** minter
//! ([`Capture::Record`]): the heads, then the kernel ops in order with every
//! created document re-adopted at its `before_op` (parsed again, so the i-th
//! `b` minted IS the i-th block symbol — the alias its symbols in the ops
//! resolve through), the moves with their inbound edges read now, the
//! tombstones — committed as one transaction (a created document as a
//! known-id ingest under the `Absent` guard; its `d` minted by the ingest)
//! with `commits.ops = canonical({ v: 1, plan_id, effects, selection? })`.
//! The receipt zips the plan's symbols onto the ids the replay minted, per
//! kind. The digest form ([`Store::execute_by_digest`]) re-plans and commits
//! on digest equality; [`Store::apply_effects`] is plan + execute in one call.
//!
//! **Selectors** (§11.8, mutate 3.1) never reach this crate as a query: the
//! store has no OQX. The surface (`omgbase-surface::select`) runs the
//! selector, expands hits × templates into the concrete effect list and
//! hands it to [`Store::plan_selected`] together with the frozen
//! [`Selection`] record, which the plan digests as its seventh core member
//! and the commit stores in the intent record. The digest form with a
//! selector re-plans through a callback the surface supplies
//! ([`Store::execute_replanned`]); so does the one-shot apply
//! ([`Store::apply_planned`]). An empty expansion (zero hits) is a legal
//! plan here: nothing to commit, `commit: null` on execute.

use std::collections::{BTreeMap, HashMap, HashSet};

use omgbase_format::hash::{hex, sha256};
use omgbase_format::{FORMAT_MARKDOWN, format_for_path};
use omgbase_mutate::effects::{
    self as fx, BlockPrecondition, ConflictTracker, DocPrecondition, Field, FocusInfo, FocusTarget,
    IdentityOp, IdentityPreview, NewId, NewIdKind, PLAN_VERSION, PLANNER_V, ParentPrecondition,
    Plan, PlanCreate, PlanFrontmatter, PlanMove, PlanOpset, PlanPreview, PlanRevision,
    PlanTombstone, Preconditions, RetargetHitPreview, RetargetPairPreview, RetargetPreview,
    ScalarWrite, Selection, Target,
};
use omgbase_mutate::frontmatter_parts::{
    FrontmatterPart, join_frontmatter_parts, lead_of, line_ending_of, split_frontmatter_raw,
    split_frontmatter_trivia,
};
use omgbase_mutate::{
    At, Effect, ErrorCode, Expect, MutBlock, MutDoc, MutationError, Op, Parent, SummaryLookup, To,
    parse_document, render, render_block, summarize_effect, visible_text_of,
};
use omgbase_reconcile::Config;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::Store;
use crate::doc_store::DocStore;
use crate::docs_ops::{canonical, compose_file, split_frontmatter};
use crate::effects::{CommitHead, DocBase, Effect as Commit, Outcome, doc_base, touched_paths};
use crate::error::{Error, Result};
use crate::links::inbound_links_to;
use crate::macros::LinkRepair;
use crate::mint::Capture;
use crate::mutate::{
    ApplyOrigin, OpsRunner, Revision, Staged, find_doc_by_ref, read_on_disk, stage,
};
use crate::retention::reference_path;
use crate::writers::Origin;
use crate::yaml_emit::stringify;

/// What a plan is computed and executed against.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanContext {
    pub repo_id: String,
    /// The commit timestamp (RFC 3339 UTC); also the pool horizon a
    /// `create`'s reconcile sees at execute.
    pub ts: String,
    pub config: Config,
}

/// §11.7 `Receipt`: `{ plan_id, commit, revisions, new_ids, committed: true,
/// summary }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub plan_id: String,
    /// The one `commits` row; `None` when the plan had nothing to commit.
    pub commit: Option<String>,
    /// One per ingest, in effect order (a create's `id` is the document minted).
    pub revisions: Vec<Revision>,
    /// `$new.<n>` → the id the replay minted for it.
    pub new_ids: Vec<(String, String)>,
    /// The plan's `preview.summary` (3.3): what was committed, in words —
    /// the confirmation text.
    pub summary: Vec<String>,
}

impl Receipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut new_ids = Map::new();
        for (symbol, id) in &self.new_ids {
            new_ids.insert(symbol.clone(), json!(id));
        }
        json!({
            "plan_id": self.plan_id,
            "commit": self.commit,
            "revisions": self.revisions.iter().map(|r| json!({ "_id": r.doc, "_path": r.path, "_hash": r.hash })).collect::<Vec<_>>(),
            "new_ids": new_ids,
            "committed": true,
            "summary": self.summary,
        })
    }
}

/// What `apply({ effects })` returns: the plan on a dry run, else the receipt.
#[derive(Clone, Debug, PartialEq)]
pub enum EffectsOutcome {
    Plan(Box<Plan>),
    Receipt(Receipt),
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::InvalidEffect(msg.into())
}

fn merr(code: ErrorCode, msg: impl Into<String>, data: Value) -> Error {
    MutationError::with_data(code, msg, data).into()
}

/// The frontmatter effects are Markdown's (`spec/properties` §3.4, 1.2;
/// `spec/surface` Decisions 2026-10-17): a `yaml`/`json` document's
/// "frontmatter" IS its whole top-level mapping, and the entry patch would
/// fence it with `---` lines — a second YAML document, or invalid JSON. Until
/// the effect learns those formats the request is refused outright —
/// `type_mismatch`, the target's kind does not admit the op — and the mapping
/// is edited with `set content` (the whole file). `data { doc?, _path, _format,
/// field }`: `doc` only for a stored document (a `create`'s `$new` symbol has
/// none); no `fix` (the correction is a different tool, not a corrected call).
fn frontmatter_not_markdown(path: &str, format: &str, field: &str, doc_id: Option<&str>) -> Error {
    let path = reference_path(path);
    let mut data = Map::new();
    if let Some(doc) = doc_id {
        data.insert("doc".to_owned(), json!(doc));
    }
    data.insert("_path".to_owned(), json!(path));
    data.insert("_format".to_owned(), json!(format));
    data.insert("field".to_owned(), json!(field));
    merr(
        ErrorCode::TypeMismatch,
        format!(
            "frontmatter effects apply to markdown documents; {path} is a {format} document — its top-level mapping is edited with `set content` (the whole file) until frontmatter effects learn yaml and json"
        ),
        Value::Object(data),
    )
}

fn doc_missing(r: &str) -> Error {
    merr(
        ErrorCode::DocMissing,
        format!("doc {r} not found"),
        json!({ "doc": r }),
    )
}

fn path_taken(msg: String, path: &str) -> Error {
    merr(ErrorCode::PathTaken, msg, json!({ "path": path }))
}

/// `target_missing { symbol }`: a `$new.<n>` document the plan creates
/// cannot be moved or removed in the same plan.
fn symbol_target_missing(symbol: &str, what: &str) -> Error {
    merr(
        ErrorCode::TargetMissing,
        format!("{symbol} is a document this plan creates; {what}"),
        json!({ "symbol": symbol }),
    )
}

// ---- the lowering context (§11.3) ---------------------------------------------------------

/// A `create` as the plan carries it (`opset.creates[]`, 3.0): its document
/// symbol, path, composed file, and the index of the first kernel op planned
/// after it — where the replay adopts it again.
struct CreateDraft {
    symbol: String,
    path: String,
    source: String,
    before_op: usize,
}

struct MoveDraft {
    id: String,
    from: String,
    to: String,
}

struct TombstoneDraft {
    id: String,
    path: String,
}

struct Planning<'a> {
    ctx: &'a PlanContext,
    doc_store: &'a dyn DocStore,
    runner: OpsRunner,
    /// `$new.n` (a block) → the kernel placeholder `$k.ids[j]` that names it.
    block_symbols: HashMap<String, String>,
    creates: Vec<CreateDraft>,
    moves: Vec<MoveDraft>,
    tombstones: Vec<TombstoneDraft>,
    /// Doc id → the file head (`set_frontmatter[].raw`), last write per document.
    heads: Vec<(String, String)>,
    /// The kernel ops pushed, in order (`opset.ops`).
    ops: Vec<Op>,
    /// `preconditions.blocks`: every pinned content hash, first-pin order.
    pins: Vec<(String, String)>,
    parents: Vec<ParentPrecondition>,
    absent_paths: Vec<String>,
    /// Documents a `move`/`remove` addressed, in effect order (after the
    /// loaded ones in `preconditions.docs`).
    doc_bases: Vec<DocBase>,
    tracker: ConflictTracker,
    /// The resolved effects kept (dropped duplicates excluded).
    resolved: Vec<Effect>,
    /// `preview.identity`: per `set document.content`, what the §7 planner
    /// decided (3.0).
    identity: Vec<(String, IdentityPreview)>,
    /// `preview.retarget`: per `retarget` effect, its hits and pairs (3.0).
    retarget: Vec<RetargetPreview>,
    /// `preview.summary`: one line per resolved effect (3.3).
    summary: Vec<String>,
    /// Doc id → `(links, documents)` its `move` rewrote (`retarget_inbound`
    /// over at least one inbound link), for the summary.
    move_retargets: Vec<(String, (usize, usize))>,
}

/// What the summary words read (`omgbase_mutate::summary`, 3.3): the live
/// row first — a block as it was before the plan — then the planner's trees
/// (a `$new.k` of a created document), a created document's path by its
/// symbol.
struct Lookup<'a> {
    store: &'a Store,
    p: &'a Planning<'a>,
    /// The `insert` effect being summarized: the ids its op reported.
    inserted: Option<usize>,
    /// The `retarget` effect being summarized: `(hits, documents)`.
    retarget: Option<(usize, usize)>,
}

impl Lookup<'_> {
    fn live_block(&self, id: &str) -> Option<(String, String, String)> {
        if fx::parse_new_symbol(id).is_some() {
            return None;
        }
        self.store
            .conn
            .query_row(
                "SELECT type, text, doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten()
    }
}

impl SummaryLookup for Lookup<'_> {
    fn block_descriptor(&self, id: &str) -> Option<(String, String)> {
        if let Some((kind, text, _)) = self.live_block(id) {
            return Some((kind, text));
        }
        let (_, b) = self.p.runner.locate_loaded(id)?;
        Some((b.kind.clone(), visible_text_of(&b.raw, &b.kind)))
    }

    fn block_doc(&self, id: &str) -> Option<String> {
        if let Some((_, _, doc)) = self.live_block(id) {
            return Some(doc);
        }
        self.p
            .runner
            .locate_loaded(id)
            .map(|(d, _)| d.doc.doc_id.clone())
    }

    fn doc_path(&self, doc_id: &str) -> Option<String> {
        if fx::parse_new_symbol(doc_id).is_some() {
            return self
                .p
                .creates
                .iter()
                .find(|c| c.symbol == doc_id)
                .map(|c| c.path.clone());
        }
        doc_base(&self.store.conn, doc_id)
            .ok()
            .flatten()
            .map(|b| b.path)
    }

    fn node_doc(&self, node_id: &str) -> Option<String> {
        self.store.node_block(node_id).ok().map(|(doc, _)| doc)
    }

    fn inserted(&self) -> Option<usize> {
        self.inserted
    }

    fn move_retarget(&self, doc_id: &str) -> Option<(usize, usize)> {
        self.p
            .move_retargets
            .iter()
            .find(|(d, _)| d == doc_id)
            .map(|(_, counts)| *counts)
    }

    fn retarget_hits(&self) -> Option<(usize, usize)> {
        self.retarget
    }
}

/// The live row of a block as the planner needs it.
struct BlockInfo {
    doc_id: String,
    /// Lower-case hex of the raw hash (the loaded tree's for a loaded block).
    hash: String,
}

fn set_head(p: &mut Planning<'_>, doc_id: &str, head: String) {
    match p.heads.iter_mut().find(|(d, _)| d == doc_id) {
        Some(slot) => slot.1 = head,
        None => p.heads.push((doc_id.to_owned(), head)),
    }
}

impl Store {
    // ---- resolution ------------------------------------------------------------------------

    /// The kind of a `$new.n` the plan allocated so far (`None`: not created).
    fn symbol_kind(&self, symbol: &str) -> Option<NewIdKind> {
        let n = fx::parse_new_symbol(symbol)?;
        self.ids.captured_kinds().get(n).map(|k| {
            if *k == "block" {
                NewIdKind::Block
            } else {
                NewIdKind::Document
            }
        })
    }

    fn symbol_missing(&self, symbol: &str, wanted: &str) -> Error {
        fx::symbol_missing(symbol, self.symbol_kind(symbol), wanted).into()
    }

    fn doc_repo(&self, doc_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT repo_id FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// A document target → `{ _id, _path }` of a live document, or the create
    /// it names by symbol (`$new.n`).
    fn resolve_document_target(&self, p: &Planning<'_>, t: &Target) -> Result<Target> {
        let Target::Document { id, path } = t else {
            return Err(invalid(format!(
                "expected a document target, got {}",
                t.kind()
            )));
        };
        let disagree = || {
            invalid(format!(
                "`_id` {} and `_path` {} name different documents",
                Value::String(id.clone().unwrap_or_default()),
                Value::String(path.clone().unwrap_or_default())
            ))
        };
        if let Some(sym) = id
            .as_deref()
            .filter(|id| fx::parse_new_symbol(id).is_some())
        {
            let Some(draft) = p.creates.iter().find(|c| c.symbol == sym) else {
                return Err(self.symbol_missing(sym, "document"));
            };
            if path
                .as_deref()
                .is_some_and(|pth| canonical(pth) != draft.path)
            {
                return Err(disagree());
            }
            return Ok(Target::Document {
                id: Some(sym.to_owned()),
                path: Some(draft.path.clone()),
            });
        }
        let by_id = match id {
            Some(id) => {
                let found = doc_base(&self.conn, id)?.filter(|_| {
                    self.doc_repo(id).ok().flatten().as_deref() == Some(&p.ctx.repo_id)
                });
                Some(found.ok_or_else(|| doc_missing(id))?)
            }
            None => None,
        };
        let by_path = match path {
            Some(pth) => {
                let info = find_doc_by_ref(&self.conn, &p.ctx.repo_id, &canonical(pth))?
                    .ok_or_else(|| doc_missing(pth))?;
                Some(doc_base(&self.conn, &info.doc_id)?.ok_or_else(|| doc_missing(pth))?)
            }
            None => None,
        };
        if let (Some(a), Some(b)) = (&by_id, &by_path)
            && a.doc_id != b.doc_id
        {
            return Err(disagree());
        }
        let base = by_id.or(by_path).expect("id or path is given");
        Ok(Target::Document {
            id: Some(base.doc_id),
            path: Some(base.path),
        })
    }

    /// Resolve one validated effect's targets (§11.4): documents to
    /// `{ id, path }`, defaults made explicit, paths canonicalized.
    fn resolve_effect(&self, p: &Planning<'_>, e: &Effect) -> Result<Effect> {
        let target = |t: &Target| -> Result<Target> {
            match t {
                Target::Document { .. } => self.resolve_document_target(p, t),
                other => Ok(other.clone()),
            }
        };
        Ok(match e {
            Effect::Create {
                path,
                markdown,
                frontmatter,
            } => Effect::Create {
                path: canonical(path),
                markdown: markdown.clone(),
                frontmatter: frontmatter.clone(),
            },
            Effect::Insert {
                into,
                at,
                markdown,
                expect,
            } => Effect::Insert {
                into: target(into)?,
                at: at.clone(),
                markdown: markdown.clone(),
                expect: expect.clone(),
            },
            Effect::Set {
                target: t,
                field,
                value,
                expect,
            } => Effect::Set {
                target: target(t)?,
                field: field.clone(),
                value: value.clone(),
                expect: expect.clone(),
            },
            Effect::Unset {
                target: t,
                field,
                expect,
            } => Effect::Unset {
                target: target(t)?,
                field: field.clone(),
                expect: expect.clone(),
            },
            Effect::MoveDocument {
                target: t,
                to,
                retarget_inbound,
            } => Effect::MoveDocument {
                target: target(t)?,
                to: canonical(to),
                retarget_inbound: *retarget_inbound,
            },
            Effect::MoveBlocks {
                targets,
                into,
                at,
                expect,
            } => Effect::MoveBlocks {
                targets: targets.clone(),
                into: target(into)?,
                at: at.clone(),
                expect: expect.clone(),
            },
            Effect::RemoveDocument { target: t } => Effect::RemoveDocument { target: target(t)? },
            Effect::RemoveBlocks { .. } | Effect::Split { .. } | Effect::Retarget { .. } => {
                e.clone()
            }
            Effect::Merge {
                targets,
                separator,
                expect,
            } => Effect::Merge {
                targets: targets.clone(),
                separator: Some(separator.clone().unwrap_or_else(|| " ".to_owned())),
                expect: expect.clone(),
            },
        })
    }

    /// A block id as the kernel must see it: a `$new.n` becomes the
    /// placeholder of the op that minted it.
    fn kernel_block_id(&self, p: &Planning<'_>, id: &str) -> Result<String> {
        if fx::parse_new_symbol(id).is_none() {
            return Ok(id.to_owned());
        }
        p.block_symbols
            .get(id)
            .cloned()
            .ok_or_else(|| self.symbol_missing(id, "block"))
    }

    fn kernel_at(&self, p: &Planning<'_>, at: &At) -> Result<At> {
        Ok(match at {
            At::Start => At::Start,
            At::End => At::End,
            At::Before(id) => At::Before(self.kernel_block_id(p, id)?),
            At::After(id) => At::After(self.kernel_block_id(p, id)?),
        })
    }

    /// The live row of a block: its document and raw hash; a `$new.n` from
    /// the runner's trees.
    fn block_info(&self, p: &Planning<'_>, id: &str) -> Result<BlockInfo> {
        if let Some((d, b)) = p.runner.locate_loaded(id) {
            return Ok(BlockInfo {
                doc_id: d.doc.doc_id.clone(),
                hash: omgbase_mutate::raw_hash_hex(&b.raw),
            });
        }
        if fx::parse_new_symbol(id).is_some() {
            return Err(self.symbol_missing(id, "block"));
        }
        let row: Option<(String, Vec<u8>)> = self
            .conn
            .query_row(
                "SELECT doc_id, raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, hash)) = row else {
            return Err(merr(
                ErrorCode::BlockMissing,
                format!("block {id} not found"),
                json!({ "block": id }),
            ));
        };
        Ok(BlockInfo {
            doc_id,
            hash: hex(&hash),
        })
    }

    /// Every descendant id of a block: the runner's tree when loaded, else
    /// the live rows.
    fn descendants_of(&self, p: &Planning<'_>, id: &str) -> Result<Vec<String>> {
        if let Some((_, b)) = p.runner.locate_loaded(id) {
            fn walk(b: &MutBlock, out: &mut Vec<String>) {
                for c in &b.children {
                    out.push(c.id.clone());
                    walk(c, out);
                }
            }
            let mut out = Vec::new();
            walk(b, &mut out);
            return Ok(out);
        }
        if fx::parse_new_symbol(id).is_some() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "WITH RECURSIVE sub(block_id) AS (
               SELECT block_id FROM blocks WHERE parent_block = ?1 AND deleted_commit IS NULL
               UNION ALL
               SELECT b.block_id FROM blocks b JOIN sub ON b.parent_block = sub.block_id WHERE b.deleted_commit IS NULL
             ) SELECT block_id FROM sub",
        )?;
        let it = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
        Ok(it.collect::<std::result::Result<_, _>>()?)
    }

    /// Every live block of a document (`[]` for a `$new.n` document).
    fn all_blocks_of(&self, doc_id: &str) -> Result<Vec<String>> {
        if fx::parse_new_symbol(doc_id).is_some() {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare("SELECT block_id FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL")?;
        let it = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
        Ok(it.collect::<std::result::Result<_, _>>()?)
    }

    /// The document a placement target lives in (`parent_missing` for an
    /// unknown heading/block).
    fn target_doc(&self, p: &Planning<'_>, t: &Target) -> Result<String> {
        match t {
            Target::Document { id, .. } => Ok(id.clone().expect("resolved")),
            Target::Section { heading_id: id } | Target::Block { id } => {
                if let Some((d, _)) = p.runner.locate_loaded(id) {
                    return Ok(d.doc.doc_id.clone());
                }
                if matches!(t, Target::Block { .. }) && fx::parse_new_symbol(id).is_some() {
                    return Err(self.symbol_missing(id, "block"));
                }
                let row: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                        params![id],
                        |r| r.get(0),
                    )
                    .optional()?;
                row.ok_or_else(|| {
                    merr(
                        ErrorCode::ParentMissing,
                        format!("parent {id} not found"),
                        json!({}),
                    )
                })
            }
            Target::Node { id } => Ok(self.node_block(id)?.0),
        }
    }

    /// `(doc_id, block_id)` of a node (`block_missing` / `node_not_editable`).
    fn node_block(&self, node_id: &str) -> Result<(String, String)> {
        let row: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT doc_id, block_id FROM nodes WHERE node_id = ?1",
                params![node_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, block_id)) = row else {
            return Err(merr(
                ErrorCode::BlockMissing,
                format!("node {node_id} not found"),
                json!({}),
            ));
        };
        let Some(block_id) = block_id else {
            return Err(merr(
                ErrorCode::NodeNotEditable,
                format!("node {node_id} is not anchored to a block"),
                json!({}),
            ));
        };
        Ok((doc_id, block_id))
    }

    fn placement(&self, p: &Planning<'_>, into: &Target, at: &At) -> Result<To> {
        let at = self.kernel_at(p, at)?;
        Ok(match into {
            Target::Document { .. } => To {
                parent: Parent::Doc,
                at,
            },
            Target::Section { heading_id } => To {
                parent: Parent::Section {
                    heading: self.kernel_block_id(p, heading_id)?,
                },
                at,
            },
            Target::Block { id } => To {
                parent: Parent::Block(self.kernel_block_id(p, id)?),
                at,
            },
            Target::Node { .. } => return Err(invalid("a node is not a placement target")),
        })
    }

    /// `expect.revision` against the document's current revision (§11.2).
    fn check_revision(&self, doc_id: &str, expect: Option<&fx::EffectExpect>) -> Result<()> {
        let Some(rev) = expect.and_then(|e| e.revision.as_deref()) else {
            return Ok(());
        };
        if fx::parse_new_symbol(doc_id).is_some() {
            return Err(invalid(format!(
                "expect.revision cannot name a document this plan creates ({doc_id})"
            )));
        }
        let base = doc_base(&self.conn, doc_id)?.ok_or_else(|| doc_missing(doc_id))?;
        if base.current_rev.as_deref() != Some(rev) {
            return Err(merr(
                ErrorCode::StalePlan,
                format!(
                    "document {doc_id} is at revision {}, not {rev}; re-plan",
                    base.current_rev.as_deref().unwrap_or("null")
                ),
                json!({
                    "doc": doc_id,
                    "expected_revision": rev,
                    "current": { "revision": base.current_rev, "_hash": base.file_hash.as_deref().map(hex) },
                    "retriable": true,
                }),
            ));
        }
        Ok(())
    }

    /// Pin a block's content hash: the caller's when given, else the live
    /// row's (the sugar tools' rule). `$new.n` blocks are not pinned.
    fn pin(&self, p: &mut Planning<'_>, id: &str, given: Option<&str>) -> Result<String> {
        let hash = match given {
            Some(h) => h.to_owned(),
            None => self.block_info(p, id)?.hash,
        };
        if fx::parse_new_symbol(id).is_none() && !p.pins.iter().any(|(b, _)| b == id) {
            p.pins.push((id.to_owned(), hash.clone()));
        }
        Ok(hash)
    }

    /// Push one kernel op through the runner; any `$new.n` it minted becomes
    /// referenceable through the op's placeholder.
    fn push_op(&mut self, p: &mut Planning<'_>, op: Op) -> Result<()> {
        p.ops.push(op.clone());
        let k = p.runner.results.len();
        let result = p.runner.push(self, &op)?;
        let minted: Vec<(usize, String)> = result
            .ids
            .iter()
            .enumerate()
            .filter(|(_, id)| fx::parse_new_symbol(id).is_some())
            .map(|(j, id)| (j, id.clone()))
            .collect();
        for (j, id) in minted {
            p.block_symbols
                .entry(id)
                .or_insert_with(|| format!("${k}.ids[{j}]"));
        }
        Ok(())
    }

    fn record_parent_pin(
        p: &mut Planning<'_>,
        doc: &str,
        into: &Target,
        expect: Option<&fx::EffectExpect>,
    ) {
        if let Some(h) = expect.and_then(|e| e.parent_children_hash.as_deref()) {
            p.parents.push(ParentPrecondition {
                doc: doc.to_owned(),
                parent: match into {
                    Target::Block { id } => Some(id.clone()),
                    _ => None,
                },
                parent_children_hash: h.to_owned(),
            });
        }
    }

    /// The kernel `expect` of an `insert`/`move`: the destination-parent CAS
    /// alone.
    fn order_expect(expect: Option<&fx::EffectExpect>) -> Option<Expect> {
        expect
            .and_then(|e| e.parent_children_hash.as_ref())
            .map(|h| Expect::order(h.clone()))
    }

    // ---- focus (§11.3) ---------------------------------------------------------------------

    fn blocks_of(&self, p: &Planning<'_>, ids: &[String]) -> Result<Vec<String>> {
        let mut docs: Vec<String> = Vec::new();
        for id in ids {
            let d = self.block_info(p, id)?.doc_id;
            if !docs.contains(&d) {
                docs.push(d);
            }
        }
        Ok(docs)
    }

    /// What a resolved effect addresses and retires, and its scalar key.
    fn focus_of(
        &self,
        p: &Planning<'_>,
        e: &Effect,
        retarget_hits: &[String],
    ) -> Result<FocusInfo> {
        fn into_blocks(into: &Target, at: &At) -> Vec<String> {
            let mut out = match into {
                Target::Block { id } => vec![id.clone()],
                Target::Section { heading_id } => vec![heading_id.clone()],
                _ => Vec::new(),
            };
            out.extend(at.anchor().map(str::to_owned));
            out
        }
        Ok(match e {
            Effect::Create { path, .. } => FocusInfo {
                paths: vec![path.clone()],
                ..Default::default()
            },
            Effect::Insert { into, at, .. } => FocusInfo {
                docs: vec![self.target_doc(p, into)?],
                blocks: into_blocks(into, at),
                ..Default::default()
            },
            Effect::Set {
                target,
                field,
                value,
                ..
            } => self.scalar_focus(p, target, field, Some(value.clone()))?,
            Effect::Unset { target, field, .. } => self.scalar_focus(p, target, field, None)?,
            Effect::MoveBlocks {
                targets, into, at, ..
            } => {
                let mut docs = self.blocks_of(p, targets)?;
                let dst = self.target_doc(p, into)?;
                if !docs.contains(&dst) {
                    docs.push(dst);
                }
                let mut blocks = targets.clone();
                blocks.extend(into_blocks(into, at));
                FocusInfo {
                    docs,
                    blocks,
                    ..Default::default()
                }
            }
            Effect::MoveDocument { target, to, .. } => {
                let Target::Document {
                    id: Some(id),
                    path: Some(path),
                } = target
                else {
                    unreachable!("resolved")
                };
                FocusInfo {
                    scalar: Some(ScalarWrite {
                        key: format!("document:{id}:path"),
                        target: FocusTarget::document(id),
                        field: "_path".into(),
                        value: Some(json!(to)),
                    }),
                    docs: vec![id.clone()],
                    paths: vec![to.clone()],
                    retires_paths: vec![path.clone()],
                    ..Default::default()
                }
            }
            Effect::RemoveBlocks { targets, .. } => {
                let docs = self.blocks_of(p, targets)?;
                let mut retires = Vec::new();
                for id in targets {
                    retires.push(id.clone());
                    retires.extend(self.descendants_of(p, id)?);
                }
                FocusInfo {
                    docs,
                    blocks: targets.clone(),
                    retires_blocks: retires,
                    ..Default::default()
                }
            }
            Effect::RemoveDocument { target } => {
                let id = target.id().expect("resolved").to_owned();
                FocusInfo {
                    docs: vec![id.clone()],
                    retires_docs: vec![id.clone()],
                    retires_blocks: self.all_blocks_of(&id)?,
                    ..Default::default()
                }
            }
            Effect::Split { target, .. } => FocusInfo {
                docs: self.blocks_of(p, std::slice::from_ref(target))?,
                blocks: vec![target.clone()],
                ..Default::default()
            },
            Effect::Merge { targets, .. } => {
                let docs = self.blocks_of(p, targets)?;
                let mut retires = Vec::new();
                for id in targets.iter().skip(1) {
                    retires.push(id.clone());
                    retires.extend(self.descendants_of(p, id)?);
                }
                FocusInfo {
                    docs,
                    blocks: targets.clone(),
                    retires_blocks: retires,
                    ..Default::default()
                }
            }
            Effect::Retarget { .. } => FocusInfo {
                scalars: retarget_hits
                    .iter()
                    .map(|id| ScalarWrite {
                        key: format!("block:{id}:markdown"),
                        target: FocusTarget::block(id),
                        field: "markdown".into(),
                        value: None,
                    })
                    .collect(),
                docs: self.blocks_of(p, retarget_hits)?,
                blocks: retarget_hits.to_vec(),
                ..Default::default()
            },
        })
    }

    /// The scalar focus of a `set`/`unset`.
    fn scalar_focus(
        &self,
        p: &Planning<'_>,
        target: &Target,
        field: &str,
        value: Option<Value>,
    ) -> Result<FocusInfo> {
        match target {
            Target::Document { id: Some(id), .. } => {
                let whole = field == "content";
                Ok(FocusInfo {
                    scalar: Some(ScalarWrite {
                        key: format!("document:{id}:{field}"),
                        target: FocusTarget::document(id),
                        field: field.to_owned(),
                        value,
                    }),
                    docs: vec![id.clone()],
                    whole_doc: whole.then(|| id.clone()),
                    retires_blocks: if whole {
                        self.all_blocks_of(id)?
                    } else {
                        Vec::new()
                    },
                    ..Default::default()
                })
            }
            Target::Block { id } => {
                let doc_id = self.block_info(p, id)?.doc_id;
                Ok(FocusInfo {
                    scalar: Some(ScalarWrite {
                        key: format!("block:{id}:{field}"),
                        target: FocusTarget::block(id),
                        field: field.to_owned(),
                        value,
                    }),
                    docs: vec![doc_id],
                    blocks: vec![id.clone()],
                    retires_blocks: if field == "markdown" {
                        self.descendants_of(p, id)?
                    } else {
                        Vec::new()
                    },
                    ..Default::default()
                })
            }
            Target::Node { id } => {
                let (doc_id, block_id) = self.node_block(id)?;
                Ok(FocusInfo {
                    scalar: Some(ScalarWrite {
                        key: format!("node:{id}:{field}"),
                        target: FocusTarget::node(id),
                        field: field.to_owned(),
                        value,
                    }),
                    docs: vec![doc_id],
                    blocks: vec![block_id],
                    ..Default::default()
                })
            }
            _ => Err(invalid("expected a document, block or node target")),
        }
    }

    // ---- the lowering table (§11.3) --------------------------------------------------------

    fn check_absent(&self, p: &Planning<'_>, path: &str) -> Result<()> {
        if find_doc_by_ref(&self.conn, &p.ctx.repo_id, path)?.is_some() {
            return Err(path_taken(
                format!("document already exists at {path}"),
                path,
            ));
        }
        if p.absent_paths.iter().any(|a| a == path) {
            return Err(path_taken(
                format!("an earlier effect already creates or moves a document to {path}"),
                path,
            ));
        }
        if p.doc_store.exists(path) {
            return Err(path_taken(
                format!("file already exists on disk at {path}"),
                path,
            ));
        }
        Ok(())
    }

    /// The per-block `expect` map of a `remove`/`merge`, every block pinned.
    fn pinned_map(
        &self,
        p: &mut Planning<'_>,
        targets: &[String],
        given: Option<&fx::ExpectMap>,
    ) -> Result<(Vec<String>, BTreeMap<String, Expect>)> {
        let mut map = BTreeMap::new();
        let mut blocks = Vec::new();
        for id in targets {
            let g = given.and_then(|m| m.get(id));
            let hash = self.pin(p, id, g.and_then(|x| x.content_hash.as_deref()))?;
            let mut x = g.cloned().unwrap_or(Expect {
                content_hash: None,
                parent_children_hash: None,
            });
            x.content_hash = Some(hash);
            let kid = self.kernel_block_id(p, id)?;
            map.insert(kid.clone(), x);
            blocks.push(kid);
        }
        Ok((blocks, map))
    }

    fn apply_lowering(
        &mut self,
        p: &mut Planning<'_>,
        e: &Effect,
        retarget_ops: Vec<Op>,
    ) -> Result<()> {
        match e {
            Effect::Create {
                path,
                markdown,
                frontmatter,
            } => {
                // §11.3 (3.0): the composed file, parsed under the current
                // minter — the document symbol first, then one block symbol
                // per block in pre-order — and adopted into the runner, so
                // every later effect addresses its blocks (and, for an
                // `insert`, the document by its symbol) as it addresses a
                // loaded document's. Its block symbols name themselves in
                // the kernel ops (no op minted them); the replay substitutes
                // the ids its own parse mints.
                self.check_absent(p, path)?;
                // `create { frontmatter }` (non-empty) at a `.yaml`/`.json`
                // path is refused (`frontmatter: {}` passes: nothing to fence).
                if frontmatter.as_ref().is_some_and(|m| !m.is_empty()) {
                    let format = format_for_path(path);
                    if format != FORMAT_MARKDOWN {
                        return Err(frontmatter_not_markdown(path, format, "frontmatter", None));
                    }
                }
                let symbol = self.mint("d")?;
                let source = compose_file(markdown, frontmatter.as_ref());
                let doc = self.parse_new_document(&symbol, path, &source)?;
                for id in doc.all_ids() {
                    p.block_symbols.entry(id.clone()).or_insert(id);
                }
                p.runner.adopt_new(doc);
                p.creates.push(CreateDraft {
                    symbol,
                    path: path.clone(),
                    source,
                    before_op: p.ops.len(),
                });
                p.absent_paths.push(path.clone());
            }
            Effect::Insert {
                into,
                at,
                markdown,
                expect,
            } => {
                let doc = self.target_doc(p, into)?;
                self.check_revision(&doc, expect.as_ref())?;
                Self::record_parent_pin(p, &doc, into, expect.as_ref());
                let to = self.placement(p, into, at)?;
                self.push_op(
                    p,
                    Op::Insert {
                        doc: matches!(into, Target::Document { .. }).then(|| doc.clone()),
                        to,
                        markdown: markdown.clone(),
                        expect: Self::order_expect(expect.as_ref()),
                    },
                )?;
            }
            Effect::Set {
                target,
                field,
                value,
                expect,
            } => self.lower_set(p, target, field, Some(value), expect.as_ref())?,
            Effect::Unset {
                target,
                field,
                expect,
            } => self.lower_set(p, target, field, None, expect.as_ref())?,
            Effect::MoveBlocks {
                targets,
                into,
                at,
                expect,
            } => {
                let dst = self.target_doc(p, into)?;
                self.check_revision(&dst, expect.as_ref())?;
                Self::record_parent_pin(p, &dst, into, expect.as_ref());
                let to = self.placement(p, into, at)?;
                let blocks = targets
                    .iter()
                    .map(|id| self.kernel_block_id(p, id))
                    .collect::<Result<Vec<_>>>()?;
                // `doc` names the destination when `into` is a document
                // (§2.3, 3.0): a top-level start/end would otherwise mean the
                // SOURCE document's.
                self.push_op(
                    p,
                    Op::Move {
                        blocks,
                        to,
                        doc: matches!(into, Target::Document { .. }).then(|| dst.clone()),
                        expect: Self::order_expect(expect.as_ref()),
                    },
                )?;
            }
            Effect::MoveDocument {
                target,
                to,
                retarget_inbound,
            } => {
                let Target::Document {
                    id: Some(id),
                    path: Some(from),
                } = target
                else {
                    unreachable!("resolved")
                };
                if fx::parse_new_symbol(id).is_some() {
                    return Err(symbol_target_missing(
                        id,
                        "it cannot be moved in the same plan",
                    ));
                }
                let base = doc_base(&self.conn, id)?.ok_or_else(|| doc_missing(id))?;
                self.check_absent(p, to)?;
                p.absent_paths.push(to.clone());
                if !p.doc_bases.iter().any(|b| b.doc_id == *id) {
                    p.doc_bases.push(base);
                }
                let inbound = inbound_links_to(&self.conn, &p.ctx.repo_id, id, from)?;
                if *retarget_inbound && !inbound.is_empty() {
                    let plan = self.plan_inbound_retarget(id, from, to, &inbound)?;
                    // The summary's counts (3.3): the links rewritten — every
                    // inbound link but the dangling — in how many documents.
                    p.move_retargets.push((
                        id.clone(),
                        (inbound.len() - plan.dangling.len(), plan.docs.len()),
                    ));
                    for op in plan.ops {
                        if let Op::Update { block, expect, .. } = &op {
                            self.pin(
                                p,
                                block,
                                expect.as_ref().and_then(|e| e.content_hash.as_deref()),
                            )?;
                        }
                        self.push_op(p, op)?;
                    }
                }
                p.moves.push(MoveDraft {
                    id: id.clone(),
                    from: from.clone(),
                    to: to.clone(),
                });
            }
            Effect::RemoveDocument { target } => {
                let Target::Document {
                    id: Some(id),
                    path: Some(path),
                } = target
                else {
                    unreachable!("resolved")
                };
                if fx::parse_new_symbol(id).is_some() {
                    return Err(symbol_target_missing(
                        id,
                        "it cannot be removed in the same plan",
                    ));
                }
                let base = doc_base(&self.conn, id)?.ok_or_else(|| doc_missing(id))?;
                if !p.doc_bases.iter().any(|b| b.doc_id == *id) {
                    p.doc_bases.push(base);
                }
                p.tombstones.push(TombstoneDraft {
                    id: id.clone(),
                    path: path.clone(),
                });
            }
            Effect::RemoveBlocks { targets, expect } => {
                let (blocks, map) = self.pinned_map(p, targets, expect.as_ref())?;
                self.push_op(
                    p,
                    Op::Remove {
                        blocks,
                        expect: Some(map),
                    },
                )?;
            }
            Effect::Split { target, at, expect } => {
                let doc_id = self.block_info(p, target)?.doc_id;
                self.check_revision(&doc_id, expect.as_ref())?;
                let hash = self.pin(
                    p,
                    target,
                    expect.as_ref().and_then(|e| e.content_hash.as_deref()),
                )?;
                let block = self.kernel_block_id(p, target)?;
                self.push_op(
                    p,
                    Op::Split {
                        block,
                        at: at.clone(),
                        expect: Some(Expect {
                            content_hash: Some(hash),
                            parent_children_hash: expect
                                .as_ref()
                                .and_then(|e| e.parent_children_hash.clone()),
                        }),
                    },
                )?;
            }
            Effect::Merge {
                targets,
                separator,
                expect,
            } => {
                let (blocks, map) = self.pinned_map(p, targets, expect.as_ref())?;
                self.push_op(
                    p,
                    Op::Merge {
                        blocks,
                        separator: separator.clone(),
                        expect: Some(map),
                    },
                )?;
            }
            Effect::Retarget { .. } => {
                for op in retarget_ops {
                    if let Op::Update { block, expect, .. } = &op {
                        self.pin(
                            p,
                            block,
                            expect.as_ref().and_then(|e| e.content_hash.as_deref()),
                        )?;
                    }
                    self.push_op(p, op)?;
                }
            }
        }
        Ok(())
    }

    /// `set` (`value` given) / `unset` of a field.
    fn lower_set(
        &mut self,
        p: &mut Planning<'_>,
        target: &Target,
        field: &str,
        value: Option<&Value>,
        expect: Option<&fx::EffectExpect>,
    ) -> Result<()> {
        match target {
            Target::Document {
                id: Some(doc_id), ..
            } => {
                self.check_revision(doc_id, expect)?;
                if field == "content" {
                    let Some(Value::String(content)) = value else {
                        return Err(invalid(
                            "`content` takes a string value: the complete proposed document",
                        ));
                    };
                    if fx::parse_new_symbol(doc_id).is_some() {
                        return Err(symbol_target_missing(
                            doc_id,
                            "its content is the create's markdown",
                        ));
                    }
                    return self.lower_content(p, doc_id, content);
                }
                // `_frontmatter.<key>` — on a created document too (3.0): its
                // tree is loaded, the patch is a head like any other — but
                // only on a Markdown document (1.2; `frontmatter_not_markdown`).
                let key = field.strip_prefix("_frontmatter.").expect("validated");
                self.require_markdown_for_frontmatter(p, doc_id, field)?;
                self.patch_frontmatter_key(p, doc_id, key, value)
            }
            Target::Block { id } => {
                let Some(value) = value else {
                    return Err(invalid("`unset` takes a document target"));
                };
                let doc_id = self.block_info(p, id)?.doc_id;
                self.check_revision(&doc_id, expect)?;
                let hash = self.pin(p, id, expect.and_then(|e| e.content_hash.as_deref()))?;
                let kernel_expect = Expect {
                    content_hash: Some(hash),
                    parent_children_hash: expect.and_then(|e| e.parent_children_hash.clone()),
                };
                let block = self.kernel_block_id(p, id)?;
                let op = match fx::classify_field(target, field).map_err(invalid)? {
                    Field::Markdown => {
                        let Some(md) = value.as_str() else {
                            return Err(invalid("`markdown` takes a string value"));
                        };
                        Op::Update {
                            block,
                            markdown: Some(md.to_owned()),
                            attrs: None,
                            expect: Some(kernel_expect),
                            trivia: None,
                            child_ids: None,
                        }
                    }
                    Field::Checked => {
                        let Some(checked) = value.as_bool() else {
                            return Err(invalid("`_attrs.checked` takes a boolean value"));
                        };
                        let mut attrs = Map::new();
                        attrs.insert("checked".to_owned(), json!(checked));
                        Op::Update {
                            block,
                            markdown: None,
                            attrs: Some(attrs),
                            expect: Some(kernel_expect),
                            trivia: None,
                            child_ids: None,
                        }
                    }
                    _ => unreachable!("validated block fields"),
                };
                self.push_op(p, op)
            }
            Target::Node { id } => {
                let Some(value) = value else {
                    return Err(invalid("`unset` takes a document target"));
                };
                let (doc_id, block_id) = self.node_block(id)?;
                self.check_revision(&doc_id, expect)?;
                let text = match value {
                    Value::String(s) => s.clone(),
                    other => fx::canonical_json(other),
                };
                let ops = self.node_set(id, field, &text)?;
                for op in ops {
                    let Op::Update {
                        block,
                        markdown,
                        attrs,
                        expect: op_expect,
                        trivia,
                        child_ids,
                    } = op
                    else {
                        unreachable!("node_set yields updates")
                    };
                    let hash = self.pin(
                        p,
                        &block_id,
                        expect
                            .and_then(|e| e.content_hash.as_deref())
                            .or(op_expect.as_ref().and_then(|e| e.content_hash.as_deref())),
                    )?;
                    let mut x = op_expect.unwrap_or(Expect {
                        content_hash: None,
                        parent_children_hash: None,
                    });
                    x.content_hash = Some(hash);
                    self.push_op(
                        p,
                        Op::Update {
                            block,
                            markdown,
                            attrs,
                            expect: Some(x),
                            trivia,
                            child_ids,
                        },
                    )?;
                }
                Ok(())
            }
            _ => Err(invalid("expected a document, block or node target")),
        }
    }

    /// `spec/mutate` §11.3 `set`/`unset _frontmatter.<key>` (3.6, "Frontmatter
    /// entries"): the frontmatter is edited BY ENTRY. The document's head is
    /// cut into its parts (`split_frontmatter_raw`, the §11.10 split rule): a
    /// `set` replaces the key's part — the lead lines (a comment documenting
    /// the key) kept, the entry's own lines re-rendered as `stringify({ key:
    /// value })` in the fence's line endings — removes any duplicate of the
    /// key, or inserts the new key's part after the last entry (before the
    /// trailing comments and the closing fence); an `unset` removes every
    /// part of the key. Every other part is byte-identical afterwards — a flow
    /// list, a quoted string, a comment the author wrote survive a change to a
    /// different key. When nothing but the fences would remain, the
    /// frontmatter goes and the separator's first line ending with it (the §6
    /// `set_meta` rule: a body that followed a blank line keeps it as leading
    /// trivia). A document WITHOUT frontmatter (or one whose head the fence
    /// rule does not recognise) still composes as `docs_set_meta` did through
    /// 3.5 — `compose_file(body, merged)` — which for a new fence is the same
    /// bytes a one-key part would give.
    /// `set`/`unset _frontmatter.<key>` apply to Markdown documents only
    /// ([`frontmatter_not_markdown`]); the format is the path's, as the
    /// reference's planner reads it off the loaded document.
    fn require_markdown_for_frontmatter(
        &mut self,
        p: &mut Planning<'_>,
        doc_id: &str,
        field: &str,
    ) -> Result<()> {
        let d = p.runner.ensure_doc(self, doc_id)?;
        let path = p.runner.loaded[d].doc.path.clone();
        let format = format_for_path(&path);
        if format == FORMAT_MARKDOWN {
            return Ok(());
        }
        let stored = fx::parse_new_symbol(doc_id).is_none().then_some(doc_id);
        Err(frontmatter_not_markdown(&path, format, field, stored))
    }

    fn patch_frontmatter_key(
        &mut self,
        p: &mut Planning<'_>,
        doc_id: &str,
        key: &str,
        set: Option<&Value>,
    ) -> Result<()> {
        let d = p.runner.ensure_doc(self, doc_id)?;
        let fence = p.runner.loaded[d]
            .doc
            .frontmatter_raw
            .as_deref()
            .and_then(split_frontmatter_trivia);
        let Some(fence) = fence else {
            let (mut merged, body) = split_frontmatter(&render(&p.runner.loaded[d].doc));
            match set {
                Some(v) => {
                    merged.insert(key.to_owned(), v.clone());
                }
                None => {
                    // `shift_remove`, as above: `unset` of a middle key must
                    // not reorder the frontmatter the way `remove` would.
                    merged.shift_remove(key);
                }
            }
            return self.patch_frontmatter(p, doc_id, &merged, &body);
        };
        let mut parts = split_frontmatter_raw(&fence.raw);
        let eol = match line_ending_of(&parts[0].bytes) {
            "" => "\n",
            e => e,
        };
        if let Some(v) = set {
            let mut one = Map::new();
            one.insert(key.to_owned(), v.clone());
            let mut rendered = stringify(&one);
            if !rendered.ends_with('\n') {
                rendered.push('\n');
            }
            if eol != "\n" {
                rendered = rendered.split('\n').collect::<Vec<_>>().join(eol);
            }
            if let Some(at) = parts.iter().position(|q| q.key.as_deref() == Some(key)) {
                parts[at].bytes = format!("{}{rendered}", lead_of(&parts[at]));
                let mut i = 0;
                parts.retain(|q| {
                    let keep = i == at || q.key.as_deref() != Some(key);
                    i += 1;
                    keep
                });
            } else {
                let last = parts.iter().rposition(|q| q.key.is_some());
                let at = last.map_or(parts.len() - 1, |l| l + 1);
                parts.insert(
                    at,
                    FrontmatterPart {
                        key: Some(key.to_owned()),
                        bytes: rendered,
                    },
                );
            }
        } else {
            parts.retain(|q| q.key.as_deref() != Some(key));
        }
        let head = if parts.len() == 2 {
            let t = fence.trivia.as_str();
            t.strip_prefix("\r\n")
                .or_else(|| t.strip_prefix('\n'))
                .unwrap_or(t)
                .to_owned()
        } else {
            format!("{}{}", join_frontmatter_parts(&parts), fence.trivia)
        };
        p.runner.set_head(self, doc_id, &head)?;
        set_head(p, doc_id, head);
        Ok(())
    }

    /// Patch a document WITHOUT frontmatter: compose the whole file as
    /// `docs_set_meta` did (`compose_file(body, merged)`, §6), then set the
    /// file head so the known-id ingest renders exactly those bytes — the
    /// body blocks keep their ids and bytes (a file without a trailing newline
    /// gains one on its last block's trivia).
    fn patch_frontmatter(
        &mut self,
        p: &mut Planning<'_>,
        doc_id: &str,
        merged: &Map<String, Value>,
        body: &str,
    ) -> Result<()> {
        let after = compose_file(body, Some(merged));
        let d = p.runner.ensure_doc(self, doc_id)?;
        let doc = &mut p.runner.loaded[d].doc;
        let mut blocks: String = doc
            .children
            .iter()
            .map(|b| format!("{}{}", render_block(b, 0), b.trivia))
            .collect();
        if !after.ends_with(&blocks) {
            let with_newline = format!("{blocks}\n");
            match doc.children.last_mut() {
                Some(last) if after.ends_with(&with_newline) => {
                    last.trivia.push('\n');
                    blocks = with_newline;
                }
                _ => {
                    return Err(merr(
                        ErrorCode::PlanNotConvergent,
                        format!(
                            "the frontmatter patch of {doc_id} does not preserve the body bytes"
                        ),
                        json!({ "doc": doc_id }),
                    ));
                }
            }
        }
        let head = after[..after.len() - blocks.len()].to_owned();
        p.runner.set_head(self, doc_id, &head)?;
        set_head(p, doc_id, head);
        Ok(())
    }

    /// A `create`'s composed file parsed into the working tree under the
    /// store's current minter (symbolic when planning, recording when
    /// executing): one `b` per block in pre-order.
    fn parse_new_document(&mut self, doc_id: &str, path: &str, source: &str) -> Result<MutDoc> {
        let mut mint = self.ids.at(&self.conn);
        let mut minter = mint.deferred("b");
        let doc = parse_document(doc_id, path, source, &mut minter);
        minter.finish()?;
        Ok(doc)
    }

    /// `set document.content`: the whole-document planner's opset, spliced
    /// in (placeholders shifted), its frontmatter as a file head, its
    /// identity decision surfaced as `preview.identity[doc]` (3.0). The
    /// planner's own dry runs mint under a throwaway symbol table. An opset
    /// with nothing to do — the content already current — loads nothing, so
    /// the plan commits nothing for it.
    fn lower_content(&mut self, p: &mut Planning<'_>, doc_id: &str, content: &str) -> Result<()> {
        let config = p.ctx.config.clone();
        let prev = self.ids.set_capture(Some(Capture::Symbolic(Vec::new())));
        let planned = self.plan_update(&p.ctx.repo_id, doc_id, content, &config);
        self.ids.set_capture(prev);
        let opset = planned?;
        if !opset.converges {
            let why = opset
                .diagnostics
                .last()
                .map_or(String::new(), |d| format!(" — {d}"));
            return Err(merr(
                ErrorCode::PlanNotConvergent,
                format!(
                    "the proposed content of {doc_id} cannot be reproduced by the planner; re-plan{why}"
                ),
                json!({ "doc": doc_id, "diagnostics": opset.diagnostics }),
            ));
        }
        let offset = p.ops.len();
        p.identity.push((
            doc_id.to_owned(),
            IdentityPreview {
                matcher_v: opset.matcher_v.clone(),
                summary: opset.summary,
                ops: opset
                    .ops
                    .iter()
                    .enumerate()
                    .map(|(i, planned)| IdentityOp {
                        op_index: offset + i,
                        disposition: planned.disposition,
                        blocks: planned.blocks.clone(),
                        confidence: planned.confidence,
                        reason: planned.reason.clone(),
                        detail: planned.detail.clone(),
                    })
                    .collect(),
                diagnostics: opset.diagnostics.clone(),
            },
        ));
        if opset.ops.is_empty() && opset.frontmatter.is_none() {
            // The content IS the document (the zero-effects rule): nothing is
            // loaded, so nothing is ingested and `execute` records no commit
            // — the document's triple stays a precondition, so the plan is
            // `stale_plan` once the document moves on.
            let base = doc_base(&self.conn, doc_id)?.ok_or_else(|| doc_missing(doc_id))?;
            if !p.doc_bases.iter().any(|b| b.doc_id == *doc_id) {
                p.doc_bases.push(base);
            }
            return Ok(());
        }
        let d = p.runner.ensure_doc(self, doc_id)?;
        if let Some(raw) = &opset.frontmatter {
            let head = format!(
                "{}{}",
                p.runner.loaded[d].doc.leading_trivia,
                raw.as_deref().unwrap_or("")
            );
            p.runner.set_head(self, doc_id, &head)?;
            set_head(p, doc_id, head);
        }
        for planned in &opset.ops {
            self.push_op(p, fx::shift_placeholders(&planned.op, offset))?;
        }
        Ok(())
    }

    /// Lower effect `i`: resolve, classify (dropping an identical duplicate
    /// or refusing a contradiction), then lower. Every error gains
    /// `effect_index`.
    fn lower_effect(&mut self, p: &mut Planning<'_>, i: usize, effect: &Effect) -> Result<()> {
        match self.lower_effect_inner(p, i, effect) {
            Err(Error::Mutation(mut m)) => {
                m.data.entry("effect_index".to_owned()).or_insert(json!(i));
                Err(Error::Mutation(m))
            }
            other => other,
        }
    }

    fn lower_effect_inner(
        &mut self,
        p: &mut Planning<'_>,
        i: usize,
        effect: &Effect,
    ) -> Result<()> {
        let e = self.resolve_effect(p, effect)?;
        // A retarget's hits are read once, for its focus, its ops and its
        // preview entry.
        let (retarget_ops, retarget_preview) = match &e {
            Effect::Retarget { repairs, path_glob } => {
                let repairs: Vec<LinkRepair> = repairs
                    .iter()
                    .map(|r| LinkRepair {
                        from: r.from.clone(),
                        to: r.to.clone(),
                    })
                    .collect();
                let plan = self.links_repair(&p.ctx.repo_id, &repairs, path_glob.as_deref())?;
                let preview = RetargetPreview {
                    effect_index: i,
                    hits: plan
                        .hits
                        .iter()
                        .map(|h| RetargetHitPreview {
                            id: h.block.clone(),
                            path: h.path.clone(),
                            old_raw: h.old_raw.clone(),
                            new_raw: h.new_raw.clone(),
                        })
                        .collect(),
                    pairs: plan
                        .pairs
                        .iter()
                        .map(|c| RetargetPairPreview {
                            from: c.from.clone(),
                            to: c.to.clone(),
                            hits: c.hits,
                        })
                        .collect(),
                };
                (plan.ops, Some(preview))
            }
            _ => (Vec::new(), None),
        };
        let hits: Vec<String> = retarget_ops
            .iter()
            .filter_map(|op| match op {
                Op::Update { block, .. } => Some(block.clone()),
                _ => None,
            })
            .collect();
        let info = self.focus_of(p, &e, &hits)?;
        if !p.tracker.check(i, &info, &e.describe())? {
            return Ok(());
        }
        p.resolved.push(e.clone());
        // The summary line (3.3) names its blocks BEFORE the lowering, as the
        // reference does — a removed or merged `$new.k` is still in the tree
        // — the live rows first (a block as it was before the plan), the
        // trees for what the plan created. An insert counts the ids its op
        // reported and a document move its rewritten links, so those two
        // are worded after; a retarget its hits and their documents.
        let retarget_counts = retarget_preview.as_ref().map(|r| {
            let mut docs: Vec<&str> = Vec::new();
            for h in &r.hits {
                if !docs.contains(&h.path.as_str()) {
                    docs.push(&h.path);
                }
            }
            (r.hits.len(), docs.len())
        });
        if let Some(preview) = retarget_preview {
            p.retarget.push(preview);
        }
        let after = matches!(e, Effect::Insert { .. } | Effect::MoveDocument { .. });
        let worded = (!after).then(|| self.summary_line(p, &e, None, retarget_counts));
        self.apply_lowering(p, &e, retarget_ops)?;
        let line = worded.unwrap_or_else(|| {
            let inserted = match e {
                Effect::Insert { .. } => p.runner.results.last().map(|r| r.ids.len()),
                _ => None,
            };
            self.summary_line(p, &e, inserted, retarget_counts)
        });
        p.summary.push(line);
        Ok(())
    }

    /// One resolved effect in words (`preview.summary`, 3.3).
    fn summary_line(
        &self,
        p: &Planning<'_>,
        e: &Effect,
        inserted: Option<usize>,
        retarget: Option<(usize, usize)>,
    ) -> String {
        summarize_effect(
            e,
            &Lookup {
                store: self,
                p,
                inserted,
                retarget,
            },
        )
    }

    // ---- plan (§11.6) ----------------------------------------------------------------------

    /// §11.6 `plan`: the frozen Plan with its preview; nothing written, no id
    /// minted.
    pub fn plan_effects(
        &mut self,
        ctx: &PlanContext,
        effects: &[Effect],
        doc_store: &dyn DocStore,
    ) -> Result<Plan> {
        self.plan_selected(ctx, effects, None, doc_store)
    }

    /// §11.8 `plan` over a selector's expansion: `effects` is the concrete
    /// list the surface derived (hits × templates, in that order) and
    /// `selection` the frozen record of how — digested as the plan's seventh
    /// core member and stored in the commit's intent record. With a
    /// selection an empty list is legal (zero hits: an empty plan, nothing
    /// to commit); without one it is the `plan_effects` shape error.
    pub fn plan_selected(
        &mut self,
        ctx: &PlanContext,
        effects: &[Effect],
        selection: Option<Selection>,
        doc_store: &dyn DocStore,
    ) -> Result<Plan> {
        if effects.is_empty() && selection.is_none() {
            return Err(invalid("`effects` must name at least one effect"));
        }
        let prev = self.ids.set_capture(Some(Capture::Symbolic(Vec::new())));
        let out = self.plan_pipeline(ctx, effects, doc_store);
        let capture = self.ids.set_capture(prev);
        let mut plan = out?;
        let Some(Capture::Symbolic(kinds)) = capture else {
            unreachable!("the symbolic capture installed above is taken back here")
        };
        plan.new_ids = kinds
            .iter()
            .enumerate()
            .map(|(n, kind)| NewId {
                symbol: fx::new_symbol(n),
                kind: if *kind == "block" {
                    NewIdKind::Block
                } else {
                    NewIdKind::Document
                },
            })
            .collect();
        plan.selection = selection;
        Ok(plan.sealed())
    }

    fn plan_pipeline(
        &mut self,
        ctx: &PlanContext,
        effects: &[Effect],
        doc_store: &dyn DocStore,
    ) -> Result<Plan> {
        let mut p = Planning {
            ctx,
            doc_store,
            runner: OpsRunner::new(&ctx.repo_id),
            block_symbols: HashMap::new(),
            creates: Vec::new(),
            moves: Vec::new(),
            tombstones: Vec::new(),
            heads: Vec::new(),
            ops: Vec::new(),
            pins: Vec::new(),
            parents: Vec::new(),
            absent_paths: Vec::new(),
            doc_bases: Vec::new(),
            tracker: ConflictTracker::default(),
            resolved: Vec::new(),
            identity: Vec::new(),
            retarget: Vec::new(),
            summary: Vec::new(),
            move_retargets: Vec::new(),
        };
        for (i, e) in effects.iter().enumerate() {
            self.lower_effect(&mut p, i, e)?;
        }
        let Planning {
            runner,
            creates,
            moves,
            tombstones,
            heads,
            ops,
            pins,
            parents,
            absent_paths,
            doc_bases,
            tracker,
            resolved,
            identity,
            retarget,
            summary,
            ..
        } = p;
        let applied = runner.finish();
        let opset = PlanOpset {
            creates: creates
                .iter()
                .map(|c| PlanCreate {
                    symbol: c.symbol.clone(),
                    path: c.path.clone(),
                    source: c.source.clone(),
                    before_op: c.before_op,
                })
                .collect(),
            moves: moves
                .iter()
                .map(|m| PlanMove {
                    id: m.id.clone(),
                    from: m.from.clone(),
                    to: m.to.clone(),
                })
                .collect(),
            tombstones: tombstones
                .iter()
                .map(|t| PlanTombstone {
                    id: t.id.clone(),
                    path: t.path.clone(),
                })
                .collect(),
            set_frontmatter: heads
                .into_iter()
                .map(|(doc, raw)| PlanFrontmatter { doc, raw })
                .collect(),
            ops,
        };
        let precondition = |base: &DocBase| DocPrecondition {
            id: base.doc_id.clone(),
            path: base.path.clone(),
            base_revision: base.current_rev.clone(),
            hash: base.file_hash.as_deref().map(hex),
        };
        // The loaded documents' triples; an adopted document has none (its
        // precondition is its path in `absent_paths`).
        let mut docs: Vec<DocPrecondition> = applied
            .loaded
            .iter()
            .filter_map(|d| d.base.as_ref().map(precondition))
            .collect();
        for base in &doc_bases {
            if !docs.iter().any(|d| d.id == base.doc_id) {
                docs.push(precondition(base));
            }
        }
        let preconditions = Preconditions {
            docs,
            blocks: pins
                .into_iter()
                .map(|(id, content_hash)| BlockPrecondition { id, content_hash })
                .collect(),
            parents,
            absent_paths,
        };
        // The preview (not digested): the kernel results, every revision the
        // commit would record (a created document's under its symbol), the
        // per-file diffs (a created document's `"" → bytes`).
        let mut diffs: Vec<(String, (String, String))> = applied
            .loaded
            .iter()
            .map(|d| (d.doc.path.clone(), (d.before.clone(), render(&d.doc))))
            .collect();
        let mut revisions: Vec<PlanRevision> = applied
            .loaded
            .iter()
            .map(|d| PlanRevision {
                id: d.doc.doc_id.clone(),
                path: d.doc.path.clone(),
                hash: hex(&sha256(render(&d.doc).as_bytes())),
            })
            .collect();
        fn put(diffs: &mut Vec<(String, (String, String))>, path: String, entry: (String, String)) {
            match diffs.iter_mut().find(|(p, _)| *p == path) {
                Some(slot) => slot.1 = entry,
                None => diffs.push((path, entry)),
            }
        }
        for m in &moves {
            let bytes = doc_store.read(&m.from)?.unwrap_or_default();
            let own = diffs
                .iter()
                .position(|(p, _)| *p == m.from)
                .map(|i| diffs.remove(i).1);
            diffs.push((m.from.clone(), (bytes.clone(), String::new())));
            put(
                &mut diffs,
                m.to.clone(),
                (String::new(), own.map_or(bytes, |(_, after)| after)),
            );
        }
        for t in &tombstones {
            put(
                &mut diffs,
                t.path.clone(),
                (doc_store.read(&t.path)?.unwrap_or_default(), String::new()),
            );
        }
        for r in &mut revisions {
            if let Some(m) = moves.iter().find(|m| m.id == r.id) {
                r.path = m.to.clone();
            }
        }
        Ok(Plan {
            version: PLAN_VERSION,
            planner_v: PLANNER_V.to_owned(),
            effects: resolved,
            opset,
            preconditions,
            new_ids: Vec::new(),
            selection: None,
            templates: None,
            plan_id: String::new(),
            diagnostics: tracker.diagnostics,
            preview: Some(PlanPreview {
                results: applied.results,
                revisions,
                diffs,
                identity,
                retarget,
                summary,
            }),
        })
    }

    // ---- execute (§11.7) -------------------------------------------------------------------

    /// Commit an admitted plan: the preconditions pre-checked (`stale_plan` /
    /// `doc_missing` / `path_taken`, outside the transaction, so a stale plan
    /// fails before any id is minted), the opset replayed under the recording
    /// minter, the internal effects built — creates, moves, the rendered
    /// documents (a moved one at its new path), tombstones — and committed as
    /// §4 step 5 with the intent record as `ops`.
    fn execute_admitted(
        &mut self,
        ctx: &PlanContext,
        plan: &Plan,
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
    ) -> Result<Receipt> {
        for d in &plan.preconditions.docs {
            let Some(row) = doc_base(&self.conn, &d.id)? else {
                return Err(merr(
                    ErrorCode::DocMissing,
                    format!("doc {} no longer exists", d.id),
                    json!({ "doc": d.id }),
                ));
            };
            let hash = row.file_hash.as_deref().map(hex);
            if row.path != d.path || row.current_rev != d.base_revision || hash != d.hash {
                return Err(merr(
                    ErrorCode::StalePlan,
                    format!("document {} changed since the plan was made; re-plan", d.id),
                    json!({
                        "doc": d.id,
                        "expected_revision": d.base_revision,
                        "current": { "revision": row.current_rev, "_hash": hash },
                        "retriable": true,
                    }),
                ));
            }
        }
        for path in &plan.preconditions.absent_paths {
            if find_doc_by_ref(&self.conn, &ctx.repo_id, path)?.is_some() {
                return Err(path_taken(
                    format!("document already exists at {path}"),
                    path,
                ));
            }
            if doc_store.exists(path) {
                return Err(path_taken(
                    format!("file already exists on disk at {path}"),
                    path,
                ));
            }
        }
        let prev = self.ids.set_capture(Some(Capture::Record(Vec::new())));
        let out = self.replay(ctx, plan, origin, doc_store);
        let capture = self.ids.set_capture(prev);
        let (commit, revisions) = out?;
        let Some(Capture::Record(minted)) = capture else {
            unreachable!("the recording capture installed above is taken back here")
        };
        // `$new.n` → minted id, per kind: the i-th block symbol is the i-th
        // `b` the replay minted (every one before the transaction, in the
        // plan's order — a created document re-adopted at its `before_op`),
        // the i-th document symbol the i-th `d` the created documents'
        // ingests minted inside it (load order = effect order).
        let mut bs = minted
            .iter()
            .filter(|(k, _)| *k == "block")
            .map(|(_, id)| id);
        let mut ds = minted
            .iter()
            .filter(|(k, _)| *k == "document")
            .map(|(_, id)| id);
        let new_ids = plan
            .new_ids
            .iter()
            .filter_map(|s| {
                let id = match s.kind {
                    NewIdKind::Block => bs.next(),
                    NewIdKind::Document => ds.next(),
                };
                id.map(|id| (s.symbol.clone(), id.clone()))
            })
            .collect();
        Ok(Receipt {
            plan_id: plan.plan_id.clone(),
            commit,
            revisions,
            new_ids,
            // The plan's words are the commit's (3.3): a plan echoed without
            // its preview commits with an empty summary.
            summary: plan
                .preview
                .as_ref()
                .map(|p| p.summary.clone())
                .unwrap_or_default(),
        })
    }

    /// The replay proper (under the recording minter): the commit id and the
    /// receipt's revisions. The heads of the loaded documents first, then
    /// the kernel ops in order with each created document re-adopted at its
    /// `before_op` — its composed file parsed under the production minter,
    /// so its blocks take the `b`s the plan's symbols stand for, and its own
    /// heads applied once its tree is loaded — every `$new.<n>` of a created
    /// document's block in an op rewritten to the id its parse minted (an
    /// `insert`'s / `move`'s `doc` keeps the document symbol: the runner knows
    /// the adopted tree by it, the ingest mints its `d`).
    fn replay(
        &mut self,
        ctx: &PlanContext,
        plan: &Plan,
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
    ) -> Result<(Option<String>, Vec<Revision>)> {
        let mut runner = OpsRunner::new(&ctx.repo_id);
        let heads = &plan.opset.set_frontmatter;
        for h in heads {
            if fx::parse_new_symbol(&h.doc).is_none() {
                runner.set_head(self, &h.doc, &h.raw)?;
            }
        }
        // The i-th `b` the replay mints is the i-th block symbol (§11.7).
        let block_symbols: Vec<&str> = plan
            .new_ids
            .iter()
            .filter(|n| n.kind == NewIdKind::Block)
            .map(|n| n.symbol.as_str())
            .collect();
        let mut aliases: HashMap<String, String> = HashMap::new();
        let creates = &plan.opset.creates;
        let mut ci = 0;
        for i in 0..=plan.opset.ops.len() {
            while ci < creates.len() && creates[ci].before_op <= i {
                let c = &creates[ci];
                ci += 1;
                let minted_before = self
                    .ids
                    .captured_kinds()
                    .iter()
                    .filter(|k| **k == "block")
                    .count();
                let doc = self.parse_new_document(&c.symbol, &c.path, &c.source)?;
                for (j, id) in doc.all_ids().into_iter().enumerate() {
                    if let Some(sym) = block_symbols.get(minted_before + j) {
                        aliases.insert((*sym).to_owned(), id);
                    }
                }
                runner.adopt_new(doc);
                for h in heads {
                    if h.doc == c.symbol {
                        runner.set_head(self, &c.symbol, &h.raw)?;
                    }
                }
            }
            let Some(op) = plan.opset.ops.get(i) else {
                break;
            };
            let op = if aliases.is_empty() {
                op.clone()
            } else {
                fx::map_block_ids(op, |id| {
                    aliases.get(id).cloned().unwrap_or_else(|| id.to_owned())
                })
            };
            runner.push(self, &op)?;
        }
        let applied = runner.finish();
        let moved_to: HashMap<&str, &str> = plan
            .opset
            .moves
            .iter()
            .map(|m| (m.id.as_str(), m.to.as_str()))
            .collect();
        // (a) Pending rows at the touched paths first, then the bytes on disk.
        let mut touched: Vec<String> = Vec::new();
        for c in &plan.opset.creates {
            touched.push(c.path.clone());
        }
        for m in &plan.opset.moves {
            touched.push(m.from.clone());
            touched.push(m.to.clone());
        }
        touched.extend(applied.loaded.iter().map(|d| d.doc.path.clone()));
        touched.extend(plan.opset.tombstones.iter().map(|t| t.path.clone()));
        let mut seen = HashSet::new();
        touched.retain(|p| seen.insert(p.clone()));
        self.materialize_paths(&ctx.repo_id, &touched, doc_store)?;
        let on_disk = read_on_disk(&applied.loaded, doc_store)?;
        let staged = stage(&applied.loaded, on_disk, |d| {
            moved_to
                .get(d.doc.doc_id.as_str())
                .map_or_else(|| d.doc.path.clone(), |t| (*t).to_owned())
        });
        // (b) The transaction: moves, the documents (created ones among
        // them, under the `Absent` guard), tombstones.
        let mut effects: Vec<Commit> = Vec::new();
        for m in &plan.opset.moves {
            let current_rev = doc_base(&self.conn, &m.id)?.and_then(|b| b.current_rev);
            effects.push(Commit::MovePath {
                doc_id: m.id.clone(),
                from: m.from.clone(),
                to: m.to.clone(),
                current_rev,
                inbound: inbound_links_to(&self.conn, &ctx.repo_id, &m.id, &m.from)?,
            });
        }
        let mut known: Vec<Revision> = staged
            .iter()
            .map(|s| Revision {
                doc: s.doc_id.clone(),
                path: s.path.clone(),
                hash: hex(&sha256(s.rendered.as_bytes())),
            })
            .collect();
        effects.extend(staged.into_iter().map(Staged::into_effect));
        for t in &plan.opset.tombstones {
            let current_rev = doc_base(&self.conn, &t.id)?.and_then(|b| b.current_rev);
            effects.push(Commit::Tombstone {
                doc_id: t.id.clone(),
                path: t.path.clone(),
                pool: false,
                current_rev,
            });
        }
        let record = fx::intent_record(
            &plan.plan_id,
            &plan.effects,
            plan.selection.as_ref(),
            plan.templates.as_deref(),
        );
        let head = CommitHead {
            origin: Origin::Api,
            actor: origin.commit_actor(),
            reason: origin.reason.as_deref(),
            clear_pending: false,
            ops: Some(&record),
        };
        let (committed, commit) =
            match self.commit_effects_with_id(&ctx.repo_id, &head, &effects, &ctx.ts)? {
                (Outcome::Committed(c), commit) => (c, commit),
                (Outcome::Conflict(c), _) => {
                    return Err(self.disk_conflict(&ctx.repo_id, &c.path, &c.bytes, &ctx.ts));
                }
            };
        // (c) The files.
        self.materialize_paths(&ctx.repo_id, &touched_paths(&effects), doc_store)?;
        // The receipt's revisions, one per ingest in load order; a created
        // document's `id` is the `d` the ingest minted.
        for (rev, c) in known.iter_mut().zip(&committed) {
            rev.doc = c.doc_id.clone();
        }
        Ok((commit, known))
    }

    /// §11.7 `execute { plan }` (the plan form): `version` read, the
    /// embedded `plan_id` recomputed over the core (`plan_mismatch` when it
    /// differs), the preconditions pre-checked, the opset replayed and
    /// committed. Returns the receipt.
    pub fn execute_plan(
        &mut self,
        ctx: &PlanContext,
        plan: &Plan,
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
    ) -> Result<Receipt> {
        if plan.version != PLAN_VERSION {
            return Err(fx::unsupported_plan_version(&json!(plan.version)).into());
        }
        let digest = plan.digest();
        if digest != plan.plan_id {
            return Err(fx::plan_mismatch(&plan.plan_id, &digest).into());
        }
        self.execute_admitted(ctx, plan, origin, doc_store)
    }

    /// §11.7 `execute { plan_id, effects }` (the digest form): re-plan; the
    /// digest must equal `plan_id`, else `plan_mismatch { expected, actual }`
    /// (the effects differ, or the documents they target moved).
    pub fn execute_by_digest(
        &mut self,
        ctx: &PlanContext,
        plan_id: &str,
        effects: &[Effect],
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
    ) -> Result<Receipt> {
        self.execute_replanned(ctx, plan_id, origin, doc_store, |store, ds| {
            store.plan_effects(ctx, effects, ds)
        })
    }

    /// The digest form over a caller-supplied re-plan (§11.8): `replan` runs
    /// under this store — the surface's selector expansion followed by
    /// [`Store::plan_selected`], so the store needs no OQX — and its plan's
    /// digest must equal `plan_id` (a hit that appeared or vanished changes
    /// `selection.identities`, so the digest), else `plan_mismatch`. The
    /// error type is the caller's (the surface's expansion fails in its own
    /// vocabulary); this store's errors convert into it.
    pub fn execute_replanned<E: From<Error>>(
        &mut self,
        ctx: &PlanContext,
        plan_id: &str,
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
        replan: impl FnOnce(&mut Store, &mut dyn DocStore) -> std::result::Result<Plan, E>,
    ) -> std::result::Result<Receipt, E> {
        let plan = replan(self, doc_store)?;
        if plan.plan_id != plan_id {
            return Err(Error::from(fx::plan_mismatch_replanned(plan_id, &plan.plan_id)).into());
        }
        Ok(self.execute_admitted(ctx, &plan, origin, doc_store)?)
    }

    /// §11.7 `apply { effects, dry_run? }`: the Plan on a dry run, else plan
    /// + execute in one call and one transaction.
    pub fn apply_effects(
        &mut self,
        ctx: &PlanContext,
        effects: &[Effect],
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
        dry_run: bool,
    ) -> Result<EffectsOutcome> {
        let plan = self.plan_effects(ctx, effects, doc_store)?;
        if dry_run {
            return Ok(EffectsOutcome::Plan(Box::new(plan)));
        }
        Ok(EffectsOutcome::Receipt(
            self.execute_admitted(ctx, &plan, origin, doc_store)?,
        ))
    }

    /// [`Store::apply_effects`] keeping the plan (ADR-021): plan + execute in
    /// one call and one transaction, the Plan and its Receipt both returned —
    /// the sugar tools and the CLI's local writes read the committed ids from
    /// the plan's preview realized through the receipt's `new_ids`. The
    /// reference is `applyEffectsDetailed`.
    pub fn apply_effects_detailed(
        &mut self,
        ctx: &PlanContext,
        effects: &[Effect],
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
    ) -> Result<(Plan, Receipt)> {
        self.apply_planned(ctx, origin, doc_store, |store, ds| {
            store.plan_effects(ctx, effects, ds)
        })
    }

    /// [`Store::apply_effects_detailed`] over a caller-supplied planner
    /// (§11.8): `plan` runs under this store — the surface's selector
    /// expansion and [`Store::plan_selected`] — and the plan it returns is
    /// committed at once, in the same write scope. The Plan and its Receipt;
    /// the error type is the caller's, as for [`Store::execute_replanned`].
    pub fn apply_planned<E: From<Error>>(
        &mut self,
        ctx: &PlanContext,
        origin: &ApplyOrigin,
        doc_store: &mut dyn DocStore,
        plan: impl FnOnce(&mut Store, &mut dyn DocStore) -> std::result::Result<Plan, E>,
    ) -> std::result::Result<(Plan, Receipt), E> {
        let plan = plan(self, doc_store)?;
        let receipt = self.execute_admitted(ctx, &plan, origin, doc_store)?;
        Ok((plan, receipt))
    }
}
