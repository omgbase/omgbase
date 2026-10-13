// webdevproxy — a development-only local web proxy for MCP servers, so the
// browser demos in this repository can reach an omgbase MCP server (a remote
// gateway with OAuth, or a local `omg mcp` process) from a Vite dev server
// without CORS or OAuth setup on the server side. Private, unpublished, not for
// production.
//
//   startProxy(options)   — run the proxy from a dev script (resolves with { url, port, whoami, ready, close })
//   viteProxy(options)    — Vite `server.proxy` entries for /mcp and /whoami
//   parseArgs / validateArgs / USAGE — the CLI's argument handling
//   logout                — delete token files
//   startPrompt(options)  — the terminal keys (a / l / q) of remote mode, for a TTY

export { startProxy, logout, UNKNOWN_SESSION_MESSAGE } from "./proxy.mjs";
export { viteProxy } from "./vite.mjs";
export { startPrompt, PROMPT_HINT } from "./prompt.mjs";
export { parseArgs, validateArgs, defaultOmg, omgCommand, USAGE, DEFAULT_PORT, DEFAULT_PATH, DEFAULT_IDLE_SECONDS, LISTEN_HOST, MONOREPO_OMG } from "./args.mjs";
export { allowOrigin, originMatches, corsHeaders, LOOPBACK_ORIGINS } from "./cors.mjs";
export {
  APP_DIR_NAME, LEGACY_APP_DIR_NAME, TOKEN_FILE_ENV, configDir, legacyConfigDir, serverUrlHash, tokenFilePath, legacyTokenFilePath,
  migrateLegacyTokenFile, readTokenFile, writeTokenFile, deleteTokenFile, listTokenFiles,
  CALLBACK_PATH, SIGN_IN_CANCELLED, STALE_DISCOVERY, TOO_MANY_ENTITIES_HINT, loopbackRedirectUrls, parseLoopbackCallback, startLoopback, openBrowser, FileOAuthProvider, RemoteAuth,
} from "./remote-auth.mjs";
export { SessionTable } from "./sessions.mjs";
export { normalizeServerUrl, callbackParams, decodeJwtClaims, identityFromTokens } from "./oauth-shared.mjs";
