// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport
// (the dev proxy — the `webdevproxy` workspace package — or a remote gateway
// behind OAuth). Nothing here imports @omgbase/core.
//
// Session recovery: a Streamable HTTP server forgets a session (the proxy after
// `--idle` seconds without a request, or when it restarts; a gateway likewise)
// and answers the next POST with 404 — the spec's signal to start over with
// `initialize`. The SDK's client does not do that by itself, so `OmgClient`
// does: a call that fails with a lost session drops the client, opens a fresh
// one against the same URL and retries the call once (`isSessionLost`); only a
// second failure reaches the caller. `onSessionLost` lets the page say so.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** How the page reaches omgbase: the local bridge serving the sample, the local
 * bridge proxying (and signed in to) a remote, or the remote directly. */
export type McpMode = "local" | "proxy" | "direct";

export interface McpSettings {
  mode: McpMode;
  /** The bridge's MCP endpoint — a same-origin path through Vite's proxy by default. */
  bridgeUrl: string;
  /** The remote gateway, for direct mode (needs CORS on the gateway and web origins in Auth0). */
  directUrl: string;
  repo: string;
}

/** The server URL a mode uses, made absolute against the page (`/mcp` → `http://localhost:5173/mcp`). */
export function serverUrlFor(s: Pick<McpSettings, "mode" | "bridgeUrl" | "directUrl">, base?: string): string {
  return absoluteServerUrl(s.mode === "direct" ? s.directUrl : s.bridgeUrl, base);
}

export function absoluteServerUrl(url: string, base: string | undefined = typeof location === "undefined" ? undefined : location.href): string {
  return new URL(url, base).href;
}

export interface OmgClientOptions {
  url: string;
  /** When set, a 401 runs the MCP OAuth flow (discovery, DCR, PKCE, refresh);
   * the local proxy never answers 401, so it stays auth-free. */
  authProvider?: OAuthClientProvider;
  /** Called once per recovered session (the server forgot ours; a fresh one was opened and the call retried). */
  onSessionLost?: (error: Error) => void;
  /** The transport to connect over (tests inject a fake; the default is the SDK's Streamable HTTP client). */
  transportFactory?: () => Transport;
}

/** Is this error the server saying it no longer knows our session? A 404 on
 * POST (`StreamableHTTPError.code`), or the proxy's `-32000 unknown session`
 * body relayed in the message (`Error POSTing to endpoint: {"jsonrpc":"2.0",
 * "error":{"code":-32000,"message":"unknown session …"},"id":null}`). */
export function isSessionLost(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === 404) return true;
  return /unknown session/i.test(e.message) || /HTTP 404\b/.test(e.message);
}

export interface QueryResult {
  hits: Record<string, unknown>[];
  truncated: boolean;
  cursor: string | null;
  consumer: string;
  count?: number;
  exists?: boolean;
  none?: boolean;
  values?: unknown[];
}

export class OmgError extends Error {
  constructor(public code: string, message: string, public data?: unknown) {
    super(message);
  }
}

/** The provider has sent the browser to the authorization server (or needs to). */
export class AuthRequiredError extends Error {
  constructor(message = "sign-in required") {
    super(message);
  }
}

export class OmgClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** How many times the server forgot our session and a fresh one was opened. */
  recoveries = 0;

  constructor(readonly options: Readonly<OmgClientOptions>) {}

  private transport(): Transport {
    if (this.options.transportFactory) return this.options.transportFactory();
    const { url, authProvider } = this.options;
    // The SDK types `sessionId?: string` on the class but `string` on the
    // interface; under exactOptionalPropertyTypes that needs a cast.
    return new StreamableHTTPClientTransport(new URL(absoluteServerUrl(url)), authProvider ? { authProvider } : {}) as unknown as Transport;
  }

  private async open(transport: Transport): Promise<Client> {
    const client = new Client({ name: "omgbase-graph-ui", version: "0.0.0" });
    try {
      await client.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
      throw e;
    }
    this.client = client;
    return client;
  }

  /** Run `fn` over the connected client; when the server has forgotten the
   * session, open a fresh one and run it once more. 401s become AuthRequiredError. */
  private async withSession<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
      if (!isSessionLost(e)) throw e;
      // Several calls may fail together: whoever is first drops the stale
      // client; the rest find it gone and share the one reconnect.
      if (this.client === client) this.client = null;
      void client.close().catch(() => undefined);
      this.recoveries++;
      this.options.onSessionLost?.(e);
      const fresh = await this.connect();
      try {
        return await fn(fresh);
      } catch (e2) {
        if (e2 instanceof UnauthorizedError) throw new AuthRequiredError(e2.message);
        throw e2;
      }
    }
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open(this.transport()).finally(() => { this.connecting = null; });
    return this.connecting;
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
    await c?.close().catch(() => undefined);
  }

  /** Call a tool and decode omgbase's JSON-text envelope (`{content:[{text}]}`,
   * `isError` → the `{error, message}` body). */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
    const result = await this.withSession((client) => client.callTool({ name, arguments: args }) as Promise<ToolResult>);
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (result.isError) {
      const b = (body ?? {}) as { error?: string; message?: string; data?: unknown };
      throw new OmgError(b.error ?? "error", b.message ?? text, b.data);
    }
    return body as T;
  }

  repos(): Promise<{ repos: { slug: string; hasSource: boolean }[] }> {
    return this.call("repos", {});
  }

  /** The tool names the server (or the gateway in front of it) offers. */
  async tools(): Promise<string[]> {
    const { tools } = await this.withSession((client) => client.listTools());
    return tools.map((t) => t.name);
  }

  /** `docs_read`: `locator` is the document argument in the server's spelling
   * (lib/paths.ts `docLocator`: `{ id }`/`{ path }` on ≥ 3.0, `{ doc }` before);
   * the whole document as the server spells it — `{ id, path,
   * rev, properties, raw }` on surface ≥ 3.0, `{ path, docId, rev, properties,
   * content }` before (lib/shapes.ts `docReadOf` reads either); the demo uses
   * `properties.frontmatter`, the parsed fence, spelled the same on both. */
  docsRead(locator: Record<string, string>, repo?: string): Promise<Record<string, unknown> & { properties?: { frontmatter?: Record<string, unknown> } }> {
    return this.call("docs_read", { ...locator, ...(repo ? { repo } : {}) });
  }

  /** `docs_set_meta`: set and/or unset frontmatter keys on one document (its
   * argument from `docLocator`)
   * (re-ingested server-side; no CAS). The result is `{ id, path, committed }`
   * on ≥ 3.0, `{ docId, path, committed }` before (lib/shapes.ts `docOpOf`). */
  docsSetMeta(locator: Record<string, string>, patch: { set?: Record<string, unknown>; unset?: string[] }, repo?: string): Promise<Record<string, unknown>> {
    return this.call("docs_set_meta", { ...locator, ...patch, ...(repo ? { repo } : {}) });
  }

  version(): Promise<Record<string, unknown>> {
    return this.call("version", {});
  }

  async query(query: string, opts: { repo?: string; limit?: number } = {}): Promise<QueryResult> {
    const args: Record<string, unknown> = { query };
    if (opts.repo) args.repo = opts.repo;
    if (opts.limit !== undefined) args.limit = opts.limit;
    return this.call<QueryResult>("query", args);
  }

  /** Every hit, following the cursor (bounded by `max` rows). */
  async queryAll(query: string, opts: { repo?: string; max?: number } = {}): Promise<Record<string, unknown>[]> {
    const max = opts.max ?? 2000;
    const out: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const args: Record<string, unknown> = { query, limit: Math.min(500, max - out.length) };
      if (opts.repo) args.repo = opts.repo;
      if (cursor) args.cursor = cursor;
      const page: QueryResult = await this.call<QueryResult>("query", args);
      out.push(...page.hits);
      cursor = page.truncated ? page.cursor : null;
    } while (cursor && out.length < max);
    return out;
  }
}
