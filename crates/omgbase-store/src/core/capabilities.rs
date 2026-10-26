//! The seams of the modular core (`docs/modular-core/README.md`, Phase 1):
//! what the current-state core asks of its two extensions and of the identity
//! oracle, as traits the composition layer implements and hands down.
//!
//! - [`HistoryRecorder`] — what the recorder receives per committed
//!   transition (the commit row — the feed row's twin — each document's
//!   revision, the matcher's verdicts) and the history reads the store
//!   exposes (the bytes at a revision, a digest's disposition counts, the
//!   projection rebuild, the mark-and-sweep, the retention and archive entry
//!   points). The default implementation is today's code moved behind
//!   the trait (`history::Recorder`); nothing in `core/` names it.
//! - [`SemanticProvider`] — the semantic capability as the query path, the
//!   `blocks_resolve` tool, the CLI's `embed`/`status` verbs and the drain
//!   see it (`README.md` §6; Phase 2): `block_vector`, `doc_vector`, the
//!   `available` gate behind `provider_unavailable`, the vector and hybrid
//!   searches, `resolve`, the queue, and the indexer — `drain` (bootstrap /
//!   catch-up / rescan over an explicit watermark), `rebuild`, `freshness`,
//!   `prune_foreign`. Default: `semantic::Provider`. Nothing outside
//!   `semantic/` reads or writes a vector except through it.
//! - [`IdentityClaims`] — the mint oracle of `spec/store` §2.1 behind an
//!   interface: since 17.0 (Phase 3b, M3/D5) the `id_claims` table
//!   ([`IdClaims`](crate::core::claims::IdClaims)) — the claim written by the
//!   row's writer, the recorder's hold, the §7.3 prune, one probe per mint.
//!
//! [`Capabilities`] bundles the three; the composition layer (the `omgbase`
//! binary's store open path, the sync workspace, the surface) assembles it
//! and passes it to [`Store::open_with`](crate::Store::open_with). Every
//! shape a trait method speaks in is defined here or in
//! [`history_shapes`](crate::core::history_shapes), so the core owns the
//! vocabulary and the extensions implement it.
//!
//! Phase 1 changes no behaviour: every store opens with the standard
//! capabilities and every method is the pass-through it replaced.

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::core::claims::ClaimScope;
use crate::core::history_shapes::{
    ArchiveListing, AttachResult, ExportOptions, ExportResult, RetentionOptions, RetentionPlan,
    RetentionPolicy,
};
use crate::core::mint::Mint;
use crate::core::semantic_shapes::{
    DocVectorHit, DrainOutcome, HybridHit, HybridQuery, IndexIdentity, QueryVector, ResolveHit,
    SemanticFreshness, SemanticQueue, VectorHit,
};
use crate::core::size::{SizeArchived, SizeRetention};
use crate::core::writers::{CommitRecord, TreeInputBlock};
use crate::error::{Error, Result};

// ---- the identity oracle --------------------------------------------------------------

/// `spec/store` §2.1 "Uniqueness at mint" as an interface (17.0 — M3/D5):
/// the `id_claims` table the core writes at every row-carrying mint and the
/// oracle the checking minter ([`Mint`]) asks before issuing an id. `holders`
/// is a bitmask — bit 0 the core, bit 1 the recorder
/// ([`IdClaims`](crate::core::claims::IdClaims)). The core's writers call
/// `claim` in the transaction that writes the row; the recorder calls `hold`
/// when its capture first names an id; `gc` calls `prune` (§7.3).
pub trait IdentityClaims {
    /// Record that the core issued `id` under `prefix` for `repo_id` (`None`
    /// = workspace-scoped) at `minted_at` — idempotent (a second claim of the
    /// same id adds nothing but the core bit).
    fn claim(
        &self,
        conn: &Connection,
        prefix: &str,
        id: &str,
        repo_id: Option<&str>,
        minted_at: &str,
    ) -> Result<()>;

    /// Set the recorder's hold (bit 1) on every id named; an id with no claim
    /// row is left alone.
    fn hold(&self, conn: &Connection, ids: &[&str]) -> Result<()>;

    /// Is `id` in use under `prefix` — §2.1: one probe on `id_claims` for a
    /// core-minted prefix (`d`, `b`, `c`, `r`, `x`, `e`, `rp`, `src`, `ep`),
    /// the table probe for the recorder's `s`.
    fn is_claimed(&self, conn: &Connection, prefix: &str, id: &str) -> Result<bool>;

    /// The claims prune (§7.3) at the clock `now` under the settings layers
    /// given (every repository's effective settings, then the workspace's for
    /// the `repo_id`-less claims); returns the holds released. Runs in the
    /// caller's transaction.
    fn prune(&self, conn: &Connection, now: &str, scopes: &[ClaimScope]) -> Result<usize>;

    /// `count(*)` of `id_claims` (the size report's `id_claims` line, §7.2).
    fn count(&self, conn: &Connection) -> Result<u64>;
}

// ---- the history recorder -------------------------------------------------------------

/// One matcher verdict as the recorder persists it (`spec/store` §5.4 step
/// 10: `dispositions` and `block_changes`). The identity decisions
/// (`assigned`, `deleted`, `consumed_pool`, `cross_doc_ids`) stay the core's;
/// the verdicts are capture (inventory §2.7 row 2).
#[derive(Clone, Debug, PartialEq)]
pub struct DispositionRow {
    pub block_id: String,
    pub kind: String,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub matcher_v: Option<String>,
    /// JSON text.
    pub detail: String,
}

/// What the recorder receives for one document of an accepted transition
/// (`spec/store` §5.4 step 15, 17.0): the head token the CORE minted (D1),
/// the identity, the path, the accepted content — its frontmatter raw and
/// its id-assigned body (the state the `blocks` rows mirror) — and the
/// content hash, under the commit row the transition runs in. The
/// before-head (the previous captured revision: its seq, tree and
/// frontmatter as the delta base, the checkpoint rule) is the recorder's OWN
/// state; the core numbers and hashes the head without reading it (M1).
#[derive(Clone, Debug)]
pub struct RevisionTransition<'a> {
    pub doc_id: &'a str,
    /// The head token the core minted for this transition (§5.4 step 6, D1):
    /// the recorder's `revisions.rev_id`.
    pub head: &'a str,
    /// The path as of this revision — immutable (D11: a `docs_move` is a new
    /// transition at the new path, with the unchanged tree).
    pub path: &'a str,
    /// The frontmatter block's raw, when the document has one.
    pub frontmatter_raw: Option<&'a str>,
    /// The id-assigned body, top level down.
    pub body: &'a [TreeInputBlock],
    /// `sha256(source)`: the accepted bytes' hash (`docs.file_hash`).
    pub rendered_hash: [u8; 32],
    pub commit_id: &'a str,
}

/// What recording a transition yields: the head token it was captured under
/// (= `RevisionTransition::head`) and the recorder's per-document seq.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRevision {
    pub rev_id: String,
    pub seq: i64,
}

/// The result of reading a document at a revision (`spec/store` §6.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionRead {
    /// The path as of that revision.
    pub path: String,
    pub content: String,
    /// `sha256(content) == revisions.rendered_hash`: byte-exact when true.
    pub rendered_hash_match: bool,
}

/// Rows a garbage collection sweeps (or would sweep).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GcResult {
    pub blobs_swept: usize,
    pub tree_nodes_swept: usize,
    /// §7 "The `same` sweep" (14.2): the `same` rows a store through 14.1
    /// wrote into `dispositions` / `block_changes` — history nothing reads.
    pub same_dispositions_swept: usize,
    /// §7.3 (17.0): the core holds released from `id_claims` under
    /// `identity.claims_retain_days` (0 while the setting is null, and on a
    /// dry run).
    pub claims_released: usize,
    /// §7.4 (17.0): the feed rows pruned under `feed.retain_days` /
    /// `feed.retain_entries` (and the cap); 0 on a dry run.
    pub feed_pruned: usize,
}

/// The history figures of the size report (`spec/store` §7 "Size", 14.2 and
/// 15.0): the `same` rows, the archived history, the retention plans' totals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HistorySizeFigures {
    /// `count(*)` of `dispositions` with `kind = 'same'`.
    pub same_dispositions: u64,
    pub archived: SizeArchived,
    pub retention: SizeRetention,
}

/// The history capability: what the current-state core hands the recorder
/// per committed transition, and the history reads the store exposes. Every
/// method runs against the connection (or the open transaction) it is given;
/// the recorder keeps no state of its own.
pub trait HistoryRecorder {
    // ---- the accepted transition ----------------------------------------------------

    /// `spec/store` §5.4 step 15 (17.0, 3d): the `commits` row — the log's
    /// copy of the feed row the core appended (`core::feed::append_feed_row`),
    /// under the same `commit_id`, `epoch` and `seq`, with `ops` (the ADR-003
    /// intent record of an api commit) — and the recorder's hold on the
    /// commit id's claim (§2.1).
    fn record_commit(&self, tx: &Connection, commit: &CommitRecord<'_>) -> Result<()>;

    /// §5.4 step 15 (17.0): the Merkle tree (full or delta over the
    /// recorder's OWN previous captured revision), the frontmatter blob (raw
    /// or delta) and the `revisions` row under the core's head token — one
    /// accepted transition, content, structure or path (D11: a `docs_move`
    /// hands the unchanged tree at the new path). Mints nothing: the head is
    /// the core's (§5.4 step 6).
    fn record_revision(
        &self,
        tx: &Connection,
        transition: &RevisionTransition<'_>,
    ) -> Result<RecordedRevision>;

    /// §5.4 step 10: the verdicts of a commit (`dispositions`,
    /// `block_changes`); which kinds persist is the recorder's rule (14.2:
    /// every kind but `same`).
    fn record_dispositions(
        &self,
        tx: &Connection,
        commit_id: &str,
        rows: &[DispositionRow],
    ) -> Result<()>;

    // ---- the reads the store exposes ------------------------------------------------

    /// `spec/store` §6.2: the bytes at a revision (`docs_read { at }`; the
    /// materializer's `bytes_for` through 16.x — it renders from the current
    /// rows since 17.0).
    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<RevisionRead>>;

    /// A captured revision's frontmatter raw, resolved through the recorder's
    /// own delta chain (`spec/store` §6.2 "Resolving"); `None` when it has
    /// none or the row is unknown. Migration 17's backfill reads it once per
    /// live head (§3.4 step 17).
    fn frontmatter_at_revision(&self, conn: &Connection, rev_id: &str) -> Result<Option<String>>;

    // (No current-state read goes THROUGH history any more: M1 retired
    // `current_frontmatter_raw`/`record_move` in 3a; M4 retired
    // `rendered_hash`/`previous_rendered_hash` in 3c — the pending row carries
    // `prior_hash` and the materializer renders from the current rows.)

    /// The disposition counts of a captured commit (`kind → n` in `kind`
    /// order, `same` never persisted) for a `changes_since` digest's summary
    /// — `None` when the recorder has no `commits` row for it (the feed is the
    /// core's; `core::feed`).
    fn disposition_counts(
        &self,
        conn: &Connection,
        commit_id: &str,
    ) -> Result<Option<Vec<(String, i64)>>>;

    // ---- the projection, the mark and the sweep -------------------------------------

    /// `spec/store` §7 rebuild: `block_changes` from `dispositions`, inside
    /// the caller's transaction.
    fn rebuild_projection(&self, tx: &Connection) -> Result<()>;

    /// §7: the recorder's half of a garbage collection inside the caller's
    /// transaction — the mark-and-sweep over `tree_nodes`/`blobs` and, since
    /// 14.2, the removal of a 14.1 store's `same` disposition rows. The
    /// claims prune (§7.3) is the core's and follows in the same transaction
    /// (`Store::gc_at`); `claims_released` is left 0 here.
    fn gc(&self, tx: &Connection) -> Result<GcResult>;

    /// What [`HistoryRecorder::gc`] would sweep, without deleting (§8 I5).
    fn gc_dry_run(&self, conn: &Connection) -> Result<GcResult>;

    /// §7 (14.2): the `same` disposition rows a store through 14.1 wrote.
    fn count_same_dispositions(&self, conn: &Connection) -> Result<usize>;

    /// The history figures of the size report at `now`.
    fn size_figures(&self, conn: &Connection, now: &str) -> Result<HistorySizeFigures>;

    // ---- retention and archive (§7.1, 15.0) -----------------------------------------

    /// The repo's effective retention policy: the defaults, the settings'
    /// `history.retention` over them, then `override_` (a CLI `--policy`).
    fn retention_policy(
        &self,
        conn: &Connection,
        repo_id: &str,
        override_: Option<&Json>,
    ) -> Result<RetentionPolicy>;

    /// §7.1 "The plan": what the policy would archive, at `opts.now`.
    fn retention_plan(
        &self,
        conn: &Connection,
        repo_id: &str,
        opts: &RetentionOptions,
    ) -> Result<RetentionPlan>;

    /// §7.1 `history export [--prune]`: write one segment (**mints `s`**), or
    /// finish an unrecorded one, and with `prune` squash the store.
    fn export_history(
        &self,
        conn: &Connection,
        mint: &mut Mint<'_>,
        repo_id: &str,
        opts: &ExportOptions,
    ) -> Result<ExportResult>;

    /// §7.1 `history attach <file|dir>`.
    fn attach_archive(
        &self,
        conn: &Connection,
        repo_id: &str,
        target: &Path,
    ) -> Result<AttachResult>;

    /// §7.1 `history detach <segment_id|path>`: the id, or `None` when
    /// nothing matched.
    fn detach_archive(&self, conn: &Connection, repo_id: &str, r: &str) -> Result<Option<String>>;

    /// §7.1 `history list`: the recorded segments, then the unrecorded ones
    /// under `dest` when given.
    fn list_archives(
        &self,
        conn: &Connection,
        repo_id: &str,
        dest: Option<&Path>,
    ) -> Result<Vec<ArchiveListing>>;
}

// ---- the semantic provider ------------------------------------------------------------

/// What a block pass of the drain did (`spec/search` §2.3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EmbedStats {
    /// Cache misses embedded and written.
    pub embedded: usize,
    /// Tasks whose vector was already cached.
    pub cached: usize,
}

/// What a document pass of the drain did (§2.4–§2.5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DocEmbedStats {
    /// Whole-document inputs embedded and written.
    pub embedded: usize,
    /// Tasks whose fresh vector was already cached.
    pub cached: usize,
    /// Over-budget documents pooled from cached block vectors.
    pub pooled: usize,
    /// Tasks not written because the document's head moved between the
    /// snapshot the task was built from and the write (Phase 2's late-result
    /// rule); the next drain re-tasks them.
    pub skipped: usize,
}

/// Counts of `(block, doc)` vectors under a model other than the one asked
/// about (§2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ForeignVectors {
    pub blocks: usize,
    pub docs: usize,
}

/// The semantic capability (`docs/modular-core/README.md` §6; Phase 2): the
/// embedding caches as `semantic(…)`, `blocks_resolve`, the
/// `provider_unavailable` gate, the `embed`/`status` verbs and the drain read
/// and write them. The provider reads the current head only — never history
/// — and the core never calls it: its callers are the surface and the binary,
/// through [`Store::semantic`](crate::Store::semantic). Every vector read or
/// write of the engine goes through this trait (`tests/boundaries.rs`).
pub trait SemanticProvider {
    /// Install what the queries need on a connection — the `cosine` scalar
    /// (`spec/search` §3) — at open.
    fn attach(&self, conn: &Connection) -> Result<()>;

    /// The tables this bundle owns (the size report's advice names them; the
    /// DDL stays the store's until the bundle carries its own schema file).
    fn tables(&self) -> &'static [&'static str];

    /// Has `model` embedded anything the repository's queries can rank — a
    /// document vector of the repo, or any block vector (the surface's
    /// `require_rankable`, `spec/surface` §4 3.0)?
    fn available(&self, conn: &Connection, repo_id: &str, model: &str) -> Result<bool>;

    /// `spec/search` §3 (1.1): a live block's vector — the row for its
    /// current `(content_hash, ctx_hash)` under `model` — as the stored
    /// blob, `None` when stale or not live.
    fn block_vector(
        &self,
        conn: &Connection,
        block_id: &str,
        model: &str,
    ) -> Result<Option<Vec<u8>>>;

    /// The document's vector under `model` (`doc_embeddings`), as stored.
    fn doc_vector(&self, conn: &Connection, doc_id: &str, model: &str) -> Result<Option<Vec<u8>>>;

    // ---- search (§3, §4) ------------------------------------------------------------

    /// §3 over the repo's live embeddable blocks: cosine against `query`
    /// under `model`, by score descending then `block_id`, limited.
    fn vector_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<VectorHit>>;

    /// §3 over the repo's document vectors.
    fn doc_vector_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<DocVectorHit>>;

    /// §4: the FTS and vector rankings fused, boosted, limited.
    fn hybrid_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        q: &HybridQuery,
    ) -> Result<Vec<HybridHit>>;

    /// §4 `resolve` with a query vector (the FTS-only form is the core's,
    /// [`Store::resolve`](crate::Store::resolve)).
    fn resolve(
        &self,
        conn: &Connection,
        repo_id: &str,
        query: &str,
        vector: Option<QueryVector>,
        limit: Option<usize>,
    ) -> Result<Vec<ResolveHit>>;

    // ---- the drain and the indexer (§2) ---------------------------------------------

    /// §2.2–§2.3: the block pass of a drain over the repo's embeddable live
    /// leaves (a full pass; no watermark bookkeeping).
    fn embed(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<EmbedStats>;

    /// §2.4–§2.5: the document pass of a drain (a full pass).
    fn embed_docs(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DocEmbedStats>;

    /// §2.6, Phase 2: one drain positioned by the watermark — a **bootstrap**
    /// from a consistent snapshot of the head when there is none (or the
    /// index identity changed), a **catch-up** over the documents the feed
    /// names since it, a **rescan** with the prune of gone entities when the
    /// cursor cannot be served. Writes the watermark only after every half
    /// succeeded; a document vector is written only while the document's
    /// head is the one the task was built from (never a stale vector).
    fn drain(
        &self,
        store: &crate::Store,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DrainOutcome>;

    /// Phase 2: the forced rescan — every live entity re-scanned, every
    /// vector of a gone entity deleted (`spec/store` §8 S1), the watermark
    /// rewritten under the provider's identity.
    fn rebuild(
        &self,
        store: &crate::Store,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DrainOutcome>;

    /// Phase 2: the watermark against the head. `index` is the identity the
    /// caller embeds under (the configured provider's); the watermark is
    /// `fresh` only under the identity it was written for.
    fn freshness(
        &self,
        store: &crate::Store,
        repo_id: &str,
        index: Option<&IndexIdentity>,
    ) -> Result<SemanticFreshness>;

    /// §2.3: the queue under `model` — the live embeddable blocks and
    /// documents, and how many of each have no (fresh) vector; `None` counts
    /// a vector under any model (the CLI's `status` before a provider is
    /// spawned, when `embedding.model` is unset).
    fn queue(&self, conn: &Connection, repo_id: &str, model: Option<&str>)
    -> Result<SemanticQueue>;

    /// §2.6: how many cached vectors belong to another model.
    fn foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors>;

    /// §2.6: delete every cached vector not produced by `model`.
    fn prune_foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors>;
}

/// The state of a capability as `version` reports it and
/// `capability_unavailable` names it (`spec/surface` 6.0 §2.1 draft,
/// `docs/modular-core/phase-1-contracts.md`): `enabled` — the module is here
/// and configured; `disabled` — the composition layer installed none
/// (semantic: no `embedding.provider` is configured for the repository, the
/// §7 resolution 1 rule — stored vectors are never consulted); `unavailable`
/// — configured, but the module could not come up (semantic: the provider
/// failed to start; retriable).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityState {
    Enabled,
    Disabled,
    Unavailable,
}

impl CapabilityState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Unavailable => "unavailable",
        }
    }
}

// ---- the bundle -------------------------------------------------------------------------

/// The capabilities a store opens with, assembled by the composition layer.
/// `history` and `semantic` are optional by type — a store without one
/// answers the calls that need it with [`unavailable`] — while
/// [`Capabilities::standard`](crate::Capabilities::standard) carries both;
/// `claims` is always present (a store cannot mint without an oracle).
///
/// **Discovery (Phase 2).** The semantic capability's *state* follows
/// `docs/modular-core/phase-1-contracts.md` §7 resolution 1: `enabled` iff
/// the repository's effective settings name an `embedding.provider`; stored
/// vectors are never consulted. The *module* is a composition matter: the
/// standard set carries it (a loaded module with nothing configured keeps
/// `spec/surface` 3.0's `provider_unavailable`), [`CAPABILITIES_ENV`]`=core`
/// opens without it (`disabled`), and a host whose configured provider failed
/// to start detaches it with the reason
/// ([`Store::detach_semantic`](crate::Store::detach_semantic), `semantic_fault`
/// → `unavailable`, retriable). The surface's `version` derives the state
/// from the configuration and the store together.
pub struct Capabilities {
    pub history: Option<Box<dyn HistoryRecorder>>,
    pub semantic: Option<Box<dyn SemanticProvider>>,
    /// Why `semantic` is `None` although a provider is configured — the
    /// `unavailable` state's reason; `None` with `semantic: None` is
    /// `disabled`.
    pub semantic_fault: Option<String>,
    pub claims: Box<dyn IdentityClaims>,
}

impl std::fmt::Debug for Capabilities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capabilities")
            .field("history", &self.history.is_some())
            .field("semantic", &self.semantic.is_some())
            .field("semantic_fault", &self.semantic_fault)
            .finish_non_exhaustive()
    }
}

/// The environment variable the fixture runners honour
/// (`docs/modular-core/README.md`, Phase 2's gate): `core` opens every store
/// without the semantic bundle, so the reads and mutations run with the
/// semantic code and data absent; unset or `standard` is
/// [`Capabilities::standard`](crate::Capabilities::standard).
pub const CAPABILITIES_ENV: &str = "OMGBASE_CAPABILITIES";

impl Capabilities {
    /// The core alone: no recorder, no provider, the `id_claims` oracle. The
    /// core mints its own head token since 17.0 (M1), but legacy capture is
    /// on for every repository through Phase 3, so a store opened with this
    /// still cannot commit a transition (`require_history`); it reads,
    /// queries and sweeps.
    #[must_use]
    pub fn core_only() -> Self {
        Self {
            history: None,
            semantic: None,
            semantic_fault: None,
            claims: Box::new(crate::core::claims::IdClaims),
        }
    }

    /// This set without the semantic bundle (`disabled`).
    #[must_use]
    pub fn without_semantic(mut self) -> Self {
        self.semantic = None;
        self.semantic_fault = None;
        self
    }

    /// This set with the semantic bundle marked `unavailable`: a provider is
    /// configured but could not start (`reason`).
    #[must_use]
    pub fn with_semantic_fault(mut self, reason: impl Into<String>) -> Self {
        self.semantic = None;
        self.semantic_fault = Some(reason.into());
        self
    }

    /// [`CAPABILITIES_ENV`] applied to `standard`: unset / empty / `standard`
    /// → `standard`; `core` → `standard().without_semantic()` — Phase 2's
    /// core (the recorder stays until Phase 3's M1 lets the core commit
    /// without it). Any other value is an error naming the two.
    pub fn from_env(standard: impl FnOnce() -> Self) -> Result<Self> {
        match std::env::var(CAPABILITIES_ENV) {
            Err(_) => Ok(standard()),
            Ok(v) if v.is_empty() || v == "standard" => Ok(standard()),
            Ok(v) if v == "core" => Ok(standard().without_semantic()),
            Ok(v) => Err(Error::Other(format!(
                "{CAPABILITIES_ENV}={v:?}: the values are \"standard\" and \"core\""
            ))),
        }
    }
}

/// The error a store without a capability answers with when a call needs it.
/// Phase 3's spec delta (D3) gives it a wire envelope,
/// `capability_unavailable { capability, state }`; until then it is the
/// store's plain error, never produced by a store opened with the standard
/// capabilities.
#[must_use]
pub fn unavailable(capability: &str) -> Error {
    Error::Other(format!(
        "the {capability} capability is not available on this store"
    ))
}

/// The recorder, or [`unavailable`]`("history")`.
pub fn require_history(history: Option<&dyn HistoryRecorder>) -> Result<&dyn HistoryRecorder> {
    history.ok_or_else(|| unavailable("history"))
}

/// The provider, or [`unavailable`]`("semantic")`.
pub fn require_semantic(semantic: Option<&dyn SemanticProvider>) -> Result<&dyn SemanticProvider> {
    semantic.ok_or_else(|| unavailable("semantic"))
}
