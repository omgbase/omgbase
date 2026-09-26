//! Normalized visible text (`spec/format/README.md` §4.1).
//!
//! Type-aware, from a block's `raw`: strip the kind's block-level markers
//! (ATX heading hashes; list markers and task checkboxes), split into lines,
//! trim each line with the JavaScript trim set, collapse `[ \t]+`, drop empty
//! lines, join with one space, NFC.

use unicode_normalization::UnicodeNormalization;

use crate::block::BlockKind;

/// The JavaScript `String.prototype.trim` set as the reference (V8) applies
/// it: Unicode `White_Space` plus U+FEFF (§4.1 step 3, §6 "Trim set").
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

/// §4.1 step 1 for `heading`: one leading `[ \t]*#{1,6}[ \t]+`, then one
/// trailing `[ \t]+#*[ \t]*` at the very end of the (whole) string.
fn strip_heading_markers(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = skip_blank(b, 0);
    let hashes_start = i;
    while i < b.len() && b[i] == b'#' {
        i += 1;
    }
    let hashes = i - hashes_start;
    let s = if (1..=6).contains(&hashes) && i < b.len() && is_blank(b[i]) {
        &s[skip_blank(b, i)..]
    } else {
        s
    };

    // Trailing `[ \t]+#*[ \t]*$`, read from the end: a blank run W2, a run of
    // hashes H, a blank run W1. The regex needs W1 non-empty when H is
    // non-empty; with H empty (or W1 empty) it can still match the plain
    // blank run W2.
    let b = s.as_bytes();
    let mut j = b.len();
    while j > 0 && is_blank(b[j - 1]) {
        j -= 1;
    }
    let w2_start = j;
    while j > 0 && b[j - 1] == b'#' {
        j -= 1;
    }
    let h_start = j;
    while j > 0 && is_blank(b[j - 1]) {
        j -= 1;
    }
    let w1_start = j;
    if w1_start < h_start {
        &s[..w1_start]
    } else if w2_start < b.len() {
        &s[..w2_start]
    } else {
        s
    }
}

/// §4.1 step 1 for `list_item`/`task`: at the very start,
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

/// §4.1 step 1: the kind-specific marker stripping, and nothing else.
#[must_use]
pub fn strip_markers(raw: &str, kind: BlockKind) -> &str {
    match kind {
        BlockKind::Heading => strip_heading_markers(raw),
        BlockKind::ListItem | BlockKind::Task => strip_list_markers(raw),
        _ => raw,
    }
}

/// Collapse every run of spaces and tabs to one space (§4.1 step 4).
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

/// §4.1 steps 2–6 (kind-agnostic): split on `\r\n` | `\r` | `\n`, trim each
/// line with the JS trim set, collapse `[ \t]+`, drop empty lines, join with
/// one space, NFC.
#[must_use]
pub fn normalize_text(raw: &str) -> String {
    let mut joined = String::with_capacity(raw.len());
    // Splitting on each of `\r` and `\n` separately turns a `\r\n` into one
    // extra empty line, which step 5 drops — the same result as splitting on
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

/// §4.1 in full: kind-aware marker stripping, then [`normalize_text`].
#[must_use]
pub fn normalize_visible_text(raw: &str, kind: BlockKind) -> String {
    normalize_text(strip_markers(raw, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn nfc() {
        // e + combining acute -> é
        assert_eq!(normalize_text("e\u{0301}"), "\u{00E9}");
        assert_eq!(normalize_text("\u{00E9}"), "\u{00E9}");
    }

    #[test]
    fn heading_markers() {
        let h = |s: &str| normalize_visible_text(s, BlockKind::Heading);
        assert_eq!(h("# Title"), "Title");
        assert_eq!(h("  ###\tTitle  ##  "), "Title");
        assert_eq!(h("###### Six"), "Six");
        assert_eq!(h("####### Seven"), "####### Seven");
        assert_eq!(h("#NoSpace"), "#NoSpace");
        assert_eq!(h("# Title #"), "Title");
        assert_eq!(h("# Title#"), "Title#");
        assert_eq!(h("# Title#  "), "Title#");
        assert_eq!(h("# # "), "#");
        assert_eq!(h("Title One\n========="), "Title One =========");
        assert_eq!(h("# a # b ##"), "a # b");
    }

    #[test]
    fn list_markers() {
        let li = |s: &str| normalize_visible_text(s, BlockKind::ListItem);
        let task = |s: &str| normalize_visible_text(s, BlockKind::Task);
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
        assert_eq!(
            normalize_visible_text("- item", BlockKind::Paragraph),
            "- item"
        );
        assert_eq!(normalize_visible_text("# T", BlockKind::Paragraph), "# T");
    }
}
