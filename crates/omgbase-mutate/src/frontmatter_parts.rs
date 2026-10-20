//! Frontmatter entries (`spec/mutate` §11.10, 3.6). The effect planner's
//! `set`/`unset frontmatter.<key>` edits ONE entry of a document's frontmatter
//! and leaves every other byte alone (§11.3). To do that the `frontmatter`
//! block's raw (fences included) is cut into an ordered list of PARTS — the
//! opening fence line, one part per top-level YAML entry (with the lines that
//! continue it and the comment lines that lead it), the trailing comment/blank
//! lines, the closing fence — by a LEXICAL, line-based rule, not a YAML parse:
//! it is total (every frontmatter the store holds, valid YAML or not, splits),
//! byte-exact (the parts concatenate back to the raw, always) and identical in
//! both engines; what a line *means* is the properties layer's business. Where
//! the rule and YAML disagree (a pathological document) the edit may touch a
//! wider or narrower run of lines than a YAML parser would, but never loses a
//! byte of the other entries.
//!
//! Storage is untouched: a revision's frontmatter stays one blob (`spec/store`
//! 15.0). The parts are the planner's view of the bytes, computed from
//! `frontmatter_raw` when a frontmatter key is set or unset. The reference is
//! `packages/core/src/mutate/frontmatter-parts.ts`, function for function.

/// One part: `key` is the entry's key (`None` for a fence, the lines before
/// the first entry, the trailing lines) and `bytes` its text, line endings
/// included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmatterPart {
    pub key: Option<String>,
    pub bytes: String,
}

/// A document head cut at the closing fence: the `frontmatter` block's raw
/// (fences included, no trailing line ending) and the trivia after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmatterSplit {
    pub raw: String,
    pub trivia: String,
}

/// Split text into lines, each keeping its own line ending (`\n` or `\r\n`);
/// the last line has none. `""` → `[""]`.
#[must_use]
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push(&text[start..=i]);
            start = i + 1;
        }
    }
    out.push(&text[start..]);
    out
}

/// A line without its line ending.
fn content(line: &str) -> &str {
    line.strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line)
}

/// The line ending of `line` (`"\r\n"`, `"\n"`, or `""` when it has none).
#[must_use]
pub fn line_ending_of(line: &str) -> &'static str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

/// A blank line (empty, or spaces and tabs only).
#[must_use]
pub fn is_blank_line(line: &str) -> bool {
    content(line).bytes().all(|b| b == b' ' || b == b'\t')
}

/// A comment line — `#` in column 0. (An indented `#` is content: a block
/// scalar's line, for one.)
#[must_use]
pub fn is_comment_line(line: &str) -> bool {
    content(line).starts_with('#')
}

/// A LEAD line: blank or comment — the lines that travel with the entry that
/// follows them.
fn is_lead_line(line: &str) -> bool {
    is_blank_line(line) || is_comment_line(line)
}

/// Characters that cannot begin a plain YAML key (flow indicators, anchors,
/// aliases, tags, block scalar indicators, directives, reserved).
const NOT_A_PLAIN_KEY_START: &[char] = &[
    '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`',
];

/// A space, a tab, or the end of the line (`None`).
fn ws_or_end(ch: Option<char>) -> bool {
    matches!(ch, None | Some(' ' | '\t'))
}

/// The reference's plain-key rule is the regex `^(.*?):(?:[ \t]|$)`, whose `.`
/// never matches a line terminator — a key region holding one is no match.
fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The entry boundary: the key of a column-0 line that opens a top-level
/// mapping entry, or `None` when the line does not. A line opens an entry when
/// it is not blank, not a comment, not a sequence item (`-` followed by a
/// space, a tab or the end of the line), not an explicit key or value
/// indicator (`?` / `:` the same way), not a document marker (`---` / `...`
/// followed by whitespace or the end of the line), and reads as `<key>:`
/// followed by a space, a tab or the end of the line — the key either
/// - quoted: a `"…"` string (`\` escapes the next character) or a `'…'` string
///   (`''` is a literal quote), closed on the same line, then optional spaces/
///   tabs, then the colon; the key is the content with `\\` → `\`, `\"` → `"`
///   (double) or `''` → `'` (single) undone and every other escape kept as
///   written; or
/// - plain: the text before the FIRST `:` that is followed by a space, a tab or
///   the end of the line, trailing spaces/tabs trimmed — non-empty, not
///   starting with a flow indicator, an anchor/alias/tag/block-scalar/
///   directive/reserved character (`[ ] { } , & * ! | > % @ \``) and not
///   containing ` #` or `\t#` (a comment would start there).
///
/// Anything else — an indented line, a flow collection's continuation, a block
/// scalar's content — is a continuation of the entry above it.
#[must_use]
pub fn entry_key_of(line: &str) -> Option<String> {
    let c = content(line);
    let mut chars = c.chars();
    let c0 = chars.next()?;
    if c0 == ' ' || c0 == '\t' || c0 == '#' {
        return None;
    }
    if c0 == '"' || c0 == '\'' {
        return quoted_key(c, c0);
    }
    let c1 = chars.next();
    if (c0 == '-' || c0 == '?' || c0 == ':') && ws_or_end(c1) {
        return None;
    }
    if (c.starts_with("---") || c.starts_with("...")) && ws_or_end(c[3..].chars().next()) {
        return None;
    }
    if NOT_A_PLAIN_KEY_START.contains(&c0) {
        return None;
    }
    // The first `:` followed by a space, a tab or the end of the line.
    let mut colon = None;
    for (i, ch) in c.char_indices() {
        if ch == ':' && ws_or_end(c[i + 1..].chars().next()) {
            colon = Some(i);
            break;
        }
    }
    let key = &c[..colon?];
    if key.chars().any(is_js_line_terminator) {
        return None;
    }
    let key = key.trim_end_matches([' ', '\t']);
    if key.is_empty() || key.contains(" #") || key.contains("\t#") {
        return None;
    }
    Some(key.to_owned())
}

/// A quoted key at column 0 (`c` starts with `quote`): the unquoted key when
/// the string closes on the line and a `:` + space/tab/EOL follows it.
fn quoted_key(c: &str, quote: char) -> Option<String> {
    let chars: Vec<char> = c.chars().collect();
    let mut i = 1;
    let mut close = None;
    if quote == '"' {
        while i < chars.len() {
            match chars[i] {
                '\\' => i += 2,
                '"' => {
                    close = Some(i);
                    break;
                }
                _ => i += 1,
            }
        }
    } else {
        while i < chars.len() {
            if chars[i] == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                } else {
                    close = Some(i);
                    break;
                }
            } else {
                i += 1;
            }
        }
    }
    let close = close?;
    // `^[ \t]*:(?:[ \t]|$)` after the closing quote.
    let mut after = chars[close + 1..]
        .iter()
        .copied()
        .skip_while(|ch| *ch == ' ' || *ch == '\t');
    if after.next() != Some(':') || !ws_or_end(after.next()) {
        return None;
    }
    let inner = &chars[1..close];
    let mut key = String::with_capacity(inner.len());
    if quote == '"' {
        // `\\` → `\`, `\"` → `"`; every other escape kept as written.
        let mut j = 0;
        while j < inner.len() {
            if inner[j] == '\\' && matches!(inner.get(j + 1), Some('"' | '\\')) {
                key.push(inner[j + 1]);
                j += 2;
            } else {
                key.push(inner[j]);
                j += 1;
            }
        }
    } else {
        // `''` → `'`.
        let mut j = 0;
        while j < inner.len() {
            if inner[j] == '\'' && inner.get(j + 1) == Some(&'\'') {
                key.push('\'');
                j += 2;
            } else {
                key.push(inner[j]);
                j += 1;
            }
        }
    }
    Some(key)
}

/// The frontmatter block's raw (fences included, no trailing line ending) → its
/// parts, in order. The parts always concatenate back to `raw` byte for byte:
/// every line of the raw lands in exactly one part.
///
/// - part 0 is the opening fence line with its line ending, key `None`;
/// - the last part is the closing fence line (no line ending), key `None`;
/// - between them, the body lines: every line before the first entry line is
///   one part with key `None` (comments, blank lines, or — when no line opens
///   an entry: a bare scalar, a sequence — the whole body); then one part per
///   entry, from the first of the lead lines (blank / column-0 comment)
///   immediately preceding its key line (never reaching back past the
///   previous entry's key line) through the line before the next entry's
///   lead, the last entry ending before the trailing lead run; the trailing
///   lead run (blank / comment lines after the last entry's content) is one
///   part with key `None`.
///
/// A raw with fewer than two lines (not a frontmatter block) is one part.
#[must_use]
pub fn split_frontmatter_raw(raw: &str) -> Vec<FrontmatterPart> {
    let lines = split_lines(raw);
    let part = |key: Option<&str>, lines: &[&str]| FrontmatterPart {
        key: key.map(str::to_owned),
        bytes: lines.concat(),
    };
    if lines.len() < 2 {
        return vec![FrontmatterPart {
            key: None,
            bytes: raw.to_owned(),
        }];
    }
    let open = lines[0];
    let close = lines[lines.len() - 1];
    let body = &lines[1..lines.len() - 1];
    let mut parts = vec![part(None, &[open])];

    let entry_at: Vec<Option<String>> = body.iter().map(|l| entry_key_of(l)).collect();
    let entry_idx: Vec<usize> = entry_at
        .iter()
        .enumerate()
        .filter_map(|(i, k)| k.as_ref().map(|_| i))
        .collect();

    if entry_idx.is_empty() {
        if !body.is_empty() {
            parts.push(part(None, body));
        }
        parts.push(part(None, &[close]));
        return parts;
    }

    // Where each entry's part starts: its lead run, bounded by the previous
    // entry's key line; the first entry starts at its key line (the lines
    // before it are the leading None part).
    let starts: Vec<usize> = entry_idx
        .iter()
        .enumerate()
        .map(|(n, &i)| {
            if n == 0 {
                return i;
            }
            let floor = entry_idx[n - 1] + 1;
            let mut j = i;
            while j > floor && is_lead_line(body[j - 1]) {
                j -= 1;
            }
            j
        })
        .collect();
    // The trailing None part: the lead run after the last entry's key line.
    let mut tail = body.len();
    let last_key = entry_idx[entry_idx.len() - 1];
    while tail - 1 > last_key && is_lead_line(body[tail - 1]) {
        tail -= 1;
    }

    if starts[0] > 0 {
        parts.push(part(None, &body[..starts[0]]));
    }
    for (n, &i) in entry_idx.iter().enumerate() {
        let end = starts.get(n + 1).copied().unwrap_or(tail);
        parts.push(part(entry_at[i].as_deref(), &body[starts[n]..end]));
    }
    if tail < body.len() {
        parts.push(part(None, &body[tail..]));
    }
    parts.push(part(None, &[close]));
    parts
}

/// The inverse of [`split_frontmatter_raw`]: the parts' bytes concatenated.
#[must_use]
pub fn join_frontmatter_parts(parts: &[FrontmatterPart]) -> String {
    parts.iter().map(|p| p.bytes.as_str()).collect()
}

/// The frontmatter block's raw and its trailing trivia, out of a document's
/// `frontmatter_raw` (`raw + docs.frontmatter_trivia`, `spec/mutate` §2): the
/// closing fence is the first line after the opening one that is `---`
/// followed only by spaces/tabs (the format layer's rule); the raw ends with
/// that line's content, the trivia is everything after. `None` when no closing
/// fence is found (not a frontmatter the format layer would have produced).
#[must_use]
pub fn split_frontmatter_trivia(frontmatter_raw: &str) -> Option<FrontmatterSplit> {
    let lines = split_lines(frontmatter_raw);
    for (i, line) in lines.iter().enumerate().skip(1) {
        let c = content(line);
        if let Some(rest) = c.strip_prefix("---")
            && rest.bytes().all(|b| b == b' ' || b == b'\t')
        {
            let mut raw: String = lines[..i].concat();
            raw.push_str(c);
            let trivia = frontmatter_raw[raw.len()..].to_owned();
            return Some(FrontmatterSplit { raw, trivia });
        }
    }
    None
}

/// The lines of a part that LEAD its key line (blank / column-0 comment
/// lines), as one string; `""` for a part without a key.
#[must_use]
pub fn lead_of(part: &FrontmatterPart) -> String {
    if part.key.is_none() {
        return String::new();
    }
    let lines = split_lines(&part.bytes);
    let mut n = 0;
    while n < lines.len() - 1 && is_lead_line(lines[n]) {
        n += 1;
    }
    lines[..n].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    // spec/mutate §11.10 "Frontmatter entries" — the split rule, byte-exact
    // and lexical; the reference's `frontmatter-parts.test.ts` case for case.

    fn keys_of(raw: &str) -> Vec<Option<String>> {
        split_frontmatter_raw(raw)
            .into_iter()
            .map(|p| p.key)
            .collect()
    }

    fn bytes_of(raw: &str) -> Vec<String> {
        split_frontmatter_raw(raw)
            .into_iter()
            .map(|p| p.bytes)
            .collect()
    }

    fn keys(ks: &[Option<&str>]) -> Vec<Option<String>> {
        ks.iter().map(|k| k.map(str::to_owned)).collect()
    }

    #[test]
    fn fences_are_null_key_parts_one_part_per_top_level_entry() {
        let raw = "---\nlayer: draft\ntitle: A\n---";
        assert_eq!(
            bytes_of(raw),
            ["---\n", "layer: draft\n", "title: A\n", "---"]
        );
        assert_eq!(
            keys_of(raw),
            keys(&[None, Some("layer"), Some("title"), None])
        );
    }

    #[test]
    fn concatenates_back_to_the_raw_for_every_shape() {
        for raw in [
            "---\n---",
            "---\r\n---",
            "---\nlayer: draft\n---",
            "---\n# c\n\na: 1\n# d\nb:\n- x\n- y\nc: |\n  l1\n\n  l3\n# end\n\n---",
            "---\n- a\n- b\n---",
            "---\njust text\n---",
            "---\r\na: 1\r\nb:\r\n  - x\r\n---",
            "---\ndup: 1\ndup: 2\n---",
            "---\n\"q\": 1\n'single': 2\n---",
        ] {
            assert_eq!(join_frontmatter_parts(&split_frontmatter_raw(raw)), raw);
        }
    }

    #[test]
    fn leading_null_part_comment_leads_the_following_key_trailing_lead_lines_are_one_null_part() {
        let raw = "---\n# doc\n\na: 1\n# about b\nb: 2\n# end\n\n---";
        assert_eq!(
            bytes_of(raw),
            [
                "---\n",
                "# doc\n\n",
                "a: 1\n",
                "# about b\nb: 2\n",
                "# end\n\n",
                "---"
            ]
        );
        assert_eq!(
            keys_of(raw),
            keys(&[None, None, Some("a"), Some("b"), None, None])
        );
    }

    #[test]
    fn continuation_lines_belong_to_the_entry_above() {
        let raw = "---\ntags:\n- a\n- b\ndesc: |\n  one\n\n  three\n  # not a comment\nnested:\n  x: 1\n---";
        assert_eq!(
            bytes_of(raw),
            [
                "---\n",
                "tags:\n- a\n- b\n",
                "desc: |\n  one\n\n  three\n  # not a comment\n",
                "nested:\n  x: 1\n",
                "---"
            ]
        );
    }

    #[test]
    fn a_body_with_no_entry_line_is_one_null_part() {
        assert_eq!(
            bytes_of("---\n- a\n- b\n---"),
            ["---\n", "- a\n- b\n", "---"]
        );
        assert_eq!(keys_of("---\nscalar\n---"), keys(&[None, None, None]));
        assert_eq!(bytes_of("---\n# only\n---"), ["---\n", "# only\n", "---"]);
        assert_eq!(bytes_of("---\n---"), ["---\n", "---"]);
    }

    #[test]
    fn keeps_crlf_endings_per_part() {
        assert_eq!(
            bytes_of("---\r\na: 1\r\nb: 2\r\n---"),
            ["---\r\n", "a: 1\r\n", "b: 2\r\n", "---"]
        );
    }

    #[test]
    fn spells_quoted_keys_unquoted_duplicates_are_separate_parts_with_the_same_key() {
        let parts = split_frontmatter_raw(
            "---\n\"quoted key\": 1\n'it''s': 2\n\"a\\\"b\": 3\ndup: 1\ndup: 2\n---",
        );
        assert_eq!(
            parts.into_iter().map(|p| p.key).collect::<Vec<_>>(),
            keys(&[
                None,
                Some("quoted key"),
                Some("it's"),
                Some("a\"b"),
                Some("dup"),
                Some("dup"),
                None
            ])
        );
    }

    #[test]
    fn an_empty_or_null_value_is_still_an_entry() {
        assert_eq!(
            keys_of("---\nempty:\nnothing: null\n---"),
            keys(&[None, Some("empty"), Some("nothing"), None])
        );
    }

    #[test]
    fn entry_key_of_accepts_plain_and_quoted_keys_and_refuses_what_cannot_open_an_entry() {
        assert_eq!(entry_key_of("a: 1\n").as_deref(), Some("a"));
        assert_eq!(entry_key_of("a:b: 1").as_deref(), Some("a:b"));
        assert_eq!(entry_key_of("a:\n").as_deref(), Some("a"));
        assert_eq!(entry_key_of("a:\t1").as_deref(), Some("a"));
        assert_eq!(entry_key_of("-x: 1").as_deref(), Some("-x"));
        assert_eq!(entry_key_of("---x: 2").as_deref(), Some("---x"));
        assert_eq!(
            entry_key_of("key with spaces : 1").as_deref(),
            Some("key with spaces")
        );
        assert_eq!(entry_key_of("\"q\": 1").as_deref(), Some("q"));
        assert_eq!(entry_key_of("'s' : 1").as_deref(), Some("s"));
        for line in [
            "",
            "  a: 1",
            "# a: 1",
            "- a: 1",
            "-",
            "? a",
            ": a",
            "--- ",
            "...",
            "[a]: 1",
            "{a: 1}",
            "&x a: 1",
            "*x",
            "!tag a: 1",
            "|",
            "a #b: 1",
            "a:1",
            "a",
            "\"unclosed: 1",
            "\"q\" 1",
            "%YAML 1.2",
        ] {
            assert_eq!(entry_key_of(line), None, "{line:?}");
        }
    }

    #[test]
    fn non_ascii_keys_and_escapes_follow_the_reference() {
        assert_eq!(entry_key_of("clé: 1").as_deref(), Some("clé"));
        assert_eq!(entry_key_of("\"\\é\": 1").as_deref(), Some("\\é"));
        assert_eq!(entry_key_of("\"a\\\\\": 1").as_deref(), Some("a\\"));
        // A line terminator inside the key region is no match for the
        // reference's `^(.*?):` (JavaScript `.` skips `\r` and U+2028).
        assert_eq!(entry_key_of("a\rb: 1"), None);
        assert_eq!(entry_key_of("a\u{2028}b: 1"), None);
    }

    #[test]
    fn cuts_a_document_head_at_the_closing_fence() {
        assert_eq!(
            split_frontmatter_trivia("---\na: 1\n---\n\n"),
            Some(FrontmatterSplit {
                raw: "---\na: 1\n---".into(),
                trivia: "\n\n".into()
            })
        );
        assert_eq!(
            split_frontmatter_trivia("---\r\na: 1\r\n--- \r\n"),
            Some(FrontmatterSplit {
                raw: "---\r\na: 1\r\n--- ".into(),
                trivia: "\r\n".into()
            })
        );
        assert_eq!(split_frontmatter_trivia("---\na: 1\n"), None);
    }

    #[test]
    fn lead_of_is_the_comment_blank_run_before_the_key_line() {
        let parts = split_frontmatter_raw("---\na: 1\n\n# about b\nb: 2\n---");
        assert_eq!(lead_of(&parts[2]), "\n# about b\n");
        assert_eq!(lead_of(&parts[1]), "");
        assert_eq!(lead_of(&parts[0]), "");
    }

    #[test]
    fn split_lines_keeps_endings() {
        assert_eq!(split_lines("a\nb\r\nc"), ["a\n", "b\r\n", "c"]);
        assert_eq!(split_lines(""), [""]);
        assert_eq!(split_lines("a\n"), ["a\n", ""]);
        assert_eq!(line_ending_of("a\r\n"), "\r\n");
        assert_eq!(line_ending_of("a\n"), "\n");
        assert_eq!(line_ending_of("a"), "");
        assert!(is_blank_line(" \t\n") && is_blank_line(""));
        assert!(is_comment_line("# x\r\n") && !is_comment_line("  # x"));
    }
}
