// @omgbase/sync — a standalone store-to-store synchronizer (ADR-014).
// The Coordinator reconciles a SyncSource (external store, via the adapter
// protocol) with an omgbase repo reached through an EngineClient seam:
// InProcessEngineClient (local, direct Store) or McpEngineClient (remote, MCP).

export { type EngineClient, type ChangesPage, type DocBytes, InProcessEngineClient } from "./engine-client.js";
export { McpEngineClient, connectStdioEngine, connectHttpEngine } from "./mcp-engine-client.js";
export { Coordinator, type SyncInSummary, type SyncOutSummary } from "./coordinator.js";
export { runFsMirror, type FsMirrorOptions } from "./mirror.js";
