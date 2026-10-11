import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Store } from "../core/store/store.js";
import { docsOutline } from "../core/read/outline.js";
import { docsRead, docsReadMany, MANY_DOCS_CAP, readDocumentAtRevision } from "../core/read/document.js";
import { nodesGet, nodesGetMany } from "../core/read/nodes.js";
import { findDoc, docsList, docsTree, DOCS_LIST_DEFAULT_LIMIT, DOCS_TREE_DEFAULT_LIMIT } from "../core/read/reader.js";
import { resolveRef } from "../core/read/refs.js";
import { VERSION } from "../core/index.js";
import { normalizeText, normalizeVisibleText } from "../core/hash.js";
import { oqxRunAsync, collectSemanticPhrases, type EmbedQuery } from "../oqx/run.js";
import { graphNeighborhood } from "./graph.js";
import { textSearch } from "../search/text.js";
import { EngineError, errorBody } from "./errors.js";
import { argumentError, validateArguments, type ArgShape } from "./arguments.js";
import { apply, type Op } from "../mutate/apply.js";
import { tasksComplete, sectionsAppend, docsAppend, linksRetarget, linksRepair, nodeSet } from "../mutate/macros.js";
import { docsCreate, docsMove, docsDelete, docsSetMeta } from "../mutate/docs.js";
import { docsUpdate } from "../mutate/plan-update.js";
import { renderOpsetPlan } from "../mutate/opset.js";
import { historyNode, diffBlocks, docDiffUnified, changesSince, docHistory } from "../graph/history.js";
import { linksStale, linksStaleSummary } from "../graph/link-health.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus, reposList } from "../sync/admin.js";
import { observeFile, observeMany, observeDelete } from "../sync/observe.js";
import { QUERY_SYNTAX } from "./reference.js";
import { versionInfo, type HostInfo } from "../version.js";
import { storagePath, referencePath } from "../core/paths.js";
import { isContainerBlock } from "../format/index.js";
import {
  surfaceApplyResult, surfaceDocOpResult, surfaceDocMoveResult, surfaceObserveResult, surfaceObserveDeleteResult,
  surfaceTextSearch, surfaceResolveHits, surfaceRetargetHits, surfaceDocsUpdate,
} from "../surface-paths.js";

// MCP server (mcp-api). The full tool surface wired to the engine: read
// (docs_tree, docs_list, docs_outline, docs_read(_many), blocks_read(_many), query, blocks_search,
// blocks_resolve), mutate (apply + macros), graph, history (blocks_history,
// docs_diff, changes_since), admin (repos_status, sync_status). Uniform truncated+cursor
// on lists; stable error-code mapping.
//
// Paths (spec/surface §1 "Paths", 2.0): every path a tool returns is the
// reference form (`/a/b.md`) and every path argument accepts either form. The
// surface-owned readers root their own results; the results another spec pins
// in the storage form (apply, the document operations, observe, search) are
// re-shaped here through `surface-paths.ts` — the same functions the `omg`
// verbs call, so the two clients cannot drift.
//
// Arguments (spec/surface §4 "Arguments", 3.0): a tool's prefix names the row
// kind it addresses, and `id` / `path` in its arguments are that kind's
// attributes — `docs_read { id?, path? }`, `docs_diff { id?, path? }`,
// `blocks_read { id }`, `nodes_set { id }`; list and mixed-reference arguments
// keep role names (`ids`, `docs`, `roots`, `to`, `blocks`). One verb returns
// the row: `read`. There is no bare `doc` argument any more. Every call is validated by
// `validateArguments` ahead of its handler (the `tool` wrapper + the
// CallTool handler below), so a wrong name is a `filter_invalid` naming the
// nearest valid one, never the SDK's generic validation text.

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
   * tool's `semantic` param yields `provider_unavailable` (no provider). The
   * host (CLI `omg mcp`) supplies this from the repo's configured embedder.
   */
  embedQuery?: (text: string) => Promise<{ model: string; vec: Float32Array }>;
  /** The configured provider's name (`embedding.provider`), for the
   *  `provider_unavailable` error's `data` when the host knows it. */
  embedProvider?: string;
  /**
   * Called after any successful write tool (apply/macros/doc ops). The host
   * (CLI `omg mcp`) uses this to schedule a background embed drain so a block's
   * vector stays fresh without a manual `omg embed drain`. Must be cheap and
   * non-blocking — it fires on the mutation's response path; the actual
   * embedding happens off it. Absent ⇒ mutations don't auto-drain.
   */
  onMutation?: () => void;
  /**
   * The serving binary's identity for the `version` tool (spec/surface §4): its
   * own version, build info and the module its component packages resolve from.
   * Set by `omg mcp`; absent for a library embedding (the tool then reports the
   * engine's own version and whatever components resolve from core).
   */
  host?: HostInfo;
}

// Kernel-op schemas (04 §1) published as the `apply` tool's op grammar. Giving
// each op a real schema (rather than z.any()) makes the required fields
// discoverable in the tool's JSON schema and turns a malformed op — e.g. an
// `update` missing its `block` id — into a boundary validation error naming the
// field, instead of a downstream `block_missing` for "block undefined". The
// grammar (`block`, `blocks`, `to`, `at`, `expect.content_hash`, `op`) is
// spec/mutate's and is not renamed by the surface's argument rule.
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
// blocks_insert / blocks_move carry the op-level expectation of spec/mutate §1.2:
// only `parent_children_hash` (the destination parent's live direct child ids
// joined by "," and sha256-hexed) has a meaning there — there is no target block
// whose content_hash could be checked — so the schema names that one key alone
// (an accidental `content_hash` is dropped, not an error; the kernel would
// ignore it anyway).
const parentExpectSchema = z.object({
  parent_children_hash: z.string().optional(),
});
const expectSchema = z.object({
  content_hash: z.string().optional(),
  parent_children_hash: z.string().optional(),
});
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), doc: z.string().optional(), to: toSchema, markdown: z.string(), expect: expectSchema.optional() }),
  z.object({ op: z.literal("update"), block: z.string(), markdown: z.string().optional(), attrs: z.record(z.string(), z.unknown()).optional(), expect: expectSchema.optional() }),
  z.object({ op: z.literal("move"), blocks: z.array(z.string()), to: toSchema, expect: expectSchema.optional() }),
  z.object({ op: z.literal("remove"), blocks: z.array(z.string()), expect: z.record(z.string(), expectSchema).optional() }),
  z.object({ op: z.literal("split"), block: z.string(), at: z.array(z.number().int()), expect: expectSchema.optional() }),
  z.object({ op: z.literal("merge"), blocks: z.array(z.string()), separator: z.string().optional(), expect: z.record(z.string(), expectSchema).optional() }),
]);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err: unknown): ToolResult {
  // One mapping for every client (errors.ts `errorBody`): the CLI renders the
  // same body, so a code can never differ between `omg` and `omg mcp`.
  return { content: [{ type: "text", text: JSON.stringify(errorBody(err)) }], isError: true };
}

/** The message every tool uses for a `semantic(...)` call the server cannot rank. */
export const PROVIDER_UNAVAILABLE_MESSAGE =
  "semantic(...) needs an embedding provider; none is configured — set embedding.provider (omg config set embedding.provider <command|url>) and embed the repository (omg embed drain)";

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "omgbase", version: VERSION });
  const { store } = ctx;

  // ---- registration: listing through the SDK, validation + dispatch ours ----
  // `server.registerTool` publishes the name, description and JSON schema on
  // `tools/list`; the `tools/call` handler is replaced below so the arguments
  // are validated by `validateArguments` (spec/surface §4 "Arguments") and a
  // failure is the engine's own `filter_invalid`, not the SDK's text.
  const registry = new Map<string, { shape: ArgShape; handler: (args: Record<string, unknown>) => Promise<ToolResult> }>();
  function tool<S extends ArgShape>(
    name: string,
    def: { description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ): void {
    server.registerTool(name, def, handler as never);
    registry.set(name, { shape: def.inputSchema, handler: handler as (args: Record<string, unknown>) => Promise<ToolResult> });
  }

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
  // The document locator every `docs_*` tool takes (§4 "Arguments"): the row's
  // own attributes, at least one of them.
  const DOC_ARGS = { id: z.string().optional(), path: z.string().optional() };

  // Wrap a successful write's result: notify the host so it can schedule a
  // background embed drain. onMutation must be cheap/non-blocking (see
  // ServerContext); we never await it, keeping it off the response path.
  function okMutated(payload: unknown): ToolResult {
    ctx.onMutation?.();
    return ok(payload);
  }

  // ---- the document locator (§4 "Arguments") ---------------------------------
  // `id` is the document's id, `path` its path (either form, §1 "Paths"); at
  // least one is required, and when both are given they must name the same
  // document. A miss is `doc_missing` "no document with id or path "<value>""
  // with the arguments as given in `data`;
  // neither given is `filter_invalid` "pass id or path"; a disagreement is
  // `filter_invalid` "id "…" and path "…" name different documents". `findDoc`
  // never falls through from an id to a path.
  function locateDoc(repoId: string, toolName: string, shape: ArgShape, args: Record<string, unknown>): string {
    const [idKey, pathKey] = ["id", "path"] as const;
    const id = args[idKey] as string | undefined;
    const path = args[pathKey] as string | undefined;
    if (id === undefined && path === undefined) throw argumentError(toolName, `pass ${idKey} or ${pathKey}`, shape);
    const given: Record<string, string> = { ...(id !== undefined ? { [idKey]: id } : {}), ...(path !== undefined ? { [pathKey]: path } : {}) };
    const missing = (value: string) => new EngineError("doc_missing", `no document with ${idKey} or ${pathKey} ${JSON.stringify(value)}`, { data: given });
    const byId = id !== undefined ? findDoc(store, { docId: id }) : null;
    if (id !== undefined && (!byId || byId.repoId !== repoId)) throw missing(id);
    const byPath = path !== undefined ? findDoc(store, { repoId, path }) : null;
    if (path !== undefined && !byPath) throw missing(path);
    if (byId && byPath && byId.docId !== byPath.docId) {
      throw argumentError(toolName, `${idKey} ${JSON.stringify(id)} and ${pathKey} ${JSON.stringify(path)} name different documents`, shape);
    }
    return (byId ?? byPath)!.docId;
  }
  // The owning document of a block id (`blocks_read`): the block must be live.
  function docOfBlock(blockId: string): string {
    const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { doc_id: string } | undefined;
    if (!row) throw blockMissing(blockId);
    return row.doc_id;
  }
  function blockMissing(value: string): EngineError {
    return new EngineError("block_missing", `no block with id ${JSON.stringify(value)}`, { data: { id: value } });
  }

  // `docs_append`'s `section`: a heading's TEXT, matched against the normalized
  // heading text of the named document's live headings (an ATX-looking value,
  // "## Title", loses its hashes). Zero → `parent_missing` naming the heading;
  // several → `ambiguous_heading` with the candidates `[{ id, doc_id }]` (pass
  // the heading's id to `blocks_append` instead). Never an id lookup — the
  // id form is `blocks_append`'s (§9).
  function resolveSectionHeading(docId: string, docPath: string, section: string): string {
    const needle = /^[ \t]*#/.test(section) ? normalizeVisibleText(section, "heading") : normalizeText(section);
    const rows = store.db
      .prepare("SELECT block_id, doc_id, text FROM blocks WHERE doc_id = ? AND type = 'heading' AND deleted_commit IS NULL")
      .all(docId) as { block_id: string; doc_id: string; text: string }[];
    const matches = rows.filter((r) => normalizeText(r.text) === needle);
    const shown = referencePath(docPath);
    if (matches.length === 0) {
      throw new EngineError("parent_missing", `no heading ${JSON.stringify(section)} in ${shown}`, { data: { section, path: shown } });
    }
    if (matches.length > 1) {
      throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(section)} matches ${matches.length} headings in ${shown}; pass the heading's id to blocks_append`, {
        data: { section, path: shown, candidates: matches.map((m) => ({ id: m.block_id, doc_id: m.doc_id })) },
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
    if (!r || r.kind !== "block" || !r.blockId) throw blockMissing(ref);
    return r.blockId;
  }
  // Resolve a PARENT ref for insert/move: a block ref names that block as the
  // parent; a document ref (id or path) names the document's top level — the
  // kernel's `{ doc: true }` parent — so "append a new section to this doc" is
  // one blocks_insert call, not a detour through docs_append. Returns the doc
  // the parent lives in so the caller can pin the op to it.
  function resolveParentRef(repoId: string, ref: string): { parent: string | { doc: true }; docId: string } {
    const r = resolveRef(store, repoId, ref);
    if (!r) throw new EngineError("block_missing", `no block or document with id or path ${JSON.stringify(ref)}`, { data: { ref } });
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
    const res = surfaceApplyResult(apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason }, ...(dryRun !== undefined ? { dryRun } : {}) }));
    return dryRun ? ok(res) : okMutated(res);
  }
  // Guard shared by every mutating tool: a sourceless (headless-only) repo has no
  // working tree to write through, so mutation is disabled with a loud error.
  function requireRoot(rootPath: string | undefined): string {
    if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
    return rootPath;
  }

  // ---- semantic(): loud when it cannot rank (§4, 3.0) ---------------------------
  // No provider → `provider_unavailable` before anything runs (`data.provider`
  // null). A provider that answers but whose model has embedded NOTHING in this
  // repository would score every row null and hand back path-ordered rows with
  // no score — so the first phrase embedded checks the index and fails the same
  // code, naming the provider and model and what to run.
  function hasEmbeddings(repoId: string, model: string): boolean {
    const row = store.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM doc_embeddings de JOIN docs d ON d.doc_id = de.doc_id WHERE d.repo_id = ? AND de.model = ?)
            OR EXISTS (SELECT 1 FROM embeddings WHERE model = ?)`,
      )
      .get(repoId, model, model);
    return row !== undefined;
  }
  function providerUnavailable(): EngineError {
    return new EngineError("provider_unavailable", PROVIDER_UNAVAILABLE_MESSAGE, { data: { provider: null } });
  }
  function rankableEmbed(repoId: string): EmbedQuery | undefined {
    const embed = ctx.embedQuery;
    if (!embed) return undefined;
    return async (text: string) => {
      const r = await embed(text);
      if (!hasEmbeddings(repoId, r.model)) {
        const who = ctx.embedProvider ? `provider ${JSON.stringify(ctx.embedProvider)} (model ${r.model})` : `model ${r.model}`;
        throw new EngineError("provider_unavailable", `semantic(...) cannot rank: ${who} is configured but nothing in this repository is embedded under it — run omg embed drain`, {
          data: { provider: ctx.embedProvider ?? null, model: r.model },
        });
      }
      return r;
    };
  }

  tool(
    "docs_outline",
    {
      description:
        "Orientation call. Returns a document's compact indented outline (alias/type/label per line, § marks section headings). IDs are stable; prefer them in follow-ups. Address the document by `id` or `path` (at least one; a `path` in either form). For the whole document body in one call, use docs_read.",
      inputSchema: {
        ...DOC_ARGS,
        resolution: z.enum(["skeleton", "outline"]).optional(),
        depth: z.number().int().optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_outline", registry.get("docs_outline")!.shape, args);
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

  tool(
    "docs_read",
    {
      description:
        "Read a whole document in one call: `raw` is the complete file bytes verbatim (fences/tables/list markers preserved), `properties` is the document's property bag grouped by source — `{ frontmatter, inline, computed }` — plus `id`/`path`/`rev` (the document's row attributes, spelled as the query language spells them). What `properties.frontmatter` holds is format-dependent: for markdown it's the parsed frontmatter fence; for YAML/JSON it's the parsed object the file represents; other adapters extract per their format. `inline` holds dataview-style `key:: value` fields from the body; `computed` holds engine intrinsics (`title`, `tags`). The cold-start 'read the guide before doing anything' call. Address the document by `id` or `path` (at least one; a query hit's `id`/`path` are the values to pass). Pass include_ids:true to also get the document's block ids in order (`ids`) AND `hashes` — a {block `id` → block `hash`} map giving the exact `expect.content_hash` value the raw `apply` kernel needs, so one read yields both the ids and the CAS tokens to mutate them (no follow-up blocks_read_many hydration) — AND `parents`, a {block id → parent block id | null} map (null = top level), because `ids` is a flat pre-order walk and a list is otherwise indistinguishable from its items; filter to `parents[id] === null` for the top-level blocks. For structure-only orientation use docs_outline; to hydrate a single block use blocks_read.",
      inputSchema: {
        ...DOC_ARGS,
        include_ids: z.boolean().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_read", registry.get("docs_read")!.shape, args);
        const res = docsRead(store, docId, args.include_ids ? { includeIds: true } : {});
        if (!res) throw new EngineError("doc_missing", `no document with id or path ${JSON.stringify(args.id ?? args.path)}`, { data: { id: docId } });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_read_many",
    {
      description:
        "Batch whole-document read — the hydrate half of query→hydrate. The plural of docs_read: pass `docs`, a list of refs (each a document id OR a path, in either form), and get back one full read per ref. Returns `{ items, errors, truncated }`: each found doc is a full docs_read projection (`raw` = complete file bytes verbatim, `properties` grouped by source, plus `id`/`path`/`rev`, and — with include_ids:true — the document's ordered block `ids`, a `hashes` {block `id` → block `hash`} map for raw-`apply` CAS pinning, and a `parents` {block id → parent block id | null} map so top-level vs nested blocks are distinguishable without an outline read); a ref that resolves to no live document lands in `errors` as {ref, error:\"doc_not_found\"} WITHOUT failing the call, so one bad ref never sinks the batch. Duplicate refs collapse first-seen (a repeated ref yields a single item). Capped at " + MANY_DOCS_CAP + " refs per call; excess refs are dropped and `truncated` is set. Pass budget_tokens to cap total hydrated size — the batch stops early and flags `truncated` when the next doc would exceed it; the FIRST doc always ships even when it alone exceeds the budget (the same at-least-one-row contract as docs_list/docs_tree, so a budgeted caller always makes progress). Use this after query/blocks_search/blocks_resolve to pull N whole docs in ONE round-trip instead of N serial docs_read calls; for a single doc use docs_read, and for lean structure-only orientation use docs_outline (docs_get_many before surface 3.0).",
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

  tool(
    "blocks_read",
    {
      description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full). `id` is the block's id — or any block ref: an `n_` node id dereferences to the block it was projected from, as on every block-level tool — and its document is inferred from it (nodes_get before surface 3.0: blocks used to be called nodes here, and `nodes` now names the extracted-entity rows). Every resolution carries the block's `id` and `type`; raw and full add `raw` (its source bytes) and `hash` (its own raw hash) — the value update/split need in expect.content_hash, so you can fetch it before editing rather than reading it back from a conflict; full adds `text`, `attrs`, `ordinal`, `depth` and `parent_id` (null at the top level). Use this to expand the lean ids returned by query/blocks_resolve. To read a whole document in one call, use docs_read (blocks_read on a heading's id returns only that block, not its section).",
      inputSchema: {
        id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // The ref goes through `resolveBlockRef` like every block-level tool's:
        // an `n_` node id dereferences to its block (what `read_ref` did before
        // 3.0 — `omg cat <n_…>` renders this tool).
        const blockId = resolveBlockRef(repoId, args.id);
        const node = nodesGet(store, docOfBlock(blockId), blockId, args.resolution ? { resolution: args.resolution } : {});
        if (!node) throw blockMissing(args.id);
        return ok(node);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_read_many",
    {
      description:
        "Fetch up to 100 blocks by id (in request order) with budget truncation — the plural of blocks_read (nodes_get_many before surface 3.0). Block ids are globally unique, so `ids` may span ANY number of documents — each id is resolved to its owning doc server-side. Result carries `nodes` (the hydrated blocks, one per resolved id), `truncated` (cap or `budget_tokens` hit — the first resolved block always ships even when it alone exceeds the budget, so a budgeted caller always makes progress), and `unresolved` — the requested ids that name no live block (never silently dropped).",
      inputSchema: {
        ids: z.array(z.string()),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        repoScope(args.repo);
        const res = nodesGetMany(store, null, args.ids, {
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_tree",
    {
      description:
        "ORIENTATION: the path-separator-aware shape of a repo in ONE small call — start here to answer 'what does this repo contain?', NOT with docs_list. Like `tree -L <depth>` crossed with `du`: every live document under `path` (a directory prefix; omit for the repo root) is collapsed at `depth` path segments (default 1 = immediate children), giving one entry per directory and one per shallow document. Returns `{ prefix, depth, total: { docs, blocks }, entries: [{ id?, path, kind: \"dir\"|\"doc\", docs, blocks, updated_at }], truncated, cursor }`: a `dir` entry's `path` ends in `/` (no `id`) and its `docs`/`blocks`/`updated_at` are the totals + latest last-commit timestamp UNDER it; a `doc` entry is a single document (docs = 1) with its `id`. `total` always covers everything under `prefix` regardless of paging, so you see the true size of what you're looking at. On an 800-document repo `depth:1` at the root is ~10 rows where docs_list would be ~800; descend by calling again with `path` set to a dir entry (or raise `depth`). Entries are ordered by path and paged: `limit` (default " + DOCS_TREE_DEFAULT_LIMIT + ") / `cursor` / `budget_tokens` with an honest `truncated`. For ranked or attribute-based discovery use `blocks_resolve`/`query`; to enumerate the documents themselves once you know where to look, use docs_list with a `path_glob`.",
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

  tool(
    "docs_list",
    {
      description:
        "ENUMERATE live documents (the `omg ls` operation) as a page: `{ items: [{ id, path, updated_at, blocks }], truncated, cursor }` — the document's id, its path (`/`-rooted, as every path the surface returns), last-commit timestamp (ISO, or null) and live block count — ordered by path. This is a flat `ls`, not an orientation primitive: unscoped on a large repo it is hundreds of rows, and the engine has no directory concept here — `path_glob` is a simple LIKE match where `*` matches ANY run INCLUDING `/` (so `projects/*` is the whole subtree; there is no 'immediate children only'). To learn a repo's shape, call docs_tree first, then scope this with a `path_glob` once you know where to look. Paged under the uniform list contract: `limit` (default " + DOCS_LIST_DEFAULT_LIMIT + ") caps rows, `cursor` (from a truncated page) resumes after the last row returned, `budget_tokens` caps the page's estimated size (at least one row is always returned), and `truncated` is honest — when true you have NOT seen everything. For structured/ranked discovery use `query` or `blocks_resolve`.",
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

  tool(
    "query_syntax",
    {
      description:
        "Reference: the full `query` (OQX) syntax — the clause order, the sugar (a block without a consumer is collect, where-first bodies, brackets, postfix `!`, `is`/`is not`, `and`/`or`/`not`), `/`-rooted paths, targets and field namespaces, scalar semantics and absence, domain predicates incl. `refs()`, nested queries and the root row (`^docs`, `^id`, `0^docs`), `select`/`order by`/paging, `follow`, and worked examples. Call this before writing a non-trivial query. No arguments.",
      inputSchema: {},
    },
    async () => ok({ syntax: QUERY_SYNTAX }),
  );

  tool(
    "query",
    {
      description:
        "OQX (omgbase Query eXpressions) — composable query in ONE expression. Two rules: DOT navigation belongs to the host object model (`doc.layer`, `section.blocks`, `target.out`); WHITESPACE query directives belong to OQX — a nested query is `<receiver> collect|exists|count|first|single { <block> }` (a postfix directive + a `{ … }` block), never a method. `from E` selects a property/relation relative to the current source scope and flattens it (a typed flatMap): top-level `from docs|blocks|nodes|links` selects the repository's docs/blocks/nodes/links (the `links` target is the authored link graph as first-class rows — one row per link RELATION; the `md:link` node is a link's occurrence in the text, `via_id` points at it, and a frontmatter link has a row and no node — `id`/`path` plus the plain fields doc_id/block_id/via_id/dst_id/dst_path/uri/predicate/provenance/dst_kind/anchor/field, with path/doc.* reaching the SOURCE doc); `where`; `select`. Its distinctive power is receiver-constrained nested queries that correlate to the current row: `from docs where nodes exists { where kind == \"md:task\" }` returns only the docs that themselves contain a matching node (not a global scan). Directives: `exists { … }` / `count { … }` in where — with an optional count comparison `nodes count { where kind == \"md:task\" } >= 2`; `collect { … }` in select for hierarchical results, nestable (`select secs: nodes collect { select h: name, items: section.blocks collect { where type == \"list_item\" } where kind == \"md:section\" } from docs`). CLAUSE ORDER IS FIXED (ADR-020): within one body — the top level or any `{ block }` — clauses appear at most once each, in exactly this order: `select … from … where … follow … order by … limit N offset N`. Every clause is optional except a top-level `from`; an out-of-order clause is a parse error naming the order. ONLY `select` may drop its keyword, and only when it is the first clause written (`path, open from docs where …`; `nodes collect { attrs.text }` projects `attrs.text`). Every other clause carries its keyword, with one piece of sugar (oqx 0.17): a block's leading expression is its `where` when it is predicate-shaped (`nodes exists { kind == \"md:task\" }` ≡ `nodes exists { where kind == \"md:task\" }`); a bare name or dotted path is a projection, so filter on a bare field with `is active`, and `{ name where … }` is the projection + filter (`{ age >= 18, name }` is an error). A top-level predicate needs `where` (`where` follows `from`, so `age > 15 from people` is an error), a bare boolean property in leading position PROJECTS (`nodes collect { active }`), and `from docs count` is an error (write `docs count { … }` for the consumer, or `select count from docs` to project a field named count). More sugar, each desugaring in the parser to the explicit directive: a receiver block without a consumer is `collect` (`docs { type == \"x\" }`, `nodes { kind == \"md:task\" }` — not after `follow`, where `{ … }` is the options block); brackets `x[p]` = `x first { where p }` (the first match or absent), `x[p]!` = `x single { where p }` required (exactly one, else filter_invalid), `x[n]` = `x first { offset n }` (positional; out of range is absent); postfix `x!` = required (the value, or a loud error naming the expression and the row — never a filter, never a coercion; tightest: `a!.b` vs `a.b!`); prefix `is x` / `not x` (truthiness); infix `x is y` / `x is not y` compares identity (a row's id, else the value — `x is null` is the absence test; for scalars `is` ≡ `==`); and a `select` item may use the items to its left (`boss: ^docs[slug == ^manager], name: boss.title`). `and` / `or` / `not` are the connectives; `&&` / `||` / `!` are accepted synonyms (the canonical printer writes the words). `where` may reference the same body's `select` aliases (`select path, old: era < 1000 from docs where old` — inlined at parse time; an alias shadows a same-named field there). On the nodes/blocks targets a bare identifier that is not a structural field (doc_id, block_id, kind/name/value; doc_id, type/text, ordinal/depth) or row attribute (id, path, raw, hash, updated_at) reads the flattened attrs bag — `checked` == `attrs.checked`, `level` == `attrs.level` — so the name you filter on matches the name a projection returns (`select attrs.checked` yields key `checked`); the `attrs.<key>` form still works and an absent key is silently false. Any consumer accepts `distinct` to dedup the rows it reduces by their projected value — `nodes count distinct { select kind }`, `nodes collect distinct { select kind }`, top-level `select distinct type` (empty projection dedups by identity). `values` after a projection of exactly ONE item returns the bare value instead of a `{name: value}` record: at the top level `select path values from docs where layer == \"canon\"` returns `values: [\"a.md\", …]` (paged like hits; `hits` is empty), and inside a block `select tags: tags collect { $it values }` yields a plain array. `$it` is the current item itself — the row, or the scalar element when the receiver is a list property (`where tags exists { where $it == \"pricing\" }`); inside a block `^$it` is the enclosing row. `none { … }` is the zero-cardinality test — true iff the block yields no rows (≡ `!… exists { … }`), and how \"every\" is spelled: `nodes none { where kind == \"md:task\" and not checked }` = no open tasks; also a whole-query directive (`docs none { … }` returns `none`). `limit N` / `offset N` bound a row set AFTER where/order/distinct and BEFORE the consumer reduces it, so they mean the same under every consumer: at the top level (`order by era desc limit 3` — the tool's `limit`/`cursor` then page within that bounded set) or inside any block (`nodes collect { … order by ordinal limit 1 }`; `nodes exists { offset 1 }` = at least two). `entries(x)` turns a record into a collection of entries — inside the block `$key` is the property key and `$it` (and bare names) the value: `select fm: entries(frontmatter) collect { k: $key, v: $it }`, `from nodes where kind == \"md:task\" and entries(attrs) exists { where $key == \"checked\" and $it }`; works on `data` (the merged authored bag: frontmatter + inline) / `frontmatter` / `inline` (nested dotted keys folded back — an authored `$`-prefixed key such as `$version` is reached as `frontmatter.$version` and listed by `entries(frontmatter)`; a bare `$version` is an unknown OQX name and reads nothing), `attrs`, a nested frontmatter map, or a list (numeric index keys). Plain objects never auto-iterate; `entries()` is the explicit bridge. The where clause is a boolean tree: compose scalar predicates and consumer directives with `and`, `or`, `not`, and grouping (`layer == \"canon\" or nodes exists { where kind == \"md:task\" }`). Relative source: `from E` inside a top-level consumer block re-projects the rows — `docs collect { from nodes where kind == \"md:task\" }` starts at docs, projects each doc through its `nodes` relation, and queries the resulting nodes (a scalar relation like `from doc` contributes one row; a missing/non-navigable relation is a loud error, never a global scan). One-scope lift: a `collect` in `where` with a `^name` both filters (non-empty) and binds the matching values into the parent select in one expression — `select path, open from docs where nodes collect { ^open: value where kind == \"md:task\" and not attrs.checked }` returns the docs with an open task, each carrying its open-task texts. Correlation / joins (the `^` sigil, symmetric with the lift): a nested query may READ a name bound one scope outward — bind it in the parent (a select value or a lift), then reference `^name` inside a nested query's where. Combined with the root row's collections `^docs` / `^nodes` / `^blocks` / `^links` (the repository is OQX's root row, one scope out from a top-level row — one caret per enclosing block, or the absolute `0^docs` from any depth; an UNBOUNDED repository scan, uncorrelated until you add a `^` predicate) this expresses lateral/dependent joins without a JOIN keyword: `^<t> exists { where … == ^k }` = semi-join, `not … exists { … }` = anti-join, `… collect { … }` in select = nested left-join, and the select-only lookups `first { … }` / `single { … }` (zero-or-one / one-to-one; `single` errors if it matches >1) — e.g. `select owner_id, owner: ^nodes single { where kind == \"person\" and attrs.id == ^owner_id } from docs`. Membership over a lifted set: `<value> in ^keys`. `^` reads exactly ONE scope out (no arbitrary-ancestor search), and a bare name reads the CURRENT row only — it never falls through to an enclosing row or the root, so reach outward explicitly with `^name` (the enclosing row) or `^docs` / `0^docs` (the root row's collections; `^id` / `0^id` is the repository id, `^$it` the root object). A bare `docs` INSIDE a block is an error (\"did you mean `^docs`\"), never an empty read; `$repo` (surface < 2.0) is refused with the replacement spelled out. PATHS are `/`-rooted on the surface (surface 2.0): every path returned — `path`, an edge's `dst_path`, a hit's `path` — is the reference form (`/a/b.md`), and a string literal compared with `path`/`dst_path` by `==`/`!=` or passed to their `startsWith` accepts both forms (`path == \"a.md\"` and `path == \"/a.md\"` both match); a property's value is the author's, so a reference held in frontmatter compares with `^path` directly (`^docs { ^path in list(after) }` = the documents whose `after` names me). `refs(field)` resolves the document REFERENCES a property holds (a string or a list of `/a.md`, `a.md` or `d_…` elements; dangling and non-string elements dropped) to live docs rows, so it is a source (`from refs(\"/a.md\")`), a receiver (`refs(before) collect { path, when }`, `refs(see_also)[0]`) or a `follow` destination (`follow refs(before), refs(after)` walks a timeline both ways); `follow before` over the strings fails — a hit must be a document, block, node or edge row. Top-level consumers: the whole query can be a consumer directive over a bare root receiver (a target name at the root scope) to change its result shape — `docs count { … }`, `docs exists { … }` and `docs none { … }` reduce to a scalar (returned as `count`/`exists`/`none`, no hits), `docs first { … }` / `docs single { … }` return zero-or-one hit (`single` errors if the query matches >1); a bare `from …` is the collect form. (A bare target at the root scope is the same collection `^<target>` reaches from inside where/select.) Scalar predicates follow the @omgbase/oqx semantics (strict typed equality with absence normalized so `!=` over an absent field matches; case-sensitive string ops with `.lower()`/`.upper()` and a regex `matches()`; absent sorts last; arithmetic supported), including doc.<key> reach-through and `text(\"terms\")` — a full-text (FTS5) PRUNING predicate that, because it is an ordinary predicate, composes inside correlated subqueries and collects (e.g. `nodes exists { where kind == \"md:task\" and text(\"ship\") }`), which the flat `query` tool cannot express. (`text` prunes; relevance ranking is separate.) And `semantic(\"phrase\")` — an embedding cosine SCORE (docs/blocks only) usable as a threshold prune (`semantic(\"the great work\") > 0.6`) or a projection (`select score: semantic(\"…\")`); it needs an embedding provider that has embedded this repository (else `provider_unavailable`, naming what to configure — never a silent unranked result) and, like `text`, composes inside nested scopes. Ranking: `order by <expr> [asc|desc], …` sorts the result (`order by semantic(\"the great work\") desc` = semantic top-K; also orders by any frontmatter field / `path`), always tie-broken by (path, id) for a total order — this is how score functions become a ranking. A custom order disables the keyset cursor (you still get the top `limit` with `truncated`). Recursion (`follow`): make the query recursive over a TYPE-PRESERVING relation (the relation's successor type must equal the query target). `from blocks where id == \"b_x\" follow block.children` walks the block subtree from a seed; the `where` picks the SEED rows and `follow <relation>` expands them. A bare `follow <relation>` carries no sub-clauses; sub-clauses go in a `{ … }` block. Two orthogonal knobs shape it: a follow-local `follow <rel> { where <pred> }` filters which successors keep participating at each hop (running out ⇒ a leaf), and `{ frontier <pred> }` cuts a relation that could otherwise continue (⇒ a frontier); `{ depth <n> }` bounds the walk (1..8, default 8). `follow distinct` dedups reached rows by identity (the default keeps one occurrence per distinct walk path). `follow … { by <expr> }` sets the node identity used for cycle detection + dedup to a field/intrinsic (default: the entity id) — e.g. `follow doc.out { by group }` treats same-`group` documents as one node. Each reached row carries recursion metadata: `$depth` (seed = 1), the categorical `$stop` (interior | leaf | frontier | depth | cycle) with `$leaf`/`$frontier` boolean sugar, and `$ordinal` (a deterministic 1..N rank over the walk, ordered by depth then path — `order by $ordinal` for walk order, `where $ordinal <= N` for a deterministic budget cut). It is queryable in select / order by AND filterable post-walk in the top-level `where` (a `where` conjunct referencing a recursion intrinsic filters the walk's RESULT — `from blocks where type == \"list_item\" and $leaf follow block.children` = the leaves; the non-recursion conjuncts remain the seed predicate). Recursion intrinsics are NOT valid in the follow-local successor `where` or `frontier` (those run mid-walk, before the metadata exists), nor inside a consumer directive. Cyclic graphs are safe: a revisited node is admitted once as a `$stop == \"cycle\"` occurrence and never re-expanded. Type-preserving relations today: `block.children` (blocks→blocks, immediate child blocks), `section.children` (nodes→nodes, immediate child sections — a true outline depth ladder) and `section.subsections` (nodes→nodes, the whole transitive sub-tree — flattens to depth 2), and `doc.out` / `doc.in` (docs→docs, the authored citation graph — outgoing links / backlinks; inspect a doc's links as rows via `doc.out_links`/`doc.in_links` (predicate/provenance/anchor filtered by a plain `where`)). Consumers compose over the walk (`blocks count { where … follow block.children }`). A `follow` may also nest inside a select-position `collect` for a per-row recursive subtree: `select outline: nodes collect { select n: name, d: $depth where kind == \"md:section\" and name == \"Overview\" follow section.children } from docs` (the collect's `where` seeds, correlated to the row; `follow` recurses; the collect's `select` projects each occurrence). Receivers: from docs — `nodes`, `blocks`, `doc.out`/`doc.in`, `doc.out_links`/`doc.in_links` (a doc's outgoing/incoming links as rows); from nodes — `section.blocks` (content under an `md:section` node's heading, transitively including deeper headings), `section.children` (immediate child sections), and `section.subsections` (all contained sections); from blocks — `section` (enclosing `md:section` node(s)), `block.children` (child blocks), `block.nodes` (the projected nodes anchored to this block — links/tasks/anchors/…), and `block.out_links` (this block's outgoing links as rows — body links + inline fields; frontmatter links are doc-grain, use `doc.out_links`); from any row — `^docs` / `^nodes` / `^blocks` / `^links` (the root row's collections; `0^docs` from any depth). Returns lean hits {id, path, ...projections} — the envelope keys are the attributes, so a hit's `id` pastes into the next `where id == …` unchanged, and is the value a tool's `id` argument takes (the name rule, surface 3.0: omgbase adds no `$` names — `$` belongs to OQX's `$it`/`$key`/`$depth`…; every engine attribute is bare snake_case and WINS on collision — id/path everywhere, raw/hash/updated_at on docs and blocks, title/tags/format on docs — and an authored key of the same name is reached through `data.<k>` / `frontmatter.<k>` / `inline.<k>`; `select id, path` is simply the envelope and any other projection whose key would be id/path must be aliased (`p: data.path`); every tool result spells a row with the same names) — with truncated + cursor (or a `count`/`exists` scalar for those consumers). Covers structural + section navigation + ad-hoc correlation + bounded recursive traversal (`follow`).",
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
        // A `semantic(...)` query with no provider is provider_unavailable (not a
        // generic filter error) — surface that specific code, mirroring graph.
        if (!ctx.embedQuery && collectSemanticPhrases(args.query).length > 0) throw providerUnavailable();
        return ok(await oqxRunAsync(store, repoId, args.query, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }, rankableEmbed(repoId)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "graph",
    {
      description:
        "Neighborhood macro: the bounded graph AROUND one or more root documents in ONE call — { documents, links, frontier } — so you can orient without hand-writing an OQX `follow`. This is a CONVENIENCE WRAPPER, not a new engine: it compiles its args into an OQX `follow doc.out`/`doc.in` query and runs it through the same `query` path (the returned `queries` field is the exact follow query it generated). It does NOT replace `follow` or `from links` — reach for the `query` tool directly when you need successor/frontier predicates, `by`-keyed identity, `$ordinal` budgets, cross-document correlation, or the links scan with its own projections. `roots` are one or more doc refs (paths and/or ids); they are depth 0. `degrees` is the max hop distance (root = 0; maps to `follow { depth degrees+1 }`, capped so degrees+1 ≤ 8; default 1). `direction` is `out` (outgoing links), `in` (backlinks), or `both` (default). `predicate` restricts the neighborhood to documents reachable from a root via edges of that predicate (both the documents and the edges are filtered). `select` adds document projections (OQX select expressions, e.g. \"layer\", \"path\"). `max_documents` caps the distinct document set (default 200) with a `truncated` flag. Returns: `documents` (each with `id`/`path`/`degree` = min hops from a root/`frontier` bool + your projections — a bare-name selection such as \"title\" is its own key, `id`/`path` land on the envelope keys, and any other expression is `sel_<i>`), `links` (the traversed links as rows of the `links` target under its own field names — `id`, `doc_id`/`block_id` (the source), `via_id`, `dst_id`, `dst_path`, `uri`, `dst_kind`, `predicate`, `provenance`, `anchor`, `field`; external `x_…` and dangling phantom endpoints are preserved as edge stubs, exactly as `from links` surfaces them), and `frontier` (the documents on the outer boundary — `{ id, path, degree }`, min degree == degrees; at degrees 0 that is the roots themselves).",
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
        if (!ctx.embedQuery && (args.select ?? []).some((s) => collectSemanticPhrases(`from docs select x: ${s}`).length > 0)) throw providerUnavailable();
        return ok(await graphNeighborhood(store, repoId, args, rankableEmbed(repoId)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_search",
    {
      description: "Full-text (FTS5, bm25-ranked) keyword search over block text: `{ hits: [{ id (the block), doc_id, path, type, text, score }], truncated }`. Input is treated as a search box — plain words are ANDed, \"quoted phrases\" match adjacency, punctuation like / is safe (no query DSL). For structured filtering or frontmatter projection use `query` instead (see query_syntax). (text_search before surface 3.0.)",
      inputSchema: { q: z.string(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return ok(surfaceTextSearch(textSearch(store, repoId, args.q, args.limit !== undefined ? { limit: args.limit } : {})));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_resolve",
    {
      description: "Resolve a name/title/concept to the concrete blocks it refers to — 'the id of the thing I mean'. Hybrid ranker (FTS + semantic when a provider is configured); best on short, entity-shaped inputs (a title, term, or phrase). Returns ranked `{ id, locator, preview, evidence }` (the block's id, its `path#type[ordinal]` locator); prefer the returned ids in follow-up calls. For open natural-language questions or passage retrieval, use `query` with `semantic` instead. (resolve before surface 3.0.)",
      inputSchema: { query: z.string(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const input: Parameters<typeof resolveThing>[1] = { repoId, query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) };
        // Hybrid: fuse the query vector into the ranking when a provider is
        // configured (mirrors CLI `omg find`). Absent ⇒ FTS-only.
        if (ctx.embedQuery) input.vector = await ctx.embedQuery(args.query);
        return ok(surfaceResolveHits(resolveThing(store, input)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "apply",
    {
      description:
        "The only real writer. Applies a changeset of kernel ops (insert/update/move/remove/split/merge) atomically — all apply or none. Each op is a tagged object keyed by \"op\"; the block an op targets is named by its `block` (update/split) or `blocks` (move/remove/merge) field, never `id`/`target` (the op grammar is spec/mutate's, unchanged by the surface's `id`/`path` argument rule). Ops apply in order; later ops see earlier effects; minted ids are referenceable via \"$n.ids[i]\". Pass dry_run:true first for multi-doc changes to preview diffs. The result is `{ results: [{ ids, … }], revisions: [{ id, path, hash }], diffs?, committed }` — one revision per touched document with its hash after the change (the same shape a changes_since revision has). update/split/merge/remove take a CAS `expect.content_hash` — get it from docs_read include_ids (its `hashes` map) in the same read that gave you the ids, or use the ref-accepting block_* sugar (blocks_update/blocks_split/…) which pins it server-side. Conflicts carry current truth (`data.current.hash` + `markdown`) — including a missing/omitted expect.content_hash, whose error returns the current hash — so retry from the error, don't re-read.",
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
        const res = surfaceApplyResult(apply(store, {
          repoId, rootPath,
          ops: args.ops as Op[],
          origin: { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) },
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        }));
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

  tool(
    "blocks_insert",
    {
      description: "Insert new block(s) parsed from `markdown` under a parent, at a position. `to` names the parent: a BLOCK ref (id or locator) nests the new blocks under that block — it must be a CONTAINER (a list, list item, task, blockquote or table); a leaf such as a heading or paragraph fails `type_mismatch` (spec/mutate §1.1) — use blocks_append for \"into this heading's section / this container\" or `at: {after: <ref>}` for \"right after this block\"; or a DOCUMENT ref (doc id or path) places them at the document's top level — so appending a new section to a document is `{ to: \"<path>\", markdown: \"## New\\n\\n…\" }` (the positional generalization of docs_append). `at` places among the parent's children: \"end\" (default) / \"start\" / {before|after: <block ref>}. Optional `expect.parent_children_hash` is the destination-parent CAS: the parent's CURRENT direct child ids (the document's top-level ids for a document `to`) joined by \",\" and sha256-hexed — compute it from docs_read include_ids (`ids` filtered by `parents`) — and the insert fails `stale_expectation` (with `data.current.parent_children_hash`) if the siblings changed under you; `content_hash` has no meaning here (there is no target block) and is not accepted. Expands to one insert op through the kernel writer.",
      inputSchema: { to: z.string(), markdown: z.string(), at: atSchema.optional(), expect: parentExpectSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const { parent, docId } = resolveParentRef(repoId, args.to);
        const to = { parent, at: resolveAt(repoId, args.at) };
        // A document parent carries no block to infer the doc from; pin it. The
        // caller's expect rides through as the op-level expectation (spec/mutate
        // §1.2: checked against the destination parent before the op mutates).
        const ops: Op[] = [{ op: "insert", ...(typeof parent === "object" ? { doc: docId } : {}), to, markdown: args.markdown, ...(args.expect ? { expect: args.expect } : {}) } as Op];
        return applyOps(repoId, root, ops, "blocks_insert", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_update",
    {
      description: "Replace a block's markdown (and/or set attrs) with compare-and-swap. `id` is the block's id (or any ref resolve accepts); `expect.content_hash` is pinned to the block's current bytes server-side when omitted (protects against a concurrent edit). One update op through the kernel writer. `markdown` may parse to SEVERAL sibling blocks (e.g. a paragraph followed by a list): the target keeps its id and takes the first, the rest are inserted right after it with fresh ids — the response carries `id` (the target) and `ids` (all resulting blocks, in order). A list item may likewise be replaced by a multi-item list (`- a\\n- b`), yielding sibling items. Task state is settable flat as `checked` (the same name reads flatten to — `from blocks where checked`), folded into attrs and synced to the `[ ]`/`[x]` in the raw. The general `attrs` bag is still accepted; note every OTHER block attr (heading `level`, code `lang`, list `ordered`) is derived from the markdown, so set those by editing `markdown`, not attrs.",
      inputSchema: { id: z.string(), markdown: z.string().optional(), checked: z.boolean().optional(), attrs: z.record(z.string(), z.unknown()).optional(), expect: expectSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args.id);
        const expect = args.expect ?? (() => { const h = pinHash(block); return h ? { content_hash: h } : undefined; })();
        // Flat `checked` sugar folds into the attrs bag (explicit attrs wins on
        // collision), so a task reads and writes under the same bare name.
        const attrs = (args.checked !== undefined || args.attrs)
          ? { ...(args.checked !== undefined ? { checked: args.checked } : {}), ...(args.attrs ?? {}) }
          : undefined;
        const ops: Op[] = [{ op: "update", block, ...(args.markdown !== undefined ? { markdown: args.markdown } : {}), ...(attrs ? { attrs } : {}), ...(expect ? { expect } : {}) } as Op];
        const res = surfaceApplyResult(apply(store, { repoId, rootPath: root, ops, origin: { actor: "agent:mcp", reason: "blocks_update" }, ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}) }));
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

  tool(
    "blocks_move",
    {
      description: "Move block(s) under a new parent at a position. `blocks` are block refs; `to` (the parent) is a block ref (a container — a leaf parent is `type_mismatch`, as for blocks_insert), or the blocks' OWN document (id or path) to move them to its top level — moving to ANOTHER document's root is not expressible (target_missing): anchor on a block in that document with `at` {before|after} instead. `at` is \"end\"/\"start\"/{before|after: <ref>}. Optional `expect.parent_children_hash` is the destination-parent CAS (as blocks_insert: the destination parent's CURRENT direct child ids joined by \",\", sha256 hex), checked once for the whole run before anything moves — `stale_expectation` with `data.current.parent_children_hash` if the destination's children changed; `content_hash` is meaningless here and not accepted. One move op through the kernel writer.",
      inputSchema: { blocks: z.array(z.string()), to: z.string(), at: atSchema.optional(), expect: parentExpectSchema.optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
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
        const ops: Op[] = [{ op: "move", blocks, to, ...(args.expect ? { expect: args.expect } : {}) } as Op];
        return applyOps(repoId, root, ops, "blocks_move", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
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

  tool(
    "blocks_split",
    {
      description: "Split a block at UTF-8 byte offset(s) into consecutive blocks. `id` is the block's id (or a ref); `at` is a list of integer byte offsets into the block's raw bytes (spec/mutate §2.5; an offset inside a multi-byte character rounds down to its start). CAS is pinned to the block's current bytes server-side. One split op through the kernel writer.",
      inputSchema: { id: z.string(), at: z.array(z.number().int()), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args.id);
        const ops: Op[] = [{ op: "split", block, at: args.at, expect: { content_hash: pinHash(block) ?? "" } } as Op];
        return applyOps(repoId, root, ops, "blocks_split", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
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

  tool(
    "blocks_check",
    {
      description: "Macro: check (or uncheck with checked:false) the given task blocks. `ids` are the blocks' ids (or refs). Expands to update(attrs:{checked}) per block, CAS-pinned, applied via the same changeset machinery (tasks_complete { blocks } before surface 3.0).",
      inputSchema: { ids: z.array(z.string()), checked: z.boolean().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const blocks = args.ids.map((b) => resolveBlockRef(repoId, b));
        const checked = args.checked ?? true;
        const ops: Op[] = checked
          ? tasksComplete(store, blocks)
          : blocks.map((block) => ({ op: "update", block, attrs: { checked: false }, ...(() => { const h = pinHash(block); return h ? { expect: { content_hash: h } } : {}; })() } as Op));
        return applyOps(repoId, root, ops, "blocks_check", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "nodes_set",
    {
      description:
        "Macro: surgically set one editable property of a projected node (e.g. a link's `name` text or `value` target, a task's `checked`). `id` is the node's id (from `query` over `from nodes` — the one tool that addresses `nodes` rows), `prop` the property, `value` its new value. Resolves the node to its block and rewrites only that node's span, applying one update op. Nodes are read-only projections — this is the affordance to edit what a node represents without hand-rewriting the block. Errors node_not_editable (with the editable prop list) when the kind/prop has no editor. (node_set before surface 3.0.)",
      inputSchema: { id: z.string(), prop: z.string(), value: z.string(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const known = store.db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND repo_id = ?").get(args.id, repoId);
        if (!known) throw new EngineError("block_missing", `no node with id ${JSON.stringify(args.id)}`, { data: { id: args.id } });
        const ops = nodeSet(store, args.id, args.prop, args.value);
        return applyOps(repoId, root, ops, "nodes_set", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_append",
    {
      description:
        "Macro: append markdown INTO a block, by what the block is. `id` is a block's id (or a ref). A HEADING: the `text` is inserted at the end of its section range (before the next heading of equal or higher level) — the former sections_append. A CONTAINER (a list, list item, task, blockquote or table — anything the kernel accepts as a parent): inserted at the end of its children (`blocks_insert { to: <id>, at: \"end\" }`). A LEAF (a paragraph, code fence, …) is `block_not_container` — append means \"into\", never a sibling insert; place after it with `blocks_insert { to: <its parent>, at: { after: <id> } }`. Expands to one insert op; to append at a whole document's end, or inside a section named by its heading TEXT, use docs_append.",
      inputSchema: { id: z.string(), text: z.string(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args.id);
        const row = store.db
          .prepare("SELECT b.type AS type, d.format AS format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) AS children FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL")
          .get(block) as { type: string; format: string | null; children: number } | undefined;
        if (!row) throw blockMissing(args.id);
        let ops: Op[];
        if (row.type === "heading") {
          ops = sectionsAppend(block, args.text);
        } else if (isContainerBlock(row.format ?? "markdown", { type: row.type, children: new Array<unknown>(row.children) })) {
          ops = [{ op: "insert", to: { parent: block, at: "end" }, markdown: args.text } as Op];
        } else {
          throw new EngineError("block_not_container", `block ${block} is a ${row.type}, not a heading or a container; append means into — insert after it with blocks_insert { to: <its parent>, at: { after: ${JSON.stringify(block)} } }`, {
            data: { id: block, type: row.type },
          });
        }
        return applyOps(repoId, root, ops, "blocks_append", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_append",
    {
      description:
        "Macro: append markdown to a document — at its END, or at the end of one of its sections when `section` names a heading by its TEXT (`\"Setup\"`; an ATX spelling `\"## Setup\"` is accepted). The journal/log/running-note primitive. ADDITIVE and identity-preserving, NOT a whole-body replace: the `text` is parsed into blocks and inserted as NEW blocks after the existing ones (at the document's top level, or inside the section's range), so every existing block keeps its stable `b_` id (omgbase deliberately has no whole-body `docs_put` — see mcp-api). Expands to a single insert op; commits atomically through the same kernel path as `apply`, returning the new revision(s) and the inserted block ids. Address the document by `id` or `path` (at least one). The document must already exist — a missing doc errors `doc_missing` (creating one is docs_create's job, never this); a `section` matching no heading in it is `parent_missing`, one matching several is `ambiguous_heading` with `candidates[{ id, doc_id }]` — pass that heading's id to blocks_append, which appends into a block by its id.",
      inputSchema: { ...DOC_ARGS, text: z.string(), section: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        // Resolve the locator to a live doc id FIRST — a missing doc is doc_missing
        // (locateDoc throws it), never an auto-create. Then expand to the single
        // insert-at-end op (document top level, or the named section) and apply
        // it (existing blocks keep their ids; only the appended blocks are minted).
        const docId = locateDoc(repoId, "docs_append", registry.get("docs_append")!.shape, args);
        let ops: Op[];
        if (args.section !== undefined) {
          const info = findDoc(store, { docId })!;
          ops = sectionsAppend(resolveSectionHeading(docId, info.path, args.section), args.text);
        } else {
          ops = docsAppend(docId, args.text);
        }
        return applyOps(repoId, root, ops, "docs_append", args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "links_retarget",
    {
      description: "Macro: rewrite ONE link destination everywhere it is linked — the single-pair form of links_repair (same matching rules: whole link destinations only, leading `/` optional, fragments preserved; prose/inline code/code fences untouched). Scope source docs with `path_glob`. ALWAYS call with dry_run:true first to preview `hits` + `pairs` (the dry run plans through the kernel, so it fails exactly where the apply would), then dry_run:false to apply.",
      inputSchema: { from_target: z.string(), to_target: z.string(), path_glob: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const { ops, hits: rawHits, pairs } = linksRetarget(store, repoId, args.from_target, args.to_target, args.path_glob ? { pathGlob: args.path_glob } : {});
        const hits = surfaceRetargetHits(rawHits);
        const dryRun = args.dry_run !== false;
        const res = surfaceApplyResult(apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason: "links_retarget" }, dryRun }));
        if (dryRun) return ok({ hits, pairs, applied: false, ...res });
        return okMutated({ hits, pairs, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "links_stale",
    {
      description:
        "READ-ONLY link health: surfaces DANGLING internal links — links whose target path has NO live document (stored as a `phantom:` edge; a doc created at that path auto-resolves them). Returns `stale[]` (each a link row under the `links` target's names: `doc_id`, `path` (the source document), `block_id` (null for a frontmatter edge), predicate, provenance, dst_kind, `target` = the canonical missing path, `/`-rooted like every path the surface returns (e.g. `/guides/old.md`), `authored` = the destination text exactly as written in the source block (e.g. `/guides/old.md#Setup`; null for frontmatter edges), `anchor`, and reason `dangling_doc`), plus `externalCount` (http(s) links — UNVERIFIABLE here, never marked broken, since reachability needs network I/O the engine won't do), `totalOpenEdges`, and `truncated` (capped by `limit`, default 500). `summary:true` returns counts only — `staleCount`, `byTarget[{target,count}]`, `bySource[{path,count}]`, `externalCount`, `totalOpenEdges` — for a repo-wide audit in one small call. Scope the SOURCE docs with `path_glob` (e.g. \"journal/*\"; `*` matches across `/`). Fix the reported targets with `links_repair` (batch) or `links_retarget` (single): either `target` or `authored` works as `from`. Anchors (#heading/^ref) into an existing doc are NOT verified in v1. Contrast docs_read/query which answer 'what does this doc say', not 'which of its links are broken'.",
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

  tool(
    "links_repair",
    {
      description:
        "Macro: BULK stale-link repair — rewrite one or MANY LINK DESTINATIONS in ONE changeset. Pass `repairs` (an array of {from,to}) to fix several dangling targets — e.g. those surfaced by links_stale — at once; a single {from_target,to_target} pair is also accepted. MATCHING: `from` must be the WHOLE destination of a Markdown link/image `[t](dest)`, a wikilink `[[dest]]`/`[[dest|alias]]`, or a bare-path inline field `key:: /dest` — a leading `/` is optional on either side (so links_stale's `target` or `authored` both work), and a trailing `#heading`/`^ref` fragment on the link is kept and re-appended to `to`. NOT rewritten: prose mentions, inline code, `code_fence` blocks, longer paths that merely contain `from`, and frontmatter values (use docs_set_meta). Scope source docs with `path_glob` (as in links_stale). Ops coalesce to one update per TOP-MOST block (a list and its items count once), so a batch never trips over its own re-minted children. Returns `hits[{id,path,oldRaw,newRaw}]` (the rewritten block and its document) and `pairs[{from,to,hits}]` (per-pair destination counts; 0 = nothing matched). ALWAYS call with dry_run:true first — the dry run plans through the kernel (returns `diffs`), so it fails exactly where the apply would — then dry_run:false to apply.",
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
        const { ops, hits: rawHits, pairs } = linksRepair(store, repoId, repairs, args.path_glob ? { pathGlob: args.path_glob } : {});
        const hits = surfaceRetargetHits(rawHits);
        // The dry run plans through the same kernel path (dryRun: no write, no
        // drain) so a preview surfaces exactly the failure an apply would hit.
        const dryRun = args.dry_run !== false;
        const res = surfaceApplyResult(apply(store, { repoId, rootPath, ops, origin: { actor: "agent:mcp", reason: "links_repair" }, dryRun }));
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
  // `dry_run` validates and returns the per-file `diffs` without writing
  // (`DocOpContext.dryRun`), the docs-verb peer of `apply`'s preview.
  const docCtx = (scope: { repoId: string; rootPath: string | undefined }, dryRun?: boolean) => {
    if (!scope.rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
    return { repoId: scope.repoId, rootPath: scope.rootPath, actor: "agent:mcp", ...(dryRun ? { dryRun: true } : {}) };
  };
  const docResult = <T,>(res: T, dryRun?: boolean) => (dryRun ? ok(res) : okMutated(res));

  tool(
    "docs_create",
    {
      description: "Create a new document at `path` (the new document's path, either form) from complete file bytes (`markdown`), with optional structured `frontmatter`; returns `{ id, path, committed }`. Fails path_taken if it already exists. dry_run:true validates and returns the would-be file under `diffs` (committed:false) without writing.",
      inputSchema: { path: z.string(), markdown: z.string(), frontmatter: z.record(z.string(), z.unknown()).optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        return docResult(surfaceDocOpResult(docsCreate(store, docCtx(repoScope(args.repo), args.dry_run), args.path, args.markdown, args.frontmatter)), args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_move",
    {
      description:
        "Rename a document to a new path (`to_path`, `/`-rooted or bare; the result `{ id, path, committed, retargeted, dangling }` reports the rooted form); the document is addressed by `id` or `path`. Block identity and history are preserved, and the inbound links FOLLOW it: every link written against the old path (Markdown links/images, wikilinks, bare-path inline fields — anchors, link text, titles and code spans preserved, absolute vs relative style kept) is rewritten to the new path in the same call as one CAS-checked changeset, so a move never leaves the graph broken. Fails path_taken if the destination exists. The result carries `retargeted` (the touched blocks/docs) and `dangling` — what could NOT be rewritten, i.e. frontmatter relations (block null; fix with docs_set_meta). Pass `retarget_inbound:false` to opt out for the rarer intent that the old path become unbound: the links are left as written, listed in `dangling` ({doc_id, path, block_id, target, anchor, field?} per occurrence — a link row under the `links` target's names) and reported by links_stale (their edges become `phantom:<old path>`); links already written against the new path start resolving to this doc either way. dry_run:true validates and returns the plan — `dangling`, `retargeted`, and the per-file `diffs` (the old path emptied, the new path filled, plus the rewritten sources) — without renaming or committing.",
      inputSchema: { ...DOC_ARGS, to_path: z.string(), retarget_inbound: z.boolean().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_move", registry.get("docs_move")!.shape, args);
        return docResult(surfaceDocMoveResult(docsMove(store, docCtx(scope, args.dry_run), docId, args.to_path, { retargetInbound: args.retarget_inbound !== false })), args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_delete",
    {
      description: "Delete a document: tombstone it and its live blocks (resurrection-poolable) and remove the file. Address it by `id` or `path`. dry_run:true validates and returns the file's removal under `diffs` without deleting.",
      inputSchema: { ...DOC_ARGS, dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_delete", registry.get("docs_delete")!.shape, args);
        return docResult(surfaceDocOpResult(docsDelete(store, docCtx(scope, args.dry_run), docId)), args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_set_meta",
    {
      description: "Surgical frontmatter patch: set the given keys and/or unset named keys on the document addressed by `id` or `path`, re-ingesting it. Other frontmatter is preserved. dry_run:true validates and returns the rewritten file under `diffs` without writing.",
      inputSchema: { ...DOC_ARGS, set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_set_meta", registry.get("docs_set_meta")!.shape, args);
        return docResult(surfaceDocOpResult(docsSetMeta(store, docCtx(scope, args.dry_run), docId, {
          ...(args.set ? { set: args.set } : {}),
          ...(args.unset ? { unset: args.unset } : {}),
        })), args.dry_run);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_update",
    {
      description:
        "Whole-document update with smart identity preservation. Submit the complete proposed `content` for a document (`id` or `path`); the engine reconciles it against the current tree, preserving stable block ids for structure that is recognizably the same (edits, moves, reorders), minting for new structure, and tombstoning removals — then commits the derived opset through the kernel write path. Frontmatter changes are applied too. dry_run:true is the PLAN-ONLY call (docs_plan_update before surface 3.0): nothing is written and the result is `{ opset, plan, result: null }` — the exact kernel ops (insert/update/move/remove) it would run, each annotated with its identity consequence (disposition, confidence, reason), a summary (preserved/updated/moved/created/removed) and a human-readable plan; the opset carries `precondition: { id, path, baseRevision, hash }` (the document's revision and hash at plan time) and `converges`, verified by replaying the ops (a divergence names the first differing byte and the proposed block in `diagnostics[]`). Use the dry run to inspect identity effects before committing, then call again without it. Conflicts (the doc changed since planning) fail stale_plan — re-run. A plan whose replay cannot reproduce `content` byte-for-byte fails plan_not_convergent; the message names the first divergent byte and the proposed block (index/type) that failed to round-trip (full diagnostics in `data.diagnostics`). This is the dry run's opset + apply(opset).",
      inputSchema: { ...DOC_ARGS, content: z.string(), reason: z.string().optional(), dry_run: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_update", registry.get("docs_update")!.shape, args);
        const { opset, result } = surfaceDocsUpdate(docsUpdate(store, docCtx(scope), docId, args.content, {
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        }));
        const payload = { opset, plan: renderOpsetPlan(opset), result };
        return args.dry_run ? ok(payload) : okMutated(payload);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "observe",
    {
      description:
        "SYNC INGEST (ADR-014): record `content` as the current authoritative bytes for `path`, committed as an OBSERVED-origin revision — a write *around* the engine, the way a human/external edit is recorded. Contrast docs_update, which is api-origin (a write *through* the engine, agent intent); both reconcile the new bytes against the current block tree and preserve stable ids, but the origin differs (and thus the change-feed semantics and matcher path). This is the file→DB direction for an out-of-process synchronizer: it never writes a file, so it works on a headless/sourceless server with no working tree. Idempotent: bytes whose hash already equals the stored revision are an ECHO — no commit (`echo:true`, `rev:null`). Bytes with git conflict markers are still ingested (opaque) and the doc is flagged (`conflicted:true`). To mirror a deletion, use `observe_delete` (an observed, resurrection-pooled tombstone — not `docs_delete`, which is an intentional api-origin removal that also unlinks the file). Returns `{ id, path, rev, commitId, converged, echo, conflicted, dispositions }` — the document's row attributes plus a disposition summary (how identity threaded). `path` is a FILE event's path from the store's layer, not a row locator, so it keeps its name.",
      inputSchema: { path: z.string(), content: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(surfaceObserveResult(observeFile(store, repoId, storagePath(args.path), args.content)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "observe_many",
    {
      description:
        "BATCH sync ingest (ADR-014): observe several files at once — the batch form of `observe`. Give `files` as an array of `{path, content}`; each is echo-gated and reconciled independently, all under one timestamp and a single resurrection-pool sweep (cheaper than N `observe` calls for an initial walk or a large checkpoint). Returns one result per input file (same shape as `observe`). Mirror deletions with `observe_delete`, one path at a time.",
      inputSchema: { files: z.array(z.object({ path: z.string(), content: z.string() })), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(observeMany(store, repoId, args.files.map((f) => ({ ...f, path: storagePath(f.path) }))).map(surfaceObserveResult));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "observe_delete",
    {
      description:
        "SYNC DELETE (ADR-014): record that `path` left the source scope — tombstone the live doc as an OBSERVED deletion (its blocks are pooled for resurrection if the path reappears; no file is removed, since it is already gone from the source). The deletion counterpart to `observe`, for a synchronizer mirroring an external delete. Idempotent: a path with no live doc is a no-op (`deleted:false`). Contrast `docs_delete` — an api-origin, intentional, non-pooled removal that also unlinks the working-tree file.",
      inputSchema: { path: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return okMutated(surfaceObserveDeleteResult(observeDelete(store, repoId, storagePath(args.path))));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_history",
    {
      description: "A block's biography: the commits that touched the block `id` names, with disposition kind/confidence/reason, newest first (history_node before surface 3.0 — it always took a block id and returned the block's changes). Not repo-scoped: block ids are global.",
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

  tool(
    "docs_diff",
    {
      description: "Block-grain diff between two revisions of a document: `[{ kind: added|removed|changed, id (the block), before?, after? }]` in that order. Address the document by `id` or `path` (at least one); `from_rev`/`to_rev` are revision ids (from docs_history, changes_since or blocks_history). Contrast docs_diff_unified, the unified text diff. (diff before surface 3.0.)",
      inputSchema: { ...DOC_ARGS, from_rev: z.string(), to_rev: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // Resolve the locator FIRST: diffBlocks keys its SQL on the doc id, so a
        // raw path here would silently return an empty diff (no error) — the
        // misleading-empty trap. locateDoc throws doc_missing when the ref
        // names no document.
        const docId = locateDoc(repoId, "docs_diff", registry.get("docs_diff")!.shape, args);
        return ok(diffBlocks(store, docId, args.from_rev, args.to_rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_diff_unified",
    {
      description:
        "Unified diff between two revisions of a document (the `omg diff` rendering): returns `{ id, path, from, to, diff }` where `diff` is a unified diff of the two revisions' file texts — for each revision exactly the bytes docs_read_at returns, so hunk line numbers are real file lines (Myers shortest edit script; `@@ -a,b +c,d @@` hunks with 3 lines of context; lines prefixed `-`, `+` or a space; no file header; identical texts → \"\"). Address the document by `id` or `path` (at least one). `from_rev`/`to_rev` default to the previous and current revisions ('what did the last commit change here'). Contrast `docs_diff`, which returns block-grain added/removed/changed entries. (diff_unified before surface 3.0.)",
      inputSchema: { ...DOC_ARGS, from_rev: z.string().optional(), to_rev: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_diff_unified", registry.get("docs_diff_unified")!.shape, args);
        return ok(docDiffUnified(store, docId, {
          ...(args.from_rev !== undefined ? { fromRev: args.from_rev } : {}),
          ...(args.to_rev !== undefined ? { toRev: args.to_rev } : {}),
          label: JSON.stringify(args.id ?? args.path),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_read_at",
    {
      description:
        "TIME-TRAVEL read: the whole file bytes of a document AS OF a past revision — `raw` is the reconstructed source at that `rev` (fences/tables/list markers preserved), plus `id`/`path` (the path as of that revision)/`rev`. Use this to audit or answer 'what did this doc say at revision N', or to fetch the exact prior text before reverting. Get a `rev` from docs_diff, blocks_history, docs_history or changes_since. Contrast: docs_read = current bytes; docs_diff = block-grain changes BETWEEN two revisions. `renderedHashMatch` is true when the reconstruction is byte-for-byte the file at that revision; it can be false for an old revision ONLY when the document's leading/frontmatter trivia (separator bytes, not block content) changed since — block content always reconstructs faithfully. `properties` are CURRENT values (propertiesAreCurrent:true), since property history is not stored. Address the document by `id` or `path` plus a `rev` id.",
      inputSchema: { ...DOC_ARGS, rev: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_read_at", registry.get("docs_read_at")!.shape, args);
        const res = readDocumentAtRevision(store, docId, args.rev);
        if (!res) throw new EngineError("target_missing", `no revision ${JSON.stringify(args.rev)} for document ${docId}`, { data: { doc: docId, rev: args.rev } });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_history",
    {
      description:
        "VERSION HISTORY of matching documents, grouped BY DOCUMENT: for each doc (`id`, `path`, `deleted`, `currentRev`), its ordered revision list (oldest→newest) with `rev`/`seq`/`commit`/`updated_at`/`origin`/`actor`/`hash`/`isCurrent`. Give `path_glob` (e.g. \"journal/*\" — `*` matches ACROSS `/`, so journal/* and journal/** are equivalent) OR a single document by `id` or `path`; at least one is required. `hash` (hex of the revision's rendered file hash) lets you spot no-op vs real changes. Feed a returned `rev` into `docs_read_at` (whole doc AT that rev) or `docs_diff` (block-grain changes BETWEEN two revs). By default only live docs; `include_deleted:true` also returns tombstoned docs (their history is intact for audit). `limit` caps DOCUMENTS returned (default 50) with a `truncated` flag. Contrast `changes_since`: a repo-wide COMMIT feed, not this per-document view.",
      inputSchema: {
        path_glob: z.string().optional(),
        ...DOC_ARGS,
        include_deleted: z.boolean().optional(),
        limit: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        if (!args.path_glob && args.id === undefined && args.path === undefined) {
          throw new EngineError("target_missing", "docs_history requires one of path_glob, id or path");
        }
        let doc: string | undefined;
        if (args.id !== undefined || args.path !== undefined) {
          // A live document resolves through the locator; with include_deleted a
          // tombstoned one is looked up by the same attribute.
          const tomb = args.include_deleted
            ? (args.id !== undefined
              ? store.db.prepare("SELECT doc_id FROM docs WHERE doc_id = ? AND repo_id = ?").get(args.id, repoId)
              : store.db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ?").get(repoId, storagePath(args.path!))) as { doc_id: string } | undefined
            : undefined;
          doc = tomb ? tomb.doc_id : locateDoc(repoId, "docs_history", registry.get("docs_history")!.shape, args);
        }
        return ok(docHistory(store, repoId, {
          ...(args.path_glob ? { pathGlob: args.path_glob } : {}),
          ...(doc ? { doc } : {}),
          ...(args.include_deleted !== undefined ? { includeDeleted: args.include_deleted } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "changes_since",
    {
      description: "The change feed: commit digests after a cursor (repo commit seq) with one-line summaries. Each digest's `revisions[]` carries `{ id, path, hash }` (hash = hex of the revision's rendered file hash; the same shape an apply result's revisions have), so a synchronizer can decide 'changed vs echo' without a follow-up docs_read. Filter by `origin` (api/observed/import) to ignore commits a given writer produced. Poll with your last cursor to cheaply re-orient after time away. Paging: `cursor` is the last digest's `seq` (a dense per-REPO order — a cursor is only meaningful against the same `repo` it came from); pass it back while `truncated` is true. `head` is the repo's current max seq: an empty page with cursor == head means nothing new, cursor > head means the cursor belongs to a different repo/server.",
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

  tool(
    "repos_status",
    {
      description:
        "Repo counts (`{ id, slug, rootPath, docs, blocks, commits, openEdges, unconverged, disk }`): docs, blocks, commits, open edges, unconverged doc count, and on-disk drift. " +
        "`disk` reports a READ-ONLY scan of the working tree vs the DB: `changed` (files edited on disk but not re-ingested), " +
        "`deleted` (docs whose file is gone from disk), `untracked` (new *.md not yet ingested), and `checked` " +
        "(false when the server has no working-tree path — disk agreement is then UNVERIFIED, not clean).",
      inputSchema: { ...REPO_ARG },
    },
    async (args) => {
      try { const { repoId, rootPath } = repoScope(args.repo); return ok(reposStatus(store, repoId, rootPath)); } catch (e) { return fail(e); }
    },
  );

  tool(
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
  tool(
    "repos",
    {
      description:
        "List the repos in this workspace: `{ repos: [{ slug, hasSource }] }`. A client addresses any of them by passing that `slug` as the `repo` argument to another tool (omit `repo` ⇒ the server's default repo). Use repos_status for per-repo counts/convergence.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(reposList(store));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Which engine and which versions (spec/surface §4, 1.4). No repo scope: the
  // answer is about the binary and its database, not a repo.
  tool(
    "version",
    {
      description:
        "Which engine and which versions you are talking to: `{ engine: \"typescript\"|\"rust\", version, components: { <package>: <version> }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk? }, runtime, commit, built }`. " +
        "`version` is the serving binary's own; `components` every omgbase package it is built from; `specs` the spec versions it implements (compile-time constants); `schema` the database's `PRAGMA user_version`; `commit`/`built` the build's git revision and RFC 3339 time (null when unknown). No arguments, no repo scope.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(versionInfo(store, ctx.host));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // The `tools/call` handler: ours, so the argument shape is checked by
  // `validateArguments` (spec/surface §4 "Arguments") and a failure is the
  // engine's `filter_invalid` envelope — naming the expected shape and, for an
  // unknown name, the nearest valid one — rather than the SDK's validation
  // text. Listing (`tools/list`) stays the SDK's, from the same registrations.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const entry = registry.get(name);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    let args: Record<string, unknown>;
    try {
      args = validateArguments(name, entry.shape, request.params.arguments);
    } catch (e) {
      return fail(e);
    }
    return entry.handler(args);
  });

  return server;
}

/** The catalog's tool names in registration order with their descriptions —
 *  what `spec/surface/tool-descriptions.json` pins for both engines. */
export async function toolDescriptions(server: McpServer): Promise<Record<string, string>> {
  const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
  const out: Record<string, string> = {};
  for (const [name, t] of Object.entries(tools)) out[name] = t.description ?? "";
  return out;
}
