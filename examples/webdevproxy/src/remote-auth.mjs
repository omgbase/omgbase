// The proxy as an OAuth client (native app). Used in --remote mode: the browser
// talks to the proxy on localhost without any auth; the proxy signs in to the
// remote MCP gateway the way Claude Code does —
//
//   401 + `WWW-Authenticate: Bearer resource_metadata=…`
//     → protected-resource metadata → the issuer's metadata        (SDK `auth()`)
//     → dynamic client registration, public client, PKCE          (SDK `auth()`)
//       with loopback redirect URIs http://127.0.0.1:<port>/callback — or, with
//       `--client-id`, no registration at all: the configured public client is
//       presented as-is and the issuer's registration endpoint is never called
//     → a registration kept from an earlier run is presented again only when it
//       was made with this issuer and names this loopback port, and — right
//       before the browser opens — the token endpoint still knows it (a gateway
//       restarted with a fresh state directory answers `invalid_client`; its
//       authorize page would say "Unknown client" and never redirect back to
//       us, so we ask first); otherwise the client is registered anew
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
import { DEFAULT_CALLBACK_PORT } from "./args.mjs";

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
 * @property {string} [clientIssuer]    the authorization server `clientInformation` was registered with (its `discovery.authorizationServerUrl` at the time)
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
/** Appended to the failure when the issuer's dynamic registration is capped (Auth0 `too_many_entities`: the tenant is full of auto-registered clients). */
export const TOO_MANY_ENTITIES_HINT = "the issuer's application limit is full — delete stale auto-registered clients in the tenant's dashboard, then press a + Enter";
/** `error.name` of the failure when the issuer's token endpoint rejects a `--client-id` (`invalid_client` / `unauthorized_client`): a configuration error, never recovered from by registering. */
export const CONFIGURED_CLIENT_REJECTED = "ConfiguredClientRejected";
/** Appended to a rejected `--client-id` when the issuer's metadata advertises a `registration_endpoint`: the proxy could register one by itself. */
export const REGISTER_INSTEAD_HINT = "the issuer advertises a registration endpoint — drop --client-id / WEBDEVPROXY_CLIENT_ID and the proxy registers a client by itself";
/**
 * The failure message for a configured client id the issuer does not accept.
 * @param {string} clientId
 * @param {string} [code]
 * @param {boolean} [canRegister]   the issuer advertises dynamic registration (RFC 7591)
 */
export function configuredClientRejected(clientId, code = "invalid_client", canRegister = false) {
  return `the configured client id ${clientId} was rejected by the issuer (${code}) — check WEBDEVPROXY_CLIENT_ID / --client-id against the tenant's application${canRegister ? `; ${REGISTER_INSTEAD_HINT}` : ""}`;
}
/** `error.name` of the pre-browser check's verdict: the token endpoint does not know the stored client registration (the gateway was reset, or started with a fresh state directory). Recovered by registering anew. */
export const CLIENT_UNKNOWN = "ClientUnknown";
/** The bogus refresh token the pre-browser check sends: the answer we want is about the client, not the token. */
export const REGISTRATION_CHECK_TOKEN = "webdevproxy-registration-check";
/**
 * The reason logged when a stored registration is unknown to the issuer.
 * @param {string} clientId
 * @param {string} issuer
 * @param {string} code
 */
export function clientUnknown(clientId, issuer, code) {
  return `the client registration ${clientId} is unknown to ${issuer} (${code}: the gateway was reset or started with a fresh state directory)`;
}
/**
 * The loopback port a registration's `redirect_uris` name (ours are `http://127.0.0.1:<port>/callback`), or undefined when they say nothing usable.
 * @param {Record<string, unknown> | undefined} clientInformation
 * @returns {number | undefined}
 */
export function registeredPort(clientInformation) {
  const uris = clientInformation?.redirect_uris;
  if (!Array.isArray(uris)) return undefined;
  for (const u of uris) {
    try {
      const port = Number(new URL(String(u)).port);
      if (port) return port;
    } catch {
      // not a URL
    }
  }
  return undefined;
}
/**
 * Whether a registration's `redirect_uris` allow `redirectUrl`; a registration without a list (an older file) is given the benefit of the doubt.
 * @param {Record<string, unknown> | undefined} clientInformation
 * @param {string} redirectUrl
 */
export function registrationAllows(clientInformation, redirectUrl) {
  const uris = clientInformation?.redirect_uris;
  return !Array.isArray(uris) || uris.includes(redirectUrl);
}
/** The start-up failure when a fixed callback port (`--callback-port`, or the `--client-id` default) is taken: another port would not match the application's allowed callback URL. */
export function callbackPortInUse(port) {
  return `callback port ${port} is in use — the sign-in redirect must be exactly http://127.0.0.1:${port}/callback (the application's allowed callback URL), so another port will not do; free the port, or pick one with --callback-port <n> / WEBDEVPROXY_CALLBACK_PORT and allow http://127.0.0.1:<n>/callback on the application`;
}

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

/** Two issuer URLs name the same authorization server (a trailing slash apart); null when either is not a URL. */
function sameIssuer(a, b) {
  try {
    return normalizeServerUrl(a) === normalizeServerUrl(b);
  } catch {
    return null;
  }
}

/**
 * `OAuthClientProvider` over a token file, with loopback redirect URIs. The
 * SDK's `auth()` drives it; `redirectToAuthorization` records the pending
 * round trip for `RemoteAuth` to finish and opens the browser (once).
 *
 * With a configured `clientId` (`--client-id`) the provider presents that
 * public client — `{ client_id, token_endpoint_auth_method: "none" }`, no
 * secret — whatever the file holds, so the SDK skips RFC 7591 registration and
 * goes straight to PKCE authorization. The id is configuration, not state: it
 * is never written to the file (`saveClientInformation` stores nothing — the
 * SDK never calls it when `clientInformation()` answers), `invalidateCredentials`
 * cannot drop it, and a `clientInformation` a run without the flag left in the
 * file is neither read nor touched (it is that mode's registration).
 *
 * A dynamic registration is kept with the issuer it was made with
 * (`clientIssuer`); when the server's discovery now names another
 * authorization server (the gateway changed its identity provider), it is
 * dropped and the SDK registers with the new one instead of presenting a
 * client id the new issuer never minted.
 */
export class FileOAuthProvider {
  /**
   * @param {{ serverUrl: string, file: string, redirectUrls: string[], clientId?: string | null, clientName?: string, log?: (m: string) => void,
   *   openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean,
   *   onRedirect?: (pending: { url: string, state: string | undefined }) => void | Promise<void> }} opts
   *   `onRedirect` runs before the browser opens (RemoteAuth registers its loopback waiter there); it may throw to abort the redirect.
   */
  constructor({ serverUrl, file, redirectUrls, clientId = null, clientName = "omgbase webdevproxy (local dev proxy)", log = () => {}, openBrowser: open = openBrowser, noBrowser = false, onRedirect = undefined }) {
    this.serverUrl = serverUrl;
    this.file = file;
    this.redirectUrls = redirectUrls;
    /** @type {string | null} the pre-registered public client to present instead of registering one */
    this.clientId = clientId || null;
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

  /**
   * The configured public client when there is one (no secret → the SDK authenticates with
   * `client_id` alone), else the file's registration — unless that was made with another
   * authorization server than the one discovery now names, in which case it is dropped (the
   * SDK saves the discovery state before asking, so this compares like with like).
   */
  clientInformation() {
    if (this.clientId) return { client_id: this.clientId, token_endpoint_auth_method: "none" };
    const { clientInformation, clientIssuer, discovery } = this.read();
    if (!clientInformation) return undefined;
    const issuer = discovery?.authorizationServerUrl;
    if (clientIssuer && typeof issuer === "string" && sameIssuer(clientIssuer, issuer) === false) {
      this.log(`the client registration ${String(clientInformation.client_id)} for ${this.serverUrl} was made with ${clientIssuer}, not ${issuer} — registering anew`);
      this.patch({ clientInformation: undefined, clientIssuer: undefined });
      return undefined;
    }
    return clientInformation;
  }

  /** The registration the SDK just made, kept with the issuer that made it. Unreachable with a configured client (the SDK registers only when `clientInformation()` is empty); stores nothing then, so the file never claims a registration that is not in use. */
  saveClientInformation(clientInformation) {
    if (this.clientId) return;
    const issuer = this.read().discovery?.authorizationServerUrl;
    this.patch({ clientInformation, clientIssuer: typeof issuer === "string" ? issuer : undefined });
    this.log(`registered client ${String(clientInformation.client_id)} with ${typeof issuer === "string" ? issuer : "the issuer"} for ${this.serverUrl}`);
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
   * `WWW-Authenticate` at the cost of two GETs. With a configured client id,
   * `"all"` drops the tokens and the discovery and `"client"` nothing: the id
   * is configuration (and a registration left in the file by a run without the
   * flag is not ours to drop).
   */
  invalidateCredentials(scope) {
    switch (scope) {
      case "all": this.patch({ ...(this.clientId ? {} : { clientInformation: undefined, clientIssuer: undefined }), tokens: undefined, tokensSavedAt: undefined, codeVerifier: undefined, state: undefined, discovery: undefined }); return;
      case "client": if (!this.clientId) this.patch({ clientInformation: undefined, clientIssuer: undefined }); return;
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
 *   • a registration the issuer no longer knows while we hold NO tokens (the
 *     normal state after `a`, or a gateway reset between the registration and
 *     the consent) never reaches the token endpoint: the SDK would send the
 *     browser to the authorize page, which shows "Unknown client" and redirects
 *     nowhere. So before the browser opens with a registration the issuer did
 *     not just make, `verifyRegistration` asks the token endpoint about the
 *     client (a refresh with a bogus token: `invalid_client` means unknown;
 *     `invalid_grant` or anything else means the client is fine) and an unknown
 *     one is dropped and registered anew in the same round.
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
   * @param {{ serverUrl: string, file?: string, legacyFile?: string | null, clientId?: string | null, callbackPort?: number | null, resetClient?: boolean, log?: (m: string) => void,
   *   fetch?: typeof globalThis.fetch, openBrowser?: (url: string) => Promise<boolean>, noBrowser?: boolean, env?: Record<string, string | undefined> }} opts
   *   `clientId` (`--client-id` / `WEBDEVPROXY_CLIENT_ID`): present this pre-registered public client; never register one.
   *   `callbackPort` (`--callback-port` / `WEBDEVPROXY_CALLBACK_PORT`): bind the loopback listener there; null = ephemeral,
   *   or `DEFAULT_CALLBACK_PORT` with a client id (the application's allowed callback URL names an exact port).
   *   `resetClient` (`--reset-client`): drop the stored client registration (and the tokens issued to it) at start-up.
   */
  constructor({ serverUrl, file, legacyFile, clientId = null, callbackPort = null, resetClient = false, log = () => {}, fetch: fetchFn = globalThis.fetch, openBrowser: open = openBrowser, noBrowser = false, env = process.env }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.file = file ?? tokenFilePath(serverUrl, { env });
    /** @type {string | null} the configured public client, else null (dynamic registration) */
    this.clientId = clientId || null;
    /** `--reset-client`: forget the stored client registration at start-up and register anew */
    this.resetClient = Boolean(resetClient);
    /** @type {number | null} the fixed loopback port, else null (ephemeral) */
    this.callbackPort = callbackPort ?? (this.clientId ? DEFAULT_CALLBACK_PORT : null);
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
     * @type {{ rejection: { endpoint: "token" | "registration", status: number, grant?: string, code?: string, description?: string, errorCode?: string } | null, discovered: boolean, registered: boolean }}
     *   `registered`: the issuer accepted a registration in this pass (so the client about to be presented is fresh, not stored)
     */
    this.observed = { rejection: null, discovered: false, registered: false };
    /** @type {"stored" | "browser"} where the current pass is: still on the stored credential, or in the browser flow */
    this.phase = "stored";
    /** @type {Promise<{ code: string }> | null} the loopback waiter the redirect hook registered */
    this.callback = null;
    /** @type {string | undefined} what the SDK's `auth()` last resolved to in this pass, for a failure message */
    this.lastResult = undefined;
    this.authFetch = this.authFetch.bind(this);
  }

  async start() {
    if (this.legacyFile && migrateLegacyTokenFile(this.file, this.legacyFile)) {
      this.log(`copied the graph-ui bridge's tokens from ${this.legacyFile} to ${this.file}`);
    }
    const stored = readTokenFile(this.file);
    // A fixed callback port (`--callback-port`, or the `--client-id` default) is the application's allowed
    // callback URL: taken means an error, never another port. Otherwise a registered client's port is
    // reused when free — the one its redirect URIs name (`redirectPort` only for a file without them),
    // since a run with `--client-id` rewrites `redirectPort` without touching the registration — else
    // any ephemeral port.
    const fixed = this.callbackPort;
    const registration = this.clientId || this.resetClient ? undefined : stored?.clientInformation;
    const wantPort = fixed ?? (registration ? registeredPort(registration) ?? stored?.redirectPort ?? 0 : 0);
    this.loopback = await startLoopback({ port: wantPort }).catch((e) => {
      if (e?.code === "EADDRINUSE") {
        if (fixed) throw new Error(callbackPortInUse(fixed));
        if (wantPort) return startLoopback({ port: 0 });
      }
      throw e;
    });
    this.provider = new FileOAuthProvider({
      serverUrl: this.serverUrl, file: this.file, redirectUrls: this.loopback.redirectUrls, clientId: this.clientId,
      log: this.log, openBrowser: this.open, noBrowser: this.noBrowser,
      onRedirect: (pending) => this.onRedirect(pending),
    });
    if (this.clientId) this.log(`using the configured client id ${this.clientId} (no dynamic registration)`);
    if (fixed) this.log(`sign-in callback fixed at ${this.loopback.redirectUrl} — the application's allowed callback URL`);
    if (this.resetClient) {
      this.resetRegistration("--reset-client");
    } else if (registration && !registrationAllows(registration, this.loopback.redirectUrl)) {
      // The registered redirect URIs name another port (it is busy, or the registration predates a `--client-id` run); register afresh.
      const busy = wantPort && this.loopback.port !== wantPort ? ` (port ${wantPort} is busy)` : "";
      this.log(`the client registration ${String(registration.client_id)} names ${Array.isArray(registration.redirect_uris) ? registration.redirect_uris.join(", ") : "other redirect URIs"}, not ${this.loopback.redirectUrl}${busy} — registering anew`);
      this.provider.invalidateCredentials("client");
    }
    this.provider.patch({ redirectPort: this.loopback.port });
    if (!this.clientId) {
      const { clientInformation, clientIssuer } = this.provider.read();
      if (clientInformation) this.log(`presenting the client registration ${String(clientInformation.client_id)} for ${this.serverUrl}${clientIssuer ? ` (registered with ${clientIssuer})` : ""}`);
      else this.log(`no client registration for ${this.serverUrl} yet — one is registered with the issuer at the first sign-in`);
    }
    return this;
  }

  /**
   * Forget the stored client registration — and the tokens it was issued, which no other client can
   * use — so the next `auth()` registers anew (`--reset-client`, the terminal's `r`). With a configured
   * client id there is no registration to forget: the id lives on the issuer's side; the tokens go, the
   * hint says how to let the proxy register instead. Returns whether a registration was dropped.
   * @param {string} why   what asked for it, for the log
   */
  resetRegistration(why) {
    if (this.clientId) {
      this.log(`the client id ${this.clientId} is configured (--client-id / WEBDEVPROXY_CLIENT_ID), not registered — ${why} has no registration to forget; dropping the tokens instead (${REGISTER_INSTEAD_HINT})`);
      this.provider.invalidateCredentials("tokens");
      return false;
    }
    const id = this.provider.read().clientInformation?.client_id;
    if (id === undefined) this.log(`no client registration for ${this.serverUrl} to forget (${why}) — registering`);
    else this.log(`forgetting the client registration ${String(id)} for ${this.serverUrl} (${why}) — registering anew`);
    this.provider.invalidateCredentials("all");
    return id !== undefined;
  }

  /** The issuer's metadata advertises dynamic registration (RFC 7591). */
  advertisesRegistration() {
    return typeof this.provider?.discoveryState()?.authorizationServerMetadata?.registration_endpoint === "string";
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
   * Which OAuth client the proxy presents (for `/whoami`): the configured one, or the
   * registration in the file (`id: null` before the first registration). Ids are public.
   * @returns {{ source: "configured" | "registered", id: string | null }}
   */
  client() {
    if (this.clientId) return { source: "configured", id: this.clientId };
    const id = this.provider?.read().clientInformation?.client_id;
    return { source: "registered", id: typeof id === "string" ? id : null };
  }

  /** Set the status and tell the listeners (the terminal prompt prints its hint on `waiting` / `error`). */
  setStatus(status) {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  /**
   * Subscribe to status changes; returns the unsubscribe.
   * @param {(status: RemoteAuth["status"]) => void} listener
   */
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
    const body = init?.body;
    const endpoint = body instanceof URLSearchParams ? "token" : typeof body === "string" && body.includes('"redirect_uris"') ? "registration" : null;
    if (endpoint === "registration" && res.ok) this.observed.registered = true;
    if (!res.ok) {
      if (endpoint) {
        /** @type {NonNullable<RemoteAuth["observed"]["rejection"]>} */
        const rejection = { endpoint, status: res.status };
        if (body instanceof URLSearchParams) rejection.grant = body.get("grant_type") ?? undefined;
        try {
          const parsed = await res.clone().json();
          if (parsed && typeof parsed === "object") {
            // RFC 6749 `error` / `error_description`; Auth0's management-style bodies say `error: "Forbidden", message, errorCode`.
            if (typeof parsed.error === "string") rejection.code = parsed.error;
            const description = typeof parsed.error_description === "string" ? parsed.error_description : typeof parsed.message === "string" ? parsed.message : undefined;
            if (description) rejection.description = description;
            if (typeof parsed.errorCode === "string") rejection.errorCode = parsed.errorCode;
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
   *
   * Nor when the token endpoint just rejected the configured client id itself
   * (`invalid_client` / `unauthorized_client`): the SDK's answer to that is
   * "drop everything, register anew" — which, with the id configured, is the same
   * id again in a browser tab. The id is wrong or deleted on the tenant; say so.
   *
   * Nor with a stored registration the issuer no longer knows: the authorize
   * page would show "Unknown client" and never call the loopback (RFC 6749
   * §4.1.2.1 forbids redirecting on an invalid client id), so the pass would
   * wait forever. `verifyRegistration` asks the token endpoint first; an unknown
   * client aborts here as `CLIENT_UNKNOWN` and `run` registers anew.
   */
  async onRedirect(pending) {
    const r = this.observed.rejection;
    if (r && r.endpoint === "token" && r.grant === "refresh_token" && !r.code && r.status !== 400 && r.status !== 401 && !this.observed.discovered) {
      throw tagged(STALE_DISCOVERY, `the stored token endpoint answered HTTP ${r.status} to the refresh`);
    }
    if (this.clientId && r && r.endpoint === "token" && (r.code === "invalid_client" || r.code === "unauthorized_client")) {
      throw tagged(CONFIGURED_CLIENT_REJECTED, configuredClientRejected(this.clientId, r.code, this.advertisesRegistration()));
    }
    if (!this.clientId && !this.observed.registered) await this.verifyRegistration();
    const waiter = this.loopback.waitForCallback(pending.state);
    waiter.catch(() => undefined); // handled where it is awaited
    this.callback = waiter;
  }

  /**
   * Is the stored client registration still known to the issuer? A refresh request with a bogus
   * token, `client_id` alone (our registrations are public clients): the token endpoint answers
   * `invalid_client` for a client it does not know (RFC 6749 §5.2) before it looks at the token, and
   * `invalid_grant` for one it does. Only those two OAuth codes are a verdict; anything else — a 5xx,
   * a network error, a non-OAuth body — teaches nothing and the browser flow goes ahead as before.
   * One request, only before a browser round trip with a registration this pass did not make.
   * @throws a `CLIENT_UNKNOWN` error when the issuer does not know the client
   */
  async verifyRegistration() {
    const info = this.provider.read().clientInformation;
    const discovery = this.provider.discoveryState();
    const tokenEndpoint = discovery?.authorizationServerMetadata?.token_endpoint;
    const clientId = info?.client_id;
    if (typeof clientId !== "string" || typeof tokenEndpoint !== "string") return;
    let code;
    try {
      const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: REGISTRATION_CHECK_TOKEN, client_id: clientId });
      if (typeof info.client_secret === "string" && info.token_endpoint_auth_method !== "none") form.set("client_secret", info.client_secret);
      const res = await this.fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, signal: AbortSignal.timeout(10_000) });
      const parsed = res.ok ? null : await res.json().catch(() => null);
      code = parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : undefined;
    } catch {
      return; // unreachable, or not a token endpoint: nothing learned
    }
    if (code !== "invalid_client" && code !== "unauthorized_client") return;
    throw tagged(CLIENT_UNKNOWN, clientUnknown(clientId, discovery?.authorizationServerUrl ?? "the issuer", code));
  }

  async run(response) {
    if (response) {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      if (resourceMetadataUrl) this.resourceMetadataUrl = resourceMetadataUrl;
      if (scope) this.scope = scope;
    }
    const opts = { serverUrl: this.serverUrl, resourceMetadataUrl: this.resourceMetadataUrl, scope: this.scope, fetchFn: this.authFetch };
    const stored = this.provider.read();
    let hadTokens = Boolean(stored.tokens);
    const hadCredential = hadTokens || Boolean(stored.clientInformation);
    // Half-states the SDK would stumble on: say so, drop the tokens up front and go straight to the browser.
    // (A registration without tokens is the normal state after the first registration — nothing to do;
    // with a configured client id, no registration is ever needed, so tokens alone are whole.)
    const unusable = !stored.tokens ? null
      : !stored.clientInformation && !this.clientId ? "has no client registration; registering and signing in again"
      : !stored.tokens.refresh_token ? "has no refresh token; signing in again"
      : null;
    if (unusable) {
      this.log(`stored sign-in for ${this.serverUrl} ${unusable}`);
      this.provider.invalidateCredentials("tokens");
      hadTokens = false;
    }
    this.phase = "stored";
    this.lastResult = undefined;
    try {
      let recovered = Boolean(unusable);
      try {
        recovered = (await this.attempt(opts, hadTokens)) && (hadTokens || recovered);
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
      const message = this.failureMessage(e);
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
    this.observed = { rejection: null, discovered: false, registered: false };
    this.phase = "stored";
    let result = await auth(this.provider, opts);
    this.lastResult = result;
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
      this.lastResult = result;
    }
    if (result !== "AUTHORIZED") throw new Error(`authorization ended in ${String(result)}`);
    return redirected;
  }

  /**
   * What `/whoami` and the log say about a failed sign-in: the error's message,
   * or — the SDK builds an OAuthError from an issuer answer without
   * `error_description` with an EMPTY message, and a non-Error can be thrown —
   * one made from where the pass was, the OAuth code and the issuer's answer.
   */
  failureMessage(e) {
    const raw = (e instanceof Error ? e.message : e === undefined || e === null ? "" : String(e)).trim();
    const r = this.observed.rejection;
    if (this.clientId) {
      // The token endpoint (refresh or code exchange) does not know the configured client: a configuration error, named as such.
      if (e instanceof Error && e.name === CONFIGURED_CLIENT_REJECTED) return e.message;
      const code = e instanceof OAuthError ? e.errorCode : r?.endpoint === "token" ? r.code : undefined;
      if (code === "invalid_client" || code === "unauthorized_client") return configuredClientRejected(this.clientId, code, this.advertisesRegistration());
    } else if (r?.endpoint === "token" && r.grant === "authorization_code" && (r.code === "invalid_client" || r.code === "unauthorized_client")) {
      // The code exchange disowned the registration: the SDK dropped it (and could not finish the exchange without one).
      return `the issuer rejected the client registration at the code exchange (${this.describeRejection()}); it has been dropped — press a + Enter (or restart the proxy) to register anew and sign in`;
    }
    if (r?.endpoint === "registration") {
      // The SDK's ServerError drops the issuer's body; say what it said, and what to do about a full tenant.
      const said = this.describeRejection();
      const quoted = said && !said.startsWith("HTTP ") ? said : undefined; // what the body said, when it said anything
      let message = `the issuer refused to register the client (HTTP ${r.status}${quoted ? `: ${quoted}` : ""})`;
      if (raw && !quoted) message += ` — ${raw}`; // else the SDK's text repeats (or Zod-dumps) the body
      if (r.errorCode === "too_many_entities" || /too_many_entities/.test(`${r.code ?? ""} ${r.description ?? ""}`)) message += `; ${TOO_MANY_ENTITIES_HINT}`;
      return message;
    }
    if (raw) return raw;
    const where = this.phase === "browser" ? "in the browser flow"
      : r?.endpoint === "registration" ? "while registering the client"
      : r?.endpoint === "token" ? "while refreshing"
      : "before the issuer was contacted (stored credential unusable)";
    const code = e instanceof OAuthError ? e.errorCode : r?.code;
    const detail = [code, r ? `HTTP ${r.status} from the ${r.endpoint} endpoint` : undefined, e instanceof Error && e.name !== "Error" ? e.name : undefined].filter(Boolean).join(", ");
    const result = this.lastResult !== undefined ? `; auth() returned ${String(this.lastResult)}` : "";
    return `authorization failed ${where}${detail ? ` (${detail})` : ""}${result}`;
  }

  /**
   * Does this failure of the stored credential mean it is dead, and which part?
   *   invalid_client / unauthorized_client (from the token endpoint, or from the pre-browser check of a
   *     stored registration — `CLIENT_UNKNOWN`), or a 400/401 from the registration endpoint          → "all"
   *   invalid_grant, or a 400/401 from the token endpoint                               → "tokens" (which drops discovery too)
   *   a token endpoint that no longer answers like one, or a registration endpoint refusing
   *     with any other status, on cached metadata                                       → "discovery"
   * Anything else (the issuer unreachable or 5xx, a malformed metadata document) is not.
   * With a configured client id, `invalid_client` / `unauthorized_client` is not a dead
   * credential either but a wrong configuration: there is no registration to redo.
   * @returns {{ scope: "all" | "tokens" | "discovery", reason: string } | null}
   */
  deadCredential(e) {
    if (e instanceof Error && e.name === STALE_DISCOVERY) return { scope: "discovery", reason: e.message };
    if (e instanceof Error && e.name === CONFIGURED_CLIENT_REJECTED) return null;
    if (e instanceof Error && e.name === CLIENT_UNKNOWN) return { scope: "all", reason: e.message };
    const r = this.observed.rejection;
    const code = e instanceof OAuthError ? e.errorCode : r?.code;
    const reason = this.describeRejection() ?? (e instanceof Error ? e.message : String(e));
    if (code === "invalid_client" || code === "unauthorized_client") return this.clientId ? null : { scope: "all", reason };
    if (code === "invalid_grant") return { scope: "tokens", reason };
    if (r && (r.status === 400 || r.status === 401)) return { scope: r.endpoint === "registration" ? "all" : "tokens", reason };
    // A registration the issuer refuses otherwise (403, 404, …) while we worked from cached metadata: the endpoint may have moved.
    if (r && r.endpoint === "registration" && !this.observed.discovered) return { scope: "discovery", reason: `the stored registration endpoint answered HTTP ${r.status}${r.code ? ` ${r.code}` : ""}` };
    return null;
  }

  describeRejection() {
    const r = this.observed.rejection;
    if (!r) return undefined;
    const text = [r.code, r.description].filter(Boolean).join(": ");
    const withCode = r.errorCode && r.errorCode !== r.code ? `${text ? `${text} ` : ""}(${r.errorCode})` : text;
    return withCode || `HTTP ${r.status} from the ${r.endpoint} endpoint`;
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
   * restart — so the client is registered anew (a configured client id is not
   * in the file: it is kept and presented again). With `resetClient` (`r`): the
   * client registration and its tokens are dropped and the client registered
   * anew — the key for a gateway whose authorize page says "Unknown client"
   * (the pre-browser check normally catches that by itself). A sign-in still
   * pending is superseded, not failed.
   */
  async reauthorize({ forget = false, resetClient = false } = {}) {
    if (!forget && !resetClient && this.status.state === "waiting" && this.provider.pending && this.inflight) {
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
    } else if (resetClient) {
      this.resetRegistration("r");
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
