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
export { resolve, type ResolveHit } from "./search/resolve.js";
export { historyNode, diffUnified, changesSince, type NodeChange, type CommitDigest } from "./graph/history.js";
export { docLinks, type LinksResult, type LinkEdge, type LinksOptions } from "./graph/links.js";
export { FilterInvalid } from "./search/cel/parser.js";
export { EngineError, type ErrorCode } from "./mcp/errors.js";
export { MutationError } from "./mutate/tree.js";
