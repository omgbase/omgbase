//! The shapes the semantic capability speaks in
//! ([`SemanticProvider`](crate::core::capabilities::SemanticProvider),
//! `docs/modular-core/README.md` §6, Phase 2): the vector hits, the hybrid
//! query and its hits, `resolve`'s candidates, the drain's figures, the
//! indexer's queue and its freshness. Defined in the core — like
//! [`history_shapes`](crate::core::history_shapes) — so the core owns the
//! vocabulary and the extension implements it; nothing here names a table.

use omgbase_search::Evidence;
use serde_json::{Value as Json, json};

use crate::core::capabilities::{DocEmbedStats, EmbedStats};

/// One `vector_search` hit (`spec/search` §3).
#[derive(Clone, Debug, PartialEq)]
pub struct VectorHit {
    pub block_id: String,
    pub doc_id: String,
    pub path: String,
    pub cosine: f64,
}

/// One `doc_vector_search` hit (§3).
#[derive(Clone, Debug, PartialEq)]
pub struct DocVectorHit {
    pub doc_id: String,
    pub path: String,
    pub cosine: f64,
}

/// The vector side of a hybrid query: the model whose cache to read and the
/// query vector.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryVector {
    pub model: String,
    pub vec: Vec<f32>,
}

/// The inputs of `hybrid_search` (§4).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HybridQuery {
    /// The FTS query.
    pub text: Option<String>,
    pub vector: Option<QueryVector>,
    /// Boost terms; default: `text` split on whitespace.
    pub terms: Option<Vec<String>>,
    pub limit: Option<usize>,
}

/// One `hybrid_search` hit (§4).
#[derive(Clone, Debug, PartialEq)]
pub struct HybridHit {
    pub block_id: String,
    pub doc_id: String,
    pub path: String,
    pub score: f64,
    pub evidence: Evidence,
}

/// One `resolve` candidate (§4; `blocks_resolve` on the wire).
#[derive(Clone, Debug, PartialEq)]
pub struct ResolveHit {
    pub id: String,
    /// `path#type[ordinal]`.
    pub locator: String,
    /// The first 12 words of the text (`…` when cut).
    pub preview: String,
    pub evidence: Evidence,
}

/// One drain: the block pass, then the document pass (§2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainStats {
    pub blocks: EmbedStats,
    pub docs: DocEmbedStats,
}

/// The identity of the index a repository's vectors were produced under: a
/// change in any member invalidates the watermark (the next drain rescans
/// every entity under the new identity; vectors of another `model` are
/// pruned on request, `spec/search` §2.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexIdentity {
    /// The provider's model name.
    pub model: String,
    /// The vector length.
    pub dim: usize,
    /// The version of the chunking rule (`spec/search` §2.1–§2.2: which
    /// blocks embed and how their context is built) — [`CHUNKING_VERSION`].
    pub chunking: u32,
}

/// The chunking rule this engine embeds under (`spec/search` 3.0: live
/// leaves over [`omgbase_search::MIN_EMBED_TOKENS`], context prefix §2.2,
/// document input §2.4). Bump when the rule changes, so every stored
/// watermark expires.
pub const CHUNKING_VERSION: u32 = 1;

impl IndexIdentity {
    /// The identity a provider embeds under.
    #[must_use]
    pub fn of(provider: &dyn omgbase_search::EmbeddingProvider) -> Self {
        Self {
            model: provider.model().to_owned(),
            dim: provider.dim(),
            chunking: CHUNKING_VERSION,
        }
    }

    /// `{ model, dims, chunking }` — the reference's spelling, so both
    /// engines read one watermark.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({ "model": self.model, "dims": self.dim, "chunking": self.chunking })
    }

    /// The identity a stored JSON object names, `None` when malformed.
    #[must_use]
    pub fn from_json(v: &Json) -> Option<Self> {
        Some(Self {
            model: v.get("model")?.as_str()?.to_owned(),
            dim: usize::try_from(v.get("dims")?.as_u64()?).ok()?,
            chunking: u32::try_from(v.get("chunking")?.as_u64()?).ok()?,
        })
    }
}

/// The indexer's position (`spec/search` §2.6; modular-core Phase 2): what
/// the last complete drain covered and what the repository has since done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticFreshness {
    /// The feed position (`spec/sync` §6 `seq`) the last complete drain
    /// started from; `None` before the first complete drain (a bootstrap is
    /// due).
    pub processed_seq: Option<i64>,
    /// The repository's current head `seq` (0 when nothing committed).
    pub head: i64,
    /// The identity the stored watermark was produced under, if any.
    pub index: Option<IndexIdentity>,
    /// `processed_seq == head` under the asked-about identity — nothing is
    /// queued by position (a vector may still be missing when a drain was
    /// interrupted; the queue count is the authority).
    pub fresh: bool,
}

impl SemanticFreshness {
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "processedSeq": self.processed_seq,
            "head": self.head,
            "index": self.index.as_ref().map(IndexIdentity::to_json),
            "fresh": self.fresh,
        })
    }
}

/// How a drain found its position (the drain's report; `omg embed drain -v`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainMode {
    /// No watermark (or another index identity): every live entity
    /// re-scanned from one consistent snapshot of the head.
    Bootstrap,
    /// The watermark's cursor was served: only the documents the feed names
    /// since it were re-scanned.
    CatchUp,
    /// The cursor lay beyond the head (a restore, a rebuild-from-files, a
    /// pruned feed): a full rescan plus the prune of vectors whose entity is
    /// gone (`spec/store` §8 S1).
    Rescan,
}

impl DrainMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::CatchUp => "catch-up",
            Self::Rescan => "rescan",
        }
    }
}

/// What one drain did and how (the trait's `drain` result).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrainOutcome {
    pub stats: DrainStats,
    pub mode: DrainMode,
    /// Vectors deleted because their entity is gone (the rescan's prune).
    pub pruned: PrunedVectors,
    /// The watermark written: the head `seq` the drain started from.
    pub processed_seq: i64,
    /// Documents the catch-up re-scanned (`None` on a full pass).
    pub docs_rescanned: Option<usize>,
}

/// Vectors removed because no live entity carries them any more (`S1`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrunedVectors {
    pub blocks: usize,
    pub docs: usize,
}

/// The embed queue (`spec/search` §2.3 "stale"; the CLI's `embed status` and
/// `status.embedQueue`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SemanticQueue {
    /// Live embeddable blocks (§2.1).
    pub embeddable: usize,
    /// Of those, with no cached vector under the model.
    pub stale_blocks: usize,
    /// Live documents with a non-blank input (§2.4).
    pub docs: usize,
    /// Of those, with no fresh cached vector under the model.
    pub stale_docs: usize,
}
