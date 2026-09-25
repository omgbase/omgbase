//! OQX structural lexer for the generic kernel (a port of
//! `packages/oqx/src/lexer.ts`).
//!
//! This lexer fully tokenizes: the parser builds an evaluable expression AST
//! directly from the token stream, so there is no source-slicing seam.
//!
//! Tagged-template bindings are lexed as first-class tokens. Each template string
//! FRAGMENT is lexed independently and a synthetic `binding` token is injected
//! between adjacent fragments. A binding therefore can never span a token or
//! alter the grammar — the prepared-statement / injection-safe property the
//! host-bindings design note calls for. (A consequence: `${x}` inside a string
//! literal does not interpolate — that fragment would be an unterminated string —
//! which is exactly the desired "interpolation is a value, never source text".)
//!
//! Positions (`Token::pos`, and the offsets quoted in error messages) count
//! Unicode scalar values (`char`s), where the TS counts UTF-16 code units. They
//! agree for everything outside the astral planes; the conformance fixtures
//! assert on stable message fragments, never on offsets.

use crate::errors::{OqxError, Result};

/// Token kinds. `Str` is the TS `"string"`; the rest keep the TS names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TokType {
    Ident,
    /// `from` | `where` | `select`
    Kw,
    Str,
    Number,
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Colon,
    /// `^` — one-scope lift marker
    Caret,
    Dot,
    /// `..` (inclusive) or `...` (exclusive end) — a Ruby-style range operator
    /// (the token's value carries which).
    Range,
    /// `== != <= >= < > && || ! + - * / %` (the token's value carries the operator).
    Op,
    /// A `${…}` interpolation; `index` names the value slot.
    Binding,
    Eof,
}

impl TokType {
    /// The TS spelling of the kind (`"ident"`, `"kw"`, `"string"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            TokType::Ident => "ident",
            TokType::Kw => "kw",
            TokType::Str => "string",
            TokType::Number => "number",
            TokType::LParen => "lparen",
            TokType::RParen => "rparen",
            TokType::LBrace => "lbrace",
            TokType::RBrace => "rbrace",
            TokType::Comma => "comma",
            TokType::Colon => "colon",
            TokType::Caret => "caret",
            TokType::Dot => "dot",
            TokType::Range => "range",
            TokType::Op => "op",
            TokType::Binding => "binding",
            TokType::Eof => "eof",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    /// The TS `type` (a Rust keyword, hence `kind`).
    pub kind: TokType,
    /// The source text of the token, except: a `Str` token carries its decoded
    /// value (quotes stripped, escapes resolved); a `Binding` carries the
    /// display marker `${N}`; `Eof` carries `""`.
    pub value: String,
    pub pos: usize,
    /// Binding tokens only.
    pub index: Option<usize>,
}

const KEYWORDS: [&str; 3] = ["from", "where", "select"];

// Multi-char operators, longest first (the scanner tries these before singles).
const MULTI_OPS: [&str; 6] = ["==", "!=", "<=", ">=", "&&", "||"];
const SINGLE_OPS: [char; 8] = ['<', '>', '!', '+', '-', '*', '/', '%'];

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '$'
}
fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}
fn is_digit(c: char) -> bool {
    c.is_ascii_digit()
}

/// Lex a tagged-template call: the cooked string fragments and the count of
/// interpolated values. Emits a single flat token stream with `binding` tokens
/// (index 0..values-1) between fragments, terminated by `eof`.
pub fn lex_template<S: AsRef<str>>(fragments: &[S], values: usize) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut base = 0; // running offset across fragments + rendered `${…}` markers
    let last = fragments.len().checked_sub(1);
    for (f, fragment) in fragments.iter().enumerate() {
        let fragment = fragment.as_ref();
        lex_fragment(fragment, base, &mut tokens)?;
        base += fragment.chars().count();
        if Some(f) != last {
            // account for the value's rendered width in the display source (see raw_source)
            let marker = format!("${{{f}}}");
            let width = marker.len();
            tokens.push(Token {
                kind: TokType::Binding,
                value: marker,
                pos: base,
                index: Some(f),
            });
            base += width;
        }
    }
    if last != Some(values) {
        return Err(OqxError::lex(format!(
            "template arity mismatch: {} fragments, {} values",
            fragments.len(),
            values
        )));
    }
    tokens.push(Token {
        kind: TokType::Eof,
        value: String::new(),
        pos: base,
        index: None,
    });
    Ok(tokens)
}

/// Lex a plain string (no bindings) — used by the string entry point.
pub fn lex_string(src: &str) -> Result<Vec<Token>> {
    let mut tokens = Vec::new();
    lex_fragment(src, 0, &mut tokens)?;
    tokens.push(Token {
        kind: TokType::Eof,
        value: String::new(),
        pos: src.chars().count(),
        index: None,
    });
    Ok(tokens)
}

fn lex_fragment(src: &str, base: usize, out: &mut Vec<Token>) -> Result<()> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let at = |i: usize| chars.get(i).copied();
    let digit_at = |i: usize| at(i).is_some_and(is_digit);
    let mut push = |kind: TokType, value: String, at: usize| {
        out.push(Token {
            kind,
            value,
            pos: base + at,
            index: None,
        });
    };

    while i < n {
        let c = chars[i];

        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            i += 1;
            continue;
        }

        let single = match c {
            '(' => Some(TokType::LParen),
            ')' => Some(TokType::RParen),
            '{' => Some(TokType::LBrace),
            '}' => Some(TokType::RBrace),
            ',' => Some(TokType::Comma),
            ':' => Some(TokType::Colon),
            '^' => Some(TokType::Caret),
            _ => None,
        };
        if let Some(kind) = single {
            push(kind, c.to_string(), i);
            i += 1;
            continue;
        }

        // range operator — `...` (exclusive end) or `..` (inclusive), longest first.
        // Scanned before the dot rule so `a..b` never looks like member navigation,
        // and before the number rule so the bounds lex as separate numbers.
        if c == '.' && at(i + 1) == Some('.') {
            if at(i + 2) == Some('.') {
                push(TokType::Range, "...".to_string(), i);
                i += 3;
                continue;
            }
            push(TokType::Range, "..".to_string(), i);
            i += 2;
            continue;
        }

        // `.` followed by a digit is neither navigation (a property name cannot start
        // with a digit) nor a number (OQX has no leading-dot numerals): it is a
        // malformed number, reported as such rather than surfacing as a confusing
        // parse error downstream. Any other `.` is member navigation.
        if c == '.' {
            if digit_at(i + 1) {
                let end = scan_number_tail(&chars, i + 1, base)?;
                let lit: String = chars[i..end].iter().collect();
                return Err(OqxError::lex(format!(
                    "malformed number \"{lit}\" at {} — a number starts with a digit (write 0{lit}), and a property name cannot be a digit (there is no index access)",
                    base + i
                )));
            }
            push(TokType::Dot, c.to_string(), i);
            i += 1;
            continue;
        }

        // string literal — decode into its VALUE (quotes stripped, escapes resolved).
        if c == '"' || c == '\'' {
            let quote = c;
            let start = i;
            i += 1;
            let mut sval = String::new();
            while i < n && chars[i] != quote {
                if chars[i] == '\\' {
                    i += 1;
                    if let Some(e) = at(i) {
                        sval.push(unescape(e));
                    }
                } else {
                    sval.push(chars[i]);
                }
                i += 1;
            }
            if i >= n {
                return Err(OqxError::lex(format!(
                    "unterminated string literal at {}",
                    base + start
                )));
            }
            i += 1; // closing quote
            push(TokType::Str, sval, start);
            continue;
        }

        // number: `digits [ "." digits ] [ ("e"|"E") ["+"|"-"] digits ]`. A `.` is a
        // decimal point only when a digit follows: `1..5` is `1` `..` `5`. A `.`
        // followed by anything else (`1.`, `1.x`) and an exponent marker without
        // digits (`1e`, `1e+`) are malformed numbers — lex errors, never a silent
        // NaN or a dangling dot.
        if is_digit(c) {
            let start = i;
            i = scan_number_tail(&chars, i, base)?;
            push(TokType::Number, chars[start..i].iter().collect(), start);
            continue;
        }

        // operators (multi-char first)
        if let Some(&d) = chars.get(i + 1) {
            let two: String = [c, d].iter().collect();
            if MULTI_OPS.contains(&two.as_str()) {
                push(TokType::Op, two, i);
                i += 2;
                continue;
            }
        }
        if SINGLE_OPS.contains(&c) {
            push(TokType::Op, c.to_string(), i);
            i += 1;
            continue;
        }

        // identifier / keyword
        if is_ident_start(c) {
            let start = i;
            i += 1;
            while i < n && is_ident_part(chars[i]) {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let kind = if KEYWORDS.contains(&word.as_str()) {
                TokType::Kw
            } else {
                TokType::Ident
            };
            push(kind, word, start);
            continue;
        }

        return Err(OqxError::lex(format!(
            "unexpected character {} at {}",
            json_quote_char(c),
            base + i
        )));
    }
    Ok(())
}

/// Scan a number whose first digit is at `i`; return the index just past it.
/// Fails with the malformed-number lex error for a trailing decimal point or an
/// exponent without digits.
fn scan_number_tail(chars: &[char], mut i: usize, base: usize) -> Result<usize> {
    let start = i;
    let n = chars.len();
    let at = |i: usize| chars.get(i).copied();
    let digit_at = |i: usize| at(i).is_some_and(is_digit);
    let fail = |end: usize, why: &str| -> Result<usize> {
        let lit: String = chars[start..end].iter().collect();
        Err(OqxError::lex(format!(
            "malformed number \"{lit}\" at {} — {why}",
            base + start
        )))
    };
    while i < n && is_digit(chars[i]) {
        i += 1;
    }
    if at(i) == Some('.') && at(i + 1) != Some('.') {
        if !digit_at(i + 1) {
            return fail(
                i + 1,
                "a decimal point needs a digit after it (write 1.0, not 1.)",
            );
        }
        i += 1;
        while i < n && is_digit(chars[i]) {
            i += 1;
        }
    }
    if matches!(at(i), Some('e' | 'E')) {
        let mut j = i + 1;
        if matches!(at(j), Some('+' | '-')) {
            j += 1;
        }
        if !digit_at(j) {
            return fail(j, "an exponent needs at least one digit (write 1e5)");
        }
        i = j;
        while i < n && is_digit(chars[i]) {
            i += 1;
        }
    }
    Ok(i)
}

fn unescape(c: char) -> char {
    match c {
        'n' => '\n',
        't' => '\t',
        'r' => '\r',
        '0' => '\0',
        other => other, // \\, \", \', \/, and anything else → the literal char
    }
}

/// `JSON.stringify(c)` for a single character, as the TS error message renders it.
fn json_quote_char(c: char) -> String {
    match c {
        '"' => "\"\\\"\"".to_string(),
        '\\' => "\"\\\\\"".to_string(),
        '\u{08}' => "\"\\b\"".to_string(),
        '\u{0c}' => "\"\\f\"".to_string(),
        '\n' => "\"\\n\"".to_string(),
        '\r' => "\"\\r\"".to_string(),
        '\t' => "\"\\t\"".to_string(),
        c if (c as u32) < 0x20 => format!("\"\\u{:04x}\"", c as u32),
        c => format!("\"{c}\""),
    }
}

/// A human-readable reconstruction of the query source, with `${N}` markers where
/// bindings were, for error messages.
pub fn raw_source<S: AsRef<str>>(fragments: &[S]) -> String {
    let mut out = String::new();
    for (i, s) in fragments.iter().enumerate() {
        out.push_str(s.as_ref());
        if i + 1 < fragments.len() {
            out.push_str(&format!("${{{i}}}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::Stage;

    fn kinds(src: &str) -> Vec<(TokType, String)> {
        lex_string(src)
            .unwrap()
            .into_iter()
            .map(|t| (t.kind, t.value))
            .collect()
    }

    fn tok(kind: TokType, value: &str) -> (TokType, String) {
        (kind, value.to_string())
    }

    fn lex_err(src: &str) -> OqxError {
        lex_string(src).unwrap_err()
    }

    #[test]
    fn keywords_idents_and_punctuation() {
        use TokType::*;
        assert_eq!(
            kinds("select name, id from people where age >= 18 && x.y != \"s\" || !z"),
            vec![
                tok(Kw, "select"),
                tok(Ident, "name"),
                tok(Comma, ","),
                tok(Ident, "id"),
                tok(Kw, "from"),
                tok(Ident, "people"),
                tok(Kw, "where"),
                tok(Ident, "age"),
                tok(Op, ">="),
                tok(Number, "18"),
                tok(Op, "&&"),
                tok(Ident, "x"),
                tok(Dot, "."),
                tok(Ident, "y"),
                tok(Op, "!="),
                tok(Str, "s"),
                tok(Op, "||"),
                tok(Op, "!"),
                tok(Ident, "z"),
                tok(Eof, ""),
            ]
        );
        // Contextual words are plain idents; only from/where/select are keywords.
        assert_eq!(
            kinds("order by asc desc follow distinct count limit offset values in"),
            [
                "order", "by", "asc", "desc", "follow", "distinct", "count", "limit", "offset",
                "values", "in"
            ]
            .iter()
            .map(|w| tok(Ident, w))
            .chain(std::iter::once(tok(Eof, "")))
            .collect::<Vec<_>>()
        );
        assert_eq!(
            kinds("( ) { } : ^ ^^"),
            vec![
                tok(LParen, "("),
                tok(RParen, ")"),
                tok(LBrace, "{"),
                tok(RBrace, "}"),
                tok(Colon, ":"),
                tok(Caret, "^"),
                tok(Caret, "^"),
                tok(Caret, "^"),
                tok(Eof, ""),
            ]
        );
    }

    #[test]
    fn dollar_identifiers() {
        use TokType::*;
        assert_eq!(
            kinds("$value $key $depth _x1 a$b"),
            vec![
                tok(Ident, "$value"),
                tok(Ident, "$key"),
                tok(Ident, "$depth"),
                tok(Ident, "_x1"),
                tok(Ident, "a$b"),
                tok(Eof, ""),
            ]
        );
    }

    #[test]
    fn all_operators() {
        use TokType::*;
        assert_eq!(
            kinds("== != <= >= < > && || ! + - * / %"),
            [
                "==", "!=", "<=", ">=", "<", ">", "&&", "||", "!", "+", "-", "*", "/", "%"
            ]
            .iter()
            .map(|o| tok(Op, o))
            .chain(std::iter::once(tok(Eof, "")))
            .collect::<Vec<_>>()
        );
        // `-1` is an operator then a number: the lexer has no signed numerals.
        assert_eq!(
            kinds("-1"),
            vec![tok(Op, "-"), tok(Number, "1"), tok(Eof, "")]
        );
    }

    #[test]
    fn range_operators_and_dots() {
        use TokType::*;
        assert_eq!(
            kinds("1..5"),
            vec![
                tok(Number, "1"),
                tok(Range, ".."),
                tok(Number, "5"),
                tok(Eof, "")
            ]
        );
        assert_eq!(
            kinds("1...5"),
            vec![
                tok(Number, "1"),
                tok(Range, "..."),
                tok(Number, "5"),
                tok(Eof, "")
            ]
        );
        assert_eq!(
            kinds("..5"),
            vec![tok(Range, ".."), tok(Number, "5"), tok(Eof, "")]
        );
        assert_eq!(
            kinds("5.."),
            vec![tok(Number, "5"), tok(Range, ".."), tok(Eof, "")]
        );
        assert_eq!(
            kinds("a..b"),
            vec![
                tok(Ident, "a"),
                tok(Range, ".."),
                tok(Ident, "b"),
                tok(Eof, "")
            ]
        );
        assert_eq!(
            kinds("a.b.c"),
            vec![
                tok(Ident, "a"),
                tok(Dot, "."),
                tok(Ident, "b"),
                tok(Dot, "."),
                tok(Ident, "c"),
                tok(Eof, ""),
            ]
        );
        // A decimal low bound before an open high end: `1.5` then `..`.
        assert_eq!(
            kinds("1.5.."),
            vec![tok(Number, "1.5"), tok(Range, ".."), tok(Eof, "")]
        );
        assert_eq!(
            kinds("1.5..2.5"),
            vec![
                tok(Number, "1.5"),
                tok(Range, ".."),
                tok(Number, "2.5"),
                tok(Eof, "")
            ]
        );
    }

    #[test]
    fn numbers() {
        use TokType::*;
        assert_eq!(kinds("42"), vec![tok(Number, "42"), tok(Eof, "")]);
        assert_eq!(kinds("1.5"), vec![tok(Number, "1.5"), tok(Eof, "")]);
        assert_eq!(kinds("1e3"), vec![tok(Number, "1e3"), tok(Eof, "")]);
        assert_eq!(kinds("1.5E-3"), vec![tok(Number, "1.5E-3"), tok(Eof, "")]);
        assert_eq!(kinds("2e+10"), vec![tok(Number, "2e+10"), tok(Eof, "")]);
        assert_eq!(kinds("1E-2"), vec![tok(Number, "1E-2"), tok(Eof, "")]);
    }

    #[test]
    fn malformed_numbers_are_lex_errors() {
        let malformed = |src: &str| {
            let e = lex_err(src);
            assert_eq!(e.stage, Stage::Lex, "{src:?}: {}", e.message);
            assert!(
                e.message.starts_with("malformed number"),
                "{src:?}: {}",
                e.message
            );
            e.message
        };
        // A trailing decimal point, at the end and before a name.
        assert_eq!(
            malformed("x: 1."),
            "malformed number \"1.\" at 3 — a decimal point needs a digit after it (write 1.0, not 1.)"
        );
        assert!(malformed("1.x").starts_with("malformed number \"1.\" at 0"));
        assert!(malformed("1.foo").starts_with("malformed number \"1.\" at 0"));
        // An exponent marker with no digits, with or without a sign, either case.
        assert_eq!(
            malformed("1e"),
            "malformed number \"1e\" at 0 — an exponent needs at least one digit (write 1e5)"
        );
        assert!(malformed("1e+ ").starts_with("malformed number \"1e+\" at 0"));
        assert!(malformed("1e- ").starts_with("malformed number \"1e-\" at 0"));
        assert!(malformed("a > 2E").starts_with("malformed number \"2E\" at 4"));
        assert!(malformed("1.5e").starts_with("malformed number \"1.5e\" at 0"));
        // A leading-dot numeral, and a digit after a navigation dot.
        assert_eq!(
            malformed(".5"),
            "malformed number \".5\" at 0 — a number starts with a digit (write 0.5), and a property name cannot be a digit (there is no index access)"
        );
        assert!(malformed("xs.0").starts_with("malformed number \".0\" at 2"));
        assert!(malformed("xs.12e3").starts_with("malformed number \".12e3\" at 2"));
        // The tail scan reports its own malformation first (as in the TS).
        assert!(malformed("xs.1.").starts_with("malformed number \"1.\" at 3"));
        // Inside a template fragment the offset is the running display offset.
        let e = lex_template(&["from ", " where a > 1e"], 1).unwrap_err();
        assert_eq!(e.stage, Stage::Lex);
        assert!(e.message.contains("\"1e\" at 20"), "{}", e.message);
    }

    #[test]
    fn strings_and_escapes() {
        use TokType::*;
        assert_eq!(kinds("\"NYC\""), vec![tok(Str, "NYC"), tok(Eof, "")]);
        assert_eq!(kinds("'NYC'"), vec![tok(Str, "NYC"), tok(Eof, "")]);
        assert_eq!(kinds("\"it's\""), vec![tok(Str, "it's"), tok(Eof, "")]);
        assert_eq!(
            kinds("'say \"hi\"'"),
            vec![tok(Str, "say \"hi\""), tok(Eof, "")]
        );
        assert_eq!(
            kinds(r#""a\nb\tc\rd\0e\"f\\g\'h\xi\/j""#),
            vec![tok(Str, "a\nb\tc\rd\0e\"f\\g'hxi/j"), tok(Eof, "")]
        );
        // Interpolation markers inside a string are just text.
        assert_eq!(kinds("\"${x}\""), vec![tok(Str, "${x}"), tok(Eof, "")]);
        // Non-ASCII content is fine inside a string; positions count chars.
        let toks = lex_string("\"héllo\" x").unwrap();
        assert_eq!(toks[0].value, "héllo");
        assert_eq!(toks[1].pos, 8);
    }

    #[test]
    fn unterminated_strings() {
        let e = lex_err("where name == \"Bob");
        assert_eq!(e.stage, Stage::Lex);
        assert_eq!(e.message, "unterminated string literal at 14");
        // A trailing backslash swallows the (absent) next char and runs off the end.
        let e = lex_err("'abc\\");
        assert_eq!(e.stage, Stage::Lex);
        assert!(
            e.message.starts_with("unterminated string literal at 0"),
            "{}",
            e.message
        );
        // The quote escaped by a backslash does not close the literal.
        let e = lex_err("\"a\\\"");
        assert_eq!(e.stage, Stage::Lex);
        assert!(e.message.contains("unterminated string literal"));
    }

    #[test]
    fn unexpected_characters() {
        let e = lex_err("a @ b");
        assert_eq!(e.stage, Stage::Lex);
        assert_eq!(e.message, "unexpected character \"@\" at 2");
        assert_eq!(lex_err("a = b").message, "unexpected character \"=\" at 2");
        assert_eq!(lex_err("a & b").message, "unexpected character \"&\" at 2");
        assert_eq!(lex_err("a | b").message, "unexpected character \"|\" at 2");
        assert_eq!(lex_err("x[0]").message, "unexpected character \"[\" at 1");
        assert_eq!(lex_err("a # b").message, "unexpected character \"#\" at 2");
        // Only space/tab/newline/CR are whitespace; other blanks are errors (as in the TS).
        assert_eq!(
            lex_err("a\u{a0}b").message,
            "unexpected character \"\u{a0}\" at 1"
        );
        // Control characters render as JSON escapes.
        assert_eq!(
            lex_err("a\u{1}b").message,
            "unexpected character \"\\u0001\" at 1"
        );
        assert_eq!(
            lex_err("\u{8}").message,
            "unexpected character \"\\b\" at 0"
        );
        // Non-ASCII letters are not identifier characters.
        assert_eq!(lex_err("café").message, "unexpected character \"é\" at 3");
    }

    #[test]
    fn positions_are_char_offsets() {
        let toks = lex_string("name  from\n  people").unwrap();
        let pos: Vec<usize> = toks.iter().map(|t| t.pos).collect();
        assert_eq!(pos, vec![0, 6, 13, 19]);
        assert_eq!(toks.last().unwrap().kind, TokType::Eof);
    }

    #[test]
    fn template_bindings_between_fragments() {
        use TokType::*;
        let toks = lex_template(&["name from ", " where age >= ", ""], 2).unwrap();
        let summary: Vec<(TokType, String, usize, Option<usize>)> = toks
            .iter()
            .map(|t| (t.kind, t.value.clone(), t.pos, t.index))
            .collect();
        assert_eq!(
            summary,
            vec![
                (Ident, "name".to_string(), 0, None),
                (Kw, "from".to_string(), 5, None),
                (Binding, "${0}".to_string(), 10, Some(0)),
                (Kw, "where".to_string(), 15, None),
                (Ident, "age".to_string(), 21, None),
                (Op, ">=".to_string(), 25, None),
                (Binding, "${1}".to_string(), 28, Some(1)),
                (Eof, String::new(), 32, None),
            ]
        );
        // A single fragment and no values is the string form.
        assert_eq!(
            lex_template(&["from xs"], 0).unwrap(),
            lex_string("from xs").unwrap()
        );
        // Adjacent bindings (`${a}${b}`) are two tokens with nothing between.
        let toks = lex_template(&["", "", ""], 2).unwrap();
        assert_eq!(
            toks.iter().map(|t| t.kind).collect::<Vec<_>>(),
            vec![Binding, Binding, Eof]
        );
        // Owned fragments work too.
        let owned = vec!["from ".to_string(), String::new()];
        assert_eq!(lex_template(&owned, 1).unwrap().len(), 3);
    }

    #[test]
    fn template_arity_mismatch() {
        let e = lex_template(&["from ", ""], 2).unwrap_err();
        assert_eq!(e.stage, Stage::Lex);
        assert_eq!(e.message, "template arity mismatch: 2 fragments, 2 values");
        let e = lex_template(&["from ", ""], 0).unwrap_err();
        assert_eq!(e.message, "template arity mismatch: 2 fragments, 0 values");
        let e = lex_template::<&str>(&[], 0).unwrap_err();
        assert_eq!(e.message, "template arity mismatch: 0 fragments, 0 values");
        // A lex error inside a fragment wins over the arity check (the TS lexes first).
        let e = lex_template(&["where x == \"", ""], 5).unwrap_err();
        assert!(
            e.message.starts_with("unterminated string literal"),
            "{}",
            e.message
        );
    }

    #[test]
    fn a_binding_inside_a_string_literal_does_not_interpolate() {
        // `where name == "${x}"`: the first fragment ends inside an open string.
        let e = lex_template(&["where name == \"", "\""], 1).unwrap_err();
        assert_eq!(e.stage, Stage::Lex);
        assert!(e.message.contains("unterminated string literal"));
    }

    #[test]
    fn raw_source_renders_markers() {
        assert_eq!(
            raw_source(&["name from ", " where a == ", ""]),
            "name from ${0} where a == ${1}"
        );
        assert_eq!(raw_source(&["from xs"]), "from xs");
        assert_eq!(raw_source::<&str>(&[]), "");
    }
}
