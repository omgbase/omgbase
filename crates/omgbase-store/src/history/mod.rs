//! The history extension (`docs/modular-core/README.md`, Phase 1): the
//! append-only record — revisions, Merkle trees and blobs ([`writers`],
//! [`delta`], [`tree`], [`edit_script`]), the commit log (the feed row's
//! twin; the change feed itself is the core's since 17.0, `core::feed`), the
//! bytes at a revision ([`read`]), the mark-and-sweep
//! ([`gc`]), retention and archive segments ([`retention`], [`archive`]) —
//! behind [`HistoryRecorder`](crate::core::capabilities::HistoryRecorder),
//! implemented by [`Recorder`]. The core names none of this; the composition
//! root (`lib.rs`) assembles it.

pub mod archive;
pub mod delta;
pub mod edit_script;
pub mod gc;
pub mod read;
pub mod recorder;
pub mod retention;
pub mod tree;
pub mod writers;

pub use recorder::Recorder;
