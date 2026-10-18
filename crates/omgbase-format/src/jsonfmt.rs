//! The JSON format adapter: a `.json` file as a block tree, the way the
//! reference's `format/json.ts` decomposes it with its own position-tracking
//! scanner (a port, step for step — the reference does not use `JSON.parse`
//! here because it needs source spans, and its scanner is lenient: a missing
//! `:` or a trailing `,` is skipped over, not an error).
//!
//! A root object's members are `json:property` blocks (attrs `{ key }`)
//! spanning the key through the value; a member whose value is an object or
//! an array carries ONE level of children — each member or element as a
//! `json:object`, `json:array` or `json:scalar` by its own shape, attrs
//! `{ key }` (an element's key is its index) — and no grandchildren. A root
//! array's elements are `json:item` blocks (`{ index }`). A scalar root is one
//! `json:scalar`. An empty object or array yields no blocks (the whole file is
//! leading trivia). A text the scanner cannot start on — including an empty
//! file — is one `json:opaque` over its bytes. Only top-level blocks carry
//! trivia (the `{`, `,`s and `}` live there); `text` is `normalize_text(raw)`.
//! The round-trip law holds.

use crate::FormatAdapter;
use crate::block::{AttrValue, Attrs, Block, BlockKind, BlockTree, Span};
use crate::text::{is_js_whitespace, normalize_text};

/// The adapter object (`format = "json"`, `.json`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JsonAdapter;

impl FormatAdapter for JsonAdapter {
    fn format(&self) -> &'static str {
        "json"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &[".json"]
    }

    fn parse(&self, source: &str) -> BlockTree {
        parse(source)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Object,
    Array,
    Scalar,
}

/// The reference's `JsonNode`: a value with its span; a member of an object
/// is a node of kind `Object` (the reference's spelling) carrying the member's
/// `key` and the VALUE's children.
#[derive(Clone, Debug)]
struct Node {
    kind: Kind,
    start: usize,
    end: usize,
    key: Option<String>,
    children: Option<Vec<Node>>,
}

struct Scanner<'a> {
    source: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            bytes: source.as_bytes(),
            pos: 0,
        }
    }

    fn at_end(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    fn peek_char(&self) -> Option<char> {
        self.source[self.pos..].chars().next()
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek_char() {
            if is_js_whitespace(c) {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }

    fn starts_with(&self, s: &str) -> bool {
        self.source[self.pos..].starts_with(s)
    }

    fn parse_value(&mut self) -> Option<Node> {
        self.skip_whitespace();
        if self.at_end() {
            return None;
        }
        let ch = self.bytes[self.pos];
        match ch {
            b'{' => Some(self.parse_object()),
            b'[' => Some(self.parse_array()),
            b'"' => Some(self.parse_string()),
            b'-' | b'0'..=b'9' => Some(self.parse_number()),
            _ => {
                for lit in ["true", "false", "null"] {
                    if self.starts_with(lit) {
                        let start = self.pos;
                        self.pos += lit.len();
                        return Some(Node {
                            kind: Kind::Scalar,
                            start,
                            end: self.pos,
                            key: None,
                            children: None,
                        });
                    }
                }
                None
            }
        }
    }

    /// The reference's `parseString` returns the decoded value; here only the
    /// span and the key text matter.
    fn parse_string(&mut self) -> Node {
        let start = self.pos;
        self.pos += 1; // the opening quote
        while !self.at_end() {
            match self.bytes[self.pos] {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    break;
                }
                _ => self.pos += 1,
            }
        }
        self.pos = self.pos.min(self.bytes.len());
        Node {
            kind: Kind::Scalar,
            start,
            end: self.pos,
            key: None,
            children: None,
        }
    }

    fn parse_number(&mut self) -> Node {
        let start = self.pos;
        if self.bytes.get(self.pos) == Some(&b'-') {
            self.pos += 1;
        }
        self.digits();
        if self.bytes.get(self.pos) == Some(&b'.') {
            self.pos += 1;
            self.digits();
        }
        if matches!(self.bytes.get(self.pos), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.bytes.get(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            self.digits();
        }
        Node {
            kind: Kind::Scalar,
            start,
            end: self.pos,
            key: None,
            children: None,
        }
    }

    fn digits(&mut self) {
        while matches!(self.bytes.get(self.pos), Some(b) if b.is_ascii_digit()) {
            self.pos += 1;
        }
    }

    fn parse_object(&mut self) -> Node {
        let start = self.pos;
        self.pos += 1; // `{`
        let mut children = Vec::new();
        self.skip_whitespace();
        while !self.at_end() && self.bytes[self.pos] != b'}' {
            let before = self.pos;
            self.skip_whitespace();
            let key_node = self.parse_string();
            let key = decode_string(&self.source[key_node.start..key_node.end]);
            self.skip_whitespace();
            if self.bytes.get(self.pos) == Some(&b':') {
                self.pos += 1;
            }
            self.skip_whitespace();
            let prop_start = key_node.start;
            let val = self.parse_value();
            let prop_end = val.as_ref().map_or(self.pos, |v| v.end);
            children.push(Node {
                kind: Kind::Object,
                start: prop_start,
                end: prop_end,
                key: Some(key),
                children: val.and_then(|v| v.children),
            });
            self.skip_whitespace();
            if self.bytes.get(self.pos) == Some(&b',') {
                self.pos += 1;
            }
            if self.pos == before {
                // The reference would spin here; a port must not.
                self.pos += 1;
            }
        }
        if !self.at_end() {
            self.pos += 1; // `}`
        }
        Node {
            kind: Kind::Object,
            start,
            end: self.pos,
            key: None,
            children: Some(children),
        }
    }

    fn parse_array(&mut self) -> Node {
        let start = self.pos;
        self.pos += 1; // `[`
        let mut children = Vec::new();
        self.skip_whitespace();
        let mut index = 0usize;
        while !self.at_end() && self.bytes[self.pos] != b']' {
            let before = self.pos;
            self.skip_whitespace();
            if let Some(mut val) = self.parse_value() {
                val.key = Some(index.to_string());
                children.push(val);
            }
            index += 1;
            self.skip_whitespace();
            if self.bytes.get(self.pos) == Some(&b',') {
                self.pos += 1;
            }
            if self.pos == before {
                self.pos += 1;
            }
        }
        if !self.at_end() {
            self.pos += 1; // `]`
        }
        Node {
            kind: Kind::Array,
            start,
            end: self.pos,
            key: None,
            children: Some(children),
        }
    }
}

/// `JSON.parse(raw)` of a string token, falling back to the quoted text
/// minus its quotes when it does not decode (the reference's `catch`).
fn decode_string(raw: &str) -> String {
    let inner = raw
        .strip_prefix('"')
        .map_or(raw, |s| s.strip_suffix('"').unwrap_or(s));
    if !inner.contains('\\') {
        return inner.to_owned();
    }
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) => out.push(ch),
                    None => return inner.to_owned(),
                }
            }
            _ => return inner.to_owned(),
        }
    }
    out
}

fn make(kind: BlockKind, span: Span, source: &str, attrs: Attrs, children: Vec<Block>) -> Block {
    let raw = &source[span.start..span.end];
    Block {
        kind,
        span,
        raw: raw.to_owned(),
        text: normalize_text(raw),
        attrs,
        children,
        trivia: String::new(),
    }
}

fn key_attrs(key: Option<&str>) -> Attrs {
    let mut attrs = Attrs::new();
    attrs.insert(
        "key".to_owned(),
        AttrValue::Str(key.unwrap_or_default().to_owned()),
    );
    attrs
}

/// `jsonNodeToBlocks`.
fn blocks_of(root: &Node, source: &str) -> Vec<Block> {
    match (root.kind, &root.children) {
        (Kind::Object, Some(members)) => members
            .iter()
            .map(|member| {
                let children = member
                    .children
                    .as_ref()
                    .map(|subs| {
                        subs.iter()
                            .map(|sub| {
                                let kind = match sub.kind {
                                    Kind::Object => BlockKind::JsonObject,
                                    Kind::Array => BlockKind::JsonArray,
                                    Kind::Scalar => BlockKind::JsonScalar,
                                };
                                make(
                                    kind,
                                    Span::new(sub.start, sub.end),
                                    source,
                                    key_attrs(sub.key.as_deref()),
                                    Vec::new(),
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                make(
                    BlockKind::JsonProperty,
                    Span::new(member.start, member.end),
                    source,
                    key_attrs(member.key.as_deref()),
                    children,
                )
            })
            .collect(),
        (Kind::Array, Some(items)) => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let mut attrs = Attrs::new();
                attrs.insert(
                    "index".to_owned(),
                    AttrValue::Int(i64::try_from(i).unwrap_or(i64::MAX)),
                );
                make(
                    BlockKind::JsonItem,
                    Span::new(item.start, item.end),
                    source,
                    attrs,
                    Vec::new(),
                )
            })
            .collect(),
        _ => vec![make(
            BlockKind::JsonScalar,
            Span::new(root.start, root.end),
            source,
            Attrs::new(),
            Vec::new(),
        )],
    }
}

/// Parse a JSON file into its block tree (see the module documentation).
#[must_use]
pub fn parse(source: &str) -> BlockTree {
    let root = Scanner::new(source).parse_value();
    let Some(root) = root else {
        return BlockTree {
            source: source.to_owned(),
            leading_trivia: String::new(),
            children: vec![make(
                BlockKind::JsonOpaque,
                Span::new(0, source.len()),
                source,
                Attrs::new(),
                Vec::new(),
            )],
        };
    };
    let mut children = blocks_of(&root, source);
    let mut cursor = 0;
    children.retain(|b| {
        let keep = b.span.start >= cursor && b.span.end >= b.span.start;
        if keep {
            cursor = b.span.end;
        }
        keep
    });
    let leading_trivia = children
        .first()
        .map_or(source, |b| &source[..b.span.start])
        .to_owned();
    let n = children.len();
    for i in 0..n {
        let end = children[i].span.end;
        let next_start = children.get(i + 1).map_or(source.len(), |b| b.span.start);
        children[i].trivia = source[end..next_start].to_owned();
    }
    BlockTree {
        source: source.to_owned(),
        leading_trivia,
        children,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render;

    fn shape(b: &Block) -> (BlockKind, &str, &str) {
        (b.kind, b.raw.as_str(), b.trivia.as_str())
    }

    fn key(b: &Block) -> &str {
        match b.attrs.get("key") {
            Some(AttrValue::Str(s)) => s.as_str(),
            _ => "?",
        }
    }

    #[test]
    fn root_object_members_with_one_level_of_children() {
        let src = "{\"name\": \"attn\", \"version\": 2, \"features\": {\"focus\": true}, \"tags\": [\"cfg\"]}\n";
        let tree = parse(src);
        assert_eq!(render(&tree), src);
        assert_eq!(tree.leading_trivia, "{");
        let kinds: Vec<_> = tree.children.iter().map(shape).collect();
        assert_eq!(
            kinds,
            vec![
                (BlockKind::JsonProperty, "\"name\": \"attn\"", ", "),
                (BlockKind::JsonProperty, "\"version\": 2", ", "),
                (
                    BlockKind::JsonProperty,
                    "\"features\": {\"focus\": true}",
                    ", "
                ),
                (BlockKind::JsonProperty, "\"tags\": [\"cfg\"]", "}\n"),
            ]
        );
        assert_eq!(key(&tree.children[2]), "features");
        let features = &tree.children[2];
        assert_eq!(features.children.len(), 1);
        assert_eq!(features.children[0].kind, BlockKind::JsonObject);
        assert_eq!(features.children[0].raw, "\"focus\": true");
        assert_eq!(features.children[0].span, Span::new(44, 57));
        assert_eq!(key(&features.children[0]), "focus");
        let tags = &tree.children[3];
        assert_eq!(tags.children[0].kind, BlockKind::JsonScalar);
        assert_eq!(tags.children[0].raw, "\"cfg\"");
        assert_eq!(key(&tags.children[0]), "0");
        assert_eq!(tree.iter().count(), 6);
    }

    #[test]
    fn pretty_printed_and_deep_values() {
        let src = "{\n  \"meta\": {\"owner\": \"alice\", \"depth\": {\"level\": 2}},\n  \"meta.flat\": \"x\",\n  \"items\": [{\"a\": 1}, \"b\"]\n}\n";
        let tree = parse(src);
        assert_eq!(render(&tree), src);
        assert_eq!(tree.leading_trivia, "{\n  ");
        assert_eq!(
            shape(&tree.children[0]),
            (
                BlockKind::JsonProperty,
                "\"meta\": {\"owner\": \"alice\", \"depth\": {\"level\": 2}}",
                ",\n  "
            )
        );
        let meta = &tree.children[0];
        assert_eq!(meta.children.len(), 2);
        assert_eq!(meta.children[1].raw, "\"depth\": {\"level\": 2}");
        assert!(meta.children[1].children.is_empty());
        let items = &tree.children[2];
        assert_eq!(items.trivia, "\n}\n");
        assert_eq!(items.children[0].kind, BlockKind::JsonObject);
        assert_eq!(items.children[0].raw, "{\"a\": 1}");
        assert_eq!(items.children[1].kind, BlockKind::JsonScalar);
        assert_eq!(key(&items.children[1]), "1");

        let tree = parse("{\"a\": {\"b\": {\"c\": 1}}, \"arr\": [[1], {\"x\": 2}]}");
        let arr = &tree.children[1];
        assert_eq!(arr.trivia, "}");
        assert_eq!(arr.children[0].kind, BlockKind::JsonArray);
        assert_eq!(arr.children[0].raw, "[1]");
        assert_eq!(arr.children[1].kind, BlockKind::JsonObject);
    }

    #[test]
    fn root_array_scalar_and_empties() {
        let tree = parse("[1, 2]\n");
        assert_eq!(tree.leading_trivia, "[");
        assert_eq!(shape(&tree.children[0]), (BlockKind::JsonItem, "1", ", "));
        assert_eq!(shape(&tree.children[1]), (BlockKind::JsonItem, "2", "]\n"));
        assert_eq!(
            tree.children[1].attrs.get("index"),
            Some(&AttrValue::Int(1))
        );

        let tree = parse("[{\"a\": 1}, [2], 3]\n");
        assert_eq!(tree.children.len(), 3);
        assert_eq!(tree.children[0].raw, "{\"a\": 1}");
        assert!(tree.children[0].children.is_empty());

        let tree = parse("\"x\"\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonScalar, "\"x\"", "\n")
        );
        assert!(tree.children[0].attrs.is_empty());

        assert!(parse("{}\n").children.is_empty());
        assert_eq!(parse("{}\n").leading_trivia, "{}\n");
        assert!(parse("[]\n").children.is_empty());
        assert_eq!(render(&parse("[]\n")), "[]\n");
    }

    #[test]
    fn lenient_and_unreadable_texts() {
        let tree = parse("{\"a\": 1,}\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonProperty, "\"a\": 1", ",}\n")
        );
        let tree = parse("{\"a\" 1}\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonProperty, "\"a\" 1", "}\n")
        );
        let tree = parse("");
        assert_eq!(shape(&tree.children[0]), (BlockKind::JsonOpaque, "", ""));
        let tree = parse("nope\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonOpaque, "nope\n", "")
        );
        assert_eq!(tree.children[0].text, "nope");
        let tree = parse("  {\"a\":1 , \"b\" : [ ] }  \n");
        assert_eq!(tree.leading_trivia, "  {");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonProperty, "\"a\":1", " , ")
        );
        assert_eq!(
            shape(&tree.children[1]),
            (BlockKind::JsonProperty, "\"b\" : [ ]", " }  \n")
        );
        // A text that never advances the scanner still terminates.
        assert_eq!(render(&parse("[x]")), "[x]");
        assert_eq!(render(&parse("{x}")), "{x}");
    }

    #[test]
    fn escapes_in_keys_and_values() {
        let tree =
            parse("{\"a\": \"x\\\"y\", \"n\": -1.5e3, \"t\": true, \"z\": null, \"k\\n\": 1}\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::JsonProperty, "\"a\": \"x\\\"y\"", ", ")
        );
        assert_eq!(tree.children[1].raw, "\"n\": -1.5e3");
        assert_eq!(tree.children[2].raw, "\"t\": true");
        assert_eq!(tree.children[3].raw, "\"z\": null");
        assert_eq!(key(&tree.children[4]), "k\n");
        assert_eq!(tree.children[4].trivia, "}\n");
    }
}
