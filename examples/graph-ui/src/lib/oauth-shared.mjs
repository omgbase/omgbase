// OAuth helpers shared by the page (src/lib/oauth.ts) and the plain-Node MCP
// bridge (scripts/dev-mcp.mjs in --remote mode). Plain JS with JSDoc types on
// purpose: the bridge runs under `node` with no build step and cannot import
// .ts, and the page should not carry a second copy. Everything here is
// isomorphic — `URL`, `atob` and nothing else.

/**
 * The canonical form of a server URL for keys and file names: origin plus the
 * path without a trailing slash (`https://host/omg/` ≡ `https://host/omg`).
 * @param {string} serverUrl
 * @returns {string}
 */
export function normalizeServerUrl(serverUrl) {
  const u = new URL(serverUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * @typedef {{ code: string | null, state: string | null, error: string | null, errorDescription: string | null }} CallbackParams
 */

/**
 * The authorization server's redirect back to us: `?code=…&state=…` or `?error=…`.
 * @param {string | URL} href
 * @returns {CallbackParams}
 */
export function callbackParams(href) {
  const q = new URL(href).searchParams;
  return {
    code: q.get("code"),
    state: q.get("state"),
    error: q.get("error"),
    errorDescription: q.get("error_description"),
  };
}

/**
 * The payload of a JWT, undecoded-signature and all; null for anything that is not a three-part token.
 * @param {string | null | undefined} jwt
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtClaims(jwt) {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    /** @type {unknown} */
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? /** @type {Record<string, unknown>} */ (claims) : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ email: string | null, name: string | null, subject: string | null }} Identity
 */

/**
 * Who the tokens say we are: the id_token's claims first, else the access token's (Auth0 JWTs).
 * @param {{ [key: string]: unknown, access_token?: string | undefined, id_token?: string | undefined } | null | undefined} tokens
 * @returns {Identity | null}
 */
export function identityFromTokens(tokens) {
  const claims = decodeJwtClaims(tokens?.id_token) ?? decodeJwtClaims(tokens?.access_token);
  if (!claims) return null;
  /** @param {string} k */
  const str = (k) => (typeof claims[k] === "string" ? /** @type {string} */ (claims[k]) : null);
  const identity = { email: str("email"), name: str("name") ?? str("nickname"), subject: str("sub") };
  return identity.email || identity.name || identity.subject ? identity : null;
}
