//! The OQX regular-expression baseline (`spec/oqx/SEMANTICS.md` §11).
//!
//! `matches(pattern, flags)` does not hand the pattern to the `regex` crate as
//! written. The pattern is first PARSED against the OQX baseline grammar — the
//! constructs every implementation supports with the same meaning — and then
//! REWRITTEN into the crate's syntax with the spec's semantics pinned: `\d` is
//! `[0-9]`, `\w` is `[A-Za-z0-9_]`, `\s` is one fixed set, `\b`/`\B` are
//! boundaries over that ASCII `\w`, `.` excludes exactly `\n`, `m` anchors turn
//! only at `\n`. Anything outside the baseline is rejected with a message that
//! names the construct, so a query that runs here runs identically in the
//! reference implementation (`packages/oqx/src/regex.ts` — the same parser,
//! emitting JavaScript `u`-mode syntax). The two parsers are kept
//! line-for-line parallel; the error messages are shared verbatim so the spec
//! fixtures can assert on them.
//!
//! The rewrite table (baseline → `regex` crate):
//!
//! | baseline | crate |
//! | --- | --- |
//! | `\d` `\D` | `[0-9]` `[^0-9]` (inside a class: `0-9` / a nested `[^0-9]`) |
//! | `\w` `\W` | `[A-Za-z0-9_]` `[^A-Za-z0-9_]` (likewise) |
//! | `\s` `\S` | the JavaScript white-space set, spelled out (likewise) |
//! | `\b` `\B` | `(?-u:\b)` `(?-u:\B)` — ASCII word boundaries; see [`CompiledRegex::is_match`] for `\B` |
//! | `\uXXXX` `\u{X…}` `\n` `\t` `\r` `\f` `\v` | `\x{HEX}` |
//! | `.` `^` `$` | unchanged: the crate's `.` already excludes exactly `\n` and its `(?m)` turns only at `\n` |
//! | flags `i` `m` `s` | a leading `(?ims)` group with the given letters |
//! | literals | backslash-escaped when the crate treats them as meta |
//!
//! A host may opt into the crate's native dialect through
//! [`crate::DataContext::regex_dialect`]: then the pattern is compiled as is
//! with the flags mapped to `RegexBuilder`. That is implementation-defined and
//! not portable; the spec tests only the baseline.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use regex::{Regex, RegexBuilder};

use crate::errors::{OqxError, Result};
use crate::semantics::json_quoted;
use crate::value::Value;

/// Which regex dialect `matches()` compiles against: the portable OQX
/// baseline (default) or the `regex` crate's own syntax (implementation-defined).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum RegexDialect {
    #[default]
    Oqx,
    Native,
}

/// The three OQX regex flags, given as the second argument of `matches()`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct RegexFlags {
    pub i: bool,
    pub m: bool,
    pub s: bool,
}

impl RegexFlags {
    fn letters(self) -> String {
        let mut out = String::new();
        if self.i {
            out.push('i');
        }
        if self.m {
            out.push('m');
        }
        if self.s {
            out.push('s');
        }
        out
    }
}

/// Parse the `flags` argument of `matches(pattern, flags)`: absent → none;
/// otherwise a string of distinct letters from `i`, `m`, `s`. Anything else is
/// an eval error (`unknown regex flag` / `duplicate regex flag`).
pub fn parse_regex_flags(v: &Value) -> Result<RegexFlags> {
    let mut flags = RegexFlags::default();
    let s = match v {
        Value::Undefined | Value::Null => return Ok(flags),
        Value::Str(s) => s,
        other => {
            return Err(OqxError::eval(format!(
                "unknown regex flags {other}: flags must be a string of \"i\", \"m\", \"s\""
            )));
        }
    };
    for c in s.chars() {
        let slot = match c {
            'i' => &mut flags.i,
            'm' => &mut flags.m,
            's' => &mut flags.s,
            _ => {
                return Err(OqxError::eval(format!(
                    "unknown regex flag {} in {} (flags are \"i\", \"m\", \"s\")",
                    json_quoted(&c.to_string()),
                    json_quoted(s)
                )));
            }
        };
        if *slot {
            return Err(OqxError::eval(format!(
                "duplicate regex flag {} in {}",
                json_quoted(&c.to_string()),
                json_quoted(s)
            )));
        }
        *slot = true;
    }
    Ok(flags)
}

/// A compiled `matches()` pattern.
#[derive(Clone, Debug)]
pub struct CompiledRegex {
    re: Regex,
    boundary_filter: bool,
}

impl CompiledRegex {
    /// Whether the pattern matches anywhere in `s`.
    ///
    /// The `regex` crate's ASCII `(?-u:\B)` can report a match at a byte
    /// offset inside a multi-byte character (both neighbouring bytes are
    /// non-word, so it is "not a boundary"), where JavaScript, working on code
    /// points, has no position at all. Such a match is always empty — every
    /// consuming element of a rewritten pattern is a Unicode code-point matcher
    /// that cannot start mid-character — so filtering out matches whose ends
    /// are not char boundaries leaves exactly the code-point answer. Patterns
    /// without `\B` take the plain `is_match` path.
    pub fn is_match(&self, s: &str) -> bool {
        if self.boundary_filter {
            self.re
                .find_iter(s)
                .any(|m| s.is_char_boundary(m.start()) && s.is_char_boundary(m.end()))
        } else {
            self.re.is_match(s)
        }
    }

    /// The underlying `regex` crate value (the rewritten pattern is `as_str()`).
    pub fn as_regex(&self) -> &Regex {
        &self.re
    }
}

type CacheKey = (RegexDialect, String, String);

static CACHE: LazyLock<Mutex<HashMap<CacheKey, CompiledRegex>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Compile a `matches()` pattern, raising an eval error for bad flags, an
/// invalid pattern (`invalid regular expression`), or — in the `Oqx` dialect —
/// a construct outside the baseline (`… is not supported in OQX regular
/// expressions`). Compiled patterns are cached.
pub fn compile_regex(pattern: &str, flags: &Value, dialect: RegexDialect) -> Result<CompiledRegex> {
    let f = parse_regex_flags(flags)?;
    let key = (dialect, f.letters(), pattern.to_owned());
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = cache.get(&key) {
            return Ok(c.clone());
        }
    }
    let compiled = match dialect {
        RegexDialect::Native => CompiledRegex {
            re: host_regex(
                pattern,
                RegexBuilder::new(pattern)
                    .case_insensitive(f.i)
                    .multi_line(f.m)
                    .dot_matches_new_line(f.s),
            )?,
            boundary_filter: false,
        },
        RegexDialect::Oqx => {
            let t = Translator::new(pattern, f).translate()?;
            CompiledRegex {
                re: host_regex(pattern, &mut RegexBuilder::new(&t.source))?,
                boundary_filter: t.boundary_filter,
            }
        }
    };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, compiled.clone());
    Ok(compiled)
}

fn host_regex(pattern: &str, builder: &mut RegexBuilder) -> Result<Regex> {
    builder.build().map_err(|e| {
        OqxError::eval(format!(
            "invalid regular expression {}: {e}",
            json_quoted(pattern)
        ))
    })
}

// ---- the baseline parser + `regex`-crate emitter ------------------------------

enum Escaped {
    /// `verbatim`: an escaped metacharacter, emitted as such (else as `\x{…}`).
    Char { cp: u32, verbatim: bool },
    /// `\d \D \w \W \s \S`
    Class(char),
    /// `\b \B`
    Assertion(char),
}

struct Translated {
    source: String,
    boundary_filter: bool,
}

/// Characters the `regex` crate treats as meta somewhere; always escaped when
/// literal (escaping any of them is accepted in and out of classes).
const RUST_META: &str = "\\.+*?()|[]{}^$#&-~";
/// The metacharacters a baseline pattern may escape.
const ESCAPABLE: &str = ".*+?()[]{}|^$\\/-";
/// JavaScript's `\s`: WhiteSpace ∪ LineTerminator.
const WHITE_SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

struct Translator<'p> {
    pattern: &'p str,
    /// The pattern as code points.
    cs: Vec<char>,
    i: usize,
    out: String,
    names: HashSet<String>,
    boundary_filter: bool,
}

impl<'p> Translator<'p> {
    fn new(pattern: &'p str, flags: RegexFlags) -> Self {
        let letters = flags.letters();
        let out = if letters.is_empty() {
            String::new()
        } else {
            format!("(?{letters})")
        };
        Self {
            pattern,
            cs: pattern.chars().collect(),
            i: 0,
            out,
            names: HashSet::new(),
            boundary_filter: false,
        }
    }

    fn translate(mut self) -> Result<Translated> {
        self.parse_disjunction()?;
        if self.i < self.cs.len() {
            return self.invalid("unmatched ')'");
        }
        Ok(Translated {
            source: self.out,
            boundary_filter: self.boundary_filter,
        })
    }

    // ---- errors ----

    fn unsupported<T>(&self, construct: &str) -> Result<T> {
        Err(OqxError::eval(format!(
            "{construct} is not supported in OQX regular expressions (pattern {})",
            json_quoted(self.pattern)
        )))
    }

    fn invalid<T>(&self, detail: &str) -> Result<T> {
        Err(OqxError::eval(format!(
            "invalid regular expression {}: {detail}",
            json_quoted(self.pattern)
        )))
    }

    // ---- cursor ----

    fn peek(&self, ahead: usize) -> Option<char> {
        self.cs.get(self.i + ahead).copied()
    }

    // ---- grammar ----

    fn parse_disjunction(&mut self) -> Result<()> {
        self.parse_alternative()?;
        while self.peek(0) == Some('|') {
            self.i += 1;
            self.out.push('|');
            self.parse_alternative()?;
        }
        Ok(())
    }

    fn parse_alternative(&mut self) -> Result<()> {
        loop {
            match self.peek(0) {
                None | Some('|') | Some(')') => return Ok(()),
                Some(_) => self.parse_term()?,
            }
        }
    }

    fn parse_term(&mut self) -> Result<()> {
        let c = self.peek(0).expect("caller checked");
        let mut assertion = false;
        match c {
            '^' | '$' => {
                self.i += 1;
                self.emit_anchor(c);
                assertion = true;
            }
            '\\' => match self.parse_escape(false)? {
                Escaped::Assertion(letter) => {
                    self.emit_assertion(letter);
                    assertion = true;
                }
                e => self.emit_atom(&e, false),
            },
            '(' => self.parse_group()?,
            '[' => self.parse_class()?,
            '.' => {
                self.i += 1;
                self.emit_dot();
            }
            '*' | '+' | '?' => return self.invalid(&format!("nothing to repeat before '{c}'")),
            '{' => {
                if self.quantifier_brace_end().is_some() {
                    return self.invalid("nothing to repeat before '{'");
                }
                return self.invalid("a literal '{' must be escaped as '\\{'");
            }
            '}' => return self.invalid("a literal '}' must be escaped as '\\}'"),
            ']' => return self.invalid("a literal ']' must be escaped as '\\]'"),
            _ => {
                self.i += 1;
                self.emit_literal(c);
            }
        }
        self.parse_quantifier(assertion)
    }

    /// Index of the closing `}` when the cursor is at a `{n}` / `{n,}` /
    /// `{n,m}` quantifier.
    fn quantifier_brace_end(&self) -> Option<usize> {
        let mut j = self.i + 1;
        let is_digit = |c: Option<&char>| c.is_some_and(char::is_ascii_digit);
        let start = j;
        while is_digit(self.cs.get(j)) {
            j += 1;
        }
        if j == start {
            return None;
        }
        if self.cs.get(j) == Some(&',') {
            j += 1;
            while is_digit(self.cs.get(j)) {
                j += 1;
            }
        }
        (self.cs.get(j) == Some(&'}')).then_some(j)
    }

    fn parse_quantifier(&mut self, assertion: bool) -> Result<()> {
        let mut q = match self.peek(0) {
            Some(c @ ('*' | '+' | '?')) => {
                self.i += 1;
                c.to_string()
            }
            Some('{') => {
                // A stray `{` is reported by the next parse_term.
                let Some(end) = self.quantifier_brace_end() else {
                    return Ok(());
                };
                let q: String = self.cs[self.i..=end].iter().collect();
                self.i = end + 1;
                let inner = &q[1..q.len() - 1];
                let (lo, hi) = inner.split_once(',').unwrap_or((inner, ""));
                let bound = |s: &str| -> Result<u64> {
                    s.parse::<u64>().map_err(|_| {
                        OqxError::eval(format!(
                            "invalid regular expression {}: quantifier bound too large in {q}",
                            json_quoted(self.pattern)
                        ))
                    })
                };
                let lo = bound(lo)?;
                if !hi.is_empty() && bound(hi)? < lo {
                    return self.invalid(&format!("numbers out of order in quantifier {q}"));
                }
                q
            }
            _ => return Ok(()),
        };
        if assertion {
            return self.invalid(&format!(
                "nothing to repeat: the quantifier '{q}' follows an assertion"
            ));
        }
        if self.peek(0) == Some('+') {
            return self.unsupported(&format!("a possessive quantifier ({q}+)"));
        }
        if self.peek(0) == Some('?') {
            q.push('?');
            self.i += 1;
        }
        match self.peek(0) {
            Some(n @ ('*' | '+' | '?')) => {
                return self.invalid(&format!("nothing to repeat before '{n}'"));
            }
            Some('{') if self.quantifier_brace_end().is_some() => {
                return self.invalid("nothing to repeat before '{'");
            }
            _ => {}
        }
        self.out.push_str(&q);
        Ok(())
    }

    fn parse_group(&mut self) -> Result<()> {
        self.i += 1; // (
        let mut open = "(".to_owned();
        if self.peek(0) == Some('?') {
            self.i += 1;
            let c = self.peek(0);
            match c {
                Some(':') => {
                    self.i += 1;
                    open = "(?:".to_owned();
                }
                Some('=') => return self.unsupported("lookahead (?=…)"),
                Some('!') => return self.unsupported("negative lookahead (?!…)"),
                Some('<') => {
                    match self.peek(1) {
                        Some('=') => return self.unsupported("lookbehind (?<=…)"),
                        Some('!') => return self.unsupported("negative lookbehind (?<!…)"),
                        _ => {}
                    }
                    self.i += 1;
                    let name = self.read_group_name()?;
                    open = format!("(?<{name}>");
                }
                Some('P') if self.peek(1) == Some('<') => {
                    return self.unsupported("the (?P<name>…) group syntax");
                }
                Some('>') => return self.unsupported("an atomic group (?>…)"),
                Some('#') => return self.unsupported("a comment group (?#…)"),
                Some(c) if is_flag_letter(c) => {
                    let mut j = self.i;
                    let mut run = String::new();
                    while let Some(&c) = self.cs.get(j).filter(|c| is_flag_letter(**c)) {
                        run.push(c);
                        j += 1;
                    }
                    if self.cs.get(j) == Some(&':') {
                        return self.unsupported(&format!("a modifier group (?{run}:…)"));
                    }
                    return self.unsupported(&format!("an inline flag (?{run})"));
                }
                _ => {
                    let shown = c.map(String::from).unwrap_or_default();
                    return self.unsupported(&format!("the group syntax (?{shown}…)"));
                }
            }
        }
        self.out.push_str(&open);
        self.parse_disjunction()?;
        if self.peek(0) != Some(')') {
            return self.invalid("unterminated group (missing ')')");
        }
        self.i += 1;
        self.out.push(')');
        Ok(())
    }

    fn read_group_name(&mut self) -> Result<String> {
        let mut name = String::new();
        loop {
            match self.peek(0) {
                None => return self.invalid("unterminated group name (missing '>')"),
                Some('>') => break,
                Some(c) => {
                    name.push(c);
                    self.i += 1;
                }
            }
        }
        self.i += 1; // >
        let mut chars = name.chars();
        let valid = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return self.invalid(&format!("invalid group name '{name}'"));
        }
        if !self.names.insert(name.clone()) {
            return self.invalid(&format!("duplicate group name '{name}'"));
        }
        Ok(name)
    }

    fn parse_class(&mut self) -> Result<()> {
        self.i += 1; // [
        let mut negate = false;
        if self.peek(0) == Some('^') {
            negate = true;
            self.i += 1;
        }
        if self.peek(0) == Some(']') {
            return self.invalid("empty character class");
        }
        self.out.push_str(if negate { "[^" } else { "[" });
        loop {
            match self.peek(0) {
                None => return self.invalid("unterminated character class (missing ']')"),
                Some(']') => {
                    self.i += 1;
                    break;
                }
                Some(_) => {}
            }
            let lo = self.parse_class_atom()?;
            let n = self.peek(1);
            if self.peek(0) == Some('-') && n.is_some() && n != Some(']') {
                self.i += 1; // -
                let Escaped::Char { cp: lo_cp, .. } = lo else {
                    return self.invalid(&format!(
                        "a class escape (\\{}) cannot be a range endpoint",
                        class_letter(&lo)
                    ));
                };
                let hi = self.parse_class_atom()?;
                let Escaped::Char { cp: hi_cp, .. } = hi else {
                    return self.invalid(&format!(
                        "a class escape (\\{}) cannot be a range endpoint",
                        class_letter(&hi)
                    ));
                };
                if hi_cp < lo_cp {
                    return self.invalid("range out of order in character class");
                }
                self.emit_atom(&lo, true);
                self.out.push('-');
                self.emit_atom(&hi, true);
            } else {
                self.emit_atom(&lo, true);
            }
        }
        self.out.push(']');
        Ok(())
    }

    fn parse_class_atom(&mut self) -> Result<Escaped> {
        let c = self.peek(0).expect("caller checked");
        match c {
            '\\' => {
                let e = self.parse_escape(true)?;
                if matches!(e, Escaped::Assertion(_)) {
                    // unreachable: parse_escape rejects it inside a class
                    return self.unsupported("the backspace escape ([\\b])");
                }
                Ok(e)
            }
            '[' => {
                if self.peek(1) == Some(':') {
                    return self.unsupported("a POSIX class ([[:alpha:]])");
                }
                self.unsupported("a nested character class ([[…]])")
            }
            '&' if self.peek(1) == Some('&') => self.unsupported("a class set operation (&&)"),
            '~' if self.peek(1) == Some('~') => self.unsupported("a class set operation (~~)"),
            _ => {
                self.i += 1;
                Ok(Escaped::Char {
                    cp: c as u32,
                    verbatim: true,
                })
            }
        }
    }

    fn parse_escape(&mut self, in_class: bool) -> Result<Escaped> {
        self.i += 1; // backslash
        let Some(n) = self.peek(0) else {
            return self.invalid("trailing backslash");
        };
        self.i += 1;
        let ch = |cp: u32, verbatim: bool| Ok(Escaped::Char { cp, verbatim });
        match n {
            'd' | 'D' | 'w' | 'W' | 's' | 'S' => Ok(Escaped::Class(n)),
            'b' | 'B' => {
                if in_class {
                    return self.unsupported("the backspace escape ([\\b])");
                }
                Ok(Escaped::Assertion(n))
            }
            'n' => ch(0x0a, false),
            't' => ch(0x09, false),
            'r' => ch(0x0d, false),
            'f' => ch(0x0c, false),
            'v' => ch(0x0b, false),
            'u' => {
                let cp = self.parse_unicode_escape()?;
                ch(cp, false)
            }
            '0' => self.unsupported("an octal escape (\\0)"),
            '1'..='9' => {
                if in_class {
                    self.unsupported(&format!("an octal escape (\\{n})"))
                } else {
                    self.unsupported(&format!("a backreference (\\{n})"))
                }
            }
            'k' => {
                if self.peek(0) == Some('<') {
                    return self.unsupported("a named backreference (\\k<…>)");
                }
                self.unsupported("an identity escape (\\k)")
            }
            'p' | 'P' => self.unsupported(&format!("a Unicode property escape (\\{n}{{…}})")),
            'x' => self.unsupported("a hex escape (\\x…)"),
            'c' => self.unsupported("a control escape (\\c…)"),
            'A' | 'z' | 'Z' | 'G' | 'K' | 'Q' | 'E' => {
                self.unsupported(&format!("the escape \\{n}"))
            }
            _ => {
                if ESCAPABLE.contains(n) {
                    return ch(n as u32, true);
                }
                self.unsupported(&format!("an identity escape (\\{n})"))
            }
        }
    }

    fn parse_unicode_escape(&mut self) -> Result<u32> {
        let hex: String = if self.peek(0) == Some('{') {
            self.i += 1;
            let mut h = String::new();
            while let Some(c) = self.peek(0).filter(|&c| c != '}') {
                h.push(c);
                self.i += 1;
            }
            if self.peek(0) != Some('}') {
                return self.invalid("unterminated \\u{…} escape");
            }
            self.i += 1;
            if h.is_empty() || h.len() > 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
                return self.invalid(&format!("\\u{{{h}}} must have one to six hex digits"));
            }
            h
        } else {
            let h: String = self.cs[self.i..self.cs.len().min(self.i + 4)]
                .iter()
                .collect();
            if h.len() != 4 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
                return self.invalid("\\u must be followed by exactly four hex digits or {…}");
            }
            self.i += 4;
            h
        };
        let cp = u32::from_str_radix(&hex, 16).expect("validated hex");
        if cp > 0x10ffff {
            return self.invalid(&format!("\\u{{{hex}}} is beyond U+10FFFF"));
        }
        if (0xd800..=0xdfff).contains(&cp) {
            return self.invalid(&format!(
                "\\u{hex} is a surrogate code point, not a character"
            ));
        }
        Ok(cp)
    }

    // ---- emission (`regex` crate syntax) ----

    fn emit_atom(&mut self, a: &Escaped, in_class: bool) {
        match a {
            Escaped::Class(letter) => self.emit_class_escape(*letter, in_class),
            Escaped::Char { cp, verbatim: true } => {
                self.emit_literal(char::from_u32(*cp).expect("validated code point"));
            }
            Escaped::Char {
                cp,
                verbatim: false,
            } => {
                self.out.push_str(&format!("\\x{{{cp:X}}}"));
            }
            Escaped::Assertion(letter) => self.emit_assertion(*letter),
        }
    }

    fn emit_literal(&mut self, ch: char) {
        if RUST_META.contains(ch) {
            self.out.push('\\');
        }
        self.out.push(ch);
    }

    /// The spec-fixed class sets. Inside a bracket class a positive set is
    /// spliced in as items; a negated set becomes a nested class.
    fn emit_class_escape(&mut self, letter: char, in_class: bool) {
        let items = match letter.to_ascii_lowercase() {
            'd' => "0-9",
            'w' => "A-Za-z0-9_",
            _ => WHITE_SPACE,
        };
        let negated = letter.is_ascii_uppercase();
        if negated {
            self.out.push_str(&format!("[^{items}]"));
        } else if in_class {
            self.out.push_str(items);
        } else {
            self.out.push_str(&format!("[{items}]"));
        }
    }

    fn emit_assertion(&mut self, letter: char) {
        if letter == 'B' {
            self.boundary_filter = true;
        }
        self.out.push_str(&format!("(?-u:\\{letter})"));
    }

    /// `.` is any code point but `\n` (the crate's default); under `s` the
    /// `(?s)` prefix makes it match `\n` too.
    fn emit_dot(&mut self) {
        self.out.push('.');
    }

    /// Under `m` the `(?m)` prefix makes `^`/`$` turn at `\n` — and, in this
    /// crate, only at `\n`, which is exactly the baseline's rule.
    fn emit_anchor(&mut self, c: char) {
        self.out.push(c);
    }
}

fn is_flag_letter(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '-'
}

fn class_letter(e: &Escaped) -> char {
    match e {
        Escaped::Class(c) | Escaped::Assertion(c) => *c,
        Escaped::Char { .. } => '?',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(pattern: &str, flags: &str) -> String {
        compile_regex(pattern, &Value::Str(flags.to_owned()), RegexDialect::Oqx)
            .unwrap()
            .as_regex()
            .as_str()
            .to_owned()
    }

    fn matches(subject: &str, pattern: &str, flags: &str) -> bool {
        compile_regex(pattern, &Value::Str(flags.to_owned()), RegexDialect::Oqx)
            .unwrap()
            .is_match(subject)
    }

    fn error(pattern: &str) -> String {
        compile_regex(pattern, &Value::Undefined, RegexDialect::Oqx)
            .unwrap_err()
            .message
    }

    #[test]
    fn rewrite_table() {
        assert_eq!(
            source(r"\d\D\w\W", ""),
            "[0-9][^0-9][A-Za-z0-9_][^A-Za-z0-9_]"
        );
        assert_eq!(source(r"[\d_]", ""), "[0-9_]");
        assert_eq!(source(r"[\D,]", ""), "[[^0-9],]");
        assert_eq!(source(r"\s", ""), format!("[{WHITE_SPACE}]"));
        assert_eq!(source(r"\b\B", ""), r"(?-u:\b)(?-u:\B)");
        assert_eq!(
            source(r"\u00e9\u{1F600}\n\t\r\f\v", ""),
            r"\x{E9}\x{1F600}\x{A}\x{9}\x{D}\x{C}\x{B}"
        );
        assert_eq!(source(r"a\.b\/c\-d#&~", ""), r"a\.b/c\-d\#\&\~");
        assert_eq!(source(r"^a.b$", "ims"), r"(?ims)^a.b$");
        assert_eq!(source(r"(?<n>a)(?:b)(c)|d", ""), r"(?<n>a)(?:b)(c)|d");
        assert_eq!(source(r"a{2,3}?b+?c*?d??", ""), r"a{2,3}?b+?c*?d??");
    }

    #[test]
    fn spec_fixed_semantics() {
        assert!(!matches("٣", r"\d", ""));
        assert!(!matches("é", r"\w", ""));
        assert!(matches("éa", r"\ba", ""));
        assert!(!matches("aéa", r"\B", "")); // the mid-character position is filtered out
        assert!(matches("éé", r"\B", ""));
        assert!(matches("", r"\B", ""));
        assert!(!matches("\u{85}", r"\s", ""));
        assert!(matches("\u{feff}", r"\s", ""));
        assert!(matches("😀", r"^.$", ""));
        assert!(matches("a\rb", r"a.b", ""));
        assert!(!matches("a\nb", r"a.b", ""));
        assert!(matches("a\nb", r"a.b", "s"));
        assert!(matches("a\nb", r"^b", "m"));
        assert!(!matches("a\r\nb", r"a$", "m"));
        assert!(matches("É", "é", "i"));
    }

    #[test]
    fn errors_name_the_construct() {
        for (pattern, what) in [
            ("(?i)a", "an inline flag (?i)"),
            ("(?i:a)", "a modifier group (?i:…)"),
            (r"\p{L}", r"a Unicode property escape (\p{…})"),
            (r"\x41", r"a hex escape (\x…)"),
            ("a*+", "a possessive quantifier (*+)"),
            ("[[:alpha:]]", "a POSIX class ([[:alpha:]])"),
            (r"(a)\1", r"a backreference (\1)"),
            ("a(?=b)", "lookahead (?=…)"),
        ] {
            let msg = error(pattern);
            assert!(
                msg.contains("not supported in OQX regular expressions") && msg.contains(what),
                "{pattern}: {msg}"
            );
        }
        for pattern in [
            "(",
            "a)",
            "[a",
            "[]",
            "[z-a]",
            "*a",
            "a**",
            "^*",
            "a{2,1}",
            "a{",
            r"\u12",
            r"\uD83D",
            "(?<n>a)(?<n>b)",
        ] {
            let msg = error(pattern);
            assert!(
                msg.contains("invalid regular expression"),
                "{pattern}: {msg}"
            );
        }
    }

    #[test]
    fn flags_are_validated() {
        let bad = |v: Value| {
            compile_regex("a", &v, RegexDialect::Oqx)
                .unwrap_err()
                .message
        };
        assert!(bad(Value::Str("x".into())).contains("unknown regex flag"));
        assert!(bad(Value::Str("ii".into())).contains("duplicate regex flag"));
        assert!(bad(Value::Number(1.0)).contains("unknown regex flag"));
        assert!(compile_regex("a", &Value::Null, RegexDialect::Oqx).is_ok());
    }

    #[test]
    fn native_dialect_is_the_crate_as_is() {
        let re = compile_regex("(?i)ELL", &Value::Undefined, RegexDialect::Native).unwrap();
        assert!(re.is_match("hello"));
        let re = compile_regex(r"\d", &Value::Undefined, RegexDialect::Native).unwrap();
        assert!(re.is_match("٣")); // Unicode-aware: the crate's own \d
        let err = compile_regex("(", &Value::Undefined, RegexDialect::Native).unwrap_err();
        assert!(err.message.contains("invalid regular expression"));
    }
}
