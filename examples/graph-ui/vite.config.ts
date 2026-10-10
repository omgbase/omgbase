import { defineConfig } from "vite";

// The MCP bridge (scripts/dev-mcp.mjs) listens on 8787 by default. The page
// reaches it at the same-origin paths /mcp and /whoami through this proxy, so
// the default server URL in the app is just "/mcp" (the bridge also sends CORS
// headers, so the absolute http://localhost:8787/mcp keeps working). Direct
// connections to a remote gateway bypass the proxy entirely.
const bridge = `http://localhost:${process.env.GRAPH_UI_MCP_PORT ?? "8787"}`;

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/mcp": { target: bridge, changeOrigin: false },
      "/whoami": { target: bridge, changeOrigin: false },
    },
  },
  // elkjs (bundled, ~1.5 MB) dominates the single chunk; a demo need not split it.
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 2600 },
});
