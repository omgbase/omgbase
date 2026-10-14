import { defineConfig } from "vite";
import { viteProxy } from "webdevproxy";

// The MCP proxy (the `webdevproxy` workspace package, started by scripts/dev.mjs)
// listens on 127.0.0.1:8791 by default for this demo (graph-ui 8787, live-tail
// 8788, repo-explorer 8789, so the demos run side by side); the dev script
// exports its actual port and path as WEBDEVPROXY_PORT / WEBDEVPROXY_PATH, which
// `viteProxy()` reads. The page reaches it at the same-origin paths /mcp and
// /whoami through this proxy, so the server URL in the app is just "/mcp".
export default defineConfig({
  server: {
    port: 5176,
    strictPort: false,
    proxy: viteProxy(),
  },
  // One chunk (Lit, signals, the MCP SDK); a demo need not split it.
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 700 },
});
