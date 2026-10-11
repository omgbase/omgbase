// The proxy end to end over a fake `omg mcp` (test/fixtures/fake-omg.mjs): a
// browser-shaped MCP client connects through the Streamable HTTP endpoint on an
// ephemeral port, the proxy spawns one stdio child per session and relays the
// JSON-RPC, /whoami describes it, and the CORS rules hold. No network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// The SDK types `sessionId?: string` on the class but `string` on the
// interface; under exactOptionalPropertyTypes connecting needs a cast.
const asTransport = (t: StreamableHTTPClientTransport): Transport => t as unknown as Transport;
import { UNKNOWN_SESSION_MESSAGE, logout, startProxy } from "../src/proxy.mjs";
import { tokenFilePath, legacyTokenFilePath, writeTokenFile, readTokenFile } from "../src/remote-auth.mjs";

const FAKE_OMG = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-omg.mjs");

let dir: string;
let proxy: Awaited<ReturnType<typeof startProxy>>;
const logs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-test-"));
  proxy = await startProxy({ local: join(dir, "ws"), omg: FAKE_OMG, port: 0, idleSeconds: 0, origins: ["https://demo.example.com"], log: (m: string) => logs.push(m) });
});
afterAll(async () => {
  await proxy.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("startProxy (local)", () => {
  it("listens on an ephemeral loopback port and describes itself on /whoami", async () => {
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.url).toBe(`http://localhost:${proxy.port}/mcp`);
    expect(proxy.mode).toBe("local");
    const res = await fetch(`http://127.0.0.1:${proxy.port}/whoami`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ mode: "local", upstream: `omg mcp -C ${join(dir, "ws")}`, identity: null, auth: { state: "none" }, tokenFile: null, sessions: [] });
    expect(logs.join("\n")).toMatch(/dev-only, 127\.0\.0\.1 only/);
  });

  it("relays a browser session to its own `omg mcp` child and ends it on DELETE", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(proxy.url));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(asTransport(transport));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
      const result = (await client.callTool({ name: "ping", arguments: {} })) as { content: { type: string; text: string }[] };
      const body = JSON.parse(result.content[0]!.text) as { workspace: string; pid: number };
      expect(body.workspace).toBe(join(dir, "ws"));
      const who = proxy.whoami();
      expect(who.sessions).toEqual([{ id: transport.sessionId, upstream: String(body.pid) }]);
      // A second browser session gets a second child.
      const t2 = new StreamableHTTPClientTransport(new URL(proxy.url));
      const c2 = new Client({ name: "test2", version: "0.0.0" });
      await c2.connect(asTransport(t2));
      const r2 = (await c2.callTool({ name: "ping", arguments: {} })) as { content: { type: string; text: string }[] };
      expect((JSON.parse(r2.content[0]!.text) as { pid: number }).pid).not.toBe(body.pid);
      expect(proxy.whoami().sessions).toHaveLength(2);
      await t2.terminateSession();
      await c2.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(proxy.whoami().sessions).toHaveLength(1);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(proxy.whoami().sessions).toEqual([]);
  });

  it("answers CORS for loopback and --origin origins only, and 404s other paths", async () => {
    const base = `http://127.0.0.1:${proxy.port}`;
    const ok = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "http://localhost:5174", "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
    expect(ok.headers.get("access-control-expose-headers")).toMatch(/mcp-session-id/);
    const extra = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://demo.example.com" } });
    expect(extra.status).toBe(204);
    expect(extra.headers.get("access-control-allow-origin")).toBe("https://demo.example.com");
    const denied = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const deniedPost = await fetch(`${base}/mcp`, { method: "POST", headers: { origin: "https://evil.example.com", "content-type": "application/json" }, body: "{}" });
    expect(deniedPost.status).toBe(403);
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    const noInit = await fetch(`${base}/mcp`, { method: "GET" });
    expect(noInit.status).toBe(400);
    // An id the proxy does not know (idle-expired, or the proxy restarted): 404 + -32000, and the message says what to do.
    const unknown = await fetch(`${base}/mcp`, { method: "POST", headers: { "mcp-session-id": "nope", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: UNKNOWN_SESSION_MESSAGE }, id: null });
    expect(UNKNOWN_SESSION_MESSAGE).toMatch(/send initialize again/);
  });

  it("refuses to start with nothing to proxy or with both modes", async () => {
    await expect(startProxy({ port: 0, log: () => {} })).rejects.toThrow(/nothing to proxy/);
    await expect(startProxy({ port: 0, local: "/x", remote: "https://mcp.example.com/omg", log: () => {} })).rejects.toThrow(/exclusive/);
  });
});

describe("logout", () => {
  it("deletes the server's file and the graph-ui legacy copy, or everything under both dirs", () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), "webdevproxy-logout-")) };
    try {
      const server = "https://mcp.example.com/omg";
      const other = "https://mcp.example.com/other";
      writeTokenFile(tokenFilePath(server, { env }), { serverUrl: server });
      writeTokenFile(legacyTokenFilePath(server, { env }), { serverUrl: server });
      writeTokenFile(tokenFilePath(other, { env }), { serverUrl: other });
      const messages: string[] = [];
      expect(logout({ remote: server, env }, (m: string) => messages.push(m)).sort()).toEqual([tokenFilePath(server, { env }), legacyTokenFilePath(server, { env })].sort());
      expect(readTokenFile(tokenFilePath(other, { env }))).toEqual({ serverUrl: other });
      expect(logout({ remote: server, env }, (m: string) => messages.push(m))).toEqual([]);
      expect(messages.at(-1)).toMatch(/nothing to forget for/);
      expect(logout({ env }, () => {})).toEqual([tokenFilePath(other, { env })]);
      expect(logout({ env }, () => {})).toEqual([]);
    } finally {
      rmSync(env.HOME, { recursive: true, force: true });
    }
  });
});
