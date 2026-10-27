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
use std::rc::Rc;

use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use crate::core::claims::ClaimScope;
use crate::core::graph::EdgeTransitions;
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

/// A `revisions` row as the query binding reads it (`spec/surface` §1.1/§1.2
/// — the `revisions` root and the `_revisions` relation; 17.1 Phase 4a): the
/// `revisions` × `commits` columns under their own names, `is_current` (= the
/// revision is its document's `head`) and `archived`. The recorder produces
/// them ([`HistoryRecorder::revision_rows`], [`HistoryRecorder::doc_revision_rows`])
/// so no SQL outside the history bundle names a history table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionQueryRow {
    pub rev_id: String,
    pub doc_id: String,
    pub seq: i64,
    /// The 32-byte content hash (`revisions.rendered_hash`).
    pub rendered_hash: Vec<u8>,
    /// The path as of the revision (the storage form).
    pub path: String,
    pub commit_id: String,
    pub ts: String,
    pub origin: String,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub is_current: bool,
    pub archived: bool,
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

/// What `history purge` removed, per history table (`spec/store` §7.6 — the
/// receipt's `purged`, 17.2 Phase 4b), in the order the receipt lists them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PurgedCounts {
    pub commits: usize,
    pub revisions: usize,
    pub blobs: usize,
    pub tree_nodes: usize,
    pub dispositions: usize,
    pub block_changes: usize,
    pub edge_transitions: usize,
    pub archives: usize,
}

impl PurgedCounts {
    /// `{ commits, revisions, blobs, tree_nodes, dispositions, block_changes,
    /// edge_transitions, archives }`, in that key order (both engines).
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = serde_json::Map::new();
        m.insert("commits".to_owned(), Json::from(self.commits));
        m.insert("revisions".to_owned(), Json::from(self.revisions));
        m.insert("blobs".to_owned(), Json::from(self.blobs));
        m.insert("tree_nodes".to_owned(), Json::from(self.tree_nodes));
        m.insert("dispositions".to_owned(), Json::from(self.dispositions));
        m.insert("block_changes".to_owned(), Json::from(self.block_changes));
        m.insert(
            "edge_transitions".to_owned(),
            Json::from(self.edge_transitions),
        );
        m.insert("archives".to_owned(), Json::from(self.archives));
        Json::Object(m)
    }

    /// Every count summed.
    #[must_use]
    pub fn total(&self) -> usize {
        self.commits
            + self.revisions
            + self.blobs
            + self.tree_nodes
            + self.dispositions
            + self.block_changes
            + self.edge_transitions
            + self.archives
    }
}

/// [`HistoryRecorder::purge`]'s outcome (`spec/store` §7.6): the rows removed
/// per table, the recorder's holds released (claims left with no holder
/// deleted), whether the bundle's tables were dropped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HistoryPurgeOutcome {
    pub purged: PurgedCounts,
    pub claims_released: usize,
    pub tables_dropped: bool,
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

/// One change of a block's biography (`spec/surface` §3 `blocks_history`):
/// the commit, its feed seq and instant, the provenance, the verdict and the
/// matcher's confidence and reason.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockChange {
    pub commit_id: String,
    pub seq: i64,
    pub ts: String,
    pub origin: String,
    pub kind: String,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
}

impl BlockChange {
    /// `{ commitId, seq, ts, origin, kind, confidence, reason }`, in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "commitId": self.commit_id,
            "seq": self.seq,
            "ts": self.ts,
            "origin": self.origin,
            "kind": self.kind,
            "confidence": self.confidence,
            "reason": self.reason,
        })
    }
}

/// One block-grain diff entry (`spec/surface` §3 `docs_diff`): the block's
/// `_id` and its raw `before`/`after` as applicable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffEntry {
    Removed {
        id: String,
        before: String,
    },
    Changed {
        id: String,
        before: String,
        after: String,
    },
    Added {
        id: String,
        after: String,
    },
}

impl DiffEntry {
    /// `{ kind, _id, before?, after? }`, in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            DiffEntry::Removed { id, before } => {
                serde_json::json!({ "kind": "removed", "_id": id, "before": before })
            }
            DiffEntry::Changed { id, before, after } => {
                serde_json::json!({ "kind": "changed", "_id": id, "before": before, "after": after })
            }
            DiffEntry::Added { id, after } => {
                serde_json::json!({ "kind": "added", "_id": id, "after": after })
            }
        }
    }
}

/// One version of a document as `docs_history` lists it (`spec/surface` §3,
/// 6.2 — resolution 11): a RETAINED version the history holds (`seq` and
/// `commit` set), or the current head UNRETAINED (`seq` null, the feed row
/// that minted it — null once pruned).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocVersion {
    pub rev: String,
    pub seq: Option<i64>,
    pub commit: Option<String>,
    pub ts: String,
    pub origin: Option<String>,
    pub actor: Option<String>,
    /// The content hash as hex.
    pub hash: String,
    pub is_current: bool,
    pub archived: bool,
    pub retained: bool,
}

impl DocVersion {
    /// `{ _rev, _seq, _commit, _ts, _origin, _actor, _hash, _is_current, _archived, retained }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "_rev": self.rev,
            "_seq": self.seq,
            "_commit": self.commit,
            "_ts": self.ts,
            "_origin": self.origin,
            "_actor": self.actor,
            "_hash": self.hash,
            "_is_current": self.is_current,
            "_archived": self.archived,
            "retained": self.retained,
        })
    }
}

/// The READ half of history (modular-core Phase 6a; `spec/surface` §3): what
/// the surface's history tools, the `revisions` query root and `doctor` ask
/// of whatever holds a repository's history. The native recorder implements
/// it over its own tables ([`HistoryRecorder`] extends it); an alternative
/// provider — the git history provider, `spec/store` §5.12 — implements it
/// over its own storage and attaches NO recorder (a `provider: git`
/// repository is captured asynchronously by a checkpoint worker, never
/// inside the commit transaction). The core reaches a repository's reader
/// through [`history_reader_for`](crate::core::manifest::history_reader_for),
/// which picks by the manifest row's `config.provider`. Every method runs
/// against the connection it is given.
pub trait HistoryReader {
    /// `spec/store` §6.2: the bytes at a revision (`docs_read { at }`);
    /// `None` when the token names no retained version of the document. A
    /// provider decides a token of its own form (a git sha) here — the
    /// `spec/surface` §3 table's `pruned` / `outside_coverage` /
    /// `target_missing` rows are its errors.
    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<RevisionRead>>;

    /// `blocks_history`: a block's biography, newest first (`limit` default
    /// 100). A provider without block lineage answers
    /// [`Error::HistoryUnsupported`].
    fn blocks_history(
        &self,
        conn: &Connection,
        block_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<BlockChange>>;

    /// `docs_diff`: the block-grain diff between two revisions — `removed`,
    /// `changed`, `added` in that order; an unknown revision is
    /// [`Error::TargetMissingRevision`]. [`Error::HistoryUnsupported`] on a
    /// provider without block identities.
    fn diff_blocks(
        &self,
        conn: &Connection,
        doc_id: &str,
        from_rev: &str,
        to_rev: &str,
    ) -> Result<Vec<DiffEntry>>;

    /// `docs_diff_unified`'s text: the unified diff of two revisions'
    /// reconstructed bytes ([`unified_diff`](crate::history::diff::unified_diff));
    /// an unknown revision is [`Error::TargetMissingRevision`].
    fn diff_unified(
        &self,
        conn: &Connection,
        doc_id: &str,
        from_rev: &str,
        to_rev: &str,
    ) -> Result<String>;

    /// The document's two most recent revision tokens, newest first — what
    /// `docs_diff_unified` defaults `to_rev` / `from_rev` to (the native
    /// recorder's rev ids; a provider's commit shas).
    fn latest_revisions(&self, conn: &Connection, doc_id: &str) -> Result<Vec<String>>;

    /// `docs_history`: the retained versions of one document, oldest first
    /// (`head` the document's current head, for `is_current`). The caller
    /// appends the unretained head (resolution 11) when none names it.
    fn doc_versions(
        &self,
        conn: &Connection,
        doc_id: &str,
        head: Option<&str>,
    ) -> Result<Vec<DocVersion>>;

    /// The disposition counts of a captured commit (`kind → n` in `kind`
    /// order, `same` never persisted) for a `changes_since` digest's summary
    /// — `None` when this history holds none for it.
    fn disposition_counts(
        &self,
        conn: &Connection,
        commit_id: &str,
    ) -> Result<Option<Vec<(String, i64)>>>;

    /// The `revisions` query root (`spec/surface` §1.1, 4.7; Phase 4a): every
    /// retained version of the repository's documents — tombstoned documents
    /// included, history is history — as the binding's rows, in the keyset
    /// order `(path as of the revision, rev_id)`.
    fn revision_rows(&self, conn: &Connection, repo_id: &str) -> Result<Vec<RevisionQueryRow>>;

    /// The `_revisions` relation of a document (`spec/surface` §1.2): its
    /// retained versions by `seq`.
    fn doc_revision_rows(&self, conn: &Connection, doc_id: &str) -> Result<Vec<RevisionQueryRow>>;

    /// Does this history hold a version under this token? (`docs_read { at }`
    /// tells a retained version from an unknown token by this; Phase 4a.)
    fn has_revision(&self, conn: &Connection, rev_id: &str) -> Result<bool>;

    /// `doctor`'s "capture complete" (`spec/cli` §6): the live documents whose
    /// head was minted at or after `since` and has no retained version.
    fn uncaptured_heads(&self, conn: &Connection, repo_id: &str, since: &str) -> Result<i64>;
}

/// The history capability: what the current-state core hands the recorder
/// per committed transition, and the history reads the store exposes
/// ([`HistoryReader`], the read half — Phase 6a). Every method runs against
/// the connection (or the open transaction) it is given; the recorder keeps
/// no state of its own.
pub trait HistoryRecorder: HistoryReader {
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

    /// §5.4 step 15 (17.0, 3e — M6; `spec/graph` §3.3): the transition's edge
    /// list — one `edge_transitions` row per opened edge (`from_commit` = this
    /// commit, `to_commit` NULL), `to_commit` = this commit on every closed
    /// one; sets the recorder's hold on the opened ids (§2.1).
    fn record_edge_transitions(
        &self,
        tx: &Connection,
        commit_id: &str,
        transitions: &EdgeTransitions,
    ) -> Result<()>;

    /// The core rewrote these open edges' destination in place (`spec/graph`
    /// §3.5 adoption, a move's re-phantoming): the open transition rows
    /// follow, so the interval record reads as 16.x's `edges` did.
    fn retarget_edges(&self, tx: &Connection, edge_ids: &[&str], dst_node: &str) -> Result<()>;

    // ---- the surface's reads: `HistoryReader` (`spec/surface` §3) ---------------------

    /// A captured revision's frontmatter raw, resolved through the recorder's
    /// own delta chain (`spec/store` §6.2 "Resolving"); `None` when it has
    /// none or the row is unknown. Migration 17's backfill reads it once per
    /// live head (§3.4 step 17). The recorder's alone: a provider has no
    /// delta chain.
    fn frontmatter_at_revision(&self, conn: &Connection, rev_id: &str) -> Result<Option<String>>;

    // (No current-state read goes THROUGH history any more: M1 retired
    // `current_frontmatter_raw`/`record_move` in 3a; M4 retired
    // `rendered_hash`/`previous_rendered_hash` in 3c — the pending row carries
    // `prior_hash` and the materializer renders from the current rows.)

    // ---- the capture lifecycle (`spec/store` §5.9, Phase 4a) ------------------------

    /// `history enable`'s baseline (`phase-1-contracts.md` §1.14): under
    /// `commit` — a feed row the core already appended (`origin = 'import'`,
    /// `reason = 'history enabled'`) — the `commits` row, a checkpoint
    /// `revisions` row for every live document whose head has none (`rev_id =
    /// docs.head`, the current tree and frontmatter, `seq = 1 + its greatest
    /// captured seq`), the recorder's hold on every live doc, head and block
    /// id, and the edge interval record reconciled with the open edges (a
    /// dangling open transition closed at this commit, an edge without one
    /// opened at it). Returns the revisions written. Runs in the caller's
    /// transaction.
    fn baseline(&self, tx: &Connection, commit: &CommitRecord<'_>) -> Result<usize>;

    /// `history purge`'s recorder half (`spec/store` §7.6, 17.2 Phase 4b):
    /// the repository's history rows — every commit, or those with `ts <
    /// before` — removed except, while `protect_heads` (the core's word that
    /// capture is on for the repository), a live head's revision and its
    /// commit; the retained revisions whose base went re-checkpointed first;
    /// the interval record trimmed to the cut (a transition closed before it
    /// goes, one open across it is re-anchored at the earliest retained
    /// commit); the segments nothing names detached; the unreachable bodies
    /// swept; then the recorder's hold released on every claim no history row
    /// names (a claim with no holder deleted — while `protect_heads` the live
    /// set keeps its hold, as a baseline would leave it); then, when
    /// `drop_if_empty` (the core's word that no repository is enabled) and
    /// every history table is empty, the bundle's tables dropped. Runs in the
    /// caller's transaction; the manifest is the core's.
    fn purge(
        &self,
        tx: &Connection,
        repo_id: &str,
        before: Option<&str>,
        drop_if_empty: bool,
        protect_heads: bool,
    ) -> Result<HistoryPurgeOutcome>;

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

// ---- the alternative history provider (`spec/store` §5.12, 17.5 — Phase 6a) -------------

/// Can the provider run on this host? (`git` on PATH for the git provider.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderAvailability {
    /// Usable; `detail` the version line or alike.
    Available { detail: String },
    /// Not usable here; `reason` the one-line why.
    Unavailable { reason: String },
}

/// `history enable --provider <name>`'s receipt from the provider: the
/// `config` the manifest row stores, the documents the baseline committed
/// and the branch tip after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderEnabled {
    pub config: Map<String, Json>,
    pub revisions: usize,
    pub tip: Option<String>,
}

/// `history purge` on a provider repository: what left (`spec/store` §5.12).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderPurge {
    pub removed: bool,
    /// The storage's path (the bare repository's).
    pub path: String,
}

/// `history checkpoint`'s receipt (`spec/store` §5.12, `spec/cli` §6): the
/// commits written, the feed span they cover, the branch tip, whether the
/// run was a rescan; `push` (17.6, Phase 6b) only when the remote binding's
/// `push` is `on-checkpoint` — the push that followed, or the error that
/// stopped it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointResult {
    pub committed: usize,
    pub from_seq: i64,
    pub to_seq: i64,
    pub tip: Option<String>,
    pub rescanned: bool,
    pub push: Option<PushOutcome>,
}

impl CheckpointResult {
    /// `{ committed, from_seq, to_seq, tip, rescanned, push? }`, in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("committed".to_owned(), Json::from(self.committed));
        m.insert("from_seq".to_owned(), Json::from(self.from_seq));
        m.insert("to_seq".to_owned(), Json::from(self.to_seq));
        m.insert(
            "tip".to_owned(),
            self.tip.clone().map_or(Json::Null, Json::String),
        );
        m.insert("rescanned".to_owned(), Json::Bool(self.rescanned));
        if let Some(p) = &self.push {
            m.insert("push".to_owned(), p.to_json());
        }
        Json::Object(m)
    }
}

// ---- the remote half (`spec/store` §5.12 "The remote binding" … "Divergence", 17.6 — Phase 6b) ----

/// `history push`'s receipt (`spec/store` §5.12 "Push", 17.6): whether
/// anything was pushed, the tip the remote now holds, the feed seq it covers
/// (`pushed_through`) and — the git provider's — what became of the ids ref
/// (`pushed` | `rejected` | `none`; absent on the wire when the provider has
/// no such ref).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushResult {
    pub pushed: bool,
    pub tip: Option<String>,
    pub pushed_through: Option<i64>,
    pub ids: Option<String>,
}

impl PushResult {
    /// `{ pushed, tip, pushed_through, ids? }`, in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("pushed".to_owned(), Json::Bool(self.pushed));
        m.insert(
            "tip".to_owned(),
            self.tip.clone().map_or(Json::Null, Json::String),
        );
        m.insert(
            "pushed_through".to_owned(),
            self.pushed_through.map_or(Json::Null, Json::from),
        );
        if let Some(ids) = &self.ids {
            m.insert("ids".to_owned(), Json::String(ids.clone()));
        }
        Json::Object(m)
    }
}

/// A push's outcome as a receipt carries it: the result, or `{ error }` (the
/// push that followed a checkpoint never fails the checkpoint; the sweep's
/// step 7 never fails the sweep).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushOutcome {
    Pushed(PushResult),
    Failed(String),
}

impl PushOutcome {
    /// The receipt's member: the result's JSON, or `{ "error": <message> }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            PushOutcome::Pushed(r) => r.to_json(),
            PushOutcome::Failed(e) => serde_json::json!({ "error": e }),
        }
    }
}

/// The relation of the engine's branch to the last known remote tip
/// (`spec/store` §5.12 "Remote status", 17.6): `in-sync` (the same commit),
/// `ahead` (the remote tip is an ancestor of ours — a push is due), `behind`
/// (ours is an ancestor of the remote's — a fetch fast-forwards), `diverged`
/// (neither — the remote was rewritten, or both sides moved), `unknown` (no
/// remote tip is known yet — nothing pushed or fetched).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteState {
    InSync,
    Ahead,
    Behind,
    Diverged,
    Unknown,
}

impl RemoteState {
    /// The wire spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            RemoteState::InSync => "in-sync",
            RemoteState::Ahead => "ahead",
            RemoteState::Behind => "behind",
            RemoteState::Diverged => "diverged",
            RemoteState::Unknown => "unknown",
        }
    }
}

/// `version.capabilities.history.remote` (`spec/surface` §4, 6.5): the
/// binding and where the two sides stand; `null` when no remote is bound.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteSummary {
    pub name: String,
    pub branch: String,
    pub state: RemoteState,
    pub pushed_through: Option<i64>,
}

impl RemoteSummary {
    /// `{ name, branch, state, pushed_through }`, in that key order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "name": self.name,
            "branch": self.branch,
            "state": self.state.as_str(),
            "pushed_through": self.pushed_through,
        })
    }
}

/// One inbound change a provider's remote half writes into the vault: the
/// bytes now at `path`, or `None` when the path is removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultChange {
    pub path: String,
    pub content: Option<Vec<u8>>,
}

/// The vault, as the remote half of a history provider writes INBOUND
/// content into it (`spec/store` §5.12 "Fetch", 17.6 — the design's "through
/// the existing source/reconciliation boundary"): a batch of changes applied
/// as EXTERNAL EDITS — the composition layer binds it to the repository's
/// filesystem root and the observe path (`omgbase-sync`'s `FsVaultSink`), a
/// fixture runner to `observe_batch` directly — so identities are matched by
/// the ordinary reconcile, the feed records the change and no row is written
/// by the provider. The Rust seam also LENDS THE CONNECTION: a sink owns the
/// store for the call's duration (the observe path needs it mutably), so the
/// provider reads its rows through [`HistoryVaultSink::conn`] between
/// applies, never holding one across them.
pub trait HistoryVaultSink {
    /// The store's connection, for the provider's reads and its own rows
    /// (the cursor, the alerts, the manifest).
    fn conn(&self) -> &Connection;

    /// Write `changes` into the vault at `ts` as one observed batch.
    fn apply(&mut self, changes: &[VaultChange], ts: &str) -> Result<()>;
}

/// What the freshness sweep's remote steps did (`spec/sync` §4.3 steps 7–8,
/// 4.6): the push (`periodic`), the fetch (`periodic`) — each the receipt or
/// `{ error }` — or `paused` while a divergence alert stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteSyncResult {
    pub pushed: Option<PushOutcome>,
    /// The fetch receipt as JSON, or `{ "error": <message> }`.
    pub fetched: Option<Json>,
    pub paused: bool,
}

impl RemoteSyncResult {
    /// `{ pushed, fetched, paused }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "pushed": self.pushed.as_ref().map(PushOutcome::to_json),
            "fetched": self.fetched,
            "paused": self.paused,
        })
    }
}

/// An alternative history provider (modular-core Phase 6a — "one alternative
/// strategy through the documented contract"; `spec/store` §5.12): what the
/// composition layer attaches for a history that is NOT the recorder's
/// tables. The core knows it by name — the manifest row's `config.provider`
/// — and reaches it through [`Capabilities::providers`]; it imports nothing
/// of the implementation (`omgbase-git-adapter`). A `provider: <name>`
/// repository has no recorder (`capture_for` is `None` — its commits write
/// the feed alone) and reads through [`HistoryProvider::reader`]; capture is
/// the provider's own asynchronous worker ([`HistoryProvider::checkpoint`]),
/// run by `omg history checkpoint` and by the freshness sweep.
pub trait HistoryProvider {
    /// The provider's name — the manifest row's `config.provider`.
    fn name(&self) -> &str;

    /// Is the provider usable here? Not → `capability_unavailable { history,
    /// unavailable, provider, reason }` on every read and the
    /// `history_provider_unavailable` alert; WRITES CONTINUE.
    fn available(&self) -> ProviderAvailability;

    /// The read half for a repository whose manifest names this provider,
    /// over the row's `config`.
    fn reader<'a>(
        &'a self,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Box<dyn HistoryReader + 'a>;

    /// `history enable --provider <name>`: initialise the provider's storage
    /// and write its BASELINE — the full current tree under the baseline
    /// feed row the core appended (`commit`) — inside the core's enable
    /// transaction (`tx`); the manifest row is written after it returns.
    /// `options` are the verb's (`branch`, `cadence` for git).
    fn enable(
        &self,
        tx: &Connection,
        repo_id: &str,
        commit: &CommitRecord<'_>,
        options: &Map<String, Json>,
    ) -> Result<ProviderEnabled>;

    /// `history purge` on a repository of this provider: delete its storage
    /// and its cursor (`spec/store` §7.6, §5.12). Runs in the caller's
    /// transaction.
    fn purge(
        &self,
        tx: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Result<ProviderPurge>;

    /// The checkpoint worker, once: read the feed from the cursor and write
    /// the provider's commits (`spec/store` §5.12) at `now`.
    fn checkpoint(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
    ) -> Result<CheckpointResult>;

    /// (17.6, Phase 6b) The remote binding's summary for `version` — `None`
    /// when the row binds no remote. Reads local refs only, never the network.
    fn remote_summary(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Result<Option<RemoteSummary>> {
        let _ = (conn, repo_id, config);
        Ok(None)
    }

    /// (17.6, Phase 6b) The freshness sweep's steps 7–8 (`spec/sync` §4.3):
    /// push when the binding says `periodic`, fetch when it says `periodic`;
    /// both paused while a divergence stands; `None` when no remote is bound.
    /// The inbound content enters through `vault`, which lends the connection.
    fn remote_sync(
        &self,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
        vault: &mut dyn HistoryVaultSink,
    ) -> Result<Option<RemoteSyncResult>> {
        let _ = (repo_id, config, now, vault);
        Ok(None)
    }
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
    /// The alternative history providers the composition layer attached
    /// (Phase 6a — the git provider in production), by [`HistoryProvider::name`];
    /// empty when none. The `full` and `git` compositions attach them, the
    /// three reduced 5a compositions attach none.
    pub providers: Vec<Rc<dyn HistoryProvider>>,
}

impl std::fmt::Debug for Capabilities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capabilities")
            .field("history", &self.history.is_some())
            .field("semantic", &self.semantic.is_some())
            .field("semantic_fault", &self.semantic_fault)
            .field(
                "providers",
                &self.providers.iter().map(|p| p.name()).collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

/// The environment variable the fixture runners and the binary honour
/// (`docs/modular-core/README.md`, Phase 2's gate; Phase 4a; Phase 5a — the
/// plan's four compositions, `spec/store` §9.6): `core` opens every store as
/// a CORE-ONLY BUILD — no history module, no semantic module
/// ([`Capabilities::core_only`]); `history` without the semantic module
/// ([`Capabilities::without_semantic`]); `semantic` without the history
/// module ([`Capabilities::without_history`]); unset, empty or `full` is
/// [`Capabilities::standard`](crate::Capabilities::standard). A TEST-ONLY
/// override, not a production switch: in production the composition is the
/// build's, and whether a repository's commits are captured is its manifest
/// row (`history enable|disable`, `spec/store` §5.9).
pub const CAPABILITIES_ENV: &str = "OMGBASE_CAPABILITIES";

/// The compositions of the modular-core plan (§5; Phase 6a added `git`):
/// what [`CAPABILITIES_ENV`] accepts. `full` is the default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Composition {
    Core,
    History,
    Semantic,
    Full,
    /// The core + the registered git history provider, no native recorder,
    /// no semantic module (`spec/store` §9.6's fifth composition, 17.5).
    Git,
}

/// Every composition, in the reference's order (`COMPOSITIONS`).
pub const COMPOSITIONS: [Composition; 5] = [
    Composition::Core,
    Composition::History,
    Composition::Semantic,
    Composition::Full,
    Composition::Git,
];

impl Composition {
    /// The composition's name on the wire (the environment value, the
    /// runners' ledger line).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Composition::Core => "core",
            Composition::History => "history",
            Composition::Semantic => "semantic",
            Composition::Full => "full",
            Composition::Git => "git",
        }
    }

    /// The composition a name denotes, if any.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        COMPOSITIONS.into_iter().find(|c| c.as_str() == s)
    }

    /// Does the composition carry the history module (`full`, `history`)?
    #[must_use]
    pub const fn has_history(self) -> bool {
        matches!(self, Composition::Full | Composition::History)
    }

    /// Does the composition carry the semantic module (`full`, `semantic`)?
    #[must_use]
    pub const fn has_semantic(self) -> bool {
        matches!(self, Composition::Full | Composition::Semantic)
    }

    /// Does the composition attach the registered alternative history
    /// providers — the git provider (Phase 6a)? `full` and `git`; the three
    /// reduced 5a compositions attach none.
    #[must_use]
    pub const fn has_git_provider(self) -> bool {
        matches!(self, Composition::Full | Composition::Git)
    }

    /// The composition a value of [`CAPABILITIES_ENV`] names: unset or empty
    /// → `full`; anything outside [`COMPOSITIONS`] is a configuration error
    /// (the reference's `envComposition`, the message alike).
    pub fn from_env_value(value: Option<&str>) -> Result<Self> {
        let v = value.unwrap_or("").trim();
        if v.is_empty() {
            return Ok(Composition::Full);
        }
        Self::parse(v).ok_or_else(|| {
            Error::Other(format!(
                "{CAPABILITIES_ENV}={v:?} is not a composition; use one of {} (the default is \"full\")",
                COMPOSITIONS
                    .iter()
                    .map(|c| format!("\"{}\"", c.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
    }

    /// The composition this process runs under ([`CAPABILITIES_ENV`]).
    pub fn from_env() -> Result<Self> {
        Self::from_env_value(std::env::var(CAPABILITIES_ENV).ok().as_deref())
    }
}

impl std::fmt::Display for Composition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Capabilities {
    /// The core alone (modular-core Phase 4a): no recorder, no provider, the
    /// `id_claims` oracle — what a core-only build is. A repository it
    /// creates starts with history `disabled` (`spec/store` §3.1); a
    /// repository whose manifest has history `enabled` with
    /// `writer_requires` refuses its writes (`require_writer` →
    /// [`Error::HistoryWriterRequired`] + the `writer_refused` alert); every
    /// history read answers [`Error::HistoryUnavailable`]; the `revisions`
    /// root lists nothing; the semantic calls raise `capability_unavailable {
    /// semantic, disabled }`. Through Phase 3 this composition still carried
    /// the recorder (every write needed it); Phase 4a made capture optional
    /// and dropped it here.
    #[must_use]
    pub fn core_only() -> Self {
        Self {
            history: None,
            semantic: None,
            semantic_fault: None,
            claims: Box::new(crate::core::claims::IdClaims),
            providers: Vec::new(),
        }
    }

    /// This set with an alternative history provider attached (Phase 6a):
    /// what the composition layer does for the `full` and `git` compositions
    /// before any store opens (the `omgbase` binary registers the git
    /// provider of `omgbase-git-adapter`; the fixture runners the same under
    /// the fixture identity). A provider of the same name replaces the
    /// earlier one.
    #[must_use]
    pub fn with_provider(mut self, provider: Box<dyn HistoryProvider>) -> Self {
        self.providers.retain(|p| p.name() != provider.name());
        // Shared handles (17.6, Phase 6b): the remote half's vault sink owns
        // the store for a call's duration, so the caller clones the
        // provider's handle out of the store first ([`crate::Store::provider_handle`]).
        self.providers.push(Rc::from(provider));
        self
    }

    /// This set without the semantic bundle (`disabled`).
    #[must_use]
    pub fn without_semantic(mut self) -> Self {
        self.semantic = None;
        self.semantic_fault = None;
        self
    }

    /// This set without the history module (modular-core Phase 5a; the
    /// plan's §5 third composition, `OMGBASE_CAPABILITIES=semantic`): a
    /// repository it creates is born `disabled`, an enabled repository's
    /// writes are refused under `writer_requires`, every history tool answers
    /// `capability_unavailable { history, unavailable }`, the `revisions` root
    /// lists nothing; the semantic bundle's DDL follows the composition as on
    /// the full one.
    #[must_use]
    pub fn without_history(mut self) -> Self {
        self.history = None;
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

    /// [`CAPABILITIES_ENV`] applied to `standard` (the plan's compositions,
    /// Phase 5a — `spec/store` §9.6): unset / empty / `full` → `standard`;
    /// `history` → `standard` without the semantic module; `semantic` →
    /// `standard` without the history module; `core` and `git` →
    /// [`Capabilities::core_only`] — a core-only build (Phase 4a: no
    /// recorder, no semantic module; `git` then gets the git provider from
    /// the composition layer, Phase 6a). Any other value is a configuration
    /// error naming the five.
    pub fn from_env(standard: impl FnOnce() -> Self) -> Result<Self> {
        Ok(Self::for_composition(Composition::from_env()?, standard))
    }

    /// The named composition over `standard` (the reference's
    /// `compositionCapabilities`).
    pub fn for_composition(composition: Composition, standard: impl FnOnce() -> Self) -> Self {
        match composition {
            Composition::Full => standard(),
            Composition::History => standard().without_semantic(),
            Composition::Semantic => standard().without_history(),
            // The providers are the composition layer's to attach
            // (`with_provider`): the core knows none by itself.
            Composition::Core | Composition::Git => Self::core_only(),
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

/// The history MODULE, or [`Error::HistoryUnavailable`] (`capability_unavailable
/// { history, unavailable }`, `phase-1-contracts.md` §2.1) when the
/// composition lacks it — what the retention verbs (`history
/// plan|export|attach|detach|list`) and the 16.x → 17 migration need: the
/// module itself, whatever a repository's manifest says. A COMMIT asks
/// [`capture_for`](crate::core::manifest::capture_for) instead — the recorder
/// only while the repository's capture is on (Phase 4a).
pub fn require_history(history: Option<&dyn HistoryRecorder>) -> Result<&dyn HistoryRecorder> {
    history.ok_or(Error::HistoryUnavailable)
}

/// The provider, or [`unavailable`]`("semantic")`.
pub fn require_semantic(semantic: Option<&dyn SemanticProvider>) -> Result<&dyn SemanticProvider> {
    semantic.ok_or_else(|| unavailable("semantic"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The five compositions (`spec/store` §9.6; Phase 6a added `git`): the
    /// names, what each carries, and the configuration error naming them all.
    #[test]
    fn the_five_compositions_and_what_they_carry() {
        assert_eq!(COMPOSITIONS.len(), 5);
        assert_eq!(Composition::parse("git"), Some(Composition::Git));
        assert_eq!(
            Composition::from_env_value(Some("git")).unwrap(),
            Composition::Git
        );
        assert_eq!(
            Composition::from_env_value(None).unwrap(),
            Composition::Full
        );
        assert!(Composition::Git.has_git_provider() && Composition::Full.has_git_provider());
        assert!(!Composition::History.has_git_provider() && !Composition::Core.has_git_provider());
        assert!(!Composition::Git.has_history() && !Composition::Git.has_semantic());
        let e = Composition::from_env_value(Some("none"))
            .unwrap_err()
            .to_string();
        assert_eq!(
            e,
            "OMGBASE_CAPABILITIES=\"none\" is not a composition; use one of \"core\", \"history\", \"semantic\", \"full\", \"git\" (the default is \"full\")"
        );
        let caps = Capabilities::for_composition(Composition::Git, Capabilities::core_only);
        assert!(caps.history.is_none() && caps.semantic.is_none() && caps.providers.is_empty());
    }
}
