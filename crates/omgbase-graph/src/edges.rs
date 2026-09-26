//! Edge extraction (§3.1, extraction `x2`): destination classification, the
//! four block scanners in order with in-block dedup, and the frontmatter
//! relations. Pure: descriptors out; the store resolves them (§3.2).

use std::collections::HashSet;
use std::fmt;
use std::sync::LazyLock;

use omgbase_format::BlockKind;
use omgbase_properties::{DocBlock, Mapping, Value};
use regex::Regex;

use crate::mask::mask_code_bytes;
use crate::nodes::JS_WS;
use crate::uri::normalize_uri;

/// `(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)`.
static MD_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(!?)\[[^\]]*\]\(([^){JS_WS}]+)(?:[{JS_WS}]+"[^"]*")?\)"#
    ))
    .expect("valid")
});
/// `(!?)\[\[([^\]]+)\]\]`.
static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?)\[\[([^\]]+)\]\]").expect("valid"));
/// `<(https?:\/\/[^>]+)>`.
static AUTOLINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<(https?://[^>]+)>").expect("valid"));
/// `\bhttps?:\/\/[^\s)>\]]+` — the reference's `(?<![("[])` lookbehind is
/// the preceding-character check in [`bare_urls`]. `\b` without the `u` flag
/// is the ASCII word boundary.
static BARE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?-u:\b)https?://[^{JS_WS})>\]]+")).expect("valid"));
/// `(?:^|\s)([a-z][a-z0-9_]*)::\s*(\[\[[^\]]+\]\]|\/[^\s]+|https?:\/\/[^\s]+)`
/// with `i`: ASCII letters either case for the key, and the scheme too.
static INLINE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[{JS_WS}])([A-Za-z][A-Za-z0-9_]*)::[{JS_WS}]*(\[\[[^\]]+\]\]|/[^{JS_WS}]+|[Hh][Tt][Tt][Pp][Ss]?://[^{JS_WS}]+)"
    ))
    .expect("valid")
});
/// `^\[\[([^\]]+)\]\]$` (no `m`: the whole string).
static WHOLE_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]]+)\]\]$").expect("valid"));

/// What an edge points at (`edges.dst_kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DstKind {
    Document,
    Block,
    External,
    Collection,
}

impl DstKind {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            DstKind::Document => "document",
            DstKind::Block => "block",
            DstKind::External => "external",
            DstKind::Collection => "collection",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "document" => Some(DstKind::Document),
            "block" => Some(DstKind::Block),
            "external" => Some(DstKind::External),
            "collection" => Some(DstKind::Collection),
            _ => None,
        }
    }
}

impl fmt::Display for DstKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where an edge was authored (`edges.provenance`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provenance {
    Link,
    Frontmatter,
    InlineField,
}

impl Provenance {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Provenance::Link => "link",
            Provenance::Frontmatter => "frontmatter",
            Provenance::InlineField => "inline_field",
        }
    }
}

impl fmt::Display for Provenance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An extracted edge before resolution (§3.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeDescriptor {
    /// `None` for a frontmatter edge.
    pub src_block: Option<String>,
    /// The frontmatter or inline-field key; `None` for a plain link.
    pub src_field: Option<String>,
    /// `references`, `embeds`, or the field key.
    pub predicate: String,
    pub dst_kind: DstKind,
    /// The raw target: a repo path, a wikilink name (alias included) or a
    /// normalized URI; `""` for a pure fragment.
    pub target: String,
    /// The `#heading` or `^ref` fragment, without its marker.
    pub anchor: Option<String>,
    pub provenance: Provenance,
}

/// Which marker split the fragment off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorKind {
    Heading,
    Ref,
}

/// §3.1: split a destination at whichever marker comes first — a `^` before
/// any `#` makes a ref (`a^b#c` → `("a", Some("b#c"), Ref)`), otherwise a `#`
/// makes a heading anchor (`a#b^c` → `("a", Some("b^c"), Heading)`); no
/// marker → `(dest, None, None)`.
#[must_use]
pub fn split_fragment(dest: &str) -> (&str, Option<&str>, Option<AnchorKind>) {
    let hash = dest.find('#');
    let caret = dest.find('^');
    match (caret, hash) {
        (Some(c), None) => (&dest[..c], Some(&dest[c + 1..]), Some(AnchorKind::Ref)),
        (Some(c), Some(h)) if c < h => (&dest[..c], Some(&dest[c + 1..]), Some(AnchorKind::Ref)),
        (_, Some(h)) => (&dest[..h], Some(&dest[h + 1..]), Some(AnchorKind::Heading)),
        (None, None) => (dest, None, None),
    }
}

/// A classified destination (§3.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classified {
    pub dst_kind: DstKind,
    pub target: String,
    pub anchor: Option<String>,
}

/// §3.1: `^https?://` → external with the URI normalized; otherwise the
/// fragment split off, a `^ref` making `dst_kind = block`, else `document`.
#[must_use]
pub fn classify(dest: &str) -> Classified {
    if dest.starts_with("https://") || dest.starts_with("http://") {
        return Classified {
            dst_kind: DstKind::External,
            target: normalize_uri(dest),
            anchor: None,
        };
    }
    let (path, anchor, kind) = split_fragment(dest);
    Classified {
        dst_kind: if kind == Some(AnchorKind::Ref) {
            DstKind::Block
        } else {
            DstKind::Document
        },
        target: path.to_owned(),
        anchor: anchor.map(str::to_owned),
    }
}

/// Bare URLs at an ASCII word boundary not preceded by `(`, `"` or `[`
/// (the reference's lookbehind): `(start, end)` byte ranges. A rejected
/// candidate does not hide a later one starting inside it, as with the
/// reference's `g` scan.
fn bare_urls(scan: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at <= scan.len() {
        let Some(m) = BARE_URL.find_at(scan, at) else {
            break;
        };
        let preceded = scan[..m.start()]
            .chars()
            .next_back()
            .is_some_and(|c| matches!(c, '(' | '"' | '['));
        if preceded {
            at = m.start() + 1;
            continue;
        }
        out.push((m.start(), m.end()));
        at = m.end();
    }
    out
}

/// §3.1 per block: over `mask_code(raw)` (nothing for a `code_fence`), the
/// inline relation fields, Markdown links and images, wikilinks, autolinks
/// and bare URLs, in that order, deduplicated within the block on
/// `(predicate, target, anchor, src_field)` (first wins).
#[must_use]
pub fn extract_block_edges(block_id: &str, kind: BlockKind, raw: &str) -> Vec<EdgeDescriptor> {
    let mut edges: Vec<EdgeDescriptor> = Vec::new();
    if kind == BlockKind::CodeFence {
        return edges;
    }
    let scan = mask_code_bytes(raw);
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |e: EdgeDescriptor| {
        let key = format!(
            "{}|{}|{}|{}",
            e.predicate,
            e.target,
            e.anchor.as_deref().unwrap_or(""),
            e.src_field.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            edges.push(e);
        }
    };
    let link = |predicate: &str, dest: &str| {
        let c = classify(dest);
        EdgeDescriptor {
            src_block: Some(block_id.to_owned()),
            src_field: None,
            predicate: predicate.to_owned(),
            dst_kind: c.dst_kind,
            target: c.target,
            anchor: c.anchor,
            provenance: Provenance::Link,
        }
    };

    // 1. Inline relation fields (their values are not also plain links).
    let mut inline_targets: HashSet<String> = HashSet::new();
    for m in INLINE_FIELD.captures_iter(&scan) {
        let key = m[1].to_ascii_lowercase();
        let raw_target = &m[2];
        inline_targets.insert(raw_target.to_owned());
        let dest = WHOLE_WIKILINK
            .captures(raw_target)
            .map_or(raw_target, |w| w.get(1).expect("group").as_str());
        let c = classify(dest);
        push(EdgeDescriptor {
            src_block: Some(block_id.to_owned()),
            src_field: Some(key.clone()),
            predicate: key,
            dst_kind: c.dst_kind,
            target: c.target,
            anchor: c.anchor,
            provenance: Provenance::InlineField,
        });
    }
    // 2. Markdown links and images.
    for m in MD_LINK.captures_iter(&scan) {
        let dest = &m[2];
        if inline_targets.contains(dest) {
            continue;
        }
        push(link(
            if &m[1] == "!" { "embeds" } else { "references" },
            dest,
        ));
    }
    // 3. Wikilinks.
    for m in WIKILINK.captures_iter(&scan) {
        let inner = &m[2];
        if inline_targets.contains(&format!("[[{inner}]]")) {
            continue;
        }
        push(link(
            if &m[1] == "!" { "embeds" } else { "references" },
            inner,
        ));
    }
    // 4. Autolinks and bare URLs → external.
    let external = |uri: &str| EdgeDescriptor {
        src_block: Some(block_id.to_owned()),
        src_field: None,
        predicate: "references".to_owned(),
        dst_kind: DstKind::External,
        target: normalize_uri(uri),
        anchor: None,
        provenance: Provenance::Link,
    };
    for m in AUTOLINK.captures_iter(&scan) {
        push(external(&m[1]));
    }
    for (start, end) in bare_urls(&scan) {
        push(external(&scan[start..end]));
    }
    edges
}

/// §3.1 frontmatter: for each top-level entry in parser order, over the
/// value or each element of an array value, a string that is exactly
/// `[[…]]` (the inner text) or starts with `/` (as is) is a relation under
/// `predicate = src_field = key` (case preserved). Nested mappings are not
/// walked.
#[must_use]
pub fn extract_frontmatter_edges(fm: &Mapping) -> Vec<EdgeDescriptor> {
    let mut edges = Vec::new();
    let mut consider = |key: &str, value: &Value| {
        let Value::String(s) = value else {
            return;
        };
        let dest = if let Some(w) = WHOLE_WIKILINK.captures(s) {
            w.get(1).expect("group").as_str()
        } else if s.starts_with('/') {
            s.as_str()
        } else {
            return;
        };
        let c = classify(dest);
        edges.push(EdgeDescriptor {
            src_block: None,
            src_field: Some(key.to_owned()),
            predicate: key.to_owned(),
            dst_kind: c.dst_kind,
            target: c.target,
            anchor: c.anchor,
            provenance: Provenance::Frontmatter,
        });
    };
    for (key, value) in fm.iter() {
        match value {
            Value::Array(items) => {
                for v in items {
                    consider(key, v);
                }
            }
            other => consider(key, other),
        }
    }
    edges
}

/// §3.1 extraction order for a document: every block in pre-order (each
/// block's steps 1–4), then the frontmatter entries.
#[must_use]
pub fn extract_doc_edges(
    blocks: &[DocBlock<'_>],
    frontmatter: Option<&Mapping>,
) -> Vec<EdgeDescriptor> {
    fn walk(blocks: &[DocBlock<'_>], out: &mut Vec<EdgeDescriptor>) {
        for b in blocks {
            out.extend(extract_block_edges(b.block_id, b.kind, b.raw));
            walk(&b.children, out);
        }
    }
    let mut out = Vec::new();
    walk(blocks, &mut out);
    if let Some(fm) = frontmatter {
        out.extend(extract_frontmatter_edges(fm));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_properties::parse_frontmatter;

    fn edges(raw: &str) -> Vec<EdgeDescriptor> {
        extract_block_edges("b_0", BlockKind::Paragraph, raw)
    }

    fn brief(e: &EdgeDescriptor) -> (&str, DstKind, &str, Option<&str>, Option<&str>, Provenance) {
        (
            e.predicate.as_str(),
            e.dst_kind,
            e.target.as_str(),
            e.anchor.as_deref(),
            e.src_field.as_deref(),
            e.provenance,
        )
    }

    #[test]
    fn fragments_split_at_the_first_marker() {
        assert_eq!(split_fragment("a"), ("a", None, None));
        assert_eq!(
            split_fragment("a#b"),
            ("a", Some("b"), Some(AnchorKind::Heading))
        );
        assert_eq!(
            split_fragment("a^b"),
            ("a", Some("b"), Some(AnchorKind::Ref))
        );
        assert_eq!(
            split_fragment("a^b#c"),
            ("a", Some("b#c"), Some(AnchorKind::Ref))
        );
        assert_eq!(
            split_fragment("a#b^c"),
            ("a", Some("b^c"), Some(AnchorKind::Heading))
        );
        assert_eq!(
            split_fragment("#H"),
            ("", Some("H"), Some(AnchorKind::Heading))
        );
        assert_eq!(split_fragment("^r"), ("", Some("r"), Some(AnchorKind::Ref)));
        assert_eq!(
            split_fragment("a#"),
            ("a", Some(""), Some(AnchorKind::Heading))
        );
    }

    #[test]
    fn classification() {
        assert_eq!(
            classify("https://A.com/x/#f"),
            Classified {
                dst_kind: DstKind::External,
                target: "https://a.com/x".into(),
                anchor: None
            }
        );
        assert_eq!(
            classify("note^r"),
            Classified {
                dst_kind: DstKind::Block,
                target: "note".into(),
                anchor: Some("r".into())
            }
        );
        assert_eq!(
            classify("./x.md#H"),
            Classified {
                dst_kind: DstKind::Document,
                target: "./x.md".into(),
                anchor: Some("H".into())
            }
        );
        assert_eq!(
            classify("HTTP://x"),
            Classified {
                dst_kind: DstKind::Document,
                target: "HTTP://x".into(),
                anchor: None
            },
            "the external test is case-sensitive"
        );
        assert_eq!(classify("mailto:a@b").dst_kind, DstKind::Document);
    }

    #[test]
    fn markdown_links_and_images() {
        let e = edges("[t](a.md) ![i](img.png \"title\") [u](/root/x.md#H) [v](<sp ace>)");
        assert_eq!(
            e.iter().map(brief).collect::<Vec<_>>(),
            [
                (
                    "references",
                    DstKind::Document,
                    "a.md",
                    None,
                    None,
                    Provenance::Link
                ),
                (
                    "embeds",
                    DstKind::Document,
                    "img.png",
                    None,
                    None,
                    Provenance::Link
                ),
                (
                    "references",
                    DstKind::Document,
                    "/root/x.md",
                    Some("H"),
                    None,
                    Provenance::Link
                ),
            ]
        );
        assert_eq!(e[0].src_block.as_deref(), Some("b_0"));
        let e = edges("[t](https://a.com/) [t](https://a.com)");
        assert_eq!(e.len(), 1, "same normalized URI dedups");
        assert_eq!(e[0].target, "https://a.com");
    }

    #[test]
    fn wikilinks() {
        let e = edges("[[note]] ![[img.png]] [[note|Alias]] [[a#H]] [[b^r]] [[note]]");
        assert_eq!(
            e.iter().map(brief).collect::<Vec<_>>(),
            [
                (
                    "references",
                    DstKind::Document,
                    "note",
                    None,
                    None,
                    Provenance::Link
                ),
                (
                    "embeds",
                    DstKind::Document,
                    "img.png",
                    None,
                    None,
                    Provenance::Link
                ),
                (
                    "references",
                    DstKind::Document,
                    "note|Alias",
                    None,
                    None,
                    Provenance::Link
                ),
                (
                    "references",
                    DstKind::Document,
                    "a",
                    Some("H"),
                    None,
                    Provenance::Link
                ),
                (
                    "references",
                    DstKind::Block,
                    "b",
                    Some("r"),
                    None,
                    Provenance::Link
                ),
            ]
        );
    }

    #[test]
    fn autolinks_and_bare_urls() {
        let e = edges("<https://a.com/x> and https://b.com/y. see https://a.com/x");
        assert_eq!(
            e.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(),
            ["https://a.com/x", "https://b.com/y."]
        );
        // Preceded by `(`, `"` or `[`: the link scanners own those.
        assert!(edges("(https://a.com)").is_empty());
        assert!(edges("\"https://a.com\"").is_empty());
        assert!(edges("[https://a.com").is_empty());
        assert_eq!(edges("xhttps://a.com").len(), 0, "word boundary");
        assert_eq!(edges("=https://a.com").len(), 1);
        // A rejected candidate does not hide a URL starting inside it.
        let e = edges("(https://a.com/?u=https://b.com)");
        assert_eq!(
            e.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(),
            ["https://b.com"]
        );
        // Trailing `)`, `>`, `]` and whitespace end a bare URL.
        let e = edges("see https://a.com/x) https://b.com/y] https://c.com/z>");
        assert_eq!(
            e.iter().map(|e| e.target.as_str()).collect::<Vec<_>>(),
            ["https://a.com/x", "https://b.com/y", "https://c.com/z"]
        );
        // JavaScript whitespace, not Unicode White_Space: U+0085 continues a URL.
        assert_eq!(
            edges("https://a.com/x\u{85}y")[0].target,
            "https://a.com/x%C2%85y"
        );
        assert_eq!(edges("https://a.com/x\u{A0}y")[0].target, "https://a.com/x");
        // A markdown link's URL is not also a bare URL.
        assert_eq!(edges("[t](https://a.com)").len(), 1);
    }

    #[test]
    fn inline_relation_fields() {
        let e = edges(
            "rel:: [[note]]\nOwner:: /people/a.md\nsee:: https://a.com/\nplain:: text\nx rel2:: [[n#H]]",
        );
        assert_eq!(
            e.iter().map(brief).collect::<Vec<_>>(),
            [
                (
                    "rel",
                    DstKind::Document,
                    "note",
                    None,
                    Some("rel"),
                    Provenance::InlineField
                ),
                (
                    "owner",
                    DstKind::Document,
                    "/people/a.md",
                    None,
                    Some("owner"),
                    Provenance::InlineField
                ),
                (
                    "see",
                    DstKind::External,
                    "https://a.com",
                    None,
                    Some("see"),
                    Provenance::InlineField
                ),
                (
                    "rel2",
                    DstKind::Document,
                    "n",
                    Some("H"),
                    Some("rel2"),
                    Provenance::InlineField
                ),
                // The remembered raw value only guards the link and wikilink
                // scanners (as the reference): a URL value is also a bare URL.
                (
                    "references",
                    DstKind::External,
                    "https://a.com",
                    None,
                    None,
                    Provenance::Link
                ),
            ]
        );
        // The remembered value is not also a plain link.
        assert_eq!(edges("rel:: [[note]]").len(), 1);
        assert_eq!(edges("rel:: [[note]] and [[note]]").len(), 1);
        assert_eq!(edges("rel:: [[note]] and [[other]]").len(), 2);
        assert_eq!(edges("rel:: /x.md and [t](/x.md)").len(), 1);
        let e = edges("see:: https://a.com/x");
        assert_eq!(e.len(), 2);
        assert_eq!(e[1].predicate, "references");
        // Scheme case-insensitive in the field, case-sensitive in classification.
        let e = edges("k:: HTTPS://a.com");
        assert_eq!(
            (e[0].dst_kind, e[0].target.as_str()),
            (DstKind::Document, "HTTPS://a.com")
        );
        // Not at a whitespace/start boundary: no field.
        assert!(
            edges("x-rel:: [[n]]")
                .iter()
                .all(|e| e.provenance == Provenance::Link)
        );
        assert!(edges("1rel:: /x").is_empty());
    }

    #[test]
    fn in_block_dedup_and_code() {
        assert_eq!(edges("[a](x) [b](x) [[x]]").len(), 1);
        assert_eq!(edges("[a](x) ![b](x)").len(), 2, "different predicates");
        assert_eq!(edges("[a](x#H) [b](x)").len(), 2, "different anchors");
        assert!(extract_block_edges("b_0", BlockKind::CodeFence, "[t](x)").is_empty());
        assert!(edges("`[t](x)` and ``https://a.com``").is_empty());
        assert_eq!(edges("`x` [t](y)")[0].target, "y");
    }

    #[test]
    fn frontmatter_relations() {
        let fm = parse_frontmatter(
            "Rel: \"[[note]]\"\nowner: /people/a.md\nrels: [\"[[a]]\", /b.md, plain, 3]\nnot: ./x.md\nnested:\n  k: /y.md\nn: 1\nwl: [[x]]\n",
        )
        .unwrap();
        let e = extract_frontmatter_edges(&fm);
        assert_eq!(
            e.iter().map(brief).collect::<Vec<_>>(),
            [
                (
                    "Rel",
                    DstKind::Document,
                    "note",
                    None,
                    Some("Rel"),
                    Provenance::Frontmatter
                ),
                (
                    "owner",
                    DstKind::Document,
                    "/people/a.md",
                    None,
                    Some("owner"),
                    Provenance::Frontmatter
                ),
                (
                    "rels",
                    DstKind::Document,
                    "a",
                    None,
                    Some("rels"),
                    Provenance::Frontmatter
                ),
                (
                    "rels",
                    DstKind::Document,
                    "/b.md",
                    None,
                    Some("rels"),
                    Provenance::Frontmatter
                ),
            ]
        );
        assert!(e.iter().all(|e| e.src_block.is_none()));
        let fm = parse_frontmatter("k: \"[[a#H]]\"\nu: /x^r\n").unwrap();
        let e = extract_frontmatter_edges(&fm);
        assert_eq!(
            brief(&e[0]),
            (
                "k",
                DstKind::Document,
                "a",
                Some("H"),
                Some("k"),
                Provenance::Frontmatter
            )
        );
        assert_eq!(
            brief(&e[1]),
            (
                "u",
                DstKind::Block,
                "/x",
                Some("r"),
                Some("u"),
                Provenance::Frontmatter
            )
        );
        assert!(extract_frontmatter_edges(&Mapping::new()).is_empty());
    }

    #[test]
    fn document_order_is_blocks_then_frontmatter() {
        use omgbase_format::parse_markdown;
        let tree = parse_markdown("---\nrel: /r.md\n---\n\n- [a](x)\n\n[b](y)\n");
        let (fm, body) = (&tree.children[0], &tree.children[1..]);
        let ids: Vec<String> = (0..DocBlock::count(body))
            .map(|i| format!("b_{i}"))
            .collect();
        let blocks = DocBlock::from_blocks(body, &ids);
        let mapping = parse_frontmatter(omgbase_properties::frontmatter_yaml(&fm.raw)).unwrap();
        let e = extract_doc_edges(&blocks, Some(&mapping));
        let v: Vec<(Option<&str>, &str)> = e
            .iter()
            .map(|e| (e.src_block.as_deref(), e.target.as_str()))
            .collect();
        assert_eq!(
            v,
            [
                (Some("b_0"), "x"),
                (Some("b_1"), "x"),
                (Some("b_2"), "y"),
                (None, "/r.md")
            ]
        );
    }
}
