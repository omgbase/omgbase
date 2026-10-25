//! The shared effect builders (ADR-021, the retirement release; `spec/mutate`
//! §6, `spec/surface` §4 "Sugar over effects" / "The document operations"):
//! every sugar write — the four document operations, the whole-document
//! update, the block tools — is **one** function here that turns the caller's
//! resolved arguments into the `Effect`s the planner runs, with the commit
//! `reason` the operation records. The MCP catalog (`omgbase-surface`), the
//! `omgbase` CLI's local verbs and the fixture runners' `docs` step all build
//! their effects here, so one builder per operation serves both engines
//! (ADR-012); the reference is `packages/core/src/mutate/sugar.ts`.
//!
//! Pure: nothing here reads the store. Ref resolution (`a.md#…` → a block id,
//! a heading's text → its id, a block's kind for `blocks_append`) and the
//! pre-checks whose error `data` the fixtures pin (`path_taken` with an empty
//! `data`, `doc_missing` naming the locator) stay with the caller, before the
//! builder runs; the planner's own copies then never fire.

use omgbase_mutate::effects::{EffectExpect, Repair, Target};
use omgbase_mutate::{At, Effect};
use serde_json::{Map, Value, json};

use crate::docs_ops::canonical;

/// A sugar operation's effects and the `reason` its commit records.
#[derive(Clone, Debug, PartialEq)]
pub struct Sugar {
    pub effects: Vec<Effect>,
    pub reason: String,
}

/// A document addressed by its id.
#[must_use]
pub fn document(doc_id: &str) -> Target {
    Target::Document {
        id: Some(doc_id.to_owned()),
        path: None,
    }
}

/// A block addressed by its id.
#[must_use]
pub fn block(id: &str) -> Target {
    Target::Block { id: id.to_owned() }
}

// ---- the document operations (§6) --------------------------------------------------------

/// `docs_create { path, markdown, frontmatter? }`: one `create` at the
/// canonical path (`spec/mutate` §6), `reason: "create <rel>"`.
#[must_use]
pub fn create_document(
    path: &str,
    markdown: &str,
    frontmatter: Option<&Map<String, Value>>,
) -> Sugar {
    let rel = canonical(path);
    Sugar {
        effects: vec![Effect::Create {
            path: rel.clone(),
            markdown: markdown.to_owned(),
            frontmatter: frontmatter.cloned(),
        }],
        reason: format!("create {rel}"),
    }
}

/// `docs_move { doc, to_path, retarget_inbound? = true }`: one `move` of the
/// document to the canonical destination, `reason: "move <from> -> <to>"`
/// (`from` the document's current storage-form path).
#[must_use]
pub fn move_document(
    doc_id: &str,
    from_path: &str,
    to_path: &str,
    retarget_inbound: bool,
) -> Sugar {
    let to_rel = canonical(to_path);
    Sugar {
        effects: vec![Effect::MoveDocument {
            target: document(doc_id),
            to: to_rel.clone(),
            retarget_inbound,
        }],
        reason: format!("move {from_path} -> {to_rel}"),
    }
}

/// `docs_delete { doc }`: one `remove` of the document, `reason: "delete <path>"`.
#[must_use]
pub fn delete_document(doc_id: &str, path: &str) -> Sugar {
    Sugar {
        effects: vec![Effect::RemoveDocument {
            target: document(doc_id),
        }],
        reason: format!("delete {path}"),
    }
}

/// `docs_set_meta { doc, set?, unset? }`: one `set _frontmatter.<k>` per
/// `set` key, then one `unset _frontmatter.<k>` per `unset` key — a key named
/// in both is only unset (the legacy merge spread `set` then deleted `unset`,
/// so `unset` won; the planner would call two writes to one scalar a
/// conflict) — `reason: "set_meta <path>"`. An empty patch yields no effect;
/// the caller refuses it (`filter_invalid` "pass `set` and/or `unset`", 3.3).
#[must_use]
pub fn set_meta(
    doc_id: &str,
    path: &str,
    set: Option<&Map<String, Value>>,
    unset: &[String],
) -> Sugar {
    let target = document(doc_id);
    let mut effects: Vec<Effect> = Vec::new();
    if let Some(set) = set {
        for (k, v) in set {
            if !unset.contains(k) {
                effects.push(Effect::Set {
                    target: target.clone(),
                    field: format!("_frontmatter.{k}"),
                    value: v.clone(),
                    expect: None,
                });
            }
        }
    }
    for k in unset {
        effects.push(Effect::Unset {
            target: target.clone(),
            field: format!("_frontmatter.{k}"),
            expect: None,
        });
    }
    Sugar {
        effects,
        reason: format!("set_meta {path}"),
    }
}

/// `docs_update { doc, content }` (`spec/surface` 4.0): one `set { document,
/// field: "content" }` — the whole-document planner's opset lowered into one
/// plan (`spec/mutate` §11.3). The reason is the caller's (`origin.reason`).
#[must_use]
pub fn update_content(doc_id: &str, content: &str) -> Vec<Effect> {
    vec![Effect::Set {
        target: document(doc_id),
        field: "content".to_owned(),
        value: json!(content),
        expect: None,
    }]
}

// ---- the block tools (`spec/surface` §4) --------------------------------------------------

/// `blocks_insert { to, markdown, at?, expect? }` / `blocks_append` /
/// `docs_append`: one `insert` into the resolved target at `at`.
#[must_use]
pub fn insert(into: Target, at: At, markdown: &str, expect: Option<EffectExpect>) -> Vec<Effect> {
    vec![Effect::Insert {
        into,
        at,
        markdown: markdown.to_owned(),
        expect,
    }]
}

/// `blocks_update { id, markdown?, checked?, expect? }`: `set markdown` and/or
/// `set _attrs.checked`; the caller's `expect` rides the first effect (the
/// planner pins the second from the tree after the first op — the hashes the
/// one legacy op checked once); a missing `content_hash` is pinned from the
/// live block by the planner, so `expect: {}` succeeds (a pinned 3.2 fix).
/// Neither `markdown` nor `checked` yields no effect.
#[must_use]
pub fn update_block(
    id: &str,
    markdown: Option<&str>,
    checked: Option<bool>,
    expect: Option<EffectExpect>,
) -> Vec<Effect> {
    let mut effects = Vec::new();
    if let Some(md) = markdown {
        effects.push(set_block(id, "markdown", json!(md), expect.clone()));
    }
    if let Some(c) = checked {
        let expect = if effects.is_empty() { expect } else { None };
        effects.push(set_block(id, "_attrs.checked", json!(c), expect));
    }
    effects
}

/// `blocks_check { ids, checked? = true }`: N × `set _attrs.checked`, each
/// pinned by the planner; an id named twice is one identical scalar write —
/// the planner drops the duplicate (a pinned 3.2 fix).
#[must_use]
pub fn check_blocks(ids: &[String], checked: bool) -> Vec<Effect> {
    ids.iter()
        .map(|b| set_block(b, "_attrs.checked", json!(checked), None))
        .collect()
}

/// `blocks_move { blocks, to, at?, expect? }`: one `move` of the blocks into
/// the resolved target (`expect` the destination-parent CAS).
#[must_use]
pub fn move_blocks(
    targets: Vec<String>,
    into: Target,
    at: At,
    expect: Option<EffectExpect>,
) -> Vec<Effect> {
    vec![Effect::MoveBlocks {
        targets,
        into,
        at,
        expect,
    }]
}

/// `blocks_remove { blocks }`: one `remove` (the planner pins every target's
/// live hash — invisible in the result; the kernel op carried none).
#[must_use]
pub fn remove_blocks(targets: Vec<String>) -> Vec<Effect> {
    vec![Effect::RemoveBlocks {
        targets,
        expect: None,
    }]
}

/// `blocks_split { id, at }`: one `split` (the planner pins the live hash).
#[must_use]
pub fn split_block(id: &str, at: Vec<usize>) -> Vec<Effect> {
    vec![Effect::Split {
        target: id.to_owned(),
        at,
        expect: None,
    }]
}

/// `blocks_merge { blocks, separator? }`: one `merge`.
#[must_use]
pub fn merge_blocks(targets: Vec<String>, separator: Option<&str>) -> Vec<Effect> {
    vec![Effect::Merge {
        targets,
        separator: separator.map(str::to_owned),
        expect: None,
    }]
}

/// `nodes_set { id, prop, value }`: one `set` of the node's property.
#[must_use]
pub fn set_node(node_id: &str, prop: &str, value: &str) -> Vec<Effect> {
    vec![Effect::Set {
        target: Target::Node {
            id: node_id.to_owned(),
        },
        field: prop.to_owned(),
        value: json!(value),
        expect: None,
    }]
}

/// `links_retarget { from_target, to_target, path_glob? }` /
/// `links_repair { repairs | from_target + to_target, path_glob? }`: one
/// `retarget` (an empty `path_glob` is none).
#[must_use]
pub fn retarget(repairs: &[(String, String)], path_glob: Option<&str>) -> Vec<Effect> {
    vec![Effect::Retarget {
        repairs: repairs
            .iter()
            .map(|(from, to)| Repair {
                from: from.clone(),
                to: to.clone(),
            })
            .collect(),
        path_glob: path_glob.filter(|g| !g.is_empty()).map(str::to_owned),
    }]
}

/// `set { block, field, value }` with an optional `expect`.
#[must_use]
pub fn set_block(id: &str, field: &str, value: Value, expect: Option<EffectExpect>) -> Effect {
    Effect::Set {
        target: block(id),
        field: field.to_owned(),
        value,
        expect,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_operations_build_their_effects_and_reasons() {
        let c = create_document("/notes/n.md", "# N\n", None);
        assert_eq!(c.reason, "create notes/n.md");
        assert_eq!(
            c.effects[0].to_json(),
            json!({ "op": "create", "path": "notes/n.md", "markdown": "# N\n" })
        );
        let m = move_document("d_0", "a.md", "/b/c.md", false);
        assert_eq!(m.reason, "move a.md -> b/c.md");
        assert_eq!(
            m.effects[0].to_json(),
            json!({ "op": "move", "target": { "kind": "document", "_id": "d_0" }, "to": "b/c.md", "retarget_inbound": false })
        );
        let d = delete_document("d_0", "a.md");
        assert_eq!(d.reason, "delete a.md");
        assert_eq!(
            d.effects[0].to_json(),
            json!({ "op": "remove", "target": { "kind": "document", "_id": "d_0" } })
        );
        let mut set = Map::new();
        set.insert("status".to_owned(), json!("x"));
        set.insert("other".to_owned(), json!(1));
        let s = set_meta("d_0", "a.md", Some(&set), &["status".to_owned()]);
        assert_eq!(s.reason, "set_meta a.md");
        assert_eq!(
            s.effects.iter().map(Effect::to_json).collect::<Vec<_>>(),
            vec![
                json!({ "op": "set", "target": { "kind": "document", "_id": "d_0" }, "field": "_frontmatter.other", "value": 1 }),
                json!({ "op": "unset", "target": { "kind": "document", "_id": "d_0" }, "field": "_frontmatter.status" }),
            ],
            "a key in both lists is only unset"
        );
        assert!(set_meta("d_0", "a.md", None, &[]).effects.is_empty());
        assert_eq!(
            update_content("d_0", "# A\n")[0].to_json(),
            json!({ "op": "set", "target": { "kind": "document", "_id": "d_0" }, "field": "content", "value": "# A\n" })
        );
    }

    #[test]
    fn block_tools_build_their_effects() {
        let expect = EffectExpect {
            content_hash: Some("ab".into()),
            parent_children_hash: None,
            revision: None,
        };
        let both = update_block("b_1", Some("x"), Some(true), Some(expect.clone()));
        assert_eq!(both.len(), 2);
        assert_eq!(both[0].to_json()["expect"], json!({ "content_hash": "ab" }));
        assert!(
            both[1].to_json().get("expect").is_none(),
            "the guard rides the first"
        );
        let checked_only = update_block("b_1", None, Some(false), Some(expect));
        assert_eq!(checked_only[0].to_json()["field"], "_attrs.checked");
        assert_eq!(
            checked_only[0].to_json()["expect"],
            json!({ "content_hash": "ab" })
        );
        assert!(update_block("b_1", None, None, None).is_empty());
        assert_eq!(check_blocks(&["b_1".into(), "b_2".into()], true).len(), 2);
        assert_eq!(
            retarget(&[("a".into(), "b".into())], Some(""))[0].to_json(),
            json!({ "op": "retarget", "repairs": [{ "from": "a", "to": "b" }] }),
            "an empty glob is none"
        );
        assert_eq!(
            set_node("n_1", "value", "/x.md")[0].to_json()["target"],
            json!({ "kind": "node", "_id": "n_1" })
        );
        assert_eq!(
            merge_blocks(vec!["b_1".into(), "b_2".into()], None)[0].to_json()["op"],
            "merge"
        );
        assert_eq!(split_block("b_1", vec![3])[0].to_json()["at"], json!([3]));
        assert_eq!(
            remove_blocks(vec!["b_1".into()])[0].to_json()["op"],
            "remove"
        );
        assert_eq!(
            move_blocks(vec!["b_1".into()], document("d_0"), At::Start, None)[0].to_json()["at"],
            "start"
        );
        assert_eq!(
            insert(block("b_1"), At::End, "x", None)[0].to_json()["into"],
            json!({ "kind": "block", "_id": "b_1" })
        );
    }
}
