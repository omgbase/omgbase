// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport
// (the dev bridge in scripts/dev-mcp.mjs, or a remote gateway behind OAuth).
// Nothing here imports @omgbase/core.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpSettings {
  url: string;
  repo: string;
}

export interface OmgClientOptions {
  url: string;
  /** When set, a 401 runs the MCP OAuth flow (discovery, DCR, PKCE, refresh);
   * the local bridge never answers 401, so it stays auth-free. */
  authProvider?: OAuthClientProvider;
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

  constructor(readonly options: Readonly<OmgClientOptions>) {}

  private transport(): StreamableHTTPClientTransport {
    const { url, authProvider } = this.options;
    return new StreamableHTTPClientTransport(new URL(url), authProvider ? { authProvider } : {});
  }

  private async open(transport: StreamableHTTPClientTransport): Promise<Client> {
    const client = new Client({ name: "omgbase-graph-ui", version: "0.0.0" });
    try {
      // The SDK types `sessionId?: string` on the class but `string` on the
      // interface; under exactOptionalPropertyTypes that needs a cast.
      await client.connect(transport as unknown as Transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
      throw e;
    }
    this.client = client;
    return client;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open(this.transport()).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Back from the authorization server: exchange the code, then connect. */
  async finishAuth(code: string): Promise<void> {
    const transport = this.transport();
    await transport.finishAuth(code);
    await this.open(transport);
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
    const client = await this.connect();
    let result: { content?: { type: string; text?: string }[]; isError?: boolean };
    try {
      result = (await client.callTool({ name, arguments: args })) as typeof result;
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new AuthRequiredError(e.message);
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
