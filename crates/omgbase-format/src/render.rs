//! The splice renderer (`spec/format/README.md` §1 inv. 1) and the coverage
//! check (inv. 2).

use crate::block::BlockTree;

/// `leading_trivia + Σ(block.raw + block.trivia)` over the top-level blocks,
/// verbatim. Nothing is re-serialized from a syntax tree, so
/// `render(&parse(s)) == s` byte for byte.
#[must_use]
pub fn render(tree: &BlockTree) -> String {
    let mut out = String::with_capacity(tree.source.len());
    out.push_str(&tree.leading_trivia);
    for block in &tree.children {
        out.push_str(&block.raw);
        out.push_str(&block.trivia);
    }
    out
}

/// Every byte of `source` is owned by exactly one top-level block's `raw` or
/// `trivia`, in order, with `leading_trivia` first: no gaps, no overlaps, and
/// the walk ends exactly at the end of the source.
#[must_use]
pub fn full_coverage(tree: &BlockTree) -> bool {
    let src = tree.source.as_str();
    let slice = |start: usize, len: usize| src.get(start..start + len);
    if slice(0, tree.leading_trivia.len()) != Some(tree.leading_trivia.as_str()) {
        return false;
    }
    let mut cursor = tree.leading_trivia.len();
    for block in &tree.children {
        if block.span.start != cursor {
            return false;
        }
        if slice(block.span.start, block.span.len()) != Some(block.raw.as_str()) {
            return false;
        }
        cursor = block.span.end;
        if slice(cursor, block.trivia.len()) != Some(block.trivia.as_str()) {
            return false;
        }
        cursor += block.trivia.len();
    }
    cursor == src.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::{Attrs, Block, BlockKind, Span};

    fn block(source: &str, start: usize, end: usize, trivia: &str) -> Block {
        Block {
            kind: BlockKind::Paragraph,
            span: Span::new(start, end),
            raw: source[start..end].to_owned(),
            text: String::new(),
            attrs: Attrs::new(),
            children: Vec::new(),
            trivia: trivia.to_owned(),
        }
    }

    #[test]
    fn splices_and_covers() {
        let source = "\n\na\n\nbb\n";
        let tree = BlockTree {
            source: source.to_owned(),
            leading_trivia: "\n\n".to_owned(),
            children: vec![block(source, 2, 3, "\n\n"), block(source, 5, 7, "\n")],
        };
        assert_eq!(render(&tree), source);
        assert!(full_coverage(&tree));

        let mut gap = tree.clone();
        gap.children[0].trivia = "\n".to_owned();
        assert!(!full_coverage(&gap));
        assert_ne!(render(&gap), source);

        let mut short = tree.clone();
        short.children.pop();
        assert!(!full_coverage(&short));

        let mut wrong_raw = tree;
        wrong_raw.children[1].raw = "cc".to_owned();
        assert!(!full_coverage(&wrong_raw));
    }

    #[test]
    fn empty_tree_is_all_leading_trivia() {
        let tree = BlockTree {
            source: "\n\n".to_owned(),
            leading_trivia: "\n\n".to_owned(),
            children: Vec::new(),
        };
        assert_eq!(render(&tree), "\n\n");
        assert!(full_coverage(&tree));
        assert!(full_coverage(&BlockTree::default()));
    }
}
