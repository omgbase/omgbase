// Session recovery (after live-tail's test): when the server forgets our session
// the client opens a fresh one and retries once — over a fake transport, no
// network. Plus the two envelopes this demo adds: the profile's `unknown tool`
// JSON-RPC error becomes an OmgError("unknown_tool"), and `retriable` is kept.
import { describe, expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { OmgClient, OmgError, isSessionLost, isUnknownTool, repoArg, whoamiUrl } from "../src/lib/mcp-client.ts";

class FakeStreamableHTTPError extends Error {
  constructor(public code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
  }
}
const UNKNOWN_SESSION = new FakeStreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"unknown session (expired or the proxy restarted) — send initialize again"},"id":null}');

interface Call { method: string; name?: string }

const MINIMAL = ["docs_read", "docs_tree", "query_syntax", "query", "blocks_resolve", "apply", "plan", "execute", "changes_since", "version"];

/** An MCP server with the minimal listing, one answering tool (`version`) and a switch that makes it forget the session. */
class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  calls: Call[] = [];
  closed = false;
  constructor(readonly name: string, readonly state: { lost: boolean; n: number }) {}
  async start(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; this.onclose?.(); }
  async send(message: JSONRPCMessage): Promise<void> {
    const msg = message as { id?: number | string; method?: string; params?: { name?: string } };
    if (msg.method) this.calls.push({ method: msg.method, ...(msg.params?.name ? { name: msg.params.name } : {}) });
    if (msg.method === "initialize") {
      this.state.lost = false;
      this.reply(msg.id!, { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
      return;
    }
    if (msg.method === "notifications/initialized") return;
    if (this.state.lost) throw UNKNOWN_SESSION;
    if (msg.method === "tools/call") {
      const name = msg.params?.name ?? "";
      if (!MINIMAL.includes(name)) { this.error(msg.id!, -32602, `unknown tool ${name}`); return; }
      this.state.n++;
      if (name === "plan") { this.reply(msg.id!, { content: [{ type: "text", text: JSON.stringify({ error: "stale_plan", message: "moved on", data: { fix: "{}" }, retriable: true }) }], isError: true }); return; }
      this.reply(msg.id!, { content: [{ type: "text", text: JSON.stringify({ n: this.state.n, via: this.name, profile: "minimal" }) }] });
      return;
    }
    if (msg.method === "tools/list") { this.reply(msg.id!, { tools: MINIMAL.map((n) => ({ name: n, inputSchema: { type: "object" } })) }); return; }
    throw new Error(`unexpected ${msg.method}`);
  }
  private reply(id: number | string, result: unknown): void {
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, result } as JSONRPCMessage));
  }
  private error(id: number | string, code: number, message: string): void {
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id, error: { code, message } } as JSONRPCMessage));
  }
}

function harness() {
  const state = { lost: false, n: 0 };
  const transports: FakeTransport[] = [];
  const lost: string[] = [];
  const client = new OmgClient({
    url: "/mcp",
    transportFactory: () => { const t = new FakeTransport(`t${transports.length + 1}`, state); transports.push(t); return t; },
    onSessionLost: (e) => lost.push(e.message),
  });
  return { client, state, transports, lost };
}

describe("isSessionLost / isUnknownTool", () => {
  it("recognise the SDK's 404 and the proxy's body; the JSON-RPC unknown-tool text", () => {
    expect(isSessionLost(UNKNOWN_SESSION)).toBe(true);
    expect(isSessionLost(new Error('Error POSTing to endpoint: {"code":-32000,"message":"unknown session"}'))).toBe(true);
    expect(isSessionLost(new FakeStreamableHTTPError(500, "boom"))).toBe(false);
    expect(isSessionLost("unknown session")).toBe(false);
    expect(isUnknownTool(new Error("MCP error -32602: unknown tool repos"))).toBe(true);
    expect(isUnknownTool(new Error("network down"))).toBe(false);
  });
});

describe("OmgClient", () => {
  it("re-initializes against the same URL and retries the call once when the session is gone", async () => {
    const h = harness();
    expect(await h.client.call<{ via: string }>("version", {})).toMatchObject({ via: "t1" });
    h.state.lost = true;
    expect(await h.client.call<{ via: string }>("version", {})).toMatchObject({ via: "t2" });
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(h.client.recoveries).toBe(1);
    expect(h.lost).toEqual([UNKNOWN_SESSION.message]);
  });
  it("lists the tools and turns the profile's `unknown tool` into OmgError(unknown_tool)", async () => {
    const h = harness();
    expect(await h.client.tools()).toEqual(MINIMAL);
    const err = await h.client.call("repos", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmgError);
    expect((err as OmgError).code).toBe("unknown_tool");
    expect((err as OmgError).message).toMatch(/does not list the tool `repos`/);
    expect(h.transports).toHaveLength(1); // not a lost session: no reconnect
  });
  it("decodes the error envelope with data and retriable", async () => {
    const h = harness();
    const err = await h.client.call("plan", { effects: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmgError);
    expect(err as OmgError).toMatchObject({ code: "stale_plan", message: "moved on", data: { fix: "{}" }, retriable: true });
  });
  it("repoArg names a repo only when one is chosen; whoamiUrl derives /whoami on the proxy's origin", () => {
    expect(repoArg(null)).toEqual({});
    expect(repoArg("")).toEqual({});
    expect(repoArg("alchemy")).toEqual({ repo: "alchemy" });
    expect(whoamiUrl("/mcp", "http://localhost:5175/")).toBe("http://localhost:5175/whoami");
    expect(whoamiUrl("http://localhost:8789/mcp?x=1")).toBe("http://localhost:8789/whoami");
  });
});
