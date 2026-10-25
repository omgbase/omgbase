//! The semantic extension (`docs/modular-core/README.md` §6, Phase 2's
//! opener): the embedding caches (`embeddings`, `doc_embeddings`), the drain,
//! vector and hybrid search, `resolve`, and the `cosine` scalar — behind
//! [`SemanticProvider`](crate::core::capabilities::SemanticProvider),
//! implemented by [`Provider`]. Reads the current head only, never history
//! (the boundary test `tests/boundaries.rs` keeps it so).

pub mod cosine;
pub mod provider;
pub mod search;

pub use cosine::{cosine_bytes, register as register_cosine};
pub use provider::Provider;
