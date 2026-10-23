// Session recovery (after live-tail's test): when the server forgets our session
// the client opens a fresh one and retries once — over a fake transport, no
// network. Plus the two envelopes this demo adds: the profile's `unknown tool`
// JSON-RPC error becomes an OmgError("unknown_tool"), and `retriable` is kept.
import { describe, expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { OmgClient, OmgError, applyArgs, applyEffects, isSessionLost, isUnknownTool, repoArg, whoamiUrl } from "../src/lib/mcp-client.ts";

class FakeStreamableHTTPError extends Error {
  constructor(public code: number, message: string) {
    super(`Streamable HTTP error: ${message}`);
  }
}
const UNKNOWN_SESSION = new FakeStreamableHTTPError(404, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"unknown session (expired or the proxy restarted) — send initialize again"},"id":null}');

interface Call { method: string; name?: string; args?: Record<string, unknown> }

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
    const msg = message as { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method) this.calls.push({ method: msg.method, ...(msg.params?.name ? { name: msg.params.name } : {}), ...(msg.params?.arguments ? { args: msg.params.arguments } : {}) });
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
      if (name === "apply") {
        // The Receipt (spec/mutate §11.7) for whatever effects came in; a wrong CAS is the kernel's stale_expectation.
        const effects = (msg.params?.arguments?.effects ?? []) as { expect?: { content_hash?: string } }[];
        if (effects.some((e) => e.expect?.content_hash === "stale")) {
          this.reply(msg.id!, { content: [{ type: "text", text: JSON.stringify({ error: "stale_expectation", message: "block b_160 changed: expected content_hash stale", data: { op_index: 0, block: "b_160", expected_content_hash: "stale", current: { _hash: "h9", markdown: "- [x] x" }, retriable: true }, retriable: true }) }], isError: true });
          return;
        }
        this.reply(msg.id!, { content: [{ type: "text", text: JSON.stringify({ plan_id: "p_1", commit: "c_31", revisions: [{ _id: "d_7", _path: "processes/calcination.md", _hash: "f1" }], new_ids: {}, committed: true, summary: ["set _attrs.checked = true on b_160"] }) }] });
        return;
      }
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
  it("apply(effects, { reason, repo }) sends apply { effects, reason, repo } — a key only when it has a value — and returns the Receipt; a stale CAS is the error envelope", async () => {
    const h = harness();
    const effect = { op: "set", target: { kind: "block", _id: "b_160" }, field: "_attrs.checked", value: true, expect: { content_hash: "h0" } };
    const receipt = await h.client.apply([effect], { reason: "repo-explorer task toggle", repo: null });
    expect(receipt).toMatchObject({ plan_id: "p_1", commit: "c_31", committed: true, revisions: [{ _id: "d_7", _path: "processes/calcination.md", _hash: "f1" }] });
    const call = h.transports[0]!.calls.find((c) => c.name === "apply");
    expect(call?.args).toEqual({ effects: [effect], reason: "repo-explorer task toggle" });
    await h.client.apply([effect], { repo: "alchemy" });
    expect(h.transports[0]!.calls.filter((c) => c.name === "apply")[1]!.args).toEqual({ effects: [effect], repo: "alchemy" });
    expect(applyArgs([effect])).toEqual({ effects: [effect] });
    // The same shape through the Caller interface the feature modules take.
    await applyEffects(h.client, [effect], { reason: "r" });
    expect(h.transports[0]!.calls.filter((c) => c.name === "apply")[2]!.args).toEqual({ effects: [effect], reason: "r" });
    const stale = await h.client.apply([{ ...effect, expect: { content_hash: "stale" } }]).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(OmgError);
    expect(stale as OmgError).toMatchObject({ code: "stale_expectation", retriable: true, data: { current: { _hash: "h9" } } });
  });
});
