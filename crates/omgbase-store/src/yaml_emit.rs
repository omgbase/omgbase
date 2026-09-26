//! A YAML emitter matching the `yaml` npm package's `stringify` defaults for
//! the frontmatter `docs_create`/`docs_set_meta` compose (`spec/mutate` §6,
//! §10 "the YAML emitter"): two-space indent, block sequences (indented
//! under their key), plain scalars where legal — quoted when the text would
//! resolve as another type, is empty, starts with an indicator, or contains
//! `: `, ` #`, a trailing space/colon — `null` as `null`. Fixtures pin flat
//! mappings of strings, numbers, booleans and string lists; nested mappings
//! and multi-line strings follow the same rules on a best-effort basis
//! (long-line folding is not implemented).

use std::sync::LazyLock;

use omgbase_properties::{Value as YamlValue, js_number_string, resolve_plain};
use regex::Regex;
use serde_json::{Map, Value};

/// The `yaml` package's plain-scalar exclusions: an empty string, `-`/`?`
/// alone or followed by a blank, a leading indicator, `\n `/`: `, ` \n`, a
/// `#` after a blank, or a trailing blank/colon.
static NOT_PLAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#,
    )
    .expect("regex")
});
static TRAILING_BLANK_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n[\t ]+$").expect("regex"));
static DOCUMENT_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(%|---|\.\.\.)").expect("regex"));

/// Whether `s` may be written as a plain scalar.
fn plain_ok(s: &str, implicit_key: bool) -> bool {
    if s.is_empty() || NOT_PLAIN.is_match(s) || DOCUMENT_MARKER.is_match(s) {
        return false;
    }
    if implicit_key && s.contains('\n') {
        return false;
    }
    // A plain scalar must read back as a string (core schema).
    matches!(resolve_plain(s), YamlValue::String(_))
}

/// `quotedString`: double quotes unless the text has `"` and no `'`.
fn quoted(s: &str) -> String {
    let has_double = s.contains('"');
    let has_single = s.contains('\'');
    if has_double && !has_single {
        format!("'{}'", s.replace('\'', "''"))
    } else {
        serde_json::to_string(s).expect("strings serialize")
    }
}

/// A multi-line string as a literal block scalar (`|`, `|-`, `|+`).
fn block_scalar(s: &str, indent: &str) -> String {
    let trimmed = s.trim_end_matches('\n');
    let trailing = s.len() - trimmed.len();
    let chomp = match trailing {
        0 => "-",
        1 => "",
        _ => "+",
    };
    let header = if s.starts_with(' ') || s.starts_with('\n') {
        format!("|2{chomp}")
    } else {
        format!("|{chomp}")
    };
    let body: Vec<String> = trimmed
        .split('\n')
        .map(|ln| {
            if ln.is_empty() {
                String::new()
            } else {
                format!("{indent}{ln}")
            }
        })
        .collect();
    let mut out = format!("{header}\n{}", body.join("\n"));
    for _ in 1..trailing {
        out.push('\n');
    }
    out
}

fn scalar(v: &Value, indent: &str) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => {
            if s.contains('\n') {
                // `blockString` falls back to quoting for whitespace-only text or a
                // final line of blanks; otherwise a multi-line string is a block
                // scalar (the `yaml` package's implicit-type path).
                if s.trim().is_empty() || TRAILING_BLANK_LINE.is_match(s) {
                    quoted(s)
                } else {
                    block_scalar(s, indent)
                }
            } else if plain_ok(s, false) {
                s.clone()
            } else {
                quoted(s)
            }
        }
        Value::Array(_) | Value::Object(_) => unreachable!("collections are emitted structurally"),
    }
}

fn key(k: &str) -> String {
    if plain_ok(k, true) {
        k.to_owned()
    } else {
        quoted(k)
    }
}

/// Emit `value` at `indent` as the value of a mapping key or sequence item
/// whose line prefix has already been written; returns the text after the
/// prefix (starting on the same line or, for collections, after `\n`).
fn value_after_prefix(v: &Value, indent: usize) -> String {
    match v {
        Value::Object(m) if m.is_empty() => " {}".to_owned(),
        Value::Array(a) if a.is_empty() => " []".to_owned(),
        Value::Object(m) => format!("\n{}", mapping(m, indent)),
        Value::Array(a) => format!("\n{}", sequence(a, indent)),
        other => format!(" {}", scalar(other, &" ".repeat(indent))),
    }
}

fn mapping(m: &Map<String, Value>, indent: usize) -> String {
    let pad = " ".repeat(indent);
    m.iter()
        .map(|(k, v)| format!("{pad}{}:{}", key(k), value_after_prefix(v, indent + 2)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn sequence(items: &[Value], indent: usize) -> String {
    let pad = " ".repeat(indent);
    items
        .iter()
        .map(|item| match item {
            Value::Object(m) if !m.is_empty() => {
                // The first entry shares the `- ` line; the rest indent under it.
                let inner = mapping(m, indent + 2);
                format!("{pad}- {}", inner.trim_start())
            }
            other => format!("{pad}-{}", value_after_prefix(other, indent + 2)),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `stringify(mapping)` with a trailing newline, as the `yaml` package
/// returns it (the compose step strips the final `\n`).
#[must_use]
pub fn stringify(m: &Map<String, Value>) -> String {
    if m.is_empty() {
        return "{}\n".to_owned();
    }
    format!("{}\n", mapping(m, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn emit(v: Value) -> String {
        stringify(v.as_object().unwrap())
    }

    #[test]
    fn flat_mappings_match_the_yaml_package() {
        assert_eq!(
            emit(json!({ "title": "Hi", "count": 2, "draft": true, "tags": ["a", "b"] })),
            "title: Hi\ncount: 2\ndraft: true\ntags:\n  - a\n  - b\n"
        );
        assert_eq!(
            emit(json!({ "n": null, "f": 1.5, "e": [], "o": {} })),
            "n: null\nf: 1.5\ne: []\no: {}\n"
        );
        assert_eq!(emit(json!({})), "{}\n");
    }

    #[test]
    fn strings_quote_when_they_would_read_back_differently() {
        assert_eq!(emit(json!({ "a": "123" })), "a: \"123\"\n");
        assert_eq!(emit(json!({ "a": "true" })), "a: \"true\"\n");
        assert_eq!(emit(json!({ "a": "null" })), "a: \"null\"\n");
        assert_eq!(emit(json!({ "a": "" })), "a: \"\"\n");
        assert_eq!(emit(json!({ "a": "x: y" })), "a: \"x: y\"\n");
        assert_eq!(emit(json!({ "a": "# c" })), "a: \"# c\"\n");
        assert_eq!(emit(json!({ "a": "x #c" })), "a: \"x #c\"\n");
        assert_eq!(emit(json!({ "a": "- x" })), "a: \"- x\"\n");
        assert_eq!(emit(json!({ "a": "trailing " })), "a: \"trailing \"\n");
        assert_eq!(emit(json!({ "a": "say \"hi\"" })), "a: say \"hi\"\n");
        assert_eq!(emit(json!({ "a": "\"x\": y" })), "a: '\"x\": y'\n");
        assert_eq!(emit(json!({ "a": "it's" })), "a: it's\n");
        assert_eq!(emit(json!({ "a": "x:y" })), "a: x:y\n");
        assert_eq!(emit(json!({ "a": "1.0.0" })), "a: 1.0.0\n");
        assert_eq!(emit(json!({ "a": "2026-09-26" })), "a: 2026-09-26\n");
        assert_eq!(emit(json!({ "a": "/people/x.md" })), "a: /people/x.md\n");
        assert_eq!(emit(json!({ "a": "[[n]]" })), "a: \"[[n]]\"\n");
    }

    #[test]
    fn nested_collections_and_block_scalars() {
        assert_eq!(
            emit(json!({ "o": { "a": 1, "b": ["x"] }, "s": [{ "k": "v", "w": 2 }, "z"] })),
            "o:\n  a: 1\n  b:\n    - x\ns:\n  - k: v\n    w: 2\n  - z\n"
        );
        assert_eq!(emit(json!({ "t": "l1\nl2" })), "t: |-\n  l1\n  l2\n");
        assert_eq!(emit(json!({ "t": "l1\nl2\n" })), "t: |\n  l1\n  l2\n");
        assert_eq!(
            emit(json!({ "a b": 1, "1": 2, "x\ny": 3 })),
            "a b: 1\n\"1\": 2\n\"x\\ny\": 3\n"
        );
    }
}
