import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectHttpEngine, fromWireObserve, parseEngineSpec, type McpEngineClient } from "./mcp-engine-client.js";

// connectHttpEngine (client Streamable-HTTP transport). Stands up a real MCP
// server over HTTP mounted at an arbitrary secret-prefixed base path, then
// proves the client (a) reaches it through that full path and (b) forwards
// custom `-H` headers on every request.

describe("connectHttpEngine (Streamable HTTP)", () => {
  let http: Server;
  let baseUrl: string;
  let engine: McpEngineClient | null = null;
  const seenAuth: (string | undefined)[] = [];

  beforeEach(async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    // Echoes back the custom header the request carried, so the client can
    // assert its `-H` value survived the round-trip.
    server.registerTool(
      "whoami",
      { description: "echo the request's X-Test header", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ seen: seenAuth.at(-1) ?? null }) }] }),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // Cast past the SDK's exactOptionalPropertyTypes friction (onclose etc.).
    await server.connect(transport as unknown as Transport);

    http = createServer((req, res) => {
      seenAuth.push(typeof req.headers["x-test"] === "string" ? (req.headers["x-test"] as string) : undefined);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? (JSON.parse(raw) as unknown) : undefined;
        void transport.handleRequest(req, res, body);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    // Arbitrary secret-prefixed base path — the whole URL must be used verbatim.
    baseUrl = `http://127.0.0.1:${port}/k/biguglysecret/mcp`;
  });

  afterEach(async () => {
    await engine?.close();
    engine = null;
    await new Promise<void>((resolve) => http.close(() => resolve()));
    seenAuth.length = 0;
  });

  it("lists the server's tools once on connect, so hasTool answers synchronously (spec/surface §4 \"Profiles\")", async () => {
    engine = await connectHttpEngine({ url: baseUrl });
    expect([...(await engine.listTools())]).toEqual(["whoami"]);
    expect(engine.hasTool("whoami")).toBe(true);
    expect(engine.hasTool("blocks_insert")).toBe(false);
  });

  it("connects through the secret base path and forwards -H headers", async () => {
    engine = await connectHttpEngine({ url: baseUrl, headers: { "X-Test": "hi" } });
    const res = await engine.callTool<{ seen: string | null }>("whoami", {});
    expect(res.seen).toBe("hi");
    // Every request the client made carried the custom header (initialize + call).
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((h) => h === "hi")).toBe(true);
  });

  it("connects with no extra headers", async () => {
    engine = await connectHttpEngine({ url: baseUrl });
    const res = await engine.callTool<{ seen: string | null }>("whoami", {});
    expect(res.seen).toBeNull();
  });
});

// parseEngineSpec — the url-vs-command rule every `--server` consumer shares
// (`omg --server`, `omg sync --server`, `omgbase-sync --server`). The property
// that matters: an http(s) URL classifies as HTTP and is never turned into a
// command to spawn (`omg sync --server <url>` used to do exactly that).
describe("parseEngineSpec (--server rule)", () => {
  it("an http(s) URL is an HTTP endpoint, used verbatim, never a spawn", () => {
    const url = "https://host.example/k/biguglysecret/mcp";
    expect(parseEngineSpec(url)).toEqual({ kind: "http", url });
    expect(parseEngineSpec(" HTTP://localhost:8080/mcp ")).toEqual({ kind: "http", url: "HTTP://localhost:8080/mcp" });
  });

  it("attaches headers to an HTTP spec (and omits the key when there are none)", () => {
    expect(parseEngineSpec("http://h/mcp", { Authorization: "Bearer x" })).toEqual({
      kind: "http",
      url: "http://h/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(parseEngineSpec("http://h/mcp", {})).toEqual({ kind: "http", url: "http://h/mcp" });
  });

  it("anything else is whitespace-split into a stdio command", () => {
    expect(parseEngineSpec("  omg mcp -C /vault ")).toEqual({ kind: "stdio", command: "omg", args: ["mcp", "-C", "/vault"] });
    expect(parseEngineSpec("omgbase-mcp")).toEqual({ kind: "stdio", command: "omgbase-mcp", args: [] });
  });

  it("rejects headers for a stdio command, and an empty spec", () => {
    expect(() => parseEngineSpec("omg mcp", { "X-A": "1" })).toThrow(/http\(s\)/);
    expect(() => parseEngineSpec("   ")).toThrow(/empty/);
  });
});

// The wire under surface 5.0 ("underscore = engine", spec/surface §1.2, §3–§4;
// spec/sync 3.0 §6): a result key that carries a row attribute is spelled as
// the attribute (`_id`, `_path`, `_hash`, `_raw`), an argument that addresses
// one too (`docs_read { _path }`), while a role keeps its name (`observe_many
// { files[].path }`, `observe_delete { path }` — a file event's path). A fake
// engine built on the SDK's low-level Server (no tool schemas, so the raw
// arguments reach the handler) answers in those shapes and records what the
// client asked; the client's `EngineClient` contract keeps the library's
// `docId`/`path`.
describe("McpEngineClient speaks surface 5.0", () => {
  let mcp: McpLowLevelServer | null = null;
  let httpServer: Server;
  let engine: McpEngineClient | null = null;
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  const DIGEST = { commit: "c_1", seq: 1, ts: "2026-10-20T00:00:00.000Z", origin: "api", actor: null, summary: "create /a.md", revisions: [{ _id: "d_1", _path: "/a.md", _hash: "ab".repeat(32) }] };

  beforeEach(async () => {
    mcp = new McpLowLevelServer({ name: "fake-engine", version: "0.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["observe_many", "observe_delete", "changes_since", "docs_read"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name, args });
      const json = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], isError });
      switch (name) {
        case "observe_many":
          return json((args.files as { path: string }[]).map((f) => ({ _id: "d_1", _path: f.path, rev: "r_1", commitId: "c_1", converged: true, echo: false, conflicted: false, dispositions: [] })));
        case "observe_delete":
          return json({ _id: "d_1", _path: args.path, deleted: true });
        case "changes_since":
          return json({ digests: [DIGEST], cursor: 1, truncated: false, head: 1 });
        case "docs_read":
          // 5.0 has no tolerance: a bare `path` is an argument error naming the `_` spelling.
          if ("path" in args) return json({ error: "filter_invalid", message: "`path` is not an argument — the document's path is `_path` (an engine field: the bare namespace is the user's)", data: { hint: "arguments", fix: { _path: args.path } } }, true);
          return json({ _id: "d_1", _path: args._path, rev: "r_1", properties: { frontmatter: {}, inline: {}, computed: {} }, _raw: "# A\n" });
        default:
          return json({ error: "unknown_tool", message: `unknown tool ${name}` }, true);
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcp.connect(transport as unknown as Transport);
    httpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        void transport.handleRequest(req, res, raw ? (JSON.parse(raw) as unknown) : undefined);
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    engine = await connectHttpEngine({ url: `http://127.0.0.1:${port}/mcp` });
  });

  afterEach(async () => {
    await engine?.close();
    engine = null;
    await mcp?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    calls.length = 0;
  });

  it("readDoc asks `docs_read { _path }` and reads `_raw` (a bare `path` would be refused)", async () => {
    const doc = await engine!.readDoc("a.md");
    expect(calls.at(-1)).toEqual({ name: "docs_read", args: { _path: "a.md" } });
    expect(doc).toEqual({ content: "# A\n", contentHash: createHash("sha256").update("# A\n", "utf8").digest("hex") });
  });

  it("observe_many / observe_delete keep `path` as the argument (a file event's path is a role) and map the result's `_id`/`_path` to the library's `docId`/`path`", async () => {
    const out = await engine!.observeMany([{ path: "a.md", content: "# A\n" }]);
    expect(calls.at(-1)).toEqual({ name: "observe_many", args: { files: [{ path: "a.md", content: "# A\n" }] } });
    expect(out).toEqual([{ docId: "d_1", path: "a.md", rev: "r_1", commitId: "c_1", converged: true, echo: false, conflicted: false, dispositions: [] }]);
    const d = await engine!.observeDelete("a.md");
    expect(calls.at(-1)).toEqual({ name: "observe_delete", args: { path: "a.md" } });
    expect(d).toEqual({ docId: "d_1", path: "a.md", deleted: true });
  });

  it("changes_since revisions arrive as `{ _id, _path, _hash }` — the row's engine names, which the coordinator reads", async () => {
    const page = await engine!.changesSince(0);
    expect(calls.at(-1)).toEqual({ name: "changes_since", args: { cursor: 0 } });
    expect(page.digests[0]!.revisions).toEqual([{ _id: "d_1", _path: "/a.md", _hash: "ab".repeat(32) }]);
  });
});

describe("fromWireObserve", () => {
  it("renames the wire's `_id`/`_path` to the library's `docId`/`path` and keeps the rest", () => {
    type Deleted = { docId: string | null; path: string; deleted: boolean };
    expect(fromWireObserve<Deleted>({ _id: "d_1", _path: "/a.md", deleted: true })).toEqual({ docId: "d_1", path: "/a.md", deleted: true });
    expect(fromWireObserve<Deleted>({ _id: null, _path: "/gone.md", deleted: false })).toEqual({ docId: null, path: "/gone.md", deleted: false });
  });
});
