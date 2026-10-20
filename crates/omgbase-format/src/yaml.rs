//! The YAML format adapter: a `.yaml`/`.yml` file as a block tree, the way the
//! reference's `format/yaml.ts` decomposes it over the `yaml` npm package's
//! document model.
//!
//! The blocks are the **first document's** top-level nodes: each `key: value`
//! pair of a root mapping is a `yaml:mapping_entry` (attrs `{ key }`) whose
//! children are its nested pairs (a mapping value, block or flow, at any
//! depth) or its sequence's elements — a scalar element is a
//! `yaml:sequence_item` (`{ index, value }`), a mapping element a
//! `yaml:mapping` carrying its own pairs, a sequence element a `yaml:sequence`
//! that is not walked further; a root sequence yields its elements the same
//! way; a scalar root, a comment-only or otherwise content-less non-empty
//! file is one `yaml:scalar`; an empty file has no blocks; a file the parser
//! rejects is one `yaml:opaque` over its bytes (the reference reaches that
//! block only when its lenient parser throws — it otherwise returns the
//! mapping it recovered from a document with errors; this port cannot
//! reproduce that recovery and takes the opaque block, a divergence that
//! changes no property row: `spec/properties` §3.4 gives a document with
//! errors no rows on either side).
//!
//! **Spans** follow the `yaml` package's node ranges, whose third element —
//! the node end — the reference uses as a block's end: a scalar or flow
//! collection in block context runs to the end of its line, a trailing
//! comment and the line ending included, but not past blank or comment lines
//! that follow (they are trivia); a block collection ends where its last
//! entry ends; a block scalar (`|`, `>`) ends after its last non-blank
//! content line; a key with no value ends after its `:`; a key whose value is
//! an alias ends at the key (the reference does not read an alias's range).
//! Only top-level blocks carry trivia; nested blocks' trivia is `""`. A
//! block's `text` is `normalize_text(raw)` — the formats' kinds strip no
//! syntax. The round-trip law holds: `leading_trivia + Σ(raw + trivia)` is
//! the source.

use saphyr_parser::{Event, Parser, ScalarStyle};

use crate::FormatAdapter;
use crate::block::{AttrValue, Attrs, Block, BlockKind, BlockTree, Span};
use crate::text::normalize_text;

/// The adapter object (`format = "yaml"`, `.yaml` and `.yml`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct YamlAdapter;

impl FormatAdapter for YamlAdapter {
    fn format(&self) -> &'static str {
        "yaml"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &[".yaml", ".yml"]
    }

    fn parse(&self, source: &str) -> BlockTree {
        parse(source)
    }
}

/// A node of the first document, with byte offsets.
#[derive(Clone, Debug)]
enum Node {
    Scalar {
        /// The token's bytes (`[start, end)`), the parser's own span.
        start: usize,
        end: usize,
        text: String,
        style: ScalarStyle,
    },
    Alias,
    Map {
        /// Where the mapping begins: its `{` in flow style, its first key in
        /// block style.
        start: usize,
        /// The byte after the closing `}` (flow style only).
        close: Option<usize>,
        entries: Vec<(Node, Node)>,
    },
    Seq {
        /// Its `[` in flow style, its first `-` in block style.
        start: usize,
        /// The byte after the closing `]` (flow style only).
        close: Option<usize>,
        items: Vec<Node>,
    },
}

enum Frame {
    Map {
        start: usize,
        flow: bool,
        entries: Vec<(Node, Node)>,
        key: Option<Node>,
    },
    Seq {
        start: usize,
        flow: bool,
        items: Vec<Node>,
    },
}

/// The first document's root, `Ok(None)` when the stream has no document
/// (an empty or comment-only file) or its root is an empty scalar, `Err(())`
/// when the parser rejects the stream before the first document ends.
fn first_document(source: &str) -> Result<Option<Node>, ()> {
    let to_byte = CharOffsets::new(source);
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<Node> = None;
    let mut in_document = false;

    for item in Parser::new_from_str(source) {
        let (event, span) = item.map_err(|_| ())?;
        let start = to_byte.at(span.start.index());
        let end = to_byte.at(span.end.index());
        let node = match event {
            Event::Nothing | Event::StreamStart => continue,
            Event::StreamEnd => break,
            Event::DocumentStart(_) => {
                in_document = true;
                continue;
            }
            Event::DocumentEnd => break,
            Event::Scalar(text, style, _, _) => Node::Scalar {
                start,
                end,
                text: text.into_owned(),
                style,
            },
            Event::Alias(_) => Node::Alias,
            Event::SequenceStart(_, _) => {
                let flow = source[start..].starts_with('[');
                stack.push(Frame::Seq {
                    start,
                    flow,
                    items: Vec::new(),
                });
                continue;
            }
            Event::SequenceEnd => match stack.pop() {
                Some(Frame::Seq { start, flow, items }) => Node::Seq {
                    start,
                    close: flow.then_some(end),
                    items,
                },
                _ => return Err(()),
            },
            Event::MappingStart(_, _) => {
                let flow = source[start..].starts_with('{');
                stack.push(Frame::Map {
                    start,
                    flow,
                    entries: Vec::new(),
                    key: None,
                });
                continue;
            }
            Event::MappingEnd => match stack.pop() {
                Some(Frame::Map {
                    start,
                    flow,
                    entries,
                    key: None,
                }) => Node::Map {
                    start,
                    close: flow.then_some(end),
                    entries,
                },
                _ => return Err(()),
            },
        };
        match stack.last_mut() {
            None => {
                if root.is_some() {
                    return Err(());
                }
                root = Some(node);
            }
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                None => *key = Some(node),
                Some(k) => entries.push((k, node)),
            },
        }
    }
    if !stack.is_empty() {
        return Err(());
    }
    if !in_document {
        return Ok(None);
    }
    Ok(root.filter(
        |n| !matches!(n, Node::Scalar { text, style: ScalarStyle::Plain, .. } if text.is_empty()),
    ))
}

/// `saphyr-parser` marks positions in chars; the block model wants bytes.
struct CharOffsets {
    bytes: Vec<usize>,
}

impl CharOffsets {
    fn new(source: &str) -> Self {
        let mut bytes: Vec<usize> = source.char_indices().map(|(i, _)| i).collect();
        bytes.push(source.len());
        Self { bytes }
    }

    fn at(&self, char_index: usize) -> usize {
        self.bytes
            .get(char_index)
            .copied()
            .unwrap_or(*self.bytes.last().unwrap_or(&0))
    }
}

/// The `yaml` package's node end for a scalar token or a flow collection's
/// closing bracket in block context: past spaces and tabs, a `#` comment to
/// the end of the line, and the line ending itself (`\n` or `\r\n`); when the
/// line goes on with content instead (a `,` or a closing bracket in flow
/// context, another token), the end stays at `end`.
fn line_end(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut i = end;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'#' {
        while i < bytes.len() && bytes[i] != b'\n' && bytes[i] != b'\r' {
            i += 1;
        }
    }
    if i < bytes.len() && bytes[i] == b'\r' {
        i += 1;
        if i < bytes.len() && bytes[i] == b'\n' {
            i += 1;
        }
        return i;
    }
    if i < bytes.len() && bytes[i] == b'\n' {
        return i + 1;
    }
    end
}

/// A block scalar's node end: the parser's span runs to the start of the
/// line after the last line it consumed, blank lines included (they are the
/// chomping's business); the `yaml` package's node ends after the last
/// non-blank content line's ending.
fn block_scalar_end(source: &str, start: usize, end: usize) -> usize {
    let mut e = end.min(source.len());
    loop {
        let before = &source[start..e];
        let Some(nl) = before.strip_suffix('\n') else {
            break;
        };
        let line_start = nl.rfind('\n').map_or(0, |i| i + 1);
        let line = &nl[line_start..];
        if line.trim_matches([' ', '\t', '\r']).is_empty() && e > start {
            e = start + line_start;
            if line_start == 0 {
                break;
            }
        } else {
            break;
        }
    }
    e
}

/// Where a node's block ends (the `yaml` package's `range[2]`); `None` for an
/// alias, whose range the reference does not read.
fn node_end(source: &str, node: &Node) -> Option<usize> {
    match node {
        Node::Scalar {
            start, end, style, ..
        } => Some(match style {
            ScalarStyle::Literal | ScalarStyle::Folded => block_scalar_end(source, *start, *end),
            _ => line_end(source, *end),
        }),
        Node::Alias => None,
        Node::Map { close: Some(c), .. } | Node::Seq { close: Some(c), .. } => {
            Some(line_end(source, *c))
        }
        Node::Map { start, entries, .. } => entries
            .iter()
            .filter_map(|(k, v)| pair_span(source, k, v).map(|s| s.end))
            .max()
            .or(Some(*start)),
        Node::Seq { start, items, .. } => items
            .iter()
            .filter_map(|n| node_end(source, n))
            .max()
            .or(Some(*start)),
    }
}

fn node_start(node: &Node) -> Option<usize> {
    match node {
        Node::Scalar { start, .. } | Node::Map { start, .. } | Node::Seq { start, .. } => {
            Some(*start)
        }
        Node::Alias => None,
    }
}

/// A pair's span: from the key to the greater of the key's token end and the
/// value's node end; an empty value ends after the `:`.
fn pair_span(source: &str, key: &Node, value: &Node) -> Option<Span> {
    let start = node_start(key)?;
    let key_end = match key {
        Node::Scalar { end, .. } => *end,
        other => node_end(source, other)?,
    };
    let value_end = match value {
        Node::Scalar {
            text,
            style: ScalarStyle::Plain,
            ..
        } if text.is_empty() => Some(colon_end(source, key_end)),
        other => node_end(source, other),
    };
    let end = value_end.map_or(key_end, |e| e.max(key_end));
    Some(Span::new(start, end))
}

/// The byte after the `:` that follows the key at `key_end` (spaces between
/// allowed); `key_end` when there is none.
fn colon_end(source: &str, key_end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut i = key_end;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b':' {
        i + 1
    } else {
        key_end
    }
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

/// `String(key.value)` in the reference: a plain scalar key resolves by the
/// core schema and prints as JavaScript prints the result; a quoted key is
/// its text; a collection key is `""`.
fn key_string(key: &Node) -> String {
    match key {
        Node::Scalar {
            text,
            style: ScalarStyle::Plain,
            ..
        } => match resolve_plain(text) {
            Resolved::Null => "null".to_owned(),
            Resolved::Bool(b) => b.to_string(),
            Resolved::Number(n) => js_number(n),
            Resolved::Str => text.clone(),
        },
        Node::Scalar { text, .. } => text.clone(),
        _ => String::new(),
    }
}

/// A sequence element's `value` attribute: the resolved scalar. The block
/// model's attributes are booleans, integers and strings, so a null is
/// omitted and a non-integral number is carried as its JavaScript string.
fn value_attr(node: &Node) -> Option<AttrValue> {
    let Node::Scalar { text, style, .. } = node else {
        return None;
    };
    if *style != ScalarStyle::Plain {
        return Some(AttrValue::Str(text.clone()));
    }
    match resolve_plain(text) {
        Resolved::Null => None,
        Resolved::Bool(b) => Some(AttrValue::Bool(b)),
        Resolved::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
                #[allow(clippy::cast_possible_truncation)]
                Some(AttrValue::Int(n as i64))
            } else {
                Some(AttrValue::Str(js_number(n)))
            }
        }
        Resolved::Str => Some(AttrValue::Str(text.clone())),
    }
}

enum Resolved {
    Null,
    Bool(bool),
    Number(f64),
    Str,
}

/// YAML 1.2 core-schema resolution of a plain scalar (`spec/properties` §4),
/// as far as a key or a `value` attribute needs it.
fn resolve_plain(s: &str) -> Resolved {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Resolved::Null,
        "true" | "True" | "TRUE" => return Resolved::Bool(true),
        "false" | "False" | "FALSE" => return Resolved::Bool(false),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => {
            return Resolved::Number(f64::INFINITY);
        }
        "-.inf" | "-.Inf" | "-.INF" => return Resolved::Number(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return Resolved::Number(f64::NAN),
        _ => {}
    }
    if let Some(oct) = s.strip_prefix("0o") {
        if !oct.is_empty()
            && oct.bytes().all(|b| (b'0'..=b'7').contains(&b))
            && let Ok(n) = u64::from_str_radix(oct, 8)
        {
            #[allow(clippy::cast_precision_loss)]
            return Resolved::Number(n as f64);
        }
        return Resolved::Str;
    }
    if let Some(hex) = s.strip_prefix("0x") {
        if !hex.is_empty()
            && hex.bytes().all(|b| b.is_ascii_hexdigit())
            && let Ok(n) = u64::from_str_radix(hex, 16)
        {
            #[allow(clippy::cast_precision_loss)]
            return Resolved::Number(n as f64);
        }
        return Resolved::Str;
    }
    if is_core_number(s)
        && let Ok(n) = s.parse::<f64>()
    {
        return Resolved::Number(n);
    }
    Resolved::Str
}

/// `[-+]?[0-9]+` or `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`.
fn is_core_number(s: &str) -> bool {
    let body = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let mantissa_ok = if let Some(frac) = mantissa.strip_prefix('.') {
        !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit())
    } else {
        match mantissa.split_once('.') {
            Some((int, frac)) => {
                !int.is_empty()
                    && int.bytes().all(|b| b.is_ascii_digit())
                    && frac.bytes().all(|b| b.is_ascii_digit())
            }
            None => !mantissa.is_empty() && mantissa.bytes().all(|b| b.is_ascii_digit()),
        }
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let digits = e.strip_prefix(['-', '+']).unwrap_or(e);
        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
    });
    mantissa_ok && exponent_ok
}

/// `String(n)` for the numbers a key or element can be: an integer prints
/// without a fraction, the non-finite values by their JavaScript names.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", n as i128);
    }
    format!("{n}")
}

/// `blockFromPair`: the entry, its nested pairs or its elements as children.
fn block_from_pair(source: &str, key: &Node, value: &Node) -> Option<Block> {
    let span = pair_span(source, key, value)?;
    let mut attrs = Attrs::new();
    attrs.insert("key".to_owned(), AttrValue::Str(key_string(key)));
    let children = match value {
        Node::Map { entries, .. } => entries
            .iter()
            .filter_map(|(k, v)| block_from_pair(source, k, v))
            .collect(),
        Node::Seq { items, .. } => sequence_children(source, items),
        _ => Vec::new(),
    };
    Some(make(
        BlockKind::YamlMappingEntry,
        span,
        source,
        attrs,
        children,
    ))
}

/// A sequence's elements as blocks: scalars as items, mappings with their
/// pairs, nested sequences unwalked (`nested = true`); at the root (the
/// reference's `parseYamlBlocks`) a nested sequence yields nothing.
fn sequence_children(source: &str, items: &[Node]) -> Vec<Block> {
    sequence_blocks(source, items, true)
}

fn sequence_blocks(source: &str, items: &[Node], nested: bool) -> Vec<Block> {
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match item {
            Node::Scalar { start, .. } => {
                let Some(end) = node_end(source, item) else {
                    continue;
                };
                let mut attrs = Attrs::new();
                attrs.insert(
                    "index".to_owned(),
                    AttrValue::Int(i64::try_from(i).unwrap_or(i64::MAX)),
                );
                if let Some(v) = value_attr(item) {
                    attrs.insert("value".to_owned(), v);
                }
                out.push(make(
                    BlockKind::YamlSequenceItem,
                    Span::new(*start, end),
                    source,
                    attrs,
                    Vec::new(),
                ));
            }
            Node::Map { start, entries, .. } => {
                let Some(end) = node_end(source, item) else {
                    continue;
                };
                let children = entries
                    .iter()
                    .filter_map(|(k, v)| block_from_pair(source, k, v))
                    .collect();
                out.push(make(
                    BlockKind::YamlMapping,
                    Span::new(*start, end),
                    source,
                    Attrs::new(),
                    children,
                ));
            }
            Node::Seq { start, .. } if nested => {
                let Some(end) = node_end(source, item) else {
                    continue;
                };
                out.push(make(
                    BlockKind::YamlSequence,
                    Span::new(*start, end),
                    source,
                    Attrs::new(),
                    Vec::new(),
                ));
            }
            Node::Seq { .. } | Node::Alias => {}
        }
    }
    out
}

fn top_level_blocks(source: &str) -> Vec<Block> {
    let whole = |kind: BlockKind| {
        vec![make(
            kind,
            Span::new(0, source.len()),
            source,
            Attrs::new(),
            Vec::new(),
        )]
    };
    let root = match first_document(source) {
        Err(()) => return whole(BlockKind::YamlOpaque),
        Ok(None) => {
            return if source.trim().is_empty() {
                Vec::new()
            } else {
                whole(BlockKind::YamlScalar)
            };
        }
        Ok(Some(root)) => root,
    };
    match &root {
        Node::Map { entries, .. } => entries
            .iter()
            .filter_map(|(k, v)| block_from_pair(source, k, v))
            .collect(),
        Node::Seq { items, .. } => sequence_blocks(source, items, false),
        Node::Scalar { start, .. } => match node_end(source, &root) {
            Some(end) => vec![make(
                BlockKind::YamlScalar,
                Span::new(*start, end),
                source,
                Attrs::new(),
                Vec::new(),
            )],
            None => Vec::new(),
        },
        Node::Alias => Vec::new(),
    }
}

/// Parse a YAML file into its block tree (see the module documentation).
#[must_use]
pub fn parse(source: &str) -> BlockTree {
    let mut children = top_level_blocks(source);
    // A span the parser placed out of order or overlapping (it should not)
    // would break the round-trip law; keep the tree sound by dropping such a
    // block rather than emitting bytes twice.
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

    #[test]
    fn mapping_entries_with_nested_children() {
        let src = "focused_intent: /notes/plan.md\nsince: 2026-10-17\ntitle: Focus\ntags: [attn, now]\nmeta:\n  owner: bb\n";
        let tree = parse(src);
        assert_eq!(render(&tree), src);
        assert_eq!(tree.leading_trivia, "");
        let kinds: Vec<_> = tree.children.iter().map(shape).collect();
        assert_eq!(
            kinds,
            vec![
                (
                    BlockKind::YamlMappingEntry,
                    "focused_intent: /notes/plan.md\n",
                    ""
                ),
                (BlockKind::YamlMappingEntry, "since: 2026-10-17\n", ""),
                (BlockKind::YamlMappingEntry, "title: Focus\n", ""),
                (BlockKind::YamlMappingEntry, "tags: [attn, now]\n", ""),
                (BlockKind::YamlMappingEntry, "meta:\n  owner: bb\n", ""),
            ]
        );
        assert_eq!(tree.children[0].text, "focused_intent: /notes/plan.md");
        assert_eq!(
            tree.children[0].attrs.get("key"),
            Some(&AttrValue::Str("focused_intent".into()))
        );
        let tags = &tree.children[3];
        assert_eq!(tags.children.len(), 2);
        assert_eq!(tags.children[0].kind, BlockKind::YamlSequenceItem);
        assert_eq!(tags.children[0].raw, "attn");
        assert_eq!(tags.children[0].span, Span::new(69, 73));
        assert_eq!(
            tags.children[0].attrs.get("index"),
            Some(&AttrValue::Int(0))
        );
        assert_eq!(
            tags.children[0].attrs.get("value"),
            Some(&AttrValue::Str("attn".into()))
        );
        assert_eq!(tags.children[1].span, Span::new(75, 78));
        let meta = &tree.children[4];
        assert_eq!(meta.text, "meta: owner: bb");
        assert_eq!(meta.children.len(), 1);
        assert_eq!(meta.children[0].raw, "owner: bb\n");
        assert_eq!(meta.children[0].span, Span::new(88, 98));
        assert_eq!(tree.iter().count(), 8);
    }

    #[test]
    fn comments_and_blank_lines_are_trivia() {
        let src = "a: 1\n\n# c\nb: 2 # trailing\n\nc:\n  - x\n  - y\n\n";
        let tree = parse(src);
        assert_eq!(render(&tree), src);
        let kinds: Vec<_> = tree.children.iter().map(shape).collect();
        assert_eq!(
            kinds,
            vec![
                (BlockKind::YamlMappingEntry, "a: 1\n", "\n# c\n"),
                (BlockKind::YamlMappingEntry, "b: 2 # trailing\n", "\n"),
                (BlockKind::YamlMappingEntry, "c:\n  - x\n  - y\n", "\n"),
            ]
        );
        let c = &tree.children[2];
        assert_eq!(c.children[0].raw, "x\n");
        assert_eq!(c.children[0].span, Span::new(34, 36));
        assert_eq!(c.children[1].span, Span::new(40, 42));
        assert_eq!(c.text, "c: - x - y");

        let tree = parse("a: 1 # c1\n# c2\n# c3\nb: 2\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "a: 1 # c1\n", "# c2\n# c3\n")
        );
        assert_eq!(tree.children[1].span, Span::new(20, 25));
    }

    #[test]
    fn block_scalars_end_after_their_last_content_line() {
        let tree = parse("d: |\n  line1\n  line2\n\ne: 3\n");
        assert_eq!(
            shape(&tree.children[0]),
            (
                BlockKind::YamlMappingEntry,
                "d: |\n  line1\n  line2\n",
                "\n"
            )
        );
        assert_eq!(tree.children[0].text, "d: | line1 line2");
        assert_eq!(tree.children[1].span, Span::new(22, 27));
        let tree = parse("d: >-\n  folded\n  text\ne: 3\n");
        assert_eq!(tree.children[0].raw, "d: >-\n  folded\n  text\n");
    }

    #[test]
    fn flow_collections_nest_and_end_at_their_line() {
        let tree = parse("f: {a: 1, b: 2}\ng: [1, 2]\n");
        let f = &tree.children[0];
        assert_eq!(f.span, Span::new(0, 16));
        assert_eq!(f.children.len(), 2);
        assert_eq!(f.children[0].span, Span::new(4, 8));
        assert_eq!(f.children[0].raw, "a: 1");
        assert_eq!(f.children[1].span, Span::new(10, 14));
        let g = &tree.children[1];
        assert_eq!(g.span, Span::new(16, 26));
        assert_eq!(g.children[0].span, Span::new(20, 21));
        assert_eq!(g.children[0].attrs.get("value"), Some(&AttrValue::Int(1)));
        assert_eq!(g.children[1].span, Span::new(23, 24));
        let tree = parse("m: {}\nl: []\n");
        assert_eq!(tree.children[0].raw, "m: {}\n");
        assert_eq!(tree.children[1].raw, "l: []\n");
        assert!(tree.children[1].children.is_empty());
    }

    #[test]
    fn sequence_elements_by_shape() {
        let src = "items:\n  - {a: 1}\n  - b\n  - - x\n    - y\n";
        let tree = parse(src);
        let items = &tree.children[0];
        assert_eq!(items.span, Span::new(0, 40));
        assert_eq!(items.text, "items: - {a: 1} - b - - x - y");
        let kinds: Vec<_> = items.children.iter().map(shape).collect();
        assert_eq!(
            kinds,
            vec![
                (BlockKind::YamlMapping, "{a: 1}\n", ""),
                (BlockKind::YamlSequenceItem, "b\n", ""),
                (BlockKind::YamlSequence, "- x\n    - y\n", ""),
            ]
        );
        assert_eq!(items.children[0].span, Span::new(11, 18));
        assert_eq!(items.children[0].children[0].raw, "a: 1");
        assert_eq!(items.children[0].children[0].span, Span::new(12, 16));
        assert_eq!(
            items.children[1].attrs.get("index"),
            Some(&AttrValue::Int(1))
        );
        assert_eq!(items.children[2].span, Span::new(28, 40));
        assert!(items.children[2].children.is_empty());
    }

    #[test]
    fn root_sequence_scalar_and_markers() {
        let tree = parse("- a\n- b\n");
        assert_eq!(tree.leading_trivia, "- ");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlSequenceItem, "a\n", "- ")
        );
        assert_eq!(
            shape(&tree.children[1]),
            (BlockKind::YamlSequenceItem, "b\n", "")
        );
        assert_eq!(render(&tree), "- a\n- b\n");

        let tree = parse("- {a: 1}\n- - x\n");
        assert_eq!(tree.children.len(), 1);
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMapping, "{a: 1}\n", "- - x\n")
        );

        let tree = parse("just a string\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlScalar, "just a string\n", "")
        );

        let tree = parse("---\na: 1\n...\n");
        assert_eq!(tree.leading_trivia, "---\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "a: 1\n", "...\n")
        );

        let tree = parse("a: 1\n---\nb: 2\n");
        assert_eq!(tree.children.len(), 1);
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "a: 1\n", "---\nb: 2\n")
        );

        let tree = parse("# head\na: 1\n");
        assert_eq!(tree.leading_trivia, "# head\n");
        assert_eq!(tree.children[0].span, Span::new(7, 12));

        let tree = parse("a: 1");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "a: 1", "")
        );
    }

    #[test]
    fn empty_null_and_alias_values() {
        let tree = parse("k:\nj: 1\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "k:", "\n")
        );
        assert_eq!(
            shape(&tree.children[1]),
            (BlockKind::YamlMappingEntry, "j: 1\n", "")
        );
        let tree = parse("x: &a 1\ny: *a\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlMappingEntry, "x: &a 1\n", "")
        );
        assert_eq!(
            shape(&tree.children[1]),
            (BlockKind::YamlMappingEntry, "y", ": *a\n")
        );
    }

    #[test]
    fn content_less_and_unreadable_files() {
        assert!(parse("").children.is_empty());
        assert_eq!(parse("").leading_trivia, "");
        let tree = parse("# nothing here\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlScalar, "# nothing here\n", "")
        );
        let tree = parse("a: [1, 2\nb: 3\n");
        assert_eq!(
            shape(&tree.children[0]),
            (BlockKind::YamlOpaque, "a: [1, 2\nb: 3\n", "")
        );
        assert_eq!(render(&tree), "a: [1, 2\nb: 3\n");
        // Duplicate keys are two entries (the parser does not object).
        let tree = parse("a: 1\na: 2\n");
        assert_eq!(tree.children.len(), 2);
    }

    #[test]
    fn keys_resolve_as_the_reference_prints_them() {
        let tree = parse("yes: no\noct: 0o17\n\"k\": \"v\"\n1.0: x\n~: y\n");
        let keys: Vec<_> = tree
            .children
            .iter()
            .map(|b| match b.attrs.get("key") {
                Some(AttrValue::Str(s)) => s.as_str(),
                _ => "?",
            })
            .collect();
        assert_eq!(keys, vec!["yes", "oct", "k", "1", "null"]);
        assert_eq!(tree.children[2].raw, "\"k\": \"v\"\n");
    }

    #[test]
    fn non_ascii_sources_use_byte_offsets() {
        let src = "é: ü\nb: 2\n";
        let tree = parse(src);
        assert_eq!(render(&tree), src);
        assert_eq!(tree.children[0].raw, "é: ü\n");
        assert_eq!(tree.children[0].span, Span::new(0, 7));
        assert_eq!(tree.children[1].raw, "b: 2\n");
    }
}
