//! The YAML contract (§4): YAML 1.2 structure from `saphyr-parser`, plain
//! scalars resolved here by the **core schema** exactly as the `yaml` npm
//! package (v2) resolves them, keys stringified as JavaScript does, and the
//! failure set — duplicate keys, tab indentation, more than one document,
//! any syntax error — mapped to "no document" (`None`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};

use crate::value::{Mapping, Value, js_number_string};

/// The handle `saphyr-parser` gives the `!!` shorthand.
const CORE_HANDLE: &str = "tag:yaml.org,2002:";

// The core-schema tests of `yaml` v2 (`schema/core/*.ts`), in its try order.
static NULL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:~|[Nn]ull|NULL)?$").expect("valid"));
static BOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$").expect("valid"));
static INT_OCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").expect("valid"));
static INT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").expect("valid"));
static INT_HEX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").expect("valid"));
static FLOAT_NAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$").expect("valid"));
static FLOAT_EXP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$").expect("valid")
});
static FLOAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$").expect("valid"));
/// The YAML 1.1 `!!timestamp` test (`yaml` resolves an explicitly tagged
/// timestamp to a `Date`, which flattens to nothing — §2.3 treats an object
/// with no enumerable entries as an empty mapping).
static TIMESTAMP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:(?:t|T|[ \t]+)[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]+)?(?:[ \t]*(?:Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$",
    )
    .expect("valid")
});

/// Digits in `radix` (2..=16) folded into a double: exact through `u128`,
/// then IEEE rounding, as `parseInt(str, radix)` yields.
fn fold_digits(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut acc: u128 = 0;
    let mut overflow = false;
    let mut approx: f64 = 0.0;
    for c in digits.chars() {
        let d = c.to_digit(radix)?;
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
    Some(if overflow { approx } else { acc as f64 })
}

/// Rust's float grammar wants a digit on both sides of `.` when an exponent
/// follows (`5.e3`) and accepts everything else the YAML float regexes admit.
fn parse_float(s: &str) -> f64 {
    let fixed = s.replace(".e", ".0e").replace(".E", ".0E");
    fixed
        .parse::<f64>()
        .expect("core-schema float strings are Rust floats")
}

/// The `!!int` tests: decimal, `0o` octal, `0x` hex.
fn resolve_int(s: &str) -> Option<Value> {
    if INT_OCT_RE.is_match(s) {
        return fold_digits(&s[2..], 8).map(Value::Number);
    }
    if INT_RE.is_match(s) {
        return Some(Value::Number(
            s.parse::<f64>().expect("decimal integers are Rust floats"),
        ));
    }
    if INT_HEX_RE.is_match(s) {
        return fold_digits(&s[2..], 16).map(Value::Number);
    }
    None
}

/// The `!!float` tests: `.inf`/`.nan`, exponent form, plain decimal.
fn resolve_float(s: &str) -> Option<Value> {
    if FLOAT_NAN_RE.is_match(s) {
        return Some(Value::Number(
            if s.ends_with("nan") || s.ends_with("NaN") || s.ends_with("NAN") {
                f64::NAN
            } else if s.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            },
        ));
    }
    if FLOAT_EXP_RE.is_match(s) || FLOAT_RE.is_match(s) {
        return Some(Value::Number(parse_float(s)));
    }
    None
}

/// §4: resolve an untagged plain scalar by the core schema.
#[must_use]
pub fn resolve_plain(s: &str) -> Value {
    if NULL_RE.is_match(s) {
        return Value::Null;
    }
    if BOOL_RE.is_match(s) {
        return Value::Bool(s.starts_with(['t', 'T']));
    }
    if let Some(v) = resolve_int(s) {
        return v;
    }
    if let Some(v) = resolve_float(s) {
        return v;
    }
    Value::String(s.to_owned())
}

/// A scalar with its style and tag: quoted and block scalars are strings; a
/// core tag applies **only when its own test matches** (`!!float 1` is the
/// string `"1"`, `!!int 1.5` the string `"1.5"`, `!!bool yes` the string
/// `"yes"` — `yaml` v2 warns and falls back to `!!str`); an unknown tag is
/// a string.
fn resolve_scalar(s: &str, style: ScalarStyle, tag: Option<&Tag>) -> Value {
    let Some(tag) = tag else {
        return if style == ScalarStyle::Plain {
            resolve_plain(s)
        } else {
            Value::String(s.to_owned())
        };
    };
    if tag.handle != CORE_HANDLE {
        return Value::String(s.to_owned());
    }
    let resolved = match tag.suffix.as_str() {
        "int" => resolve_int(s),
        "float" => resolve_float(s),
        "bool" => BOOL_RE
            .is_match(s)
            .then(|| Value::Bool(s.starts_with(['t', 'T']))),
        "null" => NULL_RE.is_match(s).then_some(Value::Null),
        "timestamp" => TIMESTAMP_RE
            .is_match(s)
            .then(|| Value::Mapping(Mapping::new())),
        _ => None,
    };
    resolved.unwrap_or_else(|| Value::String(s.to_owned()))
}

/// §4 "Keys": a key is stringified as JavaScript stringifies the resolved
/// value — `null` → `""`, booleans and numbers via `String(x)`; a
/// collection key becomes its flow rendering (`[ a, b ]`, `{ a: 1 }`).
#[must_use]
pub fn key_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(*n),
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            if items.is_empty() {
                "[]".to_owned()
            } else {
                let inner: Vec<String> = items.iter().map(flow_string).collect();
                format!("[ {} ]", inner.join(", "))
            }
        }
        Value::Mapping(m) => {
            if m.is_empty() {
                "{}".to_owned()
            } else {
                let inner: Vec<String> = m
                    .iter()
                    .map(|(k, v)| format!("{k}: {}", flow_string(v)))
                    .collect();
                format!("{{ {} }}", inner.join(", "))
            }
        }
    }
}

fn flow_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        other => key_string(other),
    }
}

/// `yaml` v2 rejects a tab in indentation ("Tabs are not allowed as
/// indentation"); `saphyr-parser` lets one through at the start of the
/// document. A line that begins with a tab and carries content is such a
/// line in a mapping document (content lines of a nested block scalar are
/// indented by spaces first); comment lines are left alone.
fn has_tab_indentation(text: &str) -> bool {
    text.split(['\n', '\r']).any(|line| {
        line.starts_with('\t') && {
            let content = line.trim_start_matches([' ', '\t']);
            !content.is_empty() && !content.starts_with('#')
        }
    })
}

enum Frame {
    Seq {
        items: Vec<Value>,
        anchor: usize,
        tag: Option<Tag>,
    },
    Map {
        entries: Mapping,
        key: Option<String>,
        anchor: usize,
        tag: Option<Tag>,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: BTreeMap<usize, Value>,
    root: Option<Value>,
    documents: usize,
}

impl Builder {
    /// Put a finished node where it belongs; `None` on a duplicate key.
    fn place(&mut self, node: Value) -> Option<()> {
        match self.stack.last_mut() {
            None => {
                if self.root.is_some() {
                    return None;
                }
                self.root = Some(node);
            }
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                None => *key = Some(key_string(&node)),
                Some(k) => {
                    if !entries.insert(k, node) {
                        return None;
                    }
                }
            },
        }
        Some(())
    }

    fn anchor(&mut self, id: usize, node: &Value) {
        if id != 0 {
            self.anchors.insert(id, node.clone());
        }
    }

    fn event(&mut self, event: Event<'_>) -> Option<()> {
        match event {
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => {}
            Event::DocumentStart(_) => {
                self.documents += 1;
                if self.documents > 1 {
                    return None;
                }
            }
            Event::Scalar(text, style, anchor, tag) => {
                let node = resolve_scalar(&text, style, tag.as_deref());
                self.anchor(anchor, &node);
                self.place(node)?;
            }
            Event::Alias(id) => {
                let node = self.anchors.get(&id)?.clone();
                self.place(node)?;
            }
            Event::SequenceStart(anchor, tag) => self.stack.push(Frame::Seq {
                items: Vec::new(),
                anchor,
                tag: tag.map(|t| t.into_owned()),
            }),
            Event::SequenceEnd => {
                let Some(Frame::Seq { items, anchor, tag }) = self.stack.pop() else {
                    return None;
                };
                // `!!omap` resolves to a `Map` in JavaScript, which flattens
                // to nothing: an empty mapping.
                let node = if is_core(tag.as_ref(), "omap") {
                    Value::Mapping(Mapping::new())
                } else {
                    Value::Array(items)
                };
                self.anchor(anchor, &node);
                self.place(node)?;
            }
            Event::MappingStart(anchor, tag) => self.stack.push(Frame::Map {
                entries: Mapping::new(),
                key: None,
                anchor,
                tag: tag.map(|t| t.into_owned()),
            }),
            Event::MappingEnd => {
                let Some(Frame::Map {
                    entries,
                    key,
                    anchor,
                    tag,
                }) = self.stack.pop()
                else {
                    return None;
                };
                if key.is_some() {
                    return None;
                }
                // `!!set` resolves to a `Set`: no enumerable entries.
                let node = if is_core(tag.as_ref(), "set") {
                    Value::Mapping(Mapping::new())
                } else {
                    Value::Mapping(entries)
                };
                self.anchor(anchor, &node);
                self.place(node)?;
            }
        }
        Some(())
    }
}

fn is_core(tag: Option<&Tag>, suffix: &str) -> bool {
    tag.is_some_and(|t| t.handle == CORE_HANDLE && t.suffix == suffix)
}

/// Parse `text` as one YAML document. `None` on any failure of §4 (syntax
/// error, duplicate key, tab indentation, more than one document, an
/// unresolved alias); `Some(Value::Null)` for an empty or comment-only text.
#[must_use]
pub fn parse_document(text: &str) -> Option<Value> {
    if has_tab_indentation(text) {
        return None;
    }
    let mut b = Builder::default();
    for item in Parser::new_from_str(text) {
        let (event, _span) = item.ok()?;
        b.event(event)?;
    }
    if !b.stack.is_empty() {
        return None;
    }
    Some(b.root.unwrap_or(Value::Null))
}

/// §3.1 / §4: the frontmatter's YAML text as a mapping, or `None` when it
/// fails to parse or is not a mapping (a scalar, a sequence, empty).
#[must_use]
pub fn parse_frontmatter(text: &str) -> Option<Mapping> {
    match parse_document(text)? {
        Value::Mapping(m) => Some(m),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(text: &str) -> Mapping {
        parse_frontmatter(text).unwrap_or_else(|| panic!("{text:?} should parse to a mapping"))
    }

    fn one(text: &str) -> Value {
        let m = map(text);
        assert_eq!(m.len(), 1, "{text:?}");
        m.entries[0].1.clone()
    }

    fn num(text: &str) -> f64 {
        match one(text) {
            Value::Number(n) => n,
            other => panic!("{text:?} → {other:?}, expected a number"),
        }
    }

    fn s(v: &str) -> Value {
        Value::String(v.to_owned())
    }

    #[test]
    fn nulls_and_bools_are_core_schema_only() {
        for t in ["a: null", "a: Null", "a: NULL", "a: ~", "a:", "a: "] {
            assert_eq!(one(t), Value::Null, "{t:?}");
        }
        assert_eq!(one("a: nULL"), s("nULL"));
        for t in ["a: true", "a: True", "a: TRUE"] {
            assert_eq!(one(t), Value::Bool(true), "{t:?}");
        }
        for t in ["a: false", "a: False", "a: FALSE"] {
            assert_eq!(one(t), Value::Bool(false), "{t:?}");
        }
        for t in [
            "a: yes", "a: no", "a: on", "a: off", "a: y", "a: n", "a: Yes", "a: NO", "a: tRUE",
        ] {
            assert!(matches!(one(t), Value::String(_)), "{t:?}");
        }
    }

    #[test]
    fn ints_and_floats_as_yaml_v2_reads_them() {
        assert_eq!(num("a: 012"), 12.0);
        assert_eq!(num("a: 0o17"), 15.0);
        assert_eq!(num("a: 0x1F"), 31.0);
        assert_eq!(num("a: +5"), 5.0);
        assert!(num("a: -0").is_sign_negative());
        assert_eq!(num("a: .5"), 0.5);
        assert_eq!(num("a: 5."), 5.0);
        assert_eq!(num("a: 1e3"), 1000.0);
        assert_eq!(num("a: 1E+3"), 1000.0);
        assert_eq!(num("a: 5.e3"), 5000.0);
        assert_eq!(num("a: -.5e-2"), -0.005);
        assert_eq!(num("a: 00"), 0.0);
        assert_eq!(num("a: 08"), 8.0);
        assert_eq!(num("a: 0777"), 777.0);
        assert_eq!(num("a: 1."), 1.0);
        assert_eq!(num("a: 1e400"), f64::INFINITY);
        assert_eq!(num("a: 9007199254740993"), 9_007_199_254_740_992.0);
        assert_eq!(num("a: .inf"), f64::INFINITY);
        assert_eq!(num("a: -.inf"), f64::NEG_INFINITY);
        assert_eq!(num("a: +.INF"), f64::INFINITY);
        assert_eq!(num("a: -.Inf"), f64::NEG_INFINITY);
        assert!(num("a: .nan").is_nan());
        assert!(num("a: .NaN").is_nan());
        assert!(num("a: .NAN").is_nan());
        assert_eq!(num("a: 1.5e3"), 1500.0);
        assert_eq!(num("a: -1"), -1.0);
        // 34 hex digits overflow u128 and fold on in doubles, like `parseInt`.
        let big = num("a: 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
        assert!(big.is_finite() && big > 8.7e40 && big < 8.8e40, "{big:e}");
        for t in [
            "a: 1_000",
            "a: .",
            "a: 1e",
            "a: 0b101",
            "a: 1:30",
            "a: 0o",
            "a: 0x",
            "a: -0x10",
            "a: +0x10",
            "a: -0o7",
            "a: .iNf",
            "a: -.nan",
            "a: +.nan",
            "a: 1,000",
            "a: 2026-01-01",
            "a: 2026-01-01T10:00:00Z",
            "a: 2026-01-01 10:00",
            "a: 1..5",
            "a: 0o8",
            "a: 0xG",
            "a: 1e3.5",
        ] {
            assert!(matches!(one(t), Value::String(_)), "{t:?} → {:?}", one(t));
        }
    }

    #[test]
    fn quoted_block_and_folded_scalars_are_strings() {
        assert_eq!(one("a: \"1\""), s("1"));
        assert_eq!(one("a: 'x'"), s("x"));
        assert_eq!(one("a: \"\""), s(""));
        assert_eq!(one("a: ''"), s(""));
        assert_eq!(one("a: \"  x \""), s("  x "));
        assert_eq!(one("a: 'it''s'"), s("it's"));
        assert_eq!(one("a: \"\\u00e9\\n\""), s("é\n"));
        assert_eq!(one("a: hello\n  world"), s("hello world"));
        assert_eq!(one("a: \"multi\n  line\""), s("multi line"));
        assert_eq!(one("a: |\n  line1\n  line2\n"), s("line1\nline2\n"));
        assert_eq!(one("a: >\n  l1\n  l2\n"), s("l1 l2\n"));
        assert_eq!(one("a: |-\n  x\n"), s("x"));
        assert_eq!(one("a: |+\n  x\n\n"), s("x\n\n"));
        assert_eq!(one("a: 1 # comment"), Value::Number(1.0));
        assert_eq!(one("a: x # c\n# d"), s("x"));
    }

    #[test]
    fn tags_resolve_only_when_their_test_matches() {
        assert_eq!(one("a: !!str 1"), s("1"));
        assert_eq!(one("a: !!str .nan"), s(".nan"));
        assert_eq!(one("a: !!int 12"), Value::Number(12.0));
        assert_eq!(one("a: !!int \"12\""), Value::Number(12.0));
        assert_eq!(one("a: !!int 0x10"), Value::Number(16.0));
        assert_eq!(one("a: !!int 0o7"), Value::Number(7.0));
        assert_eq!(one("a: !!int 012"), Value::Number(12.0));
        assert_eq!(one("a: !!int abc"), s("abc"));
        assert_eq!(one("a: !!int 1.5"), s("1.5"));
        assert_eq!(one("a: !!int"), s(""));
        assert_eq!(one("a: !!float 1"), s("1"));
        assert_eq!(one("a: !!float 1."), Value::Number(1.0));
        assert_eq!(one("a: !!float 1e3"), Value::Number(1000.0));
        assert_eq!(one("a: !!float .inf"), Value::Number(f64::INFINITY));
        assert_eq!(one("a: !!float abc"), s("abc"));
        assert_eq!(one("a: !!bool true"), Value::Bool(true));
        assert_eq!(one("a: !!bool yes"), s("yes"));
        assert_eq!(one("a: !!bool abc"), s("abc"));
        assert_eq!(one("a: !!null x"), s("x"));
        assert_eq!(one("a: !!null"), Value::Null);
        assert_eq!(one("a: !!null ~"), Value::Null);
        assert_eq!(one("a: !custom 1"), s("1"));
        assert_eq!(one("a: !!foo 1"), s("1"));
        assert_eq!(one("a: !!value 1"), s("1"));
        assert_eq!(one("a: !<tag:example.com,2000:app/foo> 1"), s("1"));
        assert_eq!(
            one("a: !!timestamp 2001-12-14"),
            Value::Mapping(Mapping::new())
        );
        assert_eq!(one("a: !!timestamp nope"), s("nope"));
        assert_eq!(one("a: !!set {x, y}"), Value::Mapping(Mapping::new()));
        assert_eq!(one("a: !!omap [{x: 1}]"), Value::Mapping(Mapping::new()));
        assert_eq!(
            one("a: !!pairs [{x: 1}]"),
            Value::Array(vec![Value::Mapping(Mapping::from(vec![(
                "x".to_owned(),
                Value::Number(1.0)
            )]))])
        );
        assert_eq!(one("a: !!seq [1]"), Value::Array(vec![Value::Number(1.0)]));
        assert_eq!(
            one("a: !custom [1]"),
            Value::Array(vec![Value::Number(1.0)])
        );
        assert_eq!(
            one("a: !!map {x: 1}"),
            Value::Mapping(Mapping::from(vec![("x".to_owned(), Value::Number(1.0))]))
        );
        assert_eq!(map("!!map\na: 1").len(), 1);
    }

    #[test]
    fn keys_are_javascript_strings() {
        let key = |t: &str| map(t).entries[0].0.clone();
        assert_eq!(key("1.0: x"), "1");
        assert_eq!(key("1.50: x"), "1.5");
        assert_eq!(key("1e3: x"), "1000");
        assert_eq!(key("0x10: x"), "16");
        assert_eq!(key(".inf: x"), "Infinity");
        assert_eq!(key(".nan: x"), "NaN");
        assert_eq!(key("true: x"), "true");
        assert_eq!(key("Null: x"), "");
        assert_eq!(key("~: x"), "");
        assert_eq!(key("null: x"), "");
        assert_eq!(key("1: x"), "1");
        assert_eq!(key("\"1\": x"), "1");
        assert_eq!(key("\"\": x"), "");
        assert_eq!(key("-0: x"), "0");
        assert_eq!(key("012: x"), "12");
        assert_eq!(key("meta.owner: x"), "meta.owner");
        assert_eq!(key("a b: x"), "a b");
        assert_eq!(key("\"a b\": x"), "a b");
        assert_eq!(key("'a': 1"), "a");
        assert_eq!(key("? [a, b]\n: x"), "[ a, b ]");
        assert_eq!(key("? {a: 1}\n: x"), "{ a: 1 }");
        assert_eq!(key("&anchor a: 1"), "a");
        assert_eq!(key("<<: {a: 1}"), "<<", "merge is off in 1.2");
        let m = map("b: 1\n1: 2\n\"01\": 3");
        let keys: Vec<&str> = m.iter().map(|(k, _)| k).collect();
        assert_eq!(
            keys,
            ["b", "1", "01"],
            "parser order, not JS integer-key order"
        );
    }

    #[test]
    fn anchors_and_aliases_resolve() {
        let m = map("a: &x 1\nb: *x");
        assert_eq!(m.get("a"), Some(&Value::Number(1.0)));
        assert_eq!(m.get("b"), Some(&Value::Number(1.0)));
        let m = map("a: &x [1, 2]\nb: *x");
        assert_eq!(m.get("b"), m.get("a"));
        let m = map("a: &x {c: 1}\n<<: *x");
        assert_eq!(m.get("<<"), m.get("a"));
        assert_eq!(parse_document("a: *missing"), None);
    }

    #[test]
    fn failures_yield_no_document() {
        for t in [
            "a: 1\na: 2",
            "{a: 1, a: 2}",
            "a: {b: 1, b: 2}",
            "1: a\n01: b",
            "null: 1\n~: 2",
            "a:\n\tb: 1",
            "\ta: 1",
            "a: 1\n\tb: 2",
            "a: 1\n---\nb: 2",
            "a: b: c",
            "a: [1, 2",
            "a: 'unterminated",
            "a: @x",
            "a: `x`",
            "a: %x",
            "a: b\n b: c",
            "a: 1\n  b: 2",
            "a: -\nb: 1",
        ] {
            assert_eq!(parse_document(t), None, "{t:?}");
        }
    }

    #[test]
    fn non_mappings_are_not_frontmatter() {
        assert_eq!(parse_document(""), Some(Value::Null));
        assert_eq!(parse_document("# comment only"), Some(Value::Null));
        assert_eq!(parse_document("\n\n"), Some(Value::Null));
        assert_eq!(parse_document("- a"), Some(Value::Array(vec![s("a")])));
        assert_eq!(parse_document("just a string"), Some(s("just a string")));
        assert_eq!(parse_document("42"), Some(Value::Number(42.0)));
        assert_eq!(parse_document("null"), Some(Value::Null));
        assert_eq!(parse_document("[]"), Some(Value::Array(vec![])));
        for t in [
            "",
            "# comment only",
            "- a",
            "just a string",
            "42",
            "null",
            "~",
            "[]",
        ] {
            assert_eq!(parse_frontmatter(t), None, "{t:?}");
        }
        assert_eq!(parse_frontmatter("{}"), Some(Mapping::new()));
    }

    #[test]
    fn accepted_oddities() {
        assert_eq!(map("a: 1\n...\n").len(), 1, "a document end marker is fine");
        assert_eq!(
            map("%YAML 1.2\n---\na: 1").len(),
            1,
            "one explicit document"
        );
        assert_eq!(map("a: 1\r\nb: 2\r\n").len(), 2, "CRLF");
        assert_eq!(one("a: b\tc"), s("b\tc"), "a tab inside a scalar");
        assert_eq!(
            map("a:\n  - 1\n  -\t2").get("a"),
            Some(&Value::Array(vec![Value::Number(1.0), Value::Number(2.0)]))
        );
        assert_eq!(map("a: x\n\n\n").len(), 1);
        assert_eq!(map("\n\na: 1").len(), 1);
        assert_eq!(map("a: 1\n\n# trailing").len(), 1);
        assert_eq!(map("a: 1\nb:\nc: 3").get("b"), Some(&Value::Null));
        assert_eq!(map("a:  1  \nb : 2").len(), 2);
        assert_eq!(map("a: 1\n\t# a tab before a comment").len(), 1);
        assert_eq!(
            map("a: {}\nb: []\nc:\n  d: {}\ne: [{}]").get("e"),
            Some(&Value::Array(vec![Value::Mapping(Mapping::new())]))
        );
    }
}
