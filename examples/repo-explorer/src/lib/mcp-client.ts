// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport,
// through the dev proxy (the `webdevproxy` workspace package) at the same-origin
// `/mcp`. Nothing here imports @omgbase/core; there is no browser-side OAuth —
// the proxy signs in to a remote on the page's behalf (GET /whoami says how far
// it got). Copied from examples/live-tail/src/lib/mcp-client.ts (which follows
// graph-ui's), with the tool spellings moved out: every feature module names
// the tool it calls through the `Caller` interface below, so a test can script
// the server and assert the exact calls.
//
// Session recovery: the proxy forgets a session after `--idle` seconds without
// a request or when it restarts, and answers the next POST with 404 `-32000
// unknown session` — the spec's cue to `initialize` again. The SDK's client
// does not, so `OmgClient` does: a lost session drops the client, opens a fresh
// one against the same URL and retries the call once (`isSessionLost`); only a
// second failure reaches the caller.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WhoAmI } from "webdevproxy";

/** A tool result as the server spelled it (each feature module coerces its own). */
export type Wire = Record<string, unknown>;

/** What a feature module needs of the client: one tool call. `OmgClient`
 * implements it; tests pass a scripted table. */
export interface Caller {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface OmgClientOptions {
  url: string;
  /** Called once per recovered session (the server forgot ours; a fresh one was opened and the call retried). */
  onSessionLost?: (error: Error) => void;
  /** The transport to connect over (tests inject a fake; the default is the SDK's Streamable HTTP client). */
  transportFactory?: () => Transport;
}

/** The server's error envelope (spec/surface §4): `{ error, message, data?, retriable }`. */
export class OmgError extends Error {
  constructor(public code: string, message: string, public data?: unknown, public retriable = false) {
    super(message);
  }
}

/** Is this error the server saying it no longer knows our session? A 404 on
 * POST (`StreamableHTTPError.code`), or the proxy's `-32000 unknown session`
 * body relayed in the message. */
export function isSessionLost(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === 404) return true;
  return /unknown session/i.test(e.message) || /HTTP 404\b/.test(e.message);
}

/** Is this the JSON-RPC `-32602 unknown tool <name>` a profile answers for a
 * tool it does not list (spec/surface §4 "Profiles")? The SDK raises it as an
 * `McpError` whose message carries the text. */
export function isUnknownTool(e: unknown): boolean {
  return e instanceof Error && /unknown tool\b/i.test(e.message);
}

export function absoluteServerUrl(url: string, base: string | undefined = typeof location === "undefined" ? undefined : location.href): string {
  return new URL(url, base).href;
}

export class OmgClient implements Caller {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** How many times the server forgot our session and a fresh one was opened. */
  recoveries = 0;

  constructor(readonly options: Readonly<OmgClientOptions>) {}

  private transport(): Transport {
    if (this.options.transportFactory) return this.options.transportFactory();
    // The SDK types `sessionId?: string` on the class but `string` on the
    // interface; under exactOptionalPropertyTypes that needs a cast.
    return new StreamableHTTPClientTransport(new URL(absoluteServerUrl(this.options.url))) as unknown as Transport;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new Client({ name: "omgbase-repo-explorer", version: "0.0.0" });
      await client.connect(this.transport());
      this.client = client;
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Run `fn` over the connected client; when the server has forgotten the
   * session, open a fresh one and run it once more. */
  private async withSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (e) {
      if (!isSessionLost(e)) throw e;
      // Several calls may fail together: whoever is first drops the stale
      // client; the rest find it gone and share the one reconnect.
      if (this.client === client) this.client = null;
      void client.close().catch(() => undefined);
      this.recoveries++;
      this.options.onSessionLost?.(e);
      return fn(await this.connect());
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    await c?.close().catch(() => undefined);
  }

  /** Call a tool and decode omgbase's JSON-text envelope (`{content:[{text}]}`,
   * `isError` → the `{error, message, data, retriable}` body). A tool the
   * profile does not list is the JSON-RPC error `unknown tool <name>`, surfaced
   * as an `OmgError` with code `unknown_tool`. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
    let result: ToolResult;
    try {
      result = await this.withSession((client) => client.callTool({ name, arguments: args }) as Promise<ToolResult>);
    } catch (e) {
      if (isUnknownTool(e)) throw new OmgError("unknown_tool", `the server does not list the tool \`${name}\` (its tools profile hides it)`, { tool: name });
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
      const b = (body ?? {}) as { error?: string; message?: string; data?: unknown; retriable?: boolean };
      throw new OmgError(b.error ?? "error", b.message ?? text, b.data, b.retriable === true);
    }
    return body as T;
  }

  /** The tool names the server (or the gateway in front of it) offers — the
   * profile's list (spec/surface §4 "Profiles"); every feature detection starts here. */
  async tools(): Promise<string[]> {
    const { tools } = await this.withSession((client) => client.listTools());
    return tools.map((t) => t.name);
  }

  /** `apply`: plan and commit effects in one call (spec/surface §4; after
   * graph-ui's). The one write this page makes without a preview is a task
   * checkbox toggle — a single `set _attrs.checked` pinned to the block's hash
   * (lib/tasks.ts). The result is the Receipt `{ plan_id, commit, revisions:
   * [{ _id, _path, _hash }], new_ids, committed, summary }`. */
  apply(effects: Record<string, unknown>[], opts: ApplyOptions = {}): Promise<Wire> {
    return this.call<Wire>("apply", applyArgs(effects, opts));
  }
}

export interface ApplyOptions {
  /** The repo slug; omitted (or empty/null) ⇒ the server's default. */
  repo?: string | null;
  /** The commit's reason (the revision's `_reason`). */
  reason?: string;
}

/** The arguments of an `apply` call: `{ effects, reason?, repo? }` — a key only when it has a value. */
export function applyArgs(effects: Record<string, unknown>[], opts: ApplyOptions = {}): Record<string, unknown> {
  return { effects, ...(opts.reason ? { reason: opts.reason } : {}), ...repoArg(opts.repo) };
}

/** `apply` over any `Caller` (the feature modules take a Caller, not the client). */
export async function applyEffects(caller: Caller, effects: Record<string, unknown>[], opts: ApplyOptions = {}): Promise<Wire> {
  return caller.call<Wire>("apply", applyArgs(effects, opts));
}

/** The proxy's status endpoint for an MCP endpoint URL: same origin, path `/whoami`. */
export function whoamiUrl(mcpUrl: string, base?: string): string {
  const u = new URL(mcpUrl, base);
  u.pathname = "/whoami";
  u.search = "";
  u.hash = "";
  return u.href;
}

export async function fetchWhoAmI(mcpUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<WhoAmI> {
  const res = await fetchFn(whoamiUrl(mcpUrl, typeof location === "undefined" ? undefined : location.href), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`whoami: HTTP ${res.status}`);
  return (await res.json()) as WhoAmI;
}

/** The repo argument, spelled only when a repo is chosen (omitted ⇒ the server's default repo). */
export function repoArg(repo: string | null | undefined): Record<string, string> {
  return repo ? { repo } : {};
}
