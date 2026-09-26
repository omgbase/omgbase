//! Markdown → block tree (`spec/format/README.md` §2, §3), over `markdown-rs`
//! (wooorm's micromark port) with the GFM constructs plus YAML frontmatter —
//! the same construct set as the reference's micromark configuration.
//!
//! Four host divergences are normalized here (README §6):
//!
//! - **Block starts.** micromark starts a block at its first non-blank byte:
//!   leading indentation (up to three spaces at the top level, any extra
//!   indentation inside a container) is a line prefix, not part of the block,
//!   and a tab that straddles a container's content column belongs to the
//!   container. `markdown-rs` starts the block at the first byte the
//!   container did not fully consume, so `  - a` is a list at 0 and a
//!   tab-indented nested list begins on the tab. Two kinds keep their
//!   indentation in both parsers — `html_block` and indented code — but not
//!   a straddling tab. [`adjust_start`] applies both rules.
//! - **Block ends.** `markdown-rs` ends a loose list item, a list whose last
//!   item is loose, and a footnote definition *after* the line ending — and
//!   any blank lines that follow, including the `>`-prefixed blank lines of an
//!   enclosing blockquote. micromark ends them at the last content byte. §1
//!   inv. 4 picks "before"; [`trim_end`] brings every span there.
//! - **BOM.** `markdown-rs` tokenizes a leading U+FEFF and reports every
//!   offset from the true start of the file, so a BOM lands in
//!   `leading_trivia` (§1 inv. 6) with no adjustment.
//! - **Ordered lists interrupting a paragraph.** CommonMark lets an ordered
//!   list interrupt a paragraph only when it starts with `1`; `markdown-rs`
//!   honours that except for a one-line paragraph that follows a list
//!   (`- a\n\npara\n3. x`), where it opens a list at `3.`. Such a tree — a
//!   `paragraph` directly followed, with no blank line, by an ordered `list`
//!   whose `start` is not 1 — cannot occur in a correct parse, so
//!   [`parse`] detects it, masks the marker's delimiter byte in a copy of
//!   the source and parses again ([`invalid_interrupt`]). Spans and `raw`
//!   always come from the original bytes.

use markdown::mdast::Node;
use markdown::{Constructs, ParseOptions, to_mdast};

use crate::block::{AttrValue, Attrs, Block, BlockKind, BlockTree, Span};
use crate::text::block_text;
use crate::{FormatAdapter, render};

/// The Markdown adapter: `format = "markdown"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarkdownAdapter;

impl FormatAdapter for MarkdownAdapter {
    fn format(&self) -> &'static str {
        "markdown"
    }

    fn extensions(&self) -> &'static [&'static str] {
        &[".md", ".markdown"]
    }

    fn parse(&self, source: &str) -> BlockTree {
        parse(source)
    }
}

fn parse_options() -> ParseOptions {
    ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            ..Constructs::gfm()
        },
        ..ParseOptions::gfm()
    }
}

/// Parse Markdown source into a block tree. Never fails (§1 inv. 8).
#[must_use]
pub fn parse(source: &str) -> BlockTree {
    // `masked` differs from `source` only at list-marker delimiters that
    // `markdown-rs` wrongly let open a list (module docs); every other lookup
    // — spans, raw slices, columns, fences — reads the original bytes.
    let mut masked: Option<Vec<u8>> = None;
    loop {
        let parsed = masked
            .as_deref()
            .map(|b| std::str::from_utf8(b).expect("masking replaces ASCII with ASCII"))
            .unwrap_or(source);
        let children = match to_mdast(parsed, &parse_options()) {
            Ok(root) => root
                .children()
                .map(|nodes| nodes.iter().map(|n| build(n, source, None, 0)).collect())
                .unwrap_or_default(),
            // `to_mdast` only fails on MDX constructs, which are off; keep the
            // promise anyway with a single opaque block over the content.
            Err(_) => opaque_fallback(source),
        };
        let Some(delimiter) = invalid_interrupt(&children, source) else {
            return attach_trivia(source, children);
        };
        masked.get_or_insert_with(|| source.as_bytes().to_vec())[delimiter] = MASK;
    }
}

/// What a wrongly recognized list marker's `.`/`)` becomes so the line reads
/// as the paragraph continuation CommonMark says it is. Any ASCII letter
/// works: `3x` starts no block-level construct.
const MASK: u8 = b'x';

/// The byte offset of the delimiter of the first ordered list that
/// `markdown-rs` let interrupt a paragraph although its start is not 1
/// (module docs), searching the whole tree; `None` when the tree is sound.
fn invalid_interrupt(blocks: &[Block], source: &str) -> Option<usize> {
    for pair in blocks.windows(2) {
        let (paragraph, list) = (&pair[0], &pair[1]);
        if paragraph.kind == BlockKind::Paragraph
            && list.kind == BlockKind::List
            && list
                .attrs
                .get("start")
                .is_some_and(|s| *s != AttrValue::Int(1))
            && is_single_line_break(&source[paragraph.span.end..list.span.start])
        {
            let b = source.as_bytes();
            let mut i = list.span.start;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            return Some(i);
        }
    }
    blocks
        .iter()
        .find_map(|b| invalid_interrupt(&b.children, source))
}

/// Exactly one line ending and otherwise only spaces, tabs and blockquote
/// markers: the two blocks are on consecutive lines with no blank between.
fn is_single_line_break(gap: &str) -> bool {
    let endings = gap.split(['\r', '\n']).count() - 1 - gap.matches("\r\n").count();
    endings == 1
        && gap
            .bytes()
            .all(|b| matches!(b, b' ' | b'\t' | b'>' | b'\r' | b'\n'))
}

fn opaque_fallback(source: &str) -> Vec<Block> {
    let end = source.trim_end_matches(['\r', '\n']).len();
    if end == 0 {
        return Vec::new();
    }
    vec![make_block(
        BlockKind::Opaque,
        Span::new(0, end),
        source,
        Attrs::new(),
        Vec::new(),
        0,
    )]
}

/// Trailing-attach (§2): each top-level block owns the bytes up to the next
/// block; bytes before the first block are `leading_trivia`.
fn attach_trivia(source: &str, mut children: Vec<Block>) -> BlockTree {
    let leading_trivia = match children.first() {
        Some(first) => source[..first.span.start].to_owned(),
        None => source.to_owned(),
    };
    let mut next_start = source.len();
    for block in children.iter_mut().rev() {
        block.trivia = source[block.span.end..next_start].to_owned();
        next_start = block.span.start;
    }
    BlockTree {
        source: source.to_owned(),
        leading_trivia,
        children,
    }
}

/// How far back a node's `markdown-rs` end may be pulled (see module docs).
#[derive(Clone, Copy, PartialEq, Eq)]
enum TrimMode {
    /// Trailing line endings only.
    LineEndings,
    /// Also trailing whitespace-only lines (`[ \t]*`).
    BlankLines,
    /// Also trailing blank-in-container lines (`[ \t>]*`): a loose item
    /// inside a blockquote swallows the quote's blank `>` line.
    ContainerBlankLines,
}

fn is_blank_line(line: &str, mode: TrimMode) -> bool {
    match mode {
        TrimMode::LineEndings => false,
        TrimMode::BlankLines => line.bytes().all(|b| matches!(b, b' ' | b'\t')),
        TrimMode::ContainerBlankLines => line.bytes().all(|b| matches!(b, b' ' | b'\t' | b'>')),
    }
}

/// Pull `end` back to the last content byte per `mode`, never below `floor`
/// (the end of the node's last child, so nesting — §1 inv. 3 — survives when
/// a trailing `>` line really is an empty blockquote child).
fn trim_end(source: &str, start: usize, end: usize, mode: TrimMode, floor: usize) -> usize {
    let mut raw = &source[start..end];
    loop {
        let trimmed = raw.trim_end_matches(['\r', '\n']);
        if trimmed.len() != raw.len() {
            raw = trimmed;
            continue;
        }
        let Some(nl) = raw.rfind(['\r', '\n']) else {
            break;
        };
        let last_line = &raw[nl + 1..];
        if !last_line.is_empty() && is_blank_line(last_line, mode) {
            raw = &raw[..nl + 1];
            continue;
        }
        break;
    }
    (start + raw.len()).max(floor)
}

/// Offset of the first byte of the line containing `at`.
fn line_start(source: &str, at: usize) -> usize {
    source[..at].rfind(['\n', '\r']).map_or(0, |i| i + 1)
}

/// Column of byte `at` on its line, with tab stops every four columns
/// (CommonMark). Only ever applied to ASCII prefix bytes.
fn column_of(source: &str, line_start: usize, at: usize) -> usize {
    source.as_bytes()[line_start..at]
        .iter()
        .fold(0, |col, &b| advance_column(col, b))
}

const fn advance_column(col: usize, b: u8) -> usize {
    if b == b'\t' {
        col + 4 - col % 4
    } else {
        col + 1
    }
}

/// The content column of a list item (CommonMark: marker width plus its
/// following 1–4 spaces of indentation; plus one when the marker is followed
/// by five or more, or by nothing).
fn item_content_column(source: &str, item_start: usize) -> usize {
    let b = source.as_bytes();
    let ls = line_start(source, item_start);
    let mut i = item_start;
    while i < b.len() && matches!(b[i], b' ' | b'\t') {
        i += 1;
    }
    if i < b.len() && matches!(b[i], b'-' | b'*' | b'+') {
        i += 1;
    } else {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i < b.len() && matches!(b[i], b'.' | b')') {
            i += 1;
        }
    }
    let marker_end = column_of(source, ls, i);
    let mut col = marker_end;
    while i < b.len() && matches!(b[i], b' ' | b'\t') {
        col = advance_column(col, b[i]);
        i += 1;
    }
    let spaces = col - marker_end;
    let blank_rest = i >= b.len() || matches!(b[i], b'\n' | b'\r');
    if (1..=4).contains(&spaces) && !blank_rest {
        marker_end + spaces
    } else {
        marker_end + 1
    }
}

/// The content column of the blockquote whose `>` prefixes the line of `at`:
/// the column after the marker, plus one for its optional space or tab.
fn quote_content_column(source: &str, at: usize) -> usize {
    let ls = line_start(source, at);
    let Some(rel) = source[ls..at].rfind('>') else {
        return 0;
    };
    let gt = ls + rel;
    let col = column_of(source, ls, gt) + 1;
    match source.as_bytes().get(gt + 1) {
        Some(b' ' | b'\t') => col + 1,
        _ => col,
    }
}

/// Where a block really starts (see module docs): a tab straddling the
/// container's content column belongs to the container; the indentation that
/// follows is a line prefix, not block content — except for `html_block` and
/// indented code, which keep it (`keep_indent`).
fn adjust_start(
    source: &str,
    start: usize,
    end: usize,
    content_col: usize,
    keep_indent: bool,
) -> usize {
    let b = source.as_bytes();
    let ls = line_start(source, start);
    let mut i = start;
    while i < end && b[i] == b'\t' && column_of(source, ls, i) < content_col {
        i += 1;
    }
    if !keep_indent {
        while i < end && matches!(b[i], b' ' | b'\t') {
            i += 1;
        }
    }
    i
}

fn kind_of(node: &Node) -> (BlockKind, Attrs, TrimMode) {
    let mut attrs = Attrs::new();
    let (kind, mode) = match node {
        Node::Yaml(_) => (BlockKind::Frontmatter, TrimMode::LineEndings),
        Node::Heading(h) => {
            attrs.insert("level".to_owned(), AttrValue::Int(i64::from(h.depth)));
            (BlockKind::Heading, TrimMode::LineEndings)
        }
        Node::Paragraph(_) => (BlockKind::Paragraph, TrimMode::LineEndings),
        Node::List(l) => {
            attrs.insert("ordered".to_owned(), AttrValue::Bool(l.ordered));
            if let (true, Some(start)) = (l.ordered, l.start) {
                attrs.insert("start".to_owned(), AttrValue::Int(i64::from(start)));
            }
            (BlockKind::List, TrimMode::BlankLines)
        }
        Node::ListItem(item) => match item.checked {
            Some(checked) => {
                attrs.insert("checked".to_owned(), AttrValue::Bool(checked));
                (BlockKind::Task, TrimMode::ContainerBlankLines)
            }
            None => (BlockKind::ListItem, TrimMode::ContainerBlankLines),
        },
        Node::Blockquote(_) => (BlockKind::Blockquote, TrimMode::LineEndings),
        Node::Code(c) => {
            if let Some(lang) = c.lang.as_deref().filter(|s| !s.is_empty()) {
                attrs.insert("lang".to_owned(), AttrValue::Str(lang.to_owned()));
            }
            if let Some(info) = c.meta.as_deref().filter(|s| !s.is_empty()) {
                attrs.insert("info".to_owned(), AttrValue::Str(info.to_owned()));
            }
            (BlockKind::CodeFence, TrimMode::LineEndings)
        }
        Node::Table(_) => (BlockKind::Table, TrimMode::LineEndings),
        Node::TableRow(_) => (BlockKind::TableRow, TrimMode::LineEndings),
        Node::ThematicBreak(_) => (BlockKind::ThematicBreak, TrimMode::LineEndings),
        Node::Html(_) => (BlockKind::HtmlBlock, TrimMode::LineEndings),
        Node::FootnoteDefinition(_) => (BlockKind::Opaque, TrimMode::BlankLines),
        _ => (BlockKind::Opaque, TrimMode::LineEndings),
    };
    (kind, attrs, mode)
}

/// Build one block. `quote_depth` is the number of `blockquote` ancestors,
/// which §4.1 step 1 needs to strip `>` markers from a leaf's `text`.
fn build(node: &Node, source: &str, parent: Option<&Node>, quote_depth: usize) -> Block {
    let position = node
        .position()
        .expect("markdown-rs sets a position on every block-level node");
    let (kind, attrs, mode) = kind_of(node);

    let content_col = match parent {
        Some(item @ Node::ListItem(_)) => {
            item_content_column(source, item.position().map_or(0, |p| p.start.offset))
        }
        Some(Node::Blockquote(_)) => quote_content_column(source, position.start.offset),
        _ => 0,
    };
    let keep_indent = match node {
        Node::Html(_) => true,
        Node::Code(_) => !matches!(
            source.as_bytes().get(position.start.offset),
            Some(b'`' | b'~')
        ),
        _ => false,
    };
    let start = adjust_start(
        source,
        position.start.offset,
        position.end.offset,
        content_col,
        keep_indent,
    );

    // Descend only into the container kinds (§1: parser nesting only); an
    // `opaque` node never has block children, whatever mdast holds.
    let child_depth = quote_depth + usize::from(kind == BlockKind::Blockquote);
    let mut children: Vec<Block> = if kind.is_container() {
        node.children()
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|n| build(n, source, Some(node), child_depth))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let floor = children.last().map_or(start, |last| last.span.end);
    let end = trim_end(source, start, position.end.offset, mode, floor);

    // Single-paragraph fold (§3): the item carries the text itself — and,
    // childless, computes it from its own raw under the leaf rule (§4.1).
    if matches!(kind, BlockKind::ListItem | BlockKind::Task)
        && children.len() == 1
        && children[0].kind == BlockKind::Paragraph
    {
        children.clear();
    }

    make_block(
        kind,
        Span::new(start, end),
        source,
        attrs,
        children,
        quote_depth,
    )
}

/// Assemble a block; `text` follows §4.1 from the children (already carrying
/// theirs) or from the raw with `quote_depth` blockquote ancestors.
fn make_block(
    kind: BlockKind,
    span: Span,
    source: &str,
    attrs: Attrs,
    children: Vec<Block>,
    quote_depth: usize,
) -> Block {
    let raw = &source[span.start..span.end];
    Block {
        kind,
        span,
        raw: raw.to_owned(),
        text: block_text(kind, raw, &children, quote_depth),
        attrs,
        children,
        trivia: String::new(),
    }
}

/// `render(parse(source))` — the round trip (§1 inv. 1), as a convenience.
#[must_use]
pub fn round_trip(source: &str) -> String {
    render(&parse(source))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(tree: &BlockTree) -> Vec<(BlockKind, &str)> {
        tree.children
            .iter()
            .map(|b| (b.kind, b.raw.as_str()))
            .collect()
    }

    fn attr<'a>(block: &'a Block, key: &str) -> Option<&'a AttrValue> {
        block.attrs.get(key)
    }

    #[test]
    fn empty_and_blank_sources_are_all_leading_trivia() {
        for src in ["", "\n", "\n\n\n", "   \n\t\n"] {
            let tree = parse(src);
            assert!(tree.children.is_empty(), "{src:?}");
            assert_eq!(tree.leading_trivia, src);
            assert_eq!(render(&tree), src);
        }
    }

    #[test]
    fn kind_mapping_and_attrs() {
        let src = "---\na: 1\n---\n\n# H1\n\nPara.\n\n1. one\n2. two\n\n- [ ] open\n- [x] done\n- plain\n\n> q\n\n```js meta here\ncode\n```\n\n    indented\n\n| a |\n| - |\n| 1 |\n\n***\n\n<div>x</div>\n\n[ref]: https://example.com\n";
        let tree = parse(src);
        let k: Vec<BlockKind> = tree.children.iter().map(|b| b.kind).collect();
        assert_eq!(
            k,
            [
                BlockKind::Frontmatter,
                BlockKind::Heading,
                BlockKind::Paragraph,
                BlockKind::List,
                BlockKind::List,
                BlockKind::Blockquote,
                BlockKind::CodeFence,
                BlockKind::CodeFence,
                BlockKind::Table,
                BlockKind::ThematicBreak,
                BlockKind::HtmlBlock,
                BlockKind::Opaque,
            ]
        );
        let b = &tree.children;
        assert_eq!(b[0].raw, "---\na: 1\n---");
        assert_eq!(b[0].text, "a: 1");
        assert_eq!(attr(&b[1], "level"), Some(&AttrValue::Int(1)));
        assert_eq!(b[1].text, "H1");

        let ordered = &b[3];
        assert_eq!(attr(ordered, "ordered"), Some(&AttrValue::Bool(true)));
        assert_eq!(attr(ordered, "start"), Some(&AttrValue::Int(1)));
        assert_eq!(ordered.children.len(), 2);
        assert_eq!(ordered.children[0].kind, BlockKind::ListItem);
        assert!(
            ordered.children[0].children.is_empty(),
            "single-paragraph fold"
        );
        assert_eq!(ordered.children[1].text, "two");

        let tasks = &b[4];
        assert_eq!(attr(tasks, "ordered"), Some(&AttrValue::Bool(false)));
        assert_eq!(attr(tasks, "start"), None);
        let items: Vec<(BlockKind, Option<&AttrValue>, &str)> = tasks
            .children
            .iter()
            .map(|i| (i.kind, attr(i, "checked"), i.text.as_str()))
            .collect();
        assert_eq!(
            items,
            [
                (BlockKind::Task, Some(&AttrValue::Bool(false)), "open"),
                (BlockKind::Task, Some(&AttrValue::Bool(true)), "done"),
                (BlockKind::ListItem, None, "plain"),
            ]
        );

        assert_eq!(b[5].children.len(), 1);
        assert_eq!(b[5].children[0].kind, BlockKind::Paragraph);
        assert_eq!(b[5].children[0].raw, "q");
        assert_eq!(b[5].text, "q");

        assert_eq!(attr(&b[6], "lang"), Some(&AttrValue::Str("js".to_owned())));
        assert_eq!(
            attr(&b[6], "info"),
            Some(&AttrValue::Str("meta here".to_owned()))
        );
        assert_eq!(b[6].text, "code", "fence lines are not visible text");
        assert!(b[7].attrs.is_empty(), "indented code has no lang/info");
        assert_eq!(b[7].raw, "    indented");
        assert_eq!(b[7].text, "indented");

        assert_eq!(b[8].children.len(), 2, "header row + one body row");
        assert!(b[8].children.iter().all(|r| r.kind == BlockKind::TableRow));
        assert!(b[8].children.iter().all(|r| r.children.is_empty()));
        assert_eq!(b[8].children[0].text, "a");
        assert_eq!(b[8].text, "a 1");
        assert_eq!(b[9].text, "");
        assert!(b[11].children.is_empty());
        assert_eq!(b[11].raw, "[ref]: https://example.com");
        assert_eq!(render(&tree), src);
    }

    #[test]
    fn loose_list_ends_are_trimmed_to_content() {
        let tree = parse("- a\n\n\n- b\n\n\npara\n");
        assert_eq!(
            kinds(&tree),
            [
                (BlockKind::List, "- a\n\n\n- b"),
                (BlockKind::Paragraph, "para")
            ]
        );
        let items: Vec<&str> = tree.children[0]
            .children
            .iter()
            .map(|i| i.raw.as_str())
            .collect();
        assert_eq!(items, ["- a", "- b"]);
        assert_eq!(tree.children[0].trivia, "\n\n\n");

        let tree = parse("1. a\n\n   b\n\n2. c\n\n\n");
        assert_eq!(tree.children[0].raw, "1. a\n\n   b\n\n2. c");
        assert_eq!(tree.children[0].children[0].raw, "1. a\n\n   b");
        assert_eq!(tree.children[0].children[0].children.len(), 2);
        assert_eq!(tree.children[0].children[1].raw, "2. c");

        let tree = parse("- a\r\n\r\n- b\r\n\r\npara\r\n");
        assert_eq!(tree.children[0].raw, "- a\r\n\r\n- b");
        assert_eq!(tree.children[0].children[0].raw, "- a");
    }

    #[test]
    fn loose_item_inside_blockquote_drops_the_quote_blank_line() {
        let tree = parse("> - a\n>\n> - b\n>\n\nafter\n");
        let quote = &tree.children[0];
        assert_eq!(quote.raw, "> - a\n>\n> - b\n>");
        let list = &quote.children[0];
        assert_eq!(list.raw, "- a\n>\n> - b\n>");
        let items: Vec<&str> = list.children.iter().map(|i| i.raw.as_str()).collect();
        assert_eq!(items, ["- a", "- b"]);
    }

    #[test]
    fn an_empty_blockquote_child_is_not_trimmed_away() {
        let tree = parse("- a\n  >\n- b\n");
        let item = &tree.children[0].children[0];
        assert_eq!(item.raw, "- a\n  >");
        assert_eq!(item.children.len(), 2);
        assert_eq!(item.children[1].kind, BlockKind::Blockquote);
        assert_eq!(item.children[1].raw, ">");
    }

    #[test]
    fn footnote_definition_is_opaque_and_trimmed() {
        let tree = parse("[^1]: note\n\n    more note\n\npara\n");
        assert_eq!(tree.children[0].kind, BlockKind::Opaque);
        assert_eq!(tree.children[0].raw, "[^1]: note\n\n    more note");
        assert!(tree.children[0].children.is_empty());
    }

    #[test]
    fn bom_is_leading_trivia_with_true_offsets() {
        let src = "\u{FEFF}# Doc with BOM\n\nBody.\n";
        let tree = parse(src);
        assert_eq!(tree.leading_trivia, "\u{FEFF}");
        assert_eq!(tree.children[0].span, Span::new(3, 17));
        assert_eq!(tree.children[0].raw, "# Doc with BOM");
        assert_eq!(tree.children[0].text, "Doc with BOM");
        assert_eq!(tree.children[1].span, Span::new(19, 24));
        assert_eq!(render(&tree), src);
    }

    #[test]
    fn setext_heading_raw_keeps_its_underline_text_drops_it() {
        let tree = parse("Title One\n=========\n\nBody.\n");
        assert_eq!(tree.children[0].kind, BlockKind::Heading);
        assert_eq!(attr(&tree.children[0], "level"), Some(&AttrValue::Int(1)));
        assert_eq!(tree.children[0].raw, "Title One\n=========");
        assert_eq!(tree.children[0].text, "Title One");
    }

    #[test]
    fn text_is_visible_text_through_the_tree() {
        // Blockquote depth: continuation `> ` prefixes go from nested leaves,
        // and a code line that itself starts with `>` survives.
        let tree = parse(
            "> level one\n> still one\n>\n> > two\n> > more two\n>\n> ```\n> > not a quote\n> ```\n",
        );
        let quote = &tree.children[0];
        assert_eq!(quote.children[0].raw, "level one\n> still one");
        assert_eq!(quote.children[0].text, "level one still one");
        let inner = &quote.children[1];
        assert_eq!(inner.kind, BlockKind::Blockquote);
        assert_eq!(inner.children[0].raw, "two\n> > more two");
        assert_eq!(inner.children[0].text, "two more two");
        assert_eq!(inner.text, "two more two");
        let code = &quote.children[2];
        assert_eq!(code.kind, BlockKind::CodeFence);
        assert_eq!(code.raw, "```\n> > not a quote\n> ```");
        assert_eq!(code.text, "> not a quote");
        assert_eq!(quote.text, "level one still one two more two > not a quote");

        // An item with children loses its bullet; nested lists inline.
        let tree = parse("- a\n\n  b\n\n  - c\n- d\n");
        let list = &tree.children[0];
        let a = &list.children[0];
        assert_eq!(a.children.len(), 3);
        assert_eq!(a.text, "a b c");
        assert_eq!(list.text, "a b c d");

        // An item whose first child is a code fence; a task with children
        // loses its checkbox along with its bullet (neither is a child's).
        let tree = parse("- ```\n  code\n  ```\n- [ ] task\n\n  ```js\n  x\n  ```\n");
        let items = &tree.children[0].children;
        assert_eq!(items[0].children[0].kind, BlockKind::CodeFence);
        assert_eq!(items[0].children[0].raw, "```\n  code\n  ```");
        assert_eq!(items[0].text, "code");
        assert_eq!(items[1].kind, BlockKind::Task);
        assert_eq!(items[1].children[0].raw, "task");
        assert_eq!(items[1].text, "task x");
        assert_eq!(tree.children[0].text, "code task x");

        // A quoted list: item raws carry `>` on continuation lines.
        let tree = parse("> - a\n>   more a\n> - b\n");
        let list = &tree.children[0].children[0];
        assert_eq!(list.children[0].raw, "- a\n>   more a");
        assert_eq!(list.children[0].text, "a more a");
        assert_eq!(tree.children[0].text, "a more a b");

        // Table: header cells then body cells; escaped pipe stays.
        let tree = parse("| a | b |\n| - | - |\n| 1 \\| x | 2 |\n");
        let table = &tree.children[0];
        assert_eq!(table.children[1].text, "1 \\| x 2");
        assert_eq!(table.text, "a b 1 \\| x 2");

        // Frontmatter, thematic break, indented and unclosed fenced code.
        let tree = parse("---\ntitle: T\n---\n\n***\n\n    indented\n\n```\nopen\n");
        let texts: Vec<&str> = tree.children.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["title: T", "", "indented", "open"]);
        assert_eq!(tree.children[3].raw, "```\nopen");
    }

    #[test]
    fn html_comment_between_blocks_is_an_html_block() {
        let tree = parse("# H\n\n<!-- a standalone comment -->\n\nPara after comment.\n");
        assert_eq!(
            kinds(&tree),
            [
                (BlockKind::Heading, "# H"),
                (BlockKind::HtmlBlock, "<!-- a standalone comment -->"),
                (BlockKind::Paragraph, "Para after comment."),
            ]
        );
    }

    #[test]
    fn no_trailing_newline_and_trailing_whitespace() {
        let tree = parse("text");
        assert_eq!(kinds(&tree), [(BlockKind::Paragraph, "text")]);
        assert_eq!(tree.children[0].trivia, "");

        let tree = parse("# H   \n\nBody   \n");
        assert_eq!(tree.children[0].raw, "# H   ");
        assert_eq!(tree.children[0].text, "H");
        assert_eq!(tree.children[1].raw, "Body   ");
        assert_eq!(tree.children[1].text, "Body");
        assert_eq!(round_trip("# H   \n\nBody   \n"), "# H   \n\nBody   \n");
    }

    #[test]
    fn nested_spans_stay_inside_parents() {
        let src = "- a\n\n  - b\n\n  - c\n\npara\n";
        let tree = parse(src);
        for parent in tree.iter() {
            for child in &parent.children {
                assert!(parent.span.contains(&child.span), "{parent:?} / {child:?}");
                assert!(parent.raw.contains(&child.raw));
                assert_eq!(child.trivia, "");
                assert!(!child.raw.ends_with(['\r', '\n']));
            }
        }
        assert_eq!(tree.children[0].raw, "- a\n\n  - b\n\n  - c");
    }

    #[test]
    fn leading_indentation_is_not_block_content() {
        // Top level: up to three spaces of indentation are a line prefix.
        let tree = parse("  - a\n");
        assert_eq!(tree.leading_trivia, "  ");
        assert_eq!(tree.children[0].span, Span::new(2, 5));
        assert_eq!(tree.children[0].children[0].raw, "- a");
        let tree = parse("   para\n");
        assert_eq!(tree.children[0].raw, "para");
        let tree = parse(" - a\n - b\n");
        assert_eq!(tree.children[0].raw, "- a\n - b");
        let items: Vec<&str> = tree.children[0]
            .children
            .iter()
            .map(|i| i.raw.as_str())
            .collect();
        assert_eq!(items, ["- a", "- b"]);
        let tree = parse("  | a |\n  | - |\n  | 1 |\n");
        assert_eq!(tree.children[0].raw, "| a |\n  | - |\n  | 1 |");
        assert_eq!(tree.children[0].children[1].raw, "| 1 |");
        let tree = parse("  Title\n  =====\n");
        assert_eq!(tree.children[0].raw, "Title\n  =====");
        // Nested: extra indentation past the item's content column, too.
        let tree = parse("- a\n\n    - b\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "- b");
        let tree = parse("- a\n\n   ---\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "---");
    }

    #[test]
    fn html_and_indented_code_keep_their_indentation() {
        let tree = parse("  <div>\n");
        assert_eq!(tree.children[0].raw, "  <div>");
        assert_eq!(tree.children[0].kind, BlockKind::HtmlBlock);
        let tree = parse("\t- a\n");
        assert_eq!(tree.children[0].raw, "\t- a");
        assert_eq!(tree.children[0].kind, BlockKind::CodeFence);
        let tree = parse("- a\n\n    <!-- c -->\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "  <!-- c -->");
        let tree = parse("- a\n\n  \t  code\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "\t  code");
        // Fenced code already starts on its fence.
        let tree = parse("  ```\nx\n  ```\n");
        assert_eq!(tree.children[0].raw, "```\nx\n  ```");
    }

    #[test]
    fn a_tab_straddling_the_container_prefix_belongs_to_the_container() {
        // edge::tabs-list-indent: the item's content column (2) falls inside
        // the tab, so the nested list starts after it.
        let tree = parse("- a\n\t- a1\n\t- a2\n\t\t- a2a\n- b\n");
        let a = &tree.children[0].children[0];
        assert_eq!(a.span, Span::new(0, 23));
        let nested = &a.children[1];
        assert_eq!(nested.span, Span::new(5, 23));
        assert_eq!(nested.raw, "- a1\n\t- a2\n\t\t- a2a");
        assert_eq!(nested.children[1].span, Span::new(11, 23));
        assert_eq!(nested.children[1].children[1].span, Span::new(18, 23));
        // Indented code and html after a straddling tab.
        let tree = parse("- a\n\n\t\tcode\n");
        let code = &tree.children[0].children[0].children[1];
        assert_eq!(
            (code.kind, code.span),
            (BlockKind::CodeFence, Span::new(6, 11))
        );
        assert_eq!(code.raw, "\tcode");
        let tree = parse("- a\n\n\t<!-- c -->\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "<!-- c -->");
        let tree = parse(">\t\tcode\n");
        assert_eq!(tree.children[0].children[0].span, Span::new(2, 7));
        let tree = parse("-\t\tcode\n");
        assert_eq!(
            tree.children[0].children[0].children[0].span,
            Span::new(2, 7)
        );
        let tree = parse("1. a\n\n\t\tcode\n");
        assert_eq!(
            tree.children[0].children[0].children[1].span,
            Span::new(7, 12)
        );
        // A tab fully inside the prefix is skipped; one at the content column is content.
        let tree = parse("- - a\n\n\t\t\tcode\n");
        assert_eq!(
            tree.children[0].children[0].children[0].children[0].children[1].raw,
            "\t\tcode"
        );
        let tree = parse("-   a\n\n\t\tcode\n");
        assert_eq!(tree.children[0].children[0].children[1].raw, "\tcode");
        assert_eq!(item_content_column("-   a", 0), 4);
        assert_eq!(item_content_column("-\t\tcode", 0), 2);
        assert_eq!(item_content_column("10. x", 0), 4);
        assert_eq!(item_content_column("-", 0), 2);
        assert_eq!(quote_content_column("> x", 2), 2);
        assert_eq!(quote_content_column(">x", 1), 1);
    }

    #[test]
    fn a_non_1_ordered_list_never_interrupts_a_paragraph() {
        // edge::list-lazy-marker-lookalike: markdown-rs opens a list at `3.`
        // after a one-line paragraph that follows a list; CommonMark does not.
        let src = "- a\n  2. not a marker\n\npara\n3. also not a marker\n";
        let tree = parse(src);
        assert_eq!(
            kinds(&tree),
            [
                (BlockKind::List, "- a\n  2. not a marker"),
                (BlockKind::Paragraph, "para\n3. also not a marker"),
            ]
        );
        assert_eq!(tree.children[1].text, "para 3. also not a marker");
        assert_eq!(render(&tree), src);
        // Several such lines, and a fence that then does interrupt.
        let tree = parse("- a\n\npara\n3. x\n4. y\n   ```\n   c\n   ```\n");
        assert_eq!(
            kinds(&tree),
            [
                (BlockKind::List, "- a"),
                (BlockKind::Paragraph, "para\n3. x\n4. y"),
                (BlockKind::CodeFence, "```\n   c\n   ```"),
            ]
        );
        // Inside a blockquote; `)` delimiter; start 0.
        let tree = parse("> - a\n>\n> para\n> 3) x\n");
        let quote = &tree.children[0];
        assert_eq!(quote.children.len(), 2);
        assert_eq!(quote.children[1].raw, "para\n> 3) x");
        assert_eq!(quote.children[1].text, "para 3) x");
        let tree = parse("- a\n\npara\n0. x\n");
        assert_eq!(tree.children[1].raw, "para\n0. x");
        // A list starting at 1, or after a blank line, does interrupt / start.
        let tree = parse("- a\n\npara\n1. x\n");
        assert_eq!(tree.children.len(), 3);
        let tree = parse("- a\n\npara\n\n3. x\n");
        assert_eq!(tree.children.len(), 3);
        assert_eq!(attr(&tree.children[2], "start"), Some(&AttrValue::Int(3)));
        assert!(is_single_line_break("\n"));
        assert!(is_single_line_break("\r\n> "));
        assert!(!is_single_line_break("\n\n"));
        assert!(!is_single_line_break("\r\n\r\n"));
        assert!(!is_single_line_break(""));
    }

    #[test]
    fn adapter_trait() {
        let adapter = MarkdownAdapter;
        assert_eq!(adapter.format(), "markdown");
        assert!(adapter.extensions().contains(&".md"));
        let tree = adapter.parse("hi\n");
        assert_eq!(adapter.render(&tree), "hi\n");
    }
}
