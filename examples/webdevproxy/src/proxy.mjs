// The proxy itself: serves the MCP Streamable HTTP transport on 127.0.0.1 (with
// CORS for loopback dev origins; Vite also proxies /mcp here) and relays
// JSON-RPC verbatim, one upstream per browser session, to either
//
//   • `omg mcp -C <workspace>` over stdio (`--local`), or
//   • a remote MCP gateway (`--remote <url>`), where the proxy itself is the
//     OAuth client — a native app with a loopback redirect, dynamic client
//     registration (or one pre-registered public client, `--client-id`;
//     `--reset-client` forgets a stored registration the gateway no longer
//     knows), PKCE and a refresh token kept in a 0600 file under
//     ~/.config/omgbase-webdevproxy/
//     — so the browser needs no CORS on the gateway and the identity provider
//     needs no web origins. See remote-auth.mjs.
//
// The stdio shape is the same as usergenic/stdio-mcp-to-http, which could not
// be reused because it is not on npm and sends no CORS headers.
//
//   GET /whoami → { mode, upstream, identity, auth, tokenFile, sessions } for a page's status line.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LISTEN_HOST, omgCommand, parseArgs, validateArgs } from "./args.mjs";
import { allowOrigin, corsHeaders } from "./cors.mjs";
import { RemoteAuth, configDir, deleteTokenFile, legacyConfigDir, legacyTokenFilePath, listTokenFiles, tokenFilePath } from "./remote-auth.mjs";
import { SessionTable } from "./sessions.mjs";

/** The 404 body's message for a session id this proxy does not know (expired or restarted). */
export const UNKNOWN_SESSION_MESSAGE = "unknown session (expired or the proxy restarted) — send initialize again";

/** SDK messages for the optional GET notification stream being unavailable. */
const NO_STREAM = /Failed to (open|reconnect) SSE stream|Maximum reconnection attempts/;

// ---- upstreams ---------------------------------------------------------------------

/** `--local`: one `omg mcp` child per session. */
function stdioUpstream({ omg, local }) {
  const { command, args } = omgCommand(omg);
  return async () => {
    const child = new StdioClientTransport({ command, args: [...args, "mcp", "-C", local], stderr: "inherit" });
    await child.start();
    return {
      transport: child,
      describe: () => `omg mcp pid ${child.pid}`,
      upstreamId: () => (child.pid ? String(child.pid) : undefined),
      terminate: () => child.close(),
    };
  };
}

/** `--remote`: one upstream Streamable HTTP session per browser session, bearer added per request. */
function remoteUpstream(remote) {
  return async () => {
    // The standalone GET notification stream is optional in Streamable HTTP; a
    // gateway may decline it (405 per spec, 404 from rmcp behind host-my-mcp).
    // Requests and responses ride POST regardless, so never retry the GET.
    const transport = new StreamableHTTPClientTransport(new URL(remote.serverUrl), {
      fetch: remote.fetchWithAuth(),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await transport.start();
    return {
      transport,
      describe: () => `${remote.serverUrl} session ${transport.sessionId ?? "(pending)"}`,
      upstreamId: () => transport.sessionId,
      // The browser ended its session: end ours at the gateway too, then drop the transport.
      terminate: async () => { await transport.terminateSession().catch(() => undefined); await transport.close(); },
      // After `initialize`, the upstream wants the negotiated version on every request.
      onInitialized: (result) => { if (typeof result?.protocolVersion === "string") transport.setProtocolVersion(result.protocolVersion); },
    };
  };
}

// ---- the proxy ---------------------------------------------------------------------

/**
 * Start the proxy. `options` are `parseArgs()`' fields (any subset; the rest
 * come from argv/env), plus `log`. Resolves once listening, with
 * `{ url, port, path, mode, remote, whoami(), ready, close() }` (`remote` is the
 * RemoteAuth in remote mode — bin/webdevproxy.mjs hands it to the terminal
 * prompt — else null). Nothing here reads stdin.
 * @param {Partial<import("./args.mjs").ProxyArgs> & { log?: (m: string) => void, argv?: string[], env?: Record<string, string | undefined>,
 *   openBrowser?: (url: string) => Promise<boolean> }} [options]   `openBrowser` replaces the system browser (the tests' fake user)
 */
export async function startProxy(options = {}) {
  const { log: logOpt, argv, env = process.env, openBrowser: open, ...overrides } = options;
  const o = { ...parseArgs(argv ?? [], env), ...overrides };
  const problem = validateArgs(o);
  if (problem) throw new Error(problem);
  const log = logOpt ?? ((m) => console.error(`[webdevproxy] ${m}`));
  const path = o.path;

  /** @type {RemoteAuth | null} */
  let remote = null;
  if (o.remote) {
    remote = await new RemoteAuth({ serverUrl: o.remote, file: o.tokenFile ?? undefined, clientId: o.clientId ?? null, callbackPort: o.callbackPort ?? null, resetClient: Boolean(o.resetClient), log, noBrowser: o.noBrowser, env, ...(open ? { openBrowser: open } : {}) }).start();
  }
  const makeUpstream = remote ? remoteUpstream(remote) : stdioUpstream(o);

  const sessions = new SessionTable({
    idleMs: o.idleSeconds * 1000,
    onIdle: (session) => { log(`session ${session.id} idle for ${o.idleSeconds}s — closing`); void session.http.close(); },
  });

  async function openSession() {
    const up = await makeUpstream();
    const session = { id: null, http: null, up, timer: null, initId: undefined, upstreamId: up.upstreamId };
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.add(session);
        log(`session ${id} opened (${up.describe()})`);
      },
      onsessionclosed: (id) => {
        sessions.remove(id);
        log(`session ${id} closed by the client`);
        void up.terminate();
      },
    });
    session.http = http;
    http.onmessage = (msg) => {
      if (session.id) sessions.touch(session);
      if (msg && msg.method === "initialize" && msg.id !== undefined) session.initId = msg.id;
      up.transport.send(msg).catch((err) => {
        log(`→ upstream failed: ${err.message}`);
        // Answer the browser's request so it does not hang on a dead upstream.
        if (msg && msg.id !== undefined && msg.method) {
          http.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `upstream: ${err.message}` } }).catch(() => undefined);
        }
      });
    };
    up.transport.onmessage = (msg) => {
      if (session.initId !== undefined && msg && msg.id === session.initId && "result" in msg) {
        up.onInitialized?.(msg.result);
        session.initId = undefined;
      }
      http.send(msg).catch((err) => log(`→ client failed: ${err.message}`));
    };
    http.onclose = () => {
      if (session.id) sessions.remove(session.id);
      void up.transport.close();
    };
    up.transport.onclose = () => {
      log(`upstream closed${session.id ? ` (session ${session.id})` : ""}`);
      void http.close();
    };
    // A declined notification stream is not an error worth repeating: say so once per session.
    let noStreamNoted = false;
    up.transport.onerror = (err) => {
      if (NO_STREAM.test(err.message)) {
        if (!noStreamNoted) { noStreamNoted = true; log(`upstream offers no GET notification stream (${err.message.replace(/^.*: /, "")}); requests continue over POST`); }
        return;
      }
      log(`upstream error: ${err.message}`);
    };
    await http.start();
    return session;
  }

  const whoami = () => ({
    mode: remote ? "remote" : "local",
    upstream: remote ? remote.serverUrl : `omg mcp -C ${o.local}`,
    identity: remote ? remote.identity() : null,
    // `client`: which OAuth client the proxy presents — `--client-id` (`configured`) or the file's registration (`registered`, `id` null before the first one).
    auth: remote ? { ...remote.status, issuer: remote.status.issuer ?? remote.issuer(), client: remote.client() } : { state: "none" },
    tokenFile: remote ? remote.file : null,
    sessions: sessions.describe(),
  });

  const server = createServer(async (req, res) => {
    const origin = allowOrigin(typeof req.headers.origin === "string" ? req.headers.origin : undefined, o.origins);
    if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS") { res.writeHead(origin ? 204 : 403); res.end(); return; }
    if (url.pathname === "/whoami" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(whoami()));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", hint: `the MCP endpoint is ${path}; GET /whoami describes the proxy` }));
      return;
    }
    if (req.headers.origin && !origin) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `origin ${req.headers.origin} is not allowed (add --origin)` }, id: null }));
      return;
    }
    try {
      const sid = req.headers["mcp-session-id"];
      const existing = sessions.get(sid);
      if (existing) {
        sessions.touch(existing);
        await existing.http.handleRequest(req, res);
        return;
      }
      if (req.method === "POST" && !sid) {
        // The SDK transport validates that this first POST is `initialize`.
        const session = await openSession();
        await session.http.handleRequest(req, res);
        return;
      }
      // 404 is the Streamable HTTP signal to start over with `initialize` (the
      // session expired after --idle seconds, or this proxy restarted); -32000
      // is kept so an existing client's matcher still fires. Say what to do.
      res.writeHead(sid ? 404 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sid ? UNKNOWN_SESSION_MESSAGE : "send initialize first" }, id: null }));
    } catch (err) {
      log(`request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "proxy error" }, id: null }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, LISTEN_HOST, () => {
      const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      const url = `http://localhost:${port}${path}`;
      log(remote ? `proxying to ${remote.serverUrl} (tokens: ${remote.file})` : `serving omg mcp -C ${o.local} (${o.omg})`);
      log(`MCP endpoint: ${url}  (GET /whoami for status; dev-only, ${LISTEN_HOST} only)`);
      // Sign in (or refresh) right away so the browser opens at startup, not on the first query.
      const ready = remote ? remote.ensure().catch(() => undefined) : Promise.resolve();
      resolve({
        url,
        port,
        path,
        mode: remote ? "remote" : "local",
        remote,
        whoami,
        ready,
        close: async () => {
          for (const s of sessions.values()) await s.http.close().catch(() => undefined);
          await remote?.close();
          await new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

/**
 * `--logout`: delete the token file for `--remote` (and the graph-ui bridge's
 * legacy copy), or every one under both config dirs.
 * @param {{ remote?: string | null, tokenFile?: string | null, env?: Record<string, string | undefined> }} o
 * @param {(m: string) => void} [log]
 * @returns {string[]} the files deleted
 */
export function logout({ remote, tokenFile, env = process.env }, log = (m) => console.error(m)) {
  const files = remote
    ? [tokenFile ?? tokenFilePath(remote, { env }), ...(tokenFile ? [] : [legacyTokenFilePath(remote, { env })])]
    : tokenFile ? [tokenFile] : [...listTokenFiles(configDir(env)), ...listTokenFiles(legacyConfigDir(env))];
  const deleted = [];
  for (const f of files) {
    if (deleteTokenFile(f)) { deleted.push(f); log(`deleted ${f}`); }
  }
  if (!deleted.length) log(`nothing to forget${remote ? ` for ${remote}` : ` under ${configDir(env)}`}`);
  return deleted;
}
