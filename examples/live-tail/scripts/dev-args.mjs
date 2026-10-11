// The dev script's arguments: webdevproxy's flags (`parseArgs`) plus this
// demo's defaults — the local sample workspace unless `--remote` is given, the
// monorepo's built `omg`, port 8788 (one above graph-ui's, so both demos run
// side by side) — and `--proxy-only` for `pnpm dev:mcp`. Pure; `rest` goes to Vite.

import { DEFAULT_PORT, parseArgs } from "webdevproxy";
import { OMG, WORKSPACE } from "./dev-workspace.mjs";

/** The proxy port when neither `--port` nor WEBDEVPROXY_PORT says otherwise. */
export const LIVE_TAIL_PORT = DEFAULT_PORT + 1;

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {import("webdevproxy").ProxyArgs & { proxyOnly: boolean }}
 */
export function devArgs(argv = process.argv.slice(2), env = process.env) {
  const proxyOnly = argv.includes("--proxy-only");
  const given = (flag) => argv.some((a) => a === flag || a.startsWith(`${flag}=`));
  const o = parseArgs(argv.filter((a) => a !== "--proxy-only"), env);
  return {
    ...o,
    local: o.remote ? null : (o.local ?? WORKSPACE),
    omg: given("--omg") || env.WEBDEVPROXY_OMG?.trim() ? o.omg : OMG,
    port: given("--port") || env.WEBDEVPROXY_PORT?.trim() ? o.port : LIVE_TAIL_PORT,
    proxyOnly,
  };
}
