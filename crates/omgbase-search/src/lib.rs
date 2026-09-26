//! # omgbase-search
//!
//! The omgbase search layer, Rust implementation — the pure half. Search is
//! how a repository is *found in*: full-text search over block text (SQLite
//! FTS5, bm25), semantic search over block and document embeddings
//! (brute-force cosine), and their fusion with explainable boosts. This crate
//! holds what is a pure function of its inputs plus the provider protocol:
//! the FTS5 query sanitizer, which blocks embed and the exact strings a
//! provider is asked for, the cache keys, the document input and its
//! whole-vs-pooled budget, block-vector pooling, cosine, RRF fusion and the
//! boosts, the `resolve` shaping, the [`EmbeddingProvider`] seam with its
//! stdio and http(s) implementations, and the deterministic
//! [`FixtureEmbedder`] the conformance fixtures use. The index maintenance
//! and the queries over the database live in `omgbase-store`, which calls
//! this crate.
//!
//! The contract is `spec/search/README.md` in the omgbase repository; the
//! reference is the TypeScript engine `@omgbase/core`
//! (`search/{fts-query,embeddings,tasks,vector,rrf,resolve,external}.ts`).
//!
//! ```
//! use omgbase_search::{
//!     FixtureEmbedder, EmbeddingProvider, context_prefix, cosine_f32, rrf_score,
//!     sanitize_fts_query, should_embed,
//! };
//!
//! assert_eq!(sanitize_fts_query("guides/onboarding"), "\"guides/onboarding\"");
//! assert_eq!(sanitize_fts_query("\"exact phrase\" other*"), "\"exact phrase\" \"other\"*");
//! assert_eq!(sanitize_fts_query("---"), "");
//!
//! assert!(!should_embed("too short to embed on its own"));
//! let chain = vec!["Setup".to_owned()];
//! assert_eq!(context_prefix("Guide", "g.md", &chain, "paragraph"), "Guide · g.md · Setup · paragraph");
//!
//! let q = FixtureEmbedder.embed_query("hello")?;
//! assert_eq!(q.len(), 8);
//! assert!((cosine_f32(&q, &q) - 1.0).abs() < 1e-9);
//! assert_eq!(rrf_score(Some(1), Some(2)), 1.0 / 61.0 + 1.0 / 62.0);
//! # Ok::<(), omgbase_search::Error>(())
//! ```

#![forbid(unsafe_code)]

pub mod embed;
pub mod error;
pub mod external;
pub mod fts;
pub mod provider;
pub mod rank;
pub mod vec;

pub use embed::{
    DEFAULT_DOC_TOKEN_BUDGET, DOC_HEADER_MARGIN_TOKENS, DocEmbedBlockRef, DocEmbedMethod,
    DocEmbedTask, EMBED_BATCH, EmbedTask, MIN_EMBED_TOKENS, context_prefix, ctx_hash, doc_header,
    doc_input, embed_input, estimate_tokens, hex, pool_block_vectors, sha256, should_embed,
    token_budget, word_count,
};
pub use error::{Error, Result};
#[cfg(feature = "http")]
pub use external::HttpProvider;
pub use external::{
    EmbeddingSettings, StdioProvider, create_external_provider, embedder_env, is_url,
};
pub use fts::{has_word_char, is_js_whitespace, sanitize_fts_query, split_ws};
pub use provider::{
    EmbeddingProvider, FIXTURE_DIM, FIXTURE_MAX_INPUT_TOKENS, FIXTURE_MODEL, FixtureEmbedder,
};
pub use rank::{
    BoostFacts, Boosts, Candidate, Evidence, HYBRID_PASS_LIMIT, PREVIEW_WORDS,
    RESOLVE_DEFAULT_LIMIT, RRF_K, apply_boosts, compute_boosts, default_terms, fuse, layer_boost,
    locator, lower_terms, preview, property_to_string, rrf_score, sort_by_score,
};
pub use vec::{blob_to_f32, cosine_bytes, cosine_f32, f32_to_blob, to_f32};

/// The `spec/search/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "1.0";

#[cfg(test)]
mod tests {
    #[test]
    fn crate_version_tracks_the_spec() {
        assert!(env!("CARGO_PKG_VERSION").starts_with(&format!("{}.", super::SPEC_VERSION)));
    }
}
