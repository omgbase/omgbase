//! # omgbase-store
//!
//! The omgbase store, Rust implementation: the embedded SQLite database that
//! owns block **identity**, **history** and the **current state** of a
//! repository of authored files. Files stay the source of truth for content;
//! the store adds stable block ids, an append-only history of revisions and
//! commits, the dispositions the matcher recorded, and the derived indexes
//! the query surfaces read. The contract is `spec/store/README.md` in the
//! omgbase repository — `schema.sql`, `schema-history.sql` and
//! `schema-semantic.sql` (embedded verbatim as [`SCHEMA_SQL`], [`HISTORY_SQL`],
//! [`SEMANTIC_SQL`]: the core, history and semantic bundles' DDL) are the
//! schema, `spec/store/cases/*.json` the executable fixtures — and this
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
//!   [`graph`], [`derived`] (§4.5 sections, FTS, the pool sweep), [`feed`]
//!   (§3.1 the change feed, §5.4 step 5, §7.4 its retention, `spec/surface`
//!   §3 `changes_since` — 17.0, D7/M5) over [`settings`], [`read`]
//!   (§5.2, §6.1), [`text_search`] (`spec/search` §1.3), the `spec/mutate`
//!   host side ([`mutate`], [`doc_store`], [`macros`], [`links`], [`sugar`],
//!   [`docs_ops`], [`yaml_emit`], [`plan`], `effects`, [`effects_plan`]),
//!   [`materialize`] (§5.7) and [`size`] (§7 "Size") — and the seams,
//!   [`capabilities`]: [`HistoryRecorder`] (its read half [`HistoryReader`]),
//!   [`SemanticProvider`], [`IdentityClaims`] and — Phase 6a — the
//!   [`HistoryProvider`] seam an alternative history (the git provider of
//!   `omgbase-git-adapter`, `spec/store` §5.12) is attached through, bundled
//!   as [`Capabilities`].
//! - [`history`] — the recorder: [`history::writers`] (blobs, tree nodes,
//!   revisions, the commit log — the feed row's twin), [`tree`] (§4.1
//!   encodings), [`delta`] (§4.1 "Delta nodes", §4.4, §6 over
//!   [`edit_script`]'s Myers script), [`history::read`] (§6.2), [`gc`] (§7
//!   mark-and-sweep), [`retention`] and [`archive`] (§7.1, 15.0);
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
    alerts, capabilities, claims, codec, derived, doc_store, docs_ops, effects_plan, fault, feed,
    graph, history_shapes, ids, legacy_bytes, links, macros, manifest, materialize, mint, mutate,
    observe, order_key, plan, properties, read, semantic_shapes, settings, size, sugar,
    text_search, time, writers, yaml_emit,
};
pub use self::history::{archive, delta, diff, edit_script, gc, retention, tree};
pub use self::semantic::search;

use std::path::Path;

use rusqlite::{Connection, Transaction, params};

pub use self::history::writers::{NewRevision, PreviousRevision, TreeWriteContext};
pub use self::semantic::{Provider, cosine_bytes};
pub use alerts::{
    Alert, AlertInput, AlertSeverity, CAPTURE_FAILED_ALERT, HISTORY_PROVIDER_UNAVAILABLE_ALERT,
    MATERIALIZATION_BACKLOG_ALERT, MATERIALIZATION_FAILED_ALERT, RECORDER_SCHEMA_UNKNOWN_ALERT,
    RECOVERY_ALERT_AFTER_MINUTES_DEFAULT, SEGMENT_DETACHED_ALERT, active_alerts,
    active_alerts_json, alert_after_minutes, clear_alert, list_active_alerts,
    materialization_backlog_message, materialization_failed_message, raise_alert,
    refresh_backlog_alert,
};
pub use archive::{
    ARCHIVE_DIR, ARCHIVE_SQL, ARCHIVE_SUFFIX, Manifest, RevisionBody, parse_segment_file_name,
    read_manifest, segment_basename, segment_file_name,
};
pub use capabilities::{
    BlockChange, CAPABILITIES_ENV, COMPOSITIONS, Capabilities, CapabilityState, CheckpointResult,
    Composition, DiffEntry, DispositionRow, DocEmbedStats, DocVersion, EmbedStats, ForeignVectors,
    GcResult, HistoryProvider, HistoryPurgeOutcome, HistoryReader, HistoryRecorder,
    HistorySizeFigures, IdentityClaims, ProviderAvailability, ProviderEnabled, ProviderPurge,
    PurgedCounts, RecordedRevision, RevisionQueryRow, RevisionRead, RevisionTransition,
    SemanticProvider,
};
pub use claims::{ClaimScope, IdClaims};
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
pub use fault::{
    ArmedFault, FAULT_ENV, FAULT_SITES, FaultSite, armed_fault, fault_passes, fault_point,
    injected_fault_message, parse_fault, reset_faults, set_armed_fault,
};
pub use feed::{
    ChangesPage, ChangesSinceOptions, CommitDigest, DigestRevision, ExpiredCursor,
    FEED_CAPPED_ALERT, FeedEntryKind, FeedPolicy, FeedRow, FeedStatus, NewFeedRow,
    feed_capped_message, feed_policy, feed_status, prune_feed, remint_epoch, render_summary,
    repo_epoch, repo_feed_policy,
};
pub use gc::ARCHIVED_COMMITS_SQL;
pub use graph::{EdgeRow, EdgeTransitions, ResolvedEdge};
pub use history::Recorder;
pub use history_shapes::{
    ArchiveListing, ArchiveState, AttachResult, AttachedSegment, ExportOptions, ExportResult,
    LadderKeep, LadderRung, RetentionDocPlan, RetentionOptions, RetentionOverride, RetentionPlan,
    RetentionPolicy, RetentionTotals, SegmentInfo, SquashResult, SweptBodies,
};
pub use ids::{IdMinter, RandomMinter, RepeatingMinter, SequentialMinter, is_valid_id, prefix_of};
pub use legacy_bytes::{
    LEGACY_BYTES_ALERT, LEGACY_BYTES_SAMPLE, UnreproducibleDoc, legacy_bytes_active,
    legacy_bytes_detail, legacy_bytes_message, legacy_bytes_suspected, refresh_legacy_bytes_alert,
    unreproducible_docs,
};
pub use links::InboundLink;
pub use macros::{LinkRepair, LinkRepairCount, LinkRepairPlan, RetargetHit};
pub use manifest::{
    CoverageInterval, HISTORY_DATA_V, HISTORY_DISABLED_MESSAGE, HISTORY_ENABLED_REASON,
    HISTORY_INTERFACE_V, HISTORY_UNAVAILABLE_MESSAGE, HISTORY_WRITER_REQUIRED_MESSAGE,
    HistoryLifecycleResult, HistoryPurgeResult, HistoryReaderRef, ManifestRow, ManifestState,
    NATIVE_PROVIDER, ProviderPurgeOutcome, SEMANTIC_DATA_V, SEMANTIC_INTERFACE_V,
    SEMANTIC_PROVIDER_MISSING_MESSAGE, SEMANTIC_SWITCHED_OFF_FIX, SEMANTIC_SWITCHED_OFF_MESSAGE,
    SemanticLifecycleResult, WRITER_REFUSED_ALERT, WRITER_REFUSED_MESSAGE, any_history_enabled,
    apply_history_bundle, attached_provider, canonical_config_json, capture,
    capture_failed_message, capture_for, claim_minted_at, clear_capture_failed,
    clear_provider_unavailable, config_hash, coverage_from, disable_history, disable_semantic,
    docs_history_reader, enable_history, enable_semantic, ensure_manifest, history_bundle_present,
    history_checkpoint, history_completeness, history_outside_coverage_message,
    history_provider_conflict_message, history_provider_not_attached_message, history_provider_of,
    history_provider_unavailable_message, history_pruned_message, history_read_refusal,
    history_reader, history_reader_for, history_reader_for_doc, history_reader_if_available,
    history_unsupported_message, in_coverage, open_coverage_from, provider_config_of,
    purge_history, raise_capture_failed, raise_provider_unavailable, read_capabilities,
    read_capability, refresh_semantic_manifest, refresh_semantic_manifests, require_history_reader,
    require_provider, require_writer, semantic_provider_of, semantic_switched_off, writer_for,
};
pub use materialize::{PendingKind, PendingRow, supersede};
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
pub use schema::{ALL_SQL_FILES, HISTORY_SQL, SCHEMA_SQL, SCHEMA_VERSION, SEMANTIC_SQL};
pub use search::{BlockContexts, ContextScope, DocVectorRow, block_vector};
pub use semantic_shapes::{
    CHUNKING_VERSION, DocVectorHit, DrainMode, DrainOutcome, DrainStats, HybridHit, HybridQuery,
    IndexIdentity, PrunedVectors, QueryVector, ResolveHit, SemanticFreshness, SemanticQueue,
    VectorHit,
};
pub use size::{
    FeedCapAdvice, SIZE_CATEGORIES, SizeArchived, SizeCapability, SizeCategory, SizeFeed, SizeFile,
    SizeReport, SizeRetention, SizeTable, TABLE_CATEGORY, VacuumResult, category_of, format_share,
    human_bytes, share_of, size_advice,
};
pub use sugar::Sugar;
pub use text_search::{TextHit, TextSearchResult};
pub use tree::{TreeEntry, serialize_tree_entries, serialize_tree_entry, tree_hash};
pub use writers::{CommitRecord, Origin, TreeInputBlock};

/// The `spec/store/VERSION` this crate implements (`major.minor`); the major
/// is [`SCHEMA_VERSION`].
pub const SPEC_VERSION: &str = "17.5";

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
    /// The alternative history providers the composition layer attached
    /// (Phase 6a), by name.
    providers: Vec<Box<dyn HistoryProvider>>,
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
        Self::from_connection_at(conn, minter, capabilities, &time::now_ts())
    }

    /// [`Store::from_connection_with`] with the opener's clock: what a
    /// migration writes where `spec/store` §3.4 says "the migration's clock"
    /// (a timestamp with no commit to anchor on; the manifest's
    /// `updated_at`, 3e-ii). The reference pins `Date` for the whole
    /// process; the fixture runners pass the fixture clock here
    /// (`spec/store` §9.3), production the wall clock.
    pub fn from_connection_at(
        conn: Connection,
        minter: Box<dyn IdMinter>,
        capabilities: Capabilities,
        now: &str,
    ) -> Result<Self> {
        let Capabilities {
            history,
            semantic,
            semantic_fault,
            claims,
            providers,
        } = capabilities;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if let Some(s) = &semantic {
            s.attach(&conn)?;
        }
        let mut ids = mint::IdSource::new(minter, claims);
        // The recorder is bound BEFORE the migration (17.0): step 17's
        // backfill resolves every live head's frontmatter through it.
        schema::migrate(&conn, &mut ids, history.as_deref(), now)?;
        Self::apply_bundles(&conn, history.is_some(), semantic.is_some())?;
        Ok(Self {
            conn,
            ids,
            history,
            semantic,
            semantic_fault,
            providers,
            #[cfg(test)]
            after_begin: None,
        })
    }

    /// The capability bundles (`spec/store` §3.1 "Which bundles a database
    /// holds", 17.1 Phase 4a), after the migration, on every open: the
    /// SEMANTIC bundle's DDL whenever the composition carries the semantic
    /// module — its reads (`queue` for `omg status`, the `available` gate, the
    /// vector cache) probe the tables without consulting the manifest, so the
    /// module's tables exist iff the module is loaded; the HISTORY bundle's
    /// DDL when any repository of the database has history `enabled` (one
    /// database holds every repository; the tables are harmless when present
    /// and unused) — `history enable` and `create_repo` execute it at the
    /// moment a row becomes `enabled`, so this is the safety net for a
    /// database written by another engine. Every statement is `CREATE … IF
    /// NOT EXISTS`. A database with no `docs` table (the
    /// `already-current-is-untouched` fixture) is left exactly as it is, as
    /// the 17-finishing step leaves it.
    fn apply_bundles(conn: &Connection, history: bool, semantic: bool) -> Result<()> {
        if !schema::table_exists(conn, "docs")? {
            return Ok(());
        }
        if semantic {
            conn.execute_batch(SEMANTIC_SQL)?;
        }
        if history && manifest::any_history_enabled(conn)? {
            manifest::apply_history_bundle(conn)?;
        }
        Ok(())
    }

    /// The history MODULE this store opened with, if any (the composition's;
    /// whether a repository's commits are captured is its manifest row —
    /// [`Store::capture_for`]).
    #[must_use]
    pub fn history(&self) -> Option<&dyn HistoryRecorder> {
        self.history.as_deref()
    }

    /// The recorder a commit on `repo_id` captures through
    /// ([`manifest::capture_for`]): the module iff the repository's manifest
    /// row is `enabled`; with `None`, the module iff the bundle's tables exist.
    pub fn capture_for(&self, repo_id: Option<&str>) -> Result<Option<&dyn HistoryRecorder>> {
        manifest::capture_for(&self.conn, self.history.as_deref(), repo_id)
    }

    /// The recorder a history READ goes through ([`manifest::history_reader`]):
    /// the module when the bundle's tables exist, else `None`.
    pub fn history_reader(&self) -> Result<Option<&dyn HistoryRecorder>> {
        manifest::history_reader(&self.conn, self.history.as_deref())
    }

    /// The reader a history TOOL reads through, or the refusal
    /// ([`manifest::require_history_reader`]: [`Error::HistoryUnavailable`]
    /// without the module, [`Error::HistoryDisabled`] when nothing was ever
    /// captured in this database; with a `repo_id`, a provider repository's
    /// reader or [`Error::HistoryProviderUnavailable`] — Phase 6a).
    pub fn require_history_reader(&self, repo_id: Option<&str>) -> Result<HistoryReaderRef<'_>> {
        manifest::require_history_reader(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            &time::now_ts(),
        )
    }

    /// The alternative history providers this store opened with (Phase 6a).
    #[must_use]
    pub fn providers(&self) -> &[Box<dyn HistoryProvider>] {
        &self.providers
    }

    /// The attached provider named `name`, if any.
    #[must_use]
    pub fn provider(&self, name: &str) -> Option<&dyn HistoryProvider> {
        manifest::attached_provider(&self.providers, name)
    }

    /// The reader a repository's history is read through
    /// ([`manifest::history_reader_for`], Phase 6a): the recorder when the
    /// row names no provider and the bundle exists, the attached provider's
    /// reader when it names one (or its refusal).
    pub fn history_reader_for(&self, repo_id: &str) -> Result<Option<HistoryReaderRef<'_>>> {
        manifest::history_reader_for(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            &time::now_ts(),
        )
    }

    /// [`Store::history_reader_for`] that never refuses
    /// ([`manifest::history_reader_if_available`]): the `revisions` root.
    pub fn history_reader_if_available(
        &self,
        repo_id: &str,
    ) -> Result<Option<HistoryReaderRef<'_>>> {
        manifest::history_reader_if_available(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            &time::now_ts(),
        )
    }

    /// `docs_history`'s reader ([`manifest::docs_history_reader`]): never
    /// `disabled`; `unavailable` without the module; a provider repository's
    /// reader or its refusal.
    pub fn docs_history_reader(&self, repo_id: &str) -> Result<HistoryReaderRef<'_>> {
        manifest::docs_history_reader(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            &time::now_ts(),
        )
    }

    /// `spec/store` §5.12 `history checkpoint` ([`manifest::history_checkpoint`],
    /// Phase 6a): the attached provider's worker, once, at `now`. The caller
    /// holds the writer lock.
    pub fn history_checkpoint(&self, repo_id: &str, now: &str) -> Result<CheckpointResult> {
        manifest::history_checkpoint(&self.conn, &self.providers, repo_id, now)
    }

    /// TEST SEAM (the fixture runners' `recorder_fault` device, `spec/store`
    /// §9.4): replace the history module this store runs with — a wrapper
    /// whose capture calls fail stands in for the recorder, then the original
    /// comes back. Returns the module replaced. Not a production path: the
    /// composition is fixed at open.
    pub fn set_history(
        &mut self,
        history: Option<Box<dyn HistoryRecorder>>,
    ) -> Option<Box<dyn HistoryRecorder>> {
        std::mem::replace(&mut self.history, history)
    }

    /// `spec/store` §5.9 `history enable` ([`manifest::enable_history`]) at
    /// `now`: the baseline commit and the open coverage interval;
    /// `writer_requires` the flag (`--best-effort` passes false). The caller
    /// holds the writer lock.
    pub fn enable_history(
        &mut self,
        repo_id: &str,
        now: &str,
        writer_requires: bool,
    ) -> Result<HistoryLifecycleResult> {
        self.enable_history_with(repo_id, now, writer_requires, None, &serde_json::Map::new())
    }

    /// [`Store::enable_history`] with the provider named (`spec/store` §5.12,
    /// Phase 6a): `history enable --provider <name>` with the verb's options
    /// (`branch`, `cadence`); `None` is the native recorder.
    pub fn enable_history_with(
        &mut self,
        repo_id: &str,
        now: &str,
        writer_requires: bool,
        provider: Option<&str>,
        provider_options: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<HistoryLifecycleResult> {
        let Store {
            conn,
            ids,
            history,
            providers,
            ..
        } = self;
        manifest::enable_history(
            conn,
            &mut ids.at(conn),
            history.as_deref(),
            providers,
            repo_id,
            now,
            writer_requires,
            provider,
            provider_options,
        )
    }

    /// `spec/store` §5.9 `history disable` ([`manifest::disable_history`]) at `now`.
    pub fn disable_history(&self, repo_id: &str, now: &str) -> Result<HistoryLifecycleResult> {
        manifest::disable_history(&self.conn, repo_id, now)
    }

    /// `spec/store` §7.6 `history purge [--before <ts>]`
    /// ([`manifest::purge_history`], 17.2 Phase 4b): the repository's
    /// captured history leaves the store — every commit, or those with `ts <
    /// before`; a live head's revision stays while capture is on; the
    /// recorder's holds are released; the bundle's tables are dropped when no
    /// repository is enabled and nothing is left. Coverage is untouched. The
    /// caller holds the writer lock.
    pub fn purge_history(&self, repo_id: &str, before: Option<&str>) -> Result<HistoryPurgeResult> {
        self.purge_history_at(repo_id, before, &time::now_ts())
    }

    /// [`Store::purge_history`] with the alert channel's clock pinned (a
    /// provider that cannot run raises `history_provider_unavailable` at `now`).
    pub fn purge_history_at(
        &self,
        repo_id: &str,
        before: Option<&str>,
        now: &str,
    ) -> Result<HistoryPurgeResult> {
        manifest::purge_history(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            before,
            now,
        )
    }

    /// `spec/surface` §3's read-state decision table
    /// ([`manifest::history_read_refusal`], Phase 4b) for a revision token the
    /// recorder holds no row for: the error to answer with.
    #[must_use]
    pub fn history_read_refusal(
        &self,
        repo_id: &str,
        rev: &str,
        doc_id: Option<&str>,
        read_fix: bool,
    ) -> Error {
        manifest::history_read_refusal(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            repo_id,
            rev,
            doc_id,
            read_fix,
            &time::now_ts(),
        )
    }

    /// `spec/store` §5.10 `embed enable` ([`manifest::enable_semantic`], Phase
    /// 4b) at `now`: needs the module and a configured provider. The caller
    /// holds the writer lock.
    pub fn enable_semantic(&self, repo_id: &str, now: &str) -> Result<SemanticLifecycleResult> {
        manifest::enable_semantic(&self.conn, self.semantic_module_present(), repo_id, now)
    }

    /// `spec/store` §5.10 `embed disable` ([`manifest::disable_semantic`]) at `now`.
    pub fn disable_semantic(&self, repo_id: &str, now: &str) -> Result<SemanticLifecycleResult> {
        manifest::disable_semantic(&self.conn, repo_id, now)
    }

    /// `spec/store` §5.10: is the repository's semantic row switched off while
    /// a provider is configured ([`manifest::semantic_switched_off`]) — the
    /// state only `omg embed disable` leaves? The semantic paths then refuse
    /// with [`Error::SemanticSwitchedOff`].
    pub fn semantic_switched_off(&self, repo_id: &str) -> Result<bool> {
        manifest::semantic_switched_off(&self.conn, self.semantic_module_present(), repo_id)
    }

    /// Does the composition carry the semantic MODULE — installed, or
    /// configured but failed to start (the host's fault, `unavailable`)? A
    /// core-only build has neither.
    fn semantic_module_present(&self) -> bool {
        self.semantic.is_some() || self.semantic_fault.is_some()
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

    /// The history capability's state as the COMPOSITION knows it: `enabled`
    /// with a recorder, else `unavailable` — the store runs without the module
    /// (a core-only build, Phase 4a). Per repository the manifest row answers
    /// (`spec/store` §3.1 `capabilities`, 3e-ii; `omgbase-sync`'s
    /// `capability_states`).
    #[must_use]
    pub fn history_state(&self) -> CapabilityState {
        if self.history.is_some() {
            CapabilityState::Enabled
        } else {
            CapabilityState::Unavailable
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

    /// Create a repo with `slug` (**mints `rp`**, then its EPOCH — **`ep`**,
    /// §3.1 `repos.epoch`, 17.0 D7); returns its id. The repo's own claim
    /// (`spec/store` §2.1, 17.0) is written under itself at the wall clock —
    /// no commit `ts` exists here — and the epoch's the same way; so are the
    /// manifest rows (§3.1 `capabilities`, 3e-ii). A caller with a pinned
    /// clock uses [`Store::create_repo_at`].
    pub fn create_repo(&mut self, slug: &str) -> Result<String> {
        self.create_repo_at(slug, &time::now_ts())
    }

    /// [`Store::create_repo`] at `now`: the `rp`/`ep` claims, and the
    /// manifest rows — history `enabled` with coverage from the repository's
    /// birth (`writer_requires` 1) when the composition carries the recorder
    /// (else `disabled`, Phase 4a), semantic `enabled` iff
    /// `embedding.provider` resolves for it (resolution 1) — all stamped
    /// `now` (the reference's `ensureRepo` under its pinned `Date`).
    pub fn create_repo_at(&mut self, slug: &str, now: &str) -> Result<String> {
        self.create_repo_with(slug, now, true)
    }

    /// [`Store::create_repo_at`] with the new repository's history capture
    /// chosen (`spec/store` §3.1, Phase 4a): `history: false` creates it
    /// `disabled` with no coverage (`omg source add --no-history`; a
    /// fixture's `capabilities: { history: false }`); `true` is the default —
    /// `enabled` when the composition carries the recorder. A composition
    /// without the recorder always creates a disabled repository.
    pub fn create_repo_with(&mut self, slug: &str, now: &str, history: bool) -> Result<String> {
        let repo_id = self.mint("rp")?;
        self.minter().claim("rp", &repo_id, Some(&repo_id), now)?;
        let epoch = feed::mint_epoch(&mut self.minter(), &repo_id, now)?;
        self.conn.execute(
            "INSERT INTO repos (repo_id, slug, epoch) VALUES (?1, ?2, ?3)",
            params![repo_id, slug, epoch],
        )?;
        let enable = history && self.history.is_some();
        manifest::ensure_manifest(&self.conn, &repo_id, now, now, enable)?;
        Ok(repo_id)
    }

    /// The §2.1 claims oracle this store opened with (the writers reach it
    /// through [`Mint::claim`]; the composition layer's registry writers —
    /// a source, `spec/store` §2.1 — through here).
    #[must_use]
    pub fn claims(&self) -> &dyn IdentityClaims {
        self.ids.claims()
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

    /// [`feed::append_feed_row`] (`spec/store` §5.4 step 5): the core's feed
    /// row — **mints `c`** — and the recorder's `commits` row under the same
    /// id when the store carries one; on the bare connection (the tests that
    /// build history by hand).
    pub fn append_feed_row(&mut self, input: &NewFeedRow<'_>) -> Result<FeedRow> {
        let Store {
            conn, ids, history, ..
        } = self;
        feed::append_feed_row(conn, &mut ids.at(conn), history.as_deref(), input)
    }

    /// [`history::writers::write_revision`] under the caller's head token
    /// (17.0); returns `(rev_id, seq)`.
    pub fn write_revision(&mut self, input: &NewRevision<'_>) -> Result<(String, i64)> {
        history::writers::write_revision(&self.conn, input)
    }

    // ---- reads --------------------------------------------------------------------

    /// §6.1: the current bytes of a live doc; `None` when tombstoned or unknown.
    pub fn reconstruct(&self, doc_id: &str) -> Result<Option<String>> {
        read::reconstruct(&self.conn, doc_id)
    }

    /// §6.2: the bytes at a revision, from its Merkle root
    /// ([`HistoryReader::read_at_revision`]) — through the reader of the
    /// document's repository (Phase 4a; Phase 6a: the recorder, or the
    /// attached provider its manifest names): `None` when the composition has
    /// no module or nothing was ever captured in this database, as for a
    /// revision the reader lacks.
    pub fn read_at_revision(&self, doc_id: &str, rev_id: &str) -> Result<Option<RevisionRead>> {
        match manifest::history_reader_for_doc(
            &self.conn,
            self.history.as_deref(),
            &self.providers,
            doc_id,
            &time::now_ts(),
        )? {
            Some(h) => h.read_at_revision(&self.conn, doc_id, rev_id),
            None => Ok(None),
        }
    }

    /// The change feed (`spec/surface` §3 `changes_since`, 6.0; `spec/store`
    /// §3.1 `feed` — the core's, 17.0 D7): the repo's feed rows with `seq >
    /// cursor` of its epoch, optionally of one `origin`, `limit + 1` fetched
    /// to set `truncated`; [`Error::ExpiredCursor`] when the feed no longer
    /// serves the cursor. The digests' disposition counts come from the
    /// recorder when the store carries one.
    pub fn changes_since(
        &self,
        repo_id: &str,
        opts: &ChangesSinceOptions<'_>,
    ) -> Result<ChangesPage> {
        feed::changes_since(&self.conn, self.history_reader()?, repo_id, opts)
    }

    /// `{ epoch, oldest, head }` of the repository's feed ([`feed::feed_status`]).
    pub fn feed_status(&self, repo_id: &str) -> Result<FeedStatus> {
        feed::feed_status(&self.conn, repo_id)
    }

    /// `spec/store` §7.5 (17.0): re-mint the repository's epoch — a
    /// **restore** or a **rebuild-from-files** starts the feed over. Mints
    /// and claims a new `ep` at `ts`, writes it on the `repos` row, deletes
    /// the repository's `feed` and `feed_entries` rows of every epoch (a
    /// cursor of the old epoch is expired by construction; the rows are
    /// unreachable); the next commit is `seq = 1` of the new epoch. The
    /// recorder's `commits` keep their old `epoch`. Returns the new epoch. No
    /// production path calls it yet (neither restore nor rebuild-from-files
    /// exists); it is the rule, pinned by the store fixtures' `remint_epoch`
    /// step. One transaction.
    pub fn remint_epoch(&mut self, repo_id: &str, ts: &str) -> Result<String> {
        let Store { conn, ids, .. } = self;
        let tx = conn.unchecked_transaction()?;
        let epoch = feed::remint_epoch(&tx, &mut ids.at(&tx), repo_id, ts)?;
        tx.commit()?;
        Ok(epoch)
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
        derived::rebuild_index(&self.conn, target, self.capture_for(None)?)
    }

    /// §7: mark-and-sweep garbage collection, flag-gated (off → no-op); since
    /// 14.2 the same sweep removes a 14.1 store's `same` disposition rows
    /// ([`HistoryRecorder::gc`]), and since 17.0 the same run prunes the feed
    /// under `feed.retain_days` / `feed.retain_entries` (§7.4) and
    /// `id_claims` under `identity.claims_retain_days` (§7.3) at the wall
    /// clock ([`Store::gc_at`]).
    pub fn gc(&self, enabled: bool) -> Result<GcResult> {
        self.gc_at(enabled, &time::now_ts())
    }

    /// [`Store::gc`] with the prunes' clock pinned to `now` (the fixture
    /// runner's `gc { ts }`, §9.4): one transaction — the recorder's sweep,
    /// then the core's two collections: the feed prune (§7.4, under every
    /// repository's `feed.*` floors; `feed_pruned` the rows deleted) BEFORE
    /// the claims prune (§7.3, under every repository's effective settings
    /// and the workspace's own; `claims_released` the holds released), so a
    /// commit id whose last feed row went this run can be released by the
    /// same run once its window has passed.
    pub fn gc_at(&self, enabled: bool, now: &str) -> Result<GcResult> {
        if !enabled {
            return Ok(GcResult::default());
        }
        // The recorder's half runs when the store carries the module and
        // the bundle's tables exist (Phase 4a — a store whose every
        // repository runs with history disabled has nothing to collect there).
        let recorder = self.capture_for(None)?;
        let tx = self.conn.unchecked_transaction()?;
        let mut result = match recorder {
            Some(r) => r.gc(&tx)?,
            None => GcResult::default(),
        };
        result.feed_pruned = feed::prune_feed(&tx, now)?;
        let scopes = self.claim_scopes(&tx)?;
        result.claims_released = self.ids.claims().prune(&tx, now, &scopes)?;
        tx.commit()?;
        Ok(result)
    }

    /// The settings layers the claims prune judges under (§7.3): every
    /// repository's effective settings by `repo_id`, then the workspace's
    /// own for the workspace-scoped claims (`repo_id` NULL).
    fn claim_scopes(&self, conn: &Connection) -> Result<Vec<ClaimScope>> {
        let repos: Vec<String> = {
            let mut stmt = conn.prepare("SELECT repo_id FROM repos ORDER BY repo_id")?;
            let it = stmt.query_map([], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut scopes = Vec::with_capacity(repos.len() + 1);
        for repo_id in repos {
            let settings = settings::effective_settings(conn, &repo_id)?;
            scopes.push(ClaimScope {
                repo_id: Some(repo_id),
                settings,
            });
        }
        let workspace: Option<String> = {
            use rusqlite::OptionalExtension;
            conn.query_row(
                "SELECT settings FROM workspace_settings WHERE id = 0",
                [],
                |r| r.get(0),
            )
            .optional()?
        };
        scopes.push(ClaimScope {
            repo_id: None,
            settings: settings::parse_settings_json(workspace.as_deref()),
        });
        Ok(scopes)
    }

    /// What [`Store::gc`] would sweep, without deleting (§8 I5) — the three
    /// counts, the `same` rows (14.2) included.
    pub fn gc_dry_run(&self) -> Result<GcResult> {
        match self.capture_for(None)? {
            Some(r) => r.gc_dry_run(&self.conn),
            None => Ok(GcResult::default()),
        }
    }

    /// §7 (14.2): the `same` disposition rows a store through 14.1 wrote (0
    /// without the module or the bundle's tables).
    pub fn count_same_dispositions(&self) -> Result<usize> {
        match self.capture_for(None)? {
            Some(r) => r.count_same_dispositions(&self.conn),
            None => Ok(0),
        }
    }

    /// §5.5: delete expired pool rows; returns how many.
    pub fn sweep_pool(&self, ts: &str) -> Result<usize> {
        derived::sweep_pool(&self.conn, ts)
    }

    /// §7 "Size" (14.1): what the database is made of — bytes per table
    /// through `dbstat`, grouped into the six categories (17.0), the file's
    /// pages, the feed's position (the store's only repository's), advice
    /// (the retention advice of 15.0 evaluated at the wall clock).
    pub fn size_report(&self) -> Result<SizeReport> {
        size::size_report(
            &self.conn,
            self.capture_for(None)?,
            self.semantic.as_deref(),
            self.ids.claims(),
        )
    }

    /// [`Store::size_report`] with the retention plans evaluated at `now`
    /// (the CLI's pinned clock under `OMGBASE_SPEC_CLOCK`) and the `feed`
    /// member `repo_id`'s when given (`spec/store` §7.2, 17.0: the selected
    /// repository's, else the store's only one's, else `None`).
    pub fn size_report_at(&self, now: &str, repo_id: Option<&str>) -> Result<SizeReport> {
        size::size_report_at(
            &self.conn,
            self.capture_for(None)?,
            self.semantic.as_deref(),
            self.ids.claims(),
            now,
            repo_id,
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
    /// the §2.1 `id_claims` oracle ([`IdClaims`], 17.0). Assembled here, on
    /// the composition root — the one module that names the core and both
    /// extensions.
    #[must_use]
    pub fn standard() -> Self {
        Self {
            history: Some(Box::new(Recorder)),
            semantic: Some(Box::new(Provider)),
            semantic_fault: None,
            claims: Box::new(IdClaims),
            providers: Vec::new(),
        }
    }

    /// [`Capabilities::from_env`] over [`Capabilities::standard`]: what every
    /// fixture runner and the binary open with, so `OMGBASE_CAPABILITIES=
    /// core|history|semantic|full` runs the suites as that composition
    /// (Phase 4a's core-only build; Phase 5a's four — `spec/store` §9.6).
    pub fn standard_from_env() -> Result<Self> {
        Self::from_env(Self::standard)
    }
}

#[cfg(test)]
mod tests;
