import { defineConfig } from "vite";
import { viteProxy } from "webdevproxy";

// The MCP proxy (the `webdevproxy` workspace package, started by scripts/dev.mjs)
// listens on 127.0.0.1:8787 by default; the dev script exports its actual port
// and path as WEBDEVPROXY_PORT / WEBDEVPROXY_PATH, which `viteProxy()` reads.
// The page reaches it at the same-origin paths /mcp and /whoami through this
// proxy, so the default server URL in the app is just "/mcp" (the proxy also
// sends CORS headers for loopback origins, so the absolute
// http://localhost:8787/mcp keeps working). Direct connections to a remote
// gateway bypass both proxies entirely.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: viteProxy(),
  },
  // elkjs (bundled, ~1.5 MB) dominates the single chunk; a demo need not split it.
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 2600 },
});
