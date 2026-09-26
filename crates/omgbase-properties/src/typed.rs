//! Typing a scalar (§2.1) and range-shaped strings (§2.2).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value as Json, json};

use crate::row::Typed;
use crate::value::{Value, number_json};

/// `^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$` with ASCII digits.
static RANGE_NUM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$").expect("valid"));
/// ISO date or datetime, ASCII digits.
static RANGE_ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?$",
    )
    .expect("valid")
});

/// One end of a range (§2.2).
#[derive(Clone, Debug, PartialEq)]
pub enum Bound {
    /// The bound was empty (`..5`, `1..`).
    Open,
    /// A numeric bound.
    Num(f64),
    /// An ISO date/datetime bound, kept as written.
    Iso(String),
}

impl Bound {
    fn to_json(&self) -> Json {
        match self {
            Bound::Open => Json::Null,
            Bound::Num(n) => number_json(*n),
            Bound::Iso(s) => Json::String(s.clone()),
        }
    }
}

/// A range-shaped string's side channel (§2.2).
#[derive(Clone, Debug, PartialEq)]
pub struct Range {
    pub lo: Bound,
    pub hi: Bound,
    /// Three dots.
    pub exclusive_end: bool,
}

impl Range {
    /// `{"__range": true, "lo": …, "hi": …, "exclusiveEnd": …}` in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "__range": true,
            "lo": self.lo.to_json(),
            "hi": self.hi.to_json(),
            "exclusiveEnd": self.exclusive_end,
        })
    }
}

/// JavaScript's `.` (no `s` flag) does not cross these; `^(.*?)(\.\.\.?)(.*)$`
/// fails on a string containing any of them.
fn has_js_line_terminator(s: &str) -> bool {
    s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// §2.2: `^(.*?)(\.\.\.?)(.*)$` with the operator a maximal run of exactly
/// two or three dots, at least one bound, both bounds in one domain.
#[must_use]
pub fn detect_range(s: &str) -> Option<Range> {
    if has_js_line_terminator(s) {
        return None;
    }
    // The lazy left part stops at the first `..`; the operator then takes a
    // third dot greedily.
    let at = s.find("..")?;
    let lo_raw = &s[..at];
    let after = &s[at + 2..];
    let (dots, hi_raw) = if let Some(rest) = after.strip_prefix('.') {
        (3, rest)
    } else {
        (2, after)
    };
    if lo_raw.ends_with('.') || hi_raw.starts_with('.') {
        return None;
    }
    if lo_raw.is_empty() && hi_raw.is_empty() {
        return None;
    }
    let present: Vec<&str> = [lo_raw, hi_raw]
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect();
    let exclusive_end = dots == 3;
    if present.iter().all(|b| RANGE_NUM.is_match(b)) {
        let num = |b: &str| {
            if b.is_empty() {
                Bound::Open
            } else {
                Bound::Num(b.parse::<f64>().expect("RANGE_NUM strings are Rust floats"))
            }
        };
        return Some(Range {
            lo: num(lo_raw),
            hi: num(hi_raw),
            exclusive_end,
        });
    }
    if present.iter().all(|b| RANGE_ISO.is_match(b)) {
        let iso = |b: &str| {
            if b.is_empty() {
                Bound::Open
            } else {
                Bound::Iso(b.to_owned())
            }
        };
        return Some(Range {
            lo: iso(lo_raw),
            hi: iso(hi_raw),
            exclusive_end,
        });
    }
    None
}

/// §2.1: type a value as the YAML parser or the inline coercion produced it.
#[must_use]
pub fn typed_value(v: &Value) -> Typed {
    match v {
        Value::Null => Typed::null(),
        Value::Bool(b) => Typed::bool(*b),
        Value::Number(n) => Typed::number(*n),
        Value::String(s) => match detect_range(s) {
            Some(range) => Typed {
                val_json: Some(range.to_json().to_string()),
                ..Typed::string(s.clone())
            },
            None => Typed::string(s.clone()),
        },
        Value::Array(_) | Value::Mapping(_) => Typed::json(v.to_json().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(s: &str) -> Option<Json> {
        detect_range(s).map(|r| r.to_json())
    }

    #[test]
    fn numeric_ranges() {
        assert_eq!(
            range("1..5"),
            Some(json!({"__range": true, "lo": 1, "hi": 5, "exclusiveEnd": false}))
        );
        assert_eq!(
            range("1...5"),
            Some(json!({"__range": true, "lo": 1, "hi": 5, "exclusiveEnd": true}))
        );
        assert_eq!(
            range("..5"),
            Some(json!({"__range": true, "lo": null, "hi": 5, "exclusiveEnd": false}))
        );
        assert_eq!(
            range("1.."),
            Some(json!({"__range": true, "lo": 1, "hi": null, "exclusiveEnd": false}))
        );
        assert_eq!(
            range("1.5..2.5"),
            Some(json!({"__range": true, "lo": 1.5, "hi": 2.5, "exclusiveEnd": false}))
        );
        assert_eq!(
            range("-5..5"),
            Some(json!({"__range": true, "lo": -5, "hi": 5, "exclusiveEnd": false}))
        );
        assert_eq!(
            range("1e2..1E+3"),
            Some(json!({"__range": true, "lo": 100, "hi": 1000, "exclusiveEnd": false}))
        );
    }

    #[test]
    fn iso_ranges_keep_strings() {
        assert_eq!(
            range("2026-01-01..2026-01-31"),
            Some(
                json!({"__range": true, "lo": "2026-01-01", "hi": "2026-01-31", "exclusiveEnd": false})
            )
        );
        assert_eq!(
            range("2026-01-01...2026-02-01"),
            Some(
                json!({"__range": true, "lo": "2026-01-01", "hi": "2026-02-01", "exclusiveEnd": true})
            )
        );
        assert_eq!(
            range("..2026-01-31"),
            Some(json!({"__range": true, "lo": null, "hi": "2026-01-31", "exclusiveEnd": false}))
        );
        assert!(range("2026-01-01T10:00:00Z..2026-01-01 11:00").is_some());
        assert!(range("2026-01-01T10:00:00.5+01:00..").is_some());
    }

    #[test]
    fn non_ranges() {
        for s in [
            "hello",
            "a..z",
            "1..2026-01-01",
            "1.2.3..4.5.6",
            "../foo",
            "1....5",
            "..",
            "3.14",
            "",
            "1..5\n",
            "1.\u{2028}.5",
            "\u{0661}..5",
            "+1..5",
            "1..5.",
            ".1..5",
        ] {
            assert_eq!(range(s), None, "{s:?}");
        }
    }

    #[test]
    fn typed_values() {
        assert_eq!(typed_value(&Value::Null), Typed::null());
        assert_eq!(typed_value(&Value::Bool(true)), Typed::bool(true));
        assert_eq!(typed_value(&Value::Number(3.0)), Typed::number(3.0));
        assert_eq!(
            typed_value(&Value::String("canon".into())),
            Typed::string("canon")
        );
        let win = typed_value(&Value::String("1..5".into()));
        assert_eq!(win.ty, ValueType::String);
        assert_eq!(win.val_text.as_deref(), Some("1..5"));
        assert_eq!(
            serde_json::from_str::<Json>(win.val_json.as_deref().unwrap()).unwrap(),
            json!({"__range": true, "lo": 1, "hi": 5, "exclusiveEnd": false})
        );
        let arr = typed_value(&Value::Array(vec![
            Value::Mapping(Mapping::from(vec![("a".to_owned(), Value::Number(1.0))])),
            Value::Number(f64::NAN),
        ]));
        assert_eq!(arr.ty, ValueType::Json);
        assert_eq!(arr.val_json.as_deref(), Some(r#"[{"a":1},null]"#));
    }

    use crate::row::ValueType;
    use crate::value::Mapping;
}
