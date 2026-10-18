//! §3.4 (1.2): a `yaml` or `json` document's **whole top-level mapping** is
//! its frontmatter. The rows are `source = frontmatter`, `block_id = null`,
//! flattened by §2.3 exactly as a Markdown fence's mapping is — the same
//! source, because it is the same thing: the document's authored mapping.
//! A YAML or JSON document has no inline rows (no `key:: value` syntax) and
//! no computed rows (nothing is derived from a mapping; its `title`/`tags`
//! are authored keys like any other).
//!
//! - **YAML**: the file is a stream; the mapping is its FIRST document,
//!   parsed per §4 (core schema, anchors resolve, merge keys do not). A later
//!   document is ignored. A syntax error, a duplicate key, tab indentation, a
//!   root that is not a mapping (a sequence, a scalar, an empty or
//!   comment-only file) → `None`: no rows. An error is a failed parse, never
//!   a recovered mapping (§8).
//! - **JSON**: the whole file is one JSON text; the mapping is its root
//!   object. A non-object root, a parse error (a trailing comma, a comment, a
//!   BOM) or an empty file → `None`. Numbers map as §2.1 maps the YAML
//!   parser's (`1.0` is 1; integers beyond 2⁵³ round to the nearest double);
//!   a repeated key keeps the LAST value at the FIRST position, as the
//!   reference host's object does (§8).

use omgbase_format::{Block, FORMAT_JSON, FORMAT_MARKDOWN, FORMAT_YAML};
use serde_json::Value as Json;

use crate::frontmatter::flatten_frontmatter;
use crate::row::{PropertyRow, Source};
use crate::value::{Mapping, Value};
use crate::yaml::parse_first_document;
use crate::{DocBlock, attribute, doc_properties};

/// §3.4: the document's authored mapping for a `yaml` or `json` `format`;
/// `None` for any failure, for a non-mapping root, and for `markdown`
/// (whose mapping is its `frontmatter` block's, §3.1 — not this function's).
#[must_use]
pub fn document_mapping(format: &str, source: &str) -> Option<Mapping> {
    match format {
        FORMAT_YAML => match parse_first_document(source)? {
            Value::Mapping(m) => Some(m),
            _ => None,
        },
        FORMAT_JSON => json_mapping(source),
        _ => None,
    }
}

/// The root object of a strict JSON text as a [`Mapping`].
fn json_mapping(source: &str) -> Option<Mapping> {
    let parsed: Json = serde_json::from_str(source).ok()?;
    match from_json(&parsed) {
        Value::Mapping(m) => Some(m),
        _ => None,
    }
}

/// `serde_json::Value` → the resolved [`Value`]: every number an IEEE double
/// (`as_f64`, which rounds an integer beyond 2⁵³ as the host does); object
/// keys in document order (`preserve_order`), a repeated key already folded
/// to its last value at its first position by the parser's map.
fn from_json(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Array(items.iter().map(from_json).collect()),
        Json::Object(m) => {
            let mut out = Mapping::new();
            for (k, v) in m {
                out.insert(k.clone(), from_json(v));
            }
            Value::Mapping(out)
        }
    }
}

/// The document's property rows for any `format` (§1): a Markdown document's
/// three sources ([`doc_properties`] over its `frontmatter` block and body);
/// a `yaml`/`json` document's whole-document mapping as `frontmatter` rows
/// and nothing else (§3.4). `source` is the document's bytes — what the
/// whole-document mapping is read from; the Markdown path does not read it.
#[must_use]
pub fn document_properties(
    doc_id: &str,
    format: &str,
    source: &str,
    frontmatter: Option<&Block>,
    body: &[DocBlock<'_>],
) -> Vec<PropertyRow> {
    if format == FORMAT_MARKDOWN || !matches!(format, FORMAT_YAML | FORMAT_JSON) {
        return doc_properties(doc_id, frontmatter, body);
    }
    document_mapping(format, source)
        .map(|m| {
            flatten_frontmatter(&m)
                .into_iter()
                .map(|flat| attribute(doc_id, Source::Frontmatter, None, flat))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{Card, ValueType};

    fn keys(rows: &[PropertyRow]) -> Vec<(&str, Source, Card, u32)> {
        rows.iter()
            .map(|r| (r.key.as_str(), r.source, r.card, r.ord))
            .collect()
    }

    #[test]
    fn yaml_whole_document_is_frontmatter_rows_only() {
        let src = "focused_intent: /notes/x.md\nsince: 2026-10-17\ntitle: Focus\ntags: [a, b]\nmeta:\n  owner: bb\n";
        let rows = document_properties("d_0", "yaml", src, None, &[]);
        assert_eq!(
            keys(&rows),
            vec![
                ("focused_intent", Source::Frontmatter, Card::Scalar, 0),
                ("since", Source::Frontmatter, Card::Scalar, 0),
                ("title", Source::Frontmatter, Card::Scalar, 0),
                ("tags", Source::Frontmatter, Card::List, 0),
                ("tags", Source::Frontmatter, Card::List, 1),
                ("meta.owner", Source::Frontmatter, Card::Scalar, 0),
            ]
        );
        assert!(rows.iter().all(|r| r.block_id.is_none()));
        assert!(rows.iter().all(|r| r.source != Source::Computed));
        assert_eq!(rows[1].ty, ValueType::String);
        assert_eq!(rows[1].val_text.as_deref(), Some("2026-10-17"));
    }

    #[test]
    fn yaml_stream_takes_the_first_document_only() {
        let m = document_mapping("yaml", "a: 1\n---\nb: 2\n---\nc: 3\n").unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("a"), Some(&Value::Number(1.0)));
        let m = document_mapping("yaml", "---\na: 1\n...\n").unwrap();
        assert_eq!(m.get("a"), Some(&Value::Number(1.0)));
    }

    #[test]
    fn yaml_failures_and_non_mappings_have_no_rows() {
        for src in [
            "- a\n- b\n",
            "just a string\n",
            "a: [1, 2\nb: 3\n",
            "a: 1\na: 2\n",
            "",
            "# nothing here\n",
            "a:\n\tb: 1\n",
        ] {
            assert!(document_mapping("yaml", src).is_none(), "{src:?}");
            assert!(
                document_properties("d_0", "yaml", src, None, &[]).is_empty(),
                "{src:?}"
            );
        }
    }

    #[test]
    fn json_root_object_maps_as_the_yaml_parser_would() {
        let src = "{\"title\": \"J\", \"k\": 1.0, \"neg\": -2.5e3, \"big\": 9007199254740993, \"flag\": false, \"nothing\": null, \"tags\": [\"a\"], \"meta\": {\"owner\": \"x\"}}";
        let m = document_mapping("json", src).unwrap();
        assert_eq!(m.get("k"), Some(&Value::Number(1.0)));
        assert_eq!(m.get("neg"), Some(&Value::Number(-2500.0)));
        assert_eq!(m.get("big"), Some(&Value::Number(9_007_199_254_740_992.0)));
        assert_eq!(m.get("flag"), Some(&Value::Bool(false)));
        assert_eq!(m.get("nothing"), Some(&Value::Null));
        let rows = document_properties("d_0", "json", src, None, &[]);
        let k = rows.iter().find(|r| r.key == "k").unwrap();
        assert_eq!((k.ty, k.val_num), (ValueType::Number, Some(1.0)));
        assert!(rows.iter().any(|r| r.key == "meta.owner"));
        assert!(rows.iter().all(|r| r.source == Source::Frontmatter));
    }

    #[test]
    fn json_repeated_key_keeps_the_last_value_first() {
        let m = document_mapping("json", "{\"a\": 1, \"b\": 2, \"a\": 3}").unwrap();
        assert_eq!(
            m.entries,
            vec![
                ("a".to_owned(), Value::Number(3.0)),
                ("b".to_owned(), Value::Number(2.0)),
            ]
        );
    }

    #[test]
    fn json_failures_and_non_objects_have_no_rows() {
        for src in [
            "[1, 2]\n",
            "\"x\"\n",
            "{\"a\": 1,}\n",
            "",
            "\u{feff}{\"a\": 1}",
            "{// c\n\"a\": 1}",
        ] {
            assert!(document_mapping("json", src).is_none(), "{src:?}");
        }
        assert!(document_mapping("markdown", "a: 1\n").is_none());
    }
}
