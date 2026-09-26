//! # omgbase-reconcile
//!
//! The omgbase reconciliation matcher, Rust implementation. Given the last
//! persisted block tree of a document (every block carrying its id) and the
//! freshly parsed tree of the new bytes (no ids), the matcher decides, for
//! every new block, whether it **carries** an existing id or is **minted**,
//! and records a **disposition** per decision. The contract is
//! `spec/reconcile/README.md` in the omgbase repository, with the executable
//! fixtures under `spec/reconcile/cases`; [`SPEC_VERSION`] is the matcher
//! version this crate conforms to and [`MATCHER_V`] the stamp it puts on every
//! disposition.
//!
//! ```
//! use omgbase_format::parse_markdown;
//! use omgbase_reconcile::{
//!     Config, DispositionKind, FlatSource, Options, SequentialMinter, flatten,
//!     reconcile_document,
//! };
//!
//! let old = parse_markdown("## Risks\n\nStable block identity is difficult.\n\nAnother paragraph.\n");
//! let new = parse_markdown(
//!     "## Risks\n\nA newly inserted paragraph.\n\nStable block identity is quite difficult.\n\nAnother paragraph.\n",
//! );
//!
//! // The old side carries ids (a store brings its persisted ones; here b_0, b_1, …).
//! let mut ids = SequentialMinter::new("b");
//! let old = flatten(&FlatSource::from_tree(&old, Some(&mut ids)));
//! let new = flatten(&FlatSource::from_tree(&new, None));
//!
//! let mut minter = SequentialMinter::new("n");
//! let result = reconcile_document(
//!     &old,
//!     &new,
//!     Options { config: &Config::default(), pool: &[], minter: &mut minter },
//! );
//!
//! assert_eq!(result.assignment["/0"], "b_0"); // the heading locks exactly
//! assert_eq!(result.assignment["/2"], "b_1"); // the edited paragraph carries
//! assert_eq!(result.assignment["/3"], "b_2");
//! assert_eq!(result.assignment["/1"], "n_0"); // the insertion is minted
//! let inserted = result.dispositions.iter().find(|d| d.block_id == "n_0").unwrap();
//! assert_eq!(inserted.kind, DispositionKind::Inserted);
//! assert!(result.deleted.is_empty());
//! ```
//!
//! ## Layering
//!
//! Mirrors the spec so the two can be read side by side: [`types`] (§1.2,
//! §2, §6), [`similarity`] (§4), [`mod@flatten`] (§1.2), [`phases`] (§5 phases
//! 1–4), [`phase5`], [`phase6a`], [`reconcile`] (the pipeline, bulk rewrite,
//! phase 6b and 7), [`crossdoc`] (§7).
//!
//! Minted ids are opaque to the matcher: it asks a [`Minter`] for each one.
//! [`SequentialMinter`] serves tests and runners; a store brings its own
//! CSPRNG-backed minter (the reference draws 7 Crockford base32 characters
//! from `crypto.randomInt`) and collision-checks the ids it stores.
//!
//! Not included: the evaluation harness (labelled corpora, release gates)
//! stays with the reference in `packages/core/src/reconcile/eval`.

#![forbid(unsafe_code)]

pub mod crossdoc;
pub mod flatten;
#[cfg(feature = "json")]
pub mod json;
pub mod mint;
pub mod phase5;
pub mod phase6a;
pub mod phases;
pub mod reconcile;
pub mod similarity;
pub mod types;

pub use crossdoc::{
    CrossDocMatch, Inserted, PerDocUnmatched, apply_cross_doc_matches, cross_doc_match,
};
pub use flatten::{FlatSource, flatten};
pub use mint::{Minter, SequentialMinter};
pub use phases::{PhaseState, classify_kind};
pub use reconcile::{Options, reconcile_document};
pub use similarity::{Shingles, dice, shingles, text_sim, token_count, tokenize};
pub use types::{
    Config, Detail, DetailValue, Disposition, DispositionKind, MatchBlock, PoolEntry, Reason,
    ReconcileResult, UnknownName,
};

/// The `spec/reconcile/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "2.1";

/// The matcher version stamped on every disposition: `"m" + SPEC_VERSION`.
pub const MATCHER_V: &str = "m2.1";

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

    #[test]
    fn matcher_v_is_m_plus_spec_version() {
        assert_eq!(MATCHER_V, format!("m{SPEC_VERSION}"));
        assert_eq!(Config::default().matcher_v, MATCHER_V);
    }
}
