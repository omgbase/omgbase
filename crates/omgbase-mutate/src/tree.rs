//! The working tree (`spec/mutate/README.md` §1): a document loaded from the
//! store into mutable blocks that carry their id, raw bytes, trailing trivia,
//! attrs, children and a render flag. Blocks are addressed by **path** — the
//! indices from the top level down — because Rust cannot hold a reference to
//! a block while mutating its siblings; `locate` finds the path, the
//! accessors resolve it.

use omgbase_format::hash::{hex, sha256};
use serde_json::{Map, Value};

/// A block of the working tree (§1 `MutBlock`).
#[derive(Clone, Debug, PartialEq)]
pub struct MutBlock {
    pub id: String,
    /// The spec/format §3 kind name (`blocks.type`).
    pub kind: String,
    /// The raw blob's bytes.
    pub raw: String,
    /// The trivia blob's bytes, or `""` when `trivia_hash` was `NULL`.
    pub trivia: String,
    /// The block's attrs as stored (a JSON object).
    pub attrs: Map<String, Value>,
    pub children: Vec<MutBlock>,
    /// The render flag (§3): `false` when loaded; set by the ops whose
    /// children changed.
    pub dirty: bool,
}

impl MutBlock {
    /// A childless, clean block with empty attrs.
    #[must_use]
    pub fn new(id: &str, kind: &str, raw: &str, trivia: &str) -> Self {
        Self {
            id: id.to_owned(),
            kind: kind.to_owned(),
            raw: raw.to_owned(),
            trivia: trivia.to_owned(),
            attrs: Map::new(),
            children: Vec::new(),
            dirty: false,
        }
    }

    /// This block and every descendant, pre-order.
    pub fn iter(&self) -> impl Iterator<Item = &MutBlock> {
        Walk { stack: vec![self] }
    }

    /// Whether this block or any descendant is dirty (§3).
    #[must_use]
    pub fn has_dirty_descendant(&self) -> bool {
        self.dirty || self.children.iter().any(MutBlock::has_dirty_descendant)
    }

    /// Mark this block and its whole subtree clean.
    pub fn mark_subtree_clean(&mut self) {
        self.dirty = false;
        for c in &mut self.children {
            c.mark_subtree_clean();
        }
    }

    /// The ids of this block and every descendant, pre-order.
    #[must_use]
    pub fn subtree_ids(&self) -> Vec<String> {
        self.iter().map(|b| b.id.clone()).collect()
    }
}

struct Walk<'a> {
    stack: Vec<&'a MutBlock>,
}

impl<'a> Iterator for Walk<'a> {
    type Item = &'a MutBlock;

    fn next(&mut self) -> Option<Self::Item> {
        let b = self.stack.pop()?;
        self.stack.extend(b.children.iter().rev());
        Some(b)
    }
}

/// A document in the working tree (§1 `MutDoc`).
#[derive(Clone, Debug, PartialEq)]
pub struct MutDoc {
    pub doc_id: String,
    pub path: String,
    /// `docs.format` (`markdown`).
    pub format: String,
    /// `docs.leading_trivia`.
    pub leading_trivia: String,
    /// The current revision's frontmatter blob + `docs.frontmatter_trivia`,
    /// or `None` when the document has no frontmatter.
    pub frontmatter_raw: Option<String>,
    /// The top-level blocks.
    pub children: Vec<MutBlock>,
}

/// Where a block sits: the indices from the top level down to it. The last
/// element is its index among its siblings; the prefix is its parent's path
/// (empty at the top level).
pub type BlockPath = Vec<usize>;

impl MutDoc {
    /// A document with no frontmatter and the given top-level blocks.
    #[must_use]
    pub fn new(doc_id: &str, path: &str, children: Vec<MutBlock>) -> Self {
        Self {
            doc_id: doc_id.to_owned(),
            path: path.to_owned(),
            format: "markdown".to_owned(),
            leading_trivia: String::new(),
            frontmatter_raw: None,
            children,
        }
    }

    /// Every block at every depth, pre-order.
    pub fn iter(&self) -> impl Iterator<Item = &MutBlock> {
        Walk {
            stack: self.children.iter().rev().collect(),
        }
    }

    /// §1: find a block anywhere in the document; its path.
    #[must_use]
    pub fn locate(&self, block_id: &str) -> Option<BlockPath> {
        fn search(list: &[MutBlock], id: &str, path: &mut BlockPath) -> bool {
            for (i, b) in list.iter().enumerate() {
                path.push(i);
                if b.id == id || search(&b.children, id, path) {
                    return true;
                }
                path.pop();
            }
            false
        }
        let mut path = Vec::new();
        search(&self.children, block_id, &mut path).then_some(path)
    }

    /// Whether `block_id` is anywhere in the document.
    #[must_use]
    pub fn contains(&self, block_id: &str) -> bool {
        self.locate(block_id).is_some()
    }

    /// The sibling list a parent path names (`[]` → the top level).
    #[must_use]
    pub fn siblings(&self, parent: &[usize]) -> &Vec<MutBlock> {
        let mut list = &self.children;
        for &i in parent {
            list = &list[i].children;
        }
        list
    }

    /// Mutable [`MutDoc::siblings`].
    pub fn siblings_mut(&mut self, parent: &[usize]) -> &mut Vec<MutBlock> {
        let mut list = &mut self.children;
        for &i in parent {
            list = &mut list[i].children;
        }
        list
    }

    /// The block at `path`.
    ///
    /// # Panics
    ///
    /// If `path` is empty or does not name a block.
    #[must_use]
    pub fn block(&self, path: &[usize]) -> &MutBlock {
        let (last, parent) = path.split_last().expect("a block path is non-empty");
        &self.siblings(parent)[*last]
    }

    /// Mutable [`MutDoc::block`].
    ///
    /// # Panics
    ///
    /// If `path` is empty or does not name a block.
    pub fn block_mut(&mut self, path: &[usize]) -> &mut MutBlock {
        let (last, parent) = path.split_last().expect("a block path is non-empty");
        &mut self.siblings_mut(parent)[*last]
    }

    /// §1 `owner_of`: the block owning the sibling list at `parent`, or
    /// `None` at the top level.
    #[must_use]
    pub fn owner_of(&self, parent: &[usize]) -> Option<&MutBlock> {
        if parent.is_empty() {
            None
        } else {
            Some(self.block(parent))
        }
    }

    /// §1 `mark_container_dirty`: a structural change to a sibling list
    /// invalidates its owner's raw; the top level needs no marking.
    pub fn mark_container_dirty(&mut self, parent: &[usize]) {
        if !parent.is_empty() {
            self.block_mut(parent).dirty = true;
        }
    }

    /// The ids of every block, pre-order.
    #[must_use]
    pub fn all_ids(&self) -> Vec<String> {
        self.iter().map(|b| b.id.clone()).collect()
    }
}

/// `hex(sha256(raw))`: the content CAS token (§1.2).
#[must_use]
pub fn raw_hash_hex(raw: &str) -> String {
    hex(&sha256(raw.as_bytes()))
}

/// The ordered ids of a sibling list.
#[must_use]
pub fn child_ids(list: &[MutBlock]) -> Vec<String> {
    list.iter().map(|b| b.id.clone()).collect()
}

/// §1.2: `hex(sha256(child ids joined by ","))`.
#[must_use]
pub fn parent_children_hash(list: &[MutBlock]) -> String {
    hex(&sha256(child_ids(list).join(",").as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nested() -> MutDoc {
        let mut list = MutBlock::new("l", "list", "- a\n- b", "\n");
        let mut a = MutBlock::new("a", "list_item", "- a", "");
        a.children.push(MutBlock::new("p", "paragraph", "a", ""));
        list.children.push(a);
        list.children
            .push(MutBlock::new("b", "list_item", "- b", ""));
        MutDoc::new(
            "d_0",
            "a.md",
            vec![MutBlock::new("h", "heading", "# H", "\n\n"), list],
        )
    }

    #[test]
    fn locate_returns_paths_and_accessors_resolve_them() {
        let doc = nested();
        assert_eq!(doc.locate("h"), Some(vec![0]));
        assert_eq!(doc.locate("l"), Some(vec![1]));
        assert_eq!(doc.locate("b"), Some(vec![1, 1]));
        assert_eq!(doc.locate("p"), Some(vec![1, 0, 0]));
        assert_eq!(doc.locate("zz"), None);
        assert_eq!(doc.block(&[1, 0, 0]).raw, "a");
        assert_eq!(doc.siblings(&[1]).len(), 2);
        assert_eq!(doc.owner_of(&[1]).map(|b| b.id.as_str()), Some("l"));
        assert!(doc.owner_of(&[]).is_none());
        assert_eq!(doc.all_ids(), ["h", "l", "a", "p", "b"]);
    }

    #[test]
    fn dirty_marks_propagate_to_ancestors_only_by_query() {
        let mut doc = nested();
        assert!(!doc.block(&[1]).has_dirty_descendant());
        doc.mark_container_dirty(&[1, 0]);
        assert!(doc.block(&[1, 0]).dirty);
        assert!(doc.block(&[1]).has_dirty_descendant());
        assert!(!doc.block(&[1]).dirty);
        doc.mark_container_dirty(&[]);
        doc.block_mut(&[1]).mark_subtree_clean();
        assert!(!doc.block(&[1]).has_dirty_descendant());
    }

    #[test]
    fn hashes() {
        assert_eq!(
            raw_hash_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let doc = nested();
        assert_eq!(child_ids(&doc.children), ["h", "l"]);
        assert_eq!(parent_children_hash(&doc.children), raw_hash_hex("h,l"));
        assert_eq!(parent_children_hash(&[]), raw_hash_hex(""));
    }
}
