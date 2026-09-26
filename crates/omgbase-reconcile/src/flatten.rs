//! Flattening (`spec/reconcile/README.md` §1.2): a block tree becomes the
//! pre-order list of [`MatchBlock`]s the phases consume, with `text`
//! computed per spec/format §4.1 in tree context (containers compose from
//! their children; nested raws lose up to *blockquote depth* `> ` prefixes)
//! and both hashes.

use omgbase_format::hash::{hex, norm_hash, raw_hash};
use omgbase_format::text::{join_texts, normalize_visible_text, uses_children_text};
use omgbase_format::{Block, BlockKind, BlockTree};

use crate::mint::Minter;
use crate::types::MatchBlock;

/// One input block (§1.1): the fields of a spec/format block the matcher
/// needs. `id` is set on the old side only. Frontmatter is never reconciled
/// and does not appear in a tree given to the matcher.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlatSource {
    pub id: Option<String>,
    pub kind: BlockKind,
    /// The block's source bytes (no trailing line ending).
    pub raw: String,
    /// Authored `^block-ref` anchors; default empty.
    pub anchors: Vec<String>,
    /// Nested blocks (parser nesting only).
    pub children: Vec<FlatSource>,
}

impl FlatSource {
    /// A childless, anchorless block without an id.
    #[must_use]
    pub fn new(kind: BlockKind, raw: &str) -> Self {
        Self {
            id: None,
            kind,
            raw: raw.to_owned(),
            anchors: Vec::new(),
            children: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_id(mut self, id: &str) -> Self {
        self.id = Some(id.to_owned());
        self
    }

    #[must_use]
    pub fn with_anchors(mut self, anchors: &[&str]) -> Self {
        self.anchors = anchors.iter().map(|a| (*a).to_owned()).collect();
        self
    }

    #[must_use]
    pub fn with_children(mut self, children: Vec<FlatSource>) -> Self {
        self.children = children;
        self
    }

    /// The matcher's view of a parsed tree: every top-level block except a
    /// `frontmatter` one, with children, and — when `ids` is given — an id
    /// minted for every block in pre-order (§9: `b_0`, `b_1`, … on the old
    /// side of a `source` fixture). Anchors are left empty: a parsed tree
    /// carries none; a store attaches the ones it extracted.
    #[must_use]
    pub fn from_tree(tree: &BlockTree, ids: Option<&mut dyn Minter>) -> Vec<FlatSource> {
        Self::from_blocks(&tree.children, ids)
    }

    /// [`FlatSource::from_tree`] over a slice of top-level blocks.
    #[must_use]
    pub fn from_blocks(blocks: &[Block], mut ids: Option<&mut dyn Minter>) -> Vec<FlatSource> {
        fn convert(b: &Block, ids: &mut Option<&mut dyn Minter>) -> FlatSource {
            let id = ids.as_mut().map(|m| m.mint());
            FlatSource {
                id,
                kind: b.kind,
                raw: b.raw.clone(),
                anchors: Vec::new(),
                children: b.children.iter().map(|c| convert(c, ids)).collect(),
            }
        }
        blocks
            .iter()
            .filter(|b| b.kind != BlockKind::Frontmatter)
            .map(|b| convert(b, &mut ids))
            .collect()
    }
}

/// Flatten a tree to match blocks in pre-order (a block, then its children,
/// then its next sibling), computing `text`, `raw_hash`, `norm_hash` and the
/// positional keys.
#[must_use]
pub fn flatten(blocks: &[FlatSource]) -> Vec<MatchBlock> {
    let mut out = Vec::new();
    walk(blocks, None, 0, &mut out);
    out
}

/// Append `list` (and descendants) to `out`; return the texts of `list`'s
/// blocks so the caller can compose a container's text from them.
fn walk(
    list: &[FlatSource],
    parent_key: Option<&str>,
    quote_depth: usize,
    out: &mut Vec<MatchBlock>,
) -> Vec<String> {
    let mut texts = Vec::with_capacity(list.len());
    for (index, b) in list.iter().enumerate() {
        let key = MatchBlock::positional_key(parent_key, index);
        let slot = out.len();
        out.push(MatchBlock {
            id: b.id.clone(),
            kind: b.kind.as_str().to_owned(),
            raw_hash: hex(&raw_hash(&b.raw)),
            norm_hash: String::new(),
            text: String::new(),
            anchors: b.anchors.clone(),
            parent_key: parent_key.map(str::to_owned),
            index,
            key: key.clone(),
        });
        let child_depth = quote_depth + usize::from(b.kind == BlockKind::Blockquote);
        let child_texts = if b.children.is_empty() {
            Vec::new()
        } else {
            walk(&b.children, Some(&key), child_depth, out)
        };
        let text = if uses_children_text(b.kind, !b.children.is_empty()) {
            join_texts(child_texts.iter().map(String::as_str))
        } else {
            normalize_visible_text(&b.raw, b.kind, quote_depth)
        };
        out[slot].norm_hash = hex(&norm_hash(&text));
        out[slot].text.clone_from(&text);
        texts.push(text);
    }
    texts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mint::SequentialMinter;
    use omgbase_format::parse_markdown;

    #[test]
    fn preorder_keys_texts_and_hashes() {
        let tree = FlatSource::new(BlockKind::List, "- a\n- b\n  > q\n  > r")
            .with_id("L")
            .with_children(vec![
                FlatSource::new(BlockKind::ListItem, "- a").with_id("A"),
                FlatSource::new(BlockKind::ListItem, "- b\n  > q\n  > r")
                    .with_id("B")
                    .with_children(vec![
                        FlatSource::new(BlockKind::Paragraph, "b").with_id("P"),
                        FlatSource::new(BlockKind::Blockquote, "> q\n  > r")
                            .with_id("Q")
                            .with_children(vec![
                                FlatSource::new(BlockKind::Paragraph, "q\n  > r").with_id("R"),
                            ]),
                    ]),
            ]);
        let flat = flatten(&[tree, FlatSource::new(BlockKind::ThematicBreak, "---")]);
        let keys: Vec<&str> = flat.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(
            keys,
            ["/0", "/0/0", "/0/1", "/0/1/0", "/0/1/1", "/0/1/1/0", "/1"]
        );
        let texts: Vec<&str> = flat.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["a b q r", "a", "b q r", "b", "q r", "q r", ""]);
        assert_eq!(flat[0].id.as_deref(), Some("L"));
        assert_eq!(flat[6].id, None);
        assert_eq!(flat[3].parent_key.as_deref(), Some("/0/1"));
        assert_eq!(flat[3].index, 0);
        assert_eq!(flat[1].kind, "list_item");
        assert_eq!(flat[0].raw_hash, hex(&raw_hash("- a\n- b\n  > q\n  > r")));
        assert_eq!(flat[0].norm_hash, hex(&norm_hash("a b q r")));
        assert_eq!(flat[0].raw_hash.len(), 64);
    }

    #[test]
    fn from_tree_drops_frontmatter_and_mints_preorder_ids() {
        let tree = parse_markdown("---\nt: 1\n---\n\n# H\n\n- a\n- b\n\npara\n");
        let mut ids = SequentialMinter::new("b");
        let src = FlatSource::from_tree(&tree, Some(&mut ids));
        assert_eq!(src.len(), 3);
        assert_eq!(src[0].kind, BlockKind::Heading);
        assert_eq!(src[0].id.as_deref(), Some("b_0"));
        assert_eq!(src[1].id.as_deref(), Some("b_1"));
        assert_eq!(src[1].children[0].id.as_deref(), Some("b_2"));
        assert_eq!(src[1].children[1].id.as_deref(), Some("b_3"));
        assert_eq!(src[2].id.as_deref(), Some("b_4"));
        let flat = flatten(&src);
        assert_eq!(flat[4].text, "para");
        assert_eq!(flat[1].text, "a b");

        let without = FlatSource::from_tree(&tree, None);
        assert!(without.iter().all(|b| b.id.is_none()));
        assert_eq!(flatten(&without).len(), 5);
    }
}
