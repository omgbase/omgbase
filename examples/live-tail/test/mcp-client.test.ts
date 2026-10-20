// Session recovery: when the server forgets our session (the proxy after its
// idle timeout or a restart answers 404 `-32000 unknown session`), the client
// opens a fresh session and retries the call once — over a fake transport, no
// network.
import { describe, expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { OmgClient, OmgError, isSessionLost, whoamiUrl } from "../src/lib/mcp-client.ts";
import { NAMES_4, docLocator } from "../src/lib/paths.ts";

/** What the proxy's 404 looks like once the SDK has wrapped it. */
class FakeStreamableHTTPError extends Error {
  constructor(public code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
  }
}
const UNKNOWN_SESSION = new FakeStreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"unknown session (expired or the proxy restarted) — send initialize again"},"id":null}');

interface Call { method: string; name?: string; args?: Record<string, unknown> }

/** An MCP server with one tool (`ping`) and a switch that makes it forget the session. */
class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  calls: Call[] = [];
  closed = false;
  constructor(readonly name: string, readonly log: string[], readonly state: { lost: boolean; pings: number }) {}
  async start(): Promise<void> { this.log.push(`${this.name}: start`); }
  async close(): Promise<void> { this.closed = true; this.log.push(`${this.name}: close`); this.onclose?.(); }
  async send(message: JSONRPCMessage): Promise<void> {
    const msg = message as { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method) this.calls.push({ method: msg.method, ...(msg.params?.name ? { name: msg.params.name } : {}), ...(msg.params?.arguments ? { args: msg.params.arguments } : {}) });
    if (msg.method === "initialize") {
      this.state.lost = false;
      this.reply(msg.id!, { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
      return;
    }
    if (msg.method === "notifications/initialized") return;
    if (this.state.lost) throw UNKNOWN_SESSION; // a POST with a forgotten session id: the SDK rejects send()
    if (msg.method === "tools/call") {
      this.state.pings++;
      const text = msg.params?.name === "boom" ? JSON.stringify({ error: "tool_failed", message: "no" }) : JSON.stringify({ pong: this.state.pings, via: this.name });
      this.reply(msg.id!, { content: [{ type: "text", text }], isError: msg.params?.name === "boom" });
      return;
    }
    if (msg.method === "tools/list") { this.reply(msg.id!, { tools: [{ name: "ping", inputSchema: { type: "object" } }] }); return; }
    throw new Error(`unexpected ${msg.method}`);
  }
  private reply(id: number | string, result: unknown): void {
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, result } as JSONRPCMessage));
  }
}

function harness() {
  const log: string[] = [];
  const state = { lost: false, pings: 0 };
  const transports: FakeTransport[] = [];
  const lost: string[] = [];
  const client = new OmgClient({
    url: "/mcp",
    transportFactory: () => { const t = new FakeTransport(`t${transports.length + 1}`, log, state); transports.push(t); return t; },
    onSessionLost: (e) => lost.push(e.message),
  });
  return { client, log, state, transports, lost };
}

describe("isSessionLost", () => {
  it("recognises the SDK's 404 and the proxy's unknown-session body, nothing else", () => {
    expect(isSessionLost(UNKNOWN_SESSION)).toBe(true);
    expect(isSessionLost(new FakeStreamableHTTPError(404, "Error POSTing to endpoint (HTTP 404): Not Found"))).toBe(true);
    expect(isSessionLost(new Error('Error POSTing to endpoint: {"code":-32000,"message":"unknown session"}'))).toBe(true);
    expect(isSessionLost(new FakeStreamableHTTPError(500, "Error POSTing to endpoint: boom"))).toBe(false);
    expect(isSessionLost(new Error("network down"))).toBe(false);
    expect(isSessionLost("unknown session")).toBe(false);
  });
});

describe("OmgClient session recovery", () => {
  it("re-initializes against the same URL and retries the call once when the session is gone", async () => {
    const h = harness();
    const first = await h.client.call<{ pong: number; via: string }>("ping", {});
    expect(first).toEqual({ pong: 1, via: "t1" });
    expect(h.transports).toHaveLength(1);

    h.state.lost = true; // the proxy idled out (or restarted)
    const second = await h.client.call<{ pong: number; via: string }>("ping", {});
    expect(second).toEqual({ pong: 2, via: "t2" });
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(h.client.recoveries).toBe(1);
    expect(h.lost).toEqual([UNKNOWN_SESSION.message]);
    // The fresh session serves the calls that follow without another handshake.
    await h.client.call("ping", {});
    expect(h.transports).toHaveLength(2);
    expect(h.transports[1]!.calls.filter((c) => c.method === "tools/call")).toHaveLength(2);
  });

  it("shares one reconnect among concurrent failures", async () => {
    const h = harness();
    await h.client.call("ping", {});
    h.state.lost = true;
    const [a, b, c] = await Promise.all([h.client.call<{ via: string }>("ping", {}), h.client.call<{ via: string }>("ping", {}), h.client.call<{ via: string }>("ping", {})]);
    expect([a.via, b.via, c.via]).toEqual(["t2", "t2", "t2"]);
    expect(h.transports).toHaveLength(2); // three failures, one new session
  });

  it("surfaces the error when the retry fails too, and leaves other errors alone", async () => {
    const h = harness();
    await h.client.call("ping", {});
    // Lost, and the fresh session is forgotten again right after initialize.
    const t2lost = { armed: false };
    const orig = FakeTransport.prototype.send;
    FakeTransport.prototype.send = async function (this: FakeTransport, message: JSONRPCMessage) {
      const m = message as { method?: string };
      if (this.name === "t2" && m.method === "tools/call" && t2lost.armed) throw UNKNOWN_SESSION;
      return orig.call(this, message);
    };
    try {
      h.state.lost = true;
      t2lost.armed = true;
      await expect(h.client.call("ping", {})).rejects.toThrow(/unknown session/);
      expect(h.client.recoveries).toBe(1);
      expect(h.transports).toHaveLength(2);
    } finally {
      FakeTransport.prototype.send = orig;
    }
    // A tool error is not a lost session: no reconnect, the OmgError comes through.
    const h2 = harness();
    await expect(h2.client.call("boom", {})).rejects.toBeInstanceOf(OmgError);
    expect(h2.transports).toHaveLength(1);
    expect(h2.client.recoveries).toBe(0);
  });
});

describe("OmgClient.diffUnified — the tool and its locator", () => {
  it("calls `docs_diff_unified { _id | _path, from_rev, to_rev }` (the bare `id`/`path` under the 4.x names)", async () => {
    const h = harness();
    await h.client.diffUnified(docLocator("d_a"), "r_1", "r_2", "notes");
    await h.client.diffUnified(docLocator("/notes/alpha.md"), "r_1", "r_2", "notes");
    await h.client.diffUnified(docLocator("d_a", NAMES_4), "r_1", "r_2", "notes");
    await h.client.diffUnified(docLocator("/notes/alpha.md", NAMES_4), "r_1", "r_2", "notes");
    expect(h.transports[0]!.calls.filter((c) => c.method === "tools/call")).toEqual([
      { method: "tools/call", name: "docs_diff_unified", args: { _id: "d_a", from_rev: "r_1", to_rev: "r_2", repo: "notes" } },
      { method: "tools/call", name: "docs_diff_unified", args: { _path: "/notes/alpha.md", from_rev: "r_1", to_rev: "r_2", repo: "notes" } },
      { method: "tools/call", name: "docs_diff_unified", args: { id: "d_a", from_rev: "r_1", to_rev: "r_2", repo: "notes" } },
      { method: "tools/call", name: "docs_diff_unified", args: { path: "/notes/alpha.md", from_rev: "r_1", to_rev: "r_2", repo: "notes" } },
    ]);
  });
});

describe("whoamiUrl", () => {
  it("derives /whoami on the proxy's origin", () => {
    expect(whoamiUrl("/mcp", "http://localhost:5174/")).toBe("http://localhost:5174/whoami");
    expect(whoamiUrl("http://localhost:8788/mcp?x=1")).toBe("http://localhost:8788/whoami");
  });
});
