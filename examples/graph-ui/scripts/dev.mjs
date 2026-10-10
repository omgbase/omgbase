#!/usr/bin/env node
// `pnpm dev`: build the sample workspace if missing, start the MCP bridge, start Vite.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureWorkspace, PACKAGE_ROOT } from "./dev-workspace.mjs";
import { startBridge } from "./dev-mcp.mjs";

try {
  ensureWorkspace({ log: (m) => console.error(`[workspace] ${m}`) });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const bridge = await startBridge();

const vite = spawn(process.execPath, [resolve(PACKAGE_ROOT, "node_modules/vite/bin/vite.js"), ...process.argv.slice(2)], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
});

const stop = async () => {
  vite.kill("SIGTERM");
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => { void bridge.close().then(() => process.exit(code ?? 0)); });
