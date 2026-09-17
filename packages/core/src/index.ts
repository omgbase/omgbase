export { VERSION } from "./core/index.js";

// Format adapter system (format-adapter-architecture §Phase 0).
export type { FormatAdapter, AdapterEdge, ProjectedNode, EmbeddingChunk, ReconcileHints } from "./format/adapter.js";
export { AdapterCapability } from "./format/adapter.js";
export { registerAdapter, adapterForFormat, adapterForPath, registeredFormats, detectFormat } from "./format/registry.js";
export { markdownAdapter, MARKDOWN_FORMAT } from "./format/markdown.js";
export { yamlAdapter, YAML_FORMAT } from "./format/yaml.js";
export { jsonAdapter, JSON_FORMAT } from "./format/json.js";
export { writeDocNodes, deleteDocNodes } from "./core/store/nodes.js";
export { docPropertiesMerged, docPropertiesGrouped, writeDocProperties, flattenFrontmatter } from "./core/store/properties.js";
// Side-effect: registers built-in adapters.
import "./format/index.js";

// Workspace + sync surface used by the CLI (second client, 11 §1).
export { Workspace, RepoSelectionError, type RepoRow } from "./sync/workspace.js";
export {
  resolveSettings,
  workspaceSettings,
  repoOwnSettings,
  writeWorkspaceSettings,
  writeRepoSettings,
  deepMerge,
  type Settings,
} from "./sync/settings.js";
export { freshnessSweep, rebuildFileStats, recordFileStat, detectDiskDrift, type SweepResult, type DiskDrift } from "./sync/freshness.js";
export { withWriterLock, writerLockFree, WriterLockTimeout } from "./sync/writer-lock.js";
export { WatchLease, watchLeaseLive } from "./sync/watch-lease.js";
export { attachRepo, type AttachResult } from "./sync/attach.js";
export { walkMarkdown, walkMarkdownAsync } from "./sync/fs-util.js";
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
  WatchListener,
} from "./sync/plugin.js";
export { createExternalSource, type ExternalSourceSpec } from "./sync/external-source.js";
export { reconcileChanges, attachSource } from "./sync/driver.js";
export { observeFile, type ObserveResult } from "./sync/observe.js";
export { buildServer, type ServerContext } from "./mcp/server.js";
export { serveStdio, type ServeStdioHandle } from "./mcp/stdio.js";
export { processCheckpoint, type CheckpointResult } from "./sync/checkpoint.js";
export { reposStatus, syncStatus, type RepoStatus, type SyncStatus, type DiskStatus } from "./sync/admin.js";

// Read surface consumed by CLI read commands (11 §5.2–5.5).
export { docsOutline, type OutlineResult, type OutlineOptions } from "./core/read/outline.js";
export { docsRead, reconstructContent, type DocsReadResult, type DocsReadOptions } from "./core/read/document.js";
export { nodesGet, nodesGetMany, type GetNode, type Resolution } from "./core/read/nodes.js";
export { findDoc, loadDocBlocks, blockRaw, type DocInfo, type BlockNode } from "./core/read/reader.js";
export { resolveRef, type ResolvedRef } from "./core/read/refs.js";
export { resolve, type ResolveHit, type ResolveInput } from "./search/resolve.js";

// OQX — omgbase Query eXpressions (unified composable query language, slice 1:
// structural navigation over docs/blocks/nodes). Coexists with query().
export { oqxRun, oqxRunAsync, collectSemanticPhrases, parseOqx, type OqxResult, type OqxHit, type OqxOptions, type EmbedQuery } from "./oqx/run.js";

// Embeddings + semantic retrieval (05 §5–6). The provider is a plugin loaded by
// package name; core carries no ML dependency.
export {
  EmbeddingWorker,
  SemanticUnavailable,
  contextPrefix,
  shouldEmbed,
  estimateTokens,
  type EmbeddingProvider,
  type EmbedTask,
  type DocEmbedTask,
  type DocEmbedBlockRef,
  type DocEmbedMethod,
  type DocVectorRow,
} from "./search/embeddings.js";
export { buildEmbedTasks, buildDocEmbedTasks } from "./search/tasks.js";
export { EmbedDrainer, type DrainerOptions } from "./search/drain.js";
export { embeddingSettings, type EmbeddingSettings } from "./search/provider.js";
export { createExternalProvider, type ExternalProvider } from "./search/external.js";
export { hybridSearch, type HybridHit, type HybridInput } from "./search/rrf.js";
export { vectorSearch, docVectorSearch, type VectorHit, type DocVectorHit } from "./search/vector.js";
export { historyNode, diffUnified, changesSince, type NodeChange, type CommitDigest } from "./graph/history.js";
export { docLinks, type LinksResult, type LinkEdge, type LinksOptions } from "./graph/links.js";
export { FilterInvalid } from "./search/cel/parser.js";
export { EngineError, type ErrorCode } from "./mcp/errors.js";
export { MutationError } from "./mutate/tree.js";
export { isValidId, prefixOf } from "./core/ids.js";

// Mutation surface consumed by CLI write commands (11 §5.6).
export { apply, type ApplyRequest, type ApplyResult, type Op } from "./mutate/apply.js";
export { type DocStore, FsDocStore, NullDocStore, resolveDocStore } from "./mutate/doc-store.js";
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

// Admin/maintenance (11 §5.9). Graph traversal is OQX `follow` now (see oqx/).
export {
  docsCreate,
  docsMove,
  docsDelete,
  docsSetMeta,
  type DocOpContext,
  type DocOpResult,
} from "./mutate/docs.js";
// Whole-document update: reconcile → opset → inspect/apply.
export {
  planUpdate,
  applyOpset,
  docsUpdate,
  type PlanUpdateOptions,
  type ApplyOpsetRequest,
  type DocsUpdateContext,
  type DocsUpdateResult,
} from "./mutate/plan-update.js";
export {
  opsetKernelOps,
  renderOpsetPlan,
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
export { planImport, importDocs, type MrplexDoc, type ImportPlan, type ImportResult } from "./migrate/mrplex.js";
