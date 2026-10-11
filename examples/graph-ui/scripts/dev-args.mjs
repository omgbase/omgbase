// The dev script's arguments: webdevproxy's flags (`parseArgs`) plus this demo's
// own spellings — `--workspace <dir>` for the proxy's `--local`, the
// `GRAPH_UI_*` environment variables older runs used, `--proxy-only` for
// `pnpm dev:mcp` — and the demo's defaults (the local sample workspace, the
// monorepo's built `omg`). Pure, so it can be unit-tested; `rest` is what goes
// to Vite.

import { parseArgs } from "webdevproxy";
import { OMG, WORKSPACE } from "./dev-workspace.mjs";

/** `GRAPH_UI_*` names older runs set, each with the webdevproxy variable that replaces it. */
export const LEGACY_ENV = {
  GRAPH_UI_REMOTE: "WEBDEVPROXY_REMOTE",
  GRAPH_UI_MCP_PORT: "WEBDEVPROXY_PORT",
  GRAPH_UI_TOKEN_FILE: "WEBDEVPROXY_TOKEN_FILE",
  GRAPH_UI_NO_BROWSER: "WEBDEVPROXY_NO_BROWSER",
  GRAPH_UI_WORKSPACE: "WEBDEVPROXY_LOCAL",
};

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {import("webdevproxy").ProxyArgs & { proxyOnly: boolean }}
 */
export function devArgs(argv = process.argv.slice(2), env = process.env) {
  // The demo's spellings → the proxy's.
  const translated = [];
  let proxyOnly = false;
  let omgGiven = false;
  for (const a of argv) {
    if (a === "--proxy-only") proxyOnly = true;
    else if (a === "--workspace") translated.push("--local");
    else if (a.startsWith("--workspace=")) translated.push(`--local=${a.slice("--workspace=".length)}`);
    else {
      if (a === "--omg" || a.startsWith("--omg=")) omgGiven = true;
      translated.push(a);
    }
  }
  // An older GRAPH_UI_* variable stands in for its webdevproxy counterpart when that one is unset.
  const merged = { ...env };
  for (const [legacy, current] of Object.entries(LEGACY_ENV)) {
    if (!merged[current]?.trim() && merged[legacy]?.trim()) merged[current] = merged[legacy];
  }
  const o = parseArgs(translated, merged);
  return {
    ...o,
    // The sample workspace unless a remote is named (never both: the proxy refuses that).
    local: o.remote ? null : (o.local ?? WORKSPACE),
    // dev-workspace.mjs builds the sample with this `omg`; the proxy serves it with the same one.
    omg: omgGiven || merged.WEBDEVPROXY_OMG?.trim() ? o.omg : OMG,
    proxyOnly,
  };
}
