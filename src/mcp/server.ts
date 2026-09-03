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

// MCP server skeleton (06-mcp-api; 07 task 1.9). Read tools wired to the Stage-1
// engine: docs_outline, nodes_get, nodes_get_many, query, text_search. Error
// mapping to stable codes; every list result carries truncated + cursor.

export interface ServerContext {
  store: Store;
  /** default repo for calls that omit one (single-repo v1 convenience). */
  repoId: string;
}

function ok(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const body =
    err instanceof EngineError
      ? err.body()
      : err instanceof FilterInvalid
        ? { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint }, retriable: false }
        : { error: "repo_not_found", message: String(err), retriable: false };
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

  return server;
}
