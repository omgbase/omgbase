// The Vite side of the arrangement: `server.proxy` entries that send the page's
// same-origin `/mcp` and `/whoami` to the proxy, so the app's server URL is just
// "/mcp" and the browser never needs CORS at all.
//
//   import { viteProxy } from "webdevproxy";
//   export default defineConfig({ server: { proxy: viteProxy() } });
//
// The dev script that starts the proxy exports WEBDEVPROXY_PORT (and _PATH) to
// Vite's environment, so a non-default port needs no config change.

import { DEFAULT_PATH, DEFAULT_PORT, LISTEN_HOST } from "./args.mjs";

/**
 * @param {{ port?: number | string, path?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {Record<string, { target: string, changeOrigin: false }>}
 */
export function viteProxy({ port, path, env = process.env } = {}) {
  const p = Number(port ?? env.WEBDEVPROXY_PORT ?? DEFAULT_PORT);
  const mcpPath = path ?? env.WEBDEVPROXY_PATH ?? DEFAULT_PATH;
  const target = `http://${LISTEN_HOST}:${p}`;
  return {
    [mcpPath]: { target, changeOrigin: false },
    "/whoami": { target, changeOrigin: false },
  };
}
