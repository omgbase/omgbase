//! Rendering (`spec/mutate/README.md` §3): the document by splice — leading
//! trivia, the frontmatter, then every top-level block and its trivia — where
//! a block with no dirty descendant emits its raw verbatim and a container
//! with one is rebuilt from its children by type.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::tree::{MutBlock, MutDoc};

/// §3 `render(doc)`.
#[must_use]
pub fn render(doc: &MutDoc) -> String {
    let mut out = String::new();
    out.push_str(&doc.leading_trivia);
    if let Some(fm) = &doc.frontmatter_raw {
        out.push_str(fm);
    }
    for b in &doc.children {
        out.push_str(&render_block(b, 0));
        out.push_str(&b.trivia);
    }
    out
}

/// §3 `render_block(b, depth)`: a leaf or a clean subtree emits its raw;
/// otherwise the container is rebuilt by type.
#[must_use]
pub fn render_block(b: &MutBlock, depth: usize) -> String {
    if b.children.is_empty() || !b.has_dirty_descendant() {
        return b.raw.clone();
    }
    match b.kind.as_str() {
        "list" => render_list(b),
        "blockquote" => render_blockquote(b, depth),
        "table" => render_table(b, depth),
        _ => {
            let indent = "  ".repeat(depth);
            b.children
                .iter()
                .map(|c| {
                    let inner = render_block(c, depth + 1).replace('\n', &format!("\n{indent}"));
                    format!("{indent}{inner}")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

fn render_blockquote(bq: &MutBlock, depth: usize) -> String {
    let body = bq
        .children
        .iter()
        .map(|c| render_block(c, depth + 1))
        .collect::<Vec<_>>()
        .join("\n\n");
    body.split('\n')
        .map(|ln| {
            if ln.is_empty() {
                ">".to_owned()
            } else {
                format!("> {ln}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

static DELIMITER_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$").expect("valid regex")
});

/// §3: the raw's second line when it is a table delimiter row.
fn table_delimiter(raw: &str) -> Option<&str> {
    let mut lines = raw.split('\n');
    lines.next()?;
    let second = lines.next()?;
    DELIMITER_ROW.is_match(second).then_some(second)
}

fn render_table(t: &MutBlock, depth: usize) -> String {
    let mut rows: Vec<String> = t
        .children
        .iter()
        .map(|c| render_block(c, depth + 1))
        .collect();
    if let Some(delim) = table_delimiter(&t.raw) {
        if !rows.is_empty() {
            rows.insert(1, delim.to_owned());
        }
    }
    rows.join("\n")
}

/// §3 list rule: items re-marked and joined by the list's own separator.
fn render_list(list: &MutBlock) -> String {
    let ordered = list.attrs.get("ordered").is_some_and(truthy);
    let start = list.attrs.get("start").and_then(Value::as_i64).unwrap_or(1);
    let sep = if list.raw.contains("\n\n") {
        "\n\n"
    } else {
        "\n"
    };
    list.children
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let marker = if ordered {
                format!("{}. ", start + i as i64)
            } else {
                "- ".to_owned()
            };
            render_item(item, &marker)
        })
        .collect::<Vec<_>>()
        .join(sep)
}

/// JavaScript `Boolean(v)` for a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// §3 `render_item`: a rebuilt body when a child changed, else the raw with
/// its marker stripped; then the marker applied.
fn render_item(item: &MutBlock, marker: &str) -> String {
    if item.children.iter().any(MutBlock::has_dirty_descendant) {
        let body = item
            .children
            .iter()
            .map(|c| {
                if c.kind == "list" {
                    render_list(c)
                } else {
                    render_block(c, 0)
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        return apply_marker(&body, marker);
    }
    apply_marker(&strip_marker(&item.raw), marker)
}

static MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)([-*+]|[0-9]+[.)])(\s+)").expect("valid regex"));

/// Remove the leading marker (and its indentation) from the first line, and
/// the same width from continuation lines whose prefix of that width is blank.
#[must_use]
pub fn strip_marker(raw: &str) -> String {
    let lines: Vec<&str> = raw.split('\n').collect();
    let Some(m) = MARKER_RE.find(lines.first().copied().unwrap_or("")) else {
        return raw.to_owned();
    };
    let width = m.end();
    lines
        .iter()
        .enumerate()
        .map(|(i, ln)| {
            if i == 0 || slice_to(ln, width).trim().is_empty() {
                slice_from(ln, width)
            } else {
                (*ln).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `s[width..]` in characters, clamped (JavaScript `slice(width)` on a
/// string whose marker match is ASCII, so bytes and chars agree there).
fn slice_from(s: &str, width: usize) -> String {
    s.chars().skip(width).collect()
}

fn slice_to(s: &str, width: usize) -> String {
    s.chars().take(width).collect()
}

/// Prefix the first line with `marker`; indent every non-empty later line by
/// the marker's width.
#[must_use]
pub fn apply_marker(body: &str, marker: &str) -> String {
    let pad = " ".repeat(marker.chars().count());
    body.split('\n')
        .enumerate()
        .map(|(i, ln)| {
            if i == 0 {
                format!("{marker}{ln}")
            } else if ln.is_empty() {
                String::new()
            } else {
                format!("{pad}{ln}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, raw: &str) -> MutBlock {
        MutBlock::new(id, "list_item", raw, "")
    }

    fn list(raw: &str, items: Vec<MutBlock>, ordered: bool, start: Option<i64>) -> MutBlock {
        let mut l = MutBlock::new("l", "list", raw, "\n");
        if ordered {
            l.attrs.insert("ordered".into(), json!(true));
        }
        if let Some(s) = start {
            l.attrs.insert("start".into(), json!(s));
        }
        l.children = items;
        l
    }

    #[test]
    fn clean_blocks_render_their_raw_verbatim() {
        let l = list(
            "- a\n- b",
            vec![item("a", "- a"), item("b", "- b")],
            false,
            None,
        );
        let doc = MutDoc::new("d", "a.md", vec![l]);
        assert_eq!(render(&doc), "- a\n- b\n");
    }

    #[test]
    fn dirty_list_renumbers_with_tight_or_loose_separator() {
        let mut l = list(
            "1. a\n2. b",
            vec![item("b", "2. b"), item("a", "1. a")],
            true,
            None,
        );
        l.dirty = true;
        assert_eq!(render_block(&l, 0), "1. b\n2. a");
        let mut loose = list(
            "3) a\n\n4) b",
            vec![item("a", "3) a"), item("b", "4) b"), item("c", "c")],
            true,
            Some(3),
        );
        loose.dirty = true;
        assert_eq!(render_block(&loose, 0), "3. a\n\n4. b\n\n5. c");
        let mut bullets = list("* a", vec![item("a", "* a\n  cont")], false, None);
        bullets.dirty = true;
        assert_eq!(render_block(&bullets, 0), "- a\n  cont");
    }

    #[test]
    fn item_with_dirty_child_is_rebuilt_from_children() {
        let mut inner = MutBlock::new("p", "paragraph", "edited", "");
        inner.dirty = true;
        let mut sub = list("- x", vec![item("x", "- x")], false, None);
        sub.dirty = false;
        let mut it = item("a", "- old\n  - x");
        it.children = vec![inner, sub];
        let mut l = list("- old\n  - x", vec![it], false, None);
        l.dirty = false;
        assert_eq!(render_block(&l, 0), "- edited\n  - x");
    }

    #[test]
    fn blockquote_rebuild_prefixes_every_line() {
        let mut bq = MutBlock::new("q", "blockquote", "> a\n>\n> b", "\n");
        let mut b = MutBlock::new("b", "paragraph", "b edited\nmore", "");
        b.dirty = true;
        bq.children = vec![MutBlock::new("a", "paragraph", "a", ""), b];
        assert_eq!(render_block(&bq, 0), "> a\n>\n> b edited\n> more");
    }

    #[test]
    fn table_rebuild_reinserts_the_delimiter_row() {
        let mut t = MutBlock::new("t", "table", "| a | b |\n|:--|--:|\n| 1 | 2 |", "\n");
        let mut row = MutBlock::new("r2", "table_row", "| 1 | 20 |", "");
        row.dirty = true;
        t.children = vec![MutBlock::new("r1", "table_row", "| a | b |", ""), row];
        assert_eq!(render_block(&t, 0), "| a | b |\n|:--|--:|\n| 1 | 20 |");
        assert!(table_delimiter("| a |\n| b |").is_none());
        assert!(table_delimiter("| a |\n| --- | :---: |").is_some());
        assert!(table_delimiter("| a |\n---").is_some());
    }

    #[test]
    fn other_containers_indent_children() {
        let mut it = item("a", "- a");
        let mut p = MutBlock::new("p", "paragraph", "x\ny", "");
        p.dirty = true;
        it.children = vec![p];
        assert_eq!(render_block(&it, 1), "  x\n  y");
    }

    #[test]
    fn marker_helpers() {
        assert_eq!(strip_marker("- a\n  b\n c"), "a\nb\n c");
        assert_eq!(strip_marker("12. a\n    b"), "a\nb");
        assert_eq!(strip_marker("plain"), "plain");
        assert_eq!(apply_marker("a\n\nb", "10. "), "10. a\n\n    b");
    }

    #[test]
    fn frontmatter_and_leading_trivia_are_emitted_first() {
        let mut doc = MutDoc::new(
            "d",
            "a.md",
            vec![MutBlock::new("h", "heading", "# H", "\n")],
        );
        doc.leading_trivia = "\n".into();
        doc.frontmatter_raw = Some("---\na: 1\n---\n\n".into());
        assert_eq!(render(&doc), "\n---\na: 1\n---\n\n# H\n");
    }
}
