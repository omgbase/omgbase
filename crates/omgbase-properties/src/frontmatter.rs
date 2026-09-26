//! Frontmatter (§3.1) and its flattening (§2.3).

use crate::row::{Card, FlatRow};
use crate::typed::typed_value;
use crate::value::{Mapping, Value};
use crate::yaml::parse_frontmatter;

/// Everything after the first line ending.
fn drop_first_line(s: &str) -> &str {
    match s.find(['\r', '\n']) {
        Some(i) => {
            let rest = &s[i + 1..];
            if s.as_bytes()[i] == b'\r' {
                rest.strip_prefix('\n').unwrap_or(rest)
            } else {
                rest
            }
        }
        None => "",
    }
}

/// Everything before the last line ending.
fn drop_last_line(s: &str) -> &str {
    match s.rfind(['\r', '\n']) {
        Some(i) => s[..i].strip_suffix('\r').unwrap_or(&s[..i]),
        None => "",
    }
}

/// §3.1: the YAML text of a `frontmatter` block's `raw` — the first line
/// (the opening `---`) and the last line (the closing `---`) removed.
#[must_use]
pub fn frontmatter_yaml(raw: &str) -> &str {
    drop_last_line(drop_first_line(raw))
}

fn walk(value: &Value, key: &str, out: &mut Vec<FlatRow>) {
    match value {
        Value::Mapping(m) => {
            for (k, v) in m.iter() {
                let child = if key.is_empty() {
                    k.to_owned()
                } else {
                    format!("{key}.{k}")
                };
                walk(v, &child, out);
            }
        }
        Value::Array(items) => {
            if items.iter().all(Value::is_scalar) {
                for (ord, item) in items.iter().enumerate() {
                    out.push(FlatRow {
                        key: key.to_owned(),
                        card: Card::List,
                        ord: u32::try_from(ord).expect("a YAML list fits in u32"),
                        typed: typed_value(item),
                    });
                }
            } else {
                out.push(FlatRow {
                    key: key.to_owned(),
                    card: Card::List,
                    ord: 0,
                    typed: typed_value(value),
                });
            }
        }
        scalar => out.push(FlatRow {
            key: key.to_owned(),
            card: Card::Scalar,
            ord: 0,
            typed: typed_value(scalar),
        }),
    }
}

/// §2.3: flatten a parsed frontmatter mapping into rows, in parser order.
#[must_use]
pub fn flatten_frontmatter(mapping: &Mapping) -> Vec<FlatRow> {
    let mut out = Vec::new();
    for (k, v) in mapping.iter() {
        walk(v, k, &mut out);
    }
    out
}

/// §3.1 end to end: a `frontmatter` block's `raw` to rows; empty when the
/// YAML fails or is not a mapping.
#[must_use]
pub fn frontmatter_rows(raw: &str) -> Vec<FlatRow> {
    parse_frontmatter(frontmatter_yaml(raw))
        .map(|m| flatten_frontmatter(&m))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{Typed, ValueType};

    fn rows(yaml: &str) -> Vec<(String, Card, u32, Typed)> {
        flatten_frontmatter(&parse_frontmatter(yaml).expect("mapping"))
            .into_iter()
            .map(|r| (r.key, r.card, r.ord, r.typed))
            .collect()
    }

    #[test]
    fn yaml_text_drops_both_fences() {
        assert_eq!(frontmatter_yaml("---\na: 1\nb: two\n---"), "a: 1\nb: two");
        assert_eq!(frontmatter_yaml("---\r\na: 1\r\n---"), "a: 1");
        assert_eq!(frontmatter_yaml("---\n---"), "");
        assert_eq!(frontmatter_yaml("---\n\n---"), "");
        assert_eq!(frontmatter_yaml("---\na: 1\n---   "), "a: 1");
    }

    #[test]
    fn scalars_are_one_typed_scalar_row() {
        assert_eq!(
            rows("layer: canon\npriority: 3\ndone: true"),
            vec![
                ("layer".into(), Card::Scalar, 0, Typed::string("canon")),
                ("priority".into(), Card::Scalar, 0, Typed::number(3.0)),
                ("done".into(), Card::Scalar, 0, Typed::bool(true)),
            ]
        );
    }

    #[test]
    fn scalar_arrays_are_ord_indexed_list_rows() {
        let r = rows("tags: [a, b, c]");
        assert_eq!(
            r.iter()
                .map(|(k, c, o, t)| (k.as_str(), *c, *o, t.val_text.clone().unwrap()))
                .collect::<Vec<_>>(),
            vec![
                ("tags", Card::List, 0, "a".to_owned()),
                ("tags", Card::List, 1, "b".to_owned()),
                ("tags", Card::List, 2, "c".to_owned())
            ]
        );
        let r = rows("g: [a, ~, 1, true]");
        assert_eq!(r[1].3, Typed::null());
        assert_eq!(r[2].3, Typed::number(1.0));
        assert_eq!(r[3].3, Typed::bool(true));
    }

    #[test]
    fn nested_maps_are_dotted() {
        let r = rows("meta:\n  owner: alice\n  team: x\n  deep: {k: 1}");
        assert_eq!(
            r.iter().map(|(k, ..)| k.as_str()).collect::<Vec<_>>(),
            ["meta.owner", "meta.team", "meta.deep.k"]
        );
    }

    #[test]
    fn arrays_of_collections_are_one_json_row() {
        let r = rows("items: [{a: 1}, {b: 2}]");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].1, Card::List);
        assert_eq!(r[0].2, 0);
        assert_eq!(r[0].3.ty, ValueType::Json);
        assert_eq!(r[0].3.val_json.as_deref(), Some(r#"[{"a":1},{"b":2}]"#));
        let r = rows("f: [[1]]\ne: [{}]");
        assert_eq!(r[0].3.val_json.as_deref(), Some("[[1]]"));
        assert_eq!(r[1].3.val_json.as_deref(), Some("[{}]"));
    }

    #[test]
    fn empty_containers_vanish() {
        assert!(rows("a: {}\nb: []\nc:\n  d: {}").is_empty());
        assert_eq!(rows("a: {}\nz: 1").len(), 1);
    }

    #[test]
    fn frontmatter_rows_end_to_end() {
        let r = frontmatter_rows("---\nwindow: 1..5\n---");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].typed.val_text.as_deref(), Some("1..5"));
        assert!(r[0].typed.val_json.is_some());
        assert!(frontmatter_rows("---\nnot: [valid\n---").is_empty());
        assert!(frontmatter_rows("---\n- a\n---").is_empty());
        assert!(frontmatter_rows("---\n---").is_empty());
        assert!(frontmatter_rows("---\njust text\n---").is_empty());
    }
}
