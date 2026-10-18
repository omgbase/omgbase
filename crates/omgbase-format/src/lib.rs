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
pub mod jsonfmt;
pub mod markdown;
pub mod render;
pub mod text;
pub mod yaml;

pub use block::{AttrValue, Attrs, Block, BlockKind, BlockTree, Span, UnknownKind};
pub use jsonfmt::{JsonAdapter, parse as parse_json};
pub use markdown::{MarkdownAdapter, parse as parse_markdown};
pub use render::{full_coverage, render};
pub use text::{
    block_text, join_texts, normalize_text, normalize_visible_text, uses_children_text,
};
pub use yaml::{YamlAdapter, parse as parse_yaml};

/// The `spec/format/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "0.2";

/// This crate's own version (`Cargo.toml`), for the surface's `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The `format` values (`spec/store` `docs.format`; `spec/properties` §1).
pub const FORMAT_MARKDOWN: &str = "markdown";
pub const FORMAT_YAML: &str = "yaml";
pub const FORMAT_JSON: &str = "json";

/// The format a path's extension selects, as the reference's adapter
/// registry does (`format/registry.ts` `adapterForPath`, case-insensitive):
/// `.yaml`/`.yml` → `yaml`, `.json` → `json`, everything else — `.md`,
/// `.markdown`, an unknown or missing extension — `markdown`, the reference's
/// fallback parser.
#[must_use]
pub fn format_for_path(path: &str) -> &'static str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let ext = name
        .rfind('.')
        .filter(|&i| i > 0)
        .map(|i| name[i..].to_ascii_lowercase());
    match ext.as_deref() {
        Some(".yaml" | ".yml") => FORMAT_YAML,
        Some(".json") => FORMAT_JSON,
        _ => FORMAT_MARKDOWN,
    }
}

/// Parse `source` as `format` (`markdown`, `yaml`, `json`; an unknown name
/// parses as Markdown, the reference's fallback).
#[must_use]
pub fn parse_format(format: &str, source: &str) -> BlockTree {
    match format {
        FORMAT_YAML => parse_yaml(source),
        FORMAT_JSON => parse_json(source),
        _ => parse_markdown(source),
    }
}

/// Parse `source` as the format `path` selects ([`format_for_path`]).
#[must_use]
pub fn parse_path(path: &str, source: &str) -> BlockTree {
    parse_format(format_for_path(path), source)
}

/// A format: a parser from source text to a block tree, and the splice
/// renderer back. Every format shares [`render`]; only parsing is
/// format-specific.
pub trait FormatAdapter {
    /// The spec's `format` value (`"markdown"`, `"yaml"`, `"json"`).
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
    fn formats_follow_the_extension() {
        assert_eq!(format_for_path("notes/plan.md"), "markdown");
        assert_eq!(format_for_path("/a/b.markdown"), "markdown");
        assert_eq!(format_for_path("/attn/focus.yaml"), "yaml");
        assert_eq!(format_for_path("x.YML"), "yaml");
        assert_eq!(format_for_path("config.json"), "json");
        assert_eq!(format_for_path("README"), "markdown");
        assert_eq!(format_for_path(".yaml"), "markdown");
        assert_eq!(format_for_path("a.txt"), "markdown");
        assert_eq!(
            parse_path("f.yaml", "a: 1\n").children[0].kind,
            BlockKind::YamlMappingEntry
        );
        assert_eq!(
            parse_path("f.json", "{\"a\": 1}\n").children[0].kind,
            BlockKind::JsonProperty
        );
        assert_eq!(
            parse_path("f.md", "a: 1\n").children[0].kind,
            BlockKind::Paragraph
        );
        assert_eq!(
            parse_format("nope", "# H\n").children[0].kind,
            BlockKind::Heading
        );
    }

    #[test]
    fn spec_version_matches_the_crate_line() {
        let crate_version = env!("CARGO_PKG_VERSION");
        assert!(
            crate_version.starts_with(&format!("{SPEC_VERSION}.")),
            "crate {crate_version} must track spec {SPEC_VERSION}.x"
        );
    }
}
