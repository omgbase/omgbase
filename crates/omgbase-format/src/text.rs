//! Normalized visible text (`spec/format/README.md` §4.1): what a reader
//! sees, with every piece of block-level Markdown syntax removed and
//! whitespace normalized. Inline syntax (emphasis, backticks, link brackets,
//! escapes) is content and stays.
//!
//! Two rules, chosen by the block's place in the tree:
//!
//! - **Leaf blocks** (`paragraph`, `heading`, `code_fence`, `html_block`,
//!   `thematic_break`, `frontmatter`, `opaque`, `table_row`, and a
//!   `list_item`/`task` with no children) compute `text` from their `raw`:
//!   strip up to *q* blockquote markers from every line after the first
//!   (*q* = the number of `blockquote` ancestors), strip the kind's own
//!   syntax (heading hashes or setext underline, frontmatter and code fences,
//!   list markers and checkboxes, table pipes, a thematic break entirely),
//!   then split into lines, trim each with the JavaScript trim set, collapse
//!   `[ \t]+`, drop empty lines, join with one space, NFC.
//!   [`normalize_visible_text`] is this rule; [`normalize_text`] is its
//!   kind-agnostic tail.
//! - **Container blocks** (`list`, `blockquote`, `table`, and a
//!   `list_item`/`task` with children) have `text` = their children's `text`
//!   values joined by one space, empties skipped ([`join_texts`]). Their own
//!   markers never appear because no child's `raw` contains them.
//!
//! [`block_text`] picks the rule for a block whose children already carry
//! their text; the parser calls it bottom-up.

use std::borrow::Cow;

use unicode_normalization::UnicodeNormalization;

use crate::block::{Block, BlockKind};

/// The JavaScript `String.prototype.trim` set as the reference (V8) applies
/// it: Unicode `White_Space` plus U+FEFF (§4.1 step 4, §6 "Trim set").
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

const fn is_blank(b: u8) -> bool {
    matches!(b, b' ' | b'\t')
}

fn skip_blank(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && is_blank(b[i]) {
        i += 1;
    }
    i
}

/// Number of leading spaces (not tabs) in `b`, capped at 4 so "up to three
/// spaces" is a `<= 3` test.
fn leading_spaces(b: &[u8]) -> usize {
    b.iter().take(4).take_while(|&&c| c == b' ').count()
}

/// Everything before the last line: `s` with its final line (and the line
/// ending that introduces it) removed. A single-line `s` becomes `""`.
fn drop_last_line(s: &str) -> &str {
    match s.rfind(['\r', '\n']) {
        Some(i) => s[..i].strip_suffix('\r').unwrap_or(&s[..i]),
        None => "",
    }
}

/// Everything after the first line ending. A single-line `s` becomes `""`.
fn drop_first_line(s: &str) -> &str {
    match s.find(['\r', '\n']) {
        Some(i) => {
            let rest = &s[i + 1..];
            if s.as_bytes()[i] == b'\r' {
                rest.strip_prefix('\n').unwrap_or(rest)
            } else {
                rest
            }
        }
        None => "",
    }
}

/// The last line of `s` (after the last line ending; all of `s` when there
/// is none).
fn last_line(s: &str) -> &str {
    s.rfind(['\r', '\n']).map_or(s, |i| &s[i + 1..])
}

/// The first line of `s` (before the first line ending).
fn first_line(s: &str) -> &str {
    s.find(['\r', '\n']).map_or(s, |i| &s[..i])
}

// ---- §4.1 step 1: blockquote markers ---------------------------------------------

/// Remove up to `q` leading blockquote markers from one line, each
/// `[ \t]*>` followed by at most one space. Stops early at the first
/// non-marker (a lazy continuation line carries fewer than `q`).
fn strip_line_quote_markers(line: &str, q: usize) -> &str {
    let b = line.as_bytes();
    let mut i = 0;
    for _ in 0..q {
        let j = skip_blank(b, i);
        if j < b.len() && b[j] == b'>' {
            i = j + 1;
            if i < b.len() && b[i] == b' ' {
                i += 1;
            }
        } else {
            break;
        }
    }
    &line[i..]
}

/// §4.1 step 1: on every line after the first, remove up to `quote_depth`
/// blockquote markers (each `[ \t]*>` and at most one following space). The
/// first line already starts at content (§1 inv. 7). Lines in a code block
/// that themselves begin with `>` survive because only `quote_depth`
/// markers go. Line endings are preserved as written.
#[must_use]
pub fn strip_quote_markers(raw: &str, quote_depth: usize) -> Cow<'_, str> {
    if quote_depth == 0 || !raw.contains(['\r', '\n']) {
        return Cow::Borrowed(raw);
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    let mut first = true;
    loop {
        let (line, ending, next) = match rest.find(['\r', '\n']) {
            Some(i) => {
                let width = if rest[i..].starts_with("\r\n") { 2 } else { 1 };
                (&rest[..i], &rest[i..i + width], &rest[i + width..])
            }
            None => (rest, "", ""),
        };
        out.push_str(if first {
            line
        } else {
            strip_line_quote_markers(line, quote_depth)
        });
        out.push_str(ending);
        if ending.is_empty() {
            break;
        }
        first = false;
        rest = next;
    }
    Cow::Owned(out)
}

// ---- §4.1 step 2: kind syntax -----------------------------------------------------

/// ATX heading: remove the opening run — up to three spaces, one to six
/// `#`, then the spaces/tabs after them (the run may be the whole line: `#`
/// alone is an empty heading) — then the closing sequence, if any: a run of
/// `#` that is the entire remainder or is preceded by at least one
/// space/tab, together with any surrounding spaces/tabs.
fn strip_atx_markers(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = skip_blank(b, 0);
    let hashes_start = i;
    while i < b.len() && b[i] == b'#' {
        i += 1;
    }
    let hashes = i - hashes_start;
    // A heading's raw always has 1–6 hashes followed by a blank or the end;
    // anything else is left alone rather than guessed at.
    if !(1..=6).contains(&hashes) || (i < b.len() && !is_blank(b[i])) {
        return s;
    }
    let s = &s[skip_blank(b, i)..];

    // Closing sequence, read from the end: blanks, a run of `#`, and the
    // blank(s) before it — the run must be the whole remainder or follow a
    // space/tab, so `a#` keeps its hash.
    let b = s.as_bytes();
    let mut j = b.len();
    while j > 0 && is_blank(b[j - 1]) {
        j -= 1;
    }
    let run_end = j;
    while j > 0 && b[j - 1] == b'#' {
        j -= 1;
    }
    let run_start = j;
    if run_start == run_end {
        return &s[..run_end];
    }
    if run_start == 0 {
        return "";
    }
    if !is_blank(b[run_start - 1]) {
        return &s[..run_end];
    }
    while j > 0 && is_blank(b[j - 1]) {
        j -= 1;
    }
    &s[..j]
}

/// `heading`: setext iff the raw contains a line ending (an ATX heading is
/// always one line): drop the underline, the last line. ATX otherwise.
fn strip_heading_syntax(s: &str) -> &str {
    if s.contains(['\r', '\n']) {
        drop_last_line(s)
    } else {
        strip_atx_markers(s)
    }
}

/// The opening fence of `line` — after up to three spaces, a run of three or
/// more backticks or tildes — as (character, run length); `None` when the
/// line does not open a fence (indented code).
fn opening_fence(line: &str) -> Option<(u8, usize)> {
    let b = line.as_bytes();
    let spaces = leading_spaces(b);
    if spaces > 3 {
        return None;
    }
    let rest = &b[spaces..];
    let &first = rest.first()?;
    if !matches!(first, b'`' | b'~') {
        return None;
    }
    let run = rest.iter().take_while(|&&c| c == first).count();
    (run >= 3).then_some((first, run))
}

/// Is `line` the closing fence for an opener of `fence` repeated `min`
/// times: after up to three spaces, `fence` at least `min` times, then only
/// spaces/tabs (CommonMark's closer rule)?
fn is_closing_fence(line: &str, fence: u8, min: usize) -> bool {
    let b = line.as_bytes();
    let spaces = leading_spaces(b);
    if spaces > 3 {
        return false;
    }
    let rest = &b[spaces..];
    let run = rest.iter().take_while(|&&c| c == fence).count();
    run >= min && rest[run..].iter().all(|&c| is_blank(c))
}

/// `code_fence`: drop the opening fence line when there is one (its info
/// string lives in `attrs`), and the last line when it is the matching
/// closing fence. A shorter run, the other fence character, or a fence
/// followed by anything but blanks is content. Indented code has nothing to
/// drop.
fn strip_code_fence_syntax(s: &str) -> &str {
    let Some((fence, len)) = opening_fence(first_line(s)) else {
        return s;
    };
    let body = drop_first_line(s);
    if !body.is_empty() && is_closing_fence(last_line(body), fence, len) {
        drop_last_line(body)
    } else {
        body
    }
}

/// `frontmatter`: drop the first and the last line (the `---` fences).
fn strip_frontmatter_syntax(s: &str) -> &str {
    drop_last_line(drop_first_line(s))
}

/// `list_item`/`task` (childless): at the very start,
/// `[ \t]*([-*+]|[0-9]+[.)])[ \t]+`, then an optional `\[[ xX]\][ \t]+`.
fn strip_list_markers(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = skip_blank(b, 0);
    if i < b.len() && matches!(b[i], b'-' | b'*' | b'+') {
        i += 1;
    } else {
        let digits_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start || i >= b.len() || !matches!(b[i], b'.' | b')') {
            return s;
        }
        i += 1;
    }
    if i >= b.len() || !is_blank(b[i]) {
        return s;
    }
    let s = &s[skip_blank(b, i)..];

    let b = s.as_bytes();
    if b.len() > 3
        && b[0] == b'['
        && matches!(b[1], b' ' | b'x' | b'X')
        && b[2] == b']'
        && is_blank(b[3])
    {
        &s[skip_blank(b, 3)..]
    } else {
        s
    }
}

/// Is the `|` at byte `at` of `b` escaped — preceded by an odd number of
/// backslashes (`\|` is content, `\\|` is a delimiter; GFM's rule)?
fn pipe_is_escaped(b: &[u8], at: usize) -> bool {
    b[..at].iter().rev().take_while(|&&c| c == b'\\').count() % 2 == 1
}

/// `table_row`: remove one leading `|` and one trailing unescaped `|` (with
/// surrounding spaces/tabs), then replace every remaining unescaped `|` with
/// a space.
fn strip_table_row_syntax(s: &str) -> String {
    let b = s.as_bytes();
    let mut start = skip_blank(b, 0);
    if start < b.len() && b[start] == b'|' {
        start += 1;
    } else {
        start = 0;
    }
    let mut end = b.len();
    while end > start && is_blank(b[end - 1]) {
        end -= 1;
    }
    if end > start && b[end - 1] == b'|' && !pipe_is_escaped(b, end - 1) {
        end -= 1;
    } else {
        end = b.len();
    }
    let inner = &b[start..end];
    let mut out = Vec::with_capacity(inner.len());
    for (i, &c) in inner.iter().enumerate() {
        out.push(if c == b'|' && !pipe_is_escaped(inner, i) {
            b' '
        } else {
            c
        });
    }
    String::from_utf8(out).expect("only ASCII bytes were replaced by ASCII")
}

/// §4.1 step 2: strip the kind's own block-level syntax from a leaf block's
/// (quote-stripped) raw, and nothing else. `paragraph`, `html_block` and
/// `opaque` pass through; `thematic_break` becomes `""`.
#[must_use]
pub fn strip_kind_syntax(s: &str, kind: BlockKind) -> Cow<'_, str> {
    match kind {
        BlockKind::Heading => Cow::Borrowed(strip_heading_syntax(s)),
        BlockKind::Frontmatter => Cow::Borrowed(strip_frontmatter_syntax(s)),
        BlockKind::CodeFence => Cow::Borrowed(strip_code_fence_syntax(s)),
        BlockKind::ListItem | BlockKind::Task => Cow::Borrowed(strip_list_markers(s)),
        BlockKind::TableRow => Cow::Owned(strip_table_row_syntax(s)),
        BlockKind::ThematicBreak => Cow::Borrowed(""),
        BlockKind::Paragraph
        | BlockKind::HtmlBlock
        | BlockKind::Opaque
        | BlockKind::List
        | BlockKind::Blockquote
        | BlockKind::Table => Cow::Borrowed(s),
    }
}

// ---- §4.1 steps 3–7 -----------------------------------------------------------------

/// Collapse every run of spaces and tabs to one space (§4.1 step 5).
fn collapse_blanks(line: &str, out: &mut String) {
    let mut in_run = false;
    for c in line.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
}

/// §4.1 steps 3–7 (kind-agnostic): split on `\r\n` | `\r` | `\n`, trim each
/// line with the JS trim set, collapse `[ \t]+`, drop empty lines, join with
/// one space, NFC. No syntax is removed here.
#[must_use]
pub fn normalize_text(raw: &str) -> String {
    let mut joined = String::with_capacity(raw.len());
    // Splitting on each of `\r` and `\n` separately turns a `\r\n` into one
    // extra empty line, which step 6 drops — the same result as splitting on
    // `\r\n|\r|\n`.
    for line in raw.split(['\r', '\n']) {
        let line = line.trim_matches(is_js_whitespace);
        if line.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push(' ');
        }
        collapse_blanks(line, &mut joined);
    }
    joined.nfc().collect()
}

// ---- the two rules --------------------------------------------------------------------

/// §4.1 for a **leaf** block: strip up to `quote_depth` blockquote markers
/// from every line after the first ([`strip_quote_markers`]), strip the
/// kind's syntax ([`strip_kind_syntax`]), then [`normalize_text`].
/// `quote_depth` is the number of `blockquote` ancestors the block has.
///
/// For a container (`list`, `blockquote`, `table`, or an item with children)
/// use [`join_texts`] over the children — this function would see the
/// container's markers and its children's syntax as content.
#[must_use]
pub fn normalize_visible_text(raw: &str, kind: BlockKind, quote_depth: usize) -> String {
    let unquoted = strip_quote_markers(raw, quote_depth);
    normalize_text(&strip_kind_syntax(&unquoted, kind))
}

/// §4.1 for a **container** block: the children's `text` values, in order,
/// joined by a single space with empty ones skipped. All-empty (or no)
/// children give `""`.
#[must_use]
pub fn join_texts<'a>(texts: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for t in texts {
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

/// Does a block of `kind` take the container rule (children's text joined)
/// rather than the leaf rule (from `raw`)? `list`, `blockquote` and `table`
/// always; `list_item`/`task` only with children (the single-paragraph fold
/// leaves an item childless, and then it carries its own text).
#[must_use]
pub const fn uses_children_text(kind: BlockKind, has_children: bool) -> bool {
    match kind {
        BlockKind::List | BlockKind::Blockquote | BlockKind::Table => true,
        BlockKind::ListItem | BlockKind::Task => has_children,
        BlockKind::Frontmatter
        | BlockKind::Heading
        | BlockKind::Paragraph
        | BlockKind::CodeFence
        | BlockKind::TableRow
        | BlockKind::ThematicBreak
        | BlockKind::HtmlBlock
        | BlockKind::Opaque => false,
    }
}

/// §4.1 in full for one block whose `children` already carry their `text`:
/// the container rule ([`join_texts`]) when [`uses_children_text`], else the
/// leaf rule ([`normalize_visible_text`]) over `raw` with `quote_depth`
/// blockquote ancestors. Consumers recomputing `text` from stored blocks
/// need exactly this context (children and blockquote depth).
#[must_use]
pub fn block_text(kind: BlockKind, raw: &str, children: &[Block], quote_depth: usize) -> String {
    if uses_children_text(kind, !children.is_empty()) {
        join_texts(children.iter().map(|c| c.text.as_str()))
    } else {
        normalize_visible_text(raw, kind, quote_depth)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(kind: BlockKind, s: &str) -> String {
        normalize_visible_text(s, kind, 0)
    }

    #[test]
    fn js_trim_set_includes_bom_and_unicode_spaces() {
        assert_eq!(normalize_text("\u{FEFF}hello\u{FEFF}"), "hello");
        assert_eq!(normalize_text("\u{3000}\u{00A0}x\u{2003}"), "x");
        assert_eq!(normalize_text("\u{0085}x\u{000B}\u{000C}"), "x");
        // Not whitespace in JS either: zero-width space, Mongolian vowel separator.
        assert_eq!(normalize_text("\u{200B}x\u{180E}"), "\u{200B}x\u{180E}");
        assert!(is_js_whitespace('\u{FEFF}'));
        assert!(!is_js_whitespace('\u{200B}'));
    }

    #[test]
    fn lines_trim_collapse_and_join() {
        assert_eq!(normalize_text("  a  \t b \n\n\r\n  c\r d\t\n"), "a b c d");
        assert_eq!(normalize_text("\n\n"), "");
        assert_eq!(normalize_text(""), "");
        // Interior unicode spaces are content (only [ \t] collapses).
        assert_eq!(normalize_text("a\u{00A0}\u{00A0}b"), "a\u{00A0}\u{00A0}b");
        // normalize_text strips no syntax at all.
        assert_eq!(normalize_text("# T\n> q"), "# T > q");
    }

    #[test]
    fn nfc() {
        // e + combining acute -> é
        assert_eq!(normalize_text("e\u{0301}"), "\u{00E9}");
        assert_eq!(normalize_text("\u{00E9}"), "\u{00E9}");
    }

    #[test]
    fn atx_heading_markers_and_closing_hashes() {
        let h = |s: &str| leaf(BlockKind::Heading, s);
        assert_eq!(h("# Title"), "Title");
        assert_eq!(h("  ###\tTitle  ##  "), "Title");
        assert_eq!(h("###### Six"), "Six");
        assert_eq!(h("#NoSpace"), "#NoSpace", "not a heading; left alone");
        assert_eq!(h("# Title #"), "Title");
        assert_eq!(h("# Title ##########"), "Title");
        assert_eq!(h("# Title#"), "Title#");
        assert_eq!(h("# a#"), "a#");
        assert_eq!(h("# Title#  "), "Title#");
        assert_eq!(h("# a # b ##"), "a # b");
        assert_eq!(h("# `code` ##"), "`code`");
        // The opening run may be the whole line; a closing run may be the
        // entire remainder.
        assert_eq!(h("#"), "");
        assert_eq!(h("# "), "");
        assert_eq!(h("###"), "");
        assert_eq!(h("### ###"), "");
        assert_eq!(h("# # "), "");
        assert_eq!(h("#\t##\t"), "");
        assert_eq!(h("  ## x  ##  "), "x");
        assert_eq!(h("# a ## b"), "a ## b");
    }

    #[test]
    fn setext_heading_drops_the_underline() {
        let h = |s: &str| leaf(BlockKind::Heading, s);
        assert_eq!(h("Title One\n========="), "Title One");
        assert_eq!(h("Title Two\n---"), "Title Two");
        assert_eq!(h("Title  \n===  "), "Title");
        assert_eq!(h("Title\r\n==="), "Title");
        assert_eq!(h("Title\r==="), "Title");
        // A multi-line setext heading keeps all its content lines.
        assert_eq!(h("Line a\nLine b\n---"), "Line a Line b");
        // Indented (nested) underline.
        assert_eq!(h("Title\n  ====="), "Title");
        // Setext is decided by the line ending, not the first byte: a heading
        // whose content starts with `#` still drops its underline.
        assert_eq!(h("#hashtag\n===="), "#hashtag");
        assert_eq!(h("####### seven\n---"), "####### seven");
        assert_eq!(h("# not atx #\n==="), "# not atx #");
    }

    #[test]
    fn frontmatter_drops_both_fences() {
        let f = |s: &str| leaf(BlockKind::Frontmatter, s);
        assert_eq!(f("---\na: 1\nb: two\n---"), "a: 1 b: two");
        assert_eq!(f("---\r\na: 1\r\n---"), "a: 1");
        assert_eq!(f("---\n---"), "");
        assert_eq!(f("---\n\n---"), "");
    }

    #[test]
    fn fenced_code_drops_fence_lines() {
        let c = |s: &str| leaf(BlockKind::CodeFence, s);
        assert_eq!(c("```js\nlet x = 1;\n```"), "let x = 1;");
        assert_eq!(c("```js meta here\nx\ny\n```"), "x y");
        // Unclosed at EOF: only the opener goes.
        assert_eq!(c("```\nx\ny"), "x y");
        assert_eq!(c("```"), "");
        assert_eq!(c("```\n```"), "");
        // Tilde fences, and a closing fence longer than the opener.
        assert_eq!(c("~~~py\nprint()\n~~~"), "print()");
        assert_eq!(c("```\nx\n`````"), "x");
        assert_eq!(
            c("````\ncode with ``` inside\n````"),
            "code with ``` inside"
        );
        // Closing fence with surrounding blanks; CRLF.
        assert_eq!(c("```\r\nx\r\n  ```  "), "x");
        assert_eq!(c("```\nx\n```\t"), "x");
        // A last line that is not purely a fence is content.
        assert_eq!(c("```\nx\n``` y"), "x ``` y");
        // Up to three spaces before the opener and the closer; four is content.
        assert_eq!(c("   ```\nx\n```"), "x");
        assert_eq!(c("```\nx\n   ```"), "x");
        assert_eq!(c("```\nx\n    ```"), "x ```");
        // The closer must match the opener: same character, at least as long.
        assert_eq!(c("````\nx\n```"), "x ```");
        assert_eq!(c("~~~\nx\n```"), "x ```");
        assert_eq!(c("```\nx\n~~~"), "x ~~~");
        assert_eq!(c("~~~~\nx\n~~~~~"), "x");
        assert_eq!(c("`````\n```"), "```");
    }

    #[test]
    fn indented_code_is_untouched() {
        let c = |s: &str| leaf(BlockKind::CodeFence, s);
        assert_eq!(c("    indented"), "indented");
        assert_eq!(c("    a\n    b"), "a b");
        assert_eq!(c("\tcode"), "code");
        // Four spaces then backticks is indented code containing a fence.
        assert_eq!(c("    ```\n    x\n    ```"), "``` x ```");
    }

    #[test]
    fn table_row_pipes() {
        let r = |s: &str| leaf(BlockKind::TableRow, s);
        assert_eq!(r("| a | b |"), "a b");
        assert_eq!(r("|a|b|"), "a b");
        assert_eq!(r("a | b"), "a b");
        assert_eq!(r("| a |  "), "a");
        assert_eq!(r("| - | - |"), "- -");
        assert_eq!(r("| a \\| b | c |"), "a \\| b c");
        assert_eq!(r("| `x|y` |"), "`x y`");
        assert_eq!(r("|"), "");
        assert_eq!(r("||"), "");
        assert_eq!(r("| | |"), "");
        // An escaped trailing pipe is content, not the row's closing pipe.
        assert_eq!(r("| a \\|"), "a \\|");
        assert_eq!(r("\\| a |"), "\\| a");
        // Escaped iff preceded by an odd number of backslashes.
        assert_eq!(r("| a \\\\| b |"), "a \\\\ b");
        assert_eq!(r("| a \\\\\\| b |"), "a \\\\\\| b");
        assert_eq!(r("| a \\\\|"), "a \\\\");
        assert_eq!(r("| a \\\\\\|"), "a \\\\\\|");
        // Only one leading pipe goes; the next is a delimiter (empty cell).
        assert_eq!(r("|| a |"), "a");
    }

    #[test]
    fn thematic_break_is_empty() {
        for s in ["---", "***", "___", "- - -", "  ***  "] {
            assert_eq!(leaf(BlockKind::ThematicBreak, s), "", "{s:?}");
        }
    }

    #[test]
    fn list_markers() {
        let li = |s: &str| leaf(BlockKind::ListItem, s);
        let task = |s: &str| leaf(BlockKind::Task, s);
        assert_eq!(li("- item"), "item");
        assert_eq!(li("  * item"), "item");
        assert_eq!(li("+\titem"), "item");
        assert_eq!(li("12. item"), "item");
        assert_eq!(li("3) item"), "item");
        assert_eq!(li("-item"), "-item");
        assert_eq!(li("-1. x"), "-1. x");
        assert_eq!(li("a. item"), "a. item");
        assert_eq!(li("-"), "-");
        assert_eq!(li("- "), "");
        assert_eq!(task("- [ ] open"), "open");
        assert_eq!(task("- [x] done"), "done");
        assert_eq!(task("- [X]  done"), "done");
        assert_eq!(task("- [ ]"), "[ ]");
        assert_eq!(task("- [y] no"), "[y] no");
        // Only the first line's marker goes; continuation lines are content.
        assert_eq!(li("- a\n  - b"), "a - b");
        // Non-ASCII digits are not a marker.
        assert_eq!(li("\u{0661}. x"), "\u{0661}. x");
        // Other kinds strip nothing.
        assert_eq!(leaf(BlockKind::Paragraph, "- item"), "- item");
        assert_eq!(leaf(BlockKind::Paragraph, "# T"), "# T");
        assert_eq!(leaf(BlockKind::HtmlBlock, "<div>\n</div>"), "<div> </div>");
        assert_eq!(leaf(BlockKind::Opaque, "[ref]: x"), "[ref]: x");
    }

    #[test]
    fn blockquote_depth_strips_markers_on_continuation_lines() {
        let p = |s: &str, q: usize| normalize_visible_text(s, BlockKind::Paragraph, q);
        assert_eq!(p("level one\n> still one", 1), "level one still one");
        assert_eq!(p("a\n>b", 1), "a b");
        assert_eq!(p("a\n>  two spaces", 1), "a two spaces");
        // A tab after `>` stays and disappears in trimming/collapsing.
        assert_eq!(p("a\n>\tb", 1), "a b");
        assert_eq!(
            normalize_visible_text("```\n>\tx\n> ```", BlockKind::CodeFence, 1),
            "x"
        );
        assert_eq!(p("a\n> > b", 2), "a b");
        assert_eq!(p("a\n > b", 1), "a b");
        assert_eq!(p("a\r\n> b\r\n> c", 1), "a b c");
        // Lazy continuation: fewer than q markers.
        assert_eq!(p("a\nlazy", 1), "a lazy");
        assert_eq!(p("a\n> one\n> > two", 2), "a one two");
        // Depth 0 removes nothing.
        assert_eq!(p("a\n> b", 0), "a > b");
        // Only q markers go: at depth 1 an inner `>` is content.
        assert_eq!(p("a\n> > b", 1), "a > b");
        // A code line that itself starts with `>` survives.
        let c = normalize_visible_text("```\n> > not a quote\n> x\n> ```", BlockKind::CodeFence, 1);
        assert_eq!(c, "> not a quote x");
        // Setext underline and closing fence are recognized after unquoting.
        assert_eq!(
            normalize_visible_text("Title\n> ===", BlockKind::Heading, 1),
            "Title"
        );
        assert_eq!(
            normalize_visible_text("- a\n>   b", BlockKind::ListItem, 1),
            "a b"
        );
        assert_eq!(
            strip_quote_markers("x", 3),
            Cow::<str>::Borrowed("x"),
            "single line is untouched"
        );
    }

    fn block(kind: BlockKind, raw: &str, text: &str, children: Vec<Block>) -> Block {
        Block {
            kind,
            span: crate::block::Span::new(0, 0),
            raw: raw.to_owned(),
            text: text.to_owned(),
            attrs: crate::block::Attrs::new(),
            children,
            trivia: String::new(),
        }
    }

    #[test]
    fn containers_join_their_children() {
        assert_eq!(join_texts(["a", "", "b", "c"]), "a b c");
        assert_eq!(join_texts(["", ""]), "");
        assert_eq!(join_texts(std::iter::empty()), "");

        let a = block(BlockKind::ListItem, "- a", "a", Vec::new());
        let b = block(BlockKind::ListItem, "- b", "b", Vec::new());
        assert_eq!(block_text(BlockKind::List, "- a\n- b", &[a, b], 0), "a b");
        // A blockquote reads as prose; an empty one is "".
        let p = block(BlockKind::Paragraph, "q\n> r", "q r", Vec::new());
        assert_eq!(
            block_text(BlockKind::Blockquote, "> q\n> r", &[p], 0),
            "q r"
        );
        assert_eq!(block_text(BlockKind::Blockquote, ">", &[], 0), "");
        // A table is header cells then body cells.
        let h = block(BlockKind::TableRow, "| a | b |", "a b", Vec::new());
        let r = block(BlockKind::TableRow, "| 1 | 2 |", "1 2", Vec::new());
        assert_eq!(
            block_text(
                BlockKind::Table,
                "| a | b |\n| - | - |\n| 1 | 2 |",
                &[h, r],
                0
            ),
            "a b 1 2"
        );
        // Children with empty text are skipped.
        let rule = block(BlockKind::ThematicBreak, "---", "", Vec::new());
        let p = block(BlockKind::Paragraph, "x", "x", Vec::new());
        assert_eq!(
            block_text(BlockKind::Blockquote, "> ---\n> x", &[rule, p], 0),
            "x"
        );
    }

    #[test]
    fn list_items_with_children_lose_their_bullet() {
        // Two paragraphs: the bullet is the item's own byte, no child has it.
        let p1 = block(BlockKind::Paragraph, "a", "a", Vec::new());
        let p2 = block(BlockKind::Paragraph, "b", "b", Vec::new());
        assert_eq!(
            block_text(BlockKind::ListItem, "- a\n\n  b", &[p1, p2], 0),
            "a b"
        );
        // First child a code fence.
        let code = block(BlockKind::CodeFence, "```\ncode\n```", "code", Vec::new());
        assert_eq!(
            block_text(BlockKind::Task, "- [ ] ```\n  code\n  ```", &[code], 0),
            "code"
        );
        // Childless items use the leaf rule instead.
        assert_eq!(block_text(BlockKind::ListItem, "- a", &[], 0), "a");
        assert_eq!(block_text(BlockKind::Task, "- [x] a", &[], 0), "a");
        assert!(uses_children_text(BlockKind::ListItem, true));
        assert!(!uses_children_text(BlockKind::ListItem, false));
        assert!(uses_children_text(BlockKind::Blockquote, false));
        assert!(!uses_children_text(BlockKind::Paragraph, true));
    }
}
