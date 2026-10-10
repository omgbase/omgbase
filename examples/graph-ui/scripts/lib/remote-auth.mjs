// The bridge as an OAuth client (native app). Used by scripts/dev-mcp.mjs in
// --remote mode: the browser talks to the bridge on localhost without any
// auth; the bridge signs in to the remote omg MCP gateway the way Claude Code
// does —
//
//   401 + `WWW-Authenticate: Bearer resource_metadata=…`
//     → protected-resource metadata → the issuer's metadata        (SDK `auth()`)
//     → dynamic client registration, public client, PKCE          (SDK `auth()`)
//       with loopback redirect URIs http://127.0.0.1:<port>/callback
//     → the system browser opens the authorization URL once
//     → the loopback listener catches ?code=…&state=…
//     → code → tokens (`auth()` again with the code), persisted to a 0600 file
//     → later runs refresh silently (`offline_access` → refresh token);
//       a failed refresh re-runs the browser flow.
//
// Pure helpers (token-file path hashing, read/write, callback parsing) are
// exported for the tests; the network-touching parts take injectable `fetch`,
// `openBrowser` and `log`.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { callbackParams, identityFromTokens, normalizeServerUrl } from "../../src/lib/oauth-shared.mjs";

// ---- the token file -------------------------------------------------------------

export const APP_DIR_NAME = "omgbase-graph-ui";

/**
 * `$XDG_CONFIG_HOME` or `~/.config`, then our app directory.
 * @param {Record<string, string | undefined>} [env]
 */
export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), ".config");
  return join(base, APP_DIR_NAME);
}

/** The first 16 hex chars of sha256 over the normalized server URL. */
export function serverUrlHash(serverUrl) {
  return createHash("sha256").update(normalizeServerUrl(serverUrl)).digest("hex").slice(0, 16);
}

/**
 * Where the tokens for `serverUrl` live: `GRAPH_UI_TOKEN_FILE` wins, else
 * `<configDir>/<hash of url>.json`.
 * @param {string} serverUrl
 * @param {{ env?: Record<string, string | undefined>, dir?: string }} [opts]
 */
export function tokenFilePath(serverUrl, { env = process.env, dir } = {}) {
  if (env.GRAPH_UI_TOKEN_FILE && env.GRAPH_UI_TOKEN_FILE.trim()) return env.GRAPH_UI_TOKEN_FILE;
  return join(dir ?? configDir(env), `${serverUrlHash(serverUrl)}.json`);
}

/**
 * @typedef {object} TokenFile
 * @property {string} serverUrl
 * @property {number} [redirectPort]    the loopback port the client was registered with
 * @property {Record<string, unknown>} [clientInformation]   RFC 7591 client information (client_id, …)
 * @property {Record<string, unknown>} [tokens]              OAuth tokens (access_token, refresh_token, id_token, …)
 * @property {number} [tokensSavedAt]
 * @property {string} [codeVerifier]
 * @property {string} [state]
 * @property {Record<string, unknown>} [discovery]           the SDK's OAuthDiscoveryState
 */

/** @returns {TokenFile | null} null when absent or unreadable. */
export function readTokenFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes via temp + rename (atomic on POSIX), directory created, mode 0600. */
export function writeTokenFile(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** @returns {boolean} whether there was a file to delete */
export function deleteTokenFile(file) {
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return existed;
}

/** Every token file in the config dir (for `--logout` without a URL). */
export function listTokenFiles(dir = configDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
}

// ---- the loopback redirect ---------------------------------------------------------

export const CALLBACK_PATH = "/callback";

/** The redirect URIs we register for a loopback port: 127.0.0.1 first (RFC 8252 §7.3), then localhost. */
export function loopbackRedirectUrls(port) {
  return [`http://127.0.0.1:${port}${CALLBACK_PATH}`, `http://localhost:${port}${CALLBACK_PATH}`];
}

/**
 * Interpret a request to the loopback listener.
 * @param {string} requestUrl   the request's path + query (as `req.url`)
 * @param {string | undefined} expectedState   the state issued for the pending round trip
 * `error` ends the pending round trip (the user declined); `mismatch` (wrong or
 * missing `state`) is answered but leaves it pending — a stray or hostile
 * request to the loopback must not cancel the real sign-in (RFC 8252 §8.9).
 * @returns {{ kind: "code", code: string } | { kind: "error", status: number, message: string } | { kind: "mismatch" | "ignore", status: number, message: string }}
 */
export function parseLoopbackCallback(requestUrl, expectedState) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname !== CALLBACK_PATH) return { kind: "ignore", status: 404, message: "not found" };
  const cb = callbackParams(url);
  if (expectedState !== undefined && cb.state !== expectedState) return { kind: "mismatch", status: 400, message: "OAuth state mismatch — this callback does not belong to the pending sign-in" };
  if (cb.error) return { kind: "error", status: 400, message: `${cb.error}${cb.errorDescription ? `: ${cb.errorDescription}` : ""}` };
  if (!cb.code) return { kind: "error", status: 400, message: "the callback carried no authorization code" };
  return { kind: "code", code: cb.code };
}

const CALLBACK_PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font: 15px/1.5 system-ui, sans-serif; margin: 3em auto; max-width: 36em; color: #1e2430">
<h1 style="font-size: 18px">${title}</h1><p>${body}</p></body>`;

/**
 * Start the loopback listener. `port` 0 picks an ephemeral port. Returns the
 * bound port, the redirect URLs, and `waitForCallback(state)`; only one
 * round trip is pending at a time.
 */
export function startLoopback({ port = 0, host = "127.0.0.1" } = {}) {
  /** @type {{ state: string | undefined, resolve: (v: { code: string }) => void, reject: (e: Error) => void } | null} */
  let pending = null;
  const server = createServer((req, res) => {
    const outcome = parseLoopbackCallback(req.url ?? "/", pending?.state);
    if (outcome.kind === "ignore") {
      res.writeHead(outcome.status, { "content-type": "text/plain" });
      res.end(outcome.message);
      return;
    }
    if (!pending) {
      res.writeHead(409, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE("No sign-in in progress", "The bridge was not waiting for a sign-in. Reload the graph UI and try again."));
      return;
    }
    if (outcome.kind === "mismatch") {
      res.writeHead(outcome.status, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE("Not this sign-in", `${outcome.message}. The bridge is still waiting for the one it started.`));
      return;
    }
    const p = pending;
    pending = null;
    if (outcome.kind === "error") {
      res.writeHead(outcome.status, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE("Sign-in failed", `${outcome.message}. You can close this tab.`));
      p.reject(new Error(outcome.message));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CALLBACK_PAGE("Signed in", "The graph UI bridge has your authorization. You can close this tab and return to the page."));
    p.resolve({ code: outcome.code });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      resolve({
        port: bound,
        redirectUrls: loopbackRedirectUrls(bound),
        redirectUrl: loopbackRedirectUrls(bound)[0],
        /** @param {string | undefined} state */
        waitForCallback: (state) => new Promise((res, rej) => {
          if (pending) pending.reject(new Error("superseded by a newer sign-in"));
          pending = { state, resolve: res, reject: rej };
        }),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- the browser --------------------------------------------------------------------

/** `open` / `xdg-open` / `start`; resolves false when nothing could be spawned. */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
    : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

// ---- the provider -------------------------------------------------------------------

/**
 * `OAuthClientProvider` over a token file, with loopback redirect URIs. The
 * SDK's `auth()` drives it; `redirectToAuthorization` records the pending
 * round trip for `RemoteAuth` to finish and opens the browser (once).
 */
export class FileOAuthProvider {
  /**
   * @param {{ serverUrl: string, file: string, redirectUrls: string[], clientName?: string, log?: (m: string) => void,
   *   openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean }} opts
   */
  constructor({ serverUrl, file, redirectUrls, clientName = "omgbase graph UI (local bridge)", log = () => {}, openBrowser: open = openBrowser, noBrowser = false }) {
    this.serverUrl = serverUrl;
    this.file = file;
    this.redirectUrls = redirectUrls;
    this.clientName = clientName;
    this.log = log;
    this.open = open;
    this.noBrowser = noBrowser;
    /** @type {{ url: string, state: string | undefined } | null} the authorization the user has yet to complete */
    this.pending = null;
  }

  /** @returns {TokenFile} */
  read() {
    return readTokenFile(this.file) ?? { serverUrl: this.serverUrl };
  }

  /** Merge into the file; an explicit `undefined` deletes the key. */
  patch(p) {
    const merged = { ...this.read(), ...p, serverUrl: this.serverUrl };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    writeTokenFile(this.file, merged);
  }

  get redirectUrl() {
    return this.redirectUrls[0];
  }

  /** A public client (PKCE, no secret), registered dynamically; the SDK fills `scope` from `scopes_supported`. */
  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: this.redirectUrls,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    const state = randomBytes(16).toString("base64url");
    this.patch({ state });
    return state;
  }

  clientInformation() {
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation) {
    this.patch({ clientInformation });
  }

  tokens() {
    return this.read().tokens;
  }

  saveTokens(tokens) {
    this.patch({ tokens, tokensSavedAt: Date.now() });
  }

  saveCodeVerifier(codeVerifier) {
    this.patch({ codeVerifier });
  }

  codeVerifier() {
    const v = this.read().codeVerifier;
    if (!v) throw new Error("no PKCE code verifier saved — start the sign-in again");
    return v;
  }

  saveDiscoveryState(discovery) {
    this.patch({ discovery });
  }

  discoveryState() {
    return this.read().discovery;
  }

  invalidateCredentials(scope) {
    switch (scope) {
      case "all": this.patch({ clientInformation: undefined, tokens: undefined, tokensSavedAt: undefined, codeVerifier: undefined, state: undefined, discovery: undefined }); return;
      case "client": this.patch({ clientInformation: undefined }); return;
      case "tokens": this.patch({ tokens: undefined, tokensSavedAt: undefined }); return;
      case "verifier": this.patch({ codeVerifier: undefined }); return;
      case "discovery": this.patch({ discovery: undefined }); return;
    }
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = authorizationUrl.href;
    this.pending = { url, state: this.read().state };
    this.log(`sign-in required for ${this.serverUrl}`);
    const issuer = this.read().discovery?.authorizationServerUrl;
    if (issuer) this.log(`issuer: ${issuer}`);
    this.log(`open this URL in your browser if it does not open by itself:`);
    this.log(`  ${url}`);
    if (!this.noBrowser) {
      const opened = await this.open(url);
      if (!opened) this.log("could not launch a browser; use the URL above");
    }
    this.log(`waiting for the sign-in to finish (listening on ${this.redirectUrl})…`);
  }

  identity() {
    return identityFromTokens(this.tokens());
  }
}

// ---- orchestration ---------------------------------------------------------------

/**
 * One remote per bridge: owns the loopback listener, the provider, and the
 * sign-in state the bridge reports on /whoami. `authorize(response)` is the
 * serialized "we got a 401" handler the forwarding fetch calls.
 */
export class RemoteAuth {
  /**
   * @param {{ serverUrl: string, file?: string, log?: (m: string) => void, fetch?: typeof globalThis.fetch,
   *   openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean }} opts
   */
  constructor({ serverUrl, file, log = () => {}, fetch: fetchFn = globalThis.fetch, openBrowser: open = openBrowser, noBrowser = false }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.file = file ?? tokenFilePath(serverUrl);
    this.log = log;
    this.fetch = fetchFn;
    this.open = open;
    this.noBrowser = noBrowser;
    /** @type {{ state: "unknown" | "ok" | "waiting" | "error", issuer?: string, authorizationUrl?: string, error?: string }} */
    this.status = { state: "unknown" };
    this.inflight = null;
    this.resourceMetadataUrl = undefined;
    this.scope = undefined;
  }

  async start() {
    const stored = readTokenFile(this.file);
    const wantPort = stored?.clientInformation && stored.redirectPort ? stored.redirectPort : 0;
    this.loopback = await startLoopback({ port: wantPort }).catch((e) => {
      if (wantPort && e?.code === "EADDRINUSE") return startLoopback({ port: 0 });
      throw e;
    });
    this.provider = new FileOAuthProvider({
      serverUrl: this.serverUrl, file: this.file, redirectUrls: this.loopback.redirectUrls,
      log: this.log, openBrowser: this.open, noBrowser: this.noBrowser,
    });
    if (wantPort && this.loopback.port !== wantPort) {
      // The registered redirect URIs name the old port; register afresh.
      this.log(`loopback port ${wantPort} is busy — using ${this.loopback.port} and re-registering the client`);
      this.provider.invalidateCredentials("client");
    }
    this.provider.patch({ redirectPort: this.loopback.port });
    return this;
  }

  async close() {
    await this.loopback?.close();
  }

  bearer() {
    return this.provider?.tokens()?.access_token;
  }

  identity() {
    return this.provider?.identity() ?? null;
  }

  issuer() {
    return this.provider?.discoveryState()?.authorizationServerUrl;
  }

  /**
   * Make sure we hold tokens the gateway accepts, signing in if needed. Sends
   * the request a browser would send first (an unauthenticated `initialize`)
   * so discovery starts from the gateway's own 401.
   */
  async ensure() {
    const res = await this.fetch(this.serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omgbase-graph-ui-bridge", version: "0.0.0" } } }),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 401) {
      // No auth in front of this server: nothing to do (and nothing to keep of the probe's session).
      const sid = res.headers.get("mcp-session-id");
      if (sid) await this.fetch(this.serverUrl, { method: "DELETE", headers: { "mcp-session-id": sid } }).then((r) => r.body?.cancel(), () => undefined);
      this.status = { state: "ok" };
      return;
    }
    await this.authorize(res);
  }

  /**
   * A 401 came back: refresh or sign in, once, no matter how many callers
   * arrive while it is in progress.
   * @param {Response | undefined} response   the 401 (its WWW-Authenticate seeds discovery)
   */
  authorize(response) {
    this.inflight ??= this.run(response).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async run(response) {
    if (response) {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      if (resourceMetadataUrl) this.resourceMetadataUrl = resourceMetadataUrl;
      if (scope) this.scope = scope;
    }
    const opts = { serverUrl: this.serverUrl, resourceMetadataUrl: this.resourceMetadataUrl, scope: this.scope, fetchFn: this.fetch };
    try {
      let result = await auth(this.provider, opts);
      if (result === "REDIRECT") {
        const pending = this.provider.pending;
        this.status = { state: "waiting", issuer: this.issuer(), authorizationUrl: pending?.url };
        const { code } = await this.loopback.waitForCallback(pending?.state);
        this.provider.pending = null;
        this.provider.patch({ state: undefined });
        result = await auth(this.provider, { ...opts, authorizationCode: code });
      }
      if (result !== "AUTHORIZED") throw new Error(`authorization ended in ${result}`);
      const who = this.identity();
      this.log(`signed in to ${this.serverUrl}${who ? ` as ${who.email ?? who.name ?? who.subject}` : ""} (tokens in ${this.file})`);
      this.status = { state: "ok", issuer: this.issuer() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.provider.pending = null;
      this.status = { state: "error", issuer: this.issuer(), error: message };
      this.log(`sign-in failed${this.issuer() ? ` (issuer ${this.issuer()})` : ""}: ${message}`);
      throw e;
    }
  }

  /**
   * A `fetch` for the upstream transport: adds the bearer token, and on a 401
   * (expired, revoked, first run) authorizes — refresh, else the browser flow
   * — then retries once.
   */
  fetchWithAuth() {
    return async (input, init = {}) => {
      const attempt = () => {
        const headers = new Headers(init.headers ?? {});
        const token = this.bearer();
        if (token) headers.set("authorization", `Bearer ${token}`);
        return this.fetch(input, { ...init, headers });
      };
      const first = await attempt();
      if (first.status !== 401) return first;
      await first.body?.cancel().catch(() => undefined);
      await this.authorize(first);
      return attempt();
    };
  }

  /** `--logout`: forget everything about this server. */
  logout() {
    return deleteTokenFile(this.file);
  }
}
