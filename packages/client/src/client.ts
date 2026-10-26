// `OmgClient`: omgbase's MCP server over the Streamable HTTP transport, typed
// for the minimal profile (spec/surface §4 "Profiles"): the ten tools an
// Explorer app and its elements share — `query`, `query_syntax`, `docs_read`,
// `docs_tree`, `blocks_resolve`, `changes_since`, `plan`, `execute`, `apply`,
// `version`. Nothing here imports an omgbase engine package; the registrations
// in packages/core/src/mcp/server.ts are the wire truth this file types.
//
// Session recovery: a Streamable HTTP server forgets a session (a proxy after
// its idle timeout or a restart; a gateway likewise) and answers the next POST
// with 404 — the spec's cue to `initialize` again. The SDK's client does not do
// that by itself, so `OmgClient` does: a call that fails with a lost session
// drops the client, opens a fresh one against the same URL and retries the call
// once (`isSessionLost`); only a second failure reaches the caller.
//
// Auth: when an `authProvider` (the SDK's `OAuthClientProvider`) is given, a
// 401 runs the SDK's OAuth flow and surfaces as `AuthRequiredError`; the client
// carries no OAuth implementation of its own — that stays in the app.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Effect } from "./effects.js";

// ---- the catalog --------------------------------------------------------------------

/** The two catalog profiles (spec/surface §4 "Profiles"). */
export type ToolsProfile = "full" | "minimal";

/** The `minimal` profile, in the server's registration order (`MINIMAL_TOOLS` in server.ts). */
export const MINIMAL_TOOLS = ["query", "query_syntax", "docs_read", "docs_tree", "blocks_resolve", "changes_since", "plan", "execute", "apply", "version"] as const;
export type MinimalTool = (typeof MINIMAL_TOOLS)[number];

/** The minimal tools that take a `repo` slug (every one but `query_syntax` and `version`). */
export const REPO_SCOPED_TOOLS: ReadonlySet<string> = new Set(["query", "docs_read", "docs_tree", "blocks_resolve", "changes_since", "plan", "execute", "apply"]);

/** The tools that commit (or, as `plan`, read under the writer lock). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["apply", "plan", "execute"]);

// ---- wire shapes --------------------------------------------------------------------

/** A repo slug per call: a string names one, `undefined` takes the client's default, `null` omits the argument (the server's default repo). */
export type RepoArg = string | null | undefined;

/** A row's identity under the engine names every result and every query spells (`_id`, `_path`). */
export interface Hit {
  _id: string;
  _path: string;
  [k: string]: unknown;
}

export type QueryConsumer = "collect" | "count" | "exists" | "none" | "first" | "single";

interface QueryPage {
  truncated: boolean;
  cursor: string | null;
  /** Names the query read that nothing carries (spec/surface §1.5); absent when none. */
  hints?: string[];
}

/** `query`'s result by consumer: rows for `collect`/`first`/`single` (`values` for a
 * `values` projection, in place of `hits`), a number for `count`, a boolean for
 * `exists` / `none`. `hits` is always present (empty for the scalar consumers). */
export type QueryResult =
  | (QueryPage & { consumer: "collect" | "first" | "single"; hits: Hit[]; values?: unknown[] })
  | (QueryPage & { consumer: "count"; hits: Hit[]; count: number })
  | (QueryPage & { consumer: "exists"; hits: Hit[]; exists: boolean })
  | (QueryPage & { consumer: "none"; hits: Hit[]; none: boolean });

export interface QueryOptions {
  limit?: number;
  cursor?: string | null;
  /** The projection alone, without the `_id`/`_path` envelope. */
  bare?: boolean;
  repo?: RepoArg;
}

export interface QueryAllOptions {
  /** Stop after this many rows (default 2000). */
  max?: number;
  /** Rows per page (default 500). */
  pageSize?: number;
  repo?: RepoArg;
}

/** The OQX reference: the card and its section slugs, or one section. */
export type QuerySyntaxResult = { syntax: string; sections: string[] } | { section: string; syntax: string };

/** A document locator (spec/surface §4 "Arguments"): at least one of `_id`, `_path`. */
export type DocLocator = { _id: string; _path?: string } | { _path: string; _id?: string };

export interface DocsReadResult {
  _id: string;
  /** The reference form, `/a/b.md`. */
  _path: string;
  rev: string | null;
  properties: { frontmatter: Record<string, unknown>; inline: Record<string, unknown>; computed: Record<string, unknown> } & Record<string, Record<string, unknown>>;
  /** The file bytes. */
  _raw: string;
  /** With `include_ids`: block ids in pre-order. */
  ids?: string[];
  /** With `include_ids`: block id → `_hash`, the CAS token `expect.content_hash` takes. */
  hashes?: Record<string, string>;
  /** With `include_ids`: block id → parent block id (null = top level). */
  parents?: Record<string, string | null>;
}

/** `docs_read { at }`: the document as of a revision — bytes only, no properties. */
export interface DocsReadAtResult {
  _id: string;
  _path: string;
  rev: string;
  _raw: string;
  renderedHashMatch: boolean;
}

export interface DocsReadOptions {
  includeIds?: boolean;
  repo?: RepoArg;
}

export interface DocsTreeEntry {
  /** Present on a document row (`files: true`). */
  _id?: string;
  /** A directory ends in `/`. */
  _path: string;
  /** Documents beneath a directory. */
  docs?: number;
  blocks: number;
  _updated_at?: string | null;
}

export interface DocsTreeResult {
  prefix: string;
  depth: number;
  total: { docs: number; blocks: number };
  files_here: number;
  entries: DocsTreeEntry[];
  truncated: boolean;
  cursor: string | null;
}

export interface DocsTreeOptions {
  path?: string;
  depth?: number;
  files?: boolean;
  updated?: boolean;
  limit?: number;
  cursor?: string | null;
  budgetTokens?: number;
  repo?: RepoArg;
}

/** A `blocks_resolve` hit: the block's id, its `<path>#<type>[<ordinal>]` locator, a preview and the fusion evidence. */
export interface ResolveHit {
  _id: string;
  locator: string;
  preview: string;
  evidence: unknown;
}

export interface Revision {
  _id: string;
  _path: string;
  _hash: string;
}

/** A document of a `changes_since` digest (spec/surface §3, 6.0): the row's engine names, the entry's `kind`, `from_path` on a move; `_hash` null for a deletion. */
export interface DigestRevision {
  _id: string;
  _path: string;
  _hash: string | null;
  kind: "created" | "changed" | "deleted" | "moved";
  from_path?: string;
}

export interface CommitDigest {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  /** the observed batch this commit belongs to (the first committing member's commit id; `= commit` for an api commit) */
  batch_id: string;
  /** the admitted plan's digest for an effect-driven api commit */
  plan_id?: string;
  summary: string;
  revisions: DigestRevision[];
}

export interface ChangesSinceResult {
  digests: CommitDigest[];
  /** The last seq of the page — pass it back (with `epoch`) to continue. */
  cursor: number;
  /** The feed's epoch: a cursor is the pair `(epoch, seq)`; a cursor from another epoch is `expired_cursor`. */
  epoch: string;
  /** The oldest seq the feed still holds (0 when empty); a cursor behind `oldest - 1` is `expired_cursor`. */
  oldest: number;
  truncated: boolean;
  /** The repo's current max seq: `cursor == head` means nothing new. */
  head: number;
}

export interface ChangesSinceOptions {
  cursor?: number;
  /** the epoch the cursor came from (default: the repo's current one) */
  epoch?: string;
  limit?: number;
  /** Only commits of one origin: writes through the engine, edits observed on disk, imports. */
  origin?: "api" | "observed" | "import";
  repo?: RepoArg;
}

export interface Receipt {
  plan_id: string;
  /** `null` when the plan had nothing to commit. */
  commit: string | null;
  revisions: Revision[];
  /** `$new.n` → the minted id. */
  new_ids: Record<string, string>;
  committed: true;
  /** What was committed, in words, one line per effect. */
  summary: string[];
}

export interface PlanPreview {
  results: unknown[];
  revisions: Revision[];
  /** Only with `diffs: true`. */
  diffs?: Record<string, { before: string; after: string }>;
  identity?: Record<string, unknown>;
  retarget?: unknown[];
  summary: string[];
}

/** A Plan as the server returns it (spec/mutate §11.6): the digested core verbatim plus `plan_id`, `diagnostics`, `preview`. */
export interface Plan {
  plan_id: string;
  version: number;
  planner_v: string;
  effects: unknown[];
  opset: unknown;
  preconditions: {
    docs: { _id: string; _path: string; base_revision: string | null; _hash: string | null }[];
    blocks: { _id: string; content_hash: string }[];
    parents: { doc: string; parent: string | null; parent_children_hash: string }[];
    absent_paths: string[];
  };
  new_ids: { symbol: string; kind: "block" | "document" }[];
  selection?: unknown;
  diagnostics: string[];
  templates?: unknown[];
  preview?: PlanPreview;
  [k: string]: unknown;
}

/** The selector half of a write: an OQX query whose hits the effects are templates over, bounded by `expect.max`. */
export interface Selector {
  select?: string;
  expect?: { max: number };
}

export interface ApplyRequest extends Selector {
  effects: Effect[];
  /** The commit's reason. */
  reason?: string;
  repo?: RepoArg;
}

export interface PlanRequest extends Selector {
  effects: Effect[];
  /** Include `preview.diffs` (whole before/after bodies). */
  diffs?: boolean;
  repo?: RepoArg;
}

/** `execute`'s three forms: the id alone (the server's plan memory), the plan object, or the digest form. */
export type ExecuteRequest = ({ plan_id: string; effects?: undefined; plan?: undefined } | ({ plan_id: string; effects: Effect[]; plan?: undefined } & Selector) | { plan: Plan | Record<string, unknown>; plan_id?: undefined; effects?: undefined }) & {
  reason?: string;
  repo?: RepoArg;
};

export interface VersionInfo {
  engine: "typescript" | "rust" | string;
  version: string;
  components: Record<string, string>;
  specs: Record<string, string>;
  schema: number | null;
  mcp: { protocol: string; sdk?: string };
  runtime: string;
  commit: string | null;
  built: string | null;
  profile: ToolsProfile;
}

/** What the connected server can do for this client, from one `version` and one `tools/list`. */
export interface Capabilities {
  engine: string;
  version: string;
  /** The surface spec version the server implements (`specs.surface`). */
  surface: string;
  profile: ToolsProfile;
  tools: string[];
  minimal: boolean;
  /** `apply` is listed. */
  canWrite: boolean;
  /** `plan` and `execute` are both listed. */
  canPlan: boolean;
}

// ---- errors -------------------------------------------------------------------------

/** The server's error envelope (spec/surface §4): `{ error, message, data?, retriable }`,
 * plus the tool that was called. `fix` is `data.fix` when the server offered a
 * literal corrected call. */
export class OmgError extends Error {
  readonly code: string;
  readonly data: unknown;
  readonly retriable: boolean;
  /** The tool whose call failed. */
  readonly tool: string | null;
  /** A corrected call to copy (`data.fix`), when the engine could compute one. */
  readonly fix: string | null;

  constructor(code: string, message: string, opts: { data?: unknown; retriable?: boolean; tool?: string } = {}) {
    super(message);
    this.name = "OmgError";
    this.code = code;
    this.data = opts.data;
    this.retriable = opts.retriable === true;
    this.tool = opts.tool ?? null;
    const fix = (opts.data as { fix?: unknown } | undefined)?.fix;
    this.fix = typeof fix === "string" ? fix : null;
  }
}

/** The provider has sent the browser to the authorization server (or needs to). */
export class AuthRequiredError extends Error {
  constructor(message = "sign-in required") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** Is this error the server saying it no longer knows our session? A 404 on
 * POST (`StreamableHTTPError.code`), or a proxy's `-32000 unknown session` body
 * relayed in the message. */
export function isSessionLost(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === 404) return true;
  return /unknown session/i.test(e.message) || /HTTP 404\b/.test(e.message);
}

/** The JSON-RPC `-32602 unknown tool <name>` a profile answers for a tool it does
 * not list — as the SDK's `McpError`, or as the `OmgError` `unknown_tool` this
 * client turns it into. */
export function isUnknownTool(e: unknown): boolean {
  if (e instanceof OmgError) return e.code === "unknown_tool";
  return e instanceof Error && /unknown tool\b/i.test(e.message);
}

export function isAuthRequired(e: unknown): boolean {
  return e instanceof AuthRequiredError || e instanceof UnauthorizedError;
}

/** The codes that mean "the world moved on; read again and re-plan". */
export const STALE_CODES: ReadonlySet<string> = new Set(["stale_plan", "plan_mismatch", "stale_expectation", "plan_unknown"]);

export function isStale(e: unknown): e is OmgError {
  return e instanceof OmgError && STALE_CODES.has(e.code);
}

export function isRepoNotFound(e: unknown): e is OmgError {
  return e instanceof OmgError && e.code === "repo_not_found";
}

export type ErrorClass = "transport" | "auth" | "capability" | "stale" | "write" | "query" | "unknown";

/** The server cannot do this at all: a hidden tool, an unknown repo, no embedding provider. */
const CAPABILITY_CODES: ReadonlySet<string> = new Set(["unknown_tool", "repo_not_found", "provider_unavailable", "embedder_failed", "unsupported_plan_version"]);
/** The request named or asked for something the server could not read or parse. */
const QUERY_CODES: ReadonlySet<string> = new Set(["filter_invalid", "budget_exceeded", "doc_missing", "block_missing", "target_missing", "revision_archived", "ambiguous_locator", "seed_unresolved"]);
/** The planner or the kernel refused a write (spec/mutate §8). */
const WRITE_CODES: ReadonlySet<string> = new Set([
  "conflicting_effects", "ambiguous_target", "selection_too_large", "cycle_move", "not_contiguous", "type_mismatch", "path_taken", "node_not_editable",
  "parent_missing", "plan_not_convergent", "sync_conflict", "ambiguous_heading", "block_not_container", "conflicted_document",
]);

/** One of seven classes a UI can act on. An `OmgError` classifies by its code, and
 * a read-shaped code raised by a write tool (a `set` on a missing document, a
 * malformed effect's `filter_invalid`) is `write`. Anything else that is an
 * `Error` and not the SDK's `McpError` is `transport`. */
export function classifyError(e: unknown): ErrorClass {
  if (isAuthRequired(e)) return "auth";
  if (isUnknownTool(e)) return "capability";
  if (isSessionLost(e)) return "transport";
  if (e instanceof OmgError) {
    if (STALE_CODES.has(e.code)) return "stale";
    if (CAPABILITY_CODES.has(e.code)) return "capability";
    const write = e.tool !== null && WRITE_TOOLS.has(e.tool);
    if (WRITE_CODES.has(e.code)) return "write";
    if (QUERY_CODES.has(e.code)) return write ? "write" : "query";
    return write ? "write" : "unknown";
  }
  if (e instanceof Error) return typeof (e as { code?: unknown }).code === "number" && /^MCP error/.test(e.message) ? "unknown" : "transport";
  return "unknown";
}

// ---- the client ---------------------------------------------------------------------

export interface OmgClientOptions {
  /** The MCP endpoint; a relative URL is made absolute against `baseUrl` (default: the page). */
  url: string;
  /** When set, a 401 runs the SDK's OAuth flow (discovery, DCR, PKCE, refresh). */
  authProvider?: OAuthClientProvider;
  /** The repo slug every repo-scoped call carries unless the call names its own. */
  repo?: string;
  /** How this client introduces itself at `initialize`. */
  clientInfo?: { name: string; version: string };
  /** The base a relative `url` resolves against (default `location.href` when there is one). */
  baseUrl?: string;
  /** Called once per recovered session (the server forgot ours; a fresh one was opened and the call retried). */
  onSessionLost?: (error: Error) => void;
  /** The transport to connect over (tests inject a fake; the default is the SDK's Streamable HTTP client). */
  transportFactory?: () => Transport;
}

export function absoluteServerUrl(url: string, base: string | undefined = typeof location === "undefined" ? undefined : location.href): string {
  return new URL(url, base).href;
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

export class OmgClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private caps: { generation: number; value: Promise<Capabilities> } | null = null;
  /** Bumped on every fresh session; the capabilities cache is keyed by it. */
  private generation = 0;
  /** How many times the server forgot our session and a fresh one was opened. */
  recoveries = 0;
  /** The default repo slug (`options.repo`); a call's own `repo` wins. */
  readonly repo: string | undefined;

  constructor(readonly options: Readonly<OmgClientOptions>) {
    this.repo = options.repo;
  }

  private transport(): Transport {
    if (this.options.transportFactory) return this.options.transportFactory();
    const { url, authProvider, baseUrl } = this.options;
    // The SDK types `sessionId?: string` on the class but `string` on the
    // interface; under exactOptionalPropertyTypes that needs a cast.
    return new StreamableHTTPClientTransport(new URL(absoluteServerUrl(url, baseUrl)), authProvider ? { authProvider } : {}) as unknown as Transport;
  }

  private async open(transport: Transport): Promise<Client> {
    const client = new Client(this.options.clientInfo ?? { name: "omgbase-client", version: "0.0.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
      throw e;
    }
    this.client = client;
    this.generation++;
    return client;
  }

  private session(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open(this.transport()).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Run `fn` over the connected client; when the server has forgotten the
   * session, open a fresh one and run it once more. 401s become AuthRequiredError. */
  private async withSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.session();
    try {
      return await fn(client);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
      if (!isSessionLost(e)) throw e;
      // Several calls may fail together: whoever is first drops the stale
      // client (and counts the recovery); the rest find it gone and share the
      // one reconnect.
      if (this.client === client) {
        this.client = null;
        void client.close().catch(() => undefined);
        this.recoveries++;
        this.options.onSessionLost?.(e);
      }
      const fresh = await this.session();
      try {
        return await fn(fresh);
      } catch (e2) {
        if (e2 instanceof UnauthorizedError) throw new AuthRequiredError(e2.message);
        throw e2;
      }
    }
  }

  /** Open the session now (every call opens it on demand; this surfaces auth/transport errors early). */
  async connect(): Promise<void> {
    await this.session();
  }

  /** Is a session open? */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Back from the authorization server: exchange the code, then connect. */
  async finishAuth(code: string): Promise<void> {
    const transport = this.transport() as StreamableHTTPClientTransport;
    await transport.finishAuth(code);
    await this.open(transport as unknown as Transport);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    this.caps = null;
    await c?.close().catch(() => undefined);
  }

  /** The `repo` argument of a call: the call's own slug, else the client's default; `null` omits it. */
  private repoArg(name: string, repo: RepoArg): Record<string, string> {
    if (!REPO_SCOPED_TOOLS.has(name) || repo === null) return {};
    const slug = repo ?? this.repo;
    return slug ? { repo: slug } : {};
  }

  /** Call a tool and decode omgbase's JSON-text envelope (`{ content: [{ text }] }`,
   * `isError` → the `{ error, message, data?, retriable }` body as `OmgError`).
   * A repo-scoped tool gets the client's default `repo` unless `args` names one
   * (`repo: null` omits it). A tool the profile hides is the JSON-RPC error
   * `unknown tool <name>`, surfaced as the `OmgError` `unknown_tool`. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { repo, ...rest } = args;
    const wire: Record<string, unknown> = { ...rest, ...this.repoArg(name, repo as RepoArg) };
    for (const k of Object.keys(wire)) if (wire[k] === undefined) delete wire[k];
    let result: ToolResult;
    try {
      result = await this.withSession((client) => client.callTool({ name, arguments: wire }) as Promise<ToolResult>);
    } catch (e) {
      if (isUnknownTool(e)) throw new OmgError("unknown_tool", `the server does not list the tool \`${name}\` (its tools profile hides it)`, { data: { tool: name }, tool: name });
      throw e;
    }
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (result.isError) {
      const b = (typeof body === "object" && body !== null ? body : {}) as { error?: string; message?: string; data?: unknown; retriable?: boolean };
      throw new OmgError(b.error ?? "error", b.message ?? text, { data: b.data, retriable: b.retriable === true, tool: name });
    }
    return body as T;
  }

  /** The tool names the server (or the gateway in front of it) lists — the profile's list. */
  async tools(): Promise<string[]> {
    const { tools } = await this.withSession((client) => client.listTools());
    return tools.map((t) => t.name);
  }

  /** `version` + `tools/list`, once per session (a recovered session asks again). */
  capabilities(): Promise<Capabilities> {
    const cached = this.caps;
    if (cached && cached.generation === this.generation && this.client) return cached.value;
    // The session the answer belongs to is known once it is open.
    const entry = { generation: this.client ? this.generation : -1, value: Promise.resolve<Capabilities>(null as never) };
    entry.value = (async () => {
      await this.session();
      entry.generation = this.generation;
      const [version, tools] = await Promise.all([this.version(), this.tools()]);
      return {
        engine: version.engine,
        version: version.version,
        surface: version.specs?.surface ?? "unknown",
        profile: version.profile,
        tools,
        minimal: version.profile === "minimal",
        canWrite: tools.includes("apply"),
        canPlan: tools.includes("plan") && tools.includes("execute"),
      };
    })();
    this.caps = entry;
    entry.value.catch(() => { if (this.caps === entry) this.caps = null; });
    return entry.value;
  }

  // ---- reads ---------------------------------------------------------------------

  query(query: string, opts: QueryOptions = {}): Promise<QueryResult> {
    return this.call<QueryResult>("query", { query, limit: opts.limit, cursor: opts.cursor ?? undefined, bare: opts.bare, repo: opts.repo });
  }

  /** Every hit, following the cursor (bounded by `max` rows). */
  async queryAll(query: string, opts: QueryAllOptions = {}): Promise<Hit[]> {
    const max = opts.max ?? 2000;
    const pageSize = opts.pageSize ?? 500;
    const out: Hit[] = [];
    let cursor: string | null = null;
    do {
      const page: QueryResult = await this.query(query, { limit: Math.min(pageSize, max - out.length), cursor, repo: opts.repo });
      out.push(...page.hits);
      cursor = page.truncated ? page.cursor : null;
    } while (cursor && out.length < max);
    return out;
  }

  /** The OQX reference card (no argument), one section by slug, or `all`. */
  querySyntax(section?: string): Promise<QuerySyntaxResult> {
    return this.call<QuerySyntaxResult>("query_syntax", { section });
  }

  /** One document, whole: `_raw` plus `properties { frontmatter, inline, computed }`; `includeIds` adds `ids`/`hashes`/`parents`. */
  docsRead(doc: DocLocator, opts: DocsReadOptions = {}): Promise<DocsReadResult> {
    return this.call<DocsReadResult>("docs_read", { ...doc, include_ids: opts.includeIds, repo: opts.repo });
  }

  /** The document as of revision `rev` (bytes only; `include_ids` is not available here). */
  docsReadAt(doc: DocLocator, rev: string, opts: { repo?: RepoArg } = {}): Promise<DocsReadAtResult> {
    return this.call<DocsReadAtResult>("docs_read", { ...doc, at: rev, repo: opts.repo });
  }

  docsTree(opts: DocsTreeOptions = {}): Promise<DocsTreeResult> {
    return this.call<DocsTreeResult>("docs_tree", {
      path: opts.path, depth: opts.depth, files: opts.files, updated: opts.updated, limit: opts.limit, cursor: opts.cursor ?? undefined, budget_tokens: opts.budgetTokens, repo: opts.repo,
    });
  }

  /** "The id of the thing I mean": a title or term ranked to blocks. The body is the bare array of hits. */
  blocksResolve(query: string, opts: { limit?: number; repo?: RepoArg } = {}): Promise<ResolveHit[]> {
    return this.call<ResolveHit[]>("blocks_resolve", { query, limit: opts.limit, repo: opts.repo });
  }

  changesSince(opts: ChangesSinceOptions = {}): Promise<ChangesSinceResult> {
    return this.call<ChangesSinceResult>("changes_since", { cursor: opts.cursor, epoch: opts.epoch, limit: opts.limit, origin: opts.origin, repo: opts.repo });
  }

  version(): Promise<VersionInfo> {
    return this.call<VersionInfo>("version", {});
  }

  // ---- writes --------------------------------------------------------------------

  /** Plan and commit in one call → the Receipt. */
  apply(req: ApplyRequest): Promise<Receipt> {
    return this.call<Receipt>("apply", { effects: req.effects, select: req.select, expect: req.expect, reason: req.reason, repo: req.repo });
  }

  /** The preview: a frozen Plan (`plan_id`, `preview.summary`, …) that commits nothing. */
  plan(req: PlanRequest): Promise<Plan> {
    return this.call<Plan>("plan", { effects: req.effects, select: req.select, expect: req.expect, diffs: req.diffs, repo: req.repo });
  }

  /** Commit a plan: by `plan_id` alone (the server's memory), as the Plan object, or `plan_id` + `effects` (the digest form). */
  execute(req: ExecuteRequest): Promise<Receipt> {
    const { reason, repo, ...form } = req;
    return this.call<Receipt>("execute", { ...form, reason, repo });
  }
}
