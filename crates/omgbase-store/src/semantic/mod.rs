//! The semantic extension (`docs/modular-core/README.md` §6, Phase 2): the
//! embedding caches (`embeddings`, `doc_embeddings`), the indexer — the
//! watermark-positioned drain ([`watermark`]), vector and hybrid search, the
//! vector side of `resolve`, and the `cosine` scalar — behind
//! [`SemanticProvider`](crate::core::capabilities::SemanticProvider),
//! implemented by [`Provider`]. Reads the current head only, never history
//! (the boundary test `tests/boundaries.rs` keeps it so), and nothing outside
//! this directory reads or writes a vector (the same test).
//!
//! Its own crate? Everything it needs from the core is public API of this
//! crate already (`read::reconstruct`, `properties`, `derived::LIVE_LEAF_SQL`,
//! `codec::from_hex`, `Store::changes_since`, the shapes in
//! `core::semantic_shapes`), so an `omgbase-semantic` crate depending on
//! `omgbase-store` is mechanical — but the crate-root paths this module is
//! re-exported under (`omgbase_store::search::*`, `omgbase_store::Provider`)
//! are what the search fixture runner and the binary import, and
//! `Capabilities::standard()` on this crate's root would have to move to the
//! composition layer with it. Phase 6 (the format/bundle split) is the
//! round that moves those; not this one.

pub mod cosine;
pub mod provider;
pub mod search;
pub mod watermark;

pub use cosine::{cosine_bytes, register as register_cosine};
pub use provider::Provider;
