//! Changesets (`spec/mutate/README.md` §4): the op shapes, their JSON wire
//! form, and placeholder resolution (`$<n>.ids[<i>]` naming an earlier op's
//! result). Applying a changeset needs a store (loading, commit) and lives in
//! `omgbase-store`; the pure pieces are here.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::error::{ErrorCode, MutationError, Result};
use crate::ops::{At, Expect, OpResult, Parent, To};

/// One kernel op as a changeset carries it (§4 `Op`). String fields may be
/// placeholders until [`resolve_op`] runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Insert {
        /// A doc id or path (§4 step 1); `None` infers from the placement.
        doc: Option<String>,
        to: To,
        markdown: String,
    },
    Update {
        block: String,
        markdown: Option<String>,
        attrs: Option<Map<String, Value>>,
        expect: Option<Expect>,
        trivia: Option<String>,
        child_ids: Option<BTreeMap<String, String>>,
    },
    Move {
        blocks: Vec<String>,
        to: To,
    },
    Remove {
        blocks: Vec<String>,
        expect: Option<BTreeMap<String, Expect>>,
    },
    Split {
        block: String,
        /// Byte offsets (§2.5).
        at: Vec<usize>,
        expect: Option<Expect>,
    },
    Merge {
        blocks: Vec<String>,
        separator: Option<String>,
        expect: Option<BTreeMap<String, Expect>>,
    },
}

impl Op {
    /// The op's name (`insert`, …).
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Op::Insert { .. } => "insert",
            Op::Update { .. } => "update",
            Op::Move { .. } => "move",
            Op::Remove { .. } => "remove",
            Op::Split { .. } => "split",
            Op::Merge { .. } => "merge",
        }
    }
}

// ---- JSON ---------------------------------------------------------------------------

fn expect_to_json(e: &Expect) -> Value {
    let mut m = Map::new();
    if let Some(h) = &e.content_hash {
        m.insert("content_hash".to_owned(), json!(h));
    }
    if let Some(h) = &e.parent_children_hash {
        m.insert("parent_children_hash".to_owned(), json!(h));
    }
    Value::Object(m)
}

fn expect_from_json(v: &Value) -> std::result::Result<Expect, String> {
    let obj = v.as_object().ok_or("expect must be an object")?;
    let s = |k: &str| -> std::result::Result<Option<String>, String> {
        match obj.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("expect.{k} must be a string")),
        }
    };
    Ok(Expect {
        content_hash: s("content_hash")?,
        parent_children_hash: s("parent_children_hash")?,
    })
}

fn expect_map_to_json(m: &BTreeMap<String, Expect>) -> Value {
    Value::Object(
        m.iter()
            .map(|(k, e)| (k.clone(), expect_to_json(e)))
            .collect(),
    )
}

fn expect_map_from_json(v: &Value) -> std::result::Result<BTreeMap<String, Expect>, String> {
    let obj = v
        .as_object()
        .ok_or("expect must be an object of block → expect")?;
    obj.iter()
        .map(|(k, e)| Ok((k.clone(), expect_from_json(e)?)))
        .collect()
}

/// `To` as JSON: `{ parent, at }`.
#[must_use]
pub fn to_to_json(to: &To) -> Value {
    let parent = match &to.parent {
        Parent::Doc => json!({ "doc": true }),
        Parent::Block(id) => json!(id),
        Parent::Section { heading } => json!({ "heading": heading, "scope": "section" }),
    };
    let at = match &to.at {
        At::Start => json!("start"),
        At::End => json!("end"),
        At::Before(id) => json!({ "before": id }),
        At::After(id) => json!({ "after": id }),
    };
    json!({ "parent": parent, "at": at })
}

/// `To` from JSON (`parent: null` is the document, as the reference accepts).
pub fn to_from_json(v: &Value) -> std::result::Result<To, String> {
    let obj = v.as_object().ok_or("to must be an object")?;
    let parent = match obj.get("parent") {
        None | Some(Value::Null) => Parent::Doc,
        Some(Value::String(id)) => Parent::Block(id.clone()),
        Some(Value::Object(p)) => {
            if let Some(h) = p.get("heading").and_then(Value::as_str) {
                Parent::Section {
                    heading: h.to_owned(),
                }
            } else if p.contains_key("doc") {
                Parent::Doc
            } else {
                return Err("to.parent must be an id, { doc: true } or { heading, scope }".into());
            }
        }
        Some(_) => return Err("to.parent must be an id or an object".into()),
    };
    let at = match obj.get("at") {
        Some(Value::String(s)) if s == "start" => At::Start,
        Some(Value::String(s)) if s == "end" => At::End,
        Some(Value::Object(a)) => {
            if let Some(b) = a.get("before").and_then(Value::as_str) {
                At::Before(b.to_owned())
            } else if let Some(b) = a.get("after").and_then(Value::as_str) {
                At::After(b.to_owned())
            } else {
                return Err("to.at must be start, end, { before } or { after }".into());
            }
        }
        _ => return Err("to.at must be start, end, { before } or { after }".into()),
    };
    Ok(To { parent, at })
}

fn strings(v: Option<&Value>, what: &str) -> std::result::Result<Vec<String>, String> {
    v.and_then(Value::as_array)
        .ok_or_else(|| format!("{what} must be an array of ids"))?
        .iter()
        .map(|x| {
            x.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{what} must be an array of ids"))
        })
        .collect()
}

fn string(v: Option<&Value>, what: &str) -> std::result::Result<String, String> {
    v.and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{what} must be a string"))
}

fn opt_string(v: Option<&Value>, what: &str) -> std::result::Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{what} must be a string")),
    }
}

impl Op {
    /// The wire form (§4 `Op`; `child_ids` as the spec spells it).
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("op".to_owned(), json!(self.name()));
        match self {
            Op::Insert { doc, to, markdown } => {
                if let Some(d) = doc {
                    m.insert("doc".to_owned(), json!(d));
                }
                m.insert("to".to_owned(), to_to_json(to));
                m.insert("markdown".to_owned(), json!(markdown));
            }
            Op::Update {
                block,
                markdown,
                attrs,
                expect,
                trivia,
                child_ids,
            } => {
                m.insert("block".to_owned(), json!(block));
                if let Some(md) = markdown {
                    m.insert("markdown".to_owned(), json!(md));
                }
                if let Some(a) = attrs {
                    m.insert("attrs".to_owned(), Value::Object(a.clone()));
                }
                if let Some(e) = expect {
                    m.insert("expect".to_owned(), expect_to_json(e));
                }
                if let Some(t) = trivia {
                    m.insert("trivia".to_owned(), json!(t));
                }
                if let Some(c) = child_ids {
                    m.insert("child_ids".to_owned(), json!(c));
                }
            }
            Op::Move { blocks, to } => {
                m.insert("blocks".to_owned(), json!(blocks));
                m.insert("to".to_owned(), to_to_json(to));
            }
            Op::Remove { blocks, expect } => {
                m.insert("blocks".to_owned(), json!(blocks));
                if let Some(e) = expect {
                    m.insert("expect".to_owned(), expect_map_to_json(e));
                }
            }
            Op::Split { block, at, expect } => {
                m.insert("block".to_owned(), json!(block));
                m.insert("at".to_owned(), json!(at));
                if let Some(e) = expect {
                    m.insert("expect".to_owned(), expect_to_json(e));
                }
            }
            Op::Merge {
                blocks,
                separator,
                expect,
            } => {
                m.insert("blocks".to_owned(), json!(blocks));
                if let Some(s) = separator {
                    m.insert("separator".to_owned(), json!(s));
                }
                if let Some(e) = expect {
                    m.insert("expect".to_owned(), expect_map_to_json(e));
                }
            }
        }
        Value::Object(m)
    }

    /// Parse the wire form (`child_ids` or the reference's `childIds`).
    pub fn from_json(v: &Value) -> std::result::Result<Op, String> {
        let obj = v.as_object().ok_or("an op must be an object")?;
        let kind = obj
            .get("op")
            .and_then(Value::as_str)
            .ok_or("op.op missing")?;
        let expect_one = |k: &str| -> std::result::Result<Option<Expect>, String> {
            match obj.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(e) => Ok(Some(expect_from_json(e)?)),
            }
        };
        let expect_many =
            |k: &str| -> std::result::Result<Option<BTreeMap<String, Expect>>, String> {
                match obj.get(k) {
                    None | Some(Value::Null) => Ok(None),
                    Some(e) => Ok(Some(expect_map_from_json(e)?)),
                }
            };
        Ok(match kind {
            "insert" => Op::Insert {
                doc: opt_string(obj.get("doc"), "insert.doc")?,
                to: to_from_json(obj.get("to").ok_or("insert.to missing")?)?,
                markdown: string(obj.get("markdown"), "insert.markdown")?,
            },
            "update" => {
                let attrs = match obj.get("attrs") {
                    None | Some(Value::Null) => None,
                    Some(Value::Object(a)) => Some(a.clone()),
                    Some(_) => return Err("update.attrs must be an object".into()),
                };
                let child_ids = match obj.get("child_ids").or_else(|| obj.get("childIds")) {
                    None | Some(Value::Null) => None,
                    Some(Value::Object(c)) => Some(
                        c.iter()
                            .map(|(k, v)| {
                                v.as_str()
                                    .map(|s| (k.clone(), s.to_owned()))
                                    .ok_or_else(|| "update.child_ids values must be ids".to_owned())
                            })
                            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?,
                    ),
                    Some(_) => return Err("update.child_ids must be an object".into()),
                };
                Op::Update {
                    block: string(obj.get("block"), "update.block")?,
                    markdown: opt_string(obj.get("markdown"), "update.markdown")?,
                    attrs,
                    expect: expect_one("expect")?,
                    trivia: opt_string(obj.get("trivia"), "update.trivia")?,
                    child_ids,
                }
            }
            "move" => Op::Move {
                blocks: strings(obj.get("blocks"), "move.blocks")?,
                to: to_from_json(obj.get("to").ok_or("move.to missing")?)?,
            },
            "remove" => Op::Remove {
                blocks: strings(obj.get("blocks"), "remove.blocks")?,
                expect: expect_many("expect")?,
            },
            "split" => Op::Split {
                block: string(obj.get("block"), "split.block")?,
                at: obj
                    .get("at")
                    .and_then(Value::as_array)
                    .ok_or("split.at must be an array of offsets")?
                    .iter()
                    .map(|x| {
                        x.as_u64()
                            .and_then(|n| usize::try_from(n).ok())
                            .ok_or_else(|| "split.at must be non-negative integers".to_owned())
                    })
                    .collect::<std::result::Result<Vec<_>, _>>()?,
                expect: expect_one("expect")?,
            },
            "merge" => Op::Merge {
                blocks: strings(obj.get("blocks"), "merge.blocks")?,
                separator: opt_string(obj.get("separator"), "merge.separator")?,
                expect: expect_many("expect")?,
            },
            other => return Err(format!("unknown op {other}")),
        })
    }
}

// ---- placeholders (§4 step 1) --------------------------------------------------------

/// `$<n>.ids[<i>]` → `(n, i)`; `None` when `value` is not a placeholder.
#[must_use]
pub fn parse_placeholder(value: &str) -> Option<(usize, usize)> {
    let rest = value.strip_prefix('$')?;
    let (n, rest) = rest.split_once(".ids[")?;
    let i = rest.strip_suffix(']')?;
    if n.is_empty()
        || i.is_empty()
        || !n.bytes().all(|b| b.is_ascii_digit())
        || !i.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((n.parse().ok()?, i.parse().ok()?))
}

/// Resolve a placeholder against earlier results; a non-placeholder passes
/// through; an index out of range is `target_missing`.
pub fn resolve_placeholder(value: &str, results: &[OpResult]) -> Result<String> {
    let Some((op_idx, id_idx)) = parse_placeholder(value) else {
        return Ok(value.to_owned());
    };
    results
        .get(op_idx)
        .and_then(|r| r.ids.get(id_idx))
        .filter(|id| !id.is_empty())
        .cloned()
        .ok_or_else(|| {
            MutationError::new(
                ErrorCode::TargetMissing,
                format!("placeholder {value} did not resolve"),
            )
        })
}

/// Resolve the placeholders a `To` may carry (`parent`, `before`/`after`).
pub fn resolve_to(to: &To, results: &[OpResult]) -> Result<To> {
    let parent = match &to.parent {
        Parent::Block(id) => Parent::Block(resolve_placeholder(id, results)?),
        other => other.clone(),
    };
    let at = match &to.at {
        At::Before(id) => At::Before(resolve_placeholder(id, results)?),
        At::After(id) => At::After(resolve_placeholder(id, results)?),
        other => other.clone(),
    };
    Ok(To { parent, at })
}

/// Resolve every placeholder-bearing field of an op (`block`, `blocks[]`,
/// `to`), as `apply` does before dispatching it.
pub fn resolve_op(op: &Op, results: &[OpResult]) -> Result<Op> {
    let ids = |list: &[String]| -> Result<Vec<String>> {
        list.iter()
            .map(|b| resolve_placeholder(b, results))
            .collect()
    };
    Ok(match op {
        Op::Insert { doc, to, markdown } => Op::Insert {
            doc: doc.clone(),
            to: resolve_to(to, results)?,
            markdown: markdown.clone(),
        },
        Op::Update {
            block,
            markdown,
            attrs,
            expect,
            trivia,
            child_ids,
        } => Op::Update {
            block: resolve_placeholder(block, results)?,
            markdown: markdown.clone(),
            attrs: attrs.clone(),
            expect: expect.clone(),
            trivia: trivia.clone(),
            child_ids: child_ids.clone(),
        },
        Op::Move { blocks, to } => Op::Move {
            blocks: ids(blocks)?,
            to: resolve_to(to, results)?,
        },
        Op::Remove { blocks, expect } => Op::Remove {
            blocks: ids(blocks)?,
            expect: expect.clone(),
        },
        Op::Split { block, at, expect } => Op::Split {
            block: resolve_placeholder(block, results)?,
            at: at.clone(),
            expect: expect.clone(),
        },
        Op::Merge {
            blocks,
            separator,
            expect,
        } => Op::Merge {
            blocks: ids(blocks)?,
            separator: separator.clone(),
            expect: expect.clone(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_parse_and_resolve() {
        assert_eq!(parse_placeholder("$0.ids[1]"), Some((0, 1)));
        assert_eq!(parse_placeholder("$12.ids[0]"), Some((12, 0)));
        assert_eq!(parse_placeholder("b_x"), None);
        assert_eq!(parse_placeholder("$a.ids[0]"), None);
        assert_eq!(parse_placeholder("$0.ids[]"), None);
        let results = vec![OpResult::ids(vec!["b_1".into(), "b_2".into()])];
        assert_eq!(resolve_placeholder("$0.ids[1]", &results).unwrap(), "b_2");
        assert_eq!(resolve_placeholder("b_9", &results).unwrap(), "b_9");
        let e = resolve_placeholder("$0.ids[2]", &results).unwrap_err();
        assert_eq!(e.code, ErrorCode::TargetMissing);
        let e = resolve_placeholder("$1.ids[0]", &results).unwrap_err();
        assert_eq!(e.code, ErrorCode::TargetMissing);
        let to = To {
            parent: Parent::Block("$0.ids[0]".into()),
            at: At::After("$0.ids[1]".into()),
        };
        assert_eq!(
            resolve_to(&to, &results).unwrap(),
            To {
                parent: Parent::Block("b_1".into()),
                at: At::After("b_2".into()),
            }
        );
        let op = Op::Move {
            blocks: vec!["$0.ids[0]".into()],
            to: To {
                parent: Parent::Doc,
                at: At::Start,
            },
        };
        assert!(
            matches!(resolve_op(&op, &results).unwrap(), Op::Move { blocks, .. } if blocks == ["b_1"])
        );
    }

    #[test]
    fn ops_round_trip_through_json() {
        let ops = json!([
            { "op": "insert", "doc": "a.md", "to": { "parent": { "doc": true }, "at": "end" }, "markdown": "x" },
            { "op": "insert", "to": { "parent": { "heading": "b_0", "scope": "section" }, "at": { "after": "b_1" } }, "markdown": "x" },
            { "op": "update", "block": "b_1", "markdown": "y", "attrs": { "checked": true }, "expect": { "content_hash": "ab" }, "trivia": "\n", "child_ids": { "/0": "b_2" } },
            { "op": "move", "blocks": ["b_1"], "to": { "parent": "b_0", "at": { "before": "b_2" } } },
            { "op": "remove", "blocks": ["b_1"], "expect": { "b_1": { "content_hash": "ab" } } },
            { "op": "split", "block": "b_1", "at": [3, 7], "expect": { "content_hash": "ab" } },
            { "op": "merge", "blocks": ["b_1", "b_2"], "separator": "\n" },
        ]);
        for v in ops.as_array().unwrap() {
            let op = Op::from_json(v).unwrap();
            assert_eq!(op.to_json(), *v);
        }
        // The reference's `childIds` spelling and `parent: null` are accepted.
        let op =
            Op::from_json(&json!({ "op": "update", "block": "b", "childIds": { "/0": "b_2" } }))
                .unwrap();
        assert!(matches!(op, Op::Update { child_ids: Some(c), .. } if c["/0"] == "b_2"));
        let to = to_from_json(&json!({ "parent": null, "at": "start" })).unwrap();
        assert_eq!(to.parent, Parent::Doc);
        assert!(Op::from_json(&json!({ "op": "nope" })).is_err());
        assert!(Op::from_json(&json!({ "op": "split", "block": "b", "at": [-1] })).is_err());
    }
}
