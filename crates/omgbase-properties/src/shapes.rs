//! The read shapes (§5): `grouped` (`docs_read.properties`) and `merged`
//! (the query layer's bag).

use serde_json::{Map as JsonMap, Value as Json};

use crate::row::{Card, PropertyRow, Source, ValueType};
use crate::value::number_json;

/// Decode one row to its value: `string` → `val_text`, `number` → `val_num`,
/// `bool` → true/false, `null` → null, `json` → the parsed `val_json`. A
/// range-shaped string decodes as its text. Non-finite numbers cannot be JSON:
/// ±Infinity become the strings `"Infinity"`/`"-Infinity"` (as the fixtures
/// carry them) and NaN — which the store holds as `NULL` — becomes `null`.
#[must_use]
pub fn decode(row: &PropertyRow) -> Json {
    match row.ty {
        ValueType::String => row.val_text.clone().map_or(Json::Null, Json::String),
        ValueType::Number => match row.val_num {
            Some(n) if n.is_nan() => Json::Null,
            Some(n) if n.is_infinite() => {
                Json::String(if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned())
            }
            Some(n) => number_json(n),
            None => Json::Null,
        },
        ValueType::Bool => row.val_bool.map_or(Json::Null, Json::Bool),
        ValueType::Null => Json::Null,
        ValueType::Json => row
            .val_json
            .as_deref()
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or(Json::Null),
    }
}

/// §5 `shape(rows)` for one key: a lone `card = scalar` row decodes to its
/// scalar; otherwise an array in (source rank, ord) order.
#[must_use]
pub fn shape(rows: &[&PropertyRow]) -> Json {
    if let [only] = rows {
        if only.card == Card::Scalar {
            return decode(only);
        }
    }
    let mut ordered: Vec<&PropertyRow> = rows.to_vec();
    ordered.sort_by_key(|r| (r.source.rank(), r.ord));
    Json::Array(ordered.into_iter().map(decode).collect())
}

/// Group by key in first-seen order.
fn by_key<'a>(rows: impl Iterator<Item = &'a PropertyRow>) -> Vec<(&'a str, Vec<&'a PropertyRow>)> {
    let mut groups: Vec<(&str, Vec<&PropertyRow>)> = Vec::new();
    for r in rows {
        match groups.iter_mut().find(|(k, _)| *k == r.key) {
            Some((_, g)) => g.push(r),
            None => groups.push((r.key.as_str(), vec![r])),
        }
    }
    groups
}

fn shaped<'a>(rows: impl Iterator<Item = &'a PropertyRow>) -> Json {
    let mut out = JsonMap::new();
    for (key, group) in by_key(rows) {
        out.insert(key.to_owned(), shape(&group));
    }
    Json::Object(out)
}

/// §5 **grouped**: `{ frontmatter: {key: shape}, inline: {…}, computed: {…} }`,
/// every source present.
#[must_use]
pub fn grouped(rows: &[PropertyRow]) -> Json {
    let mut out = JsonMap::new();
    for source in Source::ALL {
        out.insert(
            source.as_str().to_owned(),
            shaped(rows.iter().filter(|r| r.source == source)),
        );
    }
    Json::Object(out)
}

/// §5 **merged**: `{ key: shape }` over all of the document's rows.
#[must_use]
pub fn merged(rows: &[PropertyRow]) -> Json {
    shaped(rows.iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(source: Source, key: &str, card: Card, ord: u32, ty: ValueType) -> PropertyRow {
        PropertyRow {
            prop_id: format!("p_{source}_{key}_{ord}"),
            block_id: None,
            source,
            key: key.to_owned(),
            card,
            ord,
            ty,
            val_text: None,
            val_num: None,
            val_bool: None,
            val_json: None,
        }
    }

    fn text(source: Source, key: &str, card: Card, ord: u32, s: &str) -> PropertyRow {
        PropertyRow {
            val_text: Some(s.to_owned()),
            ..row(source, key, card, ord, ValueType::String)
        }
    }

    #[test]
    fn lone_scalar_decodes_to_the_scalar_else_an_array() {
        let rows = vec![
            text(Source::Frontmatter, "layer", Card::Scalar, 0, "canon"),
            text(Source::Frontmatter, "one", Card::List, 0, "x"),
            text(Source::Inline, "element", Card::Scalar, 0, "fire"),
            text(Source::Inline, "layer", Card::Scalar, 0, "inline-canon"),
            text(Source::Computed, "$title", Card::Scalar, 0, "Title"),
            PropertyRow {
                val_num: Some(3.0),
                ..row(Source::Frontmatter, "n", Card::Scalar, 0, ValueType::Number)
            },
            PropertyRow {
                val_bool: Some(true),
                ..row(Source::Frontmatter, "b", Card::Scalar, 0, ValueType::Bool)
            },
            row(Source::Frontmatter, "z", Card::Scalar, 0, ValueType::Null),
            PropertyRow {
                val_json: Some(r#"[{"a":1}]"#.to_owned()),
                ..row(Source::Frontmatter, "j", Card::List, 0, ValueType::Json)
            },
            PropertyRow {
                val_text: Some("1..5".to_owned()),
                val_json: Some(r#"{"__range":true}"#.to_owned()),
                ..row(Source::Frontmatter, "w", Card::Scalar, 0, ValueType::String)
            },
        ];
        assert_eq!(
            grouped(&rows),
            json!({
                "frontmatter": {"layer": "canon", "one": ["x"], "n": 3, "b": true, "z": null, "j": [[{"a": 1}]], "w": "1..5"},
                "inline": {"element": "fire", "layer": "inline-canon"},
                "computed": {"$title": "Title"},
            })
        );
        assert_eq!(
            merged(&rows),
            json!({
                "layer": ["canon", "inline-canon"], "one": ["x"], "element": "fire", "$title": "Title",
                "n": 3, "b": true, "z": null, "j": [[{"a": 1}]], "w": "1..5",
            })
        );
        assert_eq!(grouped(&[])["computed"], json!({}));
    }

    #[test]
    fn list_order_is_source_rank_then_ord() {
        let rows = vec![
            text(Source::Inline, "k", Card::List, 1, "i1"),
            text(Source::Computed, "k", Card::Scalar, 0, "c"),
            text(Source::Inline, "k", Card::List, 0, "i0"),
            text(Source::Frontmatter, "k", Card::Scalar, 0, "f"),
        ];
        assert_eq!(merged(&rows)["k"], json!(["f", "i0", "i1", "c"]));
    }

    #[test]
    fn non_finite_numbers() {
        let inf = PropertyRow {
            val_num: Some(f64::INFINITY),
            ..row(Source::Frontmatter, "a", Card::Scalar, 0, ValueType::Number)
        };
        let ninf = PropertyRow {
            val_num: Some(f64::NEG_INFINITY),
            ..row(Source::Frontmatter, "b", Card::Scalar, 0, ValueType::Number)
        };
        let nan = PropertyRow {
            val_num: Some(f64::NAN),
            ..row(Source::Frontmatter, "c", Card::Scalar, 0, ValueType::Number)
        };
        let stored_nan = row(Source::Frontmatter, "d", Card::Scalar, 0, ValueType::Number);
        assert_eq!(
            merged(&[inf, ninf, nan, stored_nan]),
            json!({"a": "Infinity", "b": "-Infinity", "c": null, "d": null})
        );
    }
}
