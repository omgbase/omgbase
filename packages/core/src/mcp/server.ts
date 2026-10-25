import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Store } from "../core/store/store.js";
import { docsOutline } from "../core/read/outline.js";
import { docsRead, docsReadMany, MANY_DOCS_CAP, type DocsReadAtResult } from "../core/read/document.js";
import { requireHistory, semanticOf } from "../core/capabilities/registry.js";
import { CapabilityUnavailable } from "../core/capabilities/errors.js";
import { capabilityStates, type SemanticHostReport } from "../sync/capability-state.js";
import { nodesGet, nodesGetMany } from "../core/read/nodes.js";
import { findDoc, docsList, docsTree, DOCS_LIST_DEFAULT_LIMIT } from "../core/read/reader.js";
import { resolveRef } from "../core/read/refs.js";
import { VERSION } from "../core/index.js";
import { normalizeText, normalizeVisibleText } from "../core/hash.js";
import { oqxRunAsync, collectSemanticPhrases, type EmbedQuery } from "../oqx/run.js";
import { graphNeighborhood } from "./graph.js";
import { textSearch } from "../search/text.js";
import { EngineError, errorBody } from "./errors.js";
import { argumentError, nearest, stringList, validateArguments, type ArgShape } from "./arguments.js";
import { linksRetarget, linksRepair } from "../mutate/macros.js";
import { canonicalDocPath } from "../mutate/docs.js";
import { applyEffects, executeByDigest, executePlan, planEffects, type Plan, type Receipt } from "../mutate/plan.js";
import type { EffectTarget } from "../mutate/effects.js";
import {
  appendEffects, applySugar, checkEffects, createEffects, deleteDocEffects, docsAppendEffects, insertEffects, mergeEffects, moveBlocksEffects, moveDocEffects,
  moveLinks, nodeSetEffects, removeBlocksEffects, requireAbsentPath, retargetEffects, setMetaEffects, splitEffects, updateBlockEffects, updateContentEffects, type Sugar,
} from "../mutate/sugar.js";
import { canonicalJson, fixTool } from "../mutate/canonical.js";
import { linksStale, linksStaleSummary } from "../graph/link-health.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus, reposList } from "../sync/admin.js";
import { observeFile, observeMany, observeDelete } from "../sync/observe.js";
import { withWriterLockAsync, type WriterLockOptions } from "../sync/writer-lock.js";
import { QUERY_SYNTAX_CARD, QUERY_SYNTAX_SECTION_NAMES, QUERY_SYNTAX_SECTIONS, querySyntaxSection } from "./reference.js";
import { versionInfo, type HostInfo } from "../version.js";
import { storagePath, referencePath } from "../core/paths.js";
import { isContainerBlock } from "../format/index.js";
import {
  surfaceInboundLink, surfaceObserveResult, surfaceObserveDeleteResult,
  surfaceTextSearch, surfaceResolveHits, surfaceRetargetHits, surfacePlan, surfaceReceipt,
} from "../surface-paths.js";

// MCP server (mcp-api). The full tool surface wired to the engine: read
// (docs_tree, docs_list, docs_outline, docs_read(_many), blocks_read(_many), query, blocks_search,
// blocks_resolve), mutate (`plan` / `execute` / `apply { effects }` and the sugar
// tools over them — spec/surface §4, 4.0: every write tool returns the Receipt,
// no tool takes `dry_run`), graph, history (blocks_history, docs_diff,
// changes_since), admin (repos_status, sync_status). Uniform truncated+cursor
// on lists; stable error-code mapping.
//
// Paths (spec/surface §1 "Paths", 2.0): every path a tool returns is the
// reference form (`/a/b.md`) and every path argument accepts either form. The
// surface-owned readers root their own results; the results another spec pins
// in the storage form (apply, the document operations, observe, search) are
// re-shaped here through `surface-paths.ts` — the same functions the `omg`
// verbs call, so the two clients cannot drift.
//
// Arguments (spec/surface §4 "Arguments", 5.0 "underscore = engine"): a tool's
// prefix names the row kind it addresses, and an argument that addresses one of
// that kind's engine attributes is spelled as the attribute — `docs_read { _id?,
// _path? }`, `docs_diff { _id?, _path? }`, `blocks_read { _id }`, `nodes_set
// { _id }`, `blocks_read_many { _ids }`; role arguments keep their bare names
// (`docs`, `roots`, `to`, `blocks`, `at`, `path_glob`, `docs_create.path`). One
// verb returns the row: `read`. A bare `id`/`path`/`ids` is `filter_invalid` with
// a `fix` (no tolerance); there is no bare `doc` argument. Every call is validated by
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
   * The workspace's `.omgbase/` directory. When set, every write tool
   * (`WRITE_TOOLS`) runs under the workspace writer lock of spec/sync §7 for the
   * whole call — one acquire per tool call, dry runs included — so an `omg`
   * verb, another `omg mcp`, the Rust `omgbase mcp` or a watcher checkpoint
   * sharing the workspace serialize with it (lock scope = write scope on every
   * host). It also reaches the kernel (`ApplyRequest.omgbaseDir`), so the
   * freshness stat cache is kept warm exactly as on the CLI path. Absent (a
   * library embedding over a bare store) ⇒ no lock, no stat cache.
   */
  omgbaseDir?: string;
  /** Lock wait/poll overrides for the tool-boundary lock (default 5 s / 25 ms, the spec's); a test seam. */
  writerLock?: WriterLockOptions;
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
   * A configured provider the host could NOT start (`omg mcp`'s embedder load
   * failed to spawn or hand-shake). Set with no `embedQuery`: every semantic
   * path then raises `capability_unavailable { capability: "semantic", state:
   * "unavailable" }` (retriable) naming the provider and the reason, and
   * `version` reports the state — never the misleading `provider_unavailable`
   * ("none is configured").
   */
  semanticUnavailable?: SemanticHostReport;
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
  /**
   * The catalog profile to serve (spec/surface §4 "Profiles", 4.3): `full`
   * (the default — every tool) or `minimal` (the ten of `MINIMAL_TOOLS`). A
   * profile filters listing and calling, never semantics: a tool it keeps
   * behaves exactly as under `full`, and a `tools/call` on a tool it hides is
   * the JSON-RPC `-32602` error `unknown tool <name>`. Set by `omg mcp --tools`.
   */
  tools?: ToolsProfile;
}

/** The two catalog profiles (spec/surface §4 "Profiles", 4.3). */
export type ToolsProfile = "full" | "minimal";
export const TOOLS_PROFILES: readonly ToolsProfile[] = ["full", "minimal"];

/**
 * The `minimal` profile (spec/surface §4 "Profiles", 4.3): the ten tools an
 * agent works a knowledge base with — `query` for every read it covers,
 * `query_syntax` (the grammar the ladders point at), `docs_read` (whole
 * document, `include_ids` for ids/hashes/parents), `docs_tree` (orientation),
 * `blocks_resolve` (the one ranked hybrid lookup), `changes_since`
 * (re-orientation), `plan` / `execute` / `apply` (the one writer and its
 * preview) and `version` (which reports the profile). The same list as the Rust
 * catalog's `MINIMAL_TOOLS` (`crates/omgbase-surface/src/catalog.rs`).
 */
export const MINIMAL_TOOLS: readonly string[] = [
  "query", "query_syntax", "docs_read", "docs_tree", "blocks_resolve", "changes_since", "plan", "execute", "apply", "version",
];

/** Each profile's membership test: `full` keeps every tool, `minimal` the ten of `MINIMAL_TOOLS`. */
export const PROFILES: Record<ToolsProfile, (tool: string) => boolean> = {
  full: () => true,
  minimal: (tool) => MINIMAL_TOOLS.includes(tool),
};

/** Parse a `--tools` value / the `mcp.tools` setting; null for anything but the two names. */
export function parseToolsProfile(value: unknown): ToolsProfile | null {
  return value === "full" || value === "minimal" ? value : null;
}

// The placement and guard schemas the block-level sugar shares (spec/mutate
// §1.1/§1.2; the effect vocabulary spells them the same way). blocks_insert /
// blocks_move carry the op-level expectation of §1.2: only
// `parent_children_hash` (the destination parent's live direct child ids joined
// by "," and sha256-hexed) has a meaning there — there is no target block whose
// content_hash could be checked — so their schema names that one key alone (an
// accidental `content_hash` is dropped, not an error).
const atSchema = z.union([
  z.literal("start"),
  z.literal("end"),
  z.object({ before: z.string() }),
  z.object({ after: z.string() }),
]);
const parentExpectSchema = z.object({
  parent_children_hash: z.string().optional(),
});
const expectSchema = z.object({
  content_hash: z.string().optional(),
  parent_children_hash: z.string().optional(),
});

// The public Effect vocabulary (spec/mutate §11, 2.3) — the `plan` / `execute` /
// `apply.effects` grammar. The boundary schema is deliberately loose (an
// object whose `op` is one of the nine): the planner's own `validateEffects`
// checks every key, target kind and field spelling and reports the failure as
// the same `filter_invalid { hint: "arguments" }` envelope, naming `effects[i]`
// and the offending key — a message both engines compose from the spec.
/** `expect: { max }` of a query-directed request (spec/mutate §11.8, 4.1): the bound on the selection. */
const selectionExpectSchema = z.object({ max: z.number().int().nonnegative() });
/** The selector half of `plan` / `apply` / `execute` arguments, as given (absent keys stay absent so the planner tells "no expect" apart). */
function selectorArgs(args: { select?: string | undefined; expect?: { max: number } | undefined }): { select?: string; expect?: { max: number } } {
  return { ...(args.select !== undefined ? { select: args.select } : {}), ...(args.expect !== undefined ? { expect: args.expect } : {}) };
}
const effectSchema = z.looseObject({ op: z.enum(["create", "insert", "set", "unset", "move", "remove", "split", "merge", "retarget"]) }).describe(
  "one effect: { op: \"create\", path, markdown, frontmatter? } | { op: \"insert\", into: Target, at?, markdown, expect? } | { op: \"set\", target, field, value, expect? } | { op: \"unset\", target: document, field: \"_frontmatter.<key>\", expect? } | { op: \"move\", target: document, to, retarget_inbound? } | { op: \"move\", targets: [block…], into, at?, expect? } | { op: \"remove\", target: document } | { op: \"remove\", targets: [block…], expect? } | { op: \"split\", target: block, at: [byte…], expect? } | { op: \"merge\", targets: [block…], separator?, expect? } | { op: \"retarget\", repairs: [{ from, to }], path_glob? }. Target: a bare document path, a block/node id, $new.<n> (an identity an earlier effect creates), or { kind: \"document\", _id? | _path? } | { kind: \"block\", _id } | { kind: \"node\", _id } | { kind: \"section\", heading_id }. at: \"start\" | \"end\" | { before: <block id> } | { after: <block id> } — a place among the children of `into`, so \"right after block X\" is into: X's parent (its parent block id, or the document path when X is top-level), at: { after: X }. field: a block's is \"markdown\" or \"_attrs.checked\"; a document's \"_frontmatter.<key>\" or (set only) \"content\"; a node's an editable property (value, name, checked). expect on a single-target op: { content_hash?, parent_children_hash?, revision? }; on remove/merge targets it is keyed by block id: { <block id>: { content_hash?, parent_children_hash? } }. expect: { max } is the request's top-level argument beside select, never inside an effect.",
);

// An example ladder (spec/surface §4 "Descriptions", 4.3): the description of
// each `MINIMAL_TOOLS` tool is a one-line summary, then one example per line —
// a rung is a line beginning `{` with the call's arguments as JSON, three
// spaces, a comment; a line holding `…` or `<…>` is a schema line — and a last
// line pointing at `query_syntax`. The rungs are extracted mechanically
// (`mcp/examples.test.ts`) into `spec/surface/cases/examples.json` and run
// against the alchemy corpus, so every example stays true. Ids and paths are
// the alchemy fixture's (`d_14` is substances/salt.md, `b_153` the `Tasks`
// heading of processes/calcination.md). Since 4.4 the rungs are written in
// the `spec/mutate` 3.2 sugar — a bare path, id or `$new.n` as a target, the
// `-> expr` leader for an expression — and each trailing comment teaches one
// thing; the plans they produce equal the 4.3 object-form rungs' (pinned by
// `mcp/examples.test.ts`).
const ladder = (...lines: string[]): string => lines.join("\n");
// The `docs_read` ladder's time-travel rung (4.7): the revision id is the one
// the spec minter gives `/processes/calcination.md`'s ingest revision over the
// alchemy corpus (`examples.json` runs the rung before any write).
const REVISION_RUNG = "{\"_path\":\"/processes/calcination.md\",\"at\":\"r_7\"}   as of a revision (rev ids: revisions { _rev where _path == \"/processes/calcination.md\" })";

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

/**
 * The tools that can commit — the host serializes these under the writer lock
 * of spec/sync §7. The same list as the Rust catalog's `Surface::is_write_tool`
 * (`crates/omgbase-surface/src/catalog.rs`). `plan` is listed too: it reads
 * the documents a write would touch, so a preview waits for a writer exactly as
 * the write would (through 3.x the sugar's `dry_run` played that role).
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "apply", "plan", "execute",
  "blocks_insert", "blocks_update", "blocks_move", "blocks_remove", "blocks_split", "blocks_merge", "blocks_check",
  "nodes_set", "blocks_append", "docs_append",
  "links_retarget", "links_repair",
  "docs_create", "docs_move", "docs_delete", "docs_set_meta", "docs_update",
  "observe", "observe_many", "observe_delete",
]);

/**
 * How many plans a server remembers for `execute { plan_id }` alone (spec/surface
 * §4 `execute`, 5.1): the most recent `plan` results of this process, by
 * `plan_id`, least recently produced evicted first. The same bound as the Rust
 * catalog's `PLAN_MEMORY`.
 */
export const PLAN_MEMORY = 64;

/** The message of `plan_unknown` (5.1), spelled alike by both engines. */
export function planUnknownMessage(planId: string): string {
  return `this server has no plan ${planId} — re-run plan, or pass the plan (or \`plan_id\` + \`effects\`) with execute`;
}

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "omgbase", version: VERSION });
  const { store } = ctx;
  // The kernel's share of the workspace dir: spread into every ApplyRequest /
  // DocOpContext so the stat cache is recorded on the MCP path too.
  const LOCK_DIR = ctx.omgbaseDir !== undefined ? { omgbaseDir: ctx.omgbaseDir } : {};

  // ---- registration: listing through the SDK, validation + dispatch ours ----
  // `server.registerTool` publishes the name, description and JSON schema on
  // `tools/list`; the `tools/call` handler is replaced below so the arguments
  // are validated by `validateArguments` (spec/surface §4 "Arguments") and a
  // failure is the engine's own `filter_invalid`, not the SDK's text.
  //
  // A write tool (`WRITE_TOOLS`) is wrapped at registration so its whole call —
  // argument resolution, the kernel's file-CAS + commit, `docs_move`'s inbound
  // retarget — runs under one writer-lock acquire when the host supplied the
  // workspace dir (the kernel's own inner lock re-enters it). The handler
  // catches its own errors; the only one escaping the wrapper is the lock's
  // `WriterLockTimeout`, rendered through `fail` like every other failure — a
  // plain Error, so `errorBody` maps it to the pinned catch-all `repo_not_found`
  // (spec/surface §9), the code the Rust host emits (`SurfaceError::other`).
  //
  // The profile (`ctx.tools`, spec/surface §4 "Profiles") decides which
  // registrations happen at all: a tool outside it is neither listed nor
  // callable — `tools/call` on its name is the same `unknown tool <name>` a
  // name that never existed gets — and a tool inside it is registered exactly
  // as under `full` (a profile filters listing and calling, never semantics).
  const profile: ToolsProfile = ctx.tools ?? "full";
  const inProfile = PROFILES[profile];
  const registry = new Map<string, { shape: ArgShape; handler: (args: Record<string, unknown>) => Promise<ToolResult> }>();
  // The plans this server produced (spec/surface §4 `execute`, 5.1): `plan`'s
  // results by `plan_id`, the last PLAN_MEMORY of them, so `execute { plan_id }`
  // alone runs the FULL plan form — `stale_plan` and `plan_mismatch` told apart
  // exactly as if the client had echoed the Plan — without the client replaying
  // 5–19 kB of plan as its own output. Per process: a plan_id this server never
  // produced (another server's, a restart) is `plan_unknown`, retriable.
  const plans = new Map<string, Plan>();
  function rememberPlan(plan: Plan): void {
    plans.delete(plan.plan_id);
    plans.set(plan.plan_id, plan);
    while (plans.size > PLAN_MEMORY) plans.delete(plans.keys().next().value!);
  }
  function rememberedPlan(planId: string): Plan {
    const plan = plans.get(planId);
    if (!plan) throw new EngineError("plan_unknown", planUnknownMessage(planId), { data: { plan_id: planId }, retriable: true });
    return plan;
  }
  function tool<S extends ArgShape>(
    name: string,
    def: { description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  ): void {
    if (!inProfile(name)) return;
    const lockDir = ctx.omgbaseDir;
    const run: typeof handler = WRITE_TOOLS.has(name) && lockDir !== undefined
      ? async (args) => {
          try {
            return await withWriterLockAsync(lockDir, () => handler(args), ctx.writerLock);
          } catch (e) {
            return fail(e);
          }
        }
      : handler;
    server.registerTool(name, def, run as never);
    registry.set(name, { shape: def.inputSchema, handler: run as (args: Record<string, unknown>) => Promise<ToolResult> });
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
  const DOC_ARGS = { _id: z.string().optional(), _path: z.string().optional() };

  // Wrap a successful write's result: notify the host so it can schedule a
  // background embed drain. onMutation must be cheap/non-blocking (see
  // ServerContext); we never await it, keeping it off the response path.
  function okMutated(payload: unknown): ToolResult {
    ctx.onMutation?.();
    return ok(payload);
  }
  // ---- the document locator (§4 "Arguments") ---------------------------------
  // `_id` is the document's id, `_path` its path (either form, §1 "Paths"); at
  // least one is required, and when both are given they must name the same
  // document. A miss is `doc_missing` "no document with _id or _path "<value>""
  // with the arguments as given in `data`;
  // neither given is `filter_invalid` "pass _id or _path"; a disagreement is
  // `filter_invalid` "_id "…" and _path "…" name different documents". `findDoc`
  // never falls through from an id to a path. A bare `id`/`path` never reaches
  // here: `validateArguments` refuses it with the `_` spelling and a `fix` (5.0).
  function locateDoc(repoId: string, toolName: string, shape: ArgShape, args: Record<string, unknown>): string {
    const [idKey, pathKey] = ["_id", "_path"] as const;
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
  // `docs_read { at }` and its sugar `docs_read_at` (spec/surface §2, 4.7): the
  // document AS OF a revision, `spec/store` §6.2 reconstruct; a revision that is
  // not the document's is `target_missing`.
  // The history tools reach the store's history capability (modular-core Phase 1,
  // `core/capabilities/`): `history` is the recorder the store was opened with —
  // never null while the defaults are installed; D3's `capability_unavailable`
  // is where a disabled recorder will surface.
  const history = requireHistory(store.db);
  function docsReadAt(docId: string, rev: string): DocsReadAtResult {
    const res = history.readAtRevision(docId, rev);
    if (!res) throw new EngineError("target_missing", `no revision ${JSON.stringify(rev)} for document ${docId}`, { data: { doc: docId, rev } });
    return res;
  }
  // The owning document of a block id (`blocks_read`): the block must be live.
  function docOfBlock(blockId: string): string {
    const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_at IS NULL").get(blockId) as { doc_id: string } | undefined;
    if (!row) throw blockMissing(blockId);
    return row.doc_id;
  }
  function blockMissing(value: string, hint?: string): EngineError {
    return new EngineError("block_missing", `no block with id ${JSON.stringify(value)}${hint ? ` (${hint})` : ""}`, { data: { _id: value } });
  }
  // `nodes_block_read`: the block a node was projected from — the node must
  // exist and name a live block (a block-less node, e.g. one derived from the
  // frontmatter, has none). Both misses are `block_missing`, the message naming
  // the node.
  function blockOfNode(nodeId: string): { docId: string; blockId: string } {
    const node = store.db.prepare("SELECT doc_id, block_id FROM nodes WHERE node_id = ?").get(nodeId) as { doc_id: string; block_id: string | null } | undefined;
    if (!node) throw new EngineError("block_missing", `no node with id ${JSON.stringify(nodeId)}`, { data: { _id: nodeId } });
    const live = node.block_id ? store.db.prepare("SELECT 1 FROM blocks WHERE block_id = ? AND deleted_at IS NULL").get(node.block_id) : undefined;
    if (!node.block_id || !live) throw new EngineError("block_missing", `node ${JSON.stringify(nodeId)} has no block`, { data: { _id: nodeId, _doc_id: node.doc_id } });
    return { docId: node.doc_id, blockId: node.block_id };
  }

  // `docs_append`'s `section`: a heading's TEXT, matched against the normalized
  // heading text of the named document's live headings (an ATX-looking value,
  // "## Title", loses its hashes). Zero → `parent_missing` naming the heading;
  // several → `ambiguous_heading` with the candidates `[{ id, doc_id }]` (pass
  // the heading's id to `blocks_append` instead). Never an id lookup — the
  // id form is `blocks_append`'s (§9).
  //
  // Each miss carries a `fix` (spec/surface §9, 4.4): a literal corrected call.
  // Several matches → `blocks_append` with the first candidate's id; none → the
  // one heading whose text matches up to ASCII case, as `blocks_append`, else
  // the same `docs_append` without `section` (the document's end).
  function resolveSectionHeading(docId: string, docPath: string, section: string, call: { _id?: string; _path?: string; text: string }): string {
    const needle = /^[ \t]*#/.test(section) ? normalizeVisibleText(section, "heading") : normalizeText(section);
    const rows = store.db
      .prepare("SELECT block_id, doc_id, text FROM blocks WHERE doc_id = ? AND type = 'heading' AND deleted_at IS NULL")
      .all(docId) as { block_id: string; doc_id: string; text: string }[];
    const matches = rows.filter((r) => normalizeText(r.text) === needle);
    const shown = referencePath(docPath);
    if (matches.length === 0) {
      const fold = (t: string): string => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const near = rows.filter((r) => fold(normalizeText(r.text)) === fold(needle));
      const fix = near.length === 1
        ? fixTool("blocks_append", { _id: near[0]!.block_id, text: call.text })
        : fixTool("docs_append", { ...(call._id !== undefined ? { _id: call._id } : {}), ...(call._path !== undefined ? { _path: call._path } : {}), text: call.text });
      throw new EngineError("parent_missing", `no heading ${JSON.stringify(section)} in ${shown}`, { data: { section, _path: shown, fix } });
    }
    if (matches.length > 1) {
      throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(section)} matches ${matches.length} headings in ${shown}; pass the heading's id to blocks_append`, {
        data: { section, _path: shown, candidates: matches.map((m) => ({ _id: m.block_id, _doc_id: m.doc_id })), fix: fixTool("blocks_append", { _id: matches[0]!.block_id, text: call.text }) },
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
    const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_at IS NULL").get(blockId) as { doc_id: string } | undefined;
    return row?.doc_id;
  }
  // Resolve the before/after anchor in an `at` spec (itself a block ref) to its
  // id; start/end pass through. Absent ⇒ "end" (append), matching CLI parseAt.
  type AtSpec = z.infer<typeof atSchema>;
  function resolveAt(repoId: string, at: AtSpec | undefined): AtSpec {
    if (!at || at === "start" || at === "end") return at ?? "end";
    if ("before" in at) return { before: resolveBlockRef(repoId, at.before) };
    return { after: resolveBlockRef(repoId, at.after) };
  }
  // The sugar tools are `apply { effects }` (spec/surface §4 "Sugar over
  // effects", 4.0; ADR-021): each tool resolves its refs and runs its own
  // pre-checks, hands the ids to the shared builder of `mutate/sugar.ts` (one
  // builder per operation — the same table the `omg` verbs, the fixture runner
  // and the Rust port use), and `applySugar` plans + executes the effects as one
  // request under the tool's fixed `reason` with `actor: "agent:mcp"` — the
  // planner's `effect_index` dropped from any error, so `data` stays as pinned.
  // Every sugar tool returns the Receipt (paths rooted); the preview of any of
  // them is `plan { effects }` — there is no `dry_run` since 4.0.
  function runSugar(repoId: string, rootPath: string, sugar: Sugar, reason?: string): { receipt: Receipt } {
    const { receipt } = applySugar(store, { repoId, rootPath, actor: "agent:mcp", ...(reason !== undefined ? { reason } : {}), ...LOCK_DIR }, sugar);
    return { receipt: receipt! };
  }
  function sugar(repoId: string, rootPath: string, built: Sugar): ToolResult {
    return okMutated(surfaceReceipt(runSugar(repoId, rootPath, built).receipt));
  }
  const blockTarget = (id: string): EffectTarget => ({ kind: "block", _id: id });
  // A parent ref as an effect target: a document ref is the document's top level, a block ref the block.
  const parentTarget = (p: { parent: string | { doc: true }; docId: string }): EffectTarget =>
    typeof p.parent === "object" ? { kind: "document", _id: p.docId } : { kind: "block", _id: p.parent };
  // An empty block list is an argument error (3.2, §9) — it used to reach the
  // kernel as a malformed op (`block_missing "block undefined not found"`).
  function requireSome(tool: string, arg: string, list: unknown[]): void {
    if (list.length === 0) throw argumentError(tool, `\`${arg}\` must name at least one block`, registry.get(tool)!.shape);
  }
  // Guard shared by every mutating tool: a sourceless (headless-only) repo has no
  // working tree to write through, so mutation is disabled with a loud error.
  function requireRoot(rootPath: string | undefined): string {
    if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
    return rootPath;
  }

  // ---- semantic(): loud when it cannot rank (§4, 3.0; Phase 2) ------------------
  // The gate, in this order (phase-1-contracts §2.1 and the Phase 2 rule):
  //   1. the store runs WITHOUT the semantic module (`coreCapabilities`) →
  //      `capability_unavailable { capability: "semantic", state: "disabled" }`;
  //   2. the host configured a provider it could not start →
  //      `capability_unavailable { …, state: "unavailable" }`, retriable;
  //   3. the module is here and no provider is configured (no `embedQuery`) →
  //      `provider_unavailable` (`data.provider` null) — the 3.0 code the spec
  //      pins (`reads::errors`, `interop`), kept as the alias of `disabled` for
  //      this composition: "the module is here and has nothing to score with";
  //   4. a provider that answers but whose model has embedded NOTHING in this
  //      repository would score every row null and hand back path-ordered rows
  //      with no score — so the first phrase embedded checks the index and
  //      fails `provider_unavailable`, naming the provider and model and what
  //      to run. The index check is the capability's (`SemanticProvider.
  //      available`, README §6).
  function hasEmbeddings(repoId: string, model: string): boolean {
    return semanticOf(store.db)?.available(repoId, model) ?? false;
  }
  function providerUnavailable(): EngineError {
    return new EngineError("provider_unavailable", PROVIDER_UNAVAILABLE_MESSAGE, { data: { provider: null } });
  }
  /** Steps 1–3: what a semantic call raises when nothing can rank, or undefined when the host can embed. */
  function semanticGate(): Error | undefined {
    if (!semanticOf(store.db)) return CapabilityUnavailable.semanticDisabled();
    if (ctx.semanticUnavailable) return CapabilityUnavailable.semanticUnavailable(ctx.semanticUnavailable.provider, ctx.semanticUnavailable.reason);
    if (!ctx.embedQuery) return providerUnavailable();
    return undefined;
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
        "Orientation call. Returns a document's compact indented outline (alias/type/label per line, § marks section headings). IDs are stable; prefer them in follow-ups. Address the document by `_id` or `_path` (at least one; a `_path` in either form). For the whole document body in one call, use docs_read.",
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
      description: ladder(
        "docs_read — One document, whole: _raw bytes plus properties { frontmatter, inline, computed } and _id/_path/rev.",
        "{\"_path\":\"/processes/calcination.md\"}   by _path (either form)",
        "{\"_path\":\"/processes/calcination.md\",\"include_ids\":true}   plus ids (pre-order), hashes (the CAS tokens expect.content_hash takes), parents (null = top level)",
        "{\"_id\":\"d_14\"}   by _id (a query hit's _id)",
        REVISION_RUNG,
        "Structure only: query md:section nodes. Many documents: a query with select _raw. Grammar: query_syntax.",
      ),
      inputSchema: {
        ...DOC_ARGS,
        include_ids: z.boolean().optional(),
        at: z.string().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const shape = registry.get("docs_read")!.shape;
        const docId = locateDoc(repoId, "docs_read", shape, args);
        if (args.at !== undefined) {
          // `at` (4.7): the document AS OF that revision — `docs_read_at`'s
          // code path, so the two return the same bytes. Block ids at a past
          // revision are a later question: `include_ids` is refused with `at`.
          if (args.include_ids) throw argumentError("docs_read", "`include_ids` is not available with `at`", shape);
          return ok(docsReadAt(docId, args.at));
        }
        const res = docsRead(store, docId, args.include_ids ? { includeIds: true } : {});
        if (!res) throw new EngineError("doc_missing", `no document with id or path ${JSON.stringify(args._id ?? args._path)}`, { data: { _id: docId } });
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
        "Batch whole-document read — the hydrate half of query→hydrate. The plural of docs_read: pass `docs`, a list of refs (each a document id OR a path, in either form), and get back one full read per ref. Returns `{ items, errors, truncated }`: each found doc is a full docs_read projection (`_raw` = complete file bytes verbatim, `properties` grouped by source, plus `_id`/`_path`/`rev`, and — with include_ids:true — the document's ordered block `ids`, a `hashes` {block `_id` → block `_hash`} map for raw-`apply` CAS pinning, and a `parents` {block id → parent block id | null} map so top-level vs nested blocks are distinguishable without an outline read); a ref that resolves to no live document lands in `errors` as {ref, error:\"doc_not_found\"} WITHOUT failing the call, so one bad ref never sinks the batch. Duplicate refs collapse first-seen (a repeated ref yields a single item). Capped at " + MANY_DOCS_CAP + " refs per call; excess refs are dropped and `truncated` is set. Pass budget_tokens to cap total hydrated size — the batch stops early and flags `truncated` when the next doc would exceed it; the FIRST doc always ships even when it alone exceeds the budget (the same at-least-one-row contract as docs_list/docs_tree, so a budgeted caller always makes progress). Use this after query/blocks_search/blocks_resolve to pull N whole docs in ONE round-trip instead of N serial docs_read calls; for a single doc use docs_read, and for lean structure-only orientation use docs_outline (docs_get_many before surface 3.0).",
      inputSchema: {
        docs: stringList(),
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
      description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full). `_id` is the block's id (`b_…`) and its document is inferred from it; an `n_` node id is not a block id — nodes_block_read reads the block a node was projected from (nodes_get before surface 3.0: blocks used to be called nodes here, and `nodes` now names the extracted-entity rows). Every resolution carries the block's `_id` and `_type`; raw and full add `_raw` (its source bytes) and `_hash` (its own raw hash) — the value update/split need in expect.content_hash, so you can fetch it before editing rather than reading it back from a conflict; full adds `_text`, `_attrs`, `_ordinal`, `_depth` and `parent_id` (null at the top level). Use this to expand the lean ids returned by query/blocks_resolve. To read a whole document in one call, use docs_read (blocks_read on a heading's id returns only that block, not its section).",
      inputSchema: {
        _id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        repoScope(args.repo);
        // `id` is a block id, unambiguously the `blocks_` kind's (§4 "Names and
        // arguments"): an `n_` id names a NODE and is `block_missing` pointing at
        // `nodes_block_read` (the name pass had dereferenced it here, §9).
        if (args._id.startsWith("n_")) throw blockMissing(args._id, "an n_ id names a node — nodes_block_read reads its block");
        const node = nodesGet(store, docOfBlock(args._id), args._id, args.resolution ? { resolution: args.resolution } : {});
        if (!node) throw blockMissing(args._id);
        return ok(node);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "nodes_block_read",
    {
      description:
        "Read the block a NODE was projected from: `_id` is the node's id (`n_…`, from `query` over `nodes { … }`) and the result is exactly what blocks_read returns for that block — the same resolutions (skeleton|outline|text|raw|full, default full), the same `_id`/`_type`/`_raw`/`_hash`/`_text`/`_attrs`/`_ordinal`/`_depth`/`parent_id`. The hop from an occurrence (an `md:link`, `md:task`, `md:section`, … node) to the editable block that holds it, in one call; blocks_read itself takes a block id only. An unknown node, or a node that names no live block (a block-less node, such as one derived from the frontmatter), is block_missing.",
      inputSchema: {
        _id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        repoScope(args.repo);
        const { docId, blockId } = blockOfNode(args._id);
        const node = nodesGet(store, docId, blockId, args.resolution ? { resolution: args.resolution } : {});
        if (!node) throw new EngineError("block_missing", `node ${JSON.stringify(args._id)} has no block`, { data: { _id: args._id, _doc_id: docId } });
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
        "Fetch up to 100 blocks by id (in request order) with budget truncation — the plural of blocks_read (nodes_get_many before surface 3.0). Block ids are globally unique, so `_ids` may span ANY number of documents — each id is resolved to its owning doc server-side. Result carries `nodes` (the hydrated blocks, one per resolved id), `truncated` (cap or `budget_tokens` hit — the first resolved block always ships even when it alone exceeds the budget, so a budgeted caller always makes progress), and `unresolved` — the requested ids that name no live block (never silently dropped).",
      inputSchema: {
        _ids: stringList(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        budget_tokens: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        repoScope(args.repo);
        const res = nodesGetMany(store, null, args._ids, {
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
      description: ladder(
        "docs_tree — Orientation: the repo's directories with document and block counts, one small page (tree -L depth -d + du).",
        "{}   the root: one row per directory ({ _path ending in /, docs, blocks }), files_here = documents at the root itself, total",
        "{\"path\":\"/processes/\",\"files\":true}   descend (path is the prefix) and list its documents too ({ _id, _path, blocks })",
        "{\"depth\":2,\"updated\":true}   nested directories to depth 2; updated adds _updated_at; limit/cursor page the rows",
        "Find documents by attribute, not by path: query (docs { select _path where ... }). Grammar: query_syntax.",
      ),
      inputSchema: {
        path: z.string().optional(),
        depth: z.number().int().optional(),
        files: z.boolean().optional(),
        updated: z.boolean().optional(),
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
            ...(args.files !== undefined ? { files: args.files } : {}),
            ...(args.updated !== undefined ? { updated: args.updated } : {}),
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
        "ENUMERATE live documents (the `omg ls` operation) as a page: `{ items: [{ _id, _path, _updated_at, blocks }], truncated, cursor }` — the document's `_id`, its `_path` (`/`-rooted, as every path the surface returns), last-commit timestamp (ISO, or null) and live block count — ordered by path. This is a flat `ls`, not an orientation primitive: unscoped on a large repo it is hundreds of rows, and the engine has no directory concept here — `path_glob` is a simple LIKE match where `*` matches ANY run INCLUDING `/` (so `projects/*` is the whole subtree; there is no 'immediate children only'). To learn a repo's shape, call docs_tree first, then scope this with a `path_glob` once you know where to look. Paged under the uniform list contract: `limit` (default " + DOCS_LIST_DEFAULT_LIMIT + ") caps rows, `cursor` (from a truncated page) resumes after the last row returned, `budget_tokens` caps the page's estimated size (at least one row is always returned), and `truncated` is honest — when true you have NOT seen everything. For structured/ranked discovery use `query` or `blocks_resolve`.",
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
      description: ladder(
        "query_syntax — The OQX reference: a card (clause order, the names rule and engine names per kind, consumers, follow, examples), then one chapter at a time.",
        "{}   the ~3 kB card: { syntax, sections } — enough for most queries",
        "{\"section\":\"follow\"}   one chapter in full ({ section, syntax }); the names are the card's sections list",
        "{\"section\":\"all\"}   the whole manual (38 kB) — rarely needed",
        "Call the card before a non-trivial query; every other tool's examples end here, at query_syntax.",
      ),
      inputSchema: { section: z.string().optional() },
    },
    async (args) => {
      try {
        // (5.1) The card by default; a chapter by its slug; `all` the manual. An
        // unknown name is an argument error naming the chapters, its `fix` the
        // call respelled with the nearest name (or `all`).
        if (args.section === undefined) return ok({ syntax: QUERY_SYNTAX_CARD, sections: QUERY_SYNTAX_SECTIONS.map((s) => s.slug) });
        const syntax = querySyntaxSection(args.section);
        if (syntax === null) {
          const fix = canonicalJson({ section: nearest(args.section, QUERY_SYNTAX_SECTION_NAMES) ?? "all" });
          throw argumentError("query_syntax", `unknown section \`${args.section}\`; the sections are ${QUERY_SYNTAX_SECTION_NAMES.join(", ")}`, registry.get("query_syntax")!.shape, fix);
        }
        return ok({ section: args.section, syntax });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "query",
    {
      description: ladder(
        "query — rows (_id, _path, projection) from docs, blocks, nodes or links.",
        "{\"query\":\"docs { select _title, stage where \\\"process\\\" in tags order by _path limit 5 }\"}   frontmatter; in; order, limit",
        "{\"query\":\"blocks { select _type, _text where _path == \\\"/processes/calcination.md\\\" }\"}   a document's blocks in order",
        "{\"query\":\"nodes { select _block_id where _kind == \\\"md:section\\\" and _name == \\\"Tasks\\\" and _path == \\\"/processes/calcination.md\\\" }\"}   a heading's block id",
        "{\"query\":\"nodes { select _path, _value where _kind == \\\"md:task\\\" and not checked }\"}   open tasks",
        "{\"query\":\"links { select _path, _block_id where _dst_path == \\\"/processes/calcination.md\\\" }\"}   inbound links (_path = source)",
        "{\"query\":\"docs { select _path where _title ~* \\\"salt\\\" }\"}   regex (~* ci, !~ not); substring: .contains(\\\"s\\\")",
        "Also docs count { where … }, follow, ^docs joins, text()/semantic(): query_syntax.",
      ),
      inputSchema: {
        query: z.string(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
        bare: z.boolean().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // A `semantic(...)` query the server cannot rank fails with the gate's
        // specific code (not a generic filter error) before anything runs.
        if (collectSemanticPhrases(args.query).length > 0) { const gate = semanticGate(); if (gate) throw gate; }
        return ok(await oqxRunAsync(store, repoId, args.query, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.bare !== undefined ? { bare: args.bare } : {}),
          // (4.11) the call as received, for a parse error's corrected `fix`.
          request: args,
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
        "Neighborhood macro: the bounded graph AROUND one or more root documents in ONE call — { documents, links, frontier } — so you can orient without hand-writing an OQX `follow`. This is a CONVENIENCE WRAPPER, not a new engine: it compiles its args into an OQX `follow _out_links { from _dst }` / `follow _in_links { from _doc }` query and runs it through the same `query` path (the returned `queries` field is the exact follow query it generated). It does NOT replace `follow` or `from links` — reach for the `query` tool directly when you need successor/frontier predicates, `$key`-keyed identity, `$ordinal` budgets, cross-document correlation, or the links scan with its own projections. `roots` are one or more doc refs (paths and/or ids); they are depth 0. `degrees` is the max hop distance (root = 0; maps to `follow … collect { … depth degrees+1 }`, capped so degrees+1 ≤ 8; default 1). `direction` is `out` (outgoing links), `in` (backlinks), or `both` (default). `predicate` restricts the neighborhood to documents reachable from a root via edges of that predicate (both the documents and the edges are filtered). `select` adds document projections (OQX select expressions, e.g. \"layer\", \"_title\"). `max_documents` caps the distinct document set (default 200) with a `truncated` flag. Returns: `documents` (each with `_id`/`_path`/`degree` = min hops from a root/`frontier` bool + your projections — a name selection such as \"layer\" or \"_title\" is its own key, `_id`/`_path` land on the envelope keys, and any other expression is `sel_<i>`), `links` (the traversed links as rows of the `links` target under its own field names — `_id`, `_doc_id`/`_block_id` (the source), `_via_id`, `_dst_id`, `_dst_path`, `_uri`, `_dst_kind`, `_predicate`, `_provenance`, `_anchor`, `_field`; external `x_…` and dangling phantom endpoints are preserved as edge stubs, exactly as `from links` surfaces them), and `frontier` (the documents on the outer boundary — `{ _id, _path, degree }`, min degree == degrees; at degrees 0 that is the roots themselves).",
      inputSchema: {
        roots: stringList({ min: 1 }),
        degrees: z.number().int().optional(),
        direction: z.enum(["in", "out", "both"]).optional(),
        predicate: z.string().optional(),
        select: stringList().optional(),
        max_documents: z.number().int().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        // A `select` using semantic(...) needs a provider — surface the specific
        // code, mirroring the `query` tool.
        if ((args.select ?? []).some((s) => collectSemanticPhrases(`docs { select x: ${s} }`).length > 0)) { const gate = semanticGate(); if (gate) throw gate; }
        return ok(await graphNeighborhood(store, repoId, args, rankableEmbed(repoId)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_search",
    {
      description: "Full-text (FTS5, bm25-ranked) keyword search over block text: `{ hits: [{ _id (the block), _doc_id, _path, _type, _text, score }], truncated }`. Input is treated as a search box — plain words are ANDed, \"quoted phrases\" match adjacency, punctuation like / is safe (no query DSL). For structured filtering or frontmatter projection use `query` instead (see query_syntax). (text_search before surface 3.0.)",
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
      description: ladder(
        "blocks_resolve — \"the id of the thing I mean\": a title or term, ranked to blocks { _id, locator, preview, evidence }.",
        "{\"query\":\"calcination\"}   best on short, entity-shaped input",
        "{\"query\":\"Emerald Tablet\",\"limit\":3}   use the returned _id in the next call (docs_read, a plan target)",
        "Open questions or passages: query with text(\"...\") or order by semantic(\"...\") desc. Grammar: query_syntax.",
      ),
      inputSchema: { query: z.string(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const input: Parameters<typeof resolveThing>[1] = { repoId, query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) };
        // Hybrid: fuse the query vector into the ranking when a provider is
        // configured (mirrors CLI `omg find`). Absent ⇒ FTS-only. The semantic
        // leg on a store without the module, or with a provider the host could
        // not start, is `capability_unavailable` (resolution 13's letter is
        // kept to the LEG: with nothing to fuse the ranker is FTS-only).
        if (ctx.embedQuery || ctx.semanticUnavailable) {
          const gate = semanticGate();
          if (gate) throw gate;
          input.vector = await ctx.embedQuery!(args.query);
        }
        return ok(surfaceResolveHits(resolveThing(store, input)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "apply",
    {
      description: ladder(
        "apply — plan and commit in one call; returns the Receipt { plan_id, commit, revisions, new_ids, committed, summary }.",
        "{\"effects\":[{\"op\":\"set\",\"target\":\"/substances/salt.md\",\"field\":\"_frontmatter.verified\",\"value\":false}],\"reason\":\"re-check salt\"}   one scalar; a bare path is a document target",
        "{\"effects\":[{\"op\":\"insert\",\"into\":\"/lab/2026-02-notes.md\",\"at\":\"end\",\"markdown\":\"## Follow-ups\\n\\n- [ ] re-run cycle 4\"}]}   append at a document's end",
        "{\"select\":\"blocks { _type == \\\"task\\\" and not checked and _path == \\\"/processes/calcination.md\\\" }\",\"effects\":[{\"op\":\"set\",\"field\":\"_attrs.checked\",\"value\":true}],\"expect\":{\"max\":10}}   bulk check-off; expect.max is REQUIRED with select",
        "Plan first for anything you cannot undo by hand; every error's data.fix is a corrected call to copy. Grammar: query_syntax.",
      ),
      inputSchema: {
        effects: z.array(effectSchema),
        select: z.string().optional(),
        expect: selectionExpectSchema.optional(),
        reason: z.string().optional(),
        ...REPO_ARG,
      },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const origin = { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) };
        // Plan + execute under one lock and one transaction → the Receipt (spec/mutate §11.7).
        return okMutated(surfaceReceipt(applyEffects(store, { repoId, rootPath, effects: args.effects, ...selectorArgs(args), origin, ...LOCK_DIR }) as Receipt));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- the Effect layer's verbs (spec/mutate §11, spec/surface §4 — 3.1) ----
  // `plan` reads only and returns the frozen Plan with its preview; `execute`
  // commits exactly a plan (the plan form, or the digest form `plan_id` +
  // `effects`); `apply { effects }` above is plan + execute in one call.

  tool(
    "plan",
    {
      description: ladder(
        "plan — Preview: the Plan (summary, $new.n ids) burns no id. Commit: execute { plan_id }. Bodies: diffs: true.",
        "{\"effects\":[{\"op\":\"set\",\"target\":\"/processes/calcination.md\",\"field\":\"_frontmatter.verified\",\"value\":false}]}   path = doc",
        "{\"effects\":[{\"op\":\"insert\",\"into\":{\"kind\":\"section\",\"heading_id\":\"b_153\"},\"markdown\":\"- [ ] Weigh the calx\"}]}   in a section",
        "{\"effects\":[{\"op\":\"create\",\"path\":\"lab/march.md\",\"markdown\":\"# March\\n\"},{\"op\":\"insert\",\"into\":\"$new.0\",\"markdown\":\"Hi.\"}]}   fill it: $new.0",
        "{\"select\":\"docs { stage == \\\"nigredo\\\" }\",\"effects\":[{\"op\":\"set\",\"field\":\"_frontmatter.ok\",\"value\":true}]}   no target: the hit",
        "{\"select\":\"docs { type == \\\"lab-note\\\" }\",\"effects\":[{\"op\":\"insert\",\"into\":\"-> `/processes/${subject}.md`\",\"markdown\":\"-> `[${_title}](${_path})`\"}]}   -> reads the row",
        "Ops: create insert set unset move remove split merge retarget; grammar: query_syntax.",
      ),
      inputSchema: { effects: z.array(effectSchema), select: z.string().optional(), expect: selectionExpectSchema.optional(), diffs: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const planned = planEffects(store, { repoId, rootPath, effects: args.effects, ...selectorArgs(args), ...LOCK_DIR });
        // (5.1) remembered for `execute { plan_id }` alone — the Plan as planned,
        // preview included (its `summary` is the Receipt's).
        rememberPlan(planned);
        const plan = surfacePlan(planned);
        // (4.5) `preview.diffs` — whole before/after bodies of every touched
        // document — only on request: `diffs: true`. The digest is over the
        // core, never the preview, so `plan_id` is the same either way.
        if (args.diffs === true || plan.preview === undefined) return ok(plan);
        const { diffs: _diffs, ...preview } = plan.preview;
        return ok({ ...plan, preview });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "execute",
    {
      description: ladder(
        "execute — Commit a plan from plan: by plan_id alone (this server remembers the plans it made), or the plan form (the whole Plan object), or the digest form (plan_id plus the same effects, re-planned and committed only if the digest still matches).",
        "{\"plan_id\":\"4cebb67faba4347b922151762478e60ddf56115a955489e222bee3c6bb2c7e7f\"}   the id alone: the remembered plan runs; an id this server never planned is plan_unknown (re-run plan)",
        "Or {\"plan\": the Plan as returned} or {\"plan_id\", \"effects\"}. A document that moved on fails stale_plan (retriable: call plan again). Grammar: query_syntax.",
      ),
      inputSchema: { plan: z.record(z.string(), z.unknown()).optional(), plan_id: z.string().optional(), effects: z.array(effectSchema).optional(), select: z.string().optional(), expect: selectionExpectSchema.optional(), reason: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        const shape = registry.get("execute")!.shape;
        // Three forms (spec/surface §4 `execute`): the plan form, the id alone
        // (5.1: the plan this server remembers under it, run as the plan form),
        // and the digest form (`plan_id` + `effects`, with `select`/`expect`).
        const planForm = args.plan !== undefined;
        const selector = args.select !== undefined || args.expect !== undefined;
        const idForm = args.plan_id !== undefined && args.effects === undefined && !selector;
        const digestForm = !idForm && (args.plan_id !== undefined || args.effects !== undefined || selector);
        if (planForm === (idForm || digestForm)) throw argumentError("execute", "pass exactly one of `plan`, `plan_id` or `plan_id` + `effects`", shape);
        if (digestForm && (args.plan_id === undefined || args.effects === undefined)) throw argumentError("execute", "the digest form needs both `plan_id` and `effects`", shape);
        const origin = { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) };
        const receipt = planForm
          ? executePlan(store, { repoId, rootPath, plan: args.plan, origin, ...LOCK_DIR })
          : idForm
            ? executePlan(store, { repoId, rootPath, plan: rememberedPlan(args.plan_id!), origin, ...LOCK_DIR })
            : executeByDigest(store, { repoId, rootPath, planId: args.plan_id!, effects: args.effects, ...selectorArgs(args), origin, ...LOCK_DIR });
        return okMutated(surfaceReceipt(receipt));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- block-level sugar (ref-accepting peers of the `apply` primitive) -------
  // These mirror the CLI verbs `insert`/`update`/`move`/`rm`/`split`/`merge`
  // 1:1. Each takes human REFS (a block id or anything resolveRef accepts),
  // resolves them + pins CAS server-side, builds exactly the effects the CLI
  // would (the shared builders), and applies them. This is what lets
  // `omg <verb> --server` feel identical to local: the resolution that used to
  // live in the CLI now lives next to the store, so a remote client needs no
  // local database.

  tool(
    "blocks_insert",
    {
      description: "Insert new block(s) parsed from `markdown` under a parent, at a position. `to` names the parent: a BLOCK ref (id or locator) nests the new blocks under that block — it must be a CONTAINER (a list, list item, task, blockquote or table); a leaf such as a heading or paragraph fails `type_mismatch` (spec/mutate §1.1) — use blocks_append for \"into this heading's section / this container\" or `at: {after: <ref>}` for \"right after this block\"; or a DOCUMENT ref (doc id or path) places them at the document's top level — so appending a new section to a document is `{ to: \"<path>\", markdown: \"## New\\n\\n…\" }` (the positional generalization of docs_append). `at` places among the parent's children: \"end\" (default) / \"start\" / {before|after: <block ref>}. Optional `expect.parent_children_hash` is the destination-parent CAS: the parent's CURRENT direct child ids (the document's top-level ids for a document `to`) joined by \",\" and sha256-hexed — compute it from docs_read include_ids (`ids` filtered by `parents`) — and the insert fails `stale_expectation` (with `data.current.parent_children_hash`) if the siblings changed under you; `content_hash` has no meaning here (there is no target block) and is not accepted. Sugar for `apply { effects: [{ op: \"insert\", into, at, markdown, expect? }] }` — returns the Receipt (`new_ids` holds the inserted blocks' ids, `$new.0` first); preview with `plan` over that effect.",
      inputSchema: { to: z.string(), markdown: z.string(), at: atSchema.optional(), expect: parentExpectSchema.optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        // `insert into document|block at …`: a document parent is the top level
        // (the planner pins the op to it). The caller's expect rides through as
        // the destination-parent expectation (spec/mutate §1.2).
        const into = parentTarget(resolveParentRef(repoId, args.to));
        return sugar(repoId, root, insertEffects(into, resolveAt(repoId, args.at), args.markdown, args.expect));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_update",
    {
      description: "Replace a block's markdown and/or set a task's `checked` state, with compare-and-swap. `_id` is the block's id (or any ref resolve accepts); `expect.content_hash` is pinned to the block's current bytes server-side when omitted (protects against a concurrent edit). `markdown` may parse to SEVERAL sibling blocks (e.g. a paragraph followed by a list): the target keeps its id and takes the first, the rest are inserted right after it with fresh ids — the Receipt's `new_ids` lists them (`$new.0`, …). A list item may likewise be replaced by a multi-item list (`- a\\n- b`), yielding sibling items. Task state is settable flat as `checked` (the same name reads flatten to — `blocks { checked }`), synced to the `[ ]`/`[x]` in the raw; every OTHER block attr (heading `level`, code `lang`, list `ordered`) is derived from the markdown, so set those by editing `markdown` (the 3.x `attrs` bag is retired and refused by name). Sugar for `apply { effects: [{ op: \"set\", target: { kind: \"block\", _id }, field: \"markdown\" | \"_attrs.checked\", value, expect? }] }` (both when both are given) — returns the Receipt; preview with `plan`.",
      inputSchema: { _id: z.string(), markdown: z.string().optional(), checked: z.boolean().optional(), expect: expectSchema.optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args._id);
        const built = updateBlockEffects(block, { markdown: args.markdown, checked: args.checked, expect: args.expect });
        // Nothing to set is an argument error (4.0): there is no effect for "touch".
        if (built.effects.length === 0) throw argumentError("blocks_update", "pass `markdown` and/or `checked`", registry.get("blocks_update")!.shape);
        return sugar(repoId, root, built);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_move",
    {
      description: "Move block(s) under a new parent at a position. `blocks` are block refs; `to` (the parent) is a block ref (a container — a leaf parent is `type_mismatch`, as for blocks_insert), or the blocks' OWN document (id or path) to move them to its top level — moving to ANOTHER document's root is not expressible (target_missing): anchor on a block in that document with `at` {before|after} instead. `at` is \"end\"/\"start\"/{before|after: <ref>}. Optional `expect.parent_children_hash` is the destination-parent CAS (as blocks_insert: the destination parent's CURRENT direct child ids joined by \",\", sha256 hex), checked once for the whole run before anything moves — `stale_expectation` with `data.current.parent_children_hash` if the destination's children changed; `content_hash` is meaningless here and not accepted. Sugar for `apply { effects: [{ op: \"move\", targets, into, at, expect? }] }` — returns the Receipt; preview with `plan`.",
      inputSchema: { blocks: stringList(), to: z.string(), at: atSchema.optional(), expect: parentExpectSchema.optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        requireSome("blocks_move", "blocks", args.blocks);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        const parentRef = resolveParentRef(repoId, args.to);
        // The kernel reads `{ doc: true }` + start/end as "the SOURCE doc's top
        // level", so a document parent is only honest when it IS the source doc.
        if (typeof parentRef.parent === "object" && blocks[0] !== undefined && docIdOfBlock(blocks[0]) !== parentRef.docId) {
          throw new EngineError("target_missing", `blocks_move cannot target another document's root (${args.to}); anchor on a block in that document with at.before/at.after`, { data: { to: args.to } });
        }
        return sugar(repoId, root, moveBlocksEffects(blocks, parentTarget(parentRef), resolveAt(repoId, args.at), args.expect));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_remove",
    {
      description: "Remove block(s) (the resurrection pool catches regret). `blocks` are refs; removing a block removes its whole subtree, and a set that names both a container and some of its descendants (e.g. every id of a section straight from docs_read include_ids) is fine — it collapses to the top-most blocks. Sugar for `apply { effects: [{ op: \"remove\", targets }] }` — returns the Receipt; preview with `plan` (its `preview.results[0].removed` lists everything that would leave). To delete a whole document use docs_delete.",
      inputSchema: { blocks: stringList(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        requireSome("blocks_remove", "blocks", args.blocks);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        return sugar(repoId, root, removeBlocksEffects(blocks));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_split",
    {
      description: "Split a block at UTF-8 byte offset(s) into consecutive blocks. `_id` is the block's id (or a ref); `at` is a list of integer byte offsets into the block's raw bytes (spec/mutate §2.5; an offset inside a multi-byte character rounds down to its start). CAS is pinned to the block's current bytes server-side. Sugar for `apply { effects: [{ op: \"split\", target, at }] }` — returns the Receipt (`new_ids` holds the new siblings); preview with `plan`.",
      inputSchema: { _id: z.string(), at: z.array(z.number().int()), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args._id);
        // The planner pins the content CAS from the live row (the block is live: it resolved).
        return sugar(repoId, root, splitEffects(block, args.at));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_merge",
    {
      description: "Merge adjacent blocks into the first, joined by `separator` (default a blank line). `blocks` are refs (≥2). Sugar for `apply { effects: [{ op: \"merge\", targets, separator? }] }` — returns the Receipt; preview with `plan`.",
      inputSchema: { blocks: stringList(), separator: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        requireSome("blocks_merge", "blocks", args.blocks);
        const blocks = args.blocks.map((b) => resolveBlockRef(repoId, b));
        return sugar(repoId, root, mergeEffects(blocks, args.separator));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_check",
    {
      description: "Macro: check (or uncheck with checked:false) the given task blocks. `_ids` are the blocks' ids (or refs). Sugar for `apply { effects: [{ op: \"set\", target: { kind: \"block\", _id }, field: \"_attrs.checked\", value }, …] }`, one per block, each CAS-pinned — returns the Receipt; preview with `plan` (tasks_complete { blocks } before surface 3.0).",
      inputSchema: { _ids: stringList(), checked: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        requireSome("blocks_check", "_ids", args._ids);
        const blocks = args._ids.map((b) => resolveBlockRef(repoId, b));
        // N × `set attrs.checked`, each CAS-pinned by the planner; a block named
        // twice is one write (the planner drops the identical duplicate, 3.2).
        return sugar(repoId, root, checkEffects(blocks, args.checked ?? true));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "nodes_set",
    {
      description:
        "Macro: surgically set one editable property of a projected node (e.g. a link's `name` text or `value` target, a task's `checked`). `_id` is the node's id (from `query` over `nodes { … }` — the one tool that addresses `nodes` rows), `prop` the property, `value` its new value. Resolves the node to its block and rewrites only that node's span. Nodes are read-only projections — this is the affordance to edit what a node represents without hand-rewriting the block. Errors node_not_editable (with the editable prop list) when the kind/prop has no editor. Sugar for `apply { effects: [{ op: \"set\", target: { kind: \"node\", _id }, field: prop, value }] }` — returns the Receipt; preview with `plan` (node_set before surface 3.0).",
      inputSchema: { _id: z.string(), prop: z.string(), value: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const known = store.db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND repo_id = ?").get(args._id, repoId);
        if (!known) throw new EngineError("block_missing", `no node with id ${JSON.stringify(args._id)}`, { data: { _id: args._id } });
        return sugar(repoId, root, nodeSetEffects(args._id, args.prop, args.value));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "blocks_append",
    {
      description:
        "Macro: append markdown INTO a block, by what the block is. `_id` is a block's id (or a ref). A HEADING: the `text` is inserted at the end of its section range (before the next heading of equal or higher level) — `insert into { kind: \"section\", heading_id }`. A CONTAINER (a list, list item, task, blockquote or table — anything the kernel accepts as a parent): inserted at the end of its children (`insert into { kind: \"block\", _id } at end`). A LEAF (a paragraph, code fence, …) is `block_not_container` — append means \"into\", never a sibling insert; place after it with `blocks_insert { to: <its parent>, at: { after: <_id> } }`. Sugar for that one `insert` effect — returns the Receipt; preview with `plan`. To append at a whole document's end, or inside a section named by its heading TEXT, use docs_append.",
      inputSchema: { _id: z.string(), text: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        const block = resolveBlockRef(repoId, args._id);
        const row = store.db
          .prepare("SELECT b.type AS type, d.format AS format, b.parent_block AS parent, d.path AS path, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_at IS NULL) AS children FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_at IS NULL")
          .get(block) as { type: string; format: string | null; parent: string | null; path: string; children: number } | undefined;
        if (!row) throw blockMissing(args._id);
        let into: EffectTarget;
        if (row.type === "heading") {
          into = { kind: "section", heading_id: block };
        } else if (isContainerBlock(row.format ?? "markdown", { type: row.type, children: new Array<unknown>(row.children) })) {
          into = blockTarget(block);
        } else {
          // The fix (4.4): the sibling insert spelled out — its parent block, or the document when it is top-level.
          throw new EngineError("block_not_container", `block ${block} is a ${row.type}, not a heading or a container; append means into — insert after it with blocks_insert { to: <its parent>, at: { after: ${JSON.stringify(block)} } }`, {
            data: { _id: block, _type: row.type, fix: fixTool("blocks_insert", { to: row.parent ?? referencePath(row.path), at: { after: block }, markdown: args.text }) },
          });
        }
        return sugar(repoId, root, appendEffects(into, args.text));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_append",
    {
      description:
        "Macro: append markdown to a document — at its END, or at the end of one of its sections when `section` names a heading by its TEXT (`\"Setup\"`; an ATX spelling `\"## Setup\"` is accepted). The journal/log/running-note primitive. ADDITIVE and identity-preserving, NOT a whole-body replace: the `text` is parsed into blocks and inserted as NEW blocks after the existing ones (at the document's top level, or inside the section's range), so every existing block keeps its stable `b_` id (omgbase deliberately has no whole-body `docs_put` — see mcp-api). Sugar for one `insert at end` effect into the document or the resolved section — returns the Receipt (`new_ids` the appended blocks); preview with `plan`. Address the document by `_id` or `_path` (at least one). The document must already exist — a missing doc errors `doc_missing` (creating one is docs_create's job, never this); a `section` matching no heading in it is `parent_missing`, one matching several is `ambiguous_heading` with `candidates[{ _id, _doc_id }]` — pass that heading's `_id` to blocks_append, which appends into a block by its id.",
      inputSchema: { ...DOC_ARGS, text: z.string(), section: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        const root = requireRoot(rootPath);
        // Resolve the locator to a live doc id FIRST — a missing doc is doc_missing
        // (locateDoc throws it), never an auto-create. Then expand to the single
        // insert-at-end effect (document top level, or the named section) and
        // apply it (existing blocks keep their ids; only the appended blocks are minted).
        const docId = locateDoc(repoId, "docs_append", registry.get("docs_append")!.shape, args);
        let into: EffectTarget;
        if (args.section !== undefined) {
          const info = findDoc(store, { docId })!;
          into = { kind: "section", heading_id: resolveSectionHeading(docId, info.path, args.section, { ...(args._id !== undefined ? { _id: args._id } : {}), ...(args._path !== undefined ? { _path: args._path } : {}), text: args.text }) };
        } else {
          into = { kind: "document", _id: docId };
        }
        return sugar(repoId, root, docsAppendEffects(into, args.text));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "links_retarget",
    {
      description: "Macro: rewrite ONE link destination everywhere it is linked — the single-pair form of links_repair (same matching rules: whole link destinations only, leading `/` optional, fragments preserved; prose/inline code/code fences untouched). Scope source docs with `path_glob`. COMMITS: sugar for `apply { effects: [{ op: \"retarget\", repairs: [{ from, to }], path_glob? }] }`; returns `hits[{_id,_path,oldRaw,newRaw}]` (the rewritten block and its document) and `pairs[{from,to,hits}]` plus the Receipt (`commit` null when nothing matched). To PREVIEW first, call `plan` with that one effect: its `preview.retarget[0]` carries the same `hits` and `pairs` and `preview.diffs` the files, and it fails exactly where the commit would (through surface 3.x this tool was a dry run by default, with `applied`).",
      inputSchema: { from_target: z.string(), to_target: z.string(), path_glob: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId, rootPath } = repoScope(args.repo);
        if (!rootPath) throw new EngineError("repo_not_found", "repo has no filesystem source; mutation disabled");
        // `hits`/`pairs` come from the macro's plan; the write is the `retarget`
        // effect, whose lowering runs the same macro (same ops, same CAS pins).
        const { hits: rawHits, pairs } = linksRetarget(store, repoId, args.from_target, args.to_target, args.path_glob ? { pathGlob: args.path_glob } : {});
        const hits = surfaceRetargetHits(rawHits);
        const { receipt } = runSugar(repoId, rootPath, retargetEffects([{ from: args.from_target, to: args.to_target }], args.path_glob, "links_retarget"));
        return okMutated({ hits, pairs, ...surfaceReceipt(receipt) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "links_stale",
    {
      description:
        "READ-ONLY link health: surfaces DANGLING internal links — links whose target path has NO live document (stored as a `phantom:` edge; a doc created at that path auto-resolves them). Returns `stale[]` (each a link row under the `links` target's names: `_doc_id`, `_path` (the source document), `_block_id` (null for a frontmatter edge), `_predicate`, `_provenance`, `_dst_kind`, `target` = the canonical missing path, `/`-rooted like every path the surface returns (e.g. `/guides/old.md`), `authored` = the destination text exactly as written in the source block (e.g. `/guides/old.md#Setup`; null for frontmatter edges), `_anchor`, and reason `dangling_doc`), plus `externalCount` (http(s) links — UNVERIFIABLE here, never marked broken, since reachability needs network I/O the engine won't do), `totalOpenEdges`, and `truncated` (capped by `limit`, default 500). `summary:true` returns counts only — `staleCount`, `byTarget[{target,count}]`, `bySource[{_path,count}]`, `externalCount`, `totalOpenEdges` — for a repo-wide audit in one small call. Scope the SOURCE docs with `path_glob` (e.g. \"journal/*\"; `*` matches across `/`). Fix the reported targets with `links_repair` (batch) or `links_retarget` (single): either `target` or `authored` works as `from`. Anchors (#heading/^ref) into an existing doc are NOT verified in v1. Contrast docs_read/query which answer 'what does this doc say', not 'which of its links are broken'.",
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
        "Macro: BULK stale-link repair — rewrite one or MANY LINK DESTINATIONS in ONE changeset. Pass `repairs` (an array of {from,to}) to fix several dangling targets — e.g. those surfaced by links_stale — at once; a single {from_target,to_target} pair is also accepted. MATCHING: `from` must be the WHOLE destination of a Markdown link/image `[t](dest)`, a wikilink `[[dest]]`/`[[dest|alias]]`, or a bare-path inline field `key:: /dest` — a leading `/` is optional on either side (so links_stale's `target` or `authored` both work), and a trailing `#heading`/`^ref` fragment on the link is kept and re-appended to `to`. NOT rewritten: prose mentions, inline code, `code_fence` blocks, longer paths that merely contain `from`, and frontmatter values (use docs_set_meta). Scope source docs with `path_glob` (as in links_stale). Ops coalesce to one update per TOP-MOST block (a list and its items count once), so a batch never trips over its own re-minted children. COMMITS: sugar for `apply { effects: [{ op: \"retarget\", repairs, path_glob? }] }`; returns `hits[{_id,_path,oldRaw,newRaw}]` (the rewritten block and its document) and `pairs[{from,to,hits}]` (per-pair destination counts; 0 = nothing matched) plus the Receipt (`commit` null when nothing matched). To PREVIEW first, call `plan` with that one effect — its `preview.retarget[0]` carries the same `hits`/`pairs`, `preview.diffs` the files — and it fails exactly where the commit would (through surface 3.x this tool was a dry run by default, with `applied`).",
      inputSchema: {
        repairs: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        from_target: z.string().optional(),
        to_target: z.string().optional(),
        path_glob: z.string().optional(),
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
        const { hits: rawHits, pairs } = linksRepair(store, repoId, repairs, args.path_glob ? { pathGlob: args.path_glob } : {});
        const hits = surfaceRetargetHits(rawHits);
        const { receipt } = runSugar(repoId, rootPath, retargetEffects(repairs, args.path_glob, "links_repair"));
        return okMutated({ hits, pairs, ...surfaceReceipt(receipt) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- the document operations as effects (spec/surface §4 "The document operations", 3.3; 4.0) ----
  // `docs_create` / `docs_delete` / `docs_move` / `docs_set_meta` are one document
  // effect each — `create`, `remove { target: document }`, `move { target:
  // document, to, retarget_inbound }`, one `set`/`unset frontmatter.<k>` per key —
  // built by the shared builders (`mutate/sugar.ts`), planned and executed
  // through the same seam as the block-level sugar under the `spec/mutate` §6
  // reasons (`create <rel>`, `delete <path>`, `move <from> -> <to>`, `set_meta
  // <path>`), each returning the Receipt (4.0). Each tool keeps its own
  // pre-checks — `locateDoc`'s `doc_missing`, the create/move `path_taken` pair
  // (no `data`, as pinned) — so the planner's own copies of them never fire and
  // the error envelopes are unchanged. The workspace dir rides along (LOCK_DIR):
  // the tool-boundary lock already holds the writer lock for the call, so the
  // request's own lock re-enters it. MCP-originated writes are actor agent:mcp.
  /** The storage-form path of a document `locateDoc` just found. */
  const pathOfDoc = (docId: string): string => findDoc(store, { docId })!.path;
  /** `path_taken` exactly as the legacy document operations raised it: their message, no `data` (§9). */
  const requireAbsent = (repoId: string, rootPath: string, rel: string, takenMessage: string): void => requireAbsentPath(store, repoId, { rootPath }, rel, takenMessage);

  tool(
    "docs_create",
    {
      description: "Create a new document at `path` (the new document's path, either form) from complete file bytes (`markdown`), with optional structured `frontmatter`. Sugar for `apply { effects: [{ op: \"create\", path, markdown, frontmatter? }] }` — returns the Receipt: `revisions[0]` is the created document (its `_id`, rooted `_path`, `_hash`), `new_ids[\"$new.0\"]` the same id and `$new.1…` its blocks in pre-order. Fails path_taken if it already exists. Preview with `plan` over that effect (`preview.diffs[path]` is `\"\" → the bytes`).",
      inputSchema: { path: z.string(), markdown: z.string(), frontmatter: z.record(z.string(), z.unknown()).optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const rootPath = requireRoot(scope.rootPath);
        const rel = canonicalDocPath(args.path);
        requireAbsent(scope.repoId, rootPath, rel, `document already exists at ${rel}`);
        return sugar(scope.repoId, rootPath, createEffects(rel, args.markdown, args.frontmatter));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_move",
    {
      description:
        "Rename a document to a new path (`to_path`, `/`-rooted or bare); the document is addressed by `_id` or `_path`. Block identity and history are preserved, and the inbound links FOLLOW it: every link written against the old path (Markdown links/images, wikilinks, bare-path inline fields — anchors, link text, titles and code spans preserved, absolute vs relative style kept) is rewritten to the new path in the same call as one CAS-checked commit, so a move never leaves the graph broken. Fails path_taken if the destination exists. Sugar for `apply { effects: [{ op: \"move\", target: { kind: \"document\", _id }, to, retarget_inbound? }] }` — returns the Receipt (one revision per rewritten source; the moved document's own revision does not advance unless it links to itself) plus `retargeted` (the touched blocks/docs) and `dangling` — what could NOT be rewritten, i.e. frontmatter relations (`_block_id` null; fix with docs_set_meta). Pass `retarget_inbound:false` to opt out for the rarer intent that the old path become unbound: the links are left as written, listed in `dangling` ({_doc_id, _path, _block_id, target, _anchor, _field?} per occurrence — a link row under the `links` target's names) and reported by links_stale (their edges become `phantom:<old path>`); links already written against the new path start resolving to this doc either way. Preview with `plan` over that effect: `preview.diffs` holds the old path emptied, the new path filled and the rewritten sources.",
      inputSchema: { ...DOC_ARGS, to_path: z.string(), retarget_inbound: z.boolean().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_move", registry.get("docs_move")!.shape, args);
        const rootPath = requireRoot(scope.rootPath);
        const doc = { _id: docId, _path: pathOfDoc(docId) };
        const to = canonicalDocPath(args.to_path);
        requireAbsent(scope.repoId, rootPath, to, `a document already exists at ${to}`);
        const retargetInbound = args.retarget_inbound !== false;
        // Who links here BY PATH, as written — read before the path changes — and
        // the rewrite the move carries (`moveLinks` is pure over the current
        // blocks, so computed here, before the commit, it equals what the planner
        // lowered, `spec/mutate` §11.3) → `dangling`/`retargeted`.
        const links = moveLinks(store, scope.repoId, doc, to, retargetInbound);
        const { receipt } = runSugar(scope.repoId, rootPath, moveDocEffects(doc, to, retargetInbound));
        return okMutated({ ...surfaceReceipt(receipt), retargeted: links.retargeted, dangling: links.dangling.map(surfaceInboundLink) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_delete",
    {
      description: "Delete a document: tombstone it and its live blocks (resurrection-poolable) and remove the file. Address it by `_id` or `_path`. Sugar for `apply { effects: [{ op: \"remove\", target: { kind: \"document\", _id } }] }` — returns the Receipt (a tombstone advances no revision: `revisions` is empty, `commit` the one commit). Preview with `plan` over that effect (`preview.diffs[path]` is `the bytes → \"\"`).",
      inputSchema: { ...DOC_ARGS, ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_delete", registry.get("docs_delete")!.shape, args);
        const rootPath = requireRoot(scope.rootPath);
        return sugar(scope.repoId, rootPath, deleteDocEffects({ _id: docId, _path: pathOfDoc(docId) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_set_meta",
    {
      description: "Surgical frontmatter patch: set the given keys and/or unset named keys on the document addressed by `_id` or `_path`. Other frontmatter and the whole body are preserved (every block keeps its id). Sugar for `apply { effects: [{ op: \"set\", target: { kind: \"document\", _id }, field: \"_frontmatter.<key>\", value }, { op: \"unset\", …, field: \"_frontmatter.<key>\" }, …] }`, one effect per key — returns the Receipt; at least one of `set`/`unset` is required. Preview with `plan` over those effects (`preview.diffs[path]` is the file before → after).",
      inputSchema: { ...DOC_ARGS, set: z.record(z.string(), z.unknown()).optional(), unset: stringList().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const shape = registry.get("docs_set_meta")!.shape;
        const docId = locateDoc(scope.repoId, "docs_set_meta", shape, args);
        const rootPath = requireRoot(scope.rootPath);
        // One scalar effect per key, `unset` winning over `set` for a shared key;
        // the planner drops a repeated `unset`. An empty patch is an argument
        // error (3.3, §9) — it used to rewrite the frontmatter through the emitter for nothing.
        const built = setMetaEffects({ _id: docId, _path: pathOfDoc(docId) }, args.set, args.unset);
        if (built.effects.length === 0) throw argumentError("docs_set_meta", "pass `set` and/or `unset`", shape);
        return sugar(scope.repoId, rootPath, built);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_update",
    {
      description:
        "Whole-document update with smart identity preservation — sugar for `apply { effects: [{ op: \"set\", target: { kind: \"document\", _id }, field: \"content\", value: content }] }` (surface 4.0). Submit the complete proposed `content` for a document (`_id` or `_path`); the engine reconciles it against the current tree, preserving stable block ids for structure that is recognizably the same (edits, moves, reorders), minting for new structure, and tombstoning removals — frontmatter changes included — and commits the derived ops as ONE transaction. Returns the Receipt `{ plan_id, commit, revisions: [{ _id, _path, _hash }], new_ids, committed: true }`; content that already equals the document is a plan with nothing to do — no commit (`commit: null`, no revision). To INSPECT the identity consequences before committing, call `plan { effects: [that set] }`: its `preview.identity[<doc id>]` is `{ matcher_v, summary: { preserved, updated, moved, created, removed, split, merged, ambiguous }, ops: [{ op_index, disposition, blocks, confidence, reason }], diagnostics }` — each planned kernel op (`preview`'s `op_index` into the plan's `opset.ops`) annotated with the disposition it realizes — and the plan's `preconditions.docs` pin the document's revision and hash; then `execute` that plan, or call this tool. A document that changed since planning fails stale_plan (re-plan). Content the planner cannot reproduce byte-for-byte fails plan_not_convergent; the message names the first divergent byte and the proposed block (index/type) that failed to round-trip (full diagnostics in `data.diagnostics`).",
      inputSchema: { ...DOC_ARGS, content: z.string(), reason: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const scope = repoScope(args.repo);
        const docId = locateDoc(scope.repoId, "docs_update", registry.get("docs_update")!.shape, args);
        const rootPath = requireRoot(scope.rootPath);
        const { receipt } = runSugar(scope.repoId, rootPath, updateContentEffects({ _id: docId }, args.content), args.reason);
        return okMutated(surfaceReceipt(receipt));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "observe",
    {
      description:
        "SYNC INGEST (ADR-014): record `content` as the current authoritative bytes for `path`, committed as an OBSERVED-origin revision — a write *around* the engine, the way a human/external edit is recorded. Contrast docs_update, which is api-origin (a write *through* the engine, agent intent); both reconcile the new bytes against the current block tree and preserve stable ids, but the origin differs (and thus the change-feed semantics and matcher path). This is the file→DB direction for an out-of-process synchronizer: it never writes a file, so it works on a headless/sourceless server with no working tree. Idempotent: bytes whose hash already equals the stored revision are an ECHO — no commit (`echo:true`, `rev:null`). Bytes with git conflict markers are still ingested (opaque) and the doc is flagged (`conflicted:true`). To mirror a deletion, use `observe_delete` (an observed, resurrection-pooled tombstone — not `docs_delete`, which is an intentional api-origin removal that also unlinks the file). Returns `{ _id, _path, rev, commitId, converged, echo, conflicted, dispositions }` — the document's row attributes plus a disposition summary (how identity threaded). The `path` ARGUMENT is a FILE event's path from the store's layer, not a row locator, so it keeps its bare name.",
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
      description: "A block's biography: the commits that CHANGED the block `_id` names — inserted, edited, moved, split/merge lineage, resurrected — with disposition kind/confidence/reason, newest first. A commit that rewrote the document but left this block byte-identical in place is not listed (store 14.2: `same` verdicts are not persisted; through 14.1 every commit to the document appeared here), so the newest entry's `ts` is the block's `_updated_at`; to learn whether the block was present in some other commit, diff two revisions with docs_diff (history_node before surface 3.0 — it always took a block id and returned the block's changes). Not repo-scoped: block ids are global.",
      inputSchema: { _id: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(history.blocksHistory(args._id, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_diff",
    {
      description: "Block-grain diff between two revisions of a document: `[{ kind: added|removed|changed, _id (the block), before?, after? }]` in that order. Address the document by `_id` or `_path` (at least one); `from_rev`/`to_rev` are revision ids (from docs_history, changes_since or blocks_history). Contrast docs_diff_unified, the unified text diff. (diff before surface 3.0.)",
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
        return ok(history.diffBlocks(docId, args.from_rev, args.to_rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_diff_unified",
    {
      description:
        "Unified diff between two revisions of a document (the `omg diff` rendering): returns `{ _id, _path, from, to, diff }` where `diff` is a unified diff of the two revisions' file texts — for each revision exactly the bytes docs_read_at returns, so hunk line numbers are real file lines (Myers shortest edit script; `@@ -a,b +c,d @@` hunks with 3 lines of context; lines prefixed `-`, `+` or a space; no file header; identical texts → \"\"). Address the document by `_id` or `_path` (at least one). `from_rev`/`to_rev` default to the previous and current revisions ('what did the last commit change here'). Contrast `docs_diff`, which returns block-grain added/removed/changed entries. (diff_unified before surface 3.0.)",
      inputSchema: { ...DOC_ARGS, from_rev: z.string().optional(), to_rev: z.string().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_diff_unified", registry.get("docs_diff_unified")!.shape, args);
        return ok(history.docDiffUnified(docId, {
          ...(args.from_rev !== undefined ? { fromRev: args.from_rev } : {}),
          ...(args.to_rev !== undefined ? { toRev: args.to_rev } : {}),
          label: JSON.stringify(args._id ?? args._path),
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
        "TIME-TRAVEL read: the whole file bytes of a document AS OF a past revision — `_raw` is the reconstructed source at that `rev` (fences/tables/list markers preserved), plus `_id`/`_path` (the path as of that revision)/`rev`. Sugar for `docs_read { _id | _path, at: rev }` (surface 4.7) — the same result, byte for byte. Use this to audit or answer 'what did this doc say at revision N', or to fetch the exact prior text before reverting. Get a `rev` from `query` over the `revisions` target (`revisions { _path == … order by _seq }`), docs_diff, blocks_history, docs_history or changes_since. Contrast: docs_read = current bytes; docs_diff = block-grain changes BETWEEN two revisions. `renderedHashMatch` is true when the reconstruction is byte-for-byte the file at that revision; it can be false for an old revision ONLY when the document's leading/frontmatter trivia (separator bytes, not block content) changed since — block content always reconstructs faithfully. No `properties`: the property table is current-state only (through 4.6 the current bag rode along flagged propertiesAreCurrent). Address the document by `_id` or `_path` plus a `rev` id. A revision whose bodies were moved to an archive segment (`_archived` in docs_history / the revisions target) reads through the segment when it is attached; otherwise the call fails `revision_archived` with `data: { rev, archive, path? }` — an operator attaches the file with `omg history attach`.",
      inputSchema: { ...DOC_ARGS, rev: z.string(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        const docId = locateDoc(repoId, "docs_read_at", registry.get("docs_read_at")!.shape, args);
        return ok(docsReadAt(docId, args.rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "docs_history",
    {
      description:
        "VERSION HISTORY of matching documents, grouped BY DOCUMENT: for each doc (`_id`, `_path`, `deleted`, `currentRev`), its ordered revision list (oldest→newest) — each version a `revisions` row under the row's names: `_rev`/`_seq`/`_commit`/`_ts`/`_origin`/`_actor`/`_hash`/`_is_current`/`_archived` (true when the revision's bodies live in an archive segment — the row stays, docs_read_at reads through the segment while it is attached). Give `path_glob` (e.g. \"journal/*\" — `*` matches ACROSS `/`, so journal/* and journal/** are equivalent) OR a single document by `_id` or `_path`; at least one is required. `_hash` (hex of the revision's rendered file hash) lets you spot no-op vs real changes. Feed a returned `_rev` into `docs_read_at` (whole doc AT that rev) or `docs_diff` (block-grain changes BETWEEN two revs). By default only live docs; `include_deleted:true` also returns tombstoned docs (their history is intact for audit). `limit` caps DOCUMENTS returned (default 50) with a `truncated` flag. Contrast `changes_since`: a repo-wide COMMIT feed, not this per-document view.",
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
        if (!args.path_glob && args._id === undefined && args._path === undefined) {
          throw new EngineError("target_missing", "docs_history requires one of path_glob, _id or _path");
        }
        let doc: string | undefined;
        if (args._id !== undefined || args._path !== undefined) {
          // A live document resolves through the locator; with include_deleted a
          // tombstoned one is looked up by the same attribute.
          const tomb = args.include_deleted
            ? (args._id !== undefined
              ? store.db.prepare("SELECT doc_id FROM docs WHERE doc_id = ? AND repo_id = ?").get(args._id, repoId)
              : store.db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ?").get(repoId, storagePath(args._path!))) as { doc_id: string } | undefined
            : undefined;
          doc = tomb ? tomb.doc_id : locateDoc(repoId, "docs_history", registry.get("docs_history")!.shape, args);
        }
        return ok(history.docsHistory(repoId, {
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
      description: ladder(
        "changes_since — Re-orient after time away: the commit feed after a cursor, each digest with its revisions [{ _id, _path, _hash }].",
        "{}   everything from the start; head is the current max seq",
        "{\"cursor\":20,\"limit\":5}   commits after seq 20, five at a time (cursor pages while truncated)",
        "{\"origin\":\"api\"}   only the writes made through the engine (observed = edits on disk; import)",
        "Poll with your last cursor: an empty page with cursor == head means nothing new. Read a changed document with docs_read, its blocks with query (grammar: query_syntax).",
      ),
      inputSchema: { cursor: z.number().int().optional(), origin: z.enum(["api", "observed", "import"]).optional(), limit: z.number().int().optional(), ...REPO_ARG },
    },
    async (args) => {
      try {
        const { repoId } = repoScope(args.repo);
        return ok(history.changesSince(repoId, {
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
        "Repo counts (`{ _id, slug, rootPath, docs, blocks, commits, openEdges, unconverged, disk }` — `_id` is the root row's id): docs, blocks, commits, open edges, unconverged doc count, and on-disk drift. " +
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
      description: ladder(
        "version — Which engine and which versions you are talking to, and which tools profile it serves.",
        "{}   engine, version, components, specs, schema, mcp, runtime, commit, built and profile (\"full\" or \"minimal\")",
        "Under the minimal profile ten tools are listed; calling an unlisted one is the JSON-RPC error unknown tool. Reads go through query (grammar: query_syntax).",
      ),
      inputSchema: {},
    },
    async () => {
      try {
        return ok(versionInfo(store, ctx.host, profile, capabilityStates(store, ctx.repoId, ctx.semanticUnavailable ?? null)));
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
    // An unregistered name — unknown, or hidden by the profile — is the JSON-RPC
    // `-32602` error with exactly the text both engines pin (spec/surface §4
    // "Profiles"): `unknown tool <name>`. The SDK copies a thrown error's
    // integer `code` and its `message` onto the wire verbatim; `McpError`
    // would prefix the message ("MCP error -32602: …"), so a plain Error
    // carries the code instead.
    if (!entry) throw unknownTool(name);
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

/** The pinned text of a `tools/call` on a name the server does not serve (spec/surface §4 "Profiles"). */
export const UNKNOWN_TOOL_CODE = ErrorCode.InvalidParams; // -32602
export function unknownTool(name: string): Error {
  return Object.assign(new Error(`unknown tool ${name}`), { code: UNKNOWN_TOOL_CODE });
}

/** The catalog's tool names in registration order with their descriptions —
 *  what `spec/surface/tool-descriptions.json` pins for both engines (over a
 *  `full` server; a profiled server lists its subset in the same order). */
export async function toolDescriptions(server: McpServer): Promise<Record<string, string>> {
  const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
  const out: Record<string, string> = {};
  for (const [name, t] of Object.entries(tools)) out[name] = t.description ?? "";
  return out;
}

/** The tool names a server lists, in registration order (`spec/surface/cases/profiles.json` pins them per profile). */
export async function toolNames(server: McpServer): Promise<string[]> {
  return Object.keys(await toolDescriptions(server));
}
