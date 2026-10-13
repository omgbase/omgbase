// The CLI's arguments. Pure: `parseArgs(argv, env)` → options; `rest` is argv
// with the proxy's own flags removed, so a dev script can hand what is left to
// Vite (`--open`, `--host`, …).
//
//   webdevproxy --local <workspace-dir> [--omg <omg entry or binary>]
//   webdevproxy --remote <mcp-url> [--no-browser] [--token-file <f>]
//   webdevproxy --logout [--remote <mcp-url>] [--token-file <f>]
//   common: [--port 8787] [--path /mcp] [--idle 3600] [--origin <origin>]…
//   env: WEBDEVPROXY_LOCAL, WEBDEVPROXY_OMG, WEBDEVPROXY_REMOTE, WEBDEVPROXY_PORT,
//        WEBDEVPROXY_PATH, WEBDEVPROXY_TOKEN_FILE, WEBDEVPROXY_NO_BROWSER, WEBDEVPROXY_ORIGIN (comma-separated)

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 8787;
export const DEFAULT_PATH = "/mcp";
export const DEFAULT_IDLE_SECONDS = 3600;
/** The listener binds here and nowhere else: this is a dev-only proxy. */
export const LISTEN_HOST = "127.0.0.1";

const VALUE_FLAGS = ["local", "omg", "remote", "port", "path", "idle", "origin", "token-file"];
const BOOL_FLAGS = ["logout", "no-browser", "help"];

const here = dirname(fileURLToPath(import.meta.url));
/** The monorepo's built `omg` entry, when the proxy runs from its checkout. */
export const MONOREPO_OMG = resolve(here, "../../../packages/cli/dist/src/main.js");

/**
 * Where `omg` comes from when `--omg` is not given: `WEBDEVPROXY_OMG`, the
 * monorepo's built CLI when present, else `omg` on PATH.
 * @param {Record<string, string | undefined>} [env]
 * @param {(p: string) => boolean} [exists]
 */
export function defaultOmg(env = process.env, exists = existsSync) {
  const fromEnv = env.WEBDEVPROXY_OMG?.trim();
  if (fromEnv) return fromEnv;
  return exists(MONOREPO_OMG) ? MONOREPO_OMG : "omg";
}

/** A `.js`/`.mjs`/`.cjs` path is run with the current Node; anything else is an executable. */
export function omgCommand(omg) {
  return /\.(c|m)?js$/.test(omg) ? { command: process.execPath, args: [omg] } : { command: omg, args: [] };
}

/**
 * @typedef {object} ProxyArgs
 * @property {string | null} local       workspace directory for `omg mcp -C <dir>`
 * @property {string} omg                the `omg` entry (`.js`) or binary
 * @property {string | null} remote      the upstream MCP URL
 * @property {number} port
 * @property {string} path
 * @property {number} idleSeconds
 * @property {string[]} origins          extra allowed browser origins (loopback is always allowed)
 * @property {string | null} tokenFile
 * @property {boolean} noBrowser
 * @property {boolean} logout
 * @property {boolean} help
 * @property {string[]} rest             argv without the proxy's flags
 */

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {ProxyArgs}
 */
export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const flags = {};
  const origins = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = a.startsWith("--") ? a.slice(2, eq === -1 ? undefined : eq) : null;
    if (name && VALUE_FLAGS.includes(name) && (eq !== -1 || argv[i + 1] !== undefined)) {
      const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
      if (name === "origin") origins.push(value);
      else flags[name] = value;
    } else if (name && BOOL_FLAGS.includes(name)) {
      flags[name] = true;
    } else {
      rest.push(a);
    }
  }
  const envTrim = (k) => (env[k] && env[k].trim() ? env[k].trim() : null);
  const remote = flags.remote ?? envTrim("WEBDEVPROXY_REMOTE");
  const local = flags.local ?? envTrim("WEBDEVPROXY_LOCAL");
  for (const o of (envTrim("WEBDEVPROXY_ORIGIN") ?? "").split(",")) if (o.trim()) origins.push(o.trim());
  return {
    local: local ? resolve(local) : null,
    omg: flags.omg ?? defaultOmg(env),
    remote,
    port: Number(flags.port ?? envTrim("WEBDEVPROXY_PORT") ?? DEFAULT_PORT),
    path: flags.path ?? envTrim("WEBDEVPROXY_PATH") ?? DEFAULT_PATH,
    idleSeconds: Number(flags.idle ?? DEFAULT_IDLE_SECONDS),
    origins,
    tokenFile: flags["token-file"] ?? envTrim("WEBDEVPROXY_TOKEN_FILE"),
    noBrowser: Boolean(flags["no-browser"]) || Boolean(envTrim("WEBDEVPROXY_NO_BROWSER")),
    logout: Boolean(flags.logout),
    help: Boolean(flags.help),
    rest,
  };
}

/**
 * What is wrong with a parsed set of arguments, or null when they can run.
 * @param {ProxyArgs} o
 */
export function validateArgs(o) {
  if (o.help || o.logout) return null;
  if (o.local && o.remote) return "--local and --remote are exclusive: proxy either a workspace or a remote, not both";
  if (!o.local && !o.remote) return "nothing to proxy: give --local <workspace-dir> or --remote <mcp-url>";
  if (o.remote) {
    try {
      const u = new URL(o.remote);
      if (u.protocol !== "http:" && u.protocol !== "https:") return `--remote must be an http(s) URL, got ${o.remote}`;
    } catch {
      return `--remote must be an http(s) URL, got ${o.remote}`;
    }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) return `--port must be 0..65535, got ${o.port}`;
  if (!o.path.startsWith("/")) return `--path must start with /, got ${o.path}`;
  if (!Number.isFinite(o.idleSeconds) || o.idleSeconds < 0) return `--idle must be a number of seconds, got ${o.idleSeconds}`;
  return null;
}

export const USAGE = `webdevproxy — a development-only local web proxy for MCP servers.

  Lets the browser demos in this repository reach an omgbase MCP server (a
  remote gateway behind OAuth, or a local \`omg mcp\` process) from a Vite dev
  server without CORS or OAuth setup on the server side.

  !! dev-only; do not expose beyond localhost (it listens on ${LISTEN_HOST} and
     holds your bearer tokens) !!

usage:
  webdevproxy --local <workspace-dir> [--omg <omg entry or binary>]
  webdevproxy --remote <mcp-url> [--no-browser] [--token-file <file>]
  webdevproxy --logout [--remote <mcp-url>] [--token-file <file>]

options:
  --local <dir>        spawn \`omg mcp -C <dir>\` per browser session
  --omg <path>         the omg CLI: a .js entry (run with node) or a binary
                       (default: the monorepo's packages/cli build, else \`omg\` on PATH)
  --remote <url>       relay to a remote MCP endpoint; the proxy is the OAuth client
  --port <n>           listen on 127.0.0.1:<n> (default ${DEFAULT_PORT})
  --path <p>           the MCP endpoint path (default ${DEFAULT_PATH}); GET /whoami is always served
  --idle <seconds>     close a browser session (and its upstream: the \`omg mcp\` child or the
                       remote session) after this long without a request (default ${DEFAULT_IDLE_SECONDS};
                       0 = never). A page that comes back later gets 404 \`unknown session\` on its
                       next POST and must send \`initialize\` again — the demos in this repository do
                       that by themselves and retry the call once
  --origin <origin>    allow this browser origin too (repeatable; http://localhost:* and
                       http://127.0.0.1:* are always allowed)
  --no-browser         print the sign-in URL instead of opening a browser
  --token-file <file>  where the remote's tokens live (default ~/.config/omgbase-webdevproxy/<hash>.json)
  --logout             delete the token file(s) and exit
  --help               this text

keys (remote mode, when stdin is a terminal; each followed by Enter):
  a                    (re)open the sign-in in your browser and print its URL again; when none is
                       waiting, drop the tokens (the client registration stays) and sign in afresh
  l                    forget this server's tokens (= --logout) and sign in fresh, without a restart
  q                    close every session and quit

env: WEBDEVPROXY_LOCAL, WEBDEVPROXY_OMG, WEBDEVPROXY_REMOTE, WEBDEVPROXY_PORT, WEBDEVPROXY_PATH,
     WEBDEVPROXY_ORIGIN (comma-separated), WEBDEVPROXY_TOKEN_FILE, WEBDEVPROXY_NO_BROWSER
`;
