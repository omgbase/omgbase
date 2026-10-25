// The ONLY data path: omgbase's MCP server over the Streamable HTTP transport
// (the dev proxy — the `webdevproxy` workspace package — or a remote gateway
// behind OAuth). The client itself is the shared `@omgbase/client` (`OmgClient`:
// the session, its recovery after the server forgets it — `unknown session` →
// one re-initialize and retry, `onSessionLost` so the page can say so — the
// `{ content: [{ text }] }` envelope, `OmgError { code, message, data,
// retriable, fix }`, the ten minimal tools typed, an `authProvider` for the
// direct OAuth mode and a `repo` default). This module keeps what is this page's
// own: the three connection modes and the URL a mode uses. Nothing here imports
// @omgbase/core; the browser-side OAuth provider is lib/oauth.ts.

import { absoluteServerUrl } from "@omgbase/client";

export { AuthRequiredError, OmgClient, OmgError, absoluteServerUrl, classifyError, isSessionLost, isStale, isUnknownTool } from "@omgbase/client";
export type { CommandClient, DocsReadResult, Hit, QueryResult, Receipt } from "@omgbase/client";

/** How the page reaches omgbase: the local bridge serving the sample, the local
 * bridge proxying (and signed in to) a remote, or the remote directly. */
export type McpMode = "local" | "proxy" | "direct";

export interface McpSettings {
  mode: McpMode;
  /** The bridge's MCP endpoint — a same-origin path through Vite's proxy by default. */
  bridgeUrl: string;
  /** The remote gateway, for direct mode (needs CORS on the gateway and web origins in Auth0). */
  directUrl: string;
  repo: string;
}

/** The server URL a mode uses, made absolute against the page (`/mcp` → `http://localhost:5173/mcp`). */
export function serverUrlFor(s: Pick<McpSettings, "mode" | "bridgeUrl" | "directUrl">, base?: string): string {
  return absoluteServerUrl(s.mode === "direct" ? s.directUrl : s.bridgeUrl, base);
}
