//! Document operations (`spec/mutate/README.md` §6, mutate 3.0): create,
//! move, delete, set-meta — each **an effect** of §11 built by the shared
//! builders ([`crate::sugar`]) and planned + committed by the effect planner
//! ([`crate::effects_plan`]) in one transaction under the generated reason
//! (`create <path>`, `move <from> -> <to>`, `delete <path>`, `set_meta
//! <path>`), the commit recording the intent (`commits.ops`). What stays here:
//! the pre-checks whose messages and `data` the fixtures pin (`doc_missing`
//! naming the locator, the create/move `path_taken` pair with no `data`),
//! the `docs_move` link report (`dangling`/`retargeted`, recomputed before
//! the commit from `inbound_links_to` + [`Store::plan_inbound_retarget`] —
//! pure over the current blocks, so equal to what the planner lowered), and
//! the composition helpers the planner shares (`compose_file`,
//! `split_frontmatter`, `canonical`). Through 2.x each operation was its own
//! commit path (a reconciling ingest for create / set_meta) with a dry run;
//! the preview is `plan` over the same effect (`spec/surface` §4, 4.0).

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
use crate::effects_plan::{PlanContext, Receipt};
use crate::error::Result;
use crate::links::{InboundLink, doc_dir_of, inbound_links_to, retarget_links_in_raw};
use crate::mutate::{ApplyOrigin, find_doc_by_ref};
use crate::read::blob_text;
use crate::sugar;
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

impl DocOpContext {
    /// The planner's context: this repo, this timestamp, the default matcher
    /// thresholds (a document operation never reconciles).
    fn plan_ctx(&self) -> PlanContext {
        PlanContext {
            repo_id: self.repo_id.clone(),
            ts: self.ts.clone(),
            config: Config::default(),
        }
    }

    /// The commit's origin: an absent actor records `NULL`
    /// ([`ApplyOrigin::new`]'s empty-actor rule).
    fn origin(&self, reason: &str) -> ApplyOrigin {
        ApplyOrigin::new(self.actor.as_deref().unwrap_or(""), Some(reason))
    }
}

/// `{ doc, path, committed: true }` plus the Receipt the effect planner
/// committed (`spec/mutate` §11.7) — a create's `revisions[0]` is the created
/// document and `new_ids` its symbols.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocOpResult {
    pub doc_id: String,
    pub path: String,
    pub committed: bool,
    pub receipt: Receipt,
}

impl DocOpResult {
    /// The fixture projection (`spec/mutate` §9): `{ doc, path, committed }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({ "doc": self.doc_id, "path": self.path, "committed": self.committed })
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
    /// The new path (storage form).
    pub path: String,
    pub committed: bool,
    pub receipt: Receipt,
    /// Inbound links still naming the old path after the call (with the
    /// retarget: the frontmatter relations, which are never rewritten).
    pub dangling: Vec<InboundLink>,
    /// `None` when the retarget was opted out or nothing linked in; empty
    /// lists when it ran but only frontmatter relations linked in.
    pub retargeted: Option<Retargeted>,
}

impl DocMoveResult {
    /// The fixture projection: `{ doc, path, committed, dangling, retargeted }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("doc".to_owned(), json!(self.doc_id));
        m.insert("path".to_owned(), json!(self.path));
        m.insert("committed".to_owned(), json!(self.committed));
        m.insert(
            "dangling".to_owned(),
            Value::Array(self.dangling.iter().map(InboundLink::to_json).collect()),
        );
        m.insert(
            "retargeted".to_owned(),
            retargeted_json(self.retargeted.as_ref()),
        );
        Value::Object(m)
    }
}

/// `{ blocks, docs }` or `null`.
#[must_use]
pub fn retargeted_json(r: Option<&Retargeted>) -> Value {
    json!(r.map(|r| json!({ "blocks": r.blocks, "docs": r.docs })))
}

/// The `retarget_inbound` plan of a move: one coalesced, CAS-pinned `update`
/// per deepest hit block, the blocks and docs it touches, and the inbound
/// links it leaves dangling. Pure over the store's current blocks — the move
/// itself changes no block — so the report computed before the commit equals
/// what the planner lowers (`spec/mutate` §11.3).
pub struct RetargetPlan {
    pub ops: Vec<Op>,
    pub blocks: Vec<String>,
    pub docs: Vec<String>,
    pub dangling: Vec<InboundLink>,
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

/// §6 `docs_set_meta`'s rewrite as one merged patch: `set` merged over the
/// file's frontmatter, `unset` removed, recomposed over the same body — what
/// N sequential `set`/`unset frontmatter.<k>` effects compose to (pinned).
#[must_use]
pub fn patch_frontmatter(
    original: &str,
    set: Option<&Map<String, Value>>,
    unset: &[String],
) -> String {
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

/// `path_taken` as the document operations raise it: the message alone, an
/// empty `data` (`spec/surface` §7 pins `path_taken {}`); the planner's own
/// `check_absent` (which names the path in `data`) never fires behind it.
fn path_taken(msg: String) -> crate::error::Error {
    MutationError::new(ErrorCode::PathTaken, msg).into()
}

impl Store {
    /// Whether a live document sits at the repo-relative `path`.
    pub fn live_doc_at(&self, repo_id: &str, path: &str) -> Result<bool> {
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

    /// The create/move destination checks, in the library's order and with
    /// its messages: a live document at `rel`, then a file on disk.
    fn require_absent(
        &self,
        repo_id: &str,
        doc_store: &dyn DocStore,
        rel: &str,
        doc_message: String,
    ) -> Result<()> {
        if self.live_doc_at(repo_id, rel)? {
            return Err(path_taken(doc_message));
        }
        if doc_store.exists(rel) {
            return Err(path_taken(format!("file already exists on disk at {rel}")));
        }
        Ok(())
    }

    /// §6 `docs_create`: one `create` effect ([`sugar::create_document`]) at
    /// the canonical path; `path_taken` when a live doc or a file exists
    /// (checked here, the library's messages); committed with the known-id
    /// ingest of the planner's adopted tree (`reason: "create <path>"`,
    /// `inserted / api`), the file written after the commit (14.0).
    pub fn docs_create(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        path: &str,
        markdown: &str,
        frontmatter: Option<&Map<String, Value>>,
    ) -> Result<DocOpResult> {
        let sugar::Sugar { effects, reason } = sugar::create_document(path, markdown, frontmatter);
        let rel = canonical(path);
        self.require_absent(
            &ctx.repo_id,
            doc_store,
            &rel,
            format!("document already exists at {rel}"),
        )?;
        let (_, receipt) = self.apply_effects_detailed(
            &ctx.plan_ctx(),
            &effects,
            &ctx.origin(&reason),
            doc_store,
        )?;
        let doc_id = receipt
            .revisions
            .first()
            .map(|r| r.doc.clone())
            .ok_or_else(|| {
                crate::error::Error::Other(format!("create: nothing committed for {rel}"))
            })?;
        Ok(DocOpResult {
            doc_id,
            path: rel,
            committed: true,
            receipt,
        })
    }

    /// §6 `docs_move`: one `move` effect ([`sugar::move_document`]) — the
    /// rename (identity kept) and, with `retarget_inbound` (the default since
    /// mutate 1.3), the rewrite of every dangling source, in one `api` commit
    /// (`reason: "move <from> -> <to>"`, 2.1); `false` leaves the links as
    /// written. `doc_missing` / `path_taken` are checked here; the link
    /// report is computed over the current blocks before the commit.
    pub fn docs_move(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        to_path: &str,
        retarget_inbound: bool,
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
        let (dangling, retargeted) = if retarget_inbound && !inbound.is_empty() {
            let p = self.plan_inbound_retarget(&info.doc_id, &info.path, &to_rel, &inbound)?;
            (
                p.dangling,
                Some(Retargeted {
                    blocks: p.blocks,
                    docs: p.docs,
                }),
            )
        } else {
            (inbound, None)
        };
        let sugar::Sugar { effects, reason } =
            sugar::move_document(&info.doc_id, &info.path, &to_rel, retarget_inbound);
        let (_, receipt) = self.apply_effects_detailed(
            &ctx.plan_ctx(),
            &effects,
            &ctx.origin(&reason),
            doc_store,
        )?;
        Ok(DocMoveResult {
            doc_id: info.doc_id,
            path: to_rel,
            committed: true,
            receipt,
            dangling,
            retargeted,
        })
    }

    /// The `retarget_inbound` plan of a move `from_path → to_rel` over the
    /// store's current blocks: deepest hit block per inbound link (a
    /// container whose raw includes a hit child's raw is covered by the
    /// child), each rewritten against the source's *current* directory.
    pub fn plan_inbound_retarget(
        &self,
        doc_id: &str,
        from_path: &str,
        to_rel: &str,
        inbound: &[InboundLink],
    ) -> Result<RetargetPlan> {
        let mut by_block_order: Vec<String> = Vec::new();
        let mut by_block: HashMap<String, &InboundLink> = HashMap::new();
        for l in inbound {
            if let Some(b) = &l.block
                && !by_block.contains_key(b)
            {
                by_block_order.push(b.clone());
                by_block.insert(b.clone(), l);
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
                if let Some(p) = &cur
                    && by_block.contains_key(p)
                {
                    containers.insert(p.clone());
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

    /// §6 `docs_delete`: one `remove document` effect
    /// ([`sugar::delete_document`]) — one transaction, an `api` commit
    /// (`reason: "delete <path>"`), the document and its live blocks
    /// tombstoned, nothing pooled, the file unlinked after the commit if it
    /// still holds the last revision's bytes (14.0). `doc_missing` is checked here.
    pub fn docs_delete(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
    ) -> Result<DocOpResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        let sugar::Sugar { effects, reason } = sugar::delete_document(&info.doc_id, &info.path);
        let (_, receipt) = self.apply_effects_detailed(
            &ctx.plan_ctx(),
            &effects,
            &ctx.origin(&reason),
            doc_store,
        )?;
        Ok(DocOpResult {
            doc_id: info.doc_id,
            path: info.path,
            committed: true,
            receipt,
        })
    }

    /// §6 `docs_set_meta`: one `set`/`unset frontmatter.<key>` per key
    /// ([`sugar::set_meta`]) — the composed file's head over the document's
    /// blocks, each `edited / api` (`reason: "set_meta <path>"`), the file
    /// written after the commit. `doc_missing` is checked here; an empty
    /// patch is `filter_invalid` (`spec/surface` 3.3: the library used to
    /// rewrite the frontmatter through the emitter for nothing).
    pub fn docs_set_meta(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
        set: Option<&Map<String, Value>>,
        unset: &[String],
    ) -> Result<DocOpResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        let sugar::Sugar { effects, reason } =
            sugar::set_meta(&info.doc_id, &info.path, set, unset);
        if effects.is_empty() {
            return Err(crate::error::Error::InvalidEffect(
                "pass `set` and/or `unset`".to_owned(),
            ));
        }
        let (_, receipt) = self.apply_effects_detailed(
            &ctx.plan_ctx(),
            &effects,
            &ctx.origin(&reason),
            doc_store,
        )?;
        Ok(DocOpResult {
            doc_id: info.doc_id,
            path: info.path,
            committed: true,
            receipt,
        })
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
