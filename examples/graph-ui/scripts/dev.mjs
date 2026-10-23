#!/usr/bin/env node
// `pnpm dev`: start the MCP proxy (the `webdevproxy` workspace package), then
// Vite, which proxies the page's same-origin /mcp and /whoami to it.
//
//   pnpm --filter graph-ui dev                                   # the local sample (builds ./sample into .dev-workspace first)
//   pnpm --filter graph-ui dev --remote https://mcp.example.com/omg   # proxy to a remote omg MCP; the proxy signs in for you
//   pnpm --filter graph-ui dev:mcp [--remote <url>]              # the proxy alone (= `dev --proxy-only`)
//   pnpm --filter graph-ui dev --repo <slug>                      # the repository to serve/query (the page sends it as `repo`)
//   pnpm --filter graph-ui dev --tools full                       # the local `omg mcp` serves every tool (default: minimal)
//   env: WEBDEVPROXY_REMOTE=<url> (or the older GRAPH_UI_REMOTE) is the same as --remote
//
// The proxy's flags (--remote, --no-browser, --token-file, --port, --path,
// --idle, --origin, --omg, --repo, --tools; this demo's --workspace <dir> = --local) are consumed
// here; everything else (e.g. --open, --host) goes to Vite. The proxy's port and
// path reach vite.config.ts through WEBDEVPROXY_PORT / WEBDEVPROXY_PATH.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { logout, startProxy } from "webdevproxy";
import { ensureWorkspace, PACKAGE_ROOT, WORKSPACE } from "./dev-workspace.mjs";
import { devArgs } from "./dev-args.mjs";

const options = devArgs();
const log = (m) => console.error(`[webdevproxy] ${m}`);

if (options.logout) {
  logout(options, log);
  process.exit(0);
}

if (!options.remote && options.local === WORKSPACE) {
  try {
    ensureWorkspace({ log: (m) => console.error(`[workspace] ${m}`) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

let proxy;
try {
  proxy = await startProxy({ ...options, log });
} catch (e) {
  console.error(`[webdevproxy] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (options.proxyOnly) {
  const stop = async () => { await proxy.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  const vite = spawn(process.execPath, [resolve(PACKAGE_ROOT, "node_modules/vite/bin/vite.js"), ...options.rest], {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
    env: { ...process.env, WEBDEVPROXY_PORT: String(proxy.port), WEBDEVPROXY_PATH: proxy.path },
  });

  const stop = async () => {
    vite.kill("SIGTERM");
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  vite.on("exit", (code) => { void proxy.close().then(() => process.exit(code ?? 0)); });
}
