import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../core/store/store.js";
import { docsOutline } from "../core/read/outline.js";
import { nodesGet, nodesGetMany } from "../core/read/nodes.js";
import { findDoc } from "../core/read/reader.js";
import { query as runQuery } from "../search/query.js";
import { textSearch } from "../search/text.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { EngineError } from "./errors.js";
import { apply, type Op } from "../mutate/apply.js";
import { MutationError } from "../mutate/tree.js";
import { tasksComplete, sectionsAppend, linksRetarget } from "../mutate/macros.js";
import { graphTraverse, graphPath } from "../graph/traverse.js";
import { historyNode, diffBlocks, changesSince } from "../graph/history.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus } from "../sync/admin.js";

// MCP server (06-mcp-api). The full tool surface wired to the engine: read
// (docs_outline, nodes_get(_many), query, text_search, resolve), mutate (apply
// + macros), graph (traverse, path), history (history_node, diff,
// changes_since), admin (repos_status, sync_status). Uniform truncated+cursor
// on lists; stable error-code mapping.

export interface ServerContext {
  store: Store;
  /** default repo for calls that omit one (single-repo v1 convenience). */
  repoId: string;
  /** working-tree root, required for mutation tools that write files. */
  rootPath?: string;
}

function ok(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let body: unknown;
  if (err instanceof EngineError) body = err.body();
  else if (err instanceof FilterInvalid) body = { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint }, retriable: false };
  else if (err instanceof MutationError) body = { error: err.code, message: err.message, data: err.data, retriable: Boolean((err.data as { retriable?: boolean }).retriable) };
  else body = { error: "repo_not_found", message: String(err), retriable: false };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "omgbase", version: "0.0.0" });
  const { store, repoId } = ctx;

  function resolveDocId(ref: { doc?: string | undefined; path?: string | undefined }): string {
    const info = ref.doc
      ? findDoc(store, { docId: ref.doc })
      : ref.path
        ? findDoc(store, { repoId, path: ref.path })
        : null;
    if (!info) throw new EngineError("doc_missing", `no document for ${JSON.stringify(ref)}`);
    return info.docId;
  }

  server.registerTool(
    "docs_outline",
    {
      description:
        "Orientation call. Returns a document's compact indented outline (alias/type/label per line, § marks section headings). IDs are stable; prefer them in follow-ups. Args take a doc id or path.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        resolution: z.enum(["skeleton", "outline"]).optional(),
        depth: z.number().int().optional(),
        budget_tokens: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const res = docsOutline(store, docId, {
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "nodes_get",
    {
      description: "Fetch one block subtree at a resolution (skeleton|outline|text|raw|full). Args: doc/path + block id.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const node = nodesGet(store, docId, args.id, args.resolution ? { resolution: args.resolution } : {});
        if (!node) throw new EngineError("block_missing", `no block ${args.id}`);
        return ok(node);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "nodes_get_many",
    {
      description: "Fetch up to 100 blocks by id with budget truncation. Result carries truncated.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        ids: z.array(z.string()),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        budget_tokens: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const res = nodesGetMany(store, docId, args.ids, {
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "query",
    {
      description:
        "CEL filter over documents|blocks (see the query language spec). Returns lean projected hits {id, path} with truncated + cursor. Hydrate by id via nodes_get.",
      inputSchema: {
        from: z.enum(["documents", "blocks"]),
        filter: z.string().optional(),
        text: z.string().optional(),
        order: z.array(z.string()).optional(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
      },
    },
    async (args) => {
      try {
        const res = runQuery(store, repoId, {
          from: args.from,
          ...(args.filter !== undefined ? { filter: args.filter } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.order !== undefined ? { order: args.order } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "text_search",
    {
      description: "Full-text (FTS5, bm25-ranked) search over block text. Returns hits with path + score + truncated.",
      inputSchema: { q: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(textSearch(store, repoId, args.q, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "resolve",
    {
      description: "Hybrid search specialized for 'the id of the thing I mean'. Returns ranked {id, locator, preview, evidence}. Prefer the returned ids in follow-up calls.",
      inputSchema: { query: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(resolveThing(store, { repoId, query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "apply",
    {
      description:
        "The only real writer. Applies a changeset of kernel ops (insert/update/move/remove/split/merge) atomically — all apply or none. Ops apply in order; later ops see earlier effects; minted ids are referenceable via \"$n.ids[i]\". Pass dry_run:true first for multi-doc changes to preview diffs. Conflicts carry current truth — retry from the error, don't re-read.",
      inputSchema: {
        ops: z.array(z.any()),
        reason: z.string().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const res = apply(store, {
          repoId, rootPath: ctx.rootPath,
          ops: args.ops as Op[],
          origin: { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) },
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tasks_complete",
    {
      description: "Macro: mark the given task blocks checked. Expands to update(attrs:{checked:true}) per block; the expansion is applied via the same changeset machinery.",
      inputSchema: { blocks: z.array(z.string()) },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const ops = tasksComplete(store, args.blocks);
        return ok(apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "tasks_complete" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sections_append",
    {
      description: "Macro: append markdown at the end of a heading's section range. Expands to a single insert op.",
      inputSchema: { heading: z.string(), markdown: z.string() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const ops = sectionsAppend(args.heading, args.markdown);
        return ok(apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "sections_append" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_retarget",
    {
      description: "Macro: rewrite a link/reference destination across all blocks that contain it. ALWAYS call with dry_run:true first to preview the hits, then dry_run:false to apply.",
      inputSchema: { from_target: z.string(), to_target: z.string(), dry_run: z.boolean().optional() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const { ops, hits } = linksRetarget(store, repoId, args.from_target, args.to_target);
        if (args.dry_run !== false) return ok({ hits, applied: false });
        const res = apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "links_retarget" } });
        return ok({ hits, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "graph_traverse",
    {
      description: "Frontier-expand the authored edge graph from seed node ids. direction out|in|both; depth ≤ 8; budget caps nodes/edges; as_of (commit seq) for temporal queries. Returns nodes, edges, truncated.",
      inputSchema: {
        from: z.array(z.string()),
        via: z.array(z.string()).optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        depth: z.number().int().optional(),
        as_of: z.number().int().nullable().optional(),
      },
    },
    async (args) => {
      try {
        return ok(graphTraverse(store, {
          from: args.from,
          ...(args.via ? { via: args.via } : {}),
          ...(args.direction ? { direction: args.direction } : {}),
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "graph_path",
    {
      description: "Up to k shortest paths between two node ids via BFS over authored edges. max_len ≤ 8, k ≤ 5.",
      inputSchema: { from: z.string(), to: z.string(), via: z.array(z.string()).optional(), max_len: z.number().int().optional(), k: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(graphPath(store, { from: args.from, to: args.to, ...(args.via ? { via: args.via } : {}), ...(args.max_len !== undefined ? { maxLen: args.max_len } : {}), ...(args.k !== undefined ? { k: args.k } : {}) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "history_node",
    {
      description: "A block's biography: the commits that touched it with disposition kind/confidence/reason, newest first.",
      inputSchema: { id: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(historyNode(store, args.id, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "diff",
    {
      description: "Block-grain diff between two revisions of a document: added/removed/changed blocks.",
      inputSchema: { doc: z.string(), from_rev: z.string(), to_rev: z.string() },
    },
    async (args) => {
      try {
        return ok(diffBlocks(store, args.doc, args.from_rev, args.to_rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "changes_since",
    {
      description: "The change feed: commit digests after a cursor (repo commit seq) with one-line summaries. Poll with your last cursor to cheaply re-orient after time away.",
      inputSchema: { cursor: z.number().int().optional(), origin: z.enum(["api", "observed", "import"]).optional(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(changesSince(store, repoId, {
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.origin ? { origin: args.origin } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "repos_status",
    { description: "Repo counts: documents, blocks, commits, open edges, and unconverged doc count.", inputSchema: {} },
    async () => {
      try { return ok(reposStatus(store, repoId)); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "sync_status",
    { description: "Watcher/sync state: last commit seq, last checkpoint, and whether the repo is convergent.", inputSchema: {} },
    async () => {
      try { return ok(syncStatus(store, repoId)); } catch (e) { return fail(e); }
    },
  );

  return server;
}
