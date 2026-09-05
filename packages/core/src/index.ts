export { VERSION } from "./core/index.js";

// Workspace + sync surface used by the CLI (second client, 11 §1).
export { Workspace, RepoSelectionError, type RepoRow } from "./sync/workspace.js";
export { freshnessSweep, rebuildFileStats, recordFileStat, type SweepResult } from "./sync/freshness.js";
export { withWriterLock, writerLockFree, WriterLockTimeout } from "./sync/writer-lock.js";
export { WatchLease, watchLeaseLive } from "./sync/watch-lease.js";
export { attachRepo } from "./sync/attach.js";
export { Watcher, type WatcherOptions } from "./sync/watcher.js";
export { buildServer, type ServerContext } from "./mcp/server.js";
export { serveStdio, type ServeStdioHandle } from "./mcp/stdio.js";
export { processCheckpoint, type CheckpointResult } from "./sync/checkpoint.js";
export { reposStatus, syncStatus, type RepoStatus, type SyncStatus } from "./sync/admin.js";

// Read surface consumed by CLI read commands (11 §5.2–5.5).
export { docsOutline, type OutlineResult, type OutlineOptions } from "./core/read/outline.js";
export { nodesGet, nodesGetMany, type GetNode, type Resolution } from "./core/read/nodes.js";
export { findDoc, loadDocBlocks, blockRaw, type DocInfo, type BlockNode } from "./core/read/reader.js";
export { resolveRef, type ResolvedRef } from "./core/read/refs.js";
export { query, type QueryEnvelope, type QueryResult, type QueryHit } from "./search/query.js";
export { resolve, type ResolveHit, type ResolveInput } from "./search/resolve.js";

// Embeddings + semantic retrieval (05 §5–6). The provider is a plugin loaded by
// package name; core carries no ML dependency.
export {
  EmbeddingWorker,
  SemanticUnavailable,
  contextPrefix,
  shouldEmbed,
  type EmbeddingProvider,
  type EmbedTask,
} from "./search/embeddings.js";
export { buildEmbedTasks } from "./search/tasks.js";
export { embeddingSettings, type EmbeddingSettings } from "./search/provider.js";
export { createExternalProvider, type ExternalProvider } from "./search/external.js";
export { hybridSearch, type HybridHit, type HybridInput } from "./search/rrf.js";
export { vectorSearch, type VectorHit } from "./search/vector.js";
export { historyNode, diffUnified, changesSince, type NodeChange, type CommitDigest } from "./graph/history.js";
export { docLinks, type LinksResult, type LinkEdge, type LinksOptions } from "./graph/links.js";
export { FilterInvalid } from "./search/cel/parser.js";
export { EngineError, type ErrorCode } from "./mcp/errors.js";
export { MutationError } from "./mutate/tree.js";

// Mutation surface consumed by CLI write commands (11 §5.6).
export { apply, type ApplyRequest, type ApplyResult, type Op } from "./mutate/apply.js";
export { type To, type At, type Expect } from "./mutate/ops.js";
export {
  tasksComplete,
  sectionsAppend,
  sectionsRename,
  sectionsMove,
  listsInsertItem,
  linksRetarget,
  type RetargetHit,
} from "./mutate/macros.js";

// Graph traversal (11 §5.4) + admin/maintenance (11 §5.9).
export {
  graphTraverse,
  graphPath,
  graphSubgraph,
  type TraverseSpec,
  type PathSpec,
  type SubgraphSpec,
  type TraverseResult,
  type Direction,
} from "./graph/traverse.js";
export {
  docsCreate,
  docsMove,
  docsDelete,
  docsSetMeta,
  type DocOpContext,
  type DocOpResult,
} from "./mutate/docs.js";
export { rebuildIndex, type RebuildTarget } from "./core/store/rebuild.js";
export { runGc, type GcResult } from "./core/store/gc.js";
export { planImport, importDocs, type MrplexDoc, type ImportPlan, type ImportResult } from "./migrate/mrplex.js";
