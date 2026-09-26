//! Document operations (`spec/mutate/README.md` §6): create, move, delete,
//! set-meta — `api` commits with generated reasons, each following the
//! file-first protocol against a [`DocStore`].

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
use crate::derived::fts_delete_doc;
use crate::doc_store::DocStore;
use crate::error::Result;
use crate::graph::{adopt_phantoms, rebuild_doc_edges};
use crate::links::{InboundLink, doc_dir_of, inbound_links_to, retarget_links_in_raw};
use crate::mutate::{ApplyOrigin, ApplyRequest, find_doc_by_ref};
use crate::read::blob_text;
use crate::writers::{NewCommit, Origin, new_commit};
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

/// `{ doc, path, committed }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocOpResult {
    pub doc_id: String,
    pub path: String,
    pub committed: bool,
}

impl DocOpResult {
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
    pub path: String,
    pub committed: bool,
    /// Inbound links still naming the old path after the call.
    pub dangling: Vec<InboundLink>,
    pub retargeted: Option<Retargeted>,
}

impl DocMoveResult {
    /// `{ doc, path, committed, dangling, retargeted }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "doc": self.doc_id,
            "path": self.path,
            "committed": self.committed,
            "dangling": self.dangling.iter().map(InboundLink::to_json).collect::<Vec<_>>(),
            "retargeted": self.retargeted.as_ref().map(|r| json!({ "blocks": r.blocks, "docs": r.docs })),
        })
    }
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

fn doc_missing(r: &str) -> crate::error::Error {
    MutationError::new(ErrorCode::DocMissing, format!("no document {r}")).into()
}

fn path_taken(msg: String) -> crate::error::Error {
    MutationError::new(ErrorCode::PathTaken, msg).into()
}

impl Store {
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
    /// with the reconciling resolver (`reason: "create <path>"`).
    pub fn docs_create(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        path: &str,
        markdown: &str,
        frontmatter: Option<&Map<String, Value>>,
    ) -> Result<DocOpResult> {
        let rel = canonical(path);
        if self.live_doc_at(&ctx.repo_id, &rel)? {
            return Err(path_taken(format!("document already exists at {rel}")));
        }
        let content = compose_file(markdown, frontmatter);
        if doc_store.exists(&rel) {
            return Err(path_taken(format!("file already exists on disk at {rel}")));
        }
        doc_store.write(&rel, &content)?;
        let reason = format!("create {rel}");
        let c = self.reconciling_ingest(
            &ctx.repo_id,
            &rel,
            &content,
            &ctx.ts,
            Origin::Api,
            ctx.actor.as_deref(),
            Some(&reason),
            &Config::default(),
        )?;
        Ok(DocOpResult {
            doc_id: c.doc_id,
            path: rel,
            committed: true,
        })
    }

    /// §6 `docs_move`: rename a document (identity kept); an `api` commit
    /// with no revision; open edges from other documents re-pointed to
    /// `phantom:<old path>` (a self edge only when its link names the path);
    /// phantoms at the new path adopted. With `retarget_inbound`, the
    /// dangling links are rewritten as one follow-up changeset.
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
        let content = doc_store.read(&info.path)?.unwrap_or_default();
        if doc_store.exists(&info.path) {
            doc_store.rename(&info.path, &to_rel)?;
        } else {
            doc_store.write(&to_rel, &content)?;
        }
        {
            let tx = self.conn.unchecked_transaction()?;
            let reason = format!("move {} -> {to_rel}", info.path);
            new_commit(
                &tx,
                &mut *self.minter,
                &NewCommit {
                    repo_id: &ctx.repo_id,
                    ts: &ctx.ts,
                    origin: Origin::Api,
                    actor: ctx.actor.as_deref(),
                    reason: Some(&reason),
                    checkpoint_id: None,
                    ops: None,
                },
            )?;
            tx.execute(
                "UPDATE docs SET path = ?1 WHERE doc_id = ?2",
                params![to_rel, info.doc_id],
            )?;
            tx.execute(
                "UPDATE revisions SET path = ?1 WHERE doc_id = ?2 AND rev_id = ?3",
                params![to_rel, info.doc_id, info.current_rev],
            )?;
            let phantom = format!("phantom:{}", info.path);
            let mut affected: Vec<String> = Vec::new();
            {
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT src_doc FROM edges WHERE dst_node = ?1 AND to_commit IS NULL AND src_doc != ?1",
                )?;
                let it = stmt.query_map(params![info.doc_id], |r| r.get::<_, String>(0))?;
                for src in it {
                    let src = src?;
                    if !affected.contains(&src) {
                        affected.push(src);
                    }
                }
            }
            tx.execute(
                "UPDATE edges SET dst_node = ?1 WHERE dst_node = ?2 AND to_commit IS NULL AND src_doc != ?2",
                params![phantom, info.doc_id],
            )?;
            for l in &inbound {
                let Some(block) = &l.block else {
                    continue;
                };
                if l.doc != info.doc_id {
                    continue;
                }
                tx.execute(
                    "UPDATE edges SET dst_node = ?1 WHERE dst_node = ?2 AND to_commit IS NULL AND src_doc = ?2 AND src_block = ?3 AND anchor IS ?4",
                    params![phantom, info.doc_id, block, l.anchor],
                )?;
                if !affected.contains(&info.doc_id) {
                    affected.push(info.doc_id.clone());
                }
            }
            for d in &affected {
                rebuild_doc_edges(&tx, d)?;
            }
            adopt_phantoms(&tx, &to_rel, &info.doc_id)?;
            tx.commit()?;
        }
        let moved = DocMoveResult {
            doc_id: info.doc_id.clone(),
            path: to_rel.clone(),
            committed: true,
            dangling: inbound.clone(),
            retargeted: None,
        };
        if !retarget_inbound || inbound.is_empty() {
            return Ok(moved);
        }

        // Rewrite the dangling links, deepest block per inbound link.
        let mut by_block_order: Vec<String> = Vec::new();
        let mut by_block: HashMap<String, &InboundLink> = HashMap::new();
        for l in &inbound {
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
            let write_dir = if src.doc == info.doc_id {
                doc_dir_of(&to_rel)
            } else {
                doc_dir_of(&src.path)
            };
            let Some(new_raw) =
                retarget_links_in_raw(&raw, doc_dir_of(&src.path), write_dir, &info.path, &to_rel)
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
        if !ops.is_empty() {
            let req = ApplyRequest {
                repo_id: ctx.repo_id.clone(),
                ops,
                origin: ApplyOrigin {
                    actor: ctx.actor.clone().unwrap_or_else(|| "api".to_owned()),
                    reason: Some(format!("retarget inbound links {} -> {to_rel}", info.path)),
                },
                dry_run: false,
                set_frontmatter: Vec::new(),
            };
            self.apply(&req, doc_store, &ctx.ts)?;
        }
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
        Ok(DocMoveResult {
            dangling,
            retargeted: Some(Retargeted { blocks, docs }),
            ..moved
        })
    }

    /// §6 `docs_delete`: one transaction — an `api` commit, FTS rows dropped,
    /// live blocks and the doc tombstoned, nothing pooled — then the file
    /// removed.
    pub fn docs_delete(
        &mut self,
        ctx: &DocOpContext,
        doc_store: &mut dyn DocStore,
        doc_ref: &str,
    ) -> Result<DocOpResult> {
        let info = find_doc_by_ref(&self.conn, &ctx.repo_id, doc_ref)?
            .ok_or_else(|| doc_missing(doc_ref))?;
        {
            let tx = self.conn.unchecked_transaction()?;
            let reason = format!("delete {}", info.path);
            let (commit_id, _) = new_commit(
                &tx,
                &mut *self.minter,
                &NewCommit {
                    repo_id: &ctx.repo_id,
                    ts: &ctx.ts,
                    origin: Origin::Api,
                    actor: ctx.actor.as_deref(),
                    reason: Some(&reason),
                    checkpoint_id: None,
                    ops: None,
                },
            )?;
            fts_delete_doc(&tx, &info.doc_id)?;
            tx.execute(
                "UPDATE blocks SET deleted_commit = ?1 WHERE doc_id = ?2 AND deleted_commit IS NULL",
                params![commit_id, info.doc_id],
            )?;
            tx.execute(
                "UPDATE docs SET deleted_commit = ?1 WHERE doc_id = ?2",
                params![commit_id, info.doc_id],
            )?;
            tx.commit()?;
        }
        doc_store.remove(&info.path)?;
        Ok(DocOpResult {
            doc_id: info.doc_id,
            path: info.path,
            committed: true,
        })
    }

    /// §6 `docs_set_meta`: read the file, split the frontmatter, merge `set`,
    /// delete `unset`, compose, write, ingest with the reconciling resolver
    /// (`reason: "set_meta <path>"`).
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
        let original = doc_store.read(&info.path)?.unwrap_or_default();
        let (mut merged, body) = split_frontmatter(&original);
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
        let content = compose_file(&body, Some(&merged));
        doc_store.write(&info.path, &content)?;
        let reason = format!("set_meta {}", info.path);
        let c = self.reconciling_ingest(
            &ctx.repo_id,
            &info.path,
            &content,
            &ctx.ts,
            Origin::Api,
            ctx.actor.as_deref(),
            Some(&reason),
            &Config::default(),
        )?;
        Ok(DocOpResult {
            doc_id: c.doc_id,
            path: info.path,
            committed: true,
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
}
