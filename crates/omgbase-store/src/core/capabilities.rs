//! The seams of the modular core (`docs/modular-core/README.md`, Phase 1):
//! what the current-state core asks of its two extensions and of the identity
//! oracle, as traits the composition layer implements and hands down.
//!
//! - [`HistoryRecorder`] — what the recorder receives per committed
//!   transition (the commit row, each document's revision, the matcher's
//!   verdicts, a move) and the history reads the store exposes (the bytes at
//!   a revision, the feed, the rendered hashes the recovery path compares,
//!   the projection rebuild, the mark-and-sweep, the retention and archive
//!   entry points). The default implementation is today's code moved behind
//!   the trait (`history::Recorder`); nothing in `core/` names it.
//! - [`SemanticProvider`] — the embedding caches as the query path and the
//!   drain see them (`README.md` §6): `block_vector`, `doc_vector`, the
//!   `available` gate behind `provider_unavailable`, `embed`/`embed_docs`/
//!   `prune_foreign`. Default: `semantic::Provider`.
//! - [`IdentityClaims`] — the mint oracle of `spec/store` §2.1 behind an
//!   interface: today the union of each prefix's tables
//!   ([`TableUnionClaims`](crate::core::claims::TableUnionClaims)), in Phase
//!   3 an `id_claims` table (D5).
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

use crate::core::history_shapes::{
    ArchiveListing, AttachResult, ExportOptions, ExportResult, RetentionOptions, RetentionPlan,
    RetentionPolicy,
};
use crate::core::mint::Mint;
use crate::core::size::{SizeArchived, SizeRetention};
use crate::core::writers::{NewCommit, TreeInputBlock};
use crate::error::{Error, Result};

// ---- the identity oracle --------------------------------------------------------------

/// `spec/store` §2.1 "Uniqueness at mint" as an interface: whether an id is
/// already claimed, and the claim itself. The checking minter ([`Mint`])
/// consults it on every draw.
pub trait IdentityClaims {
    /// Does `id` (of `prefix`) already name an identity this store issued —
    /// today a row of the prefix's table(s), history tables included
    /// (`block_changes`, `resurrection_pool`, `commits`, `revisions`, …)?
    fn is_claimed(&self, conn: &Connection, prefix: &str, id: &str) -> Result<bool>;

    /// Record that `id` was just issued. The table-union oracle claims
    /// nothing here — the row the writer inserts is the claim; Phase 3's
    /// `id_claims` table (D5) writes its row.
    fn claim(&self, conn: &Connection, prefix: &str, id: &str) -> Result<()>;
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
/// (`spec/store` §5.4 steps 0, 1, 4 and 6): the identity, the path, the
/// accepted content — its frontmatter raw and its id-assigned body (the state
/// the `blocks` rows mirror) — and the content hash, under the commit row the
/// transition runs in.
#[derive(Clone, Debug)]
pub struct RevisionTransition<'a> {
    pub doc_id: &'a str,
    pub path: &'a str,
    /// The frontmatter block's raw, when the document has one.
    pub frontmatter_raw: Option<&'a str>,
    /// The id-assigned body, top level down.
    pub body: &'a [TreeInputBlock],
    /// `sha256(source)`: the accepted bytes' hash (`docs.file_hash`).
    pub rendered_hash: [u8; 32],
    pub commit_id: &'a str,
}

/// What recording a transition yields: the head token (D1 — the `r_`
/// revision id, equal to the recorder's revision id while capture is on)
/// and the document's revision sequence number.
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
}

/// One revision a commit wrote (the change feed, `spec/sync` §6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestRevision {
    pub doc: String,
    pub path: String,
    /// Hex of the revision's `rendered_hash`.
    pub content_hash: String,
}

/// One commit of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitDigest {
    pub commit: String,
    pub seq: i64,
    pub ts: String,
    pub origin: String,
    pub actor: Option<String>,
    /// A human line (the fixtures do not pin it).
    pub summary: String,
    pub revisions: Vec<DigestRevision>,
}

/// A page of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangesPage {
    pub digests: Vec<CommitDigest>,
    /// The last digest's `seq`, or the input cursor when the page is empty.
    pub cursor: i64,
    /// More commits follow.
    pub truncated: bool,
    /// The repo's max `seq` (0 when it has no commits).
    pub head: i64,
}

impl ChangesPage {
    /// The page as the MCP surface renders it (`camelCase` as the reference).
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "digests": self.digests.iter().map(CommitDigest::to_json).collect::<Vec<_>>(),
            "cursor": self.cursor,
            "truncated": self.truncated,
            "head": self.head,
        })
    }
}

impl CommitDigest {
    /// The digest as the MCP surface renders it (`spec/sync` §6, 3.0): the
    /// digest's own keys describe a commit and stay bare; a revision is a
    /// `revisions` row rendered, so it takes the row's engine names
    /// `{ _id, _path, _hash }` (`spec/surface` §1.2, 5.0).
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "commit": self.commit,
            "seq": self.seq,
            "ts": self.ts,
            "origin": self.origin,
            "actor": self.actor,
            "summary": self.summary,
            "revisions": self.revisions.iter().map(|r| serde_json::json!({
                "_id": r.doc, "_path": r.path, "_hash": r.content_hash,
            })).collect::<Vec<_>>(),
        })
    }
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

    /// `spec/store` §5.4 step 5: the commit row — **mints `c`**, `seq = 1 +
    /// max(seq)` over the repo. Returns `(commit_id, seq)`. Every write
    /// entry point records one before any current-state row.
    fn new_commit(
        &self,
        tx: &Connection,
        mint: &mut Mint<'_>,
        input: &NewCommit<'_>,
    ) -> Result<(String, i64)>;

    /// §5.4 steps 0, 1, 4 and 6 for one document: its place (seq, checkpoint),
    /// its frontmatter blob (raw or delta), its Merkle tree (full or delta
    /// against the previous revision's) and the revision row — **mints
    /// `r`**. Returns the head token the core points `docs.current_rev` at.
    fn record_revision(
        &self,
        tx: &Connection,
        mint: &mut Mint<'_>,
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

    /// A `docs_move`: the current revision's path becomes `to` (`spec/surface`
    /// 4.7 "the path it was committed under"; inventory §3.12).
    fn record_move(
        &self,
        tx: &Connection,
        doc_id: &str,
        rev_id: Option<&str>,
        to: &str,
    ) -> Result<()>;

    // ---- the reads the store exposes ------------------------------------------------

    /// `spec/store` §6.2: the bytes at a revision (`docs_read { at }`, the
    /// materializer's `bytes_for` until M4).
    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<RevisionRead>>;

    /// `revisions.rendered_hash` of `rev_id`, `None` for an unknown revision
    /// (the pending row's expected bytes; inventory §3.4).
    fn rendered_hash(&self, conn: &Connection, rev_id: &str) -> Result<Option<Vec<u8>>>;

    /// The `rendered_hash` of the document's revision before `rev_id`: the
    /// bytes a file left behind by the commit still holds (the materializer's
    /// prior-bytes rule; inventory §3.4).
    fn previous_rendered_hash(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<Vec<u8>>>;

    /// The change feed (`spec/sync` §6): the repo's commits with `seq >
    /// cursor`, optionally of one `origin`, `limit + 1` fetched to set
    /// `truncated`.
    fn changes_since(
        &self,
        conn: &Connection,
        repo_id: &str,
        cursor: i64,
        limit: usize,
        origin: Option<&str>,
    ) -> Result<ChangesPage>;

    // ---- the projection, the mark and the sweep -------------------------------------

    /// `spec/store` §7 rebuild: `block_changes` from `dispositions`, inside
    /// the caller's transaction.
    fn rebuild_projection(&self, tx: &Connection) -> Result<()>;

    /// §7: mark-and-sweep garbage collection, flag-gated (off → no-op); since
    /// 14.2 the same sweep removes a 14.1 store's `same` disposition rows.
    fn gc(&self, conn: &Connection, enabled: bool) -> Result<GcResult>;

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
}

/// Counts of `(block, doc)` vectors under a model other than the one asked
/// about (§2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ForeignVectors {
    pub blocks: usize,
    pub docs: usize,
}

/// The semantic capability (`docs/modular-core/README.md` §6): the embedding
/// caches as `semantic(…)`, `resolve`, the `provider_unavailable` gate and
/// the drain read and write them. The provider reads the current head only
/// — never history — and the core never calls it: its callers are the
/// surface and the binary, through [`Store::semantic`](crate::Store::semantic).
pub trait SemanticProvider {
    /// Install what the queries need on a connection — the `cosine` scalar
    /// (`spec/search` §3) — at open.
    fn attach(&self, conn: &Connection) -> Result<()>;

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

    /// §2.2–§2.3: the block pass of a drain over the repo's embeddable live
    /// leaves.
    fn embed(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<EmbedStats>;

    /// §2.4–§2.5: the document pass of a drain.
    fn embed_docs(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DocEmbedStats>;

    /// §2.6: delete every cached vector not produced by `model`.
    fn prune_foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors>;
}

// ---- the bundle -------------------------------------------------------------------------

/// The capabilities a store opens with, assembled by the composition layer.
/// `history` and `semantic` are optional by type — the Phase 2 and Phase 3
/// gates open a store without one — while every Phase 1 store carries both
/// ([`Capabilities::standard`](crate::Capabilities::standard)); `claims` is
/// always present (a store cannot mint without an oracle).
pub struct Capabilities {
    pub history: Option<Box<dyn HistoryRecorder>>,
    pub semantic: Option<Box<dyn SemanticProvider>>,
    pub claims: Box<dyn IdentityClaims>,
}

impl std::fmt::Debug for Capabilities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capabilities")
            .field("history", &self.history.is_some())
            .field("semantic", &self.semantic.is_some())
            .finish_non_exhaustive()
    }
}

impl Capabilities {
    /// The core alone: no recorder, no provider, the table-union oracle. A
    /// store opened with this cannot commit a transition until Phase 3 lets
    /// the core mint its own head token (M1); it reads, queries and sweeps.
    #[must_use]
    pub fn core_only() -> Self {
        Self {
            history: None,
            semantic: None,
            claims: Box::new(crate::core::claims::TableUnionClaims),
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
