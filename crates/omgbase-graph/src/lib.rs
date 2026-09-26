//! # omgbase-graph
//!
//! The omgbase graph layer, Rust implementation — the **pure** half: the
//! semantic nodes a Markdown document's blocks project (links, wikilinks,
//! tasks, anchors, inline fields) and the authored edge descriptors they and
//! the frontmatter yield (links, frontmatter relations, inline relations),
//! plus URI normalization and relative-path resolution. The contract is
//! `spec/graph/README.md` in the omgbase repository, with the executable
//! fixtures under `spec/graph/cases`; [`SPEC_VERSION`] is the spec version
//! this crate conforms to. Resolution to node ids, minting, the edge
//! intervals and the `doc_edges` rollup read and write the database and live
//! in `omgbase-store`, which calls this crate inside its commit transaction.
//!
//! ```
//! use omgbase_format::parse_markdown;
//! use omgbase_graph::{DstKind, NodeKind, Provenance, extract_doc_edges, node_rows, project_nodes};
//! use omgbase_properties::DocBlock;
//!
//! let tree = parse_markdown("# T\n\nSee [x](./x.md#H) and [[note^r1]]\n\nrel:: [[y]]\n");
//! let ids: Vec<String> = (0..DocBlock::count(&tree.children)).map(|i| format!("b_{i}")).collect();
//! let blocks = DocBlock::from_blocks(&tree.children, &ids);
//!
//! let nodes = project_nodes(&blocks);
//! let kinds: Vec<NodeKind> = nodes.iter().map(|n| n.kind).collect();
//! assert_eq!(
//!     kinds,
//!     [NodeKind::Link, NodeKind::Wikilink, NodeKind::Anchor, NodeKind::Wikilink, NodeKind::InlineField]
//! );
//! assert_eq!(nodes[0].span, Some((4, 17)));
//! let rows = node_rows("d_0", &nodes);
//! assert!(rows[0].node_id.starts_with("n_") && rows[0].node_id.len() == 14);
//!
//! let edges = extract_doc_edges(&blocks, None);
//! assert_eq!(edges.len(), 3);
//! assert_eq!(edges[0].target, "./x.md");
//! assert_eq!(edges[0].anchor.as_deref(), Some("H"));
//! assert_eq!(edges[0].dst_kind, DstKind::Document);
//! assert_eq!(edges[1].dst_kind, DstKind::Block); // `[[note^r1]]`: a block ref
//! assert_eq!(edges[2].predicate, "rel"); // and `[[y]]` is not also a plain link
//! assert_eq!(edges[2].provenance, Provenance::InlineField);
//! ```

#![forbid(unsafe_code)]

pub mod edges;
pub mod mask;
pub mod nodes;
pub mod path;
pub mod uri;

pub use edges::{
    AnchorKind, Classified, DstKind, EdgeDescriptor, Provenance, classify, extract_block_edges,
    extract_doc_edges, extract_frontmatter_edges, split_fragment,
};
pub use mask::mask_code_bytes;
pub use nodes::{NodeKind, NodeRow, ProjectedNode, node_id, node_rows, project_nodes};
pub use path::{canonical_path, doc_dir, resolve_relative};
pub use uri::normalize_uri;

/// The `spec/graph/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "1.0";

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
