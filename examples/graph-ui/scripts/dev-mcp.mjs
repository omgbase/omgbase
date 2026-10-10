#!/usr/bin/env node
// A local MCP bridge: serves the MCP Streamable HTTP transport on localhost
// (with CORS, so the Vite page can talk to it; Vite also proxies /mcp here)
// and relays JSON-RPC verbatim, one upstream per browser session, to either
//
//   • `omg mcp -C <workspace>` over stdio (the local sample; default), or
//   • a remote omg MCP gateway (`--remote <url>`), where the bridge itself is
//     the OAuth client — a native app with a loopback redirect, dynamic client
//     registration, PKCE and a refresh token kept in a 0600 file under
//     ~/.config/omgbase-graph-ui/ — so the browser needs no CORS on the gateway
//     and Auth0 needs no web origins. See scripts/lib/remote-auth.mjs.
//
// The stdio shape is the same as usergenic/stdio-mcp-to-http, which could not
// be reused because it is not on npm and sends no CORS headers.
//
//   node scripts/dev-mcp.mjs [--port 8787] [--path /mcp] [--idle 600]
//                            [--workspace <dir>] [--omg <main.js>]            # local sample
//                            [--remote <mcp-url>] [--no-browser] [--token-file <f>] [--logout]
//   env: OMG, GRAPH_UI_WORKSPACE, GRAPH_UI_MCP_PORT, GRAPH_UI_REMOTE, GRAPH_UI_TOKEN_FILE, GRAPH_UI_NO_BROWSER
//
//   GET /whoami → { mode, upstream, identity, auth, sessions } for the page's settings panel.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OMG, WORKSPACE } from "./dev-workspace.mjs";
import { RemoteAuth, configDir, deleteTokenFile, listTokenFiles, tokenFilePath } from "./lib/remote-auth.mjs";
import { SessionTable } from "./lib/sessions.mjs";

// ---- arguments ---------------------------------------------------------------------

const VALUE_FLAGS = ["port", "path", "idle", "workspace", "omg", "remote", "token-file"];
const BOOL_FLAGS = ["logout", "no-browser"];
/** Flags only the bridge understands; dev.mjs strips these before handing argv to Vite (Vite keeps its 5173). */
const BRIDGE_ONLY = ["port", "path", "idle", "workspace", "omg", "remote", "token-file", "logout", "no-browser"];

/** Parse the bridge's flags (+ env fallbacks); `rest` is argv without the bridge-only flags. */
export function parseBridgeArgs(argv = process.argv.slice(2), env = process.env) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && VALUE_FLAGS.includes(name) && argv[i + 1] !== undefined) {
      flags[name] = argv[++i];
      if (!BRIDGE_ONLY.includes(name)) rest.push(a, flags[name]);
    } else if (name && BOOL_FLAGS.includes(name)) {
      flags[name] = true;
    } else {
      rest.push(a);
    }
  }
  const remote = flags.remote ?? (env.GRAPH_UI_REMOTE?.trim() || null);
  return {
    port: Number(flags.port ?? env.GRAPH_UI_MCP_PORT ?? "8787"),
    path: flags.path ?? "/mcp",
    idleSeconds: Number(flags.idle ?? "600"),
    workspace: flags.workspace ?? WORKSPACE,
    omg: flags.omg ?? OMG,
    remote,
    tokenFile: flags["token-file"] ?? (env.GRAPH_UI_TOKEN_FILE?.trim() || null),
    noBrowser: Boolean(flags["no-browser"]) || Boolean(env.GRAPH_UI_NO_BROWSER?.trim()),
    logout: Boolean(flags.logout),
    rest,
  };
}

// ---- upstreams ---------------------------------------------------------------------

/** The local sample: one `omg mcp` child per session. */
function stdioUpstream({ omg, workspace }) {
  return async () => {
    const child = new StdioClientTransport({ command: process.execPath, args: [omg, "mcp", "-C", workspace], stderr: "inherit" });
    await child.start();
    return {
      transport: child,
      describe: () => `omg mcp pid ${child.pid}`,
      upstreamId: () => (child.pid ? String(child.pid) : undefined),
      terminate: () => child.close(),
    };
  };
}

/** A remote gateway: one upstream Streamable HTTP session per browser session, bearer added per request. */
function remoteUpstream(remote) {
  return async () => {
    const transport = new StreamableHTTPClientTransport(new URL(remote.serverUrl), { fetch: remote.fetchWithAuth() });
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

// ---- the bridge ---------------------------------------------------------------------

export async function startBridge(opts = {}) {
  const o = { ...parseBridgeArgs(), ...opts };
  const log = o.log ?? ((m) => console.error(`[mcp-bridge] ${m}`));
  const path = o.path;

  /** @type {RemoteAuth | null} */
  let remote = null;
  if (o.remote) {
    remote = await new RemoteAuth({ serverUrl: o.remote, file: o.tokenFile ?? undefined, log, noBrowser: o.noBrowser }).start();
  }
  const makeUpstream = remote ? remoteUpstream(remote) : stdioUpstream(o);

  const sessions = new SessionTable({
    idleMs: o.idleSeconds * 1000,
    onIdle: (session) => { log(`session ${session.id} idle for ${o.idleSeconds}s — closing`); void session.http.close(); },
  });

  const cors = (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

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
    up.transport.onerror = (err) => log(`upstream error: ${err.message}`);
    await http.start();
    return session;
  }

  const whoami = () => ({
    mode: remote ? "remote" : "local",
    upstream: remote ? remote.serverUrl : `omg mcp -C ${o.workspace}`,
    identity: remote ? remote.identity() : null,
    auth: remote ? { ...remote.status, issuer: remote.status.issuer ?? remote.issuer() } : { state: "none" },
    tokenFile: remote ? remote.file : null,
    sessions: sessions.describe(),
  });

  const server = createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/whoami" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(whoami()));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", hint: `the MCP endpoint is ${path}; GET /whoami describes the bridge` }));
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
      res.writeHead(sid ? 404 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sid ? "unknown session" : "send initialize first" }, id: null }));
    } catch (err) {
      log(`request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "bridge error" }, id: null }));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(o.port, "127.0.0.1", () => {
      log(remote ? `proxying to ${remote.serverUrl} (tokens: ${remote.file})` : `serving omg mcp -C ${o.workspace}`);
      log(`MCP endpoint: http://localhost:${o.port}${path}  (GET /whoami for status)`);
      // Sign in (or refresh) right away so the browser opens at startup, not on the first query.
      const ready = remote ? remote.ensure().catch(() => undefined) : Promise.resolve();
      resolve({
        url: `http://localhost:${o.port}${path}`,
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

/** `--logout`: delete the token file for `--remote` (or every one under the config dir). */
export function logout({ remote, tokenFile }, log = (m) => console.error(m)) {
  const files = remote ? [tokenFile ?? tokenFilePath(remote)] : listTokenFiles(configDir());
  if (!files.length) { log(`nothing to forget under ${configDir()}`); return; }
  for (const f of files) log(deleteTokenFile(f) ? `deleted ${f}` : `no token file at ${f}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseBridgeArgs();
  if (o.logout) {
    logout(o);
    process.exit(0);
  }
  const bridge = await startBridge(o);
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
