//! The history extension (`docs/modular-core/README.md`, Phase 1): the
//! append-only record — revisions, Merkle trees and blobs ([`writers`],
//! [`delta`], [`tree`], [`edit_script`]), commits and the change feed
//! ([`feed`]), the bytes at a revision ([`read`]), the mark-and-sweep
//! ([`gc`]), retention and archive segments ([`retention`], [`archive`]) —
//! behind [`HistoryRecorder`](crate::core::capabilities::HistoryRecorder),
//! implemented by [`Recorder`]. The core names none of this; the composition
//! root (`lib.rs`) assembles it.
//!
//! The feed module keeps the old `history` module's name on the wire of the
//! crate: `omgbase_store::history::changes_since` and the feed shapes still
//! resolve.

pub mod archive;
pub mod delta;
pub mod edit_script;
pub mod feed;
pub mod gc;
pub mod read;
pub mod recorder;
pub mod retention;
pub mod tree;
pub mod writers;

pub use feed::{ChangesPage, CommitDigest, DigestRevision, changes_since};
pub use recorder::Recorder;
