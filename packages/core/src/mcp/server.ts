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
import { docsCreate, docsMove, docsDelete, docsSetMeta } from "../mutate/docs.js";
import { graphTraverse, graphPath } from "../graph/traverse.js";
import { historyNode, diffBlocks, changesSince } from "../graph/history.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus } from "../sync/admin.js";
import { QUERY_SYNTAX, GRAPH_SYNTAX } from "./reference.js";

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
  /**
   * Embed a query string to a vector for semantic search. Absent ⇒ the `query`
   * tool's `semantic` param yields `semantic_unavailable` (no provider). The
   * host (CLI `omg mcp`) supplies this from the repo's configured embedder.
   */
  embedQuery?: (text: string) => Promise<{ model: string; vec: Float32Array }>;
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

  // Resolve the owning document id from an explicit doc/path, or — when neither
  // is given — infer it from a block id. The MCP schemas mark `doc`/`path`
  // optional precisely so a caller holding only a block id (e.g. from
  // docs_outline or query) can hydrate it without a separate lookup.
  function resolveDocId(ref: { doc?: string | undefined; path?: string | undefined; block?: string | undefined }): string {
    if (ref.doc) {
      const info = findDoc(store, { docId: ref.doc });
      if (info) return info.docId;
    } else if (ref.path) {
      const info = findDoc(store, { repoId, path: ref.path });
      if (info) return info.docId;
    } else if (ref.block) {
      const row = store.db
        .prepare("SELECT doc_id FROM blocks WHERE block_id = ?")
        .get(ref.block) as { doc_id: string } | undefined;
      if (row) return row.doc_id;
    }
    throw new EngineError("doc_missing", `no document for ${JSON.stringify(ref)}`);
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
      description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full). Pass a block `id`; `doc`/`path` are optional — the owning document is inferred from the block id when omitted. Use this to expand the lean ids returned by query/resolve/graph_traverse.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId({ doc: args.doc, path: args.path, block: args.id });
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
        const docId = resolveDocId({ doc: args.doc, path: args.path, block: args.ids[0] });
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
    "query_syntax",
    {
      description:
        "Reference: the full `query` syntax — targets, the CEL filter subset, absence semantics, structural + link-graph functions, `select` projection, and worked examples. Call this before writing a non-trivial filter. No arguments.",
      inputSchema: {},
    },
    async () => ok({ syntax: QUERY_SYNTAX }),
  );

  server.registerTool(
    "graph_syntax",
    {
      description:
        "Reference: the full `graph_traverse` / `graph_path` syntax — the doc-grain seed rule, predicates/direction/depth, `select` node projection, temporal as_of, and how to compose traversal with `query`. Call this before a non-trivial traversal. No arguments.",
      inputSchema: {},
    },
    async () => ok({ syntax: GRAPH_SYNTAX }),
  );

  server.registerTool(
    "query",
    {
      description:
        "Structured retrieval over documents|blocks. Modes intersect (AND): `filter` (CEL — call query_syntax for the grammar), `text` (FTS5 keyword), `semantic` (embedding similarity, needs a provider). `select` projects fields onto each hit so you can triage without a follow-up nodes_get: bare keys read the doc's frontmatter (e.g. \"layer\",\"type\",\"tracking\"); on blocks also \"type\", \"attrs.<k>\", \"$ordinal\"; \"$semantic_score\" with semantic. Default hit is lean {id, path}. Returns truncated + cursor. Blocks can constrain the parent doc via doc.<key> (e.g. doc.layer == \"canon\").",
      inputSchema: {
        from: z.enum(["documents", "blocks"]),
        filter: z.string().optional(),
        text: z.string().optional(),
        semantic: z.string().optional(),
        select: z.array(z.string()).optional(),
        order: z.array(z.string()).optional(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
      },
    },
    async (args) => {
      try {
        const env: Parameters<typeof runQuery>[2] = {
          from: args.from,
          ...(args.filter !== undefined ? { filter: args.filter } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.select !== undefined ? { select: args.select } : {}),
          ...(args.order !== undefined ? { order: args.order } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        };
        if (args.semantic !== undefined && args.semantic.trim().length > 0) {
          if (!ctx.embedQuery) {
            throw new EngineError("semantic_unavailable", "no embedding provider configured for this server");
          }
          env.vector = await ctx.embedQuery(args.semantic);
        }
        return ok(runQuery(store, repoId, env));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "text_search",
    {
      description: "Full-text (FTS5, bm25-ranked) keyword search over block text. Input is treated as a search box — plain words are ANDed, \"quoted phrases\" match adjacency, punctuation like / is safe (no query DSL). For structured filtering or frontmatter projection use `query` instead (see query_syntax).",
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

  // Doc-level operations (06 §API). The MCP server serializes writes in-process,
  // so these pass no omgbaseDir (the flock is for cross-process CLI writers);
  // MCP-originated writes are actor agent:mcp.
  const docCtx = () => {
    if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
    return { repoId, rootPath: ctx.rootPath, actor: "agent:mcp" };
  };

  server.registerTool(
    "docs_create",
    {
      description: "Create a new document at `path` from complete file bytes (`markdown`), with optional structured `frontmatter`. Fails path_taken if it already exists.",
      inputSchema: { path: z.string(), markdown: z.string(), frontmatter: z.record(z.string(), z.unknown()).optional() },
    },
    async (args) => {
      try {
        return ok(docsCreate(store, docCtx(), args.path, args.markdown, args.frontmatter));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_move",
    {
      description: "Rename a document to a new repo-relative path; block identity and history are preserved. Fails path_taken if the destination exists.",
      inputSchema: { doc: z.string(), to_path: z.string() },
    },
    async (args) => {
      try {
        return ok(docsMove(store, docCtx(), args.doc, args.to_path));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_delete",
    {
      description: "Delete a document: tombstone it and its live blocks (resurrection-poolable) and remove the file. Requires the explicit doc id/path.",
      inputSchema: { doc: z.string() },
    },
    async (args) => {
      try {
        return ok(docsDelete(store, docCtx(), args.doc));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_set_meta",
    {
      description: "Surgical frontmatter patch: set the given keys and/or unset named keys, re-ingesting the document. Other frontmatter is preserved.",
      inputSchema: { doc: z.string(), set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional() },
    },
    async (args) => {
      try {
        return ok(docsSetMeta(store, docCtx(), args.doc, {
          ...(args.set ? { set: args.set } : {}),
          ...(args.unset ? { unset: args.unset } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "graph_traverse",
    {
      description: "Frontier-expand the authored edge graph from seed node ids. Traversal is DOC-GRAIN: seeds are document ids; a block id is auto-normalized to its owning document (so ids from query/docs_outline work). direction out|in|both; depth ≤ 8; budget caps nodes/edges; as_of (commit seq) for temporal queries. `select` projects per-node metadata into `nodeInfo` (e.g. [\"$path\",\"type\",\"layer\"]) so nodes are actionable without hydrating each id; phantom/external nodes carry their target path/uri. Returns nodes, edges, nodeInfo?, truncated.",
      inputSchema: {
        from: z.array(z.string()),
        via: z.array(z.string()).optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        depth: z.number().int().optional(),
        select: z.array(z.string()).optional(),
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
          ...(args.select ? { select: args.select } : {}),
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
