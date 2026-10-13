//! # omgbase-mutate
//!
//! The omgbase mutation kernel, Rust implementation of `spec/mutate`: a
//! document loaded from the store as a mutable block tree ([`MutDoc`]), the
//! six kernel operations over it with placement addressing and
//! compare-and-swap expectations ([`ops`]), the splice renderer with its
//! dirty rules ([`render`]), changeset placeholder resolution
//! ([`changeset`]), the whole-document lowering ([`lower`]), the opset
//! ([`opset`]) and the public effect vocabulary with its plan shape, conflict
//! rules and digest ([`effects`], 2.3). Every function here is pure: the store loads, applies,
//! commits, and hosts the macros and document operations.
//!
//! ```
//! use omgbase_mutate::{MutBlock, MutDoc, At, Parent, To, op_insert, render};
//! use omgbase_reconcile::SequentialMinter;
//!
//! let mut doc = MutDoc::new("d_0", "a.md", vec![MutBlock::new("b_0", "heading", "# Title", "\n")]);
//! let mut minter = SequentialMinter::new("b");
//! let to = To { parent: Parent::Doc, at: At::End };
//! let result = op_insert(&mut doc, &to, "A paragraph.", 0, None, &mut minter).unwrap();
//! assert_eq!(result.ids, ["b_0"]);
//! assert_eq!(render(&doc), "# Title\n\nA paragraph.\n");
//! ```

#![forbid(unsafe_code)]

pub mod changeset;
pub mod effects;
pub mod error;
pub mod lower;
pub mod ops;
pub mod opset;
pub mod render;
pub mod summary;
pub mod tree;

pub use changeset::{Op, parse_placeholder, resolve_op, resolve_placeholder, resolve_to};
pub use effects::{
    Admission, ConflictTracker, Effect, EffectExpect, ExpectMap, Field, Focus, FocusInfo,
    FocusTarget, IdentityOp, IdentityPreview, NewId, NewIdKind, PLAN_VERSION, PLANNER_V, Plan,
    PlanCreate, PlanFrontmatter, PlanMove, PlanOpset, PlanPreview, PlanRevision, PlanTombstone,
    Preconditions, Repair, RetargetHitPreview, RetargetPairPreview, RetargetPreview,
    SELECTION_CEILING, ScalarWrite, Selection, SelectionExpect, Target, canonical_json,
    classify_field, map_block_ids, parse_new_symbol, shift_placeholders,
};
pub use error::{ErrorCode, MutationError, Result};
pub use lower::{LowerResult, body_of, lcs, lower_replace, lower_top_level, strip_frontmatter};
pub use omgbase_reconcile::Minter;
pub use ops::{
    At, Expect, OpResult, Parent, To, UpdateArgs, check_content_hash, check_parent_children_hash,
    cross_doc_move, default_trivia, op_insert, op_merge, op_move, op_remove, op_split, op_update,
    parse_content, parse_document, resolve_target, separates_blocks,
};
pub use opset::{Opset, OpsetPrecondition, OpsetSummary, PlanDisposition, PlanOp, summarize};
pub use render::{render, render_block};
pub use summary::{
    NoLookup, SummaryLookup, block_count, plural, summarize_effect, visible_text_of,
};
pub use tree::{BlockPath, MutBlock, MutDoc, child_ids, parent_children_hash, raw_hash_hex};

/// The `spec/mutate/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "3.3";

/// This crate's own version (`Cargo.toml`), for the surface's `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

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
