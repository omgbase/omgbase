//! Computed intrinsics (§3.3) and their flattening (§2.4).

use std::sync::LazyLock;

use omgbase_format::text::is_js_whitespace;
use omgbase_format::{AttrValue, BlockKind};
use regex::Regex;

use crate::DocBlock;
use crate::row::{Card, FlatRow};
use crate::typed::typed_value;
use crate::value::{Mapping, Value};

/// `(?:^|\s)#([a-zA-Z][\w/-]*)` with JavaScript's `\s` (the `String.prototype.trim`
/// set: Unicode `White_Space` minus U+0085, plus U+FEFF) and ASCII `\w`.
static TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[\t\n\x0B\x0C\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}])#([A-Za-z][A-Za-z0-9_/-]*)",
    )
    .expect("valid")
});

fn find_h1<'a>(blocks: &[DocBlock<'a>]) -> Option<&'a str> {
    for b in blocks {
        if b.kind == BlockKind::Heading && b.attrs.get("level") == Some(&AttrValue::Int(1)) {
            let t = b.text.trim_matches(is_js_whitespace);
            if !t.is_empty() {
                return Some(t);
            }
        }
        if let Some(t) = find_h1(&b.children) {
            return Some(t);
        }
    }
    None
}

fn collect_tags(blocks: &[DocBlock<'_>], tags: &mut Vec<String>) {
    for b in blocks {
        if b.kind != BlockKind::Heading && b.kind != BlockKind::CodeFence {
            for m in TAG.captures_iter(b.raw) {
                let t = &m[1];
                if !tags.iter().any(|seen| seen == t) {
                    tags.push(t.to_owned());
                }
            }
        }
        collect_tags(&b.children, tags);
    }
}

/// §3.3: the Markdown adapter's computed object over the body blocks —
/// `$title` (the first level-1 heading's text in pre-order, when non-empty)
/// and `$tags` (distinct `#tags` over every non-heading, non-code `raw`, in
/// encounter order, when any). Absent keys are simply not present.
#[must_use]
pub fn compute_markdown(blocks: &[DocBlock<'_>]) -> Mapping {
    let mut out = Mapping::new();
    if let Some(title) = find_h1(blocks) {
        out.insert("$title".to_owned(), Value::String(title.to_owned()));
    }
    let mut tags = Vec::new();
    collect_tags(blocks, &mut tags);
    if !tags.is_empty() {
        out.insert(
            "$tags".to_owned(),
            Value::Array(tags.into_iter().map(Value::String).collect()),
        );
    }
    out
}

/// The `$tags` of one raw text (the §3.3 scan on its own; the JavaScript
/// whitespace set gates a tag, so a tag after `(` or `,` does not count).
#[must_use]
pub fn tags_in(raw: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for m in TAG.captures_iter(raw) {
        let t = &m[1];
        if !tags.iter().any(|seen| seen == t) {
            tags.push(t.to_owned());
        }
    }
    tags
}

/// §2.4: an array value emits `card = list` rows per element; anything else
/// one `card = scalar` row. Keys are stored as given, `$` included.
#[must_use]
pub fn flatten_computed(computed: &Mapping) -> Vec<FlatRow> {
    let mut out = Vec::new();
    for (key, value) in computed.iter() {
        match value {
            Value::Array(items) => {
                for (ord, item) in items.iter().enumerate() {
                    out.push(FlatRow {
                        key: key.to_owned(),
                        card: Card::List,
                        ord: u32::try_from(ord).expect("a tag list fits in u32"),
                        typed: typed_value(item),
                    });
                }
            }
            other => out.push(FlatRow {
                key: key.to_owned(),
                card: Card::Scalar,
                ord: 0,
                typed: typed_value(other),
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::parse_markdown;

    fn computed(source: &str) -> Mapping {
        let tree = parse_markdown(source);
        let ids: Vec<String> = (0..DocBlock::count(&tree.children))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(&tree.children, &ids);
        compute_markdown(&blocks)
    }

    fn strs(v: Option<&Value>) -> Vec<String> {
        match v {
            Some(Value::Array(items)) => items
                .iter()
                .map(|i| match i {
                    Value::String(s) => s.clone(),
                    other => panic!("{other:?}"),
                })
                .collect(),
            None => Vec::new(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn title_is_the_first_nonempty_h1_in_preorder() {
        assert_eq!(
            computed("# Title\n\n# Second\n").get("$title"),
            Some(&Value::String("Title".into()))
        );
        assert_eq!(computed("## Not h1\n\ntext\n").get("$title"), None);
        assert_eq!(
            computed("#\n\n# Real\n").get("$title"),
            Some(&Value::String("Real".into()))
        );
        assert_eq!(
            computed("> # Quoted\n").get("$title"),
            Some(&Value::String("Quoted".into()))
        );
        assert_eq!(
            computed("- item\n\n  # Nested\n").get("$title"),
            Some(&Value::String("Nested".into()))
        );
        assert_eq!(
            computed("Setext\n======\n").get("$title"),
            Some(&Value::String("Setext".into()))
        );
        assert_eq!(computed("text\n").get("$title"), None);
        assert!(computed("text\n").is_empty());
    }

    #[test]
    fn tags_scan_raw_skip_headings_and_fences() {
        assert_eq!(
            strs(computed("#start and #two_2 and #a/b-c\n").get("$tags")),
            ["start", "two_2", "a/b-c"]
        );
        assert_eq!(
            strs(computed("# #heading\n\nbody #tag\n").get("$tags")),
            ["tag"]
        );
        assert_eq!(
            strs(computed("```\n#code\n```\n").get("$tags")),
            Vec::<String>::new()
        );
        assert_eq!(
            strs(computed("see `#not`\n").get("$tags")),
            Vec::<String>::new(),
            "a backtick is not whitespace"
        );
        assert_eq!(
            strs(computed("see `x #inl`\n").get("$tags")),
            ["inl"],
            "inline code counts (raw, not masked)"
        );
        assert_eq!(
            strs(computed("<div>\n#html\n</div>\n").get("$tags")),
            ["html"]
        );
        assert_eq!(
            strs(computed("(#paren) x,#comma #ok\n").get("$tags")),
            ["ok"]
        );
        assert_eq!(
            strs(computed("#dup #dup #Dup\n").get("$tags")),
            ["dup", "Dup"]
        );
        assert_eq!(
            strs(computed("#1st #_x\n").get("$tags")),
            Vec::<String>::new()
        );
        assert_eq!(strs(computed("#a#b\n").get("$tags")), ["a"]);
        assert_eq!(
            strs(computed("- #in_list\n- #second\n").get("$tags")),
            ["in_list", "second"]
        );
        assert_eq!(
            strs(computed("x\u{00A0}#nbsp\u{2003}#em\n").get("$tags")),
            ["nbsp", "em"]
        );
        assert_eq!(
            strs(computed("x\u{0085}#nel\n").get("$tags")),
            Vec::<String>::new(),
            "NEL is not JS whitespace"
        );
        assert_eq!(tags_in("#a\n#b"), ["a", "b"]);
    }

    #[test]
    fn flattening() {
        let mut m = Mapping::new();
        m.insert("$title".into(), Value::String("T".into()));
        m.insert(
            "$tags".into(),
            Value::Array(vec![Value::String("a".into()), Value::String("b".into())]),
        );
        let rows = flatten_computed(&m);
        let view: Vec<(&str, Card, u32, Option<&str>)> = rows
            .iter()
            .map(|r| (r.key.as_str(), r.card, r.ord, r.typed.val_text.as_deref()))
            .collect();
        assert_eq!(
            view,
            vec![
                ("$title", Card::Scalar, 0, Some("T")),
                ("$tags", Card::List, 0, Some("a")),
                ("$tags", Card::List, 1, Some("b"))
            ]
        );
    }
}
