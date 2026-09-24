import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../core/store/store.js";
import { docsOutline } from "../core/read/outline.js";
import { docsRead, docsReadMany, MANY_DOCS_CAP, readDocumentAtRevision } from "../core/read/document.js";
import { nodesGet, nodesGetMany } from "../core/read/nodes.js";
import { findDoc, findDocByRef, docsList, docsTree, DOCS_LIST_DEFAULT_LIMIT, DOCS_TREE_DEFAULT_LIMIT } from "../core/read/reader.js";
import { CursorInvalid } from "../core/cursor.js";
import { resolveRef } from "../core/read/refs.js";
import { isValidId } from "../core/ids.js";
import { VERSION } from "../core/index.js";
import { normalizeText, normalizeVisibleText } from "../core/hash.js";
import { oqxRunAsync, collectSemanticPhrases } from "../oqx/run.js";
import { graphNeighborhood } from "./graph.js";
import { textSearch } from "../search/text.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { EngineError } from "./errors.js";
import { apply, type Op } from "../mutate/apply.js";
import { MutationError } from "../mutate/tree.js";
import { tasksComplete, sectionsAppend, docsAppend, linksRetarget, linksRepair, nodeSet } from "../mutate/macros.js";
import { docsCreate, docsMove, docsDelete, docsSetMeta } from "../mutate/docs.js";
import { planUpdate, docsUpdate } from "../mutate/plan-update.js";
import { renderOpsetPlan } from "../mutate/opset.js";
import { historyNode, diffBlocks, diffUnified, changesSince, docHistory } from "../graph/history.js";
import { linksStale, linksStaleSummary } from "../graph/link-health.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus } from "../sync/admin.js";
import { observeFile, observeMany, observeDelete } from "../sync/observe.js";
import { QUERY_SYNTAX } from "./reference.js";

// MCP server (mcp-api). The full tool surface wired to the engine: read
// (docs_tree, docs_list, docs_outline, nodes_get(_many), query, text_search, resolve), mutate (apply
// + macros), graph (traverse, path), history (history_node, diff,
// changes_since), admin (repos_status, sync_status). Uniform truncated+cursor
// on lists; stable error-code mapping.

export interface ServerContext {
  store: Store;
  /** The DEFAULT repo for calls that omit `repo` (ADR-014). Tools accept an
   *  optional `repo` slug to address any repo in the workspace; this is the
   *  fallback when none is given. */
  repoId: string;
  /** Default repo's working-tree root (for mutations that omit `repo`); a
   *  `repo`-scoped call derives the target repo's root from its fs source. */
  rootPath?: string;
  /**
   * Embed a query string to a vector for semantic search. Absent ⇒ the `query`
   * tool's `semantic` param yields `semantic_unavailable` (no provider). The
   * host (CLI `omg mcp`) supplies this from the repo's configured embedder.
   */
  embedQuery?: (text: string) => Promise<{ model: string; vec: Float32Array }>;
  /**
   * Called after any successful write tool (apply/macros/doc ops). The host
   * (CLI `omg mcp`) uses this to schedule a background embed drain so a block's
   * vector stays fresh without a manual `omg embed drain`. Must be cheap and
   * non-blocking — it fires on the mutation's response path; the actual
   * embedding happens off it. Absent ⇒ mutations don't auto-drain.
   */
  onMutation?: () => void;
}

// Kernel-op schemas (04 §1) published as the `apply` tool's op grammar. Giving
// each op a real schema (rather than z.any()) makes the required fields
// discoverable in the tool's JSON schema and turns a malformed op — e.g. an
// `update` missing its `block` id — into a boundary validation error naming the
// field, instead of a downstream `block_missing` for "block undefined".
const atSchema = z.union([
  z.literal("start"),
  z.literal("end"),
  z.object({ before: z.string() }),
  z.object({ after: z.string() }),
]);
const toSchema = z.object({
  parent: z.union([
    z.string().describe("a block id to nest under"),
    z.object({ doc: z.literal(true) }).describe("the document's top level"),
    z.object({ heading: z.string(), scope: z.literal("section") }).describe("a heading's section range"),
  ]),
  at: atSchema,
});
const expectSchema = z.object({
  content_hash: z.string().optional(),
  parent_children_hash: z.string().optional(),
});
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), doc: z.string().optional(), to: toSchema, markdown: z.string() }),
  z.object({ op: z.literal("update"), block: z.string(), markdown: z.string().optional(), attrs: z.record(z.string(), z.unknown()).optional(), expect: expectSchema.optional() }),
  z.object({ op: z.literal("move"), blocks: z.array(z.string()), to: toSchema }),
  z.object({ op: z.literal("remove"), blocks: z.array(z.string()), expect: z.record(z.string(), expectSchema).optional() }),
  z.object({ op: z.literal("split"), block: z.string(), at: z.array(z.number().int()), expect: expectSchema.optional() }),
  z.object({ op: z.literal("merge"), blocks: z.array(z.string()), separator: z.string().optional(), expect: z.record(z.string(), expectSchema).optional() }),
]);

function ok(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let body: unknown;
  if (err instanceof EngineError) body = err.body();
  else if (err instanceof FilterInvalid) body = { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint }, retriable: false };
  else if (err instanceof CursorInvalid) body = { error: "filter_invalid", message: err.message, data: { reason: `cursor was not issued by ${err.surface}`, hint: "resume only with a `cursor` returned by a truncated page of the same tool" }, retriable: false };
  else if (err instanceof MutationError) body = { error: err.code, message: err.message, data: err.data, retriable: Boolean((err.data as { retriable?: boolean }).retriable) };
  else body = { error: "repo_not_found", message: String(err), retriable: false };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "omgbase", version: VERSION });
  const { store } = ctx;

  // Multi-repo (ADR-014): every tool accepts an optional `repo` slug. Resolve it
  // to a repo id + its (derived) working-tree root per call; omitting it uses the
  // server's bound default repo, so single-repo clients are unchanged. rootPath
  // is derived from the repo's attached `fs` source (the root_path column is
  // gone). An unknown slug is a loud repo_not_found.
  function repoScope(slug?: string): { repoId: string; rootPath: string | undefined } {
    if (slug === undefined) return { repoId: ctx.repoId, rootPath: ctx.rootPath };
    const row = store.db.prepare("SELECT repo_id FROM repos WHERE slug = ?").get(slug) as { repo_id: string } | undefined;
    if (!row) throw new EngineError("repo_not_found", `no repo '${slug}' in this workspace`, { data: { repo: slug } });
    const cfg = store.db
      .prepare("SELECT s.config AS config FROM sources s JOIN attachments a ON a.source_id = s.source_id WHERE a.repo_id = ? AND s.adapter = 'fs' LIMIT 1")
      .get(row.repo_id) as { config: string } | undefined;
    let rootPath: string | undefined;
    if (cfg) {
      try {
        const r = (JSON.parse(cfg.config) as { root?: unknown }).root;
        if (typeof r === "string" && r) rootPath = r;
      } catch { /* malformed config → no root */ }
    }
    return { repoId: row.repo_id, rootPath };
  }
  // Every repo-scoped tool adds `...REPO_ARG` to its inputSchema and opens with
  // `const { repoId, rootPath } = repoScope(args.repo);` — omitting `repo` uses
  // the bound default repo (single-repo clients unchanged).
  const REPO_ARG = { repo: z.string().optional() };

  // Wrap a successful write's result: notify the host so it can schedule a
  // background embed drain. onMutation must be cheap/non-blocking (see
  // ServerContext); we never await it, keeping it off the response path.
  function okMutated(payload: unknown): { content: { type: "text"; text: string }[] } {
    ctx.onMutation?.();
    return ok(payload);
  }

  // Resolve the owning document id from an explicit doc/path, or — when neither
  // is given — infer it from a block id. The MCP schemas mark `doc`/`path`
  // optional precisely so a caller holding only a block id (e.g. from
  // docs_outline or query) can hydrate it without a separate lookup.
  //
  // `doc` is id-OR-path: an agent holding a path from a prior query/outline hit
  // routinely reaches for the most obvious field, so it must accept both (via
  // the shared findDocByRef). `path` stays explicit-path; `block` infers the
  // owning doc. An unresolvable ref throws doc_missing (loud), never a silent
  // empty — including a d_-shaped id that doesn't exist (findDocByRef won't fall
  // through to a path lookup for it).
  function resolveDocId(repoId: string, ref: { doc?: string | undefined; path?: string | undefined; block?: string | undefined }): string {
    if (ref.doc) {
      const info = findDocByRef(store, repoId, ref.doc);
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
    throw new EngineError("doc_missing", `no document for ${JSON.stringify(ref)}`, { data: ref });
  }

  // Resolve `heading` (a block id or heading text) to a heading block id, for
  // macros that address a section. A value that already names a live heading
  // block is returned as-is; otherwise it's matched as heading text (normalized
  // the same way the parser stores block.text), scoped to a doc/path when given.
  // Repo-wide text that isn't unique fails ambiguous_heading with candidate ids.
  function resolveHeadingId(repoId: string, heading: string, scope: { doc?: string; path?: string }): string {
    const asBlock = store.db
      .prepare("SELECT block_id FROM blocks WHERE block_id = ? AND type = 'heading' AND deleted_commit IS NULL")
      .get(heading) as { block_id: string } | undefined;
    if (asBlock) return asBlock.block_id;

    const wantDoc = scope.doc || scope.path ? resolveDocId(repoId, scope) : undefined;
    const needle = normalizeVisibleText(heading, "heading");
    const rows = (wantDoc
      ? store.db.prepare("SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ? AND type = 'heading' AND doc_id = ? AND deleted_commit IS NULL")
        .all(repoId, wantDoc)
      : store.db.prepare("SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ? AND type = 'heading' AND deleted_commit IS NULL")
        .all(repoId)) as { block_id: string; doc_id: string; text: string }[];
    const matches = rows.filter((r) => normalizeText(r.text) === needle);
    if (matches.length === 0) throw new EngineError("parent_missing", `no heading matching ${JSON.stringify(heading)}`, { data: { heading, ...(wantDoc ? { doc: wantDoc } : {}) } });
    if (matches.length > 1) {
      throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(heading)} matches ${matches.length} headings; pass its block id or a doc/path scope`, {
        data: { heading, candidates: matches.map((m) => ({ block: m.block_id, doc: m.doc_id })) },
      });
    }
    return matches[0]!.block_id;
  }

  // Resolve a human ref (block id, locator, node id, …) to a live block id — the
  // server-side equal of the CLI's local `block()`. The block-level tools accept
  // refs (not pre-resolved ids) so a remote `omg insert/move/split/…` behaves
  // exactly like local: ref resolution and CAS pinning happen HERE, next to the
  // store, instead of on a client that has none.
  function resolveBlockRef(repoId: string, ref: string): string {
    const r = resolveRef(store, repoId, ref);
    if (!r || r.kind !== "block" || !r.blockId) throw new EngineError("block_missing", `not a block: ${ref}`, { data: { ref } });
    return r.blockId;
  }
  // Resolve a PARENT ref for insert/move: a block ref names that block as the
  // parent; a document ref (id or path) names the document's top level — the
  // kernel's `{ doc: true }` parent — so "append a new section to this doc" is
  // one blocks_insert call, not a detour through docs_append. Returns the doc
  // the parent lives in so the caller can pin the op to it.
  function resolveParentRef(repoId: string, ref: string): { parent: string | { doc: true }; docId: string } {
    const r = resolveRef(store, repoId, ref);
    if (!r) throw new EngineError("block_missing", `not a block or document: ${ref}`, { data: { ref } });
    if (r.kind === "document") return { parent: { doc: true }, docId: r.docId };
    return { parent: r.blockId!, docId: r.docId };
  }
  function docIdOfBlock(blockId: string): string | undefined {
    const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { doc_id: string } | undefined;
    return row?.doc_id;
  }
  // Current raw-content hash (hex) of a block, for CAS `expect` pinning — mirrors
  // the CLI's rawHashOf. Undefined for an unknown/deleted block (the op then runs
  // unpinned, exactly as the CLI does when it can't read a hash).
  function pinHash(blockId: string): string | undefined {
    const row = store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { h: string } | undefined;
    return row?.h;
  }
  // Resolve the before/after anchor in an `at` spec (itself a block ref) to its
  // id; start/end pass through. Absent ⇒ "end" (append), matching CLI parseAt.
  type AtSpec = z.infer<typeof atSchema>;
  function resolveAt(repoId: string, at: AtSpec | undefined): AtSpec {
    if (!at || at === "start" || at === "end") return at ?? "end";
    if ("before" in at) return { before: resolveBlockRef(repoId, at.before) };
    return { after: resolveBlockRef(repoId, at.after) };
  }
  // Apply an already-built op list, honoring dry_run (preview, no drain) — the
  // shared tail of every block-level tool below.
  function applyOps(repoId: string, rootPath: string, ops: Op[], reason: string, dryRun?: boolean) {
    const res = apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason }, ...(dryRun !== undefined ? { dryRun } : {}) });
    return dryRun ? ok(res) : okMutated(res);
  }
  // Guard shared by every mutating tool: a sourceless (headless-only) repo has no
  // working tree to write through, so mutation is disabled with a loud error.
  function requireRoot(rootPath: string | undefined): string {
    if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
    return rootPath;
  }

  server.registerTool(
    "docs_outline",
    {
      description:
        "Orientation call. Returns a document's compact indented outline (alias/type/label per line, § marks section headings). IDs are stable; prefer them in follow-ups. Args take a doc id or path. For the whole document body in one call, use docs_read.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        resolution: z.enum(["skeleton", "outline"]).optional(),
        depth: z.number().int().optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = resolveDocId(repoId, args);
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
    "docs_read",
    {
      description:
        "Read a whole document in one call: `content` is the complete file bytes verbatim (fences/tables/list markers preserved), `properties` is the document's property bag grouped by source — `{ frontmatter, inline, computed }` — plus `path`/`docId`/`rev`. What `properties.frontmatter` holds is format-dependent: for markdown it's the parsed frontmatter fence; for YAML/JSON it's the parsed object the file represents; other adapters extract per their format. `inline` holds dataview-style `key:: value` fields from the body; `computed` holds engine intrinsics (`$title`, `$tags`). The cold-start 'read the guide before doing anything' call. Args take a doc id or path. Pass include_ids:true to also get the document's block ids in order (`ids`) AND `hashes` — a {block id → content hash} map giving the exact `expect.content_hash` value the raw `apply` kernel needs, so one read yields both the ids and the CAS tokens to mutate them (no follow-up nodes_get_many hydration) — AND `parents`, a {block id → parent block id | null} map (null = top level), because `ids` is a flat pre-order walk and a list is otherwise indistinguishable from its items; filter to `parents[id] === null` for the top-level blocks. For structure-only orientation use docs_outline; to hydrate a single block use nodes_get.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        include_ids: z.boolean().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = resolveDocId(repoId, args);
        const res = docsRead(store, docId, args.include_ids ? { includeIds: true } : {});
        if (!res) throw new EngineError("doc_missing", `no document for ${JSON.stringify(args)}`);
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_get_many",
    {
      description:
        "Batch whole-document read — the hydrate half of query→hydrate. The plural of docs_read: pass `docs`, a list of refs (each a doc id OR a path, same id-or-path symmetry docs_read accepts in its `doc` field), and get back one full read per ref. Returns `{ items, errors, truncated }`: each found doc is a full docs_read projection (`content` = complete file bytes verbatim, `properties` grouped by source, plus `path`/`docId`/`rev`, and — with include_ids:true — the document's ordered block `ids`, a `hashes` {block id → content hash} map for raw-`apply` CAS pinning, and a `parents` {block id → parent block id | null} map so top-level vs nested blocks are distinguishable without an outline read); a ref that resolves to no live document lands in `errors` as {ref, error:\"doc_not_found\"} WITHOUT failing the call, so one bad ref never sinks the batch. Duplicate refs collapse first-seen (a repeated ref yields a single item). Capped at " + MANY_DOCS_CAP + " refs per call; excess refs are dropped and `truncated` is set. Pass budget_tokens to cap total hydrated size — the batch stops early and flags `truncated` when the next doc would exceed it. Use this after query/text_search/resolve to pull N whole docs in ONE round-trip instead of N serial docs_read calls; for a single doc use docs_read, and for lean structure-only orientation use docs_outline.",
      inputSchema: {
        docs: z.array(z.string()),
        include_ids: z.boolean().optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const res = docsReadMany(store, repoId, args.docs, {
          ...(args.include_ids ? { includeIds: true } : {}),
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
      description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full). Pass a block `id`; `doc`/`path` are optional — the owning document is inferred from the block id when omitted. The raw and full resolutions include the block's `content_hash` (its own raw hash) — the value update/split need in expect.content_hash, so you can fetch it before editing rather than reading it back from a conflict. Use this to expand the lean ids returned by query/resolve. To read a whole document in one call, use docs_read (nodes_get on a doc/heading id returns only that block, not the document).",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = resolveDocId(repoId, { doc: args.doc, path: args.path, block: args.id });
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
      description:
        "Fetch up to 100 blocks by id (in request order) with budget truncation. Block ids are globally unique, so `ids` may span ANY number of documents — each id is resolved to its owning doc server-side; `doc`/`path` is an optional SCOPE (ids from other docs then count as unresolved), not a requirement. Result carries `nodes`, `truncated` (cap or `budget_tokens` hit), and `unresolved` — the requested ids that name no live block (never silently dropped).",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        ids: z.array(z.string()),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // Only an explicit doc/path scopes the fetch; never infer a doc from
        // ids[0] — that silently dropped every id owned by another document.
        const docId = args.doc || args.path ? resolveDocId(repoId, { doc: args.doc, path: args.path }) : null;
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
    "read_ref",
    {
      description:
        "Read ANY ref — a document (`d_…` id or repo-relative path) OR a block (`b_…` id, or an `n_…` node id which dereferences to its block) — and get its content, classified. Resolves the ref server-side (the polymorphic `omg cat`): a document ref returns `{ kind:\"document\", content, path, docId, … }` (complete file bytes; `resolution` does not apply); a block ref returns `{ kind:\"block\", … }` — the block subtree at `resolution` (raw|text|outline|skeleton|full, default raw). Use this when you hold a ref and want its bytes WITHOUT first knowing whether it names a document or a block. Contrast: docs_read needs a doc; nodes_get needs a block id.",
      inputSchema: {
        ref: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const resolved = resolveRef(store, repoId, args.ref);
        if (!resolved) throw new EngineError("doc_missing", `no document or block for ${JSON.stringify(args.ref)}`);
        if (resolved.kind === "document") {
          const res = docsRead(store, resolved.docId);
          if (!res) throw new EngineError("doc_missing", `no document for ${JSON.stringify(args.ref)}`);
          return ok({ kind: "document", ...res });
        }
        const node = nodesGet(store, resolved.docId, resolved.blockId!, { resolution: args.resolution ?? "raw" });
        if (!node) throw new EngineError("block_missing", `no block ${resolved.blockId}`);
        return ok({ kind: "block", ...node });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_tree",
    {
      description:
        "ORIENTATION: the path-separator-aware shape of a repo in ONE small call — start here to answer 'what does this repo contain?', NOT with docs_list. Like `tree -L <depth>` crossed with `du`: every live document under `path` (a directory prefix; omit for the repo root) is collapsed at `depth` path segments (default 1 = immediate children), giving one entry per directory and one per shallow document. Returns `{ prefix, depth, total: { docs, blocks }, entries: [{ path, kind: \"dir\"|\"doc\", docs, blocks, ts }], truncated, cursor }`: a `dir` entry's path ends in `/` and its `docs`/`blocks`/`ts` are the totals + latest last-commit timestamp UNDER it; a `doc` entry is a single document (docs = 1). `total` always covers everything under `prefix` regardless of paging, so you see the true size of what you're looking at. On an 800-document repo `depth:1` at the root is ~10 rows where docs_list would be ~800; descend by calling again with `path` set to a dir entry (or raise `depth`). Entries are ordered by path and paged: `limit` (default " + DOCS_TREE_DEFAULT_LIMIT + ") / `cursor` / `budget_tokens` with an honest `truncated`. For ranked or attribute-based discovery use `resolve`/`query`; to enumerate the documents themselves once you know where to look, use docs_list with a `path_glob`.",
      inputSchema: {
        path: z.string().optional(),
        depth: z.number().int().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return ok(
          docsTree(store, repoId, {
            ...(args.path !== undefined ? { path: args.path } : {}),
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_list",
    {
      description:
        "ENUMERATE live documents (the `omg ls` operation) as a page: `{ items: [{ path, blocks, ts }], truncated, cursor }` — repo-relative path, live block count, last-commit timestamp (ISO, or null) — ordered by path. This is a flat `ls`, not an orientation primitive: unscoped on a large repo it is hundreds of rows, and the engine has no directory concept here — `path_glob` is a simple LIKE match where `*` matches ANY run INCLUDING `/` (so `projects/*` is the whole subtree; there is no 'immediate children only'). To learn a repo's shape, call docs_tree first, then scope this with a `path_glob` once you know where to look. Paged under the uniform list contract: `limit` (default " + DOCS_LIST_DEFAULT_LIMIT + ") caps rows, `cursor` (from a truncated page) resumes after the last row returned, `budget_tokens` caps the page's estimated size (at least one row is always returned), and `truncated` is honest — when true you have NOT seen everything. For structured/ranked discovery use `query` or `resolve`.",
      inputSchema: {
        path_glob: z.string().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return ok(
          docsList(store, repoId, {
            ...(args.path_glob !== undefined ? { pathGlob: args.path_glob } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
            ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "query_syntax",
    {
      description:
        "Reference: the full `query` syntax — targets, the CEL filter subset, absence semantics, structural functions, link-graph traversal (OQX `follow`), `select` projection, and worked examples. Call this before writing a non-trivial filter. No arguments.",
      inputSchema: {},
    },
    async () => ok({ syntax: QUERY_SYNTAX }),
  );

  server.registerTool(
    "query",
    {
      description:
        "OQX (omgbase Query eXpressions) — composable query in ONE expression. Two rules: DOT navigation belongs to the host object model (`doc.layer`, `section.blocks`, `target.out`); WHITESPACE query directives belong to OQX — a nested query is `<receiver> collect|exists|count|first|single { <block> }` (a postfix directive + a `{ … }` block), never a method. `from E` selects a property/relation relative to the current source scope and flattens it (a typed flatMap): top-level `from docs|blocks|nodes|edges` selects the repository's docs/blocks/nodes/edges (the `edges` target is the authored link graph as first-class rows — predicate/provenance/dst_kind/anchor/src_field + $src/$dst/$dst_path/$dst_uri, with $path/doc.* reaching the SOURCE doc); `where`; `select`. Its distinctive power is receiver-constrained nested queries that correlate to the current row: `from docs where nodes exists { where kind == \"md:task\" }` returns only the docs that themselves contain a matching node (not a global scan). Directives: `exists { … }` / `count { … }` in where — with an optional count comparison `nodes count { where kind == \"md:task\" } >= 2`; `collect { … }` in select for hierarchical results, nestable (`select secs: nodes collect { where kind == \"md:section\" select h: name, items: section.blocks collect { where type == \"list_item\" } }`). Inside a query block (and after a top-level `from`) the `where`/`select` keyword may be omitted: a leading PREDICATE-shaped expression is an implicit `where` (`nodes exists { kind == \"md:task\" }` ≡ `{ where kind == \"md:task\" }`), and a leading reference / `name: value` list is an implicit `select` (`nodes collect { attrs.text }` projects `attrs.text`). The choice is by SYNTAX, not type — a bare boolean-valued property still PROJECTS (`nodes collect { active }`), so to filter by it write `where active` or the predicate-shaped `active == true`. On the nodes/blocks targets a bare identifier that is not a structural field (kind/name/value; type/text) or `$`-intrinsic reads the flattened attrs bag — `checked` == `attrs.checked`, `level` == `attrs.level` — so the name you filter on matches the name a projection returns (`select attrs.checked` yields key `checked`); the `attrs.<key>` form still works and an absent key is silently false. Any consumer accepts `distinct` to dedup the rows it reduces by their projected value — `nodes count distinct { select kind }`, `nodes collect distinct { select kind }`, top-level `select distinct type` (empty projection dedups by identity). `values` after a projection of exactly ONE item returns the bare value instead of a `{name: value}` record: at the top level `from docs where layer == \"canon\" select $path values` returns `values: [\"a.md\", …]` (paged like hits; `hits` is empty), and inside a block `select tags: tags collect { $value values }` yields a plain array. `$value` is the current item itself — the row, or the scalar element when the receiver is a list property (`where tags exists { where $value == \"pricing\" }`); inside a block `^$value` is the enclosing row. `none { … }` is the zero-cardinality test — true iff the block yields no rows (≡ `!… exists { … }`), and how \"every\" is spelled: `nodes none { where kind == \"md:task\" && !checked }` = no open tasks; also a whole-query directive (`$repo.docs none { … }` returns `none`). `limit N` / `offset N` bound a row set AFTER where/order/distinct and BEFORE the consumer reduces it, so they mean the same under every consumer: at the top level (`order by era desc limit 3` — the tool's `limit`/`cursor` then page within that bounded set) or inside any block (`nodes collect { … order by ordinal limit 1 }`; `nodes exists { offset 1 }` = at least two). `entries(x)` turns a record into a collection of entries — inside the block `$key` is the property key and `$value` (and bare names) the value: `select fm: entries(frontmatter) collect { k: $key, v: $value }`, `from nodes where kind == \"md:task\" && entries(attrs) exists { where $key == \"checked\" && $value }`; works on `frontmatter` / `inline` (the whole authored bag, nested dotted keys folded back), `attrs`, a nested frontmatter map, or a list (numeric index keys). Plain objects never auto-iterate; `entries()` is the explicit bridge. The where clause is a boolean tree: compose scalar predicates and consumer directives with `&&`, `||`, `!`, and grouping (`layer == \"canon\" || nodes exists { where kind == \"md:task\" }`). Relative source: `from E` inside a top-level consumer block re-projects the rows — `$repo.docs collect { from nodes where kind == \"md:task\" }` starts at docs, projects each doc through its `nodes` relation, and queries the resulting nodes (a scalar relation like `from doc` contributes one row; a missing/non-navigable relation is a loud error, never a global scan). One-scope lift: a `collect` in `where` with a `^name` both filters (non-empty) and binds the matching values into the parent select in one expression — `from docs where nodes collect { ^open: value where kind == \"md:task\" && !attrs.checked } select $path, open` returns the docs with an open task, each carrying its open-task texts. Correlation / joins (the `^` sigil, symmetric with the lift): a nested query may READ a name bound one scope outward — bind it in the parent (a select value or a lift), then reference `^name` inside a nested query's where. Combined with the explicit root relations `$repo.docs` / `$repo.nodes` / `$repo.blocks` (an UNBOUNDED repository scan, uncorrelated until you add a `^` predicate) this expresses lateral/dependent joins without a JOIN keyword: `repo.<t> exists { where … == ^k }` = semi-join, `!… exists { … }` = anti-join, `… collect { … }` in select = nested left-join, and the select-only lookups `first { … }` / `single { … }` (zero-or-one / one-to-one; `single` errors if it matches >1) — e.g. `from docs select owner_id, owner: $repo.nodes single { where kind == \"person\" && attrs.id == ^owner_id }`. Membership over a lifted set: `<value> in ^keys`. `^` reads exactly ONE scope out (no arbitrary-ancestor search), and a bare name reads the CURRENT row only — it never falls through to an enclosing row or the root, so reach outward explicitly with `^name` (the enclosing row) or `$repo.<target>` (a root scan, from any depth). Top-level consumers: the whole query can be a consumer directive over a root receiver to change its result shape — `$repo.docs count { … }`, `$repo.docs exists { … }` and `$repo.docs none { … }` reduce to a scalar (returned as `count`/`exists`/`none`, no hits), `$repo.docs first { … }` / `$repo.docs single { … }` return zero-or-one hit (`single` errors if the query matches >1); a bare `from …` is the collect form. (The `$repo.<target>` receiver is the same root relation used inside where/select.) Scalar predicates follow the @omgbase/oqx semantics (strict typed equality with absence normalized so `!=` over an absent field matches; case-sensitive string ops with `.lower()`/`.upper()` and a regex `matches()`; absent sorts last; arithmetic supported), including doc.<key> reach-through and `text(\"terms\")` — a full-text (FTS5) PRUNING predicate that, because it is an ordinary predicate, composes inside correlated subqueries and collects (e.g. `nodes exists { where kind == \"md:task\" && text(\"ship\") }`), which the flat `query` tool cannot express. (`text` prunes; relevance ranking is separate.) And `semantic(\"phrase\")` — an embedding cosine SCORE (docs/blocks only) usable as a threshold prune (`semantic(\"the great work\") > 0.6`) or a projection (`select score: semantic(\"…\")`); it needs an embedding provider (else semantic_unavailable) and, like `text`, composes inside nested scopes. Ranking: `order by <expr> [asc|desc], …` sorts the result (`order by semantic(\"the great work\") desc` = semantic top-K; also orders by any frontmatter field / `$path`), always tie-broken by (path, id) for a total order — this is how score functions become a ranking. A custom order disables the keyset cursor (you still get the top `limit` with `truncated`). Recursion (`follow`): make the query recursive over a TYPE-PRESERVING relation (the relation's successor type must equal the query target). `from blocks where $id == \"b_x\" follow block.children` walks the block subtree from a seed; the `where` picks the SEED rows and `follow <relation>` expands them. A bare `follow <relation>` carries no sub-clauses; sub-clauses go in a `{ … }` block. Two orthogonal knobs shape it: a follow-local `follow <rel> { where <pred> }` filters which successors keep participating at each hop (running out ⇒ a leaf), and `{ frontier <pred> }` cuts a relation that could otherwise continue (⇒ a frontier); `{ depth <n> }` bounds the walk (1..8, default 8). `follow distinct` dedups reached rows by identity (the default keeps one occurrence per distinct walk path). `follow … { by <expr> }` sets the node identity used for cycle detection + dedup to a field/intrinsic (default: the entity id) — e.g. `follow doc.out { by group }` treats same-`group` documents as one node. Each reached row carries recursion metadata: `$depth` (seed = 1), the categorical `$stop` (interior | leaf | frontier | depth | cycle) with `$leaf`/`$frontier` boolean sugar, and `$ordinal` (a deterministic 1..N rank over the walk, ordered by depth then path — `order by $ordinal` for walk order, `where $ordinal <= N` for a deterministic budget cut). It is queryable in select / order by AND filterable post-walk in the top-level `where` (a `where` conjunct referencing a recursion intrinsic filters the walk's RESULT — `from blocks where type == \"list_item\" && $leaf follow block.children` = the leaves; the non-recursion conjuncts remain the seed predicate). Recursion intrinsics are NOT valid in the follow-local successor `where` or `frontier` (those run mid-walk, before the metadata exists), nor inside a consumer directive. Cyclic graphs are safe: a revisited node is admitted once as a `$stop == \"cycle\"` occurrence and never re-expanded. Type-preserving relations today: `block.children` (blocks→blocks, immediate child blocks), `section.children` (nodes→nodes, immediate child sections — a true outline depth ladder) and `section.subsections` (nodes→nodes, the whole transitive sub-tree — flattens to depth 2), and `doc.out` / `doc.in` (docs→docs, the authored citation graph — outgoing links / backlinks; inspect a doc's edges as rows via `doc.out_edges`/`doc.in_edges` (predicate/provenance/anchor filtered by a plain `where`)). Consumers compose over the walk (`$repo.blocks count { where … follow block.children }`). A `follow` may also nest inside a select-position `collect` for a per-row recursive subtree: `from docs select outline: nodes collect { where kind == \"md:section\" && name == \"Overview\" select n: name, d: $depth follow section.children }` (the collect's `where` seeds, correlated to the row; `follow` recurses; the collect's `select` projects each occurrence). Receivers: from docs — `nodes`, `blocks`, `doc.out`/`doc.in`, `doc.out_edges`/`doc.in_edges` (a doc's outgoing/incoming edges as rows); from nodes — `section.blocks` (content under an `md:section` node's heading, transitively including deeper headings), `section.children` (immediate child sections), and `section.subsections` (all contained sections); from blocks — `section` (enclosing `md:section` node(s)), `block.children` (child blocks), `block.nodes` (the projected nodes anchored to this block — links/tasks/anchors/…), and `block.out_edges` (this block's outgoing edges as rows — body links + inline fields; frontmatter edges are doc-grain, use `doc.out_edges`); from any scope — `$repo.docs` / `$repo.nodes` / `$repo.blocks`. Returns lean hits {id, path, ...projections} with truncated + cursor (or a `count`/`exists` scalar for those consumers). Covers structural + section navigation + ad-hoc correlation + bounded recursive traversal (`follow`).",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // A `semantic(...)` query with no provider is semantic_unavailable (not a
        // generic filter error) — surface that specific code, mirroring resolve.
        if (!ctx.embedQuery && collectSemanticPhrases(args.query).length > 0) {
          throw new EngineError("semantic_unavailable", "no embedding provider configured for this server");
        }
        return ok(await oqxRunAsync(store, repoId, args.query, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }, ctx.embedQuery));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "graph",
    {
      description:
        "Neighborhood macro: the bounded graph AROUND one or more root documents in ONE call — { documents, edges, frontier } — so you can orient without hand-writing an OQX `follow`. This is a CONVENIENCE WRAPPER, not a new engine: it compiles its args into an OQX `follow doc.out`/`doc.in` query and runs it through the same `query` path (the returned `queries` field is the exact follow query it generated). It does NOT replace `follow` or `from edges` — reach for the `query` tool directly when you need successor/frontier predicates, `by`-keyed identity, `$ordinal` budgets, cross-document correlation, or the edge scan with its own projections. `roots` are one or more doc refs (paths and/or ids); they are depth 0. `degrees` is the max hop distance (root = 0; maps to `follow { depth degrees+1 }`, capped so degrees+1 ≤ 8; default 1). `direction` is `out` (outgoing links), `in` (backlinks), or `both` (default). `predicate` restricts the neighborhood to documents reachable from a root via edges of that predicate (both the documents and the edges are filtered). `select` adds document projections (OQX select expressions, e.g. \"layer\", \"$path\"). `max_documents` caps the distinct document set (default 200) with a `truncated` flag. Returns: `documents` (each with `id`/`path`/`degree` = min hops from a root/`frontier` bool + your projections), `edges` (the traversed edges with full provenance — `predicate`/`provenance`/`dst_kind`/`anchor`/`src_field` + `src`/`dst`/`dst_path`/`dst_uri`; external `x_…` and dangling phantom endpoints are preserved as edge stubs, exactly as `from edges` surfaces them), and `frontier` (the documents on the outer boundary — min degree == degrees; at degrees 0 that is the roots themselves).",
      inputSchema: {
        roots: z.array(z.string()).min(1),
        degrees: z.number().int().optional(),
        direction: z.enum(["in", "out", "both"]).optional(),
        predicate: z.string().optional(),
        select: z.array(z.string()).optional(),
        max_documents: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // A `select` using semantic(...) needs a provider — surface the specific
        // code, mirroring the `query` tool.
        if (!ctx.embedQuery && (args.select ?? []).some((s) => collectSemanticPhrases(`from docs select x: ${s}`).length > 0)) {
          throw new EngineError("semantic_unavailable", "no embedding provider configured for this server");
        }
        return ok(await graphNeighborhood(store, repoId, args, ctx.embedQuery));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "text_search",
    {
      description: "Full-text (FTS5, bm25-ranked) keyword search over block text. Input is treated as a search box — plain words are ANDed, \"quoted phrases\" match adjacency, punctuation like / is safe (no query DSL). For structured filtering or frontmatter projection use `query` instead (see query_syntax).",
      inputSchema: { q: z.string(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return ok(textSearch(store, repoId, args.q, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "resolve",
    {
      description: "Resolve a name/title/concept to the concrete blocks it refers to — 'the id of the thing I mean'. Hybrid ranker (FTS + semantic when a provider is configured); best on short, entity-shaped inputs (a title, term, or phrase). Returns ranked {id, locator, preview, evidence}; prefer the returned ids in follow-up calls. For open natural-language questions or passage retrieval, use `query` with `semantic` instead.",
      inputSchema: { query: z.string(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const input: Parameters<typeof resolveThing>[1] = { repoId, query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) };
        // Hybrid: fuse the query vector into the ranking when a provider is
        // configured (mirrors CLI `omg find`). Absent ⇒ FTS-only.
        if (ctx.embedQuery) input.vector = await ctx.embedQuery(args.query);
        return ok(resolveThing(store, input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "apply",
    {
      description:
        "The only real writer. Applies a changeset of kernel ops (insert/update/move/remove/split/merge) atomically — all apply or none. Each op is a tagged object keyed by \"op\"; the block an op targets is named by its `block` (update/split) or `blocks` (move/remove/merge) field, never `id`/`target`. Ops apply in order; later ops see earlier effects; minted ids are referenceable via \"$n.ids[i]\". Pass dry_run:true first for multi-doc changes to preview diffs. update/split/merge/remove take a CAS `expect.content_hash` — get it from docs_read include_ids (its `hashes` map) in the same read that gave you the ids, or use the ref-accepting block_* sugar (blocks_update/blocks_split/…) which pins it server-side. Conflicts carry current truth — including a missing/omitted expect.content_hash, whose error now returns the current hash — so retry from the error, don't re-read.",
      inputSchema: {
        ops: z.array(opSchema),
        reason: z.string().optional(),
        dry_run: z.boolean().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const res = apply(store, {
          repoId, rootPath,
          ops: args.ops as Op[],
          origin: { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) },
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        });
        // A dry run previews without writing — don't schedule a drain for it.
        return args.dry_run ? ok(res) : okMutated(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- block-level sugar (ref-accepting peers of the `apply` primitive) -------
  // These mirror the CLI verbs `insert`/`update`/`move`/`rm`/`split`/`merge`
  // 1:1. Each takes human REFS (a block id or anything resolveRef accepts),
  // resolves them + pins CAS server-side, builds exactly the op the CLI would,
  // and applies it. This is what lets `omg <verb> --server` feel identical to
  // local: the resolution that used to live in the CLI now lives next to the
  // store, so a remote client needs no local database.

  server.registerTool(
    "blocks_insert",
    {
      description: "Insert new block(s) parsed from `markdown` under a parent, at a position. `to` names the parent: a BLOCK ref (id or locator) nests the new blocks under that block, or a DOCUMENT ref (doc id or path) places them at the document's top level — so appending a new section to a document is `{ to: \"<path>\", markdown: \"## New\\n\\n…\" }` (the positional generalization of docs_append). `at` places among the parent's children: \"end\" (default) / \"start\" / {before|after: <block ref>}. Expands to one insert op through the kernel writer.",
      inputSchema: { to: z.string(), markdown: z.string(), at: atSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const { parent, docId } = resolveParentRef(repoId, args.to);
        const to = { parent, at: resolveAt(repoId, args.at) };
        // A document parent carries no block to infer the doc from; pin it.
        const ops: Op[] = [{ op: "insert", ...(typeof parent === "object" ? { doc: docId } : {}), to, markdown: args.markdown } as Op];
        return applyOps(repoId, root, ops, "blocks_insert", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "blocks_update",
    {
      description: "Replace a block's markdown (and/or set attrs) with compare-and-swap. `block` is a ref; `expect.content_hash` is pinned to the block's current bytes server-side when omitted (protects against a concurrent edit). One update op through the kernel writer. `markdown` may parse to SEVERAL sibling blocks (e.g. a paragraph followed by a list): the target keeps its id and takes the first, the rest are inserted right after it with fresh ids — the response carries `id` (the target) and `ids` (all resulting blocks, in order). A list item may likewise be replaced by a multi-item list (`- a\\n- b`), yielding sibling items. Task state is settable flat as `checked` (the same name reads flatten to — `from blocks where checked`), folded into attrs and synced to the `[ ]`/`[x]` in the raw. The general `attrs` bag is still accepted; note every OTHER block attr (heading `level`, code `lang`, list `ordered`) is derived from the markdown, so set those by editing `markdown`, not attrs.",
      inputSchema: { block: z.string(), markdown: z.string().optional(), checked: z.boolean().optional(), attrs: z.record(z.string(), z.unknown()).optional(), expect: expectSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args.block);
        const expect = args.expect ?? (() => { const h = pinHash(block); return h ? { content_hash: h } : undefined; })();
        // Flat `checked` sugar folds into the attrs bag (explicit attrs wins on
        // collision), so a task reads and writes under the same bare name.
        const attrs = (args.checked !== undefined || args.attrs)
          ? { ...(args.checked !== undefined ? { checked: args.checked } : {}), ...(args.attrs ?? {}) }
          : undefined;
        const ops: Op[] = [{ op: "update", block, ...(args.markdown !== undefined ? { markdown: args.markdown } : {}), ...(attrs ? { attrs } : {}), ...(expect ? { expect } : {}) } as Op];
        const res = apply(store, { repoId, rootPath: root, ops, origin: { actor: "agent:mcp", reason: "blocks_update" }, ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}) });
        // `ids` lists every resulting block (the target first, then any siblings
        // minted from multi-block content); `id` keeps the target for convenience.
        const ids = res.results[0]?.ids ?? [block];
        const payload = { id: ids[0] ?? block, ids, ...res };
        return args.dry_run ? ok(payload) : okMutated(payload);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "blocks_move",
    {
      description: "Move block(s) under a new parent at a position. `blocks` are block refs; `to` (the parent) is a block ref, or the blocks' OWN document (id or path) to move them to its top level — moving to ANOTHER document's root is not expressible (target_missing): anchor on a block in that document with `at` {before|after} instead. `at` is \"end\"/\"start\"/{before|after: <ref>}. One move op through the kernel writer.",
      inputSchema: { blocks: z.array(z.string()), to: z.string(), at: atSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        const { parent, docId } = resolveParentRef(repoId, args.to);
        // The kernel reads `{ doc: true }` + start/end as "the SOURCE doc's top
        // level", so a document parent is only honest when it IS the source doc.
        if (typeof parent === "object" && blocks[0] !== undefined && docIdOfBlock(blocks[0]) !== docId) {
          throw new EngineError("target_missing", `blocks_move cannot target another document's root (${args.to}); anchor on a block in that document with at.before/at.after`, { data: { to: args.to } });
        }
        const to = { parent, at: resolveAt(repoId, args.at) };
        const ops: Op[] = [{ op: "move", blocks, to } as Op];
        return applyOps(repoId, root, ops, "blocks_move", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "blocks_remove",
    {
      description: "Remove block(s) (the resurrection pool catches regret). `blocks` are refs; removing a block removes its whole subtree, and a set that names both a container and some of its descendants (e.g. every id of a section straight from docs_read include_ids) is fine — it collapses to the top-most blocks and `removed` lists everything that left. One remove op through the kernel writer. To delete a whole document use docs_delete.",
      inputSchema: { blocks: z.array(z.string()), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        const ops: Op[] = [{ op: "remove", blocks } as Op];
        return applyOps(repoId, root, ops, "blocks_remove", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "blocks_split",
    {
      description: "Split a block at character offset(s) into consecutive blocks. `block` is a ref; `at` is a list of integer offsets. CAS is pinned to the block's current bytes server-side. One split op through the kernel writer.",
      inputSchema: { block: z.string(), at: z.array(z.number().int()), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args.block);
        const ops: Op[] = [{ op: "split", block, at: args.at, expect: { content_hash: pinHash(block) ?? "" } } as Op];
        return applyOps(repoId, root, ops, "blocks_split", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "blocks_merge",
    {
      description: "Merge adjacent blocks into the first, joined by `separator` (default a blank line). `blocks` are refs (≥2). One merge op through the kernel writer.",
      inputSchema: { blocks: z.array(z.string()), separator: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        const ops: Op[] = [{ op: "merge", blocks, ...(args.separator !== undefined ? { separator: args.separator } : {}) } as Op];
        return applyOps(repoId, root, ops, "blocks_merge", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tasks_complete",
    {
      description: "Macro: check (or, with checked:false, uncheck) the given task blocks. `blocks` are refs. Expands to update(attrs:{checked}) per block, CAS-pinned, applied via the same changeset machinery.",
      inputSchema: { blocks: z.array(z.string()), checked: z.boolean().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        const checked = args.checked ?? true;
        const ops: Op[] = checked
          ? tasksComplete(store, blocks)
          : blocks.map((block) => ({ op: "update", block, attrs: { checked: false }, ...(() => { const h = pinHash(block); return h ? { expect: { content_hash: h } } : {}; })() } as Op));
        return applyOps(repoId, root, ops, "tasks_complete", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "node_set",
    {
      description:
        "Macro: surgically set one editable property of a projected node (e.g. a link's `name` text or `value` target, a task's `checked`). Takes the node id (from query from:nodes), a property, and its new value. Resolves the node to its block and rewrites only that node's span, applying one update op. Nodes are read-only projections — this is the affordance to edit what a node represents without hand-rewriting the block. Errors node_not_editable (with the editable prop list) when the kind/prop has no editor.",
      inputSchema: { node: z.string(), prop: z.string(), value: z.string(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const ops = nodeSet(store, args.node, args.prop, args.value);
        return applyOps(repoId, root, ops, "node_set", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sections_append",
    {
      description:
        "Macro: append markdown at the end of a heading's section range. `heading` accepts the heading's block id (preferred, from docs_outline) OR its text — text is resolved to an id, scoped to `doc`/`path` when given. Heading text without a doc scope is repo-wide and errors ambiguous_heading (with candidate ids) when it isn't unique. Expands to a single insert op.",
      inputSchema: { heading: z.string(), markdown: z.string(), doc: z.string().optional(), path: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const headingId = resolveHeadingId(repoId, args.heading, { ...(args.doc ? { doc: args.doc } : {}), ...(args.path ? { path: args.path } : {}) });
        const ops = sectionsAppend(headingId, args.markdown);
        return applyOps(repoId, root, ops, "sections_append", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_append",
    {
      description:
        "Macro: append markdown at the END of a whole document — the journal/log/running-note primitive (the document-root peer of sections_append, which appends inside a heading's section). ADDITIVE and identity-preserving, NOT a whole-body replace: the `text` is parsed into blocks and inserted as NEW top-level blocks after the document's existing ones, so every existing block keeps its stable `b_` id (omgbase deliberately has no whole-body `docs_put` — see mcp-api). Expands to a single insert op at the document top level (position end); commits atomically through the same kernel path as `apply`, returning the new revision(s) and the inserted block ids. Target the document with `doc` (id OR path) or `path`. The document must already exist — a missing doc errors `doc_missing` (creating one is docs_create's job, never this). To append inside a specific heading section instead, use sections_append.",
      inputSchema: { doc: z.string().optional(), path: z.string().optional(), text: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        // Resolve the ref to a live doc id FIRST — a missing doc is doc_missing
        // (resolveDocId throws it), never an auto-create. Then expand to the
        // single top-level insert-at-end op and apply it (existing blocks keep
        // their ids; only the appended blocks are minted).
        const docId = resolveDocId(repoId, { ...(args.doc ? { doc: args.doc } : {}), ...(args.path ? { path: args.path } : {}) });
        const ops = docsAppend(docId, args.text);
        return okMutated(apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason: "docs_append" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_retarget",
    {
      description: "Macro: rewrite ONE link destination everywhere it is linked — the single-pair form of links_repair (same matching rules: whole link destinations only, leading `/` optional, fragments preserved; prose/inline code/code fences untouched). Scope source docs with `path_glob`. ALWAYS call with dry_run:true first to preview `hits` + `pairs` (the dry run plans through the kernel, so it fails exactly where the apply would), then dry_run:false to apply.",
      inputSchema: { from_target: z.string(), to_target: z.string(), path_glob: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const { ops, hits, pairs } = linksRetarget(store, repoId, args.from_target, args.to_target, args.path_glob ? { pathGlob: args.path_glob } : {});
        const dryRun = args.dry_run !== false;
        const res = apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason: "links_retarget" }, dryRun });
        if (dryRun) return ok({ hits, pairs, applied: false, ...res });
        return okMutated({ hits, pairs, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_stale",
    {
      description:
        "READ-ONLY link health: surfaces DANGLING internal links — links whose target path has NO live document (stored as a `phantom:` edge; a doc created at that path auto-resolves them). Returns `stale[]` (each with srcPath, srcBlock, predicate, provenance, `target` = the canonical missing path WITHOUT a leading `/` (e.g. `guides/old.md`), `authored` = the destination text exactly as written in the source block (e.g. `/guides/old.md#Setup`; null for frontmatter edges), `anchor`, and reason `dangling_doc`), plus `externalCount` (http(s) links — UNVERIFIABLE here, never marked broken, since reachability needs network I/O the engine won't do), `totalOpenEdges`, and `truncated` (capped by `limit`, default 500). `summary:true` returns counts only — `staleCount`, `byTarget[{target,count}]`, `bySource[{srcPath,count}]`, `externalCount`, `totalOpenEdges` — for a repo-wide audit in one small call. Scope the SOURCE docs with `path_glob` (e.g. \"journal/*\"; `*` matches across `/`). Fix the reported targets with `links_repair` (batch) or `links_retarget` (single): either `target` or `authored` works as `from`. Anchors (#heading/^ref) into an existing doc are NOT verified in v1. Contrast docs_read/query which answer 'what does this doc say', not 'which of its links are broken'.",
      inputSchema: { path_glob: z.string().optional(), limit: z.number().int().optional(), summary: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        if (args.summary) return ok(linksStaleSummary(store, repoId, args.path_glob ? { pathGlob: args.path_glob } : {}));
        return ok(linksStale(store, repoId, {
          ...(args.path_glob ? { pathGlob: args.path_glob } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_repair",
    {
      description:
        "Macro: BULK stale-link repair — rewrite one or MANY LINK DESTINATIONS in ONE changeset. Pass `repairs` (an array of {from,to}) to fix several dangling targets — e.g. those surfaced by links_stale — at once; a single {from_target,to_target} pair is also accepted. MATCHING: `from` must be the WHOLE destination of a Markdown link/image `[t](dest)`, a wikilink `[[dest]]`/`[[dest|alias]]`, or a bare-path inline field `key:: /dest` — a leading `/` is optional on either side (so links_stale's `target` or `authored` both work), and a trailing `#heading`/`^ref` fragment on the link is kept and re-appended to `to`. NOT rewritten: prose mentions, inline code, `code_fence` blocks, longer paths that merely contain `from`, and frontmatter values (use docs_set_meta). Scope source docs with `path_glob` (as in links_stale). Ops coalesce to one update per TOP-MOST block (a list and its items count once), so a batch never trips over its own re-minted children. Returns `hits[{block,path,oldRaw,newRaw}]` and `pairs[{from,to,hits}]` (per-pair destination counts; 0 = nothing matched). ALWAYS call with dry_run:true first — the dry run plans through the kernel (returns `diffs`), so it fails exactly where the apply would — then dry_run:false to apply.",
      inputSchema: {
        repairs: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        from_target: z.string().optional(),
        to_target: z.string().optional(),
        path_glob: z.string().optional(),
        dry_run: z.boolean().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const repairs = args.repairs
          ? args.repairs
          : args.from_target !== undefined && args.to_target !== undefined
            ? [{ from: args.from_target, to: args.to_target }]
            : null;
        if (!repairs || repairs.length === 0) {
          throw new EngineError("target_missing", "links_repair requires `repairs` (array of {from,to}) or a `from_target`+`to_target` pair");
        }
        const { ops, hits, pairs } = linksRepair(store, repoId, repairs, args.path_glob ? { pathGlob: args.path_glob } : {});
        // The dry run plans through the same kernel path (dryRun: no write, no
        // drain) so a preview surfaces exactly the failure an apply would hit.
        const dryRun = args.dry_run !== false;
        const res = apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason: "links_repair" }, dryRun });
        if (dryRun) return ok({ hits, pairs, applied: false, ...res });
        return okMutated({ hits, pairs, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Doc-level operations (06 §API). The MCP server serializes writes in-process,
  // so these pass no omgbaseDir (the flock is for cross-process CLI writers);
  // MCP-originated writes are actor agent:mcp.
  const docCtx = (scope: { repoId: string; rootPath: string | undefined }) => {
    if (!scope.rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
    return { repoId: scope.repoId, rootPath: scope.rootPath, actor: "agent:mcp" };
  };

  server.registerTool(
    "docs_create",
    {
      description: "Create a new document at `path` from complete file bytes (`markdown`), with optional structured `frontmatter`. Fails path_taken if it already exists.",
      inputSchema: { path: z.string(), markdown: z.string(), frontmatter: z.record(z.string(), z.unknown()).optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        return okMutated(docsCreate(store, docCtx(repoScope(args.repo)), args.path, args.markdown, args.frontmatter));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_move",
    {
      description:
        "Rename a document to a new repo-relative path; block identity and history are preserved. Fails path_taken if the destination exists. Links follow the PATH, not the identity: inbound links written against the old path now dangle (their edges become `phantom:<old path>`, so links_stale reports them), and links already written against the new path start resolving to this doc. The result lists those `dangling` inbound links ({doc, path, block, target, anchor, field?} per occurrence; block null = a frontmatter relation). Pass `retarget_inbound:true` to rewrite them in the same call — a destination-aware rewrite (anchors/link text/code spans preserved, absolute vs relative style kept) applied as one CAS-checked changeset, after which `dangling` holds only what could not be rewritten (frontmatter relations) and `retargeted` lists the touched blocks/docs.",
      inputSchema: { doc: z.string(), to_path: z.string(), retarget_inbound: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        return okMutated(docsMove(store, docCtx(repoScope(args.repo)), args.doc, args.to_path, { retargetInbound: args.retarget_inbound === true }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_delete",
    {
      description: "Delete a document: tombstone it and its live blocks (resurrection-poolable) and remove the file. Requires the explicit doc id/path.",
      inputSchema: { doc: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        return okMutated(docsDelete(store, docCtx(repoScope(args.repo)), args.doc));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_set_meta",
    {
      description: "Surgical frontmatter patch: set the given keys and/or unset named keys, re-ingesting the document. Other frontmatter is preserved.",
      inputSchema: { doc: z.string(), set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        return okMutated(docsSetMeta(store, docCtx(repoScope(args.repo)), args.doc, {
          ...(args.set ? { set: args.set } : {}),
          ...(args.unset ? { unset: args.unset } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_plan_update",
    {
      description:
        "Plan a whole-document update WITHOUT applying it. Given a doc (id or path) and the proposed complete `content`, reconciles the new representation against the current stable block tree and returns an executable *opset*: the exact kernel ops (insert/update/move/remove) it would run, each annotated with its identity consequence (disposition, confidence, reason), plus a summary (preserved/updated/moved/created/removed) and a human-readable plan. The opset carries preconditions (base revision + content hash); a stale plan is refused at apply. `converges` is verified by simulation (replaying the ops reproduces `content` byte-for-byte); when a lowering diverges, `diagnostics[]` names the first differing byte offset and the proposed block (index/type/byte range) that failed to round-trip. Use this to inspect identity effects before committing, or as the reviewable half of docs_update.",
      inputSchema: { doc: z.string(), content: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const opset = planUpdate(store, repoId, rootPath, args.doc, args.content);
        return ok({ opset, plan: renderOpsetPlan(opset) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_update",
    {
      description:
        "Whole-document update with smart identity preservation. Submit the complete proposed `content` for a doc (id or path); the engine reconciles it against the current tree, preserving stable block ids for structure that is recognizably the same (edits, moves, reorders), minting for new structure, and tombstoning removals — then commits the derived opset through the kernel write path. Frontmatter changes are applied too. dry_run:true returns the opset + plan without writing (identical to docs_plan_update). Conflicts (the doc changed since planning) fail stale_plan — re-run. A plan whose replay cannot reproduce `content` byte-for-byte fails plan_not_convergent; the message names the first divergent byte and the proposed block (index/type) that failed to round-trip (full diagnostics in `data.diagnostics`). This is docs_plan_update + apply(opset).",
      inputSchema: { doc: z.string(), content: z.string(), reason: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { opset, result } = docsUpdate(store, docCtx(repoScope(args.repo)), args.doc, args.content, {
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        const payload = { opset, plan: renderOpsetPlan(opset), result };
        return args.dry_run ? ok(payload) : okMutated(payload);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "observe",
    {
      description:
        "SYNC INGEST (ADR-014): record `content` as the current authoritative bytes for `path`, committed as an OBSERVED-origin revision — a write *around* the engine, the way a human/external edit is recorded. Contrast docs_update, which is api-origin (a write *through* the engine, agent intent); both reconcile the new bytes against the current block tree and preserve stable ids, but the origin differs (and thus the change-feed semantics and matcher path). This is the file→DB direction for an out-of-process synchronizer: it never writes a file, so it works on a headless/sourceless server with no working tree. Idempotent: bytes whose hash already equals the stored revision are an ECHO — no commit (`echo:true`, `rev:null`). Bytes with git conflict markers are still ingested (opaque) and the doc is flagged (`conflicted:true`). To mirror a deletion, use docs_delete. Returns doc/path/rev plus a disposition summary (how identity threaded).",
      inputSchema: { path: z.string(), content: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(observeFile(store, repoId, args.path, args.content));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "observe_many",
    {
      description:
        "BATCH sync ingest (ADR-014): observe several files at once — the batch form of `observe`. Give `files` as an array of `{path, content}`; each is echo-gated and reconciled independently, all under one timestamp and a single resurrection-pool sweep (cheaper than N `observe` calls for an initial walk or a large checkpoint). Returns one result per input file (same shape as `observe`). Mirror deletions with `docs_delete`.",
      inputSchema: { files: z.array(z.object({ path: z.string(), content: z.string() })), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(observeMany(store, repoId, args.files));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "observe_delete",
    {
      description:
        "SYNC DELETE (ADR-014): record that `path` left the source scope — tombstone the live doc as an OBSERVED deletion (its blocks are pooled for resurrection if the path reappears; no file is removed, since it is already gone from the source). The deletion counterpart to `observe`, for a synchronizer mirroring an external delete. Idempotent: a path with no live doc is a no-op (`deleted:false`). Contrast `docs_delete` — an api-origin, intentional, non-pooled removal that also unlinks the working-tree file.",
      inputSchema: { path: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(observeDelete(store, repoId, args.path));
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
      inputSchema: { doc: z.string(), from_rev: z.string(), to_rev: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // Resolve `doc` id-or-path FIRST: diffBlocks keys its SQL on the doc id,
        // so a raw path here would silently return an empty diff (no error) —
        // the misleading-empty trap. resolveDocId throws doc_missing when the
        // ref names no document.
        const docId = resolveDocId(repoId, { doc: args.doc });
        return ok(diffBlocks(store, docId, args.from_rev, args.to_rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "diff_unified",
    {
      description:
        "Line-based unified diff between two revisions of a document (the `omg diff` rendering): returns `{ doc, path, from, to, diff }` where `diff` is the +/- unified text. `from_rev`/`to_rev` default to the previous and current revisions ('what did the last commit change here'). Contrast `diff`, which returns block-grain added/removed/changed entries.",
      inputSchema: { doc: z.string(), from_rev: z.string().optional(), to_rev: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = resolveDocId(repoId, { doc: args.doc });
        const revs = store.db
          .prepare("SELECT rev_id FROM revisions WHERE doc_id = ? ORDER BY seq DESC LIMIT 2")
          .all(docId) as { rev_id: string }[];
        const toRev = args.to_rev ?? revs[0]?.rev_id;
        const fromRev = args.from_rev ?? revs[1]?.rev_id ?? revs[0]?.rev_id;
        if (!toRev || !fromRev) throw new EngineError("target_missing", `no revisions to diff for ${JSON.stringify(args.doc)}`);
        const path = (store.db.prepare("SELECT path FROM docs WHERE doc_id = ?").get(docId) as { path: string } | undefined)?.path ?? "";
        return ok({ doc: docId, path, from: fromRev, to: toRev, diff: diffUnified(store, docId, fromRev, toRev) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_read_at",
    {
      description:
        "TIME-TRAVEL read: the whole file bytes of a document AS OF a past revision — `content` is the reconstructed source at that `rev` (fences/tables/list markers preserved), plus `path`/`docId`/`rev`. Use this to audit or answer 'what did this doc say at revision N', or to fetch the exact prior text before reverting. Get a `rev` from diff, history_node, or changes_since. Contrast: docs_read = current bytes; diff = block-grain changes BETWEEN two revisions. `renderedHashMatch` is true when the reconstruction is byte-for-byte the file at that revision; it can be false for an old revision ONLY when the document's leading/frontmatter trivia (separator bytes, not block content) changed since — block content always reconstructs faithfully. `properties` are CURRENT values (propertiesAreCurrent:true), since property history is not stored. Args take a doc id or path plus a rev id.",
      inputSchema: { doc: z.string().optional(), path: z.string().optional(), rev: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = resolveDocId(repoId, args);
        const res = readDocumentAtRevision(store, docId, args.rev);
        if (!res) throw new EngineError("target_missing", `no revision ${JSON.stringify(args.rev)} for document ${docId}`, { data: { doc: docId, rev: args.rev } });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_history",
    {
      description:
        "VERSION HISTORY of matching documents, grouped BY DOCUMENT: for each doc, its ordered revision list (oldest→newest) with `rev`/`seq`/`commit`/`ts`/`origin`/`actor`/`contentHash`/`isCurrent`. Give `path_glob` (e.g. \"journal/*\" — `*` matches ACROSS `/`, so journal/* and journal/** are equivalent) OR a single `doc` (id or path); at least one is required. `contentHash` (hex of the revision's rendered file hash) lets you spot no-op vs real changes. Feed a returned `rev` into `docs_read_at` (whole doc AT that rev) or `diff` (block-grain changes BETWEEN two revs). By default only live docs; `include_deleted:true` also returns tombstoned docs (their history is intact for audit). `limit` caps DOCUMENTS returned (default 50) with a `truncated` flag. Contrast `changes_since`: a repo-wide COMMIT feed, not this per-document view.",
      inputSchema: {
        path_glob: z.string().optional(),
        doc: z.string().optional(),
        include_deleted: z.boolean().optional(),
        limit: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        if (!args.path_glob && !args.doc) {
          throw new EngineError("target_missing", "docs_history requires one of path_glob or doc");
        }
        if (args.doc) {
          // Validate the ref resolves (or, when include_deleted, a tombstoned doc
          // exists). findDocByRef does the id-or-path dispatch (isValidId); the
          // tombstone fallback uses the same dispatch.
          const info = findDocByRef(store, repoId, args.doc);
          const asId = isValidId(args.doc, "d");
          const known = info || (args.include_deleted
            ? store.db.prepare(asId ? "SELECT 1 FROM docs WHERE doc_id = ?" : "SELECT 1 FROM docs WHERE repo_id = ? AND path = ?").get(...(asId ? [args.doc] : [repoId, args.doc]))
            : undefined);
          if (!known) throw new EngineError("doc_missing", `no document for ${JSON.stringify(args.doc)}`);
        }
        return ok(docHistory(store, repoId, {
          ...(args.path_glob ? { pathGlob: args.path_glob } : {}),
          ...(args.doc ? { doc: args.doc } : {}),
          ...(args.include_deleted !== undefined ? { includeDeleted: args.include_deleted } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "changes_since",
    {
      description: "The change feed: commit digests after a cursor (repo commit seq) with one-line summaries. Each digest's `revisions[]` carries `{doc, path, contentHash}` (contentHash = hex of the revision's rendered file hash), so a synchronizer can decide 'changed vs echo' without a follow-up docs_read. Filter by `origin` (api/observed/import) to ignore commits a given writer produced. Poll with your last cursor to cheaply re-orient after time away. Paging: `cursor` is the last digest's `seq` (a dense per-REPO order — a cursor is only meaningful against the same `repo` it came from); pass it back while `truncated` is true. `head` is the repo's current max seq: an empty page with cursor == head means nothing new, cursor > head means the cursor belongs to a different repo/server.",
      inputSchema: { cursor: z.number().int().optional(), origin: z.enum(["api", "observed", "import"]).optional(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
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
    {
      description:
        "Repo counts: docs, blocks, commits, open edges, unconverged doc count, and on-disk drift. " +
        "`disk` reports a READ-ONLY scan of the working tree vs the DB: `changed` (files edited on disk but not re-ingested), " +
        "`deleted` (docs whose file is gone from disk), `untracked` (new *.md not yet ingested), and `checked` " +
        "(false when the server has no working-tree path — disk agreement is then UNVERIFIED, not clean).",
      inputSchema: { ...REPO_ARG },
    },
    async (args) => {
      try { const { repoId, rootPath } = repoScope(args.repo); return ok(reposStatus(store, repoId, rootPath)); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "sync_status",
    {
      description:
        "Watcher/sync state: last commit seq, last checkpoint, and whether the repo is convergent. " +
        "`convergent` is true ONLY when the DB is internally converged AND a working-tree scan ran (`diskChecked`) AND found no drift " +
        "(`disk.changed`/`deleted`/`untracked` all 0). If the server has no working-tree path, `diskChecked` is false and `convergent` is " +
        "false — a green light is never shown while disk freshness is unverified, so an agent can trust `convergent: true` to mean not stale.",
      inputSchema: { ...REPO_ARG },
    },
    async (args) => {
      try { const { repoId, rootPath } = repoScope(args.repo); return ok(syncStatus(store, repoId, rootPath)); } catch (e) { return fail(e); }
    },
  );

  // List the repos in this workspace (multi-repo discovery for a client): slug +
  // whether it has a filesystem source. The `repo` arg other tools take is a slug
  // from here. (repos_status gives per-repo counts.)
  server.registerTool(
    "repos",
    {
      description:
        "List the repos in this workspace: `{ repos: [{ slug, hasSource }] }`. A client addresses any of them by passing that `slug` as the `repo` argument to another tool (omit `repo` ⇒ the server's default repo). Use repos_status for per-repo counts/convergence.",
      inputSchema: {},
    },
    async () => {
      try {
        const rows = store.db
          .prepare(
            "SELECT r.slug AS slug, MAX(CASE WHEN s.adapter = 'fs' THEN 1 ELSE 0 END) AS has_fs FROM repos r LEFT JOIN attachments a ON a.repo_id = r.repo_id LEFT JOIN sources s ON s.source_id = a.source_id GROUP BY r.repo_id, r.slug ORDER BY r.slug",
          )
          .all() as { slug: string; has_fs: number }[];
        return ok({ repos: rows.map((r) => ({ slug: r.slug, hasSource: r.has_fs === 1 })) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
