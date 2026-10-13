// An in-process stand-in for a remote MCP gateway behind OAuth, with its issuer
// on the same ephemeral port: the 401 + WWW-Authenticate, RFC 9728 / RFC 8414
// metadata, RFC 7591 registration, the token endpoint (code exchange, refresh
// with rotation) and a tiny JSON-RPC MCP endpoint behind the bearer check. The
// "browser" is a function that reads the authorization URL and answers the
// loopback itself. Knobs simulate a reset gateway: revoke tokens or clients,
// script the refresh answer, move the token endpoint. `fixedClient(id, port)` is
// an application created by hand in the tenant's dashboard (Auth0 Native app, no
// secret) whose one allowed callback URL is `http://127.0.0.1:<port>/callback`,
// compared exactly as Auth0 does (no port wildcard) — for `--client-id`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Hits { mcp: number; metadata: number; register: number; refresh: number; exchange: number; notFound: number }
/** One token request as the issuer saw it: the grant, the client and how it authenticated (`none` = `client_id` in the form alone — a public client). */
export interface TokenRequest { grant: string | null; clientId: string; auth: "none" | "basic" | "post"; redirectUri: string | null }
export interface Scripted { status: number; body: unknown; contentType?: string }
export type BrowserMode = "consent" | "decline" | "hang";
export interface FakeBrowser { (url: string): Promise<boolean>; opened: string[]; mode: BrowserMode }

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export class FakeGateway {
  readonly base: string;
  readonly serverUrl: string;
  readonly issuer: string;
  readonly clients = new Set<string>();
  readonly refreshTokens = new Set<string>();
  readonly accessTokens = new Set<string>();
  readonly codes = new Map<string, string>();
  readonly hits: Hits = { mcp: 0, metadata: 0, register: 0, refresh: 0, exchange: 0, notFound: 0 };
  /** Every token request in order. */
  readonly tokenRequests: TokenRequest[] = [];
  /** Clients created by hand, with the exact callback URLs the tenant allows them (Auth0 compares `redirect_uri` to the application's list verbatim). */
  readonly callbacks = new Map<string, string[]>();
  /** When set, every refresh is answered with this instead of the real logic. */
  refreshResponse: Scripted | null = null;
  /** When set, every registration is answered with this. */
  registerResponse: Scripted | null = null;
  /** The token endpoint's path; `moveTokenEndpoint()` changes it so cached metadata goes stale (the old path 404s with HTML). */
  tokenPath = "/issuer/token";
  private seq = 0;
  private sessions = 0;

  private constructor(private readonly server: Server, port: number) {
    this.base = `http://127.0.0.1:${port}`;
    this.serverUrl = `${this.base}/omg`;
    this.issuer = `${this.base}/issuer`;
  }

  static start(): Promise<FakeGateway> {
    return new Promise((resolve, reject) => {
      let gw: FakeGateway;
      const server = createServer((req, res) => { void gw.handle(req, res); });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        gw = new FakeGateway(server, (server.address() as AddressInfo).port);
        resolve(gw);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r()); });
  }

  /**
   * A pre-registered public client (what `--client-id` names): known to the issuer without any
   * registration call, allowed exactly one callback URL, `http://127.0.0.1:<callbackPort>/callback`,
   * and nothing else (Auth0 accepts no port wildcard). Returns the id.
   */
  fixedClient(id: string, callbackPort: number): string {
    this.clients.add(id);
    this.callbacks.set(id, [`http://127.0.0.1:${callbackPort}/callback`]);
    return id;
  }

  /** The identity provider forgot every token (refresh → `invalid_grant`); the gateway rejects every bearer. */
  revokeTokens(): void {
    this.refreshTokens.clear();
    this.accessTokens.clear();
  }

  /** The identity provider forgot every client registration too (refresh → `invalid_client`). */
  revokeClients(): void {
    this.clients.clear();
    this.revokeTokens();
  }

  /** The gateway rejects every bearer it issued so far (an access token expired); refresh tokens stay good. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  moveTokenEndpoint(): void {
    this.tokenPath = "/issuer/v2/token";
  }

  /** A code the token endpoint will exchange for `clientId` (what a consenting user's browser would carry back). */
  mintCode(clientId: string): string {
    const code = `code-${++this.seq}`;
    this.codes.set(code, clientId);
    return code;
  }

  /**
   * An `openBrowser` that behaves like a user at the identity provider: `consent`
   * answers the loopback with a code (asynchronously, as a browser would),
   * `decline` with `error=access_denied`, `hang` never answers. An unknown
   * client or a wrong authorization endpoint is an error page: `invalid_request`.
   */
  browser(mode: BrowserMode = "consent"): FakeBrowser {
    const opened: string[] = [];
    const fn = Object.assign(async (url: string): Promise<boolean> => {
      opened.push(url);
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri") ?? "";
      const state = u.searchParams.get("state") ?? "";
      const clientId = u.searchParams.get("client_id") ?? "";
      if (fn.mode === "hang") return true;
      let callback: string;
      if (u.pathname !== "/issuer/authorize") callback = `${redirect}?error=invalid_request&error_description=no+such+page&state=${state}`;
      else if (!this.clients.has(clientId)) callback = `${redirect}?error=invalid_request&error_description=unknown+client&state=${state}`;
      else if (this.callbacks.has(clientId) && !this.callbacks.get(clientId)!.includes(redirect)) callback = `${redirect}?error=invalid_request&error_description=callback+URL+mismatch&state=${state}`;
      else if (fn.mode === "decline") callback = `${redirect}?error=access_denied&error_description=the+user+declined&state=${state}`;
      else callback = `${redirect}?code=${this.mintCode(clientId)}&state=${state}`;
      void fetch(callback).then((r) => r.body?.cancel(), () => undefined);
      return true;
    }, { opened, mode });
    return fn;
  }

  private issueTokens(): Record<string, unknown> {
    const n = ++this.seq;
    this.accessTokens.add(`at-${n}`);
    this.refreshTokens.add(`rt-${n}`);
    return { access_token: `at-${n}`, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${n}`, scope: "openid offline_access" };
  }

  private scripted(res: ServerResponse, s: Scripted): void {
    res.writeHead(s.status, { "content-type": s.contentType ?? "application/json" });
    res.end(typeof s.body === "string" ? s.body : JSON.stringify(s.body));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource/omg" && req.method === "GET") {
      this.hits.metadata++;
      json(res, 200, { resource: this.serverUrl, authorization_servers: [this.issuer], scopes_supported: ["openid", "offline_access"], bearer_methods_supported: ["header"] });
      return;
    }
    if (path === "/.well-known/oauth-authorization-server/issuer" && req.method === "GET") {
      this.hits.metadata++;
      json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.base}${this.tokenPath}`,
        registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["openid", "offline_access"],
      });
      return;
    }
    if (path.startsWith("/.well-known/")) { json(res, 404, { error: "not_found" }); return; }
    if (path === "/issuer/register" && req.method === "POST") {
      this.hits.register++;
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      if (this.registerResponse) { this.scripted(res, this.registerResponse); return; }
      const client_id = `client-${++this.seq}`;
      this.clients.add(client_id);
      json(res, 201, { client_id, client_id_issued_at: Math.floor(Date.now() / 1000), ...body });
      return;
    }
    if (path === this.tokenPath && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type");
      const basic = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":")[0] : undefined;
      const clientId = basic ?? form.get("client_id") ?? "";
      this.tokenRequests.push({ grant, clientId, auth: basic !== undefined ? "basic" : form.has("client_secret") ? "post" : "none", redirectUri: form.get("redirect_uri") });
      if (grant === "refresh_token") {
        this.hits.refresh++;
        if (this.refreshResponse) { this.scripted(res, this.refreshResponse); return; }
        if (!this.clients.has(clientId)) { json(res, 401, { error: "invalid_client", error_description: "unknown client" }); return; }
        const rt = form.get("refresh_token") ?? "";
        if (!this.refreshTokens.has(rt)) { json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" }); return; }
        this.refreshTokens.delete(rt);
        json(res, 200, this.issueTokens());
        return;
      }
      if (grant === "authorization_code") {
        this.hits.exchange++;
        const code = form.get("code") ?? "";
        if (!this.clients.has(clientId)) { json(res, 401, { error: "invalid_client", error_description: "unknown client" }); return; }
        if (this.codes.get(code) !== clientId) { json(res, 400, { error: "invalid_grant", error_description: "unknown code" }); return; }
        this.codes.delete(code);
        json(res, 200, this.issueTokens());
        return;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (path === "/omg") {
      if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      this.hits.mcp++;
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const body = await readBody(req);
      if (!bearer || !this.accessTokens.has(bearer)) {
        json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/omg", scope="openid offline_access"` });
        return;
      }
      const msg = JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      const reply = (result: unknown, headers: Record<string, string> = {}) => json(res, 200, { jsonrpc: "2.0", id: msg.id, result }, headers);
      if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-gateway", version: "0.0.0" } }, { "mcp-session-id": `s-${++this.sessions}` });
      else if (msg.method === "tools/list") reply({ tools: [{ name: "ping", description: "pong", inputSchema: { type: "object" } }] });
      else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "pong" }] });
      else json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    this.hits.notFound++;
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<h1>Not Found</h1>");
  }
}

/** Poll until `pred` holds (every 10 ms, up to `ms`). */
export async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
