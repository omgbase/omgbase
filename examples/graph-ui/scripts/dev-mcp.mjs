#!/usr/bin/env node
// A local MCP bridge: spawns `omg mcp` (stdio) for a workspace and serves it
// over the MCP Streamable HTTP transport on localhost, with CORS so the Vite
// page can talk to it. One child per MCP session (the browser's `initialize`
// opens one; closing the tab or an idle timeout ends it), JSON-RPC relayed
// verbatim in both directions — the same shape as usergenic/stdio-mcp-to-http,
// which could not be reused because it is not on npm and sends no CORS headers.
//
//   node scripts/dev-mcp.mjs [--port 8787] [--path /mcp] [--workspace <dir>] [--omg <main.js>] [--idle 600]
//   env: OMG, GRAPH_UI_WORKSPACE (same as dev-workspace.mjs)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OMG, WORKSPACE } from "./dev-workspace.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

export function startBridge({
  port = Number(arg("port", process.env.GRAPH_UI_MCP_PORT ?? "8787")),
  path = arg("path", "/mcp"),
  workspace = arg("workspace", WORKSPACE),
  omg = arg("omg", OMG),
  idleSeconds = Number(arg("idle", "600")),
  log = (m) => console.error(`[mcp-bridge] ${m}`),
} = {}) {
  const sessions = new Map(); // sessionId → { http, child, timer }

  const cors = (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  const touch = (session) => {
    if (!idleSeconds) return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      log(`session ${session.id} idle for ${idleSeconds}s — closing`);
      void session.http.close();
    }, idleSeconds * 1000);
  };

  async function openSession() {
    const child = new StdioClientTransport({ command: process.execPath, args: [omg, "mcp", "-C", workspace], stderr: "inherit" });
    const session = { id: null, http: null, child, timer: null };
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        log(`session ${id} opened (omg mcp pid ${child.pid})`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        clearTimeout(session.timer);
        log(`session ${id} closed`);
      },
    });
    session.http = http;
    http.onmessage = (msg) => {
      touch(session);
      child.send(msg).catch((err) => log(`→ child failed: ${err.message}`));
    };
    child.onmessage = (msg) => {
      http.send(msg).catch((err) => log(`→ client failed: ${err.message}`));
    };
    http.onclose = () => {
      if (session.id) sessions.delete(session.id);
      clearTimeout(session.timer);
      void child.close();
    };
    child.onclose = () => {
      log(`omg mcp exited${session.id ? ` (session ${session.id})` : ""}`);
      void http.close();
    };
    child.onerror = (err) => log(`child error: ${err.message}`);
    await child.start();
    await http.start();
    return session;
  }

  const server = createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", hint: `the MCP endpoint is ${path}` }));
      return;
    }
    try {
      const sid = req.headers["mcp-session-id"];
      const existing = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (existing) {
        touch(existing);
        await existing.http.handleRequest(req, res);
        return;
      }
      if (req.method === "POST" && !sid) {
        // The SDK transport validates that this first POST is `initialize`.
        const session = await openSession();
        touch(session);
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
    server.listen(port, "127.0.0.1", () => {
      log(`serving omg mcp -C ${workspace}`);
      log(`MCP endpoint: http://localhost:${port}${path}`);
      resolve({
        url: `http://localhost:${port}${path}`,
        close: async () => {
          for (const s of [...sessions.values()]) await s.http.close().catch(() => undefined);
          await new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const bridge = await startBridge();
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
