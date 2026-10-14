import { defineConfig } from "vite";
import { viteProxy } from "webdevproxy";

// The MCP proxy (the `webdevproxy` workspace package, started by scripts/dev.mjs)
// listens on 127.0.0.1:8789 by default for this demo (graph-ui 8787, live-tail
// 8788, so the three run side by side); the dev script exports its actual port
// and path as WEBDEVPROXY_PORT / WEBDEVPROXY_PATH, which `viteProxy()` reads.
// The page reaches it at the same-origin paths /mcp and /whoami through this
// proxy, so the server URL in the app is just "/mcp".
export default defineConfig({
  server: {
    port: 5175,
    strictPort: false,
    proxy: viteProxy(),
  },
  // One chunk (~570 kB: Shoelace, markdown-it, the MCP SDK); a demo need not split it.
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 700 },
});
