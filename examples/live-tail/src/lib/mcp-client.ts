// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport,
// through the dev proxy (the `webdevproxy` workspace package) at the same-origin
// `/mcp`. Nothing here imports @omgbase/core; there is no browser-side OAuth —
// the proxy signs in to a remote on the page's behalf (GET /whoami says how far
// it got).
//
// Session recovery: the proxy forgets a session after `--idle` seconds without
// a request or when it restarts, and answers the next POST with 404 `-32000
// unknown session` — the spec's cue to `initialize` again. The SDK's client
// does not, so `OmgClient` does: a lost session drops the client, opens a fresh
// one against the same URL and retries the call once (`isSessionLost`); only a
// second failure reaches the caller. Same helper as graph-ui's.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WhoAmI } from "webdevproxy";
/** A tool result as the server spelled it (lib/shapes.ts reads it per version). */
export type Wire = Record<string, unknown>;
/** A `changes_since` page on the wire: the digests are read per version, the paging keys did not change. */
export type ChangesSinceWire = { digests: Wire[]; cursor: number; truncated: boolean; head: number };

export interface OmgClientOptions {
  url: string;
  /** Called once per recovered session (the server forgot ours; a fresh one was opened and the call retried). */
  onSessionLost?: (error: Error) => void;
  /** The transport to connect over (tests inject a fake; the default is the SDK's Streamable HTTP client). */
  transportFactory?: () => Transport;
}

export interface QueryResult {
  hits: Record<string, unknown>[];
  truncated: boolean;
  cursor: string | null;
}

export class OmgError extends Error {
  constructor(public code: string, message: string, public data?: unknown) {
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

export function absoluteServerUrl(url: string, base: string | undefined = typeof location === "undefined" ? undefined : location.href): string {
  return new URL(url, base).href;
}

export class OmgClient {
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
      const client = new Client({ name: "omgbase-live-tail", version: "0.0.0" });
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

  version(): Promise<Record<string, unknown>> {
    return this.call("version", {});
  }

  query(query: string, repo: string, limit?: number): Promise<QueryResult> {
    return this.call<QueryResult>("query", { query, repo, ...(limit !== undefined ? { limit } : {}) });
  }

  // The four reads below return the server's wire shape untouched: surface
  // 3.0 spells a row `$id`/`$path`/`$hash`/`$updated_at`/`$raw` where 2.x had
  // `doc`/`docId`/`path`/`contentHash`/`ts`/`content` (spec/surface §3–§4), and
  // the page reads either through lib/shapes.ts by the connected version.

  changesSince(repo: string, cursor?: number, limit = 50): Promise<ChangesSinceWire> {
    return this.call<ChangesSinceWire>("changes_since", { repo, limit, ...(cursor !== undefined ? { cursor } : {}) });
  }

  // The document argument arrives spelled for the connected server
  // (lib/paths.ts `docLocator` / `docForeign`: `{ id }`/`{ path }` and
  // `{ doc_id }`/`{ doc_path }` on 3.0, `{ doc }` before — spec/surface §4).

  /** One document's version list (oldest → newest). */
  async docsHistory(locator: Record<string, string>, repo: string): Promise<Wire | null> {
    const r = await this.call<{ docs: Wire[] }>("docs_history", { ...locator, repo, include_deleted: true });
    return r.docs[0] ?? null;
  }

  diffUnified(foreign: Record<string, string>, fromRev: string, toRev: string, repo: string): Promise<Wire> {
    return this.call("diff_unified", { ...foreign, from_rev: fromRev, to_rev: toRev, repo });
  }

  docsReadAt(locator: Record<string, string>, rev: string, repo: string): Promise<Wire> {
    return this.call("docs_read_at", { ...locator, rev, repo });
  }
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
