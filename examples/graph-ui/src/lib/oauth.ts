// OAuth for the browser: an `OAuthClientProvider` for @modelcontextprotocol/sdk's
// Streamable HTTP client, so the page can sign in to a remote omg MCP behind a
// gateway (host-my-mcp + Auth0) with the standard MCP flow —
//
//   401 + `WWW-Authenticate: Bearer resource_metadata=…`
//     → /.well-known/oauth-protected-resource/<path>   (RFC 9728)
//     → the authorization server's metadata            (RFC 8414 / OIDC)
//     → dynamic client registration                    (RFC 7591, public client, PKCE)
//     → Authorization Code + PKCE with `resource=<server url>` (RFC 8707)
//     → redirect back here with ?code=…&state=…, exchange, store tokens
//     → refresh silently (`offline_access` yields a refresh token);
//       a 401 after a failed refresh re-runs the flow.
//
// The SDK's `auth()` drives discovery, DCR, PKCE, exchange and refresh; this
// module supplies the persistence (localStorage keyed by server URL), the
// redirect, and the pure helpers the UI and the tests use (WWW-Authenticate
// parsing, metadata URL derivation, discovery with an injectable fetch, PKCE
// S256, the authorization URL, JWT claims for the identity line).

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// ---- WWW-Authenticate -----------------------------------------------------------

export interface WwwAuthenticate {
  scheme: string | null;
  resourceMetadataUrl: string | null;
  scope: string | null;
  error: string | null;
}

/** `Bearer resource_metadata="https://…", scope="openid email", error="invalid_token"`. */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticate {
  const out: WwwAuthenticate = { scheme: null, resourceMetadataUrl: null, scope: null, error: null };
  if (!header) return out;
  const m = /^\s*([A-Za-z][\w-]*)\s*(.*)$/s.exec(header);
  if (!m) return out;
  out.scheme = m[1]!;
  const params = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const p of m[2]!.matchAll(params)) {
    const key = p[1]!.toLowerCase();
    const value = (p[2] ?? p[3] ?? "").replace(/\\(.)/g, "$1");
    if (key === "resource_metadata") out.resourceMetadataUrl = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
  }
  return out;
}

// ---- metadata locations -----------------------------------------------------------

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** RFC 9728 §3: the path-aware well-known URL first, then the origin's. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = trimSlash(u.pathname);
  const urls = [`${u.origin}/.well-known/oauth-protected-resource`];
  if (path) urls.unshift(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  return urls;
}

/** RFC 8414 then OpenID discovery, path-aware when the issuer has a path. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = trimSlash(u.pathname);
  if (!path) {
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

export interface Discovery {
  resourceMetadataUrl: string | null;
  resource: OAuthProtectedResourceMetadata | null;
  authorizationServerUrl: string;
  authorizationServer: AuthorizationServerMetadata;
  /** The scope the flow will request: WWW-Authenticate's, else the resource's `scopes_supported`. */
  scope: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function firstJson<T>(urls: string[], fetchFn: FetchLike): Promise<{ url: string; body: T } | null> {
  for (const url of urls) {
    try {
      const res = await fetchFn(url, { headers: { accept: "application/json" } });
      if (res.ok) return { url, body: (await res.json()) as T };
    } catch {
      // unreachable / CORS-blocked: try the next location
    }
  }
  return null;
}

/** Protected-resource + authorization-server discovery (pure given `fetch`). */
export async function discover(
  serverUrl: string,
  opts: { fetch?: FetchLike; wwwAuthenticate?: WwwAuthenticate | string | null } = {},
): Promise<Discovery> {
  const fetchFn = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const www = typeof opts.wwwAuthenticate === "string" ? parseWwwAuthenticate(opts.wwwAuthenticate) : opts.wwwAuthenticate ?? null;
  const prmUrls = www?.resourceMetadataUrl ? [www.resourceMetadataUrl] : protectedResourceMetadataUrls(serverUrl);
  const prm = await firstJson<OAuthProtectedResourceMetadata>(prmUrls, fetchFn);
  const issuer = prm?.body.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  const as = await firstJson<AuthorizationServerMetadata>(authorizationServerMetadataUrls(issuer), fetchFn);
  if (!as) throw new Error(`no authorization server metadata at ${issuer} (tried ${authorizationServerMetadataUrls(issuer).join(", ")})`);
  return {
    resourceMetadataUrl: prm?.url ?? null,
    resource: prm?.body ?? null,
    authorizationServerUrl: issuer,
    authorizationServer: as.body,
    scope: www?.scope ?? prm?.body.scopes_supported?.join(" ") ?? null,
  };
}

// ---- PKCE + the authorization URL ---------------------------------------------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** S256: base64url(sha256(verifier)) (RFC 7636 §4.2). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  return { verifier, challenge: await codeChallenge(verifier) };
}

export interface AuthorizationParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string | null;
  resource?: string | null;
}

export function authorizationUrl(meta: Pick<AuthorizationServerMetadata, "authorization_endpoint">, p: AuthorizationParams): URL {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", p.state);
  if (p.scope) url.searchParams.set("scope", p.scope);
  if (p.resource) url.searchParams.set("resource", p.resource);
  // `offline_access` is an OIDC scope: a refresh token is only issued when consent is prompted.
  if (p.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
  return url;
}

export interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export function callbackParams(href: string | URL): CallbackParams {
  const q = new URL(href).searchParams;
  return {
    code: q.get("code"),
    state: q.get("state"),
    error: q.get("error"),
    errorDescription: q.get("error_description"),
  };
}

// ---- identity -----------------------------------------------------------------------

export function decodeJwtClaims(jwt: string | null | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface Identity {
  email: string | null;
  name: string | null;
  subject: string | null;
}

/** Who the tokens say we are: the id_token's claims first, else the access token's (Auth0 JWTs). */
export function identityFromTokens(tokens: OAuthTokens | undefined | null): Identity | null {
  const claims = decodeJwtClaims(tokens?.id_token) ?? decodeJwtClaims(tokens?.access_token);
  if (!claims) return null;
  const str = (k: string): string | null => (typeof claims[k] === "string" ? (claims[k] as string) : null);
  const identity = { email: str("email"), name: str("name") ?? str("nickname"), subject: str("sub") };
  return identity.email || identity.name || identity.subject ? identity : null;
}

// ---- the provider ----------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const OAUTH_STORAGE_PREFIX = "omgbase-graph-ui.oauth.";

export function storageKey(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${OAUTH_STORAGE_PREFIX}${u.origin}${trimSlash(u.pathname)}`;
}

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensSavedAt?: number;
  codeVerifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
}

export interface BrowserOAuthProviderOptions {
  /** Where the authorization server sends the browser back (this page). */
  redirectUrl: string;
  storage?: StorageLike;
  /** Performs the navigation (default `location.assign`); tests inject a spy. */
  navigate?: (url: URL) => void;
  /** Called right before navigating away — persist whatever must survive the round trip. */
  onBeforeRedirect?: () => void;
  clientName?: string;
}

export class BrowserOAuthProvider implements OAuthClientProvider {
  readonly key: string;
  private readonly storage: StorageLike;

  constructor(readonly serverUrl: string, private readonly options: BrowserOAuthProviderOptions) {
    this.key = storageKey(serverUrl);
    this.storage = options.storage ?? globalThis.localStorage;
  }

  private read(): Stored {
    try {
      return (JSON.parse(this.storage.getItem(this.key) ?? "{}") as Stored) ?? {};
    } catch {
      return {};
    }
  }

  /** Merge into the stored record; an explicit `undefined` deletes the key. */
  private patch(p: { [K in keyof Stored]?: Stored[K] | undefined }): void {
    const merged: Record<string, unknown> = { ...this.read(), ...p };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    this.storage.setItem(this.key, JSON.stringify(merged));
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  /** A public client (PKCE, no secret) registered dynamically; the SDK fills `scope`
   * from the resource's `scopes_supported` (SEP-835) so none is pinned here. */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName ?? "omgbase graph UI",
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const state = randomString(16);
    this.patch({ state });
    return state;
  }

  /** The state issued for the pending round trip, cleared on read. */
  consumeState(): string | undefined {
    const { state } = this.read();
    this.patch({ state: undefined });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.patch({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch({ tokens, tokensSavedAt: Date.now() });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.options.onBeforeRedirect?.();
    (this.options.navigate ?? ((u: URL) => globalThis.location.assign(u.href)))(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error("no PKCE code verifier saved for this server — start the sign-in again");
    return v;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.patch({ discovery });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read().discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    switch (scope) {
      case "all": this.storage.removeItem(this.key); return;
      case "client": this.patch({ client: undefined }); return;
      case "tokens": this.patch({ tokens: undefined, tokensSavedAt: undefined }); return;
      case "verifier": this.patch({ codeVerifier: undefined }); return;
      case "discovery": this.patch({ discovery: undefined }); return;
    }
  }

  /** Forget everything about this server (sign out locally). */
  clear(): void {
    this.invalidateCredentials("all");
  }

  hasTokens(): boolean {
    return this.read().tokens !== undefined;
  }

  identity(): Identity | null {
    return identityFromTokens(this.read().tokens);
  }
}
