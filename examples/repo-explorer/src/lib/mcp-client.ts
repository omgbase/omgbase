// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport,
// through the dev proxy (the `webdevproxy` workspace package) at the same-origin
// `/mcp`. The client itself is the shared `@omgbase/client` (`OmgClient`: the
// session, its recovery after the proxy forgets it — `unknown session` → one
// re-initialize and retry — the `{ content: [{ text }] }` envelope, `OmgError
// { code, message, data, retriable, fix }`, the ten minimal tools typed); this
// module keeps what is this page's own: the `Caller` seam every feature module
// is written against (so a test can script the server and assert the exact
// calls), the proxy's `/whoami`, and the `repo` argument rule. Nothing here
// imports @omgbase/core; there is no browser-side OAuth — the proxy signs in to
// a remote on the page's behalf (GET /whoami says how far it got).

import type { WhoAmI } from "webdevproxy";

export { AuthRequiredError, OmgClient, OmgError, absoluteServerUrl, isSessionLost, isUnknownTool } from "@omgbase/client";

/** A tool result as the server spelled it (each feature module coerces its own). */
export type Wire = Record<string, unknown>;

/** What a feature module needs of the client: one tool call. `OmgClient`
 * satisfies it; tests pass a scripted table. */
export interface Caller {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface ApplyOptions {
  /** The repo slug; omitted (or empty/null) ⇒ the server's default. */
  repo?: string | null;
  /** The commit's reason (the revision's `_reason`). */
  reason?: string;
}

/** The arguments of an `apply` call: `{ effects, reason?, repo? }` — a key only when it has a value. */
export function applyArgs(effects: Record<string, unknown>[], opts: ApplyOptions = {}): Record<string, unknown> {
  return { effects, ...(opts.reason ? { reason: opts.reason } : {}), ...repoArg(opts.repo) };
}

/** `apply` over any `Caller`: plan and commit effects in one call (spec/surface
 * §4). The result is the Receipt `{ plan_id, commit, revisions: [{ _id, _path,
 * _hash }], new_ids, committed, summary }`. */
export async function applyEffects(caller: Caller, effects: Record<string, unknown>[], opts: ApplyOptions = {}): Promise<Wire> {
  return caller.call<Wire>("apply", applyArgs(effects, opts));
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

/** The repo argument, spelled only when a repo is chosen (omitted ⇒ the server's default repo). */
export function repoArg(repo: string | null | undefined): Record<string, string> {
  return repo ? { repo } : {};
}
