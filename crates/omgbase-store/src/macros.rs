//! Macros (`spec/mutate/README.md` §5): each expands deterministically to
//! kernel ops the caller then applies (and sees). The expansions read the
//! store — live hashes for the CAS tokens, the section runs, the `nodes`
//! rows for `node_set`, the candidate blocks for `links_repair`.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use omgbase_format::hash::hex;
use omgbase_mutate::{At, ErrorCode, Expect, MutationError, Op, Parent, To};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::Store;
use crate::error::{Error, Result};
use crate::links::{glob_clause, rewrite_link_destinations, split_destination};
use crate::read::blob_text;

fn raw_hash_of_block(conn: &Connection, block_id: &str) -> Result<Option<String>> {
    let h: Option<Vec<u8>> = conn
        .query_row(
            "SELECT raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(h.map(|h| hex(&h)))
}

fn raw_of_block(conn: &Connection, block_id: &str) -> Result<Option<String>> {
    let h: Option<Vec<u8>> = conn
        .query_row(
            "SELECT raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()?;
    h.map(|h| blob_text(conn, &h)).transpose()
}

fn update_markdown(block: &str, markdown: String, hash: Option<String>) -> Op {
    Op::Update {
        block: block.to_owned(),
        markdown: Some(markdown),
        attrs: None,
        expect: hash.map(Expect::content),
        trivia: None,
        child_ids: None,
    }
}

/// One rewritten block of a link repair (a dry-run preview).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetargetHit {
    pub block: String,
    /// The block's document path.
    pub path: String,
    pub old_raw: String,
    pub new_raw: String,
}

/// A `from` → `to` destination rewrite.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRepair {
    pub from: String,
    pub to: String,
}

/// A pair with how many destinations it matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRepairCount {
    pub from: String,
    pub to: String,
    pub hits: usize,
}

/// What `links_repair` returns (§5).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkRepairPlan {
    /// One `update` per rewritten top-most block.
    pub ops: Vec<Op>,
    pub hits: Vec<RetargetHit>,
    pub pairs: Vec<LinkRepairCount>,
}

impl LinkRepairPlan {
    /// `{ hits: [{ block, path, old_raw, new_raw }], pairs: [{ from, to, hits }] }`
    /// — the extra the fixture records beside `ops`.
    #[must_use]
    pub fn extras_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert(
            "hits".to_owned(),
            Value::Array(
                self.hits
                    .iter()
                    .map(|h| json!({ "block": h.block, "path": h.path, "old_raw": h.old_raw, "new_raw": h.new_raw }))
                    .collect(),
            ),
        );
        m.insert(
            "pairs".to_owned(),
            Value::Array(
                self.pairs
                    .iter()
                    .map(|p| json!({ "from": p.from, "to": p.to, "hits": p.hits }))
                    .collect(),
            ),
        );
        m
    }
}

fn strip_slash(s: &str) -> &str {
    s.strip_prefix('/').unwrap_or(s)
}

/// Whether authored destination `dest` names the same target as `from`
/// (whole destination first, then the path part with its fragment riding
/// along); the fragment to re-append.
fn destination_match<'a>(dest: &'a str, from: &str) -> Option<&'a str> {
    if strip_slash(dest) == strip_slash(from) {
        return Some("");
    }
    let (path, fragment) = split_destination(dest);
    (!fragment.is_empty() && strip_slash(path) == strip_slash(from)).then_some(fragment)
}

static HEADING_LEVEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,6})\s").expect("regex"));

/// The editable property names for a `(format, kind)`.
#[must_use]
pub fn editable_props_for(format: &str, kind: &str) -> Vec<&'static str> {
    if format != "markdown" {
        return Vec::new();
    }
    match kind {
        "md:link" => vec!["name", "value"],
        "md:task" => vec!["checked"],
        _ => Vec::new(),
    }
}

static LINK_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[[^\]]*\]").expect("regex"));
static LINK_TARGET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\]\(([^)\s]+)(\s+"[^"]*")?\)$"#).expect("regex"));

impl Store {
    /// §5 `tasks_complete`: one `update { attrs: { checked: true } }` per
    /// block, with the live CAS token when the block is known.
    pub fn tasks_complete(&self, blocks: &[String]) -> Result<Vec<Op>> {
        let mut attrs = Map::new();
        attrs.insert("checked".to_owned(), json!(true));
        blocks
            .iter()
            .map(|b| {
                Ok(Op::Update {
                    block: b.clone(),
                    markdown: None,
                    attrs: Some(attrs.clone()),
                    expect: raw_hash_of_block(&self.conn, b)?.map(Expect::content),
                    trivia: None,
                    child_ids: None,
                })
            })
            .collect()
    }

    /// §5 `sections_append`.
    #[must_use]
    pub fn sections_append(heading: &str, markdown: &str) -> Vec<Op> {
        vec![Op::Insert {
            doc: None,
            to: To {
                parent: Parent::Section {
                    heading: heading.to_owned(),
                },
                at: At::End,
            },
            markdown: markdown.to_owned(),
        }]
    }

    /// §5 `docs_append`.
    #[must_use]
    pub fn docs_append(doc: &str, markdown: &str) -> Vec<Op> {
        vec![Op::Insert {
            doc: Some(doc.to_owned()),
            to: To {
                parent: Parent::Doc,
                at: At::End,
            },
            markdown: markdown.to_owned(),
        }]
    }

    /// §5 `sections_rename`: the level from the live raw's leading `#` run.
    pub fn sections_rename(&self, heading: &str, title: &str) -> Result<Vec<Op>> {
        let raw = raw_of_block(&self.conn, heading)?.unwrap_or_default();
        let level = HEADING_LEVEL.captures(&raw).map_or(1, |c| c[1].len());
        let hash = raw_hash_of_block(&self.conn, heading)?;
        Ok(vec![update_markdown(
            heading,
            format!("{} {title}", "#".repeat(level)),
            hash,
        )])
    }

    /// §5 `sections_move`: the heading's section run (top-level ids from the
    /// heading to before the next heading of level ≤ its own); `[]` when the
    /// heading is unknown.
    pub fn sections_move(&self, heading: &str, to: &To) -> Result<Vec<Op>> {
        let row: Option<(String, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT doc_id, json_extract(attrs, '$.level') FROM blocks WHERE block_id = ?1",
                params![heading],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, level)) = row else {
            return Ok(Vec::new());
        };
        let level = level.unwrap_or(1);
        let tops: Vec<(String, String, Option<i64>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT block_id, type, json_extract(attrs, '$.level') FROM blocks
                 WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_commit IS NULL ORDER BY ordinal",
            )?;
            let it = stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        };
        // JavaScript `findIndex`/`slice` semantics, including a -1 start.
        let start_idx: i64 = tops
            .iter()
            .position(|t| t.0 == heading)
            .map_or(-1, |i| i as i64);
        let mut end = tops.len();
        for (i, t) in tops.iter().enumerate() {
            if (i as i64) <= start_idx {
                continue;
            }
            if t.1 == "heading" && t.2.unwrap_or(1) <= level {
                end = i;
                break;
            }
        }
        let start = if start_idx < 0 {
            (tops.len() as i64 + start_idx).max(0) as usize
        } else {
            start_idx as usize
        };
        let run: Vec<String> = if start < end {
            tops[start..end].iter().map(|t| t.0.clone()).collect()
        } else {
            Vec::new()
        };
        Ok(vec![Op::Move {
            blocks: run,
            to: to.clone(),
        }])
    }

    /// §5 `lists_insert_item`.
    #[must_use]
    pub fn lists_insert_item(anchor: &str, at: At, markdown: &str) -> Vec<Op> {
        let item = if markdown.trim_start().starts_with("- ") {
            markdown.to_owned()
        } else {
            format!("- {markdown}")
        };
        vec![Op::Insert {
            doc: None,
            to: To {
                parent: Parent::Block(anchor.to_owned()),
                at,
            },
            markdown: item,
        }]
    }

    /// §5 `node_set`: the adapter's editor for `(kind, prop)` over the node's
    /// block raw and byte span → one `update` with the CAS token.
    pub fn node_set(&self, node_id: &str, prop: &str, value: &str) -> Result<Vec<Op>> {
        type NodeRow = (
            String,
            Option<String>,
            Option<String>,
            String,
            Option<i64>,
            Option<i64>,
            Option<String>,
            String,
        );
        let row: Option<NodeRow> = self
            .conn
            .query_row(
                "SELECT n.kind, n.name, n.value, n.attrs, n.span_start, n.span_end, n.block_id, d.format
                 FROM nodes n JOIN docs d ON d.doc_id = n.doc_id WHERE n.node_id = ?1",
                params![node_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()?;
        let Some((kind, _name, _value, _attrs, span_start, span_end, block_id, format)) = row
        else {
            return Err(MutationError::new(
                ErrorCode::BlockMissing,
                format!("node {node_id} not found"),
            )
            .into());
        };
        let Some(block_id) = block_id else {
            return Err(MutationError::new(
                ErrorCode::NodeNotEditable,
                format!("node {node_id} is not anchored to a block"),
            )
            .into());
        };
        let editable = editable_props_for(&format, &kind);
        if !editable.contains(&prop) {
            return Err(MutationError::with_data(
                ErrorCode::NodeNotEditable,
                format!("no editor for {kind}.{prop}"),
                json!({ "kind": kind, "prop": prop, "editable": editable }),
            )
            .into());
        }
        let Some(block_raw) = raw_of_block(&self.conn, &block_id)? else {
            return Err(MutationError::new(
                ErrorCode::BlockMissing,
                format!("block {block_id} not found"),
            )
            .into());
        };
        let hash = raw_hash_of_block(&self.conn, &block_id)?;
        let span = match (span_start, span_end) {
            (Some(s), Some(e)) => {
                let s = usize::try_from(s).unwrap_or(0).min(block_raw.len());
                let e = usize::try_from(e).unwrap_or(0).clamp(s, block_raw.len());
                Some((s, e))
            }
            _ => None,
        };
        let seg = |(s, e): (usize, usize)| -> Result<&str> {
            block_raw.get(s..e).ok_or_else(|| {
                Error::Other(format!("node span {s}..{e} is not on a char boundary"))
            })
        };
        match (kind.as_str(), prop) {
            ("md:link", "name") => {
                let span = span
                    .ok_or_else(|| Error::Other("md:link.name requires a recorded span".into()))?;
                let seg = seg(span)?;
                let rebuilt = LINK_TEXT
                    .replace(seg, format!("[{value}]").as_str())
                    .into_owned();
                if rebuilt == seg {
                    return Err(Error::Other(format!(
                        "could not locate link text in {}",
                        serde_json::to_string(seg).unwrap_or_default()
                    )));
                }
                let md = format!("{}{rebuilt}{}", &block_raw[..span.0], &block_raw[span.1..]);
                Ok(vec![update_markdown(&block_id, md, hash)])
            }
            ("md:link", "value") => {
                let span = span
                    .ok_or_else(|| Error::Other("md:link.value requires a recorded span".into()))?;
                let seg = seg(span)?;
                let rebuilt = LINK_TARGET
                    .replace(seg, |caps: &regex::Captures<'_>| {
                        format!("]({value}{})", caps.get(2).map_or("", |m| m.as_str()))
                    })
                    .into_owned();
                if rebuilt == seg {
                    return Err(Error::Other(format!(
                        "could not locate link target in {}",
                        serde_json::to_string(seg).unwrap_or_default()
                    )));
                }
                let md = format!("{}{rebuilt}{}", &block_raw[..span.0], &block_raw[span.1..]);
                Ok(vec![update_markdown(&block_id, md, hash)])
            }
            ("md:task", "checked") => {
                let mut attrs = Map::new();
                attrs.insert("checked".to_owned(), json!(value == "true" || value == "1"));
                Ok(vec![Op::Update {
                    block: block_id,
                    markdown: None,
                    attrs: Some(attrs),
                    expect: hash.map(Expect::content),
                    trivia: None,
                    child_ids: None,
                }])
            }
            _ => unreachable!("editable props are enumerated above"),
        }
    }

    /// §5 `links_retarget`: the one-pair form of [`Store::links_repair`].
    pub fn links_retarget(
        &self,
        repo_id: &str,
        from: &str,
        to: &str,
        path_glob: Option<&str>,
    ) -> Result<LinkRepairPlan> {
        self.links_repair(
            repo_id,
            &[LinkRepair {
                from: from.to_owned(),
                to: to.to_owned(),
            }],
            path_glob,
        )
    }

    /// §5 `links_repair`: for every live non-`code_fence` block whose raw
    /// contains a slash-less `from`, rewrite each whole link destination that
    /// names it (first matching pair wins, fragment re-appended, never inside
    /// code spans); one `update` per changed top-most block.
    pub fn links_repair(
        &self,
        repo_id: &str,
        repairs: &[LinkRepair],
        path_glob: Option<&str>,
    ) -> Result<LinkRepairPlan> {
        let mut pairs: Vec<LinkRepairCount> = repairs
            .iter()
            .map(|r| LinkRepairCount {
                from: r.from.clone(),
                to: r.to.clone(),
                hits: 0,
            })
            .collect();
        let effective: Vec<usize> = pairs
            .iter()
            .enumerate()
            .filter(|(_, r)| !strip_slash(&r.from).is_empty() && r.from != r.to)
            .map(|(i, _)| i)
            .collect();
        if effective.is_empty() {
            return Ok(LinkRepairPlan {
                ops: Vec::new(),
                hits: Vec::new(),
                pairs,
            });
        }
        let (glob_sql, glob_param) = match path_glob {
            Some(g) => {
                let (clause, param) = glob_clause("d.path", g);
                (format!("AND {clause}"), Some(param))
            }
            None => (String::new(), None),
        };
        let sql = format!(
            "SELECT bl.block_id, bl.parent_block, d.path, b.bytes
             FROM blocks bl
             JOIN blobs b ON b.hash = bl.raw_hash
             JOIN docs d ON d.doc_id = bl.doc_id
             WHERE bl.repo_id = ?1 AND bl.deleted_commit IS NULL AND d.deleted_commit IS NULL
               AND bl.type != 'code_fence' AND instr(b.bytes, ?2) > 0 {glob_sql}
             ORDER BY d.path, bl.depth, bl.ordinal, bl.block_id"
        );
        struct Candidate {
            parent: Option<String>,
            path: String,
            raw: String,
        }
        let mut order: Vec<String> = Vec::new();
        let mut candidates: HashMap<String, Candidate> = HashMap::new();
        let mut keys_seen: Vec<String> = Vec::new();
        for &i in &effective {
            let key = strip_slash(&pairs[i].from).to_owned();
            if keys_seen.contains(&key) {
                continue;
            }
            keys_seen.push(key.clone());
            let mut stmt = self.conn.prepare(&sql)?;
            let rows: Vec<(String, Option<String>, String, Vec<u8>)> = match &glob_param {
                Some(p) => stmt
                    .query_map(params![repo_id, key, p], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
                None => stmt
                    .query_map(params![repo_id, key], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            };
            for (block_id, parent, path, bytes) in rows {
                if let std::collections::hash_map::Entry::Vacant(slot) =
                    candidates.entry(block_id.clone())
                {
                    order.push(block_id);
                    slot.insert(Candidate {
                        parent,
                        path,
                        raw: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                }
            }
        }
        struct Changed {
            parent: Option<String>,
            path: String,
            old_raw: String,
            new_raw: String,
            tally: Vec<usize>,
        }
        let mut changed_order: Vec<String> = Vec::new();
        let mut changed: HashMap<String, Changed> = HashMap::new();
        for block_id in &order {
            let c = &candidates[block_id];
            let mut tally = vec![0usize; effective.len()];
            let new_raw = rewrite_link_destinations(&c.raw, |dest| {
                for (k, &i) in effective.iter().enumerate() {
                    if let Some(fragment) = destination_match(dest, &pairs[i].from) {
                        tally[k] += 1;
                        return Some(format!("{}{fragment}", pairs[i].to));
                    }
                }
                None
            });
            if new_raw != c.raw {
                changed_order.push(block_id.clone());
                changed.insert(
                    block_id.clone(),
                    Changed {
                        parent: c.parent.clone(),
                        path: c.path.clone(),
                        old_raw: c.raw.clone(),
                        new_raw,
                        tally,
                    },
                );
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
        let mut ops = Vec::new();
        let mut hits = Vec::new();
        for block_id in &changed_order {
            let c = &changed[block_id];
            let mut p = c.parent.clone();
            let mut has_changed_ancestor = false;
            while let Some(pid) = p {
                if changed.contains_key(&pid) {
                    has_changed_ancestor = true;
                    break;
                }
                p = parent_of(&pid)?;
            }
            if has_changed_ancestor {
                continue;
            }
            for (k, &i) in effective.iter().enumerate() {
                pairs[i].hits += c.tally[k];
            }
            let hash = raw_hash_of_block(&self.conn, block_id)?;
            ops.push(update_markdown(block_id, c.new_raw.clone(), hash));
            hits.push(RetargetHit {
                block: block_id.clone(),
                path: c.path.clone(),
                old_raw: c.old_raw.clone(),
                new_raw: c.new_raw.clone(),
            });
        }
        Ok(LinkRepairPlan { ops, hits, pairs })
    }
}

/// Parse a macro's `expect`-free op list back from JSON (for callers that
/// carry expansions as JSON).
pub fn ops_from_json(v: &Value) -> Result<Vec<Op>> {
    v.as_array()
        .ok_or_else(|| Error::Other("ops must be an array".into()))?
        .iter()
        .map(|o| Op::from_json(o).map_err(Error::Other))
        .collect()
}

/// A `BTreeMap` of per-block expectations from JSON.
pub fn expect_map_from_json(v: &Value) -> Result<BTreeMap<String, Expect>> {
    let obj = v
        .as_object()
        .ok_or_else(|| Error::Other("expect must be an object".into()))?;
    obj.iter()
        .map(|(k, e)| {
            let h = e
                .get("content_hash")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Ok((
                k.clone(),
                Expect {
                    content_hash: h,
                    parent_children_hash: e
                        .get("parent_children_hash")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_matching_ignores_one_leading_slash_and_keeps_fragments() {
        assert_eq!(destination_match("/x.md", "x.md"), Some(""));
        assert_eq!(destination_match("x.md", "/x.md"), Some(""));
        assert_eq!(destination_match("/x.md#S", "/x.md"), Some("#S"));
        assert_eq!(destination_match("/x.md^r", "x.md"), Some("^r"));
        assert_eq!(destination_match("/xx.md", "x.md"), None);
        assert_eq!(destination_match("/a/x.md", "x.md"), None);
    }

    #[test]
    fn pure_expansions() {
        let ops = Store::sections_append("b_1", "text");
        assert!(
            matches!(&ops[0], Op::Insert { doc: None, to, markdown } if to.parent == Parent::Section { heading: "b_1".into() } && markdown == "text")
        );
        let ops = Store::docs_append("a.md", "text");
        assert!(matches!(&ops[0], Op::Insert { doc: Some(d), .. } if d == "a.md"));
        let ops = Store::lists_insert_item("b_0", At::End, "four");
        assert!(matches!(&ops[0], Op::Insert { markdown, .. } if markdown == "- four"));
        let ops = Store::lists_insert_item("b_0", At::Start, "  - zero");
        assert!(matches!(&ops[0], Op::Insert { markdown, .. } if markdown == "  - zero"));
        assert_eq!(editable_props_for("markdown", "md:link"), ["name", "value"]);
        assert_eq!(editable_props_for("markdown", "md:task"), ["checked"]);
        assert!(editable_props_for("markdown", "md:section").is_empty());
        assert!(editable_props_for("yaml", "md:link").is_empty());
    }
}
