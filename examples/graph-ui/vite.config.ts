import { defineConfig } from "vite";

// The MCP bridge (scripts/dev-mcp.mjs) listens on 8787 by default; the UI
// talks to it directly (CORS is on), so no proxy is configured here. Override
// the endpoint in the page's settings panel.
export default defineConfig({
  server: { port: 5173, strictPort: false },
  // elkjs (bundled, ~1.5 MB) dominates the single chunk; a demo need not split it.
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 2600 },
});
