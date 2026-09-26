//! # omgbase-properties
//!
//! The omgbase document properties, Rust implementation: the typed, indexed
//! rows a Markdown document yields from its YAML frontmatter, its inline
//! `key:: value` fields and the engine-computed `$`-intrinsics, plus the two
//! read shapes built from them. The contract is `spec/properties/README.md`
//! in the omgbase repository, with the executable fixtures under
//! `spec/properties/cases`; [`SPEC_VERSION`] is the spec version this crate
//! conforms to. A pure library: a block tree with ids in, rows out;
//! `omgbase-store` writes them inside its commit transaction (§6).
//!
//! ```
//! use omgbase_format::{BlockKind, parse_markdown};
//! use omgbase_properties::{Card, DocBlock, Source, ValueType, doc_properties, grouped, merged};
//!
//! let tree = parse_markdown("---\nlayer: canon\ntags: [a, b]\n---\n\n# Title\n\nelement:: fire #x\n");
//! let (frontmatter, body) = match tree.children.first() {
//!     Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
//!     _ => (None, &tree.children[..]),
//! };
//! let ids: Vec<String> = (0..DocBlock::count(body)).map(|i| format!("b_{i}")).collect();
//! let blocks = DocBlock::from_blocks(body, &ids);
//!
//! let rows = doc_properties("d_0", frontmatter, &blocks);
//! let element = rows.iter().find(|r| r.key == "element").unwrap();
//! assert_eq!(element.source, Source::Inline);
//! assert_eq!(element.block_id.as_deref(), Some("b_1"));
//! assert_eq!(element.card, Card::Scalar);
//! assert_eq!(element.ty, ValueType::String);
//! assert_eq!(element.val_text.as_deref(), Some("fire #x"));
//! assert_eq!(element.prop_id.len(), 14);
//!
//! assert_eq!(grouped(&rows)["frontmatter"]["tags"], serde_json::json!(["a", "b"]));
//! assert_eq!(merged(&rows)["$title"], "Title");
//! assert_eq!(merged(&rows)["$tags"], serde_json::json!(["x"]));
//! ```

#![forbid(unsafe_code)]

pub mod computed;
pub mod frontmatter;
pub mod inline;
pub mod row;
pub mod shapes;
pub mod typed;
pub mod value;
pub mod yaml;

use std::collections::HashMap;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::{Attrs, Block, BlockKind};

pub use computed::{compute_markdown, flatten_computed};
pub use frontmatter::{flatten_frontmatter, frontmatter_rows, frontmatter_yaml};
pub use inline::{
    Occurrence, inline_occurrences, inline_rows, js_number, mask_code, typed_inline_value,
};
pub use row::{Card, FlatRow, PropertyRow, Source, Typed, ValueType};
pub use shapes::{decode, grouped, merged, shape};
pub use typed::{Bound, Range, detect_range, typed_value};
pub use value::{Mapping, Value, js_number_string, number_json};
pub use yaml::{parse_document, parse_frontmatter, resolve_plain};

/// The `spec/properties/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "1.0";

/// A body block with its id: the crate's input (§1). Borrowed from whatever
/// the caller holds — a parsed `spec/format` tree with ids assigned, or a
/// store's own block rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocBlock<'a> {
    pub block_id: &'a str,
    pub kind: BlockKind,
    /// The block's source bytes (`spec/format` §1).
    pub raw: &'a str,
    /// The block's visible text (`spec/format` §4.1).
    pub text: &'a str,
    /// Typed attributes (`attrs.level` for headings).
    pub attrs: &'a Attrs,
    pub children: Vec<DocBlock<'a>>,
}

impl<'a> DocBlock<'a> {
    /// How many blocks `blocks` and their descendants are — the number of
    /// ids [`DocBlock::from_blocks`] consumes.
    #[must_use]
    pub fn count(blocks: &[Block]) -> usize {
        blocks.iter().map(|b| 1 + Self::count(&b.children)).sum()
    }

    /// Zip pre-order `ids` onto a parsed body tree (`b_0`, `b_1`, … in a
    /// fixture; a store's assigned ids).
    ///
    /// # Panics
    ///
    /// When `ids` has fewer entries than [`DocBlock::count`] reports.
    #[must_use]
    pub fn from_blocks(blocks: &'a [Block], ids: &'a [String]) -> Vec<DocBlock<'a>> {
        fn walk<'a>(blocks: &'a [Block], ids: &'a [String], next: &mut usize) -> Vec<DocBlock<'a>> {
            blocks
                .iter()
                .map(|b| {
                    let id = ids.get(*next).unwrap_or_else(|| {
                        panic!(
                            "DocBlock::from_blocks: {} ids for a tree of more blocks",
                            ids.len()
                        )
                    });
                    *next += 1;
                    DocBlock {
                        block_id: id.as_str(),
                        kind: b.kind,
                        raw: b.raw.as_str(),
                        text: b.text.as_str(),
                        attrs: &b.attrs,
                        children: walk(&b.children, ids, next),
                    }
                })
                .collect()
        }
        walk(blocks, ids, &mut 0)
    }
}

/// §1: `"p_"` + the first 12 hex characters of
/// `sha256(doc_id + "|" + source + "|" + key + "|" + ord)`.
#[must_use]
pub fn prop_id(doc_id: &str, source: Source, key: &str, ord: u32) -> String {
    let digest = sha256(format!("{doc_id}|{source}|{key}|{ord}").as_bytes());
    format!("p_{}", &hex(&digest)[..12])
}

fn attribute(doc_id: &str, source: Source, block_id: Option<&str>, flat: FlatRow) -> PropertyRow {
    PropertyRow {
        prop_id: prop_id(doc_id, source, &flat.key, flat.ord),
        block_id: block_id.map(str::to_owned),
        source,
        key: flat.key,
        card: flat.card,
        ord: flat.ord,
        ty: flat.typed.ty,
        val_text: flat.typed.val_text,
        val_num: flat.typed.val_num,
        val_bool: flat.typed.val_bool,
        val_json: flat.typed.val_json,
    }
}

/// The document's property rows (§1) in the reference's write order —
/// inline (occurrence order), then frontmatter, then computed — **with**
/// `prop_id` collisions already resolved last-wins (§1, §6: the store's
/// `INSERT OR REPLACE`), so every `prop_id` is unique.
///
/// `frontmatter` is the tree's leading `frontmatter` block, if any (§3.1);
/// `body` the remaining blocks with their ids.
#[must_use]
pub fn doc_properties(
    doc_id: &str,
    frontmatter: Option<&Block>,
    body: &[DocBlock<'_>],
) -> Vec<PropertyRow> {
    let mut rows: Vec<PropertyRow> = Vec::new();
    for (block_id, flat) in inline_rows(&inline_occurrences(body)) {
        rows.push(attribute(doc_id, Source::Inline, Some(&block_id), flat));
    }
    if let Some(fm) = frontmatter.filter(|b| b.kind == BlockKind::Frontmatter) {
        for flat in frontmatter_rows(&fm.raw) {
            rows.push(attribute(doc_id, Source::Frontmatter, None, flat));
        }
    }
    for flat in flatten_computed(&compute_markdown(body)) {
        rows.push(attribute(doc_id, Source::Computed, None, flat));
    }
    dedupe_last_wins(rows)
}

/// §1 collision rule: of several rows with one `prop_id`, the last written
/// survives.
fn dedupe_last_wins(rows: Vec<PropertyRow>) -> Vec<PropertyRow> {
    let mut out: Vec<PropertyRow> = Vec::with_capacity(rows.len());
    let mut at: HashMap<String, usize> = HashMap::new();
    for row in rows {
        match at.get(&row.prop_id) {
            Some(&i) => out[i] = row,
            None => {
                at.insert(row.prop_id.clone(), out.len());
                out.push(row);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::parse_markdown;
    use serde_json::json;

    #[test]
    fn spec_version_matches_the_crate_line() {
        let crate_version = env!("CARGO_PKG_VERSION");
        assert!(
            crate_version.starts_with(&format!("{SPEC_VERSION}.")),
            "crate {crate_version} must track spec {SPEC_VERSION}.x"
        );
    }

    fn rows_of(source: &str) -> Vec<PropertyRow> {
        let tree = parse_markdown(source);
        let (fm, body) = match tree.children.first() {
            Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
            _ => (None, &tree.children[..]),
        };
        let ids: Vec<String> = (0..DocBlock::count(body))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(body, &ids);
        doc_properties("d_0", fm, &blocks)
    }

    fn find<'a>(rows: &'a [PropertyRow], source: Source, key: &str) -> Vec<&'a PropertyRow> {
        rows.iter()
            .filter(|r| r.source == source && r.key == key)
            .collect()
    }

    #[test]
    fn prop_id_is_the_sha256_prefix() {
        let id = prop_id("d_0", Source::Inline, "element", 0);
        assert_eq!(id.len(), 14);
        assert!(id.starts_with("p_"));
        assert!(id[2..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            id,
            format!("p_{}", &hex(&sha256(b"d_0|inline|element|0"))[..12])
        );
        assert_ne!(id, prop_id("d_0", Source::Inline, "element", 1));
        assert_ne!(id, prop_id("d_0", Source::Frontmatter, "element", 0));
    }

    #[test]
    fn readme_example_yields_three_rows() {
        let rows = rows_of("---\nlayer: canon\n---\n\n# Title\n\nelement:: fire\n");
        assert_eq!(rows.len(), 3);
        let layer = &find(&rows, Source::Frontmatter, "layer")[0];
        assert_eq!(
            (layer.card, layer.ord, layer.ty),
            (Card::Scalar, 0, ValueType::String)
        );
        assert_eq!(layer.val_text.as_deref(), Some("canon"));
        assert_eq!(layer.block_id, None);
        let element = &find(&rows, Source::Inline, "element")[0];
        assert_eq!(element.block_id.as_deref(), Some("b_1"));
        assert_eq!(element.val_text.as_deref(), Some("fire"));
        let title = &find(&rows, Source::Computed, "$title")[0];
        assert_eq!(title.val_text.as_deref(), Some("Title"));
        assert_eq!(
            grouped(&rows),
            json!({"frontmatter": {"layer": "canon"}, "inline": {"element": "fire"}, "computed": {"$title": "Title"}})
        );
        assert_eq!(
            merged(&rows),
            json!({"layer": "canon", "element": "fire", "$title": "Title"})
        );
    }

    #[test]
    fn ports_of_the_reference_unit_tests() {
        // frontmatter scalar + list with card
        let rows = rows_of("---\nlayer: canon\ntags: [a, b]\n---\n\n# H\n");
        assert_eq!(
            find(&rows, Source::Frontmatter, "layer")[0].card,
            Card::Scalar
        );
        let tags = find(&rows, Source::Frontmatter, "tags");
        assert_eq!(
            tags.iter()
                .map(|r| (r.card, r.ord, r.val_text.as_deref().unwrap()))
                .collect::<Vec<_>>(),
            [(Card::List, 0, "a"), (Card::List, 1, "b")]
        );
        // a lone inline field is scalar
        let rows = rows_of("# H\n\nelement:: fire\n");
        let el = find(&rows, Source::Inline, "element");
        assert_eq!(
            el.iter().map(|r| (r.card, r.ord)).collect::<Vec<_>>(),
            [(Card::Scalar, 0)]
        );
        // repeated inline fields accumulate as list rows in order
        let rows = rows_of("# H\n\njob:: janitor\n\njob:: salesman\n");
        let job = find(&rows, Source::Inline, "job");
        assert_eq!(
            job.iter()
                .map(|r| (
                    r.card,
                    r.ord,
                    r.val_text.as_deref().unwrap(),
                    r.block_id.as_deref().unwrap()
                ))
                .collect::<Vec<_>>(),
            [
                (Card::List, 0, "janitor", "b_1"),
                (Card::List, 1, "salesman", "b_2")
            ]
        );
        // multi-word value whole
        let rows = rows_of("# H\n\nknown_for:: tria prima\n");
        assert_eq!(
            find(&rows, Source::Inline, "known_for")[0]
                .val_text
                .as_deref(),
            Some("tria prima")
        );
        // bracketed values up to the closer
        let rows =
            rows_of("# H\n\nSee [element:: quick silver] in the text (state:: liquid metal).\n");
        assert_eq!(
            find(&rows, Source::Inline, "element")[0]
                .val_text
                .as_deref(),
            Some("quick silver")
        );
        assert_eq!(
            find(&rows, Source::Inline, "state")[0].val_text.as_deref(),
            Some("liquid metal")
        );
        // numeric coercion
        let rows = rows_of("# H\n\npriority:: 3\n");
        let p = find(&rows, Source::Inline, "priority")[0];
        assert_eq!((p.ty, p.val_num), (ValueType::Number, Some(3.0)));
        // ranges in frontmatter
        let rows = rows_of(
            "---\nwindow: 2026-01-01..2026-01-31\nqty: 1..5\nversion: alpha..omega\n---\n\n# H\n",
        );
        let win = find(&rows, Source::Frontmatter, "window")[0];
        assert_eq!(
            (win.card, win.ty, win.val_text.as_deref()),
            (
                Card::Scalar,
                ValueType::String,
                Some("2026-01-01..2026-01-31")
            )
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(win.val_json.as_deref().unwrap()).unwrap(),
            json!({"__range": true, "lo": "2026-01-01", "hi": "2026-01-31", "exclusiveEnd": false})
        );
        let qty = find(&rows, Source::Frontmatter, "qty")[0];
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(qty.val_json.as_deref().unwrap()).unwrap(),
            json!({"__range": true, "lo": 1, "hi": 5, "exclusiveEnd": false})
        );
        assert_eq!(
            find(&rows, Source::Frontmatter, "version")[0].val_json,
            None
        );
    }

    #[test]
    fn frontmatter_only_from_the_block() {
        // Invalid closing fence: no frontmatter block, so no frontmatter rows.
        let rows = rows_of("---\nfoo: 1\n---bar\n");
        assert!(find(&rows, Source::Frontmatter, "foo").is_empty());
        // A later `---` fence is a thematic break, not frontmatter.
        let rows = rows_of("# H\n\n---\nfoo: 1\n---\n");
        assert!(rows.iter().all(|r| r.source != Source::Frontmatter));
    }

    #[test]
    fn collisions_resolve_last_wins() {
        let rows = rows_of("---\nmeta.owner: a\nmeta:\n  owner: b\n---\n");
        let owner = find(&rows, Source::Frontmatter, "meta.owner");
        assert_eq!(owner.len(), 1);
        assert_eq!(owner[0].val_text.as_deref(), Some("b"));
        let mut ids: Vec<&str> = rows.iter().map(|r| r.prop_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), rows.len());
    }

    #[test]
    fn write_order_is_inline_frontmatter_computed() {
        let rows = rows_of("---\na: 1\n---\n\n# T\n\nk:: v #tag\n");
        let order: Vec<Source> = rows.iter().map(|r| r.source).collect();
        assert_eq!(
            order,
            [
                Source::Inline,
                Source::Frontmatter,
                Source::Computed,
                Source::Computed
            ]
        );
    }

    #[test]
    fn non_finite_frontmatter_numbers() {
        let rows = rows_of("---\na: .inf\nb: -.inf\nc: .nan\n---\n");
        let get = |k: &str| find(&rows, Source::Frontmatter, k)[0].val_num.unwrap();
        assert_eq!(get("a"), f64::INFINITY);
        assert_eq!(get("b"), f64::NEG_INFINITY);
        assert!(get("c").is_nan());
        assert!(rows.iter().all(|r| r.ty == ValueType::Number));
        assert_eq!(
            merged(&rows),
            json!({"a": "Infinity", "b": "-Infinity", "c": null})
        );
    }

    #[test]
    fn doc_block_from_blocks_is_preorder() {
        let tree = parse_markdown("- a\n  - b\n- c\n\npara\n");
        let n = DocBlock::count(&tree.children);
        let ids: Vec<String> = (0..n).map(|i| format!("b_{i}")).collect();
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        fn flat<'a>(b: &[DocBlock<'a>], out: &mut Vec<(&'a str, BlockKind)>) {
            for x in b {
                out.push((x.block_id, x.kind));
                flat(&x.children, out);
            }
        }
        let mut out = Vec::new();
        flat(&blocks, &mut out);
        assert_eq!(out.len(), n);
        assert_eq!(out[0], ("b_0", BlockKind::List));
        assert_eq!(out[1], ("b_1", BlockKind::ListItem));
        assert_eq!(
            out.last().unwrap(),
            &(format!("b_{}", n - 1).leak() as &str, BlockKind::Paragraph)
        );
    }
}
