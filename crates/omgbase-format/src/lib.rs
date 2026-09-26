//! # omgbase-format
//!
//! The omgbase format layer, Rust implementation: an authored source file
//! becomes a [`BlockTree`] — source-backed blocks with byte spans, trailing
//! trivia, typed attributes and normalized visible text — that splices back
//! into the identical bytes. The contract is `spec/format/README.md` in the
//! omgbase repository, with the executable fixtures under `spec/format/cases`;
//! [`SPEC_VERSION`] is the block-model version this crate conforms to.
//!
//! ```
//! use omgbase_format::{BlockKind, parse_markdown, render};
//!
//! let source = "# Title\n\n- [x] done\n- open\n";
//! let tree = parse_markdown(source);
//! assert_eq!(render(&tree), source);
//! assert_eq!(tree.children[0].kind, BlockKind::Heading);
//! assert_eq!(tree.children[0].text, "Title");
//! assert_eq!(tree.children[1].children[0].kind, BlockKind::Task);
//! ```

#![forbid(unsafe_code)]

pub mod block;
pub mod hash;
#[cfg(feature = "json")]
pub mod json;
pub mod markdown;
pub mod render;
pub mod text;

pub use block::{AttrValue, Attrs, Block, BlockKind, BlockTree, Span, UnknownKind};
pub use markdown::{MarkdownAdapter, parse as parse_markdown};
pub use render::{full_coverage, render};
pub use text::{
    block_text, join_texts, normalize_text, normalize_visible_text, uses_children_text,
};

/// The `spec/format/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "0.2";

/// A format: a parser from source text to a block tree, and the splice
/// renderer back. Every format shares [`render`]; only parsing is
/// format-specific.
pub trait FormatAdapter {
    /// The spec's `format` value (`"markdown"`).
    fn format(&self) -> &'static str;

    /// File extensions this format claims, with the leading dot.
    fn extensions(&self) -> &'static [&'static str];

    /// Parse `source` into a block tree. Never fails (§1 inv. 8).
    fn parse(&self, source: &str) -> BlockTree;

    /// `leading_trivia + Σ(raw + trivia)`: the round trip (§1 inv. 1).
    fn render(&self, tree: &BlockTree) -> String {
        render(tree)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_version_matches_the_crate_line() {
        let crate_version = env!("CARGO_PKG_VERSION");
        assert!(
            crate_version.starts_with(&format!("{SPEC_VERSION}.")),
            "crate {crate_version} must track spec {SPEC_VERSION}.x"
        );
    }
}
