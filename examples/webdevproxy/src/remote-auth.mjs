// The proxy as an OAuth client (native app). Used in --remote mode: the browser
// talks to the proxy on localhost without any auth; the proxy signs in to the
// remote MCP gateway the way Claude Code does —
//
//   401 + `WWW-Authenticate: Bearer resource_metadata=…`
//     → protected-resource metadata → the issuer's metadata        (SDK `auth()`)
//     → dynamic client registration, public client, PKCE          (SDK `auth()`)
//       with loopback redirect URIs http://127.0.0.1:<port>/callback
//     → the system browser opens the authorization URL once
//     → the loopback listener catches ?code=…&state=…
//     → code → tokens (`auth()` again with the code), persisted to a 0600 file
//     → later runs refresh silently (`offline_access` → refresh token);
//       a refresh the issuer refuses (the gateway or its identity provider was
//       reset; the refresh token or the client registration revoked) drops the
//       dead part of the file — and the cached discovery — and re-runs the
//       browser flow by itself, once per 401 round (`RemoteAuth.run`); `--logout`
//       is only for switching accounts or servers.
//
// Pure helpers (token-file path hashing, read/write, the legacy graph-ui file
// fallback, callback parsing) are exported for the tests; the network-touching
// parts take injectable `fetch`, `openBrowser` and `log`.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { callbackParams, identityFromTokens, normalizeServerUrl } from "./oauth-shared.mjs";

// ---- the token file -------------------------------------------------------------

export const APP_DIR_NAME = "omgbase-webdevproxy";
/** Where the graph-ui bridge kept its tokens before the proxy was extracted; read (and copied) so nobody signs in twice. */
export const LEGACY_APP_DIR_NAME = "omgbase-graph-ui";
export const TOKEN_FILE_ENV = "WEBDEVPROXY_TOKEN_FILE";

/**
 * `$XDG_CONFIG_HOME` or `~/.config`, then the app directory.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [appDir]
 */
export function configDir(env = process.env, appDir = APP_DIR_NAME) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(env.HOME ?? homedir(), ".config");
  return join(base, appDir);
}

/** The graph-ui bridge's config dir (pre-extraction), for the fallback. */
export function legacyConfigDir(env = process.env) {
  return configDir(env, LEGACY_APP_DIR_NAME);
}

/** The first 16 hex chars of sha256 over the normalized server URL. */
export function serverUrlHash(serverUrl) {
  return createHash("sha256").update(normalizeServerUrl(serverUrl)).digest("hex").slice(0, 16);
}

/**
 * Where the tokens for `serverUrl` live: `WEBDEVPROXY_TOKEN_FILE` wins, else
 * `<configDir>/<hash of url>.json`.
 * @param {string} serverUrl
 * @param {{ env?: Record<string, string | undefined>, dir?: string }} [opts]
 */
export function tokenFilePath(serverUrl, { env = process.env, dir } = {}) {
  const override = env[TOKEN_FILE_ENV];
  if (override && override.trim()) return override;
  return join(dir ?? configDir(env), `${serverUrlHash(serverUrl)}.json`);
}

/**
 * The graph-ui bridge's token file for the same server (same hash, old dir).
 * @param {string} serverUrl
 * @param {{ env?: Record<string, string | undefined>, dir?: string }} [opts]
 */
export function legacyTokenFilePath(serverUrl, { env = process.env, dir } = {}) {
  return join(dir ?? legacyConfigDir(env), `${serverUrlHash(serverUrl)}.json`);
}

/**
 * When `file` is absent and `legacyFile` holds a readable token file, copy it
 * into place (mode 0600). The legacy file is left alone, so an older graph-ui
 * checkout keeps working. Returns true when a copy was made.
 * @param {string} file
 * @param {string} legacyFile
 */
export function migrateLegacyTokenFile(file, legacyFile) {
  if (existsSync(file) || file === legacyFile) return false;
  const data = readTokenFile(legacyFile);
  if (!data) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  copyFileSync(legacyFile, file);
  chmodSync(file, 0o600);
  return true;
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

/** Every token file in a config dir (for `--logout` without a URL). */
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

/** `error.name` of the rejection a cancelled round trip ends with: the sign-in was superseded, not failed. */
export const SIGN_IN_CANCELLED = "SignInCancelled";
/** `error.name` of RemoteAuth's abort of a browser flow built on cached issuer metadata the token endpoint just failed to honour. */
export const STALE_DISCOVERY = "StaleDiscovery";

/** An Error with a `name` the callers switch on. */
function tagged(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const CALLBACK_PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font: 15px/1.5 system-ui, sans-serif; margin: 3em auto; max-width: 36em; color: #1e2430">
<h1 style="font-size: 18px">${title}</h1><p>${body}</p></body>`;

/**
 * Start the loopback listener. `port` 0 picks an ephemeral port. Returns the
 * bound port, the redirect URLs, `waitForCallback(state)` and `cancel(reason)`
 * (rejects the pending round trip with a `SignInCancelled` error); only one
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
      res.end(CALLBACK_PAGE("No sign-in in progress", "The proxy was not waiting for a sign-in. Reload the page and try again."));
      return;
    }
    if (outcome.kind === "mismatch") {
      res.writeHead(outcome.status, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE("Not this sign-in", `${outcome.message}. The proxy is still waiting for the one it started.`));
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
    res.end(CALLBACK_PAGE("Signed in", "The local dev proxy has your authorization. You can close this tab and return to the page."));
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
          if (pending) pending.reject(tagged(SIGN_IN_CANCELLED, "superseded by a newer sign-in"));
          pending = { state, resolve: res, reject: rej };
        }),
        /** @param {string} reason */
        cancel: (reason) => {
          if (!pending) return false;
          const p = pending;
          pending = null;
          p.reject(tagged(SIGN_IN_CANCELLED, reason));
          return true;
        },
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
   *   openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean,
   *   onRedirect?: (pending: { url: string, state: string | undefined }) => void | Promise<void> }} opts
   *   `onRedirect` runs before the browser opens (RemoteAuth registers its loopback waiter there); it may throw to abort the redirect.
   */
  constructor({ serverUrl, file, redirectUrls, clientName = "omgbase webdevproxy (local dev proxy)", log = () => {}, openBrowser: open = openBrowser, noBrowser = false, onRedirect = undefined }) {
    this.serverUrl = serverUrl;
    this.file = file;
    this.redirectUrls = redirectUrls;
    this.clientName = clientName;
    this.log = log;
    this.open = open;
    this.noBrowser = noBrowser;
    this.onRedirect = onRedirect;
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

  /**
   * The SDK's `auth()` calls this with `"all"` when the issuer answers `invalid_client` /
   * `unauthorized_client` and with `"tokens"` on `invalid_grant`, then retries; `RemoteAuth`
   * calls it for the rejections the SDK does not recover from. Dropping tokens drops the
   * cached discovery too: an issuer that refuses what we stored may well have moved
   * (the gateway upgraded), and the next `auth()` rediscovers from the 401's
   * `WWW-Authenticate` at the cost of two GETs.
   */
  invalidateCredentials(scope) {
    switch (scope) {
      case "all": this.patch({ clientInformation: undefined, tokens: undefined, tokensSavedAt: undefined, codeVerifier: undefined, state: undefined, discovery: undefined }); return;
      case "client": this.patch({ clientInformation: undefined }); return;
      case "tokens": this.patch({ tokens: undefined, tokensSavedAt: undefined, discovery: undefined }); return;
      case "verifier": this.patch({ codeVerifier: undefined }); return;
      case "discovery": this.patch({ discovery: undefined }); return;
    }
  }

  async redirectToAuthorization(authorizationUrl) {
    const url = authorizationUrl.href;
    const pending = { url, state: this.read().state };
    await this.onRedirect?.(pending);
    this.pending = pending;
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
 * One remote per proxy: owns the loopback listener, the provider, and the
 * sign-in state the proxy reports on /whoami. `authorize(response)` is the
 * serialized "we got a 401" handler the forwarding fetch calls.
 *
 * Recovery (the stored sign-in is dead — the gateway or its identity provider
 * was reset, the refresh token or the client registration revoked):
 *
 *   • `invalid_grant` on the refresh → the SDK's `auth()` itself drops the tokens
 *     (our provider drops the cached discovery with them) and starts the browser
 *     flow; `invalid_client` / `unauthorized_client` → it drops everything and
 *     re-registers first. We only notice (log, `recovered`).
 *   • any other refusal the SDK gives up on — another OAuth error code, or a
 *     400/401 from the token endpoint (→ tokens) or the registration endpoint
 *     (→ all), or a token endpoint that no longer answers like one while we
 *     worked from cached metadata (→ discovery) — is handled here: clear that
 *     part of the file, run `auth()` once more. Only when that also fails does
 *     the status become `error`.
 *
 * One recovery per 401 round; a failure inside the browser flow (the user
 * declined, the code exchange failed) is a failed sign-in, not a dead credential,
 * and is never retried by itself.
 */
export class RemoteAuth {
  /**
   * @param {{ serverUrl: string, file?: string, legacyFile?: string | null, log?: (m: string) => void, fetch?: typeof globalThis.fetch,
   *   openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean, env?: Record<string, string | undefined> }} opts
   */
  constructor({ serverUrl, file, legacyFile, log = () => {}, fetch: fetchFn = globalThis.fetch, openBrowser: open = openBrowser, noBrowser = false, env = process.env }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.file = file ?? tokenFilePath(serverUrl, { env });
    // The graph-ui bridge's file for the same server, unless the caller named a file of its own.
    this.legacyFile = legacyFile === undefined ? (file ? null : legacyTokenFilePath(serverUrl, { env })) : legacyFile;
    this.log = log;
    this.fetch = fetchFn;
    this.open = open;
    this.noBrowser = noBrowser;
    /** @type {{ state: "unknown" | "ok" | "waiting" | "error", issuer?: string, authorizationUrl?: string, error?: string, recovered?: true, recoveredAt?: string }} */
    this.status = { state: "unknown" };
    /** @type {((status: RemoteAuth["status"]) => void)[]} */
    this.listeners = [];
    this.inflight = null;
    this.resourceMetadataUrl = undefined;
    this.scope = undefined;
    /** @type {string | undefined} when a dead stored sign-in was last replaced by a fresh one, by itself */
    this.recoveredAt = undefined;
    /**
     * What the issuer answered during the current `auth()` pass (see `authFetch`).
     * @type {{ rejection: { endpoint: "token" | "registration", status: number, grant?: string, code?: string, description?: string } | null, discovered: boolean }}
     */
    this.observed = { rejection: null, discovered: false };
    /** @type {"stored" | "browser"} where the current pass is: still on the stored credential, or in the browser flow */
    this.phase = "stored";
    /** @type {Promise<{ code: string }> | null} the loopback waiter the redirect hook registered */
    this.callback = null;
    this.authFetch = this.authFetch.bind(this);
  }

  async start() {
    if (this.legacyFile && migrateLegacyTokenFile(this.file, this.legacyFile)) {
      this.log(`copied the graph-ui bridge's tokens from ${this.legacyFile} to ${this.file}`);
    }
    const stored = readTokenFile(this.file);
    const wantPort = stored?.clientInformation && stored.redirectPort ? stored.redirectPort : 0;
    this.loopback = await startLoopback({ port: wantPort }).catch((e) => {
      if (wantPort && e?.code === "EADDRINUSE") return startLoopback({ port: 0 });
      throw e;
    });
    this.provider = new FileOAuthProvider({
      serverUrl: this.serverUrl, file: this.file, redirectUrls: this.loopback.redirectUrls,
      log: this.log, openBrowser: this.open, noBrowser: this.noBrowser,
      onRedirect: (pending) => this.onRedirect(pending),
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

  /** Set the status and tell the listeners (the terminal prompt prints its hint on `waiting` / `error`). */
  setStatus(status) {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  /** Subscribe to status changes; returns the unsubscribe. */
  onStatus(listener) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  okStatus() {
    return { state: "ok", issuer: this.issuer(), ...(this.recoveredAt ? { recovered: true, recoveredAt: this.recoveredAt } : {}) };
  }

  /**
   * Make sure we hold tokens the gateway accepts, signing in if needed. Sends
   * the request a browser would send first (an unauthenticated `initialize`)
   * so discovery starts from the gateway's own 401. A stored sign-in the
   * issuer rejects goes through the same recovery as one rejected later.
   */
  async ensure() {
    const res = await this.fetch(this.serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omgbase-webdevproxy", version: "0.0.0" } } }),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 401) {
      // No auth in front of this server: nothing to do (and nothing to keep of the probe's session).
      const sid = res.headers.get("mcp-session-id");
      if (sid) await this.fetch(this.serverUrl, { method: "DELETE", headers: { "mcp-session-id": sid } }).then((r) => r.body?.cancel(), () => undefined);
      this.setStatus({ state: "ok" });
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

  /**
   * The `fetch` handed to the SDK's `auth()`: the upstream fetch, plus a note of
   * what the issuer answered — a refused token or registration request (status,
   * the OAuth `error` when the body is one) and whether metadata was
   * (re)discovered on the way — so `run` can tell a dead stored credential from
   * a failed sign-in. Bodies are read from a clone; the SDK still gets its own.
   */
  async authFetch(input, init) {
    const res = await this.fetch(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/")) this.observed.discovered = true;
    if (!res.ok) {
      const body = init?.body;
      const endpoint = body instanceof URLSearchParams ? "token" : typeof body === "string" && body.includes('"redirect_uris"') ? "registration" : null;
      if (endpoint) {
        /** @type {NonNullable<RemoteAuth["observed"]["rejection"]>} */
        const rejection = { endpoint, status: res.status };
        if (body instanceof URLSearchParams) rejection.grant = body.get("grant_type") ?? undefined;
        try {
          const parsed = await res.clone().json();
          if (parsed && typeof parsed.error === "string") {
            rejection.code = parsed.error;
            if (typeof parsed.error_description === "string") rejection.description = parsed.error_description;
          }
        } catch {
          // not an OAuth error body (an HTML 404 after the issuer moved, say)
        }
        this.observed.rejection = rejection;
      }
    }
    return res;
  }

  /**
   * The provider is about to send the user to the authorization server.
   * Register the loopback waiter first, so an answer can never arrive before
   * anyone listens — unless the flow is built on cached issuer metadata whose
   * token endpoint just answered the refresh with something that is neither an
   * OAuth error nor a 400/401 (a 404 after the issuer moved, say): the SDK would
   * carry on to a stale authorization endpoint; abort before the browser opens
   * and rediscover. A bare 400/401 is the token being refused, not the issuer moving.
   */
  onRedirect(pending) {
    const r = this.observed.rejection;
    if (r && r.endpoint === "token" && r.grant === "refresh_token" && !r.code && r.status !== 400 && r.status !== 401 && !this.observed.discovered) {
      throw tagged(STALE_DISCOVERY, `the stored token endpoint answered HTTP ${r.status} to the refresh`);
    }
    const waiter = this.loopback.waitForCallback(pending.state);
    waiter.catch(() => undefined); // handled where it is awaited
    this.callback = waiter;
  }

  async run(response) {
    if (response) {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      if (resourceMetadataUrl) this.resourceMetadataUrl = resourceMetadataUrl;
      if (scope) this.scope = scope;
    }
    const opts = { serverUrl: this.serverUrl, resourceMetadataUrl: this.resourceMetadataUrl, scope: this.scope, fetchFn: this.authFetch };
    const stored = this.provider.read();
    const hadTokens = Boolean(stored.tokens);
    const hadCredential = hadTokens || Boolean(stored.clientInformation);
    try {
      let recovered = false;
      try {
        recovered = (await this.attempt(opts, hadTokens)) && hadTokens;
      } catch (e) {
        // A stored credential the issuer refused before any browser flow began: drop the dead part and sign in afresh, once.
        const dead = hadCredential && this.phase === "stored" ? this.deadCredential(e) : null;
        if (!dead) throw e;
        if (dead.scope === "discovery") this.log(`stored issuer metadata for ${this.serverUrl} is stale (${dead.reason}); rediscovering`);
        else this.log(`stored sign-in for ${this.serverUrl} was rejected (${dead.reason}); signing in again`);
        this.provider.invalidateCredentials(dead.scope);
        recovered = (await this.attempt(opts, false)) || dead.scope !== "discovery";
      }
      if (recovered) this.recoveredAt = new Date().toISOString();
      const who = this.identity();
      this.log(`signed in${recovered ? " again" : ""} to ${this.serverUrl}${who ? ` as ${who.email ?? who.name ?? who.subject}` : ""} (tokens in ${this.file})`);
      this.setStatus(this.okStatus());
    } catch (e) {
      this.provider.pending = null;
      if (e instanceof Error && e.name === SIGN_IN_CANCELLED) throw e; // superseded by a fresh sign-in, which reports for itself
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: "error", issuer: this.issuer(), error: message });
      this.log(`sign-in failed${this.issuer() ? ` (issuer ${this.issuer()})` : ""}: ${message}`);
      throw e;
    }
  }

  /**
   * One pass of the SDK's `auth()`, plus the loopback round trip when it
   * redirects. Resolves to whether the browser flow ran; when it did while we
   * held tokens, the SDK found the stored refresh token dead (and already
   * dropped it), which is logged here.
   */
  async attempt(opts, hadTokens) {
    this.observed = { rejection: null, discovered: false };
    this.phase = "stored";
    let result = await auth(this.provider, opts);
    const redirected = result === "REDIRECT";
    if (redirected) {
      this.phase = "browser";
      if (hadTokens) this.log(`stored sign-in for ${this.serverUrl} was rejected (${this.describeRejection() ?? "no usable refresh token"}); signing in again`);
      const pending = this.provider.pending;
      const callback = this.callback;
      this.callback = null;
      if (!callback) throw new Error("the sign-in redirect registered no loopback waiter");
      this.setStatus({ state: "waiting", issuer: this.issuer(), authorizationUrl: pending?.url });
      const { code } = await callback;
      this.provider.pending = null;
      this.provider.patch({ state: undefined });
      result = await auth(this.provider, { ...opts, authorizationCode: code });
    }
    if (result !== "AUTHORIZED") throw new Error(`authorization ended in ${result}`);
    return redirected;
  }

  /**
   * Does this failure of the stored credential mean it is dead, and which part?
   *   invalid_client / unauthorized_client, or a 400/401 from the registration endpoint → "all"
   *   invalid_grant, or a 400/401 from the token endpoint                               → "tokens" (which drops discovery too)
   *   a token endpoint that no longer answers like one, on cached metadata             → "discovery"
   * Anything else (the issuer unreachable or 5xx, a malformed metadata document) is not.
   * @returns {{ scope: "all" | "tokens" | "discovery", reason: string } | null}
   */
  deadCredential(e) {
    if (e instanceof Error && e.name === STALE_DISCOVERY) return { scope: "discovery", reason: e.message };
    const r = this.observed.rejection;
    const code = e instanceof OAuthError ? e.errorCode : r?.code;
    const reason = this.describeRejection() ?? (e instanceof Error ? e.message : String(e));
    if (code === "invalid_client" || code === "unauthorized_client") return { scope: "all", reason };
    if (code === "invalid_grant") return { scope: "tokens", reason };
    if (r && (r.status === 400 || r.status === 401)) return { scope: r.endpoint === "registration" ? "all" : "tokens", reason };
    return null;
  }

  describeRejection() {
    const r = this.observed.rejection;
    if (!r) return undefined;
    return r.code ? `${r.code}${r.description ? `: ${r.description}` : ""}` : `HTTP ${r.status} from the ${r.endpoint} endpoint`;
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

  /**
   * The terminal's escape hatch (src/prompt.mjs). Without `forget` (`a`): a
   * sign-in that is `waiting` is re-opened — the URL printed again, the browser
   * launched again — and nothing else changes; otherwise the tokens are dropped
   * (the client registration kept) and a fresh authorization starts. With
   * `forget` (`l`): the token file is deleted first — `--logout` without a
   * restart — so the client is registered anew. A sign-in still pending is
   * superseded, not failed.
   */
  async reauthorize({ forget = false } = {}) {
    if (!forget && this.status.state === "waiting" && this.provider.pending && this.inflight) {
      const { url } = this.provider.pending;
      this.log(`open this URL in your browser to finish the sign-in:`);
      this.log(`  ${url}`);
      if (!this.noBrowser && !(await this.open(url))) this.log("could not launch a browser; use the URL above");
      return this.inflight;
    }
    if (this.inflight) {
      this.loopback.cancel("superseded by a fresh sign-in");
      await this.inflight.catch(() => undefined);
    }
    if (forget) {
      this.log(`forgetting the tokens for ${this.serverUrl} (${this.file}) — signing in fresh`);
      this.logout();
      this.provider.patch({ redirectPort: this.loopback.port });
    } else {
      this.log(`dropping the tokens for ${this.serverUrl} — signing in again`);
      this.provider.invalidateCredentials("tokens");
    }
    return this.authorize(undefined);
  }

  /** `--logout`: forget everything about this server. */
  logout() {
    return deleteTokenFile(this.file);
  }
}
