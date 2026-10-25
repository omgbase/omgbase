//! # omgbase-store
//!
//! The omgbase store, Rust implementation: the embedded SQLite database that
//! owns block **identity**, **history** and the **current state** of a
//! repository of authored files. Files stay the source of truth for content;
//! the store adds stable block ids, an append-only history of revisions and
//! commits, the dispositions the matcher recorded, and the derived indexes
//! the query surfaces read. The contract is `spec/store/README.md` in the
//! omgbase repository — `schema.sql` (embedded verbatim as [`SCHEMA_SQL`]) is
//! the DDL, `spec/store/cases/*.json` the executable fixtures — and this
//! crate opens the same databases the TypeScript reference writes.
//!
//! ```
//! use omgbase_reconcile::Config;
//! use omgbase_store::{BatchItem, Store};
//!
//! let mut store = Store::open_in_memory()?;
//! let repo = store.create_repo("notes")?;
//! let ts = "2026-09-26T10:00:00.000Z";
//! let items = [BatchItem::observed("a.md", "# Title\n\nFirst.\n")];
//! let outcomes = store.observe_batch(&repo, &items, ts, &Config::default())?;
//! let o = outcomes[0].as_observed().unwrap();
//! assert!(o.converged && !o.echo);
//! assert_eq!(o.dispositions["inserted"], 2);
//! assert_eq!(store.reconstruct(&o.doc_id)?.as_deref(), Some("# Title\n\nFirst.\n"));
//!
//! // Re-observing what the store holds is an echo: no commit, no mint.
//! let again = store.observe_batch(&repo, &items, ts, &Config::default())?;
//! assert!(again[0].as_observed().unwrap().echo);
//! # Ok::<(), omgbase_store::Error>(())
//! ```
//!
//! ## Layering
//!
//! Since the modular-core program's Phase 1 (`docs/modular-core/README.md`)
//! the crate is three module trees and a composition root:
//!
//! - [`core`] — the current-state core: [`schema`]'s companion [`ids`]
//!   (§2.1–2.2) and [`mint`] (the checking minter over the
//!   [`IdentityClaims`] oracle, [`claims`]), [`time`] (§2.4), [`order_key`]
//!   (§4.3), [`codec`] (canonical attrs, hex), [`writers`] (the id-assigned
//!   body and the commit row's provenance), [`observe`] (§5: the observe
//!   commit, its history half handed to the recorder), [`properties`],
//!   [`graph`], [`derived`] (§4.5 sections, FTS, the pool sweep), [`read`]
//!   (§5.2, §6.1), [`text_search`] (`spec/search` §1.3), the `spec/mutate`
//!   host side ([`mutate`], [`doc_store`], [`macros`], [`links`], [`sugar`],
//!   [`docs_ops`], [`yaml_emit`], [`plan`], `effects`, [`effects_plan`]),
//!   [`materialize`] (§5.7) and [`size`] (§7 "Size") — and the seams,
//!   [`capabilities`]: [`HistoryRecorder`], [`SemanticProvider`],
//!   [`IdentityClaims`], bundled as [`Capabilities`].
//! - [`history`] — the recorder: [`history::writers`] (blobs, tree nodes,
//!   revisions, commits), [`tree`] (§4.1 encodings), [`delta`] (§4.1 "Delta
//!   nodes", §4.4, §6 over [`edit_script`]'s Myers script), [`history::feed`]
//!   (the `changes_since` feed of `spec/sync` §6), [`history::read`] (§6.2),
//!   [`gc`] (§7 mark-and-sweep), [`retention`] and [`archive`] (§7.1, 15.0);
//!   [`Recorder`] implements [`HistoryRecorder`] over them.
//! - [`semantic`] — the provider: [`search`] (`spec/search`: the embedding
//!   drain over the `embeddings`/`doc_embeddings` caches, vector and hybrid
//!   search, the vector side of `resolve`), the indexer's watermark and the
//!   `cosine` scalar; [`Provider`] implements [`SemanticProvider`]. Reached
//!   only through [`Store::semantic`] (Phase 2).
//! - this root — [`Store`], the opener ([`schema`]), and
//!   [`Capabilities::standard`]: the one place that names the core and both
//!   extensions. Every module keeps its pre-Phase-1 crate-root path
//!   (`omgbase_store::read`, `omgbase_store::archive`, …) through re-exports.
//!
//! The core names nothing of `history` or `semantic` and no SQL of the core
//! names a vector table (`tests/boundaries.rs`, with `boundary-allowlist.txt`
//! for what Phase 3 removes); the semantic layer names nothing of `history`. Since 13.7 every `api` request — a
//! changeset over N documents, a move with its retarget, a create, a delete —
//! commits as one transaction with one `commits` row through the internal
//! effect set (`effects`, not public API); since 14.0 it commits **DB-first**,
//! recording the files it owes as `pending_materializations` rows and writing
//! them after COMMIT ([`materialize`]: the replay the sweep, recovery and the
//! observe gate rule share). The public effect vocabulary of `spec/mutate`
//! §11 (mutate 2.3) is planned and executed over that executor by
//! [`effects_plan`] (`plan` / `execute` / `apply({ effects })`).
//!
//! Minted ids are opaque; the store asks its [`IdMinter`] for each one. The
//! default is the CSPRNG-backed [`RandomMinter`]; a fixture runner installs a
//! [`SequentialMinter`] through [`Store::open_in_memory_with_minter`]. Every
//! draw passes through the checking [`Mint`] (§2.1, 13.5): an id already
//! issued in this process or naming a row of its prefix's table is redrawn.

#![forbid(unsafe_code)]

pub mod core;
pub mod error;
pub mod history;
pub mod schema;
pub mod semantic;

// The modular-core layout (`docs/modular-core/README.md`, Phase 1): the
// current-state core, the history extension and the semantic extension are
// three module trees; every module keeps its old crate-root path through
// these re-exports, so `omgbase_store::read::reconstruct`,
// `omgbase_store::archive::revision_body`, `omgbase_store::search::…` and
// the rest resolve as before. `lib.rs` is the composition root: the one
// place that names both the core and its extensions.
pub(crate) use self::core::effects;
pub use self::core::{
    capabilities, claims, codec, derived, doc_store, docs_ops, effects_plan, graph, history_shapes,
    ids, links, macros, materialize, mint, mutate, observe, order_key, plan, properties, read,
    semantic_shapes, size, sugar, text_search, time, writers, yaml_emit,
};
pub use self::history::{archive, delta, edit_script, gc, retention, tree};
pub use self::semantic::search;

use std::path::Path;

use rusqlite::{Connection, Transaction, params};

pub use self::history::writers::{NewRevision, PreviousRevision, TreeWriteContext};
pub use self::semantic::{Provider, cosine_bytes};
pub use archive::{
    ARCHIVE_DIR, ARCHIVE_SQL, ARCHIVE_SUFFIX, Manifest, RevisionBody, parse_segment_file_name,
    read_manifest, segment_basename, segment_file_name,
};
pub use capabilities::{
    CAPABILITIES_ENV, Capabilities, CapabilityState, ChangesPage, CommitDigest, DigestRevision,
    DispositionRow, DocEmbedStats, EmbedStats, ForeignVectors, GcResult, HistoryRecorder,
    HistorySizeFigures, IdentityClaims, RecordedRevision, RevisionRead, RevisionTransition,
    SemanticProvider,
};
pub use claims::TableUnionClaims;
pub use codec::{canonical_attrs, canonical_json, from_hex, hash_hex};
pub use delta::{
    CHECKPOINT_EVERY, DeltaOp, Form, FrontmatterBlob, Node, ResolvedList, ResolvedTree,
    TreeResolver, is_checkpoint_seq,
};
pub use derived::{LIVE_LEAF_SQL, RebuildTarget};
pub use doc_store::{DocStore, FsDocStore, MemDocStore, NullDocStore};
pub use docs_ops::{DocMoveResult, DocOpContext, DocOpResult, Retargeted};
pub use edit_script::{EditOp, myers_script};
pub use effects_plan::{EffectsOutcome, PlanContext, Receipt};
pub use error::{Error, Result};
pub use gc::ARCHIVED_COMMITS_SQL;
pub use graph::ResolvedEdge;
pub use history::Recorder;
pub use history_shapes::{
    ArchiveListing, ArchiveState, AttachResult, AttachedSegment, ExportOptions, ExportResult,
    LadderKeep, LadderRung, RetentionDocPlan, RetentionOptions, RetentionOverride, RetentionPlan,
    RetentionPolicy, RetentionTotals, SegmentInfo, SquashResult, SweptBodies,
};
pub use ids::{IdMinter, RandomMinter, RepeatingMinter, SequentialMinter, is_valid_id, prefix_of};
pub use links::InboundLink;
pub use macros::{LinkRepair, LinkRepairCount, LinkRepairPlan, RetargetHit};
pub use materialize::{PendingKind, PendingRow};
pub use mint::{Deferred, MINT_GIVE_UP_AFTER, Mint, id_in_use};
pub use mutate::{
    ApplyOrigin, ApplyRequest, ApplyResult, Diff, DocInfo, Revision, find_doc_by_ref, is_id_ref,
    load_mut_doc,
};
pub use observe::{
    BatchItem, BatchOutcome, Committed, DeleteOutcome, ObserveOutcome, has_conflict_markers,
};
pub use omgbase_graph::{EdgeDescriptor, ProjectedNode};
pub use omgbase_mutate::{
    self as mutate_kernel, At, Effect as PublicEffect, Expect, MutBlock, MutDoc, MutationError, Op,
    OpResult, Opset, Parent, Plan, PlanOp, To,
};
pub use omgbase_properties::PropertyRow;
pub use omgbase_reconcile::{Config, MatchBlock, PoolEntry};
pub use omgbase_search::{
    Boosts, DocEmbedBlockRef, DocEmbedMethod, DocEmbedTask, EmbedTask, EmbeddingProvider, Evidence,
};
pub use retention::{evaluate_retention, merge_retention_policy, retention_policy};
pub use schema::{SCHEMA_SQL, SCHEMA_VERSION};
pub use search::{BlockContexts, ContextScope, DocVectorRow, block_vector};
pub use semantic_shapes::{
    CHUNKING_VERSION, DocVectorHit, DrainMode, DrainOutcome, DrainStats, HybridHit, HybridQuery,
    IndexIdentity, PrunedVectors, QueryVector, ResolveHit, SemanticFreshness, SemanticQueue,
    VectorHit,
};
pub use size::{
    SIZE_CATEGORIES, SizeArchived, SizeCategory, SizeFile, SizeReport, SizeRetention, SizeTable,
    TABLE_CATEGORY, VacuumResult, category_of, format_share, human_bytes, share_of, size_advice,
};
pub use sugar::Sugar;
pub use text_search::{TextHit, TextSearchResult};
pub use tree::{TreeEntry, serialize_tree_entries, serialize_tree_entry, tree_hash};
pub use writers::{NewCommit, Origin, TreeInputBlock};

/// The `spec/store/VERSION` this crate implements (`major.minor`); the major
/// is [`SCHEMA_VERSION`].
pub const SPEC_VERSION: &str = "16.0";

/// This crate's own version (`Cargo.toml`), for the surface's `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The one format this crate ingests (`docs.format`).
pub const FORMAT_MARKDOWN: &str = "markdown";

/// An open store: one connection, one id minter (behind the in-use check of
/// [`mint`]). All writes go through it.
pub struct Store {
    conn: Connection,
    ids: mint::IdSource,
    /// The history capability, when the store opened with one.
    history: Option<Box<dyn HistoryRecorder>>,
    /// The semantic capability, when the store opened with one.
    semantic: Option<Box<dyn SemanticProvider>>,
    /// Why `semantic` is `None` although one is configured (the
    /// `unavailable` state); `None` with no provider is `disabled`.
    semantic_fault: Option<String>,
    /// Test seam: runs inside [`Store::commit_effects`](effects) right after
    /// its `BEGIN IMMEDIATE`, before the validation — a test interleaves a
    /// second connection against the held write lock here.
    #[cfg(test)]
    pub(crate) after_begin: Option<Box<dyn FnMut() + Send>>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    /// Open (creating parent directories and the file as needed) with the
    /// production minter. `:memory:` is a valid path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_minter(path, Box::new(RandomMinter))
    }

    /// [`Store::open`] with a replaceable minter (§2.2) and the standard
    /// capabilities.
    pub fn open_with_minter(path: impl AsRef<Path>, minter: Box<dyn IdMinter>) -> Result<Self> {
        Self::open_with(path, minter, Capabilities::standard())
    }

    /// [`Store::open`] with a replaceable minter and the capabilities the
    /// composition layer assembled (`docs/modular-core/README.md`, Phase 1):
    /// the `omgbase` binary, the sync workspace and every fixture runner open
    /// through here or through the [`Capabilities::standard`] shorthands.
    pub fn open_with(
        path: impl AsRef<Path>,
        minter: Box<dyn IdMinter>,
        capabilities: Capabilities,
    ) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str() != ":memory:"
            && let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty())
        {
            std::fs::create_dir_all(dir)
                .map_err(|e| Error::Other(format!("cannot create {}: {e}", dir.display())))?;
        }
        Self::from_connection_with(Connection::open(path)?, minter, capabilities)
    }

    /// A fresh in-memory store (tests, fixtures).
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, Box::new(RandomMinter))
    }

    /// A fresh in-memory store with a replaceable minter.
    pub fn open_in_memory_with_minter(minter: Box<dyn IdMinter>) -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, minter)
    }

    /// A fresh in-memory store with a replaceable minter and the
    /// capabilities given (the fixture runners:
    /// [`Capabilities::standard_from_env`]).
    pub fn open_in_memory_with_capabilities(
        minter: Box<dyn IdMinter>,
        capabilities: Capabilities,
    ) -> Result<Self> {
        Self::from_connection_with(Connection::open_in_memory()?, minter, capabilities)
    }

    /// Adopt an existing connection with the standard capabilities: apply the
    /// §1 pragmas, register `cosine`, run the opener (fresh → `schema.sql`;
    /// older → migrations; newer → [`Error::SchemaTooNew`]).
    pub fn from_connection(conn: Connection, minter: Box<dyn IdMinter>) -> Result<Self> {
        Self::from_connection_with(conn, minter, Capabilities::standard())
    }

    /// [`Store::from_connection`] with the capabilities the composition layer
    /// assembled: the semantic provider attaches its `cosine` scalar, the
    /// claims oracle goes behind the checking minter, the recorder is what
    /// every commit records through.
    pub fn from_connection_with(
        conn: Connection,
        minter: Box<dyn IdMinter>,
        capabilities: Capabilities,
    ) -> Result<Self> {
        let Capabilities {
            history,
            semantic,
            semantic_fault,
            claims,
        } = capabilities;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if let Some(s) = &semantic {
            s.attach(&conn)?;
        }
        let mut ids = mint::IdSource::new(minter, claims);
        schema::migrate(&conn, &mut ids)?;
        Ok(Self {
            conn,
            ids,
            history,
            semantic,
            semantic_fault,
            #[cfg(test)]
            after_begin: None,
        })
    }

    /// The history capability this store opened with, if any.
    #[must_use]
    pub fn history(&self) -> Option<&dyn HistoryRecorder> {
        self.history.as_deref()
    }

    /// The semantic capability this store opened with, if any — the one way
    /// to a vector (Phase 2): `None` is the `disabled` or `unavailable`
    /// state ([`Store::semantic_state`]).
    #[must_use]
    pub fn semantic(&self) -> Option<&dyn SemanticProvider> {
        self.semantic.as_deref()
    }

    /// The semantic capability or [`capabilities::unavailable`]`("semantic")`.
    pub fn require_semantic(&self) -> Result<&dyn SemanticProvider> {
        capabilities::require_semantic(self.semantic.as_deref())
    }

    /// The history capability's state: `enabled` with a recorder, else
    /// `disabled` — the store runs without the module (both engines spell a
    /// module-less store so; no manifest row exists before Phase 3).
    #[must_use]
    pub fn history_state(&self) -> CapabilityState {
        if self.history.is_some() {
            CapabilityState::Enabled
        } else {
            CapabilityState::Disabled
        }
    }

    /// The semantic capability's state as the store knows it: `enabled` with
    /// a provider installed, `unavailable` when the configured one failed
    /// ([`Store::detach_semantic`] with a reason), else `disabled`. Whether a
    /// provider is *configured* for a repository (`phase-1-contracts.md` §7
    /// resolution 1) is the settings' business — the surface's `version`
    /// folds it in.
    #[must_use]
    pub fn semantic_state(&self) -> CapabilityState {
        match (&self.semantic, &self.semantic_fault) {
            (Some(_), _) => CapabilityState::Enabled,
            (None, Some(_)) => CapabilityState::Unavailable,
            (None, None) => CapabilityState::Disabled,
        }
    }

    /// The `unavailable` state's reason, if that is the state.
    #[must_use]
    pub fn semantic_fault(&self) -> Option<&str> {
        self.semantic_fault.as_deref()
    }

    /// Capability discovery (Phase 2): drop the semantic provider — the
    /// configured one failed to start (`Some(reason)` → `unavailable`,
    /// retriable), or the composition decided against the module after open
    /// (`None` → `disabled`). The `cosine` scalar a provider attached at open
    /// stays registered; nothing calls it once the provider is gone. Stored
    /// vectors are never consulted.
    pub fn detach_semantic(&mut self, fault: Option<String>) {
        self.semantic = None;
        self.semantic_fault = fault;
    }

    /// The recorder, or the capability-unavailable error.
    fn recorder(&self) -> Result<&dyn HistoryRecorder> {
        capabilities::require_history(self.history.as_deref())
    }

    /// The underlying connection.
    #[must_use]
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The store's checking minter (§2.1) over its connection.
    pub fn minter(&mut self) -> Mint<'_> {
        self.ids.at(&self.conn)
    }

    /// Mint an id with `prefix` (§2.1): never one in use.
    pub fn mint(&mut self, prefix: &str) -> Result<String> {
        self.minter().mint(prefix)
    }

    /// Begin a write transaction (one per commit, §1); rolls back on drop.
    pub fn transaction(&self) -> Result<Transaction<'_>> {
        Ok(self.conn.unchecked_transaction()?)
    }

    /// Create a repo with `slug` (**mints `rp`**); returns its id.
    pub fn create_repo(&mut self, slug: &str) -> Result<String> {
        let repo_id = self.mint("rp")?;
        self.conn.execute(
            "INSERT INTO repos (repo_id, slug) VALUES (?1, ?2)",
            params![repo_id, slug],
        )?;
        Ok(repo_id)
    }

    /// The repo id for `slug`, if any.
    pub fn repo_by_slug(&self, slug: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row(
                "SELECT repo_id FROM repos WHERE slug = ?1",
                params![slug],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// `PRAGMA user_version`.
    pub fn user_version(&self) -> Result<i64> {
        schema::user_version(&self.conn)
    }

    // ---- writers ------------------------------------------------------------------

    // The recorder's own writers, exposed for the fixture runners and the
    // tests that build history by hand (the composition root may name
    // `history::writers`; the core may not).

    /// [`history::writers::put_blob`].
    pub fn put_blob(&self, text: &str) -> Result<String> {
        history::writers::put_blob(&self.conn, text)
    }

    /// [`history::writers::put_tree_node`].
    pub fn put_tree_node(&self, entries: &[TreeEntry]) -> Result<String> {
        history::writers::put_tree_node(&self.conn, entries)
    }

    /// [`history::writers::write_block_tree`].
    pub fn write_block_tree(&self, blocks: &[TreeInputBlock]) -> Result<String> {
        history::writers::write_block_tree(&self.conn, blocks)
    }

    /// [`HistoryRecorder::new_commit`]; returns `(commit_id, seq)`.
    pub fn new_commit(&mut self, input: &NewCommit<'_>) -> Result<(String, i64)> {
        let recorder = capabilities::require_history(self.history.as_deref())?;
        recorder.new_commit(&self.conn, &mut self.ids.at(&self.conn), input)
    }

    /// [`history::writers::write_revision`]; returns `(rev_id, seq)`.
    pub fn write_revision(&mut self, input: &NewRevision<'_>) -> Result<(String, i64)> {
        history::writers::write_revision(&self.conn, &mut self.ids.at(&self.conn), input)
    }

    // ---- reads --------------------------------------------------------------------

    /// §6.1: the current bytes of a live doc; `None` when tombstoned or unknown.
    pub fn reconstruct(&self, doc_id: &str) -> Result<Option<String>> {
        read::reconstruct(&self.conn, doc_id)
    }

    /// §6.2: the bytes at a revision, from its Merkle root
    /// ([`HistoryRecorder::read_at_revision`]).
    pub fn read_at_revision(&self, doc_id: &str, rev_id: &str) -> Result<Option<RevisionRead>> {
        self.recorder()?
            .read_at_revision(&self.conn, doc_id, rev_id)
    }

    /// The change feed (`spec/sync` §6): the repo's commits with `seq >
    /// cursor`, optionally of one `origin`, `limit + 1` fetched to set
    /// `truncated`.
    pub fn changes_since(
        &self,
        repo_id: &str,
        cursor: i64,
        limit: usize,
        origin: Option<&str>,
    ) -> Result<ChangesPage> {
        self.recorder()?
            .changes_since(&self.conn, repo_id, cursor, limit, origin)
    }

    /// §5.2: the matcher's old side for a doc, from the live `blocks` rows.
    pub fn load_old_match_blocks(&self, doc_id: &str) -> Result<Vec<MatchBlock>> {
        read::load_old_match_blocks(&self.conn, doc_id)
    }

    /// §5.1: the repo's unexpired pool at `ts`.
    pub fn load_pool(&self, repo_id: &str, ts: &str) -> Result<Vec<PoolEntry>> {
        read::load_pool(&self.conn, repo_id, ts)
    }

    /// The document's live `properties` rows (`spec/properties` §1), in
    /// write order.
    pub fn properties(&self, doc_id: &str) -> Result<Vec<PropertyRow>> {
        properties::read_doc_properties(&self.conn, doc_id)
    }

    /// `spec/properties` §5 **grouped**: `{frontmatter, inline, computed}`
    /// (the `docs_read.properties` shape).
    pub fn properties_grouped(&self, doc_id: &str) -> Result<serde_json::Value> {
        Ok(omgbase_properties::grouped(&self.properties(doc_id)?))
    }

    /// `spec/properties` §5 **merged**: `{key: shape}` over every row.
    pub fn properties_merged(&self, doc_id: &str) -> Result<serde_json::Value> {
        Ok(omgbase_properties::merged(&self.properties(doc_id)?))
    }

    // ---- graph (spec/graph) -----------------------------------------------------------

    /// `spec/graph` §3.4: recompute one document's `doc_edges` from its open
    /// edges.
    pub fn rebuild_doc_edges(&self, doc_id: &str) -> Result<()> {
        graph::rebuild_doc_edges(&self.conn, doc_id)
    }

    // ---- derived ------------------------------------------------------------------

    /// §4.5: rebuild `sections` for one document.
    pub fn rebuild_sections(&self, doc_id: &str) -> Result<()> {
        derived::rebuild_sections(&self.conn, doc_id)
    }

    /// §7: recompute derived tables (the `block_changes` projection through
    /// [`HistoryRecorder::rebuild_projection`]).
    pub fn rebuild_index(&self, target: RebuildTarget) -> Result<()> {
        derived::rebuild_index(&self.conn, target, self.history.as_deref())
    }

    /// §7: mark-and-sweep garbage collection, flag-gated (off → no-op); since
    /// 14.2 the same sweep removes a 14.1 store's `same` disposition rows
    /// ([`HistoryRecorder::gc`]).
    pub fn gc(&self, enabled: bool) -> Result<GcResult> {
        self.recorder()?.gc(&self.conn, enabled)
    }

    /// What [`Store::gc`] would sweep, without deleting (§8 I5) — the three
    /// counts, the `same` rows (14.2) included.
    pub fn gc_dry_run(&self) -> Result<GcResult> {
        self.recorder()?.gc_dry_run(&self.conn)
    }

    /// §7 (14.2): the `same` disposition rows a store through 14.1 wrote.
    pub fn count_same_dispositions(&self) -> Result<usize> {
        self.recorder()?.count_same_dispositions(&self.conn)
    }

    /// §5.5: delete expired pool rows; returns how many.
    pub fn sweep_pool(&self, ts: &str) -> Result<usize> {
        derived::sweep_pool(&self.conn, ts)
    }

    /// §7 "Size" (14.1): what the database is made of — bytes per table
    /// through `dbstat`, grouped into categories, the file's pages, advice
    /// (the retention advice of 15.0 evaluated at the wall clock).
    pub fn size_report(&self) -> Result<SizeReport> {
        size::size_report(
            &self.conn,
            self.history.as_deref(),
            self.semantic.as_deref(),
        )
    }

    /// [`Store::size_report`] with the retention plans evaluated at `now`
    /// (the CLI's pinned clock under `OMGBASE_SPEC_CLOCK`).
    pub fn size_report_at(&self, now: &str) -> Result<SizeReport> {
        size::size_report_at(
            &self.conn,
            self.history.as_deref(),
            self.semantic.as_deref(),
            now,
        )
    }

    // ---- history retention (§7.1, 15.0) ------------------------------------------------

    /// The repo's effective retention policy: the defaults, the settings'
    /// `history.retention` over them, then `override_` (a CLI `--policy`).
    pub fn retention_policy(
        &self,
        repo_id: &str,
        override_: Option<&serde_json::Value>,
    ) -> Result<RetentionPolicy> {
        self.recorder()?
            .retention_policy(&self.conn, repo_id, override_)
    }

    /// §7.1 "The plan": what the policy would archive, at `opts.now`.
    pub fn retention_plan(&self, repo_id: &str, opts: &RetentionOptions) -> Result<RetentionPlan> {
        self.recorder()?.retention_plan(&self.conn, repo_id, opts)
    }

    /// §7.1 `history export [--prune]`: write one segment (**mints `s`**),
    /// or finish an unrecorded one, and with `prune` squash the store.
    pub fn export_history(&mut self, repo_id: &str, opts: &ExportOptions) -> Result<ExportResult> {
        let recorder = capabilities::require_history(self.history.as_deref())?;
        recorder.export_history(&self.conn, &mut self.ids.at(&self.conn), repo_id, opts)
    }

    /// §7.1 `history attach <file|dir>`: record a segment, or every segment
    /// of a directory that belongs to the repo.
    pub fn attach_archive(&self, repo_id: &str, target: &Path) -> Result<AttachResult> {
        self.recorder()?.attach_archive(&self.conn, repo_id, target)
    }

    /// §7.1 `history detach <segment_id|path>`: forget a segment; the id, or
    /// `None` when nothing matched.
    pub fn detach_archive(&self, repo_id: &str, r: &str) -> Result<Option<String>> {
        self.recorder()?.detach_archive(&self.conn, repo_id, r)
    }

    /// §7.1 `history list`: the recorded segments, then the unrecorded ones
    /// under `dest` when given.
    pub fn list_archives(&self, repo_id: &str, dest: Option<&Path>) -> Result<Vec<ArchiveListing>> {
        self.recorder()?.list_archives(&self.conn, repo_id, dest)
    }

    /// §6.2: a revision's row with its bodies resolved — through its segment
    /// when archived ([`Error::RevisionArchived`] when unavailable). The
    /// recorder's own read, named from the composition root (the surface's
    /// `docs_diff` walks the resolved tree itself).
    pub fn revision_body(
        &self,
        rev_id: &str,
        doc_id: Option<&str>,
    ) -> Result<Option<RevisionBody>> {
        archive::revision_body(&self.conn, rev_id, doc_id)
    }

    /// §7 (14.1): `freelist_count * page_size`, what [`Store::vacuum`] would return.
    pub fn reclaimable_bytes(&self) -> Result<u64> {
        size::reclaimable_bytes(&self.conn)
    }

    /// §7 (14.1): `VACUUM` the database; returns the free-page bytes it returned.
    pub fn vacuum(&self) -> Result<VacuumResult> {
        size::vacuum(&self.conn)
    }

    /// Close the connection.
    pub fn close(self) -> Result<()> {
        self.conn.close().map_err(|(_, e)| Error::Sqlite(e))
    }
}

impl Capabilities {
    /// What every store opens with today: the recorder over the store's own
    /// history tables ([`Recorder`]), the embedding caches ([`Provider`]) and
    /// the §2.1 table-union oracle ([`TableUnionClaims`]). Assembled here, on
    /// the composition root — the one module that names the core and both
    /// extensions.
    #[must_use]
    pub fn standard() -> Self {
        Self {
            history: Some(Box::new(Recorder)),
            semantic: Some(Box::new(Provider)),
            semantic_fault: None,
            claims: Box::new(TableUnionClaims),
        }
    }

    /// [`Capabilities::from_env`] over [`Capabilities::standard`]: what every
    /// fixture runner opens with, so `OMGBASE_CAPABILITIES=core` runs the
    /// suites without the semantic bundle.
    pub fn standard_from_env() -> Result<Self> {
        Self::from_env(Self::standard)
    }
}

#[cfg(test)]
mod tests;
