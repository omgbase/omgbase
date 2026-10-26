export { VERSION } from "./core/index.js";
export { versionInfo, coreVersion, nearestPackageVersion, COMPONENT_PACKAGES, type VersionInfo, type HostInfo } from "./version.js";
export { SPEC_VERSIONS, type SpecName } from "./spec-versions.js";

// Format adapter system (format-adapter-architecture §Phase 0).
export type { FormatAdapter, AdapterEdge, ProjectedNode, EmbeddingChunk, ReconcileHints } from "./format/adapter.js";
export { AdapterCapability } from "./format/adapter.js";
export { registerAdapter, adapterForFormat, adapterForPath, registeredFormats, detectFormat } from "./format/registry.js";
export { markdownAdapter, MARKDOWN_FORMAT } from "./format/markdown.js";
export { isContainerBlock } from "./format/index.js";
export { yamlAdapter, YAML_FORMAT } from "./format/yaml.js";
export { jsonAdapter, JSON_FORMAT } from "./format/json.js";
export { writeDocNodes, deleteDocNodes } from "./core/store/nodes.js";
export { docPropertiesMerged, docPropertiesGrouped, writeDocProperties, flattenFrontmatter } from "./core/store/properties.js";
// Side-effect: registers built-in adapters.
import "./format/index.js";

// Workspace + sync surface used by the CLI (second client, 11 §1).
export { Store, type StoreOptions } from "./core/store/store.js";
export { Workspace, RepoSelectionError, selectRepo, type RepoRow } from "./sync/workspace.js";
export {
  resolveSettings,
  workspaceSettings,
  repoOwnSettings,
  writeWorkspaceSettings,
  writeRepoSettings,
  deepMerge,
  type Settings,
} from "./sync/settings.js";
export {
  freshnessSweep, rebuildFileStats, recordFileStat, recordStat, detectDiskDrift, sweepPlan, sweepCandidates, loadStatCache, snapshotOf,
  type SweepResult, type DiskDrift, type SweepPlan, type StatCacheRow, type SnapshotEntry,
} from "./sync/freshness.js";
export { recoverRepo, type RecoveryResult } from "./sync/recovery.js";
export { withWriterLock, withWriterLockAsync, writerLockFree, writerLockHeld, setWriterLockDefaults, writerLockDefaults, WriterLockTimeout, type WriterLockOptions } from "./sync/writer-lock.js";
export { WatchLease, watchLeaseLive } from "./sync/watch-lease.js";
export { ingestDirectory, type IngestDirResult } from "./sync/attach.js";
export { ensureRepo } from "./core/attach.js";
export { walkMarkdown, walkMarkdownAsync, nodeFs, type SyncFs, type FileStat } from "./sync/fs-util.js";
export { Watcher, type WatcherOptions } from "./sync/watcher.js";
// External sync-adapter seam (sync-plugins): a SyncSource is the in-engine
// handle to an external adapter process; createExternalSource spawns one and
// speaks the stdio protocol; the driver reconciles a repo against any source.
export type {
  SyncSource,
  SourceCapabilities,
  SourceIdentity,
  SourceEntry,
  SourceItem,
  SourceWatch,
  WatchEvent,
  WatchListener,
} from "./sync/plugin.js";
export { awaitReady, WATCH_READY_PATIENCE_MS } from "./sync/plugin.js";
export { createExternalSource, type ExternalSourceSpec } from "./sync/external-source.js";
export {
  ensureAdapter,
  listAdapters,
  createSource,
  deleteSource,
  listSources,
  getSourceByName,
  attachSourceToRepo,
  detachSourceFromRepo,
  sourcesForRepo,
  renderConfigFlags,
  type AdapterRow,
  type SourceRow,
} from "./sync/sources.js";
export { reconcileChanges, attachSource } from "./sync/driver.js";
export { observeFile, observeMany, observeOne, observeDelete, observeBatch, type ObserveResult, type ObserveOneResult, type ObserveDeleteResult, type BatchItem, type BatchOutcome } from "./sync/observe.js";
export { buildServer, toolDescriptions, toolNames, unknownTool, UNKNOWN_TOOL_CODE, WRITE_TOOLS, MINIMAL_TOOLS, PROFILES, TOOLS_PROFILES, parseToolsProfile, type ServerContext, type ToolsProfile } from "./mcp/server.js";
export { serveStdio, type ServeStdioHandle } from "./mcp/stdio.js";
export { processCheckpoint, lastBatch, type BatchResult, type CheckpointResult } from "./sync/checkpoint.js";
export { reposStatus, syncStatus, reposList, type RepoStatus, type SyncStatus, type DiskStatus, type ReposList } from "./sync/admin.js";

// Read surface consumed by CLI read commands (11 §5.2–5.5).
export { docsOutline, type OutlineResult, type OutlineOptions } from "./core/read/outline.js";
export { docsRead, reconstructContent, type DocsReadResult, type DocsReadOptions } from "./core/read/document.js";
export { nodesGet, nodesGetMany, type GetNode, type Resolution } from "./core/read/nodes.js";
export {
  findDoc, findDocByRef, loadDocBlocks, blockRaw, docsList, docsTree, normalizeTreePrefix, DOCS_LIST_DEFAULT_LIMIT, DOCS_TREE_DEFAULT_LIMIT,
  type DocInfo, type BlockNode, type DocListRow, type DocListPage, type DocListOptions, type DocTreeEntry, type DocTreePage, type DocTreeOptions,
} from "./core/read/reader.js";
export { CursorInvalid, encodeCursor, decodeCursor, decodePathCursor } from "./core/cursor.js";
export { referencePath, storagePath, referencePathOrNull, referenceKeyed } from "./core/paths.js";
export * from "./surface-paths.js";
export { resolveRef, type ResolvedRef } from "./core/read/refs.js";
export { resolve, type ResolveHit, type ResolveInput } from "./search/resolve.js";

// OQX — omgbase Query eXpressions (unified composable query language, slice 1:
// structural navigation over docs/blocks/nodes). Coexists with query().
export { oqxRun, oqxRunAsync, collectSemanticPhrases, parseOqx, type OqxResult, type OqxHit, type OqxOptions, type EmbedQuery } from "./oqx/run.js";

// The semantic bundle (05 §5–6; modular-core Phase 2: `src/semantic/`, reached
// by the core only through `SemanticProvider`). The provider is an external
// process or endpoint named in settings; core carries no ML dependency. These
// exports are the COMPOSITION layer's (the CLI's `omg embed`, `omg mcp`, a
// library host); the engine's own paths go through the capability.
export {
  EmbeddingWorker,
  SemanticUnavailable,
  contextPrefix,
  shouldEmbed,
  estimateTokens,
  type EmbeddingProvider,
  type EmbedTask,
  type EmbedResult,
  type DocEmbedTask,
  type DocEmbedResult,
  type DocEmbedBlockRef,
  type DocEmbedMethod,
  type DocVectorRow,
} from "./semantic/embeddings.js";
export { buildEmbedTasks, buildDocEmbedTasks, staleEmbedCount, type TaskScope } from "./semantic/tasks.js";
export { EmbedDrainer, type DrainerOptions } from "./semantic/drain.js";
export {
  drainRepo, drainMode, freshness as semanticFreshness, readWatermark, writeWatermark, clearWatermark, feedHead, indexIdentity, sameIdentity, CHUNKING_VERSION, WATERMARK_SOURCE,
  type DrainMode, type DrainOptions, type DrainResult, type SemanticIndexIdentity, type SemanticWatermark,
} from "./semantic/indexer.js";
export { embeddingSettings, type EmbeddingSettings } from "./semantic/provider.js";
export { createExternalProvider, type ExternalProvider } from "./semantic/external.js";
export { hybridSearch, type HybridHit, type HybridInput } from "./search/rrf.js";
export { vectorSearch, docVectorSearch, type VectorHit, type DocVectorHit } from "./semantic/vector.js";
export { capabilityStates, historyState, semanticState, semanticConfigured, type CapabilityStates, type SemanticHostReport } from "./sync/capability-state.js";
// The capability manifest and the alert channel (spec/store §3.1 `capabilities` / `alerts`, 17.0 — modular-core Phase 3e-ii).
export {
  readCapability, readCapabilities, coverageFrom, ensureManifest, refreshSemanticManifest, refreshSemanticManifests, requireWriter, configHash, canonicalConfigJson,
  HISTORY_INTERFACE_V, HISTORY_DATA_V, SEMANTIC_INTERFACE_V, SEMANTIC_DATA_V, WRITER_REFUSED_ALERT, WRITER_REFUSED_MESSAGE,
  type ManifestRow, type ManifestState, type CoverageInterval,
} from "./core/store/manifest.js";
export {
  activeAlerts, listActiveAlerts, raiseAlert, clearAlert, refreshBacklogAlert, alertAfterMinutes, materializationBacklogMessage, materializationFailedMessage,
  MATERIALIZATION_BACKLOG_ALERT, MATERIALIZATION_FAILED_ALERT, RECOVERY_ALERT_AFTER_MINUTES_DEFAULT,
  type Alert, type AlertInput, type AlertSeverity,
} from "./core/store/alerts.js";
export { historyNode, diffUnified, docDiffUnified, diffBlocks, unifiedDiff, RevisionNotFound, type NodeChange, type DocDiffUnified, type DiffEntry } from "./graph/history.js";
// The change feed (spec/store §3.1 `feed`, 17.0 — the core's; spec/surface §3 `changes_since`).
export {
  changesSince, feedStatus, repoEpoch, pruneFeed, feedPolicy, repoFeedPolicy, ExpiredCursor,
  FEED_RETAIN_DAYS_DEFAULT, FEED_RETAIN_ENTRIES_DEFAULT, FEED_MAX_ENTRIES_DEFAULT,
  type ChangesPage, type ChangesSinceOptions, type CommitDigest, type DigestRevision, type FeedEntryKind, type FeedPolicy, type FeedStatus,
} from "./core/store/feed.js";
export { docLinks, type LinksResult, type LinkEdge, type LinksOptions } from "./graph/links.js";
export { FilterInvalid } from "./core/filter-invalid.js";
export { EngineError, errorBody, type ErrorCode, type ErrorBody } from "./mcp/errors.js";
export { MutationError } from "./mutate/tree.js";
export { isValidId, prefixOf, mintId, setIdMinter, withIdMinter, sequentialMinter, repeatingMinter, registerIdOracle, type IdMinter, type IdOracle, type IdPrefix } from "./core/ids.js";
// The clock seam (spec/surface §7.1): `omg mcp` pins the process clock under OMGBASE_SPEC_CLOCK.
export { pinClock, withClock } from "./core/clock.js";
export { sha256 } from "./core/hash.js";
export { ingestFile, type IngestResult } from "./core/ingest.js";

// Mutation surface consumed by CLI write commands (11 §5.6).
export { apply, type ApplyRequest, type ApplyResult, type Op } from "./mutate/apply.js";
export { type DocStore, FsDocStore, NullDocStore, resolveDocStore } from "./mutate/doc-store.js";
export { materializePending, materializeRow, listPending, readPending, type PendingRow, type PendingKind } from "./mutate/materialize.js";
export { type To, type At, type Expect } from "./mutate/ops.js";
export {
  tasksComplete,
  sectionsAppend,
  sectionsRename,
  sectionsMove,
  listsInsertItem,
  linksRetarget,
  nodeSet,
  editablePropsFor,
  type RetargetHit,
} from "./mutate/macros.js";

// The document operations' shared pieces (spec/mutate §6); the operations themselves are the effect builders below.
export { canonicalDocPath, composeFile, splitFrontmatter, planInboundRetarget } from "./mutate/docs.js";
// The effect builders (spec/mutate §6/§10, 3.0; spec/surface §4 "Sugar over effects", 4.0): one per operation,
// shared by the MCP server, the `omg` verbs and the fixture runner, plus `applySugar` and the Receipt adapters.
export {
  createEffects,
  moveDocEffects,
  deleteDocEffects,
  setMetaEffects,
  updateContentEffects,
  insertEffects,
  updateBlockEffects,
  moveBlocksEffects,
  removeBlocksEffects,
  splitEffects,
  mergeEffects,
  checkEffects,
  nodeSetEffects,
  appendEffects,
  docsAppendEffects,
  retargetEffects,
  guardOf,
  requireAbsentPath,
  applySugar,
  createdDoc,
  docOutcome,
  moveLinks,
  type Sugar,
  type SugarDoc,
  type SugarRequest,
  type DocOpOutcome,
  type MoveLinks,
} from "./mutate/sugar.js";
// The Effect layer (ADR-021, spec/mutate §11): plan / execute / apply { effects } and the plan's shapes.
export {
  planEffects,
  executePlan,
  executeByDigest,
  applyEffects,
  applyEffectsDetailed,
  substituteSymbols,
  admitPlan,
  canonicalJson,
  planDigest,
  PLAN_VERSION,
  PLANNER_V,
  type Plan,
  type PlanCore,
  type PlanOpset,
  type PlanPreconditions,
  type PlanPreview,
  type Receipt,
  type PlanEffectsRequest,
  type ExecuteRequest,
} from "./mutate/plan.js";
export { validateEffects, EFFECT_OPS, type Effect, type EffectTarget, type EffectExpect, type ResolvedEffect, type CreateEntry, type RetargetPreview } from "./mutate/effects.js";
// Query-directed planning (spec/mutate §11.8, 3.1): the selector binding behind `plan`/`apply`/`execute { select }`.
export { compileSelection, selectionQuery, SELECTION_CEILING, type Selection, type SelectionExpect, type CompiledSelection } from "./mutate/select.js";
export { oqxRunQuery, reservedAlias } from "./oqx-js/run.js";
// Inbound-link discovery + destination-aware rewrite (docs_move's dangling report / retarget_inbound).
export { inboundLinksTo, retargetLinksInRaw, type InboundLink } from "./graph/inbound-links.js";
// Whole-document update: reconcile → opset (the `set content` effect's internal planner since 3.0; `preview.identity` surfaces it).
export { planUpdate, type PlanUpdateOptions } from "./mutate/plan-update.js";
export {
  opsetKernelOps,
  renderOpsetPlan,
  renderIdentityPlan,
  type IdentityPreview,
  serializeOpset,
  parseOpset,
  type Opset,
  type PlanOp,
  type OpsetSummary,
  type OpsetPrecondition,
  type PlanDisposition,
} from "./mutate/opset.js";
export { rebuildIndex, type RebuildTarget } from "./core/store/rebuild.js";
export { runGc, type GcResult } from "./core/store/gc.js";
// History retention (spec/store §7 "Retention", 15.0): the policy and plan, the archive segments.
export {
  evaluateRetention, retentionPolicy, mergeRetentionPolicy, policyFor, globToRegExp, ageDays, periodKey, DEFAULT_RETENTION, LADDER_KEEPS, RetentionPolicyError,
  type RetentionPolicy, type RetentionOverride, type LadderRung, type LadderKeep, type RetentionPlan, type RetentionDocPlan, type RetentionTotals, type EvaluateOptions,
} from "./core/store/retention.js";
export {
  exportHistory, attachArchive, detachArchive, listArchives, unrecordedSegments, readManifest, revisionBody, archivePrefix, archivedSummary, segmentFileName, parseSegmentFileName,
  RevisionArchived, NotASegment, StaleSegment, ARCHIVE_DDL, ARCHIVE_SUFFIX, ARCHIVE_DIR,
  type ExportOptions, type ExportResult, type SegmentInfo, type SquashResult, type AttachResult, type AttachedSegment, type ArchiveListing, type ArchiveState, type UnrecordedSegment, type Manifest, type RevisionBody,
} from "./core/store/archive.js";
export {
  sizeReport, sizeAdvice, vacuum, reclaimableBytes, humanBytes, formatShare, shareOf, categoryOf, TABLE_CATEGORY, SIZE_CATEGORIES,
  type SizeReport, type SizeCategory, type SizeCategoryReport, type SizeTable, type SizeFile, type SizeArchived, type SizeRetention, type VacuumResult,
} from "./core/store/size.js";
export { LIVE_LEAF_SQL, ftsIndexedRowCount, liveLeafCount } from "./core/store/fts.js";
// The capability seams (modular-core Phase 1, docs/modular-core/README.md §5–§6): the interfaces the core calls,
// the default implementations the composition layer names (`StoreOptions.capabilities`), and the registry.
export {
  defaultCapabilities, coreCapabilities, envCapabilities, CAPABILITIES_ENV, capabilitiesOf, requireHistory, requireSemantic, semanticOf, HistoryRecorderImpl, SemanticProviderImpl, IdClaims,
  CapabilityUnavailable, SEMANTIC_DISABLED_MESSAGE, SEMANTIC_DISABLED_FIX, semanticUnavailableMessage,
  type Capabilities, type CapabilitiesFactory, type HistoryRecorder, type SemanticProvider, type SemanticScorer, type SemanticFreshness, type SemanticDrainOptions, type IdentityClaims, type RevisionTransition, type CapturedRevision, type SemanticVec,
  type CapabilityName, type CapabilityState,
} from "./core/capabilities/index.js";
