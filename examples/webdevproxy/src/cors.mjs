// Which browser origins may call the proxy. Loopback dev servers on any port
// are always allowed (`http://localhost:*`, `http://127.0.0.1:*`, `[::1]`);
// `--origin` adds exact origins or the same `*`-port pattern. A request with
// no Origin header (same-origin through Vite's proxy, curl) needs no CORS
// headers at all. Pure, so the matching is unit-testable.

export const LOOPBACK_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"];

/**
 * Does `origin` match `pattern`? A pattern is an exact origin, or an origin
 * whose port is `*` (any port, including the default one).
 * @param {string} origin
 * @param {string} pattern
 */
export function originMatches(origin, pattern) {
  if (origin === pattern) return true;
  if (!pattern.endsWith(":*")) return false;
  const prefix = pattern.slice(0, -1); // keep the colon
  if (origin === prefix.slice(0, -1)) return true; // the default port, no colon in the origin
  return origin.startsWith(prefix) && /^\d+$/.test(origin.slice(prefix.length));
}

/**
 * The `Access-Control-Allow-Origin` value for a request, or null when the
 * request needs no CORS headers (no Origin) or the origin is not allowed.
 * @param {string | undefined} origin   the request's Origin header
 * @param {string[]} [extra]            `--origin` values
 */
export function allowOrigin(origin, extra = []) {
  if (!origin) return null;
  return [...LOOPBACK_ORIGINS, ...extra].some((p) => originMatches(origin, p)) ? origin : null;
}

/**
 * The CORS headers for an allowed origin (the MCP session headers exposed).
 * @param {string} origin
 */
export function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
    "Access-Control-Max-Age": "86400",
  };
}
