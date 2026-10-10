#!/usr/bin/env node
// `pnpm dev`: start the MCP bridge, then Vite (which proxies /mcp and /whoami to the bridge).
//
//   pnpm --filter graph-ui dev                                   # the local sample (builds ./sample into .dev-workspace first)
//   pnpm --filter graph-ui dev --remote https://host/omg         # proxy to a remote omg MCP; the bridge signs in for you
//   env: GRAPH_UI_REMOTE=<url> is the same as --remote
//
// Bridge-only flags (--remote, --no-browser, --token-file, --workspace, …) are
// consumed here; everything else (e.g. --open, --host) goes to Vite.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureWorkspace, PACKAGE_ROOT } from "./dev-workspace.mjs";
import { parseBridgeArgs, startBridge } from "./dev-mcp.mjs";

const options = parseBridgeArgs();

if (!options.remote) {
  try {
    ensureWorkspace({ log: (m) => console.error(`[workspace] ${m}`) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const bridge = await startBridge(options);

const vite = spawn(process.execPath, [resolve(PACKAGE_ROOT, "node_modules/vite/bin/vite.js"), ...options.rest], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
  env: { ...process.env, GRAPH_UI_MCP_PORT: String(options.port) },
});

const stop = async () => {
  vite.kill("SIGTERM");
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => { void bridge.close().then(() => process.exit(code ?? 0)); });
