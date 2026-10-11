import { defineConfig } from "vite";
import { viteProxy } from "webdevproxy";

// The MCP proxy (the `webdevproxy` workspace package, started by scripts/dev.mjs
// on 127.0.0.1:8788 by default — one above graph-ui's, so both demos can run)
// exports its actual port and path as WEBDEVPROXY_PORT / WEBDEVPROXY_PATH, which
// `viteProxy()` reads. The page reaches it at the same-origin /mcp and /whoami.
export default defineConfig({
  server: {
    port: 5174,
    strictPort: false,
    proxy: viteProxy(),
  },
  build: { target: "es2022", outDir: "dist" },
});
