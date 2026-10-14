#!/usr/bin/env node
// `pnpm dev`: start the MCP proxy (the `webdevproxy` workspace package), then
// Vite, which proxies the page's same-origin /mcp and /whoami to it.
//
//   pnpm --filter repo-explorer dev                                   # the alchemy workspace, served with --tools minimal
//   pnpm --filter repo-explorer dev --full                            # the same workspace, the full catalog
//   pnpm --filter repo-explorer dev --remote https://mcp.example.com/omg   # a remote omg MCP; the proxy signs in for you
//   pnpm --filter repo-explorer dev:mcp [--remote <url>]              # the proxy alone (= `dev --proxy-only`)
//   env: WEBDEVPROXY_REMOTE=<url> is the same as --remote
//
// The proxy's flags (--remote, --no-browser, --token-file, --port, --path,
// --idle, --origin, --omg, --local) and this demo's (--full, --proxy-only) are
// consumed here; everything else (e.g. --open, --host) goes to Vite, which
// learns the proxy's port and path from WEBDEVPROXY_PORT / WEBDEVPROXY_PATH.
// (After examples/live-tail/scripts/dev.mjs.)

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
  if (!options.remote) log(`local omg mcp serves the ${options.profile} tools profile${options.profile === "minimal" ? " (pass --full for the whole catalog)" : ""}`);
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
