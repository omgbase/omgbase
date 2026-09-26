//! The FTS5 query sanitizer (`spec/search` §1.2): a search box, not the FTS5
//! query language.

use std::sync::OnceLock;

use regex::Regex;

/// JavaScript's `\s` set: `\t \n \v \f \r`, space, U+00A0, U+1680,
/// U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. Differs
/// from Rust's `char::is_whitespace` in two places: U+0085 (NEL) is *not*
/// JavaScript whitespace, U+FEFF (BOM) is.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.split(/\s+/).filter(Boolean)`: the non-empty runs between
/// JavaScript whitespace.
pub fn split_ws(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_js_whitespace).filter(|w| !w.is_empty())
}

/// Whether `s` has a letter or a digit (Unicode general categories `L`/`N`;
/// the reference's `/[\p{L}\p{N}]/u`).
#[must_use]
pub fn has_word_char(s: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]").expect("valid regex"))
        .is_match(s)
}

/// One raw token as a quoted FTS5 string, inner quotes doubled.
fn quote_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', "\"\""))
}

/// §1.2: compile user input to a grammar-free MATCH expression. Whitespace
/// splits tokens; a double-quoted run is one phrase (an unclosed quote runs to
/// the end; quotes never nest); a bareword ending in `*` is a prefix token;
/// tokens without a letter or digit are dropped; each survivor is `"…"` with
/// inner `"` doubled, a prefix token `"…"*`, joined by single spaces. `""`
/// when nothing survives — the caller skips the MATCH.
#[must_use]
pub fn sanitize_fts_query(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if is_js_whitespace(c) {
            i += 1;
            continue;
        }
        if c == '"' {
            i += 1;
            let start = i;
            while i < n && chars[i] != '"' {
                i += 1;
            }
            let phrase: String = chars[start..i].iter().collect();
            if i < n {
                i += 1; // the closing quote
            }
            if has_word_char(&phrase) {
                out.push(quote_token(&phrase));
            }
            continue;
        }
        let start = i;
        while i < n && !is_js_whitespace(chars[i]) && chars[i] != '"' {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        let (core, prefix) = match word.strip_suffix('*') {
            Some(core) => (core.to_owned(), true),
            None => (word, false),
        };
        if has_word_char(&core) {
            let mut t = quote_token(&core);
            if prefix {
                t.push('*');
            }
            out.push(t);
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readme_table() {
        assert_eq!(
            sanitize_fts_query("guides/onboarding"),
            "\"guides/onboarding\""
        );
        assert_eq!(
            sanitize_fts_query("\"exact phrase\" other*"),
            "\"exact phrase\" \"other\"*"
        );
        assert_eq!(sanitize_fts_query("---"), "");
        assert_eq!(sanitize_fts_query(""), "");
        assert_eq!(sanitize_fts_query("   \t\n"), "");
    }

    #[test]
    fn phrases_and_quotes() {
        // An unclosed quote runs to the end.
        assert_eq!(sanitize_fts_query("\"open phrase"), "\"open phrase\"");
        // Quotes never nest; a quote ends a bareword.
        assert_eq!(
            sanitize_fts_query("ab\"cd ef\"gh"),
            "\"ab\" \"cd ef\" \"gh\""
        );
        // An empty or symbol-only phrase is dropped.
        assert_eq!(sanitize_fts_query("\"\" \"--\" x"), "\"x\"");
        // A phrase keeps its inner whitespace and the `*` inside it verbatim.
        assert_eq!(sanitize_fts_query("\"a  b*\""), "\"a  b*\"");
    }

    #[test]
    fn prefix_and_word_chars() {
        assert_eq!(sanitize_fts_query("foo*"), "\"foo\"*");
        // A lone `*` or `**` has no word char once the trailing `*` is stripped.
        assert_eq!(sanitize_fts_query("* ** ***"), "");
        // Only one trailing `*` is stripped; the rest stays inside the quotes.
        assert_eq!(sanitize_fts_query("foo**"), "\"foo*\"*");
        // Unicode letters and digits count; punctuation alone does not.
        assert_eq!(sanitize_fts_query("héllo ９ ¿?"), "\"héllo\" \"９\"");
        assert_eq!(
            sanitize_fts_query("AND OR NOT:x (y)"),
            "\"AND\" \"OR\" \"NOT:x\" \"(y)\""
        );
    }

    #[test]
    fn js_whitespace_set() {
        assert!(is_js_whitespace('\u{FEFF}'));
        assert!(is_js_whitespace('\u{00A0}'));
        assert!(is_js_whitespace('\u{3000}'));
        assert!(!is_js_whitespace('\u{0085}'));
        assert!(!is_js_whitespace('\u{200B}'));
        assert_eq!(
            sanitize_fts_query("a\u{00A0}b\u{FEFF}c"),
            "\"a\" \"b\" \"c\""
        );
        assert_eq!(sanitize_fts_query("a\u{0085}b"), "\"a\u{0085}b\"");
        assert_eq!(
            split_ws("  a  b\u{3000}c ").collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
    }
}
