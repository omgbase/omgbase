//! Link-destination rewriting (`spec/mutate/README.md` §5 `links_repair`,
//! §6 `docs_move` retargeting): the scanners the repair macro uses over a
//! block's raw (`graph/link-destinations.ts`), the destination-aware
//! retarget of the inbound links to a moved document
//! (`graph/inbound-links.ts`), and the inbound-link scan over the open edge
//! index. Kept in the store for now — it reads `blocks`/`edges` — though the
//! pure rewriting could move to `omgbase-graph`.

use std::collections::HashSet;
use std::sync::LazyLock;

use omgbase_format::BlockKind;
use omgbase_graph::{DstKind, extract_block_edges, mask_code_bytes, resolve_relative};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::error::Result;
use crate::read::blob_text;

// ---- destinations (link-destinations.ts) ----------------------------------------------

/// Split an authored destination into its path and its trailing fragment
/// (`#Heading` / `^ref`, marker included); a `^` wins over a `#` when both
/// appear.
#[must_use]
pub fn split_destination(dest: &str) -> (&str, &str) {
    if let Some(c) = dest.find('^') {
        return (&dest[..c], &dest[c..]);
    }
    if let Some(h) = dest.find('#') {
        return (&dest[..h], &dest[h..]);
    }
    (dest, "")
}

/// The canonical repo-relative path of an authored link path in a document
/// under `doc_dir` (`""` or `"a/b/"`): `./`/`../` resolve against the
/// directory; a leading `/` is dropped.
#[must_use]
pub fn canonical_link_path(path: &str, doc_dir: &str) -> String {
    if path.starts_with("./") || path.starts_with("../") {
        return resolve_relative(path, doc_dir);
    }
    path.strip_prefix('/').unwrap_or(path).to_owned()
}

/// The directory prefix (`""` or `"a/b/"`) of a repo-relative doc path.
#[must_use]
pub fn doc_dir_of(doc_path: &str) -> &str {
    match doc_path.rfind('/') {
        Some(i) => &doc_path[..=i],
        None => "",
    }
}

static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))"#).expect("regex"));
static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?\[\[)([^\]|]+)((?:\|[^\]]*)?\]\])").expect("regex"));
static INLINE_FIELD_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)((?:^|\s)[a-z][a-z0-9_]*::[ \t]*)(/[^\s]+)()").expect("regex")
});

/// The CommonMark-ish code spans of the reference's `CODE_SPAN`
/// (`` (`+)[^`][\s\S]*?\1 ``): `(start, end)` byte ranges, non-overlapping,
/// scanned left to right.
fn code_spans(raw: &str) -> Vec<(usize, usize)> {
    let b = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && b[j] == b'`' {
            j += 1;
        }
        let n = j - i;
        // `[^`]` needs one non-backtick character after the opener.
        if j >= b.len() {
            break;
        }
        // The lazy body ends at the first run of `n` backticks after it.
        let mut k = j + 1;
        let mut found = None;
        while k + n <= b.len() {
            if b[k..k + n].iter().all(|&c| c == b'`') {
                found = Some(k);
                break;
            }
            k += 1;
        }
        match found {
            Some(k) => {
                out.push((i, k + n));
                i = k + n;
            }
            None => i += 1,
        }
    }
    out
}

/// Rewrite every link destination in `raw` outside inline code: `replace`
/// sees each destination and returns the new text or `None` to leave it.
pub fn rewrite_link_destinations(
    raw: &str,
    mut replace: impl FnMut(&str) -> Option<String>,
) -> String {
    let mut rewrite_segment = |seg: &str| -> String {
        let sub =
            |re: &Regex, s: &str, replace: &mut dyn FnMut(&str) -> Option<String>| -> String {
                re.replace_all(s, |caps: &regex::Captures<'_>| {
                    let pre = &caps[1];
                    let dest = &caps[2];
                    let post = &caps[3];
                    match replace(dest) {
                        Some(next) => format!("{pre}{next}{post}"),
                        None => caps[0].to_owned(),
                    }
                })
                .into_owned()
            };
        let a = sub(&MD_LINK, seg, &mut replace);
        let b = sub(&WIKILINK, &a, &mut replace);
        sub(&INLINE_FIELD_PATH, &b, &mut replace)
    };
    let mut out = String::new();
    let mut last = 0;
    for (start, end) in code_spans(raw) {
        out.push_str(&rewrite_segment(&raw[last..start]));
        out.push_str(&raw[start..end]);
        last = end;
    }
    out.push_str(&rewrite_segment(&raw[last..]));
    out
}

// ---- retargeting (inbound-links.ts) ----------------------------------------------------

/// Every leading `/` stripped.
fn canonical_all(path: &str) -> &str {
    path.trim_start_matches('/')
}

static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("regex"));

/// Whether a destination written in a doc under `src_dir` resolves to `doc_path`.
#[must_use]
pub fn resolves_to(dest: &str, src_dir: &str, doc_path: &str) -> bool {
    if dest.is_empty() || SCHEME.is_match(dest) {
        return false;
    }
    canonical_all(&resolve_relative(dest, src_dir)) == doc_path
}

/// The relative path from directory `from_dir` (`"a/b/"` or `""`) to `to`.
#[must_use]
pub fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let target: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < from.len() && i < target.len() && from[i] == target[i] {
        i += 1;
    }
    let ups = from.len() - i;
    let rest = target[i..].join("/");
    if ups == 0 {
        format!("./{rest}")
    } else {
        format!("{}{rest}", "../".repeat(ups))
    }
}

fn rewrite_dest(
    dest: &str,
    match_dir: &str,
    write_dir: &str,
    from_path: &str,
    to_path: &str,
) -> Option<String> {
    let hash = dest.find('#');
    let caret = dest.find('^');
    let cut = match (caret, hash) {
        (Some(c), None) => c,
        (Some(c), Some(h)) if c < h => c,
        (_, Some(h)) => h,
        (None, None) => dest.len(),
    };
    let (path_part, fragment) = (&dest[..cut], &dest[cut..]);
    if !resolves_to(path_part, match_dir, from_path) {
        return None;
    }
    let new_path = if path_part.starts_with('/') {
        format!("/{to_path}")
    } else if path_part.starts_with("./") || path_part.starts_with("../") {
        relative_path(write_dir, to_path)
    } else {
        to_path.to_owned()
    };
    Some(format!("{new_path}{fragment}"))
}

static MD_LINK_DEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))"#).expect("regex"));
static WIKILINK_DEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?\[\[)([^\]]+)(\]\])").expect("regex"));
static INLINE_FIELD_DEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)((?:^|\s)[a-z][a-z0-9_]*::\s*)(/[^\s]+)").expect("regex"));

/// §6: rewrite every destination of `raw` that resolves (against
/// `match_dir`) to `from_path` so it names `to_path`, relative forms written
/// against `write_dir`; code is masked. `None` when nothing changed.
#[must_use]
pub fn retarget_links_in_raw(
    raw: &str,
    match_dir: &str,
    write_dir: &str,
    from_path: &str,
    to_path: &str,
) -> Option<String> {
    let masked = mask_code_bytes(raw);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for re in [&*MD_LINK_DEST, &*WIKILINK_DEST, &*INLINE_FIELD_DEST] {
        for caps in re.captures_iter(&masked) {
            let dest = caps.get(2).expect("group 2");
            let Some(replaced) =
                rewrite_dest(dest.as_str(), match_dir, write_dir, from_path, to_path)
            else {
                continue;
            };
            edits.push((dest.start(), dest.end(), replaced));
        }
    }
    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = raw.to_owned();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }
    (out != raw).then_some(out)
}

/// One inbound link to a document, as written (§6 `docs_move`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundLink {
    /// The source document.
    pub doc: String,
    pub path: String,
    /// The source block; `None` for a frontmatter edge.
    pub block: Option<String>,
    /// The destination path as written.
    pub target: String,
    pub anchor: Option<String>,
    /// The frontmatter or inline-field key of a typed edge.
    pub field: Option<String>,
}

impl InboundLink {
    /// `{ doc, path, block, target, anchor, field? }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("doc".to_owned(), json!(self.doc));
        m.insert("path".to_owned(), json!(self.path));
        m.insert("block".to_owned(), json!(self.block));
        m.insert("target".to_owned(), json!(self.target));
        m.insert("anchor".to_owned(), json!(self.anchor));
        if let Some(f) = &self.field {
            m.insert("field".to_owned(), json!(f));
        }
        Value::Object(m)
    }
}

/// Every link in the repo whose destination resolves to `doc_path`, found
/// through the open edges into `doc_id`; block edges are re-scanned from the
/// raw so `target`/`anchor` are as written (a self-doc pure fragment is not
/// reported); frontmatter edges carry `block: None` and `target = doc_path`.
pub fn inbound_links_to(
    conn: &Connection,
    repo_id: &str,
    doc_id: &str,
    doc_path: &str,
) -> Result<Vec<InboundLink>> {
    type Row = (String, String, Option<String>, Option<String>);
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT e.src_doc, d.path, e.src_block, e.src_field
             FROM edges e JOIN docs d ON d.doc_id = e.src_doc
             WHERE e.repo_id = ?1 AND e.dst_node = ?2 AND e.to_commit IS NULL AND d.deleted_commit IS NULL
             ORDER BY d.path, e.src_block",
        )?;
        let it = stmt.query_map(params![repo_id, doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (src_doc, src_path, src_block, src_field) in rows {
        let Some(block_id) = src_block else {
            out.push(InboundLink {
                doc: src_doc,
                path: src_path,
                block: None,
                target: doc_path.to_owned(),
                anchor: None,
                field: src_field.filter(|f| !f.is_empty()),
            });
            continue;
        };
        if !seen.insert(block_id.clone()) {
            continue;
        }
        let blk: Option<(String, Vec<u8>)> = conn
            .query_row(
                "SELECT type, raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![block_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((kind, raw_hash)) = blk else {
            continue;
        };
        let raw = blob_text(conn, &raw_hash)?;
        let kind = kind.parse::<BlockKind>().unwrap_or(BlockKind::Opaque);
        let src_dir = doc_dir_of(&src_path).to_owned();
        for e in extract_block_edges(&block_id, kind, &raw) {
            if e.dst_kind == DstKind::External || !resolves_to(&e.target, &src_dir, doc_path) {
                continue;
            }
            out.push(InboundLink {
                doc: src_doc.clone(),
                path: src_path.clone(),
                block: Some(block_id.clone()),
                target: e.target.clone(),
                anchor: e.anchor.clone(),
                field: e.src_field.clone().filter(|f| !f.is_empty()),
            });
        }
    }
    Ok(out)
}

/// `globClause`: a path glob (`*` → SQL `%`, `%`/`_` escaped) as a `LIKE`
/// clause, or `=` when there is no `*`.
#[must_use]
pub fn glob_clause(column: &str, glob: &str) -> (String, String) {
    if glob.contains('*') {
        let like = glob
            .chars()
            .flat_map(|c| match c {
                '%' | '_' => vec!['\\', c],
                '*' => vec!['%'],
                other => vec![other],
            })
            .collect::<String>();
        (format!("{column} LIKE ? ESCAPE '\\'"), like)
    } else {
        (format!("{column} = ?"), glob.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_split_and_canonicalize() {
        assert_eq!(split_destination("a.md#H"), ("a.md", "#H"));
        assert_eq!(split_destination("a.md^r"), ("a.md", "^r"));
        assert_eq!(split_destination("a.md#H^r"), ("a.md#H", "^r"));
        assert_eq!(split_destination("a.md"), ("a.md", ""));
        assert_eq!(canonical_link_path("/a.md", "x/"), "a.md");
        assert_eq!(canonical_link_path("./a.md", "x/"), "x/a.md");
        assert_eq!(canonical_link_path("../a.md", "x/y/"), "x/a.md");
        assert_eq!(doc_dir_of("a/b/c.md"), "a/b/");
        assert_eq!(doc_dir_of("c.md"), "");
    }

    #[test]
    fn code_spans_follow_the_reference_regex() {
        assert_eq!(code_spans("a `b` c"), vec![(2, 5)]);
        assert_eq!(code_spans("``a`` and `x`"), vec![(0, 5), (10, 13)]);
        // The closing run only needs to contain n backticks.
        assert_eq!(code_spans("`a``"), vec![(0, 3)]);
        // An opener with nothing after it never matches; a shorter start does.
        assert_eq!(code_spans("``a`"), vec![(1, 4)]);
        assert_eq!(code_spans("no code"), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn rewrites_destinations_outside_code() {
        let raw = "See [a](/x.md) and [b](/x.md#S) or ![i](/x.md \"t\") and [[x.md|alias]] `[c](/x.md)` key:: /x.md";
        let out = rewrite_link_destinations(raw, |d| {
            let (p, frag) = split_destination(d);
            (p.trim_start_matches('/') == "x.md").then(|| format!("/y.md{frag}"))
        });
        assert_eq!(
            out,
            "See [a](/y.md) and [b](/y.md#S) or ![i](/y.md \"t\") and [[/y.md|alias]] `[c](/x.md)` key:: /y.md"
        );
        assert_eq!(
            rewrite_link_destinations("plain [a](b.md)", |_| None),
            "plain [a](b.md)"
        );
    }

    #[test]
    fn retargets_with_style_preserved() {
        assert_eq!(
            retarget_links_in_raw("[a](/old.md) [b](./old.md#H) [c](old.md) [[old.md]] k:: /old.md `x [d](/old.md)`", "", "", "old.md", "new/n.md"),
            Some("[a](/new/n.md) [b](./new/n.md#H) [c](new/n.md) [[new/n.md]] k:: /new/n.md `x [d](/old.md)`".to_owned())
        );
        assert_eq!(
            retarget_links_in_raw("[a](/other.md)", "", "", "old.md", "n.md"),
            None
        );
        assert_eq!(
            retarget_links_in_raw("[a](../old.md)", "d/", "e/f/", "old.md", "x/new.md"),
            Some("[a](../../x/new.md)".to_owned())
        );
        assert_eq!(relative_path("", "a.md"), "./a.md");
        assert_eq!(relative_path("a/b/", "a/c.md"), "../c.md");
        assert!(resolves_to("/a.md", "", "a.md"));
        assert!(!resolves_to("https://x", "", "a.md"));
        assert!(!resolves_to("", "", "a.md"));
    }

    #[test]
    fn glob_clauses() {
        assert_eq!(
            glob_clause("d.path", "journal/*"),
            (
                "d.path LIKE ? ESCAPE '\\'".to_owned(),
                "journal/%".to_owned()
            )
        );
        assert_eq!(
            glob_clause("d.path", "a_b%*"),
            (
                "d.path LIKE ? ESCAPE '\\'".to_owned(),
                "a\\_b\\%%".to_owned()
            )
        );
        assert_eq!(
            glob_clause("d.path", "a.md"),
            ("d.path = ?".to_owned(), "a.md".to_owned())
        );
    }
}
