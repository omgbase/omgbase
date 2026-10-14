// The dev script's arguments: webdevproxy's flags (`parseArgs`) plus this
// demo's defaults — the sample workspace unless `--remote` is given, port 8791
// (graph-ui 8787, live-tail 8788, repo-explorer 8789; 8790 is the proxy's
// sign-in callback port), and the tools profile the local `omg mcp` serves:
// MINIMAL by default (the app is built against it; `scripts/omg-minimal.mjs`
// is the `omg` the proxy spawns), `--full` for the whole catalog.
// `--proxy-only` is `pnpm dev:mcp`. Pure; `rest` goes to Vite.
// (After examples/repo-explorer/scripts/dev-args.mjs.)

import { DEFAULT_PORT, parseArgs } from "webdevproxy";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OMG, WORKSPACE } from "./dev-workspace.mjs";

/** The proxy port when neither `--port` nor WEBDEVPROXY_PORT says otherwise. */
export const ATTN_PORT = DEFAULT_PORT + 4;

/** The `omg` stand-in that appends `--tools minimal` (scripts/omg-minimal.mjs). */
export const OMG_MINIMAL = resolve(dirname(fileURLToPath(import.meta.url)), "omg-minimal.mjs");

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {import("webdevproxy").ProxyArgs & { proxyOnly: boolean, profile: "minimal" | "full" }}
 */
export function devArgs(argv = process.argv.slice(2), env = process.env) {
  const own = new Set(["--proxy-only", "--full", "--minimal"]);
  const proxyOnly = argv.includes("--proxy-only");
  const profile = argv.includes("--full") ? "full" : "minimal";
  const given = (flag) => argv.some((a) => a === flag || a.startsWith(`${flag}=`));
  const o = parseArgs(argv.filter((a) => !own.has(a)), env);
  const omgGiven = given("--omg") || Boolean(env.WEBDEVPROXY_OMG?.trim());
  return {
    ...o,
    local: o.remote ? null : (o.local ?? WORKSPACE),
    // The real CLI when named; else the minimal stand-in (which runs the monorepo's build), or the build itself under --full.
    omg: omgGiven ? o.omg : profile === "minimal" ? OMG_MINIMAL : OMG,
    port: given("--port") || env.WEBDEVPROXY_PORT?.trim() ? o.port : ATTN_PORT,
    proxyOnly,
    profile,
  };
}
