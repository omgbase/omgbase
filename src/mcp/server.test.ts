import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { buildServer } from "./server.js";

let store: Store;
let repoId: string;
let client: Client;

async function connect(): Promise<void> {
  const server = buildServer({ store, repoId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
}

function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  return client.callTool({ name, arguments: args }).then((r) => {
    const res = r as { content: { text: string }[]; isError?: boolean };
    const payload = JSON.parse(res.content[0]!.text);
    return { payload, isError: res.isError ?? false };
  });
}

beforeEach(async () => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
  ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n");
  await connect();
});
afterEach(() => store.close());

describe("MCP server skeleton", () => {
  it("lists the read tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["docs_outline", "nodes_get", "nodes_get_many", "query", "text_search"]);
  });

  it("docs_outline returns the outline with an ids table", async () => {
    const { payload } = (await call("docs_outline", { path: "notes.md" })) as { payload: { text: string; ids: Record<string, string> } };
    expect(payload.text).toContain("§");
    expect(Object.keys(payload.ids).length).toBeGreaterThan(0);
  });

  it("query returns projected hits with truncated + cursor", async () => {
    const { payload } = (await call("query", { from: "documents", filter: 'layer == "working"' })) as { payload: { hits: { path: string }[]; truncated: boolean } };
    expect(payload.hits.map((h) => h.path)).toEqual(["notes.md"]);
    expect(payload.truncated).toBe(false);
  });

  it("nodes_get hydrates a block by id at a resolution", async () => {
    const { payload: outline } = (await call("docs_outline", { path: "notes.md" })) as { payload: { ids: Record<string, string> } };
    const headingId = outline.ids.b01!;
    const { payload } = (await call("nodes_get", { path: "notes.md", id: headingId, resolution: "raw" })) as { payload: { raw: string } };
    expect(payload.raw).toBe("# Risks");
  });

  it("text_search returns bm25 hits", async () => {
    const { payload } = (await call("text_search", { q: "identity" })) as { payload: { hits: unknown[] } };
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  it("maps a bad filter to filter_invalid with reason + hint", async () => {
    const { payload, isError } = (await call("query", { from: "documents", filter: "a + b == 1" })) as { payload: { error: string; data: { hint: string } }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("filter_invalid");
    expect(payload.data.hint).toContain("10");
  });

  it("maps a missing doc to doc_missing", async () => {
    const { payload, isError } = (await call("docs_outline", { path: "nope.md" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });
});
