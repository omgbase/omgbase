//! Node projection (§2): the Markdown adapter's nodes over each block's
//! masked raw, the `md:section` shape the store appends, ordinals and
//! `node_id`.

use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::{AttrValue, BlockKind};
use omgbase_properties::DocBlock;
use regex::Regex;
use serde_json::{Map as JsonMap, Value as Json};

use crate::mask::mask_code_bytes;

/// JavaScript's `\s` (WhiteSpace + LineTerminator), as a regex class body:
/// the reference's patterns run without the `u` flag, so `\s` is this set,
/// not Unicode `White_Space` (U+0085 is not in it; U+FEFF is).
pub(crate) const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// JavaScript's multiline `^`/`$` sit at these line terminators.
pub(crate) const JS_LINE_TERMINATORS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];

/// `\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`.
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"\[([^\]]*)\]\(([^){JS_WS}]+)(?:[{JS_WS}]+"[^"]*")?\)"#
    ))
    .expect("valid")
});
/// `\[\[([^\]]+)\]\]`.
static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]]+)\]\]").expect("valid"));
/// `\^([a-zA-Z0-9_-]+)`.
static ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\^([a-zA-Z0-9_-]+)").expect("valid"));
/// The bracketed inline field of `spec/properties` §3.2 (the reference's
/// `i` flag only widens `[a-z]` to ASCII letters).
static BRACKETED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\[(]([A-Za-z][A-Za-z0-9_]*)::[ \t]*([^\]\n)]*?)[ \t]*[\])]").expect("valid")
});

/// A node kind (§2.1, §2.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    Link,
    Wikilink,
    Task,
    Anchor,
    InlineField,
    Section,
}

impl NodeKind {
    /// The `nodes.kind` string.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Link => "md:link",
            NodeKind::Wikilink => "md:wikilink",
            NodeKind::Task => "md:task",
            NodeKind::Anchor => "md:anchor",
            NodeKind::InlineField => "md:inline_field",
            NodeKind::Section => "md:section",
        }
    }

    /// The inverse of [`NodeKind::as_str`].
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "md:link" => Some(NodeKind::Link),
            "md:wikilink" => Some(NodeKind::Wikilink),
            "md:task" => Some(NodeKind::Task),
            "md:anchor" => Some(NodeKind::Anchor),
            "md:inline_field" => Some(NodeKind::InlineField),
            "md:section" => Some(NodeKind::Section),
            _ => None,
        }
    }
}

impl fmt::Display for NodeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One projected node before it has an id (§2.1, §2.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedNode {
    pub kind: NodeKind,
    /// The block the node is anchored to (a real id at ingest).
    pub block_id: String,
    pub name: Option<String>,
    pub value: Option<String>,
    /// `[start, end)` **byte** offsets into the block's UTF-8 `raw`, or
    /// `None` (sections).
    pub span: Option<(usize, usize)>,
    /// JSON object.
    pub attrs: JsonMap<String, Json>,
}

impl ProjectedNode {
    fn new(kind: NodeKind, block_id: &str) -> Self {
        Self {
            kind,
            block_id: block_id.to_owned(),
            name: None,
            value: None,
            span: None,
            attrs: JsonMap::new(),
        }
    }

    /// §2.2: an `md:section` node for a `sections` row (`name` = the
    /// heading's text; `attrs = { level, first_ordinal, last_ordinal }`; no
    /// span).
    #[must_use]
    pub fn section(
        heading_block: &str,
        text: &str,
        level: i64,
        first_ordinal: i64,
        last_ordinal: i64,
    ) -> Self {
        let mut attrs = JsonMap::new();
        attrs.insert("level".to_owned(), Json::from(level));
        attrs.insert("first_ordinal".to_owned(), Json::from(first_ordinal));
        attrs.insert("last_ordinal".to_owned(), Json::from(last_ordinal));
        Self {
            kind: NodeKind::Section,
            block_id: heading_block.to_owned(),
            name: Some(text.to_owned()),
            value: None,
            span: None,
            attrs,
        }
    }
}

/// The line form of an inline field over one line (already split at the
/// JavaScript line terminators): `^[ \t]*([a-z][a-z0-9_]*)::[ \t]*([^\n]*?)[ \t]*$`
/// with `i`. Returns `(key, value, start, end)` with the offsets relative to
/// the line: `start` after the leading blanks (where the key begins), `end`
/// where the trimmed value ends (§2.1).
pub(crate) fn line_field(line: &str) -> Option<(&str, &str, usize, usize)> {
    let lead = line.len() - line.trim_start_matches([' ', '\t']).len();
    let rest = &line[lead..];
    let mut key_end = 0;
    for (i, c) in rest.char_indices() {
        let ok = if i == 0 {
            c.is_ascii_alphabetic()
        } else {
            c.is_ascii_alphanumeric() || c == '_'
        };
        if !ok {
            break;
        }
        key_end = i + c.len_utf8();
    }
    if key_end == 0 {
        return None;
    }
    let key = &rest[..key_end];
    let after = rest[key_end..].strip_prefix("::")?;
    let value = after
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t']);
    let end = line.len() - line.trim_end_matches([' ', '\t']).len();
    Some((key, value, lead, line.len() - end))
}

fn scan_block(b: &DocBlock<'_>, out: &mut Vec<ProjectedNode>) {
    let id = b.block_id;
    // Code is not prose: a code_fence projects nothing; inline code is masked.
    let scan = if b.kind == BlockKind::CodeFence {
        String::new()
    } else {
        mask_code_bytes(b.raw)
    };
    for m in LINK.captures_iter(&scan) {
        let whole = m.get(0).expect("match");
        let mut n = ProjectedNode::new(NodeKind::Link, id);
        n.name = Some(m[1].to_owned());
        n.value = Some(m[2].to_owned());
        n.span = Some((whole.start(), whole.end()));
        out.push(n);
    }
    for m in WIKILINK.captures_iter(&scan) {
        let whole = m.get(0).expect("match");
        let mut n = ProjectedNode::new(NodeKind::Wikilink, id);
        n.value = Some(m[1].to_owned());
        n.span = Some((whole.start(), whole.end()));
        out.push(n);
    }
    if b.kind == BlockKind::Task {
        let checked = matches!(b.attrs.get("checked"), Some(AttrValue::Bool(true)));
        let mut n = ProjectedNode::new(NodeKind::Task, id);
        n.value = Some(b.text.to_owned());
        n.span = Some((0, b.raw.len()));
        n.attrs.insert("checked".to_owned(), Json::Bool(checked));
        out.push(n);
    }
    for m in ANCHOR.captures_iter(&scan) {
        let whole = m.get(0).expect("match");
        let mut n = ProjectedNode::new(NodeKind::Anchor, id);
        n.name = Some(m[1].to_owned());
        n.span = Some((whole.start(), whole.end()));
        out.push(n);
    }
    for m in BRACKETED.captures_iter(&scan) {
        let whole = m.get(0).expect("match");
        let mut n = ProjectedNode::new(NodeKind::InlineField, id);
        n.name = Some(m[1].to_owned());
        n.value = Some(m[2].to_owned());
        n.span = Some((whole.start(), whole.end()));
        out.push(n);
    }
    let mut line_start = 0;
    for line in scan.split(JS_LINE_TERMINATORS) {
        if let Some((key, value, start, end)) = line_field(line) {
            let mut n = ProjectedNode::new(NodeKind::InlineField, id);
            n.name = Some(key.to_owned());
            n.value = Some(value.to_owned());
            n.span = Some((line_start + start, line_start + end));
            out.push(n);
        }
        // Every terminator is one byte except U+2028/U+2029 (three); recover
        // the width from the source.
        let next = line_start + line.len();
        line_start = match scan[next..].chars().next() {
            Some(t) => next + t.len_utf8(),
            None => next,
        };
    }
    for child in &b.children {
        scan_block(child, out);
    }
}

/// §2.1: the Markdown adapter's nodes over the body blocks in pre-order —
/// per block, all links, all wikilinks, the task, all anchors, then the
/// inline fields (bracketed, then line form). Containers are scanned too, so
/// a feature inside a list item is projected once for the list and once for
/// the item (§8). Spans are bytes into the block's `raw`.
#[must_use]
pub fn project_nodes(blocks: &[DocBlock<'_>]) -> Vec<ProjectedNode> {
    let mut out = Vec::new();
    for b in blocks {
        scan_block(b, &mut out);
    }
    out
}

/// §2.3: `"n_"` + the first 12 hex of
/// `sha256(doc_id + "|" + block_id + "|" + kind + "|" + ordinal)`.
#[must_use]
pub fn node_id(doc_id: &str, block_id: &str, kind: &str, ordinal: u32) -> String {
    let digest = sha256(format!("{doc_id}|{block_id}|{kind}|{ordinal}").as_bytes());
    format!("n_{}", &hex(&digest)[..12])
}

/// A node with its id and ordinal (§2.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRow<'a> {
    pub node_id: String,
    /// The count of earlier nodes of the same `(kind, block_id)`.
    pub ordinal: u32,
    pub node: &'a ProjectedNode,
}

/// §2.3: assign ordinals and ids to a document's nodes in list order (the
/// adapter nodes followed by the section nodes).
#[must_use]
pub fn node_rows<'a>(doc_id: &str, nodes: &'a [ProjectedNode]) -> Vec<NodeRow<'a>> {
    let mut counters: HashMap<(NodeKind, &str), u32> = HashMap::new();
    nodes
        .iter()
        .map(|n| {
            let ordinal = counters.entry((n.kind, n.block_id.as_str())).or_insert(0);
            let this = *ordinal;
            *ordinal += 1;
            NodeRow {
                node_id: node_id(doc_id, &n.block_id, n.kind.as_str(), this),
                ordinal: this,
                node: n,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::parse_markdown;

    fn nodes_of(source: &str) -> Vec<ProjectedNode> {
        let tree = parse_markdown(source);
        let ids: Vec<String> = (0..DocBlock::count(&tree.children))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        project_nodes(&blocks)
    }

    /// `(kind, block_id, name, value, span)`.
    type View<'a> = (
        NodeKind,
        &'a str,
        Option<&'a str>,
        Option<&'a str>,
        Option<(usize, usize)>,
    );

    fn view(nodes: &[ProjectedNode]) -> Vec<View<'_>> {
        nodes
            .iter()
            .map(|n| {
                (
                    n.kind,
                    n.block_id.as_str(),
                    n.name.as_deref(),
                    n.value.as_deref(),
                    n.span,
                )
            })
            .collect()
    }

    #[test]
    fn node_id_is_the_sha256_prefix() {
        let id = node_id("d_0", "b_1", "md:link", 0);
        assert_eq!(id.len(), 14);
        assert_eq!(
            id,
            format!("n_{}", &hex(&sha256(b"d_0|b_1|md:link|0"))[..12])
        );
        assert_ne!(id, node_id("d_0", "b_1", "md:link", 1));
    }

    #[test]
    fn links_with_titles_images_and_spans() {
        let n = nodes_of("See [t](x.md \"title\") and ![alt](img.png)\n");
        assert_eq!(
            view(&n),
            vec![
                (
                    NodeKind::Link,
                    "b_0",
                    Some("t"),
                    Some("x.md"),
                    Some((4, 21))
                ),
                (
                    NodeKind::Link,
                    "b_0",
                    Some("alt"),
                    Some("img.png"),
                    Some((27, 41))
                ),
            ]
        );
        assert!(
            nodes_of("[t](a b)\n").is_empty(),
            "no space in a destination"
        );
        assert!(nodes_of("[t]()\n").is_empty());
        let n = nodes_of("[](x)\n");
        assert_eq!(n[0].name.as_deref(), Some(""));
    }

    #[test]
    fn spans_are_bytes_into_raw() {
        let n = nodes_of("héllo [t](x) `é` [[w]]\n");
        let raw = "héllo [t](x) `é` [[w]]";
        assert_eq!(
            n[0].span,
            Some((raw.find("[t]").unwrap(), raw.find("[t]").unwrap() + 6))
        );
        assert_eq!(n[1].kind, NodeKind::Wikilink);
        assert_eq!(n[1].span, Some((raw.find("[[").unwrap(), raw.len())));
        let n = nodes_of("- [x] dö it\n");
        let task = n.iter().find(|n| n.kind == NodeKind::Task).unwrap();
        assert_eq!(task.span, Some((0, "- [x] dö it".len())));
    }

    #[test]
    fn wikilinks_keep_aliases_and_fragments() {
        let n = nodes_of("[[note|Alias]] [[a#H]] [[b^r]]\n");
        let values: Vec<&str> = n
            .iter()
            .filter(|n| n.kind == NodeKind::Wikilink)
            .map(|n| n.value.as_deref().unwrap())
            .collect();
        assert_eq!(values, ["note|Alias", "a#H", "b^r"]);
        // `^r` inside the wikilink is also an anchor match.
        let anchors: Vec<&str> = n
            .iter()
            .filter(|n| n.kind == NodeKind::Anchor)
            .map(|n| n.name.as_deref().unwrap())
            .collect();
        assert_eq!(anchors, ["r"]);
    }

    #[test]
    fn tasks_project_once_per_nesting_level_of_the_task_only() {
        let n = nodes_of("- [ ] open\n- [x] done\n");
        let tasks: Vec<_> = n
            .iter()
            .filter(|n| n.kind == NodeKind::Task)
            .map(|n| {
                (
                    n.block_id.as_str(),
                    n.value.as_deref().unwrap(),
                    n.attrs["checked"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(tasks, [("b_1", "open", false), ("b_2", "done", true)]);
        assert_eq!(n[0].kind, NodeKind::Task, "the list itself is not a task");
    }

    #[test]
    fn anchors() {
        let n = nodes_of("Para ^ref-1 and ^x_y and ^ (none)\n");
        assert_eq!(
            view(&n),
            vec![
                (NodeKind::Anchor, "b_0", Some("ref-1"), None, Some((5, 11))),
                (NodeKind::Anchor, "b_0", Some("x_y"), None, Some((16, 20))),
            ]
        );
    }

    #[test]
    fn inline_fields_bracketed_then_line_form_with_spans() {
        let n = nodes_of("key:: two words  \nSee [k2:: v] (k3::\tw )\n");
        let fields: Vec<_> = n
            .iter()
            .filter(|n| n.kind == NodeKind::InlineField)
            .map(|n| {
                (
                    n.name.as_deref().unwrap(),
                    n.value.as_deref().unwrap(),
                    n.span.unwrap(),
                )
            })
            .collect();
        let raw = "key:: two words  \nSee [k2:: v] (k3::\tw )";
        assert_eq!(
            fields,
            [
                (
                    "k2",
                    "v",
                    (raw.find("[k2").unwrap(), raw.find("[k2").unwrap() + 8)
                ),
                ("k3", "w", (raw.find("(k3").unwrap(), raw.len())),
                ("key", "two words", (0, 15)),
            ]
        );
        // Leading blanks on a continuation line: the span starts at the key.
        assert_eq!(line_field("  \tkey::  v \t"), Some(("key", "v", 3, 11)));
        assert_eq!(line_field("k::"), Some(("k", "", 0, 3)));
        assert_eq!(line_field("- k:: v"), None);
        assert_eq!(line_field("k: v"), None);
        let n = nodes_of("first\n  key:: v\n");
        assert_eq!(n[0].span, Some((8, 15)));
        // Line form: key at line start only; not after a list marker.
        assert!(
            nodes_of("- k:: v\n")
                .iter()
                .all(|n| n.kind != NodeKind::InlineField)
        );
        // A bracketed field alone on a line is one node.
        assert_eq!(
            nodes_of("[k:: v]\n")
                .iter()
                .filter(|n| n.kind == NodeKind::InlineField)
                .count(),
            1
        );
        // Later lines, CRLF and U+2028 terminators.
        let n = nodes_of("a:: 1\r\nb:: 2\u{2028}c:: 3\n");
        let spans: Vec<_> = n
            .iter()
            .map(|n| (n.name.as_deref().unwrap(), n.span.unwrap()))
            .collect();
        assert_eq!(spans, [("a", (0, 5)), ("b", (7, 12)), ("c", (15, 20))]);
        // Key case preserved; value trimmed.
        let n = nodes_of("Key_1::   v  \n");
        assert_eq!(
            (n[0].name.as_deref(), n[0].value.as_deref(), n[0].span),
            (Some("Key_1"), Some("v"), Some((0, 11)))
        );
        assert_eq!(nodes_of("k::\n")[0].value.as_deref(), Some(""));
    }

    #[test]
    fn code_is_not_prose() {
        assert!(nodes_of("```\n[t](x) [[w]] ^a k:: v\n```\n").is_empty());
        assert!(nodes_of("see `[t](x)` and `[[w]]`\n").is_empty());
        let n = nodes_of("`x` [t](y)\n");
        assert_eq!(n[0].span, Some((4, 10)));
    }

    #[test]
    fn containers_project_once_per_level() {
        let n = nodes_of("- see [t](x)\n");
        assert_eq!(
            view(&n),
            vec![
                (NodeKind::Link, "b_0", Some("t"), Some("x"), Some((6, 12))),
                (NodeKind::Link, "b_1", Some("t"), Some("x"), Some((6, 12))),
            ]
        );
        let n = nodes_of("> [[w]]\n");
        assert_eq!(n[0].block_id, "b_0");
        assert_eq!(n[0].span, Some((2, 7)));
        assert_eq!(n[1].block_id, "b_1");
        assert_eq!(n[1].span, Some((0, 5)));
    }

    #[test]
    fn ordinals_count_per_kind_and_block() {
        let n = nodes_of("[a](x) [b](y) [[w]]\n\n[c](z)\n");
        let rows = node_rows("d_0", &n);
        let view: Vec<(NodeKind, &str, u32)> = rows
            .iter()
            .map(|r| (r.node.kind, r.node.block_id.as_str(), r.ordinal))
            .collect();
        assert_eq!(
            view,
            [
                (NodeKind::Link, "b_0", 0),
                (NodeKind::Link, "b_0", 1),
                (NodeKind::Wikilink, "b_0", 0),
                (NodeKind::Link, "b_1", 0),
            ]
        );
        assert_eq!(rows[0].node_id, node_id("d_0", "b_0", "md:link", 0));
        assert_eq!(rows[1].node_id, node_id("d_0", "b_0", "md:link", 1));
        let mut ids: Vec<&str> = rows.iter().map(|r| r.node_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn section_shape() {
        let s = ProjectedNode::section("b_0", "Title", 1, 0, 3);
        assert_eq!(s.kind, NodeKind::Section);
        assert_eq!(s.name.as_deref(), Some("Title"));
        assert_eq!(s.value, None);
        assert_eq!(s.span, None);
        assert_eq!(
            Json::Object(s.attrs.clone()),
            serde_json::json!({"level": 1, "first_ordinal": 0, "last_ordinal": 3})
        );
        assert_eq!(NodeKind::parse("md:section"), Some(NodeKind::Section));
        assert_eq!(NodeKind::parse("md:x"), None);
        for k in [
            NodeKind::Link,
            NodeKind::Wikilink,
            NodeKind::Task,
            NodeKind::Anchor,
            NodeKind::InlineField,
            NodeKind::Section,
        ] {
            assert_eq!(NodeKind::parse(k.as_str()), Some(k));
        }
    }
}
