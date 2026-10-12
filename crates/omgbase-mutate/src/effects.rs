//! Effects and plans (`spec/mutate/README.md` §11, mutate 2.3; ADR-021):
//! the public intentional-write vocabulary — nine effects over document,
//! block, node and section targets — as a **planner tier** over the six
//! kernel ops. Everything here is pure: the effect and plan shapes with their
//! JSON forms, the `$new.<n>` symbols a plan uses for identities it creates,
//! the shape validator (§11.1), the focus bookkeeping the conflict rules run
//! on ([`ConflictTracker`], §11.3), the canonical JSON the plan digest is
//! computed over (§11.5), and the [`Plan`] with its digest. The store
//! resolves targets, lowers under a symbolic minter, pins the preconditions
//! and commits a plan (`omgbase-store`'s `effects_plan`).
//!
//! **Canonical JSON** (§11.5): no whitespace; object members sorted by the
//! UTF-8 bytes of their keys; a `null` value stays `null` (optional keys are
//! absent, never `null`, by construction); strings escaped as JSON requires
//! and no further (`"`, `\`, U+0000–U+001F as `\b \f \n \r \t` else
//! `\u00xx` lower-case — `serde_json`'s own rules — everything else literal
//! UTF-8); a number integral with |v| < 2^53 as a plain integer (`-0` → `0`),
//! any other finite number as ECMAScript `Number::toString` prints it
//! (shortest round-trip digits; exponential outside `1e-7 ≤ |x| < 1e21`).
//!
//! `plan_id = hex(sha256(canonical({ version, planner_v, effects, opset,
//! preconditions, new_ids })))`.

use std::collections::{BTreeMap, HashMap};

use omgbase_format::hash::{hex, sha256};
use serde_json::{Map, Value, json};

use crate::changeset::Op;
use crate::error::{ErrorCode, MutationError, Result};
use crate::ops::{At, Expect, OpResult, Parent, To};
use crate::opset::{OpsetSummary, PlanDisposition};

/// The plan schema version this crate reads and writes.
pub const PLAN_VERSION: u64 = 1;
/// The lowering + conflict rules version pinned in `spec/mutate` §11 (the
/// `matcher_v` precedent): `p2` since mutate 3.0 — a `create` is a loaded
/// document whose block symbols are in `new_ids`, so every plan with a
/// `create` digests differently from `p1`.
pub const PLANNER_V: &str = "p2";

// ---- `$new.<n>` ---------------------------------------------------------------------------

/// `$new.<n>` → `n`; `None` for anything else.
#[must_use]
pub fn parse_new_symbol(s: &str) -> Option<usize> {
    let n = s.strip_prefix("$new.")?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// The `n`-th symbolic identity.
#[must_use]
pub fn new_symbol(n: usize) -> String {
    format!("$new.{n}")
}

// ---- targets ------------------------------------------------------------------------------

/// What an effect addresses (§11 `Target`). A document is named by `id`
/// and/or `path` (a resolved target carries both); a section is the derived
/// range under a heading block (ADR-005), never a stored id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Document {
        id: Option<String>,
        path: Option<String>,
    },
    Block {
        id: String,
    },
    Node {
        id: String,
    },
    Section {
        heading_id: String,
    },
}

impl Target {
    /// `document` / `block` / `node` / `section`.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Target::Document { .. } => "document",
            Target::Block { .. } => "block",
            Target::Node { .. } => "node",
            Target::Section { .. } => "section",
        }
    }

    /// The id the target names, if any (a document's `id`, a block's or
    /// node's `id`, a section's heading id).
    #[must_use]
    pub fn id(&self) -> Option<&str> {
        match self {
            Target::Document { id, .. } => id.as_deref(),
            Target::Block { id } | Target::Node { id } => Some(id),
            Target::Section { heading_id } => Some(heading_id),
        }
    }

    /// `{ kind, … }`; optional keys absent.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".to_owned(), json!(self.kind()));
        match self {
            Target::Document { id, path } => {
                if let Some(id) = id {
                    m.insert("id".to_owned(), json!(id));
                }
                if let Some(path) = path {
                    m.insert("path".to_owned(), json!(path));
                }
            }
            Target::Block { id } | Target::Node { id } => {
                m.insert("id".to_owned(), json!(id));
            }
            Target::Section { heading_id } => {
                m.insert("heading_id".to_owned(), json!(heading_id));
            }
        }
        Value::Object(m)
    }

    /// Parse `{ kind, … }` of any kind.
    pub fn from_json(v: &Value) -> std::result::Result<Target, String> {
        validate_target(Some(v), "target", &["document", "block", "node", "section"])
    }
}

/// A `targets` list as resolved effects spell it: block targets.
fn block_refs_to_json(ids: &[String]) -> Value {
    Value::Array(
        ids.iter()
            .map(|id| Target::Block { id: id.clone() }.to_json())
            .collect(),
    )
}

// ---- expectations -------------------------------------------------------------------------

/// §11 `Expect`: the kernel's CAS tokens plus the document's current
/// revision (`revision`), checked at plan time and pinned into the plan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EffectExpect {
    pub content_hash: Option<String>,
    pub parent_children_hash: Option<String>,
    pub revision: Option<String>,
}

impl EffectExpect {
    /// The kernel's `Expect` when either hash is given.
    #[must_use]
    pub fn kernel(&self) -> Option<Expect> {
        if self.content_hash.is_none() && self.parent_children_hash.is_none() {
            return None;
        }
        Some(Expect {
            content_hash: self.content_hash.clone(),
            parent_children_hash: self.parent_children_hash.clone(),
        })
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(h) = &self.content_hash {
            m.insert("content_hash".to_owned(), json!(h));
        }
        if let Some(h) = &self.parent_children_hash {
            m.insert("parent_children_hash".to_owned(), json!(h));
        }
        if let Some(r) = &self.revision {
            m.insert("revision".to_owned(), json!(r));
        }
        Value::Object(m)
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        validate_expect(Some(v), "expect").map(|e| e.expect("given"))
    }
}

// ---- the effects --------------------------------------------------------------------------

/// A `from` → `to` destination rewrite of a `retarget`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repair {
    pub from: String,
    pub to: String,
}

/// Per-block expectations of a `remove`/`merge` (§11.1 `expect: { <block id>: Expect }`).
pub type ExpectMap = BTreeMap<String, Expect>;

/// §11 `Effect`: the nine public effects (two shapes each for `move` and
/// `remove`).
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// A new document at `path` from `markdown` and an optional frontmatter
    /// mapping (composed as `docs_create` composes).
    Create {
        path: String,
        markdown: String,
        frontmatter: Option<Map<String, Value>>,
    },
    /// New blocks parsed from `markdown` into a document's top level, a
    /// section's range or a container block, at `at` (default `end`).
    Insert {
        into: Target,
        at: At,
        markdown: String,
        expect: Option<EffectExpect>,
    },
    /// Write a field: `frontmatter.<key>` / `content` of a document,
    /// `markdown` / `attrs.checked` of a block, an editable property of a
    /// node.
    Set {
        target: Target,
        field: String,
        value: Value,
        expect: Option<EffectExpect>,
    },
    /// Remove a document's `frontmatter.<key>`.
    Unset {
        target: Target,
        field: String,
        expect: Option<EffectExpect>,
    },
    /// Rename a document (identity kept), rewriting the inbound links unless
    /// `retarget_inbound` is false.
    MoveDocument {
        target: Target,
        to: String,
        retarget_inbound: bool,
    },
    /// Move blocks under a new parent at a position.
    MoveBlocks {
        targets: Vec<String>,
        into: Target,
        at: At,
        expect: Option<EffectExpect>,
    },
    /// Tombstone a document (nothing pooled).
    RemoveDocument { target: Target },
    /// Remove blocks (subtrees).
    RemoveBlocks {
        targets: Vec<String>,
        expect: Option<ExpectMap>,
    },
    /// Split a block at byte offsets.
    Split {
        target: String,
        at: Vec<usize>,
        expect: Option<EffectExpect>,
    },
    /// Merge blocks into the first (`separator` default `" "`, made explicit
    /// once resolved).
    Merge {
        targets: Vec<String>,
        separator: Option<String>,
        expect: Option<ExpectMap>,
    },
    /// Rewrite link destinations repository-wide (`links_repair`).
    Retarget {
        repairs: Vec<Repair>,
        path_glob: Option<String>,
    },
}

/// `start` / `end` / `{ before }` / `{ after }`.
#[must_use]
pub fn at_to_json(at: &At) -> Value {
    match at {
        At::Start => json!("start"),
        At::End => json!("end"),
        At::Before(id) => json!({ "before": id }),
        At::After(id) => json!({ "after": id }),
    }
}

/// Parse an `at`; absent → `end`.
pub fn at_from_json(v: Option<&Value>, here: &str) -> std::result::Result<At, String> {
    match v {
        None => Ok(At::End),
        Some(Value::String(s)) if s == "start" => Ok(At::Start),
        Some(Value::String(s)) if s == "end" => Ok(At::End),
        Some(Value::Object(a)) if a.len() == 1 => {
            if let Some(b) = a.get("before").and_then(Value::as_str) {
                Ok(At::Before(b.to_owned()))
            } else if let Some(b) = a.get("after").and_then(Value::as_str) {
                Ok(At::After(b.to_owned()))
            } else {
                Err(format!(
                    "{here}: `at` must be \"start\", \"end\", {{ before: <block id> }} or {{ after: <block id> }}"
                ))
            }
        }
        _ => Err(format!(
            "{here}: `at` must be \"start\", \"end\", {{ before: <block id> }} or {{ after: <block id> }}"
        )),
    }
}

fn require_string(
    obj: &Map<String, Value>,
    key: &str,
    here: &str,
) -> std::result::Result<String, String> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{here}: `{key}` must be a string"))
}

fn optional_string(
    obj: &Map<String, Value>,
    key: &str,
    here: &str,
) -> std::result::Result<Option<String>, String> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{here}: `{key}` must be a string")),
    }
}

fn only_keys(
    obj: &Map<String, Value>,
    allowed: &[&str],
    here: &str,
) -> std::result::Result<(), String> {
    let extra: Vec<String> = obj
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .map(|k| format!("`{k}`"))
        .collect();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{here}: unknown key{} {}",
            if extra.len() > 1 { "s" } else { "" },
            extra.join(", ")
        ))
    }
}

/// §11.1: a target of one of `kinds`.
fn validate_target(
    v: Option<&Value>,
    here: &str,
    kinds: &[&str],
) -> std::result::Result<Target, String> {
    let kinds_text = kinds
        .iter()
        .map(|k| format!("\"{k}\""))
        .collect::<Vec<_>>()
        .join(" | ");
    let obj = v
        .and_then(Value::as_object)
        .filter(|o| o.get("kind").is_some_and(Value::is_string))
        .ok_or_else(|| format!("{here}: a target is {{ kind: {kinds_text}, … }}"))?;
    let kind = obj["kind"].as_str().expect("checked");
    if !kinds.contains(&kind) {
        return Err(format!(
            "{here}: `kind` must be one of {} (got \"{kind}\")",
            kinds.join(", ")
        ));
    }
    Ok(match kind {
        "document" => {
            only_keys(obj, &["kind", "id", "path"], here)?;
            let id = optional_string(obj, "id", here)?;
            let path = optional_string(obj, "path", here)?;
            if id.is_none() && path.is_none() {
                return Err(format!("{here}: a document target needs `id` or `path`"));
            }
            Target::Document { id, path }
        }
        "block" => {
            only_keys(obj, &["kind", "id"], here)?;
            Target::Block {
                id: require_string(obj, "id", here)?,
            }
        }
        "node" => {
            only_keys(obj, &["kind", "id"], here)?;
            Target::Node {
                id: require_string(obj, "id", here)?,
            }
        }
        "section" => {
            only_keys(obj, &["kind", "heading_id"], here)?;
            Target::Section {
                heading_id: require_string(obj, "heading_id", here)?,
            }
        }
        _ => unreachable!("kinds are the four above"),
    })
}

/// `targets`: a non-empty array of block targets.
fn validate_targets(v: Option<&Value>, here: &str) -> std::result::Result<Vec<String>, String> {
    let list = v
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| format!("{here}: `targets` must be a non-empty array of block targets"))?;
    list.iter()
        .enumerate()
        .map(|(i, t)| {
            match validate_target(Some(t), &format!("{here}.targets[{i}]"), &["block"])? {
                Target::Block { id } => Ok(id),
                _ => unreachable!("kinds is [block]"),
            }
        })
        .collect()
}

fn validate_expect(
    v: Option<&Value>,
    here: &str,
) -> std::result::Result<Option<EffectExpect>, String> {
    let Some(v) = v else { return Ok(None) };
    let obj = v
        .as_object()
        .ok_or_else(|| format!("{here}: `expect` must be an object"))?;
    let at = format!("{here}.expect");
    only_keys(
        obj,
        &["content_hash", "parent_children_hash", "revision"],
        &at,
    )?;
    Ok(Some(EffectExpect {
        content_hash: optional_string(obj, "content_hash", &at)?,
        parent_children_hash: optional_string(obj, "parent_children_hash", &at)?,
        revision: optional_string(obj, "revision", &at)?,
    }))
}

fn validate_expect_map(
    v: Option<&Value>,
    here: &str,
) -> std::result::Result<Option<ExpectMap>, String> {
    let Some(v) = v else { return Ok(None) };
    let obj = v
        .as_object()
        .ok_or_else(|| format!("{here}: `expect` must be an object keyed by block id"))?;
    let mut out = ExpectMap::new();
    for (id, x) in obj {
        let at = format!("{here}.expect[{}]", Value::String(id.clone()));
        let x = x
            .as_object()
            .ok_or_else(|| format!("{at}: must be an object"))?;
        only_keys(x, &["content_hash", "parent_children_hash"], &at)?;
        out.insert(
            id.clone(),
            Expect {
                content_hash: optional_string(x, "content_hash", &at)?,
                parent_children_hash: optional_string(x, "parent_children_hash", &at)?,
            },
        );
    }
    Ok(Some(out))
}

/// §11.2: the `field` spellings per target kind, checked at the shape level.
fn check_field(
    target: &Target,
    field: &str,
    here: &str,
    op: &str,
) -> std::result::Result<(), String> {
    match target {
        Target::Document { .. } => {
            if field
                .strip_prefix("frontmatter.")
                .is_some_and(|k| !k.is_empty())
                || (op == "set" && field == "content")
            {
                Ok(())
            } else {
                Err(format!(
                    "{here}: a document's `field` is `frontmatter.<key>`{} (got \"{field}\")",
                    if op == "set" { " or `content`" } else { "" }
                ))
            }
        }
        Target::Block { .. } => {
            if field == "markdown" || field == "attrs.checked" {
                Ok(())
            } else {
                Err(format!(
                    "{here}: a block's `field` is `markdown` or `attrs.checked` (got \"{field}\")"
                ))
            }
        }
        Target::Node { .. } => {
            if field.is_empty() || field.contains('.') {
                Err(format!(
                    "{here}: a node's `field` is one of its editable properties (got \"{field}\")"
                ))
            } else {
                Ok(())
            }
        }
        Target::Section { .. } => Err(format!("{here}: a section has no settable field")),
    }
}

fn expect_map_to_json(m: &ExpectMap) -> Value {
    Value::Object(
        m.iter()
            .map(|(k, e)| {
                let mut o = Map::new();
                if let Some(h) = &e.content_hash {
                    o.insert("content_hash".to_owned(), json!(h));
                }
                if let Some(h) = &e.parent_children_hash {
                    o.insert("parent_children_hash".to_owned(), json!(h));
                }
                (k.clone(), Value::Object(o))
            })
            .collect(),
    )
}

impl Effect {
    /// The effect's `op`.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Effect::Create { .. } => "create",
            Effect::Insert { .. } => "insert",
            Effect::Set { .. } => "set",
            Effect::Unset { .. } => "unset",
            Effect::MoveDocument { .. } | Effect::MoveBlocks { .. } => "move",
            Effect::RemoveDocument { .. } | Effect::RemoveBlocks { .. } => "remove",
            Effect::Split { .. } => "split",
            Effect::Merge { .. } => "merge",
            Effect::Retarget { .. } => "retarget",
        }
    }

    /// The wire form (§11.4 `ResolvedEffect` once resolved): `op` first,
    /// `at` always present, `separator` present when set, optional keys
    /// absent.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("op".to_owned(), json!(self.name()));
        let expect = |m: &mut Map<String, Value>, e: &Option<EffectExpect>| {
            if let Some(e) = e {
                m.insert("expect".to_owned(), e.to_json());
            }
        };
        match self {
            Effect::Create {
                path,
                markdown,
                frontmatter,
            } => {
                m.insert("path".to_owned(), json!(path));
                m.insert("markdown".to_owned(), json!(markdown));
                if let Some(fm) = frontmatter {
                    m.insert("frontmatter".to_owned(), Value::Object(fm.clone()));
                }
            }
            Effect::Insert {
                into,
                at,
                markdown,
                expect: e,
            } => {
                m.insert("into".to_owned(), into.to_json());
                m.insert("at".to_owned(), at_to_json(at));
                m.insert("markdown".to_owned(), json!(markdown));
                expect(&mut m, e);
            }
            Effect::Set {
                target,
                field,
                value,
                expect: e,
            } => {
                m.insert("target".to_owned(), target.to_json());
                m.insert("field".to_owned(), json!(field));
                m.insert("value".to_owned(), value.clone());
                expect(&mut m, e);
            }
            Effect::Unset {
                target,
                field,
                expect: e,
            } => {
                m.insert("target".to_owned(), target.to_json());
                m.insert("field".to_owned(), json!(field));
                expect(&mut m, e);
            }
            Effect::MoveDocument {
                target,
                to,
                retarget_inbound,
            } => {
                m.insert("target".to_owned(), target.to_json());
                m.insert("to".to_owned(), json!(to));
                m.insert("retarget_inbound".to_owned(), json!(retarget_inbound));
            }
            Effect::MoveBlocks {
                targets,
                into,
                at,
                expect: e,
            } => {
                m.insert("targets".to_owned(), block_refs_to_json(targets));
                m.insert("into".to_owned(), into.to_json());
                m.insert("at".to_owned(), at_to_json(at));
                expect(&mut m, e);
            }
            Effect::RemoveDocument { target } => {
                m.insert("target".to_owned(), target.to_json());
            }
            Effect::RemoveBlocks { targets, expect: e } => {
                m.insert("targets".to_owned(), block_refs_to_json(targets));
                if let Some(e) = e {
                    m.insert("expect".to_owned(), expect_map_to_json(e));
                }
            }
            Effect::Split {
                target,
                at,
                expect: e,
            } => {
                m.insert(
                    "target".to_owned(),
                    Target::Block { id: target.clone() }.to_json(),
                );
                m.insert("at".to_owned(), json!(at));
                expect(&mut m, e);
            }
            Effect::Merge {
                targets,
                separator,
                expect: e,
            } => {
                m.insert("targets".to_owned(), block_refs_to_json(targets));
                if let Some(s) = separator {
                    m.insert("separator".to_owned(), json!(s));
                }
                if let Some(e) = e {
                    m.insert("expect".to_owned(), expect_map_to_json(e));
                }
            }
            Effect::Retarget { repairs, path_glob } => {
                m.insert(
                    "repairs".to_owned(),
                    Value::Array(
                        repairs
                            .iter()
                            .map(|r| json!({ "from": r.from, "to": r.to }))
                            .collect(),
                    ),
                );
                if let Some(g) = path_glob {
                    m.insert("path_glob".to_owned(), json!(g));
                }
            }
        }
        Value::Object(m)
    }

    /// §11.1's shape check of `effects[i]`: an unknown key, a missing or
    /// mistyped member, a target kind the op does not take, a `field` not in
    /// §11.2 — the message names `effects[i]` and the member (the surface
    /// reports it as `filter_invalid { reason, hint: "arguments" }`).
    pub fn validate(v: &Value, i: usize) -> std::result::Result<Effect, String> {
        let here = format!("effects[{i}]");
        let ops = "create/insert/set/unset/move/remove/split/merge/retarget";
        let obj = v
            .as_object()
            .filter(|o| o.get("op").is_some_and(Value::is_string))
            .ok_or_else(|| format!("{here}: an effect is an object whose `op` is one of {ops}"))?;
        let op = obj["op"].as_str().expect("checked");
        Ok(match op {
            "create" => {
                only_keys(obj, &["op", "path", "markdown", "frontmatter"], &here)?;
                let path = require_string(obj, "path", &here)?;
                let markdown = require_string(obj, "markdown", &here)?;
                let frontmatter = match obj.get("frontmatter") {
                    None => None,
                    Some(Value::Object(fm)) => Some(fm.clone()),
                    Some(_) => return Err(format!("{here}: `frontmatter` must be an object")),
                };
                Effect::Create {
                    path,
                    markdown,
                    frontmatter,
                }
            }
            "insert" => {
                only_keys(obj, &["op", "into", "at", "markdown", "expect"], &here)?;
                let into = validate_target(
                    obj.get("into"),
                    &format!("{here}.into"),
                    &["document", "section", "block"],
                )?;
                let at = at_from_json(obj.get("at"), &here)?;
                let markdown = require_string(obj, "markdown", &here)?;
                let expect = validate_expect(obj.get("expect"), &here)?;
                Effect::Insert {
                    into,
                    at,
                    markdown,
                    expect,
                }
            }
            "set" => {
                only_keys(obj, &["op", "target", "field", "value", "expect"], &here)?;
                let target = validate_target(
                    obj.get("target"),
                    &format!("{here}.target"),
                    &["document", "block", "node"],
                )?;
                let field = require_string(obj, "field", &here)?;
                let value = obj
                    .get("value")
                    .cloned()
                    .ok_or_else(|| format!("{here}: `value` is required"))?;
                check_field(&target, &field, &here, "set")?;
                let expect = validate_expect(obj.get("expect"), &here)?;
                Effect::Set {
                    target,
                    field,
                    value,
                    expect,
                }
            }
            "unset" => {
                only_keys(obj, &["op", "target", "field", "expect"], &here)?;
                let target =
                    validate_target(obj.get("target"), &format!("{here}.target"), &["document"])?;
                let field = require_string(obj, "field", &here)?;
                check_field(&target, &field, &here, "unset")?;
                let expect = validate_expect(obj.get("expect"), &here)?;
                Effect::Unset {
                    target,
                    field,
                    expect,
                }
            }
            "move" => {
                if obj.contains_key("targets") {
                    only_keys(obj, &["op", "targets", "into", "at", "expect"], &here)?;
                    let targets = validate_targets(obj.get("targets"), &here)?;
                    let into = validate_target(
                        obj.get("into"),
                        &format!("{here}.into"),
                        &["document", "section", "block"],
                    )?;
                    let at = at_from_json(obj.get("at"), &here)?;
                    let expect = validate_expect(obj.get("expect"), &here)?;
                    Effect::MoveBlocks {
                        targets,
                        into,
                        at,
                        expect,
                    }
                } else {
                    only_keys(obj, &["op", "target", "to", "retarget_inbound"], &here)?;
                    let target = validate_target(
                        obj.get("target"),
                        &format!("{here}.target"),
                        &["document"],
                    )?;
                    let to = require_string(obj, "to", &here)?;
                    let retarget_inbound = match obj.get("retarget_inbound") {
                        None => true,
                        Some(Value::Bool(b)) => *b,
                        Some(_) => {
                            return Err(format!("{here}: `retarget_inbound` must be a boolean"));
                        }
                    };
                    Effect::MoveDocument {
                        target,
                        to,
                        retarget_inbound,
                    }
                }
            }
            "remove" => {
                if obj.contains_key("targets") {
                    only_keys(obj, &["op", "targets", "expect"], &here)?;
                    Effect::RemoveBlocks {
                        targets: validate_targets(obj.get("targets"), &here)?,
                        expect: validate_expect_map(obj.get("expect"), &here)?,
                    }
                } else {
                    only_keys(obj, &["op", "target"], &here)?;
                    Effect::RemoveDocument {
                        target: validate_target(
                            obj.get("target"),
                            &format!("{here}.target"),
                            &["document"],
                        )?,
                    }
                }
            }
            "split" => {
                only_keys(obj, &["op", "target", "at", "expect"], &here)?;
                let Target::Block { id } =
                    validate_target(obj.get("target"), &format!("{here}.target"), &["block"])?
                else {
                    unreachable!("kinds is [block]")
                };
                let at = obj
                    .get("at")
                    .and_then(Value::as_array)
                    .and_then(|a| {
                        a.iter()
                            .map(|n| n.as_u64().and_then(|n| usize::try_from(n).ok()))
                            .collect::<Option<Vec<usize>>>()
                    })
                    .ok_or_else(|| format!("{here}: `at` must be an array of byte offsets"))?;
                let expect = validate_expect(obj.get("expect"), &here)?;
                Effect::Split {
                    target: id,
                    at,
                    expect,
                }
            }
            "merge" => {
                only_keys(obj, &["op", "targets", "separator", "expect"], &here)?;
                Effect::Merge {
                    targets: validate_targets(obj.get("targets"), &here)?,
                    separator: optional_string(obj, "separator", &here)?,
                    expect: validate_expect_map(obj.get("expect"), &here)?,
                }
            }
            "retarget" => {
                only_keys(obj, &["op", "repairs", "path_glob"], &here)?;
                let repairs = obj
                    .get("repairs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("{here}: `repairs` must be an array of {{ from, to }}"))?
                    .iter()
                    .enumerate()
                    .map(|(j, r)| {
                        let at = format!("{here}.repairs[{j}]");
                        let r = r
                            .as_object()
                            .ok_or_else(|| format!("{at}: must be {{ from, to }}"))?;
                        only_keys(r, &["from", "to"], &at)?;
                        Ok(Repair {
                            from: require_string(r, "from", &at)?,
                            to: require_string(r, "to", &at)?,
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, String>>()?;
                Effect::Retarget {
                    repairs,
                    path_glob: optional_string(obj, "path_glob", &here)?,
                }
            }
            other => {
                return Err(format!(
                    "{here}: `op` must be one of {ops} (got \"{other}\")"
                ));
            }
        })
    }

    /// Parse one effect (its message names `effects[0]`).
    pub fn from_json(v: &Value) -> std::result::Result<Effect, String> {
        Effect::validate(v, 0)
    }

    /// Parse an `effects` array: a non-array or an empty list is a shape
    /// error too.
    pub fn list_from_json(v: &Value) -> std::result::Result<Vec<Effect>, String> {
        let list = v
            .as_array()
            .ok_or("`effects` must be an array of effects")?;
        if list.is_empty() {
            return Err("`effects` must name at least one effect".into());
        }
        list.iter()
            .enumerate()
            .map(|(i, e)| Effect::validate(e, i))
            .collect()
    }

    /// The `expect` an effect carries, if any (not the per-block maps).
    #[must_use]
    pub fn expect(&self) -> Option<&EffectExpect> {
        match self {
            Effect::Insert { expect, .. }
            | Effect::Set { expect, .. }
            | Effect::Unset { expect, .. }
            | Effect::MoveBlocks { expect, .. }
            | Effect::Split { expect, .. } => expect.as_ref(),
            _ => None,
        }
    }

    /// `describe` (§11.3): the words a dropped duplicate's diagnostic uses —
    /// `set <field> on document <id>`, `move block b_1,block b_2`, ….
    #[must_use]
    pub fn describe(&self) -> String {
        fn name(t: &Target) -> String {
            match t {
                Target::Section { heading_id } => format!("section {heading_id}"),
                other => format!("{} {}", other.kind(), other.id().unwrap_or_default()),
            }
        }
        fn blocks(ids: &[String]) -> String {
            ids.iter()
                .map(|id| format!("block {id}"))
                .collect::<Vec<_>>()
                .join(",")
        }
        match self {
            Effect::Create { path, .. } => format!("create {path}"),
            Effect::Insert { into, .. } => format!("insert into {}", name(into)),
            Effect::Set { target, field, .. } => format!("set {field} on {}", name(target)),
            Effect::Unset { target, field, .. } => format!("unset {field} on {}", name(target)),
            Effect::MoveDocument { target, to, .. } => format!("move {} -> {to}", name(target)),
            Effect::MoveBlocks { targets, .. } => format!("move {}", blocks(targets)),
            Effect::RemoveDocument { target } => format!("remove {}", name(target)),
            Effect::RemoveBlocks { targets, .. } => format!("remove {}", blocks(targets)),
            Effect::Split { target, .. } => format!("split block {target}"),
            Effect::Merge { targets, .. } => format!("merge {}", blocks(targets)),
            Effect::Retarget { repairs, .. } => format!(
                "retarget {}",
                repairs
                    .iter()
                    .map(|r| format!("{}->{}", r.from, r.to))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}

// ---- fields ------------------------------------------------------------------------------

/// What a `set`/`unset` `field` names, by target kind (§11.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Field<'a> {
    /// `frontmatter.<key>` of a document.
    Frontmatter(&'a str),
    /// `content` of a document: the whole-document planner.
    Content,
    /// `markdown` of a block.
    Markdown,
    /// `attrs.checked` of a block.
    Checked,
    /// An editable property of a node (`value`, `name`, `checked`).
    NodeProp(&'a str),
}

/// Classify a validated `field` for `target`.
pub fn classify_field<'a>(
    target: &Target,
    field: &'a str,
) -> std::result::Result<Field<'a>, String> {
    check_field(target, field, "field", "set")?;
    Ok(match target {
        Target::Document { .. } => match field.strip_prefix("frontmatter.") {
            Some(key) => Field::Frontmatter(key),
            None => Field::Content,
        },
        Target::Block { .. } => {
            if field == "markdown" {
                Field::Markdown
            } else {
                Field::Checked
            }
        }
        Target::Node { .. } => Field::NodeProp(field),
        Target::Section { .. } => unreachable!("check_field rejects sections"),
    })
}

/// `$n.ids[i]` placeholders of one kernel op shifted by `offset` (an opset
/// planned alone, spliced into a longer op list — `set document.content`).
#[must_use]
pub fn shift_placeholders(op: &Op, offset: usize) -> Op {
    map_block_ids(op, |v| match crate::changeset::parse_placeholder(v) {
        Some((n, i)) => format!("${}.ids[{i}]", n + offset),
        None => v.to_owned(),
    })
}

/// Every block id a kernel op names — `block`, `blocks`, a placement's parent
/// block or section heading and its anchor, the keys of a per-block `expect`
/// map, and an `insert`'s `doc` — rewritten by `f` (§11.7: the replay turns
/// the `$new.<n>` symbols of a created document into the ids it minted).
#[must_use]
pub fn map_block_ids(op: &Op, f: impl Fn(&str) -> String) -> Op {
    let s = |v: &String| -> String { f(v) };
    let to = |t: &To| To {
        parent: match &t.parent {
            Parent::Block(id) => Parent::Block(s(id)),
            Parent::Section { heading } => Parent::Section {
                heading: s(heading),
            },
            Parent::Doc => Parent::Doc,
        },
        at: match &t.at {
            At::Before(id) => At::Before(s(id)),
            At::After(id) => At::After(s(id)),
            other => other.clone(),
        },
    };
    let map = |m: &Option<BTreeMap<String, Expect>>| -> Option<BTreeMap<String, Expect>> {
        m.as_ref()
            .map(|m| m.iter().map(|(k, e)| (s(k), e.clone())).collect())
    };
    match op {
        Op::Insert {
            doc,
            to: t,
            markdown,
            expect,
        } => Op::Insert {
            doc: doc.as_ref().map(s),
            to: to(t),
            markdown: markdown.clone(),
            expect: expect.clone(),
        },
        Op::Update {
            block,
            markdown,
            attrs,
            expect,
            trivia,
            child_ids,
        } => Op::Update {
            block: s(block),
            markdown: markdown.clone(),
            attrs: attrs.clone(),
            expect: expect.clone(),
            trivia: trivia.clone(),
            child_ids: child_ids.clone(),
        },
        Op::Move {
            blocks,
            to: t,
            doc,
            expect,
        } => Op::Move {
            blocks: blocks.iter().map(s).collect(),
            to: to(t),
            doc: doc.as_ref().map(s),
            expect: expect.clone(),
        },
        Op::Remove { blocks, expect } => Op::Remove {
            blocks: blocks.iter().map(s).collect(),
            expect: map(expect),
        },
        Op::Split { block, at, expect } => Op::Split {
            block: s(block),
            at: at.clone(),
            expect: expect.clone(),
        },
        Op::Merge {
            blocks,
            separator,
            expect,
        } => Op::Merge {
            blocks: blocks.iter().map(s).collect(),
            separator: separator.clone(),
            expect: map(expect),
        },
    }
}

// ---- focus and conflicts (decision 4, §11.3) ----------------------------------------------

/// What a focus names: `{ kind: "document" | "block" | "node" | "path", id? | path? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusTarget {
    pub kind: &'static str,
    pub id: Option<String>,
    pub path: Option<String>,
}

impl FocusTarget {
    #[must_use]
    pub fn document(id: &str) -> Self {
        Self {
            kind: "document",
            id: Some(id.to_owned()),
            path: None,
        }
    }

    #[must_use]
    pub fn block(id: &str) -> Self {
        Self {
            kind: "block",
            id: Some(id.to_owned()),
            path: None,
        }
    }

    #[must_use]
    pub fn node(id: &str) -> Self {
        Self {
            kind: "node",
            id: Some(id.to_owned()),
            path: None,
        }
    }

    #[must_use]
    pub fn path(path: &str) -> Self {
        Self {
            kind: "path",
            id: None,
            path: Some(path.to_owned()),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".to_owned(), json!(self.kind));
        if let Some(id) = &self.id {
            m.insert("id".to_owned(), json!(id));
        }
        if let Some(path) = &self.path {
            m.insert("path".to_owned(), json!(path));
        }
        Value::Object(m)
    }
}

/// The focus of a conflict: `{ kind, target, field? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focus {
    /// `scalar` or `identity`.
    pub kind: &'static str,
    pub target: FocusTarget,
    pub field: Option<String>,
}

impl Focus {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".to_owned(), json!(self.kind));
        m.insert("target".to_owned(), self.target.to_json());
        if let Some(f) = &self.field {
            m.insert("field".to_owned(), json!(f));
        }
        Value::Object(m)
    }
}

/// `conflicting_effects { effects: [i, j], focus, retriable: false }` (§8).
#[must_use]
pub fn conflicting_effects(i: usize, j: usize, focus: &Focus) -> MutationError {
    let who = focus
        .target
        .id
        .clone()
        .or_else(|| focus.target.path.clone())
        .unwrap_or_default();
    let what = match &focus.field {
        Some(f) => format!("{} {who} {f}", focus.target.kind),
        None => format!("{} {who}", focus.target.kind),
    };
    MutationError::with_data(
        ErrorCode::ConflictingEffects,
        format!("effects {i} and {j} contradict each other on {what}"),
        json!({ "effects": [i, j], "focus": focus.to_json(), "retriable": false }),
    )
}

/// `target_missing { symbol }` for a `$new.<n>` no earlier effect created
/// (`kind` `None`), or one of the other kind.
#[must_use]
pub fn symbol_missing(symbol: &str, kind: Option<NewIdKind>, wanted: &str) -> MutationError {
    let message = match kind {
        None => format!("{symbol} is not created by an earlier effect"),
        Some(k) => format!("{symbol} names a {}, not a {wanted}", k.as_str()),
    };
    MutationError::with_data(
        ErrorCode::TargetMissing,
        message,
        json!({ "symbol": symbol }),
    )
}

/// A scalar write: one `(target, field)` key, `set` with a value or `unset`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScalarWrite {
    /// `document:<id>:<field>`, `block:<id>:<field>`, `node:<id>:<field>`.
    pub key: String,
    pub target: FocusTarget,
    pub field: String,
    /// `Some(value)` for a `set`, `None` for an `unset`.
    pub value: Option<Value>,
}

/// What one effect addresses and retires (§11.3): the planner computes it
/// against its trees and the store, the [`ConflictTracker`] judges it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FocusInfo {
    pub scalar: Option<ScalarWrite>,
    /// Every `(block, markdown)` focus of a `retarget` (never deduped).
    pub scalars: Vec<ScalarWrite>,
    /// The documents, blocks and paths the effect addresses.
    pub docs: Vec<String>,
    pub blocks: Vec<String>,
    pub paths: Vec<String>,
    /// What later effects may no longer address.
    pub retires_docs: Vec<String>,
    pub retires_blocks: Vec<String>,
    pub retires_paths: Vec<String>,
    /// `set document.content`: the whole document is rewritten.
    pub whole_doc: Option<String>,
}

/// The focus bookkeeping over an ordered effect list (§11.3).
#[derive(Debug, Default)]
pub struct ConflictTracker {
    scalar: HashMap<String, (usize, ScalarWrite)>,
    retired_docs: HashMap<String, usize>,
    retired_blocks: HashMap<String, usize>,
    retired_paths: HashMap<String, usize>,
    touched_docs: HashMap<String, usize>,
    /// The dropped duplicates, verbatim.
    pub diagnostics: Vec<String>,
}

impl ConflictTracker {
    /// Check effect `i`: `Ok(false)` when it is an identical duplicate to
    /// drop (a diagnostic is recorded), `Ok(true)` when it stands,
    /// `Err(conflicting_effects)` when it contradicts an earlier effect.
    pub fn check(&mut self, i: usize, info: &FocusInfo, describe: &str) -> Result<bool> {
        for d in &info.docs {
            if let Some(&by) = self.retired_docs.get(d) {
                return Err(conflicting_effects(
                    by,
                    i,
                    &identity(FocusTarget::document(d)),
                ));
            }
        }
        for b in &info.blocks {
            if let Some(&by) = self.retired_blocks.get(b) {
                return Err(conflicting_effects(by, i, &identity(FocusTarget::block(b))));
            }
        }
        for p in &info.paths {
            if let Some(&by) = self.retired_paths.get(p) {
                return Err(conflicting_effects(by, i, &identity(FocusTarget::path(p))));
            }
        }
        if let Some(d) = &info.whole_doc {
            if let Some(&by) = self.touched_docs.get(d) {
                return Err(conflicting_effects(
                    by,
                    i,
                    &identity(FocusTarget::document(d)),
                ));
            }
        }
        if let Some(s) = &info.scalar {
            if let Some((prev_i, prev)) = self.scalar.get(&s.key) {
                let identical = match (&prev.value, &s.value) {
                    (None, None) => true,
                    (Some(a), Some(b)) => canonical_json(a) == canonical_json(b),
                    _ => false,
                };
                if !identical {
                    return Err(conflicting_effects(
                        *prev_i,
                        i,
                        &Focus {
                            kind: "scalar",
                            target: s.target.clone(),
                            field: Some(s.field.clone()),
                        },
                    ));
                }
                self.diagnostics.push(format!(
                    "effect {i} ({describe}) duplicates effect {prev_i}; dropped"
                ));
                return Ok(false);
            }
        }
        for s in &info.scalars {
            if let Some((prev_i, _)) = self.scalar.get(&s.key) {
                return Err(conflicting_effects(
                    *prev_i,
                    i,
                    &Focus {
                        kind: "scalar",
                        target: s.target.clone(),
                        field: Some(s.field.clone()),
                    },
                ));
            }
        }
        // Record.
        if let Some(s) = &info.scalar {
            self.scalar.insert(s.key.clone(), (i, s.clone()));
        }
        for s in &info.scalars {
            self.scalar.insert(s.key.clone(), (i, s.clone()));
        }
        for d in &info.docs {
            self.touched_docs.entry(d.clone()).or_insert(i);
        }
        for d in &info.retires_docs {
            self.retired_docs.insert(d.clone(), i);
        }
        for b in &info.retires_blocks {
            self.retired_blocks.insert(b.clone(), i);
        }
        for p in &info.retires_paths {
            self.retired_paths.insert(p.clone(), i);
        }
        Ok(true)
    }
}

fn identity(target: FocusTarget) -> Focus {
    Focus {
        kind: "identity",
        target,
        field: None,
    }
}

// ---- canonical JSON and the digest ---------------------------------------------------------

/// §11 canonical JSON (module docs).
#[must_use]
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Number(n) => out.push_str(&canonical_number(n)),
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// A number as ECMAScript `JSON.stringify` prints it.
fn canonical_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let Some(f) = n.as_f64() else {
        return "null".to_owned();
    };
    js_number(f)
}

/// ECMAScript `Number::toString(x)` for a finite `x` (`null` otherwise).
#[must_use]
pub fn js_number(x: f64) -> String {
    const TWO_53: f64 = 9_007_199_254_740_992.0;
    if !x.is_finite() {
        return "null".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.fract() == 0.0 && x.abs() < TWO_53 {
        // Integral below 2^53: no fraction, no exponent.
        #[allow(clippy::cast_possible_truncation)]
        return (x as i64).to_string();
    }
    // Shortest round-trip digits and the decimal exponent from Rust's `{:e}`
    // (`d.ddde±X`), re-laid out per Number::toString.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("{:e} has an exponent");
    let exp: i32 = exp.parse().expect("{:e} exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1; // x = 0.digits × 10^n
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.push_str(&"0".repeat((n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat((-n) as usize));
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// `hex(sha256(canonical_json(core)))`.
#[must_use]
pub fn digest(core: &Value) -> String {
    hex(&sha256(canonical_json(core).as_bytes()))
}

// ---- the plan ----------------------------------------------------------------------------

/// `opset.creates[]` (3.0): a `create` as the plan carries it — its document
/// symbol, path, composed file, and `before_op`, the index of the first
/// kernel op planned after it (`ops.len()` when none): where `execute`
/// adopts it again so the replay mints its block ids in the plan's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanCreate {
    pub symbol: String,
    pub path: String,
    pub source: String,
    pub before_op: usize,
}

/// `opset.moves[]`: a document rename (its retarget updates are in `ops`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanMove {
    pub id: String,
    pub from: String,
    pub to: String,
}

/// `opset.tombstones[]`: a `remove document`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanTombstone {
    pub id: String,
    pub path: String,
}

/// `opset.set_frontmatter[]`: a document's file **head** — everything before
/// its first block (frontmatter with fences and separator, or the leading
/// trivia alone).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanFrontmatter {
    pub doc: String,
    pub raw: String,
}

/// §11.4 `opset`: every key present (`[]` when empty); the ops in the fixture
/// spelling (`child_ids`), new structure named by kernel placeholders.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanOpset {
    pub creates: Vec<PlanCreate>,
    pub moves: Vec<PlanMove>,
    pub tombstones: Vec<PlanTombstone>,
    pub set_frontmatter: Vec<PlanFrontmatter>,
    pub ops: Vec<Op>,
}

impl PlanOpset {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "creates": self.creates.iter().map(|c| json!({ "symbol": c.symbol, "path": c.path, "source": c.source, "before_op": c.before_op })).collect::<Vec<_>>(),
            "moves": self.moves.iter().map(|m| json!({ "id": m.id, "from": m.from, "to": m.to })).collect::<Vec<_>>(),
            "tombstones": self.tombstones.iter().map(|t| json!({ "id": t.id, "path": t.path })).collect::<Vec<_>>(),
            "set_frontmatter": self.set_frontmatter.iter().map(|f| json!({ "doc": f.doc, "raw": f.raw })).collect::<Vec<_>>(),
            "ops": self.ops.iter().map(Op::to_json).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let obj = v.as_object().ok_or("`plan.opset` must be an object")?;
        let arr = |k: &str| -> std::result::Result<&Vec<Value>, String> {
            obj.get(k)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("`plan.opset.{k}` must be an array"))
        };
        let s = |v: &Value, k: &str, here: &str| -> std::result::Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("`plan.opset.{here}.{k}` must be a string"))
        };
        Ok(Self {
            creates: arr("creates")?
                .iter()
                .map(|c| {
                    let str_of = |k: &str| c.get(k).and_then(Value::as_str).map(str::to_owned);
                    let before_op = c
                        .get("before_op")
                        .and_then(Value::as_u64)
                        .and_then(|n| usize::try_from(n).ok());
                    match (str_of("symbol"), str_of("path"), str_of("source"), before_op) {
                        (Some(symbol), Some(path), Some(source), Some(before_op)) => {
                            Ok(PlanCreate {
                                symbol,
                                path,
                                source,
                                before_op,
                            })
                        }
                        _ => Err(
                            "`plan.opset.creates[]` entries are { symbol, path, source, before_op }"
                                .to_owned(),
                        ),
                    }
                })
                .collect::<std::result::Result<_, String>>()?,
            moves: arr("moves")?
                .iter()
                .map(|m| {
                    Ok(PlanMove {
                        id: s(m, "id", "moves[]")?,
                        from: s(m, "from", "moves[]")?,
                        to: s(m, "to", "moves[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            tombstones: arr("tombstones")?
                .iter()
                .map(|t| {
                    Ok(PlanTombstone {
                        id: s(t, "id", "tombstones[]")?,
                        path: s(t, "path", "tombstones[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            set_frontmatter: arr("set_frontmatter")?
                .iter()
                .map(|f| {
                    Ok(PlanFrontmatter {
                        doc: s(f, "doc", "set_frontmatter[]")?,
                        raw: s(f, "raw", "set_frontmatter[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            ops: arr("ops")?
                .iter()
                .map(Op::from_json)
                .collect::<std::result::Result<Vec<_>, String>>()?,
        })
    }
}

/// A document's precondition: the `DocBase` triple as `{ id, path,
/// base_revision, hash }` — `null`s kept (they are values, §11.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocPrecondition {
    pub id: String,
    pub path: String,
    pub base_revision: Option<String>,
    /// Lower-case hex of `docs.file_hash`.
    pub hash: Option<String>,
}

/// A block's CAS pin: `{ id, content_hash }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockPrecondition {
    pub id: String,
    pub content_hash: String,
}

/// A caller's destination-parent pin: `{ doc, parent: <block id> | null,
/// parent_children_hash }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParentPrecondition {
    pub doc: String,
    pub parent: Option<String>,
    pub parent_children_hash: String,
}

/// §11.4 `preconditions`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Preconditions {
    pub docs: Vec<DocPrecondition>,
    pub blocks: Vec<BlockPrecondition>,
    pub parents: Vec<ParentPrecondition>,
    pub absent_paths: Vec<String>,
}

impl Preconditions {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "docs": self.docs.iter().map(|d| json!({ "id": d.id, "path": d.path, "base_revision": d.base_revision, "hash": d.hash })).collect::<Vec<_>>(),
            "blocks": self.blocks.iter().map(|b| json!({ "id": b.id, "content_hash": b.content_hash })).collect::<Vec<_>>(),
            "parents": self.parents.iter().map(|p| json!({ "doc": p.doc, "parent": p.parent, "parent_children_hash": p.parent_children_hash })).collect::<Vec<_>>(),
            "absent_paths": self.absent_paths,
        })
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let obj = v
            .as_object()
            .ok_or("`plan.preconditions` must be an object")?;
        let arr = |k: &str| -> std::result::Result<&Vec<Value>, String> {
            obj.get(k)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("`plan.preconditions.{k}` must be an array"))
        };
        let s = |v: &Value, k: &str, here: &str| -> std::result::Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("`plan.preconditions.{here}.{k}` must be a string"))
        };
        let opt = |v: &Value, k: &str, here: &str| -> std::result::Result<Option<String>, String> {
            match v.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(x)) => Ok(Some(x.clone())),
                Some(_) => Err(format!(
                    "`plan.preconditions.{here}.{k}` must be a string or null"
                )),
            }
        };
        Ok(Self {
            docs: arr("docs")?
                .iter()
                .map(|d| {
                    Ok(DocPrecondition {
                        id: s(d, "id", "docs[]")?,
                        path: s(d, "path", "docs[]")?,
                        base_revision: opt(d, "base_revision", "docs[]")?,
                        hash: opt(d, "hash", "docs[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            blocks: arr("blocks")?
                .iter()
                .map(|b| {
                    Ok(BlockPrecondition {
                        id: s(b, "id", "blocks[]")?,
                        content_hash: s(b, "content_hash", "blocks[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            parents: arr("parents")?
                .iter()
                .map(|p| {
                    Ok(ParentPrecondition {
                        doc: s(p, "doc", "parents[]")?,
                        parent: opt(p, "parent", "parents[]")?,
                        parent_children_hash: s(p, "parent_children_hash", "parents[]")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            absent_paths: arr("absent_paths")?
                .iter()
                .map(|p| {
                    p.as_str().map(str::to_owned).ok_or_else(|| {
                        "`plan.preconditions.absent_paths[]` must be strings".to_owned()
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
        })
    }
}

/// The kind of identity a `$new.<n>` stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NewIdKind {
    Block,
    Document,
}

impl NewIdKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            NewIdKind::Block => "block",
            NewIdKind::Document => "document",
        }
    }

    /// The kind a mint prefix stands for (`b` / `d`).
    #[must_use]
    pub fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            "b" => Some(NewIdKind::Block),
            "d" => Some(NewIdKind::Document),
            _ => None,
        }
    }
}

/// `{ symbol, kind }` in allocation order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewId {
    pub symbol: String,
    pub kind: NewIdKind,
}

/// A planned revision `{ id, path, hash }` (a created document's `id` is
/// its symbol).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanRevision {
    pub id: String,
    pub path: String,
    pub hash: String,
}

/// One planned op of a `set document.content` as `preview.identity` reports
/// it (mutate 3.0): the §7 `PlanOp` minus the op itself — `op_index` names
/// the entry of `opset.ops` it became.
#[derive(Clone, Debug, PartialEq)]
pub struct IdentityOp {
    pub op_index: usize,
    pub disposition: PlanDisposition,
    /// The carried id(s) the op acts on; empty for an insert of new structure.
    pub blocks: Vec<String>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    /// The matcher's detail, when the planner recorded one.
    pub detail: Option<Value>,
}

/// `preview.identity[<doc id>]` (mutate 3.0): what the whole-document
/// planner (§7) decided for a `set document.content` — the `Opset`'s
/// identity fields, surfaced since the opset itself is no longer a wire
/// shape (`converges` is not here: a returned plan always converges).
#[derive(Clone, Debug, PartialEq)]
pub struct IdentityPreview {
    pub matcher_v: String,
    pub summary: OpsetSummary,
    pub ops: Vec<IdentityOp>,
    pub diagnostics: Vec<String>,
}

impl IdentityPreview {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "matcher_v": self.matcher_v,
            "summary": self.summary.to_json(),
            "ops": self.ops.iter().map(|o| {
                let mut m = Map::new();
                m.insert("op_index".to_owned(), json!(o.op_index));
                m.insert("disposition".to_owned(), json!(o.disposition.as_str()));
                m.insert("blocks".to_owned(), json!(o.blocks));
                m.insert("confidence".to_owned(), json!(o.confidence));
                m.insert("reason".to_owned(), json!(o.reason));
                if let Some(d) = &o.detail {
                    m.insert("detail".to_owned(), d.clone());
                }
                Value::Object(m)
            }).collect::<Vec<_>>(),
            "diagnostics": self.diagnostics,
        })
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let obj = v
            .as_object()
            .ok_or("`plan.preview.identity[]` must be an object")?;
        let matcher_v = obj
            .get("matcher_v")
            .and_then(Value::as_str)
            .ok_or("`plan.preview.identity[].matcher_v` must be a string")?
            .to_owned();
        let summary = obj
            .get("summary")
            .and_then(Value::as_object)
            .ok_or("`plan.preview.identity[].summary` must be an object")?;
        let count = |k: &str| -> usize {
            summary
                .get(k)
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(0)
        };
        let summary = OpsetSummary {
            preserved: count("preserved"),
            updated: count("updated"),
            moved: count("moved"),
            created: count("created"),
            removed: count("removed"),
            split: count("split"),
            merged: count("merged"),
            ambiguous: count("ambiguous"),
        };
        let ops = obj
            .get("ops")
            .and_then(Value::as_array)
            .ok_or("`plan.preview.identity[].ops` must be an array")?
            .iter()
            .map(|o| {
                let disposition = o
                    .get("disposition")
                    .and_then(Value::as_str)
                    .and_then(PlanDisposition::parse)
                    .ok_or("`plan.preview.identity[].ops[].disposition` is not a disposition")?;
                let op_index = o
                    .get("op_index")
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or("`plan.preview.identity[].ops[].op_index` must be an integer")?;
                Ok(IdentityOp {
                    op_index,
                    disposition,
                    blocks: o
                        .get("blocks")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    confidence: o.get("confidence").and_then(Value::as_f64),
                    reason: o.get("reason").and_then(Value::as_str).map(str::to_owned),
                    detail: o.get("detail").cloned(),
                })
            })
            .collect::<std::result::Result<Vec<_>, String>>()?;
        let diagnostics = obj
            .get("diagnostics")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            matcher_v,
            summary,
            ops,
            diagnostics,
        })
    }
}

/// A block a `retarget` rewrites, as `links_repair` reports it:
/// `{ id, path, oldRaw, newRaw }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetargetHitPreview {
    pub id: String,
    pub path: String,
    pub old_raw: String,
    pub new_raw: String,
}

/// A repair pair with how many destinations it matched: `{ from, to, hits }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetargetPairPreview {
    pub from: String,
    pub to: String,
    pub hits: usize,
}

/// `preview.retarget[]` (mutate 3.0): what a `retarget` effect found —
/// `{ effect_index, hits, pairs }`, the `links_repair` report the retired
/// `links_retarget { dry_run }` used to return.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetargetPreview {
    pub effect_index: usize,
    pub hits: Vec<RetargetHitPreview>,
    pub pairs: Vec<RetargetPairPreview>,
}

impl RetargetPreview {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "effect_index": self.effect_index,
            "hits": self.hits.iter().map(|h| json!({ "id": h.id, "path": h.path, "oldRaw": h.old_raw, "newRaw": h.new_raw })).collect::<Vec<_>>(),
            "pairs": self.pairs.iter().map(|p| json!({ "from": p.from, "to": p.to, "hits": p.hits })).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let obj = v
            .as_object()
            .ok_or("`plan.preview.retarget[]` must be an object")?;
        let s = |v: &Value, k: &str| -> std::result::Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("`plan.preview.retarget[]` {k} must be a string"))
        };
        let n = |v: &Value, k: &str| -> std::result::Result<usize, String> {
            v.get(k)
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| format!("`plan.preview.retarget[]` {k} must be an integer"))
        };
        Ok(Self {
            effect_index: n(v, "effect_index")?,
            hits: obj
                .get("hits")
                .and_then(Value::as_array)
                .ok_or("`plan.preview.retarget[].hits` must be an array")?
                .iter()
                .map(|h| {
                    Ok(RetargetHitPreview {
                        id: s(h, "id")?,
                        path: s(h, "path")?,
                        old_raw: s(h, "oldRaw")?,
                        new_raw: s(h, "newRaw")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
            pairs: obj
                .get("pairs")
                .and_then(Value::as_array)
                .ok_or("`plan.preview.retarget[].pairs` must be an array")?
                .iter()
                .map(|p| {
                    Ok(RetargetPairPreview {
                        from: s(p, "from")?,
                        to: s(p, "to")?,
                        hits: n(p, "hits")?,
                    })
                })
                .collect::<std::result::Result<_, String>>()?,
        })
    }
}

/// §11.4 `preview`: excluded from the digest, omittable on echo. `identity`
/// (per document, in effect order) and `retarget` (per effect) are present
/// on the wire only when non-empty (mutate 3.0).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanPreview {
    pub results: Vec<OpResult>,
    pub revisions: Vec<PlanRevision>,
    /// Path → `(before, after)`, in insertion order.
    pub diffs: Vec<(String, (String, String))>,
    /// Doc id → the whole-document planner's identity decision.
    pub identity: Vec<(String, IdentityPreview)>,
    pub retarget: Vec<RetargetPreview>,
}

impl PlanPreview {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut diffs = Map::new();
        for (path, (before, after)) in &self.diffs {
            diffs.insert(path.clone(), json!({ "before": before, "after": after }));
        }
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
                    .map(|r| json!({ "id": r.id, "path": r.path, "hash": r.hash }))
                    .collect(),
            ),
        );
        m.insert("diffs".to_owned(), Value::Object(diffs));
        if !self.identity.is_empty() {
            let mut identity = Map::new();
            for (doc, i) in &self.identity {
                identity.insert(doc.clone(), i.to_json());
            }
            m.insert("identity".to_owned(), Value::Object(identity));
        }
        if !self.retarget.is_empty() {
            m.insert(
                "retarget".to_owned(),
                Value::Array(self.retarget.iter().map(RetargetPreview::to_json).collect()),
            );
        }
        Value::Object(m)
    }

    pub fn from_json(v: &Value) -> std::result::Result<Self, String> {
        let obj = v.as_object().ok_or("`plan.preview` must be an object")?;
        let identity = obj
            .get("identity")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(doc, i)| Ok((doc.clone(), IdentityPreview::from_json(i)?)))
                    .collect::<std::result::Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        let retarget = obj
            .get("retarget")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(RetargetPreview::from_json)
                    .collect::<std::result::Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        let strings = |v: Option<&Value>| -> Option<Vec<String>> {
            v.and_then(Value::as_array).map(|l| {
                l.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
        };
        let results = obj
            .get("results")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|r| OpResult {
                        ids: strings(r.get("ids")).unwrap_or_default(),
                        removed: strings(r.get("removed")),
                        merged_into: strings(r.get("merged_into")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let str_of = |v: &Value, k: &str| -> std::result::Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("`plan.preview` {k} must be a string"))
        };
        let revisions = obj
            .get("revisions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|r| {
                        Ok(PlanRevision {
                            id: str_of(r, "id")?,
                            path: str_of(r, "path")?,
                            hash: str_of(r, "hash")?,
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        let diffs = obj
            .get("diffs")
            .and_then(Value::as_object)
            .map(|d| {
                d.iter()
                    .map(|(p, v)| Ok((p.clone(), (str_of(v, "before")?, str_of(v, "after")?))))
                    .collect::<std::result::Result<Vec<_>, String>>()
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            results,
            revisions,
            diffs,
            identity,
            retarget,
        })
    }
}

/// §11.4 `Plan`.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub version: u64,
    pub planner_v: String,
    /// The effects with their targets resolved; `$new.<n>` kept symbolic;
    /// dropped duplicates excluded.
    pub effects: Vec<Effect>,
    pub opset: PlanOpset,
    pub preconditions: Preconditions,
    pub new_ids: Vec<NewId>,
    pub plan_id: String,
    pub diagnostics: Vec<String>,
    pub preview: Option<PlanPreview>,
}

/// Why a plan handed to `execute` was not admitted (§11.7).
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    /// `unsupported_plan_version` or `plan_mismatch`.
    Refused(MutationError),
    /// A missing or mistyped core member (`filter_invalid`).
    Invalid(String),
}

impl Plan {
    /// The executable core the digest covers: `{ version, planner_v,
    /// effects, opset, preconditions, new_ids }`.
    #[must_use]
    pub fn core_json(&self) -> Value {
        json!({
            "version": self.version,
            "planner_v": self.planner_v,
            "effects": self.effects.iter().map(Effect::to_json).collect::<Vec<_>>(),
            "opset": self.opset.to_json(),
            "preconditions": self.preconditions.to_json(),
            "new_ids": self.new_ids.iter().map(|n| json!({ "symbol": n.symbol, "kind": n.kind.as_str() })).collect::<Vec<_>>(),
        })
    }

    /// `hex(sha256(canonical(core)))`.
    #[must_use]
    pub fn digest(&self) -> String {
        digest(&self.core_json())
    }

    /// The plan with `plan_id` recomputed over its core.
    #[must_use]
    pub fn sealed(mut self) -> Self {
        self.plan_id = self.digest();
        self
    }

    /// The wire form; `preview` only when present and `with_preview`.
    #[must_use]
    pub fn to_json(&self, with_preview: bool) -> Value {
        let Value::Object(mut m) = self.core_json() else {
            unreachable!("core_json is an object")
        };
        m.insert("plan_id".to_owned(), json!(self.plan_id));
        m.insert("diagnostics".to_owned(), json!(self.diagnostics));
        if with_preview {
            if let Some(p) = &self.preview {
                m.insert("preview".to_owned(), p.to_json());
            }
        }
        Value::Object(m)
    }

    /// Parse a well-formed plan (`version` must already be 1: use
    /// [`Plan::admit`] for a client's object).
    pub fn from_json(v: &Value) -> std::result::Result<Plan, String> {
        let obj = v.as_object().ok_or("`plan` must be an object")?;
        for k in [
            "planner_v",
            "effects",
            "opset",
            "preconditions",
            "new_ids",
            "plan_id",
        ] {
            if !obj.contains_key(k) {
                return Err(format!("`plan.{k}` is required"));
            }
        }
        let version = obj
            .get("version")
            .and_then(Value::as_u64)
            .ok_or("`plan.version` must be an integer")?;
        let planner_v = obj["planner_v"]
            .as_str()
            .ok_or("`plan.planner_v` must be a string")?
            .to_owned();
        let effects = obj["effects"]
            .as_array()
            .ok_or("`plan.effects` must be an array")?
            .iter()
            .enumerate()
            .map(|(i, e)| Effect::validate(e, i))
            .collect::<std::result::Result<Vec<_>, String>>()?;
        let opset = PlanOpset::from_json(&obj["opset"])?;
        let preconditions = Preconditions::from_json(&obj["preconditions"])?;
        let new_ids = obj["new_ids"]
            .as_array()
            .ok_or("`plan.new_ids` must be an array")?
            .iter()
            .map(|n| {
                let kind = match n.get("kind").and_then(Value::as_str) {
                    Some("block") => NewIdKind::Block,
                    Some("document") => NewIdKind::Document,
                    _ => return Err("`plan.new_ids[].kind` must be block or document".to_owned()),
                };
                let symbol = n
                    .get("symbol")
                    .and_then(Value::as_str)
                    .ok_or("`plan.new_ids[].symbol` must be a string")?
                    .to_owned();
                Ok(NewId { symbol, kind })
            })
            .collect::<std::result::Result<Vec<_>, String>>()?;
        let plan_id = obj["plan_id"]
            .as_str()
            .ok_or("`plan.plan_id` must be a string")?
            .to_owned();
        let diagnostics = obj
            .get("diagnostics")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let preview = match obj.get("preview") {
            None | Some(Value::Null) => None,
            Some(p) => Some(PlanPreview::from_json(p)?),
        };
        Ok(Plan {
            version,
            planner_v,
            effects,
            opset,
            preconditions,
            new_ids,
            plan_id,
            diagnostics,
            preview,
        })
    }

    /// §11.7 admission of a client's plan object, in this order: `version`
    /// ≠ 1 → `unsupported_plan_version` (before any other member is read);
    /// a missing or mistyped core member → invalid; the recomputed digest
    /// ≠ `plan_id` → `plan_mismatch { expected, actual }`.
    pub fn admit(v: &Value) -> std::result::Result<Plan, Admission> {
        let obj = v
            .as_object()
            .ok_or_else(|| Admission::Invalid("`plan` must be an object".into()))?;
        let version = obj.get("version").cloned().unwrap_or(Value::Null);
        if version != json!(PLAN_VERSION) {
            return Err(Admission::Refused(unsupported_plan_version(&version)));
        }
        let plan = Plan::from_json(v).map_err(Admission::Invalid)?;
        let actual = plan.digest();
        if actual != plan.plan_id {
            return Err(Admission::Refused(plan_mismatch(&plan.plan_id, &actual)));
        }
        Ok(plan)
    }
}

/// `unsupported_plan_version { version, supported: [1] }`.
#[must_use]
pub fn unsupported_plan_version(version: &Value) -> MutationError {
    MutationError::with_data(
        ErrorCode::UnsupportedPlanVersion,
        format!("plan version {version} is not supported (supported: {PLAN_VERSION})"),
        json!({ "version": version, "supported": [PLAN_VERSION] }),
    )
}

/// `plan_mismatch { expected, actual }`: the digest a caller named against
/// the one the plan's core (or a re-plan) yields.
#[must_use]
pub fn plan_mismatch(expected: &str, actual: &str) -> MutationError {
    MutationError::with_data(
        ErrorCode::PlanMismatch,
        "the plan's digest does not match its plan_id; it was edited or produced by a different planner — re-plan",
        json!({ "expected": expected, "actual": actual }),
    )
}

/// §11.7 `plan_mismatch` of the digest form (`execute { plan_id, effects }`):
/// the re-plan's digest is not the `plan_id` given — the effects, or the
/// documents they target, changed since the plan was made.
#[must_use]
pub fn plan_mismatch_replanned(expected: &str, actual: &str) -> MutationError {
    MutationError::with_data(
        ErrorCode::PlanMismatch,
        "the effects or the documents they target changed since the plan was made; re-plan",
        json!({ "expected": expected, "actual": actual }),
    )
}

/// The intent record an effect-driven commit stores in `commits.ops`
/// (ADR-003): `canonical({ v: 1, plan_id, effects })`.
#[must_use]
pub fn intent_record(plan_id: &str, effects: &[Effect]) -> String {
    canonical_json(&json!({
        "v": 1,
        "plan_id": plan_id,
        "effects": effects.iter().map(Effect::to_json).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, path: &str) -> Target {
        Target::Document {
            id: Some(id.into()),
            path: Some(path.into()),
        }
    }

    fn fm_set(key: &str, value: Value) -> Effect {
        Effect::Set {
            target: doc("d_0", "a.md"),
            field: format!("frontmatter.{key}"),
            value,
            expect: None,
        }
    }

    fn scalar(key: &str, target: FocusTarget, field: &str, value: Option<Value>) -> FocusInfo {
        FocusInfo {
            scalar: Some(ScalarWrite {
                key: key.into(),
                target,
                field: field.into(),
                value,
            }),
            docs: vec!["d_0".into()],
            ..Default::default()
        }
    }

    #[test]
    fn symbols_parse() {
        assert_eq!(parse_new_symbol("$new.0"), Some(0));
        assert_eq!(parse_new_symbol("$new.12"), Some(12));
        assert_eq!(parse_new_symbol("$new."), None);
        assert_eq!(parse_new_symbol("$new.a"), None);
        assert_eq!(parse_new_symbol("b_0"), None);
        assert_eq!(new_symbol(3), "$new.3");
    }

    #[test]
    fn effects_validate_and_round_trip_through_json() {
        let effects = json!([
            { "op": "create", "path": "n.md", "markdown": "# N", "frontmatter": { "k": 1 } },
            { "op": "insert", "into": { "kind": "section", "heading_id": "b_1" }, "at": "end", "markdown": "x" },
            { "op": "insert", "into": { "kind": "document", "id": "d_0", "path": "a.md" }, "at": { "after": "b_1" }, "markdown": "x", "expect": { "parent_children_hash": "cd", "revision": "r_0" } },
            { "op": "set", "target": { "kind": "document", "path": "a.md" }, "field": "frontmatter.status", "value": "done" },
            { "op": "set", "target": { "kind": "block", "id": "b_1" }, "field": "attrs.checked", "value": true, "expect": { "content_hash": "ab" } },
            { "op": "set", "target": { "kind": "node", "id": "n_1" }, "field": "value", "value": 3 },
            { "op": "unset", "target": { "kind": "document", "id": "d_0" }, "field": "frontmatter.old" },
            { "op": "move", "target": { "kind": "document", "id": "d_0" }, "to": "b.md", "retarget_inbound": true },
            { "op": "move", "targets": [{ "kind": "block", "id": "b_1" }], "into": { "kind": "block", "id": "b_2" }, "at": "start" },
            { "op": "remove", "target": { "kind": "document", "id": "d_0" } },
            { "op": "remove", "targets": [{ "kind": "block", "id": "b_1" }], "expect": { "b_1": { "content_hash": "ab" } } },
            { "op": "split", "target": { "kind": "block", "id": "b_1" }, "at": [3] },
            { "op": "merge", "targets": [{ "kind": "block", "id": "b_1" }, { "kind": "block", "id": "b_2" }], "separator": " " },
            { "op": "retarget", "repairs": [{ "from": "a.md", "to": "b.md" }], "path_glob": "notes/*" },
        ]);
        let parsed = Effect::list_from_json(&effects).unwrap();
        assert_eq!(parsed.len(), 14);
        for (v, e) in effects.as_array().unwrap().iter().zip(&parsed) {
            assert_eq!(e.to_json(), *v, "{}", e.name());
        }
        // Defaults materialize on the way out (`at`, `retarget_inbound`).
        let e = Effect::from_json(&json!({ "op": "move", "target": { "kind": "document", "path": "a.md" }, "to": "b.md" })).unwrap();
        assert_eq!(e.to_json()["retarget_inbound"], json!(true));
        let e = Effect::from_json(
            &json!({ "op": "insert", "into": { "kind": "block", "id": "b_1" }, "markdown": "x" }),
        )
        .unwrap();
        assert_eq!(e.to_json()["at"], json!("end"));
        // Shape errors name the effect and the member.
        let bad = |v: Value| Effect::validate(&v, 2).unwrap_err();
        assert!(bad(json!({ "op": "nope" })).starts_with("effects[2]: `op` must be one of"));
        assert_eq!(
            bad(
                json!({ "op": "set", "target": { "kind": "block", "id": "b" }, "field": "markdown" })
            ),
            "effects[2]: `value` is required"
        );
        assert!(
            bad(json!({ "op": "move", "target": { "kind": "block", "id": "b" }, "to": "x" }))
                .contains("`kind` must be one of document")
        );
        assert!(
            bad(json!({ "op": "create", "path": "x.md", "markdown": "", "extra": 1 }))
                .contains("unknown key `extra`")
        );
        assert!(
            bad(json!({ "op": "remove", "targets": ["b_1"] }))
                .contains("effects[2].targets[0]: a target is")
        );
        assert!(bad(json!({ "op": "remove", "targets": [] })).contains("non-empty"));
        assert!(bad(json!({ "op": "set", "target": { "kind": "document", "path": "a.md" }, "field": "title", "value": 1 })).contains("a document's `field` is `frontmatter.<key>` or `content`"));
        assert!(bad(json!({ "op": "unset", "target": { "kind": "document", "path": "a.md" }, "field": "content" })).contains("(got \"content\")"));
        assert!(bad(json!({ "op": "set", "target": { "kind": "node", "id": "n" }, "field": "a.b", "value": 1 })).contains("editable properties"));
        assert!(bad(json!({ "op": "insert", "into": { "kind": "document", "path": "a.md" }, "at": { "before": "b", "after": "c" }, "markdown": "x" })).contains("`at` must be"));
        assert!(Effect::list_from_json(&json!([])).is_err());
        assert!(Effect::list_from_json(&json!({})).is_err());
    }

    #[test]
    fn describe_and_classify() {
        assert_eq!(
            fm_set("status", json!(1)).describe(),
            "set frontmatter.status on document d_0"
        );
        let mv = Effect::MoveBlocks {
            targets: vec!["b_1".into(), "b_2".into()],
            into: Target::Section {
                heading_id: "b_0".into(),
            },
            at: At::End,
            expect: None,
        };
        assert_eq!(mv.describe(), "move block b_1,block b_2");
        let rt = Effect::Retarget {
            repairs: vec![Repair {
                from: "a".into(),
                to: "b".into(),
            }],
            path_glob: None,
        };
        assert_eq!(rt.describe(), "retarget a->b");
        assert_eq!(
            classify_field(&doc("d_0", "a.md"), "frontmatter.status"),
            Ok(Field::Frontmatter("status"))
        );
        assert_eq!(
            classify_field(&doc("d_0", "a.md"), "content"),
            Ok(Field::Content)
        );
        assert_eq!(
            classify_field(&Target::Block { id: "b".into() }, "attrs.checked"),
            Ok(Field::Checked)
        );
        assert_eq!(
            classify_field(&Target::Node { id: "n".into() }, "value"),
            Ok(Field::NodeProp("value"))
        );
        assert!(
            classify_field(
                &Target::Section {
                    heading_id: "h".into()
                },
                "x"
            )
            .is_err()
        );
    }

    #[test]
    fn placeholders_shift() {
        let op = Op::Move {
            blocks: vec!["$0.ids[1]".into(), "b_3".into()],
            to: To {
                parent: Parent::Block("$1.ids[0]".into()),
                at: At::After("$2.ids[0]".into()),
            },
            doc: None,
            expect: None,
        };
        assert_eq!(
            shift_placeholders(&op, 5).to_json(),
            json!({ "op": "move", "blocks": ["$5.ids[1]", "b_3"], "to": { "parent": "$6.ids[0]", "at": { "after": "$7.ids[0]" } } })
        );
    }

    #[test]
    fn the_tracker_dedupes_identical_scalars_and_refuses_the_rest() {
        let mut t = ConflictTracker::default();
        let write = |v: Option<Value>| {
            scalar(
                "document:d_0:frontmatter.status",
                FocusTarget::document("d_0"),
                "frontmatter.status",
                v,
            )
        };
        assert!(
            t.check(
                0,
                &write(Some(json!("done"))),
                "set frontmatter.status on document d_0"
            )
            .unwrap()
        );
        assert!(
            !t.check(
                1,
                &write(Some(json!("done"))),
                "set frontmatter.status on document d_0"
            )
            .unwrap()
        );
        assert_eq!(
            t.diagnostics,
            ["effect 1 (set frontmatter.status on document d_0) duplicates effect 0; dropped"]
        );
        let e = t.check(2, &write(Some(json!("open"))), "x").unwrap_err();
        assert_eq!(e.code, ErrorCode::ConflictingEffects);
        assert_eq!(
            e.to_json(),
            json!({ "code": "conflicting_effects", "effects": [0, 2], "focus": { "kind": "scalar", "target": { "kind": "document", "id": "d_0" }, "field": "frontmatter.status" }, "retriable": false })
        );
        // set then unset
        let e = t.check(3, &write(None), "x").unwrap_err();
        assert_eq!(e.data["effects"], json!([0, 3]));
        // A retarget's scalars never dedupe.
        let mut t = ConflictTracker::default();
        let hit = FocusInfo {
            scalars: vec![ScalarWrite {
                key: "block:b_1:markdown".into(),
                target: FocusTarget::block("b_1"),
                field: "markdown".into(),
                value: None,
            }],
            blocks: vec!["b_1".into()],
            ..Default::default()
        };
        assert!(t.check(0, &hit, "retarget").unwrap());
        let e = t.check(1, &hit, "retarget").unwrap_err();
        assert_eq!(
            e.data["focus"]["target"],
            json!({ "kind": "block", "id": "b_1" })
        );
    }

    #[test]
    fn the_tracker_enforces_identity_retirements() {
        let mut t = ConflictTracker::default();
        let remove = FocusInfo {
            docs: vec!["d_0".into()],
            blocks: vec!["b_1".into()],
            retires_blocks: vec!["b_1".into(), "b_2".into()],
            ..Default::default()
        };
        assert!(t.check(0, &remove, "remove block b_1").unwrap());
        let touch_child = FocusInfo {
            docs: vec!["d_0".into()],
            blocks: vec!["b_2".into()],
            ..Default::default()
        };
        let e = t.check(1, &touch_child, "x").unwrap_err();
        assert_eq!(
            e.data["focus"],
            json!({ "kind": "identity", "target": { "kind": "block", "id": "b_2" } })
        );
        // A path retired by a move; a create there.
        let mut t = ConflictTracker::default();
        let mv = FocusInfo {
            docs: vec!["d_0".into()],
            paths: vec!["moved/a.md".into()],
            retires_paths: vec!["a.md".into()],
            ..Default::default()
        };
        assert!(t.check(0, &mv, "move").unwrap());
        let create = FocusInfo {
            paths: vec!["a.md".into()],
            ..Default::default()
        };
        let e = t.check(1, &create, "create a.md").unwrap_err();
        assert_eq!(
            e.data["focus"],
            json!({ "kind": "identity", "target": { "kind": "path", "path": "a.md" } })
        );
        // `set content` after any touch of the document.
        let mut t = ConflictTracker::default();
        let insert = FocusInfo {
            docs: vec!["d_0".into()],
            blocks: vec!["b_2".into()],
            ..Default::default()
        };
        assert!(t.check(0, &insert, "insert").unwrap());
        let content = FocusInfo {
            scalar: Some(ScalarWrite {
                key: "document:d_0:content".into(),
                target: FocusTarget::document("d_0"),
                field: "content".into(),
                value: Some(json!("x")),
            }),
            docs: vec!["d_0".into()],
            whole_doc: Some("d_0".into()),
            ..Default::default()
        };
        let e = t
            .check(1, &content, "set content on document d_0")
            .unwrap_err();
        assert_eq!(
            e.data["focus"],
            json!({ "kind": "identity", "target": { "kind": "document", "id": "d_0" } })
        );
        // A removed document: its id is retired.
        let mut t = ConflictTracker::default();
        let rm = FocusInfo {
            docs: vec!["d_0".into()],
            retires_docs: vec!["d_0".into()],
            ..Default::default()
        };
        assert!(t.check(0, &rm, "remove document d_0").unwrap());
        let e = t.check(1, &insert, "insert").unwrap_err();
        assert_eq!(
            e.data["focus"]["target"],
            json!({ "kind": "document", "id": "d_0" })
        );
        let m = symbol_missing("$new.5", None, "block");
        assert_eq!(
            m.to_json(),
            json!({ "code": "target_missing", "symbol": "$new.5" })
        );
        let m = symbol_missing("$new.0", Some(NewIdKind::Document), "block");
        assert!(m.message.contains("names a document, not a block"));
    }

    #[test]
    fn canonical_json_sorts_keys_and_prints_numbers_like_javascript() {
        let v = json!({ "b": [1, 2.0, 2.5, -0.0, 1e21, 1e-7, 123456789012345680000.0, 0.000001, 1.5e300],
                        "a": { "z": null, "y": "q\"\n\u{1}é" }, "c": true });
        assert_eq!(
            canonical_json(&v),
            "{\"a\":{\"y\":\"q\\\"\\n\\u0001é\",\"z\":null},\"b\":[1,2,2.5,0,1e+21,1e-7,123456789012345680000,0.000001,1.5e+300],\"c\":true}"
        );
        assert_eq!(js_number(9007199254740993.0), "9007199254740992");
        assert_eq!(js_number(0.1), "0.1");
        assert_eq!(js_number(0.30000000000000004), "0.30000000000000004");
        assert_eq!(js_number(-1.5), "-1.5");
        assert_eq!(js_number(1e-6), "0.000001");
        assert_eq!(js_number(1.2e-7), "1.2e-7");
        assert_eq!(js_number(f64::NAN), "null");
        assert_eq!(js_number(100.0), "100");
        assert_eq!(js_number(1e20), "100000000000000000000");
        assert_eq!(js_number(1.7976931348623157e308), "1.7976931348623157e+308");
        assert_eq!(js_number(5e-324), "5e-324");
        // §11.5: the empty core digests to the pinned value (`p1`, the 2.3
        // vector) — and under the current planner version to its own.
        let empty = json!({ "version": 1, "planner_v": "p1", "effects": [], "opset": { "creates": [], "moves": [], "tombstones": [], "set_frontmatter": [], "ops": [] }, "preconditions": { "docs": [], "blocks": [], "parents": [], "absent_paths": [] }, "new_ids": [] });
        assert_eq!(
            digest(&empty),
            "a20097a9c319b59a1313c83e1fd494bbb3cf4895040fbbddd2866e56b16cddd3"
        );
        let mut current = empty.clone();
        current["planner_v"] = json!(PLANNER_V);
        assert_eq!(
            digest(&current),
            "6f43b302fdcd58ca4fd182b21a5bdab6fee3787ddc074f5e7c5c23b2cc368bf9"
        );
        // The spec's number vector (`effects::digest-vectors`), byte for byte.
        let numbers: Value = serde_json::from_str(
            "[1, 1.5, 0.30000000000000004, 1e+21, 1e-07, 9007199254740992, 1.7976931348623157e+308, -2.5, 100, 123456789012345680000]",
        )
        .unwrap();
        assert_eq!(
            canonical_json(&numbers),
            "[1,1.5,0.30000000000000004,1e+21,1e-7,9007199254740992,1.7976931348623157e+308,-2.5,100,123456789012345680000]"
        );
        // `z` before `é`; `/` and non-ASCII literal; lower-case `\u001f`.
        assert_eq!(
            canonical_json(&json!({ "é": "e", "z": 0 })),
            "{\"z\":0,\"é\":\"e\"}"
        );
        assert_eq!(canonical_json(&json!("a/b\u{1f}é😀")), "\"a/b\\u001fé😀\"");
    }

    #[test]
    fn a_plan_digests_its_core_and_round_trips() {
        let plan = Plan {
            version: PLAN_VERSION,
            planner_v: PLANNER_V.into(),
            effects: vec![fm_set("status", json!("done"))],
            opset: PlanOpset {
                set_frontmatter: vec![PlanFrontmatter {
                    doc: "d_0".into(),
                    raw: "---\nstatus: done\n---\n\n".into(),
                }],
                ..Default::default()
            },
            preconditions: Preconditions {
                docs: vec![DocPrecondition {
                    id: "d_0".into(),
                    path: "a.md".into(),
                    base_revision: Some("r_0".into()),
                    hash: None,
                }],
                ..Default::default()
            },
            new_ids: vec![NewId {
                symbol: "$new.0".into(),
                kind: NewIdKind::Block,
            }],
            plan_id: String::new(),
            diagnostics: vec![],
            preview: Some(PlanPreview::default()),
        }
        .sealed();
        assert_eq!(plan.plan_id.len(), 64);
        assert_eq!(plan.plan_id, digest(&plan.core_json()));
        let wire = plan.to_json(true);
        assert!(wire.get("preview").is_some());
        assert_eq!(
            wire["preconditions"]["docs"][0]["hash"],
            Value::Null,
            "a null value stays"
        );
        assert_eq!(wire["opset"]["creates"], json!([]));
        let back = Plan::from_json(&wire).unwrap();
        assert_eq!(back, plan);
        let trimmed = plan.to_json(false);
        assert!(trimmed.get("preview").is_none());
        assert_eq!(Plan::admit(&trimmed).unwrap().digest(), plan.plan_id);
        // Admission: version first, then shape, then the digest.
        let mut v2 = trimmed.clone();
        v2["version"] = json!(2);
        v2["opset"] = json!({});
        match Plan::admit(&v2) {
            Err(Admission::Refused(m)) => {
                assert_eq!(m.code, ErrorCode::UnsupportedPlanVersion);
                assert_eq!(m.data["supported"], json!([1]));
                assert_eq!(m.data["version"], json!(2));
            }
            other => panic!("{other:?}"),
        }
        let mut bare = trimmed.clone();
        bare["opset"] = json!({});
        assert!(
            matches!(Plan::admit(&bare), Err(Admission::Invalid(m)) if m.contains("opset.creates"))
        );
        let mut tampered = trimmed.clone();
        tampered["effects"] = json!([]);
        match Plan::admit(&tampered) {
            Err(Admission::Refused(m)) => {
                assert_eq!(m.code, ErrorCode::PlanMismatch);
                assert_eq!(m.data["expected"], json!(plan.plan_id));
                assert_ne!(m.data["actual"], json!(plan.plan_id));
            }
            other => panic!("{other:?}"),
        }
        let record = intent_record(&plan.plan_id, &plan.effects);
        assert!(
            record.starts_with("{\"effects\":[{\"field\":\"frontmatter.status\""),
            "{record}"
        );
        assert!(record.ends_with("\"v\":1}"));
    }
}
