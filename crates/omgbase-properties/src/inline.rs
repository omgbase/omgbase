//! Inline fields (§3.2): a block's own text, code masking, the two field
//! forms, occurrence collection, card/ord, and the JavaScript `Number()`
//! coercion.

use std::collections::HashMap;
use std::sync::LazyLock;

use omgbase_format::BlockKind;
use omgbase_format::text::is_js_whitespace;
use regex::Regex;

use crate::DocBlock;
use crate::row::{Card, FlatRow, Typed};

/// Bracketed form: `[key:: value]` / `(key:: value)`. The reference's
/// `i` flag only widens `[a-z]` to ASCII letters (no `u` flag, so no
/// Unicode case folding); the key is captured as written.
static BRACKETED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\[(]([A-Za-z][A-Za-z0-9_]*)::[ \t]*([^\]\n)]*?)[ \t]*[\])]").expect("valid")
});

/// Blank every non-newline character (length-preserving in the reference;
/// here one space per character, which the field scan cannot tell apart).
fn blank(s: &str) -> String {
    s.chars()
        .map(|c| if c == '\n' { '\n' } else { ' ' })
        .collect()
}

/// `^[ \t]*(`{3,}|~{3,})` → the fence character and its run length.
fn fence_open(line: &str) -> Option<(char, usize, &str)> {
    let rest = line.trim_start_matches([' ', '\t']);
    let ch = rest.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = rest.chars().take_while(|&c| c == ch).count();
    (run >= 3).then(|| (ch, run, &rest[run..]))
}

/// `^[ \t]*(`{3,}|~{3,})[ \t]*$`.
fn fence_close(line: &str) -> Option<(char, usize)> {
    let (ch, run, rest) = fence_open(line)?;
    rest.chars()
        .all(|c| c == ' ' || c == '\t')
        .then_some((ch, run))
}

/// `graph/extract.ts` `maskCode`: fenced code (the fence lines included,
/// closed by a same-character fence at least as long, or running to the
/// end; a backtick fence whose info string contains a backtick is not a
/// fence) and inline code spans (a run of *n* backticks closed by the next
/// run of exactly *n*; an unmatched run stays) become spaces.
#[must_use]
pub fn mask_code(raw: &str) -> String {
    if !raw.contains('`') && !raw.contains("~~~") {
        return raw.to_owned();
    }

    // 1. Fenced code blocks, line by line.
    let mut lines: Vec<String> = raw.split('\n').map(str::to_owned).collect();
    let mut open: Option<(char, usize)> = None;
    for line in &mut lines {
        if let Some((ch, len)) = open {
            let closes = fence_close(line).is_some_and(|(c, n)| c == ch && n >= len);
            *line = blank(line);
            if closes {
                open = None;
            }
            continue;
        }
        if let Some((ch, len, rest)) = fence_open(line) {
            if ch == '`' && rest.contains('`') {
                continue;
            }
            open = Some((ch, len));
            *line = blank(line);
        }
    }
    let joined = lines.join("\n");

    // 2. Inline code spans over what remains.
    let mut out: Vec<char> = joined.chars().collect();
    let mut i = 0;
    while i < out.len() {
        if out[i] != '`' {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < out.len() && out[j] == '`' {
            j += 1;
        }
        let n = j - i;
        let mut k = j;
        let mut close = None;
        while k < out.len() {
            if out[k] != '`' {
                k += 1;
                continue;
            }
            let mut e = k;
            while e < out.len() && out[e] == '`' {
                e += 1;
            }
            if e - k == n {
                close = Some(k);
                break;
            }
            k = e;
        }
        let Some(close) = close else {
            i = j;
            continue;
        };
        for c in &mut out[i..close + n] {
            if *c != '\n' {
                *c = ' ';
            }
        }
        i = close + n;
    }
    out.into_iter().collect()
}

/// One inline field as found (§3.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Occurrence {
    /// The key as written.
    pub key: String,
    /// The captured value, trimmed of spaces and tabs.
    pub value: String,
    /// The block being scanned when it matched.
    pub block_id: String,
}

/// The length of the run of spaces and tabs `s` starts with.
fn blanks(s: &str) -> usize {
    s.len() - s.trim_start_matches([' ', '\t']).len()
}

/// §3.2 line form over one line (already split at JavaScript's line
/// terminators):
/// `^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?([a-z][a-z0-9_]*)::[ \t]*([^\n]*?)[ \t]*$`
/// with `i` (ASCII letters of either case). A key at the start of the line,
/// after blanks and — since 1.1 — optionally a list marker (`-`/`*`/`+`, or
/// one to nine ASCII digits and `.`/`)`) with at least one blank, then
/// optionally a task checkbox with at least one blank. Returns `(key, value,
/// start, end)`: the key as written, the value trimmed of spaces and tabs,
/// and the byte offsets in `line` where the key begins and where the trimmed
/// value ends (the `md:inline_field` span of `spec/graph` §2.1). The greedy
/// scan equals the regex: a marker or checkbox that is not followed by a key
/// cannot be the start of one, so there is nothing to backtrack into.
#[must_use]
pub fn line_field(line: &str) -> Option<(&str, &str, usize, usize)> {
    let mut at = blanks(line);
    let rest = &line[at..];
    let marker = if rest.starts_with(['-', '*', '+']) {
        Some(1)
    } else {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        ((1..=9).contains(&digits) && rest[digits..].starts_with(['.', ')'])).then_some(digits + 1)
    };
    if let Some(width) = marker {
        let gap = blanks(&rest[width..]);
        if gap > 0 {
            at += width + gap;
            let after = &line.as_bytes()[at..];
            if after.len() > 3
                && after[0] == b'['
                && matches!(after[1], b' ' | b'x' | b'X')
                && after[2] == b']'
            {
                let gap = blanks(&line[at + 3..]);
                if gap > 0 {
                    at += 3 + gap;
                }
            }
        }
    }
    let rest = &line[at..];
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
    let trailing = line.len() - line.trim_end_matches([' ', '\t']).len();
    Some((key, value, at, line.len() - trailing))
}

/// §3.2 `own(raw)`: the block's `raw` with the span of every **direct**
/// child blanked — `child.span.start − block.span.start` up to
/// `child.span.end − block.span.start`, each byte a space except `\n`,
/// which stays (exactly as [`mask_code`]'s blanking; a `\r` becomes a space
/// too) so the line form still sees lines. Byte-length preserving: an offset into the result is an
/// offset into `raw`, so `spec/graph` spans stay in `raw` coordinates. A
/// container's own text is its markers, prefixes and blank lines; a field
/// inside a child is found by the child. A child span outside the parent's,
/// reversed, or off a character boundary is impossible for a parsed tree
/// (`spec/format` §1 inv. 3) and is skipped rather than clamped.
#[must_use]
pub fn own_text(block: &DocBlock<'_>) -> String {
    if block.children.is_empty() {
        return block.raw.to_owned();
    }
    let raw = block.raw;
    let mut bytes = raw.as_bytes().to_vec();
    let base = block.span.0;
    for child in &block.children {
        let (Some(start), Some(end)) = (
            child.span.0.checked_sub(base),
            child.span.1.checked_sub(base),
        ) else {
            continue;
        };
        if start > end
            || end > raw.len()
            || !raw.is_char_boundary(start)
            || !raw.is_char_boundary(end)
        {
            continue;
        }
        for b in &mut bytes[start..end] {
            if *b != b'\n' {
                *b = b' ';
            }
        }
    }
    String::from_utf8(bytes).expect("blanking whole characters keeps UTF-8")
}

fn scan_block(block: &DocBlock<'_>, out: &mut Vec<Occurrence>) {
    if block.kind != BlockKind::CodeFence {
        let scan = mask_code(&own_text(block));
        for m in BRACKETED.captures_iter(&scan) {
            out.push(Occurrence {
                key: m[1].to_owned(),
                value: m[2].to_owned(),
                block_id: block.block_id.to_owned(),
            });
        }
        // JavaScript's multiline `^`/`$` sit at LF, CR, U+2028 and U+2029.
        for line in scan.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
            if let Some((key, value, _, _)) = line_field(line) {
                out.push(Occurrence {
                    key: key.to_owned(),
                    value: value.to_owned(),
                    block_id: block.block_id.to_owned(),
                });
            }
        }
    }
    for child in &block.children {
        scan_block(child, out);
    }
}

/// §3.2: every inline-field occurrence over the body blocks in pre-order,
/// each block scanned over `mask_code(own_text(block))` — so a field belongs
/// to the innermost block that contains it (1.1; §8 for the old count).
#[must_use]
pub fn inline_occurrences(blocks: &[DocBlock<'_>]) -> Vec<Occurrence> {
    let mut out = Vec::new();
    for b in blocks {
        scan_block(b, &mut out);
    }
    out
}

/// A JavaScript whitespace or line terminator (`StrWhiteSpaceChar`).
fn trim_js(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// The value of a `StringNumericLiteral` (ECMA-262 `Number(string)`), or
/// `None` when `s` is not one. `s` is already trimmed. The empty string is
/// not accepted here (the caller excludes it; `Number("")` is 0).
#[must_use]
pub fn js_number(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    let b = s.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let digits = &s[2..];
            if !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            let mut acc: u128 = 0;
            let mut approx = 0.0_f64;
            let mut overflow = false;
            for c in digits.chars() {
                let d = c.to_digit(radix).expect("checked above");
                if !overflow {
                    match acc
                        .checked_mul(u128::from(radix))
                        .and_then(|a| a.checked_add(u128::from(d)))
                    {
                        Some(next) => acc = next,
                        None => {
                            overflow = true;
                            approx = acc as f64;
                        }
                    }
                }
                if overflow {
                    approx = approx * f64::from(radix) + f64::from(d);
                }
            }
            return Some(if overflow { approx } else { acc as f64 });
        }
    }
    let (negative, rest) = match b[0] {
        b'-' => (true, &s[1..]),
        b'+' => (false, &s[1..]),
        _ => (false, s),
    };
    if rest == "Infinity" {
        return Some(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [exp] | . digits [exp]
    let rb = rest.as_bytes();
    let mut i = 0;
    let int_digits = rb.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if i < rb.len() && rb[i] == b'.' {
        i += 1;
        frac_digits = rb[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return None;
    }
    if i < rb.len() && (rb[i] == b'e' || rb[i] == b'E') {
        i += 1;
        if i < rb.len() && (rb[i] == b'+' || rb[i] == b'-') {
            i += 1;
        }
        let exp_digits = rb[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return None;
        }
        i += exp_digits;
    }
    if i != rb.len() {
        return None;
    }
    // Normalize for Rust's grammar: a digit on each side of the point.
    let mut lit = rest.to_owned();
    if lit.starts_with('.') {
        lit.insert(0, '0');
    }
    lit = lit.replace(".e", ".0e").replace(".E", ".0E");
    if lit.ends_with('.') {
        lit.push('0');
    }
    let v: f64 = lit.parse().expect("a validated decimal literal");
    Some(if negative { -v } else { v })
}

/// §3.2 value coercion (`typedInlineValue`): trim with the JavaScript trim
/// set; exact `true`/`false` → bool; a non-empty JavaScript numeric string
/// converting to a finite number → number; else string. Ranges (§2.2) do
/// **not** apply (§8).
#[must_use]
pub fn typed_inline_value(raw: &str) -> Typed {
    let v = trim_js(raw);
    match v {
        "true" => return Typed::bool(true),
        "false" => return Typed::bool(false),
        _ => {}
    }
    if !v.is_empty() {
        if let Some(n) = js_number(v).filter(|n| n.is_finite()) {
            return Typed::number(n);
        }
    }
    Typed::string(v)
}

/// §3.2 card and ord: a key with one occurrence is a scalar row; several
/// are list rows in occurrence order. Returns `(block_id, row)` pairs in
/// occurrence order.
#[must_use]
pub fn inline_rows(occurrences: &[Occurrence]) -> Vec<(String, FlatRow)> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for o in occurrences {
        *counts.entry(o.key.as_str()).or_insert(0) += 1;
    }
    let mut next_ord: HashMap<&str, u32> = HashMap::new();
    occurrences
        .iter()
        .map(|o| {
            let ord = next_ord.entry(o.key.as_str()).or_insert(0);
            let this = *ord;
            *ord += 1;
            let card = if counts[o.key.as_str()] > 1 {
                Card::List
            } else {
                Card::Scalar
            };
            (
                o.block_id.clone(),
                FlatRow {
                    key: o.key.clone(),
                    card,
                    ord: this,
                    typed: typed_inline_value(&o.value),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::parse_markdown;

    #[test]
    fn masks_fences_and_spans_preserving_lines() {
        assert_eq!(mask_code("plain"), "plain");
        assert_eq!(mask_code("a `code` b"), "a        b");
        assert_eq!(mask_code("a ``x ` y`` b"), "a           b");
        assert_eq!(mask_code("a `unclosed b"), "a `unclosed b");
        assert_eq!(mask_code("a ``x` b"), "a ``x` b", "runs must match exactly");
        assert_eq!(
            mask_code("```\nk:: v\n```\nafter"),
            "   \n     \n   \nafter"
        );
        assert_eq!(mask_code("~~~\nk:: v\n~~~~\nx"), "   \n     \n    \nx");
        assert_eq!(
            mask_code("```\nk:: v\n~~~\nx"),
            "   \n     \n   \n ",
            "wrong closer: runs to the end"
        );
        assert_eq!(
            mask_code("````\nk:: v\n```\nx"),
            "    \n     \n   \n ",
            "shorter closer: runs to the end"
        );
        assert_eq!(
            mask_code("``` a`b\nk:: v"),
            "``` a`b\nk:: v",
            "backtick in a backtick fence's info string"
        );
        assert_eq!(
            mask_code("~~~ a`b\nk:: v"),
            "       \n     ",
            "fine for a tilde fence"
        );
        assert_eq!(
            mask_code("\t```\nx\n  ```\ny"),
            "    \n \n     \ny",
            "any indent, as the reference"
        );
        assert_eq!(
            mask_code("- item\n  ```\n  k:: v\n  ```"),
            "- item\n     \n       \n     "
        );
        assert_eq!(mask_code("a `é` b"), "a     b", "one space per character");
    }

    #[test]
    fn line_form() {
        assert_eq!(line_field("key:: value"), Some(("key", "value", 0, 11)));
        assert_eq!(
            line_field("  \tKey_1::\t two words \t"),
            Some(("Key_1", "two words", 3, 21))
        );
        assert_eq!(line_field("key::"), Some(("key", "", 0, 5)));
        assert_eq!(line_field("key:: "), Some(("key", "", 0, 5)));
        assert_eq!(line_field("> key:: v"), None);
        assert_eq!(line_field("1key:: v"), None);
        assert_eq!(line_field("key: v"), None);
        assert_eq!(line_field("key-1:: v"), None);
        assert_eq!(line_field("[key:: v]"), None);
        assert_eq!(line_field("(key:: v)"), None);
        assert_eq!(line_field("ключ:: v"), None);
        assert_eq!(line_field("key:: [a] (b)"), Some(("key", "[a] (b)", 0, 13)));
    }

    #[test]
    fn line_form_admits_a_list_marker_and_a_task_checkbox() {
        assert_eq!(line_field("- key:: v"), Some(("key", "v", 2, 9)));
        assert_eq!(line_field("* key:: v"), Some(("key", "v", 2, 9)));
        assert_eq!(line_field("+ key:: v"), Some(("key", "v", 2, 9)));
        assert_eq!(line_field("1. key:: v"), Some(("key", "v", 3, 10)));
        assert_eq!(line_field("1) key:: v"), Some(("key", "v", 3, 10)));
        assert_eq!(line_field("123456789. key:: v"), Some(("key", "v", 11, 18)));
        assert_eq!(line_field("  -\t key::  v  "), Some(("key", "v", 5, 13)));
        assert_eq!(line_field("- [ ] due:: fri"), Some(("due", "fri", 6, 15)));
        assert_eq!(line_field("- [x] due:: fri"), Some(("due", "fri", 6, 15)));
        assert_eq!(line_field("- [X] due:: fri"), Some(("due", "fri", 6, 15)));
        assert_eq!(line_field("1. [ ] due::"), Some(("due", "", 7, 12)));
        // Not a marker: no blank after it, ten digits, `>` or `.` alone.
        assert_eq!(line_field("-key:: v"), None);
        assert_eq!(line_field("1.key:: v"), None);
        assert_eq!(line_field("1234567890. key:: v"), None);
        assert_eq!(line_field("> key:: v"), None);
        assert_eq!(line_field(". key:: v"), None);
        // A checkbox needs the marker, the exact shape, and a blank after it.
        assert_eq!(line_field("[ ] key:: v"), None);
        assert_eq!(line_field("- [ ]key:: v"), None);
        assert_eq!(line_field("- [y] key:: v"), None);
        assert_eq!(line_field("- [  ] key:: v"), None);
        // A marker followed by no key is nothing.
        assert_eq!(line_field("- - key:: v"), None);
        assert_eq!(line_field("- [ ] [k:: v]"), None);
    }

    #[test]
    fn own_text_blanks_direct_children_only() {
        let tree = parse_markdown("- a\n  - b\n    job:: x\n- c\n");
        let ids: Vec<String> = (0..DocBlock::count(&tree.children))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        let list = &blocks[0];
        assert_eq!(own_text(list), "   \n     \n           \n   ");
        let item = &list.children[0];
        assert_eq!(item.raw, "- a\n  - b\n    job:: x");
        // The paragraph `a` and the inner list are blanked; the marker and
        // the indentation stay.
        assert_eq!(own_text(item), "-  \n     \n           ");
        let inner = &item.children[1].children[0];
        assert_eq!(inner.raw, "- b\n    job:: x");
        assert_eq!(own_text(inner), inner.raw, "a leaf is its own text");
        // Byte length is preserved around non-ASCII.
        let tree = parse_markdown("> é [k:: v]\n");
        let ids = ["b_0".to_owned(), "b_1".to_owned()];
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        let own = own_text(&blocks[0]);
        assert_eq!(own.len(), blocks[0].raw.len());
        assert_eq!(own, ">           ");
        // A child span outside the parent is skipped, not clamped.
        let bogus = DocBlock {
            block_id: "b_9",
            kind: BlockKind::ListItem,
            span: (100, 105),
            raw: "- k:: v",
            text: "k:: v",
            attrs: blocks[0].attrs,
            children: vec![DocBlock {
                block_id: "b_10",
                kind: BlockKind::Paragraph,
                span: (0, 3),
                raw: "k::",
                text: "k::",
                attrs: blocks[0].attrs,
                children: Vec::new(),
            }],
        };
        assert_eq!(own_text(&bogus), "- k:: v");
    }

    fn occurrences(source: &str) -> Vec<(String, String, String)> {
        let tree = parse_markdown(source);
        let ids: Vec<String> = (0..DocBlock::count(&tree.children))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        inline_occurrences(&blocks)
            .into_iter()
            .map(|o| (o.key, o.value, o.block_id))
            .collect()
    }

    #[test]
    fn bracketed_then_line_form_per_block() {
        let occ = occurrences(
            "# H\n\nSee [element:: quick silver] in the text (state:: liquid metal).\n\nknown_for:: tria prima\n",
        );
        assert_eq!(
            occ,
            vec![
                (
                    "element".to_owned(),
                    "quick silver".to_owned(),
                    "b_1".to_owned()
                ),
                (
                    "state".to_owned(),
                    "liquid metal".to_owned(),
                    "b_1".to_owned()
                ),
                (
                    "known_for".to_owned(),
                    "tria prima".to_owned(),
                    "b_2".to_owned()
                ),
            ]
        );
        // Within one block: all bracketed first, then all line-form.
        let occ = occurrences("a:: 1\nSee [b:: 2] here\nc:: 3\n");
        assert_eq!(
            occ.iter().map(|o| o.0.as_str()).collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
        // Mixed closers, case preserved, tabs trimmed.
        let occ = occurrences("x (Key::\tval ] y\n");
        assert_eq!(
            occ,
            vec![("Key".to_owned(), "val".to_owned(), "b_0".to_owned())]
        );
        // A bracketed field on its own line is one occurrence.
        assert_eq!(occurrences("[k:: v]\n").len(), 1);
        // Code is not prose.
        assert!(occurrences("```\nk:: v\n```\n").is_empty());
        assert!(occurrences("`k:: v`\n").is_empty());
        assert!(occurrences("see `[k:: v]` here\n").is_empty());
    }

    #[test]
    fn containers_scan_their_own_text_only() {
        // Continuation-line field: the item (the list's own text is blank).
        let occ = occurrences("- a\n  job:: x\n");
        assert_eq!(
            occ,
            vec![("job".to_owned(), "x".to_owned(), "b_1".to_owned())]
        );
        // Marker-line field: the item, since 1.1.
        let occ = occurrences("- job:: x\n\n1. num:: y\n");
        assert_eq!(
            occ,
            vec![
                ("job".to_owned(), "x".to_owned(), "b_1".to_owned()),
                ("num".to_owned(), "y".to_owned(), "b_3".to_owned()),
            ]
        );
        // A task item's marker line.
        let occ = occurrences("- [ ] due:: fri\n");
        assert_eq!(
            occ,
            vec![("due".to_owned(), "fri".to_owned(), "b_1".to_owned())]
        );
        // Bracketed inside a blockquote: the paragraph only.
        let occ = occurrences("> See [k:: v]\n");
        assert_eq!(
            occ.iter().map(|o| o.2.as_str()).collect::<Vec<_>>(),
            ["b_1"]
        );
        // A `> `-prefixed line-form field never matches; the paragraph's own
        // first line starts at content and does.
        let occ = occurrences("> k:: v\n> j:: w\n");
        assert_eq!(
            occ,
            vec![("k".to_owned(), "v".to_owned(), "b_1".to_owned())]
        );
        // An item with children holds no text of its own: the continuation
        // line is the paragraph child's.
        let occ = occurrences("- a\n  job:: x\n  - b\n");
        assert_eq!(
            occ,
            vec![("job".to_owned(), "x".to_owned(), "b_2".to_owned())]
        );
        // Nested: the innermost item.
        let occ = occurrences("- a\n  - b\n    job:: x\n");
        assert_eq!(
            occ,
            vec![("job".to_owned(), "x".to_owned(), "b_4".to_owned())]
        );
    }

    #[test]
    fn javascript_number_grammar() {
        let n = |s: &str| js_number(s);
        assert_eq!(n("12"), Some(12.0));
        assert_eq!(n("1.5"), Some(1.5));
        assert_eq!(n(".5"), Some(0.5));
        assert_eq!(n("5."), Some(5.0));
        assert_eq!(n("1e3"), Some(1000.0));
        assert_eq!(n("1E-2"), Some(0.01));
        assert_eq!(n("5.e3"), Some(5000.0));
        assert_eq!(n("+5"), Some(5.0));
        assert_eq!(n("-5.5"), Some(-5.5));
        assert_eq!(n("-.5"), Some(-0.5));
        assert_eq!(n("012"), Some(12.0));
        assert_eq!(n("0x10"), Some(16.0));
        assert_eq!(n("0XfF"), Some(255.0));
        assert_eq!(n("0o17"), Some(15.0));
        assert_eq!(n("0b101"), Some(5.0));
        assert_eq!(n("Infinity"), Some(f64::INFINITY));
        assert_eq!(n("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(n("1e400"), Some(f64::INFINITY));
        assert!(n("-0").is_some_and(|v| v == 0.0 && v.is_sign_negative()));
        for s in [
            "", "1_000", "12px", "NaN", "0x", "0b", "0o8", "0x1g", "-0x10", "+0b1", ".", "1e",
            "1e+", "e3", "1.5.2", "١٢", "infinity", "1 000", "0x 10", "--1", "1-", "0b102",
        ] {
            assert_eq!(n(s), None, "{s:?}");
        }
    }

    #[test]
    fn inline_value_coercion() {
        assert_eq!(typed_inline_value("true"), Typed::bool(true));
        assert_eq!(typed_inline_value(" false\t"), Typed::bool(false));
        assert_eq!(typed_inline_value("True"), Typed::string("True"));
        assert_eq!(typed_inline_value("3"), Typed::number(3.0));
        assert_eq!(typed_inline_value("0x10"), Typed::number(16.0));
        assert_eq!(typed_inline_value(".5"), Typed::number(0.5));
        assert_eq!(typed_inline_value("Infinity"), Typed::string("Infinity"));
        assert_eq!(typed_inline_value("NaN"), Typed::string("NaN"));
        assert_eq!(typed_inline_value("1_000"), Typed::string("1_000"));
        assert_eq!(typed_inline_value("12px"), Typed::string("12px"));
        assert_eq!(typed_inline_value(""), Typed::string(""));
        assert_eq!(typed_inline_value("\u{00A0}x\u{FEFF}"), Typed::string("x"));
        assert_eq!(
            typed_inline_value("1..5"),
            Typed::string("1..5"),
            "no range detection inline"
        );
        assert_eq!(
            typed_inline_value("2026-01-01"),
            Typed::string("2026-01-01")
        );
    }

    #[test]
    fn card_and_ord_per_key() {
        let occ = |k: &str, v: &str, b: &str| Occurrence {
            key: k.into(),
            value: v.into(),
            block_id: b.into(),
        };
        let rows = inline_rows(&[
            occ("job", "janitor", "b_1"),
            occ("element", "fire", "b_1"),
            occ("job", "salesman", "b_2"),
        ]);
        let view: Vec<(&str, &str, Card, u32)> = rows
            .iter()
            .map(|(b, r)| (b.as_str(), r.key.as_str(), r.card, r.ord))
            .collect();
        assert_eq!(
            view,
            vec![
                ("b_1", "job", Card::List, 0),
                ("b_1", "element", Card::Scalar, 0),
                ("b_2", "job", Card::List, 1)
            ]
        );
        // Keys are case-sensitive as written.
        let rows = inline_rows(&[occ("Job", "a", "b_0"), occ("job", "b", "b_0")]);
        assert!(rows.iter().all(|(_, r)| r.card == Card::Scalar));
    }
}
