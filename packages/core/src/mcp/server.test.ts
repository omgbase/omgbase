import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { buildServer } from "./server.js";

let store: Store;
let repoId: string;
let client: Client;

async function connect(rootPath?: string): Promise<void> {
  const server = buildServer(rootPath ? { store, repoId, rootPath } : { store, repoId });
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
  it("lists the full tool surface", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    for (const t of ["docs_outline", "nodes_get", "nodes_get_many", "query", "query_syntax", "graph_syntax", "text_search", "resolve", "apply", "tasks_complete", "sections_append", "links_retarget", "docs_create", "docs_move", "docs_delete", "docs_set_meta", "graph_traverse", "graph_path", "history_node", "diff", "changes_since", "repos_status", "sync_status"]) {
      expect(names, `missing tool ${t}`).toContain(t);
    }
  });

  it("query_syntax and graph_syntax return reference docs", async () => {
    const { payload: q } = (await call("query_syntax", {})) as { payload: { syntax: string } };
    expect(q.syntax).toContain("$path.startsWith");
    expect(q.syntax).toContain("select");
    const { payload: g } = (await call("graph_syntax", {})) as { payload: { syntax: string } };
    expect(g.syntax).toContain("DOC-GRAIN");
    expect(g.syntax).toContain("nodeInfo");
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

  it("query select projects frontmatter onto hits", async () => {
    const { payload } = (await call("query", { from: "documents", filter: 'layer == "working"', select: ["layer"] })) as { payload: { hits: { path: string; layer: string }[] } };
    expect(payload.hits[0]!.layer).toBe("working");
  });

  it("query semantic without a provider yields semantic_unavailable", async () => {
    const { payload, isError } = (await call("query", { from: "blocks", semantic: "identity across edits" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("semantic_unavailable");
  });

  it("nodes_get hydrates a block by id at a resolution", async () => {
    const { payload: outline } = (await call("docs_outline", { path: "notes.md" })) as { payload: { ids: Record<string, string> } };
    const headingId = outline.ids.b01!;
    const { payload } = (await call("nodes_get", { path: "notes.md", id: headingId, resolution: "raw" })) as { payload: { raw: string } };
    expect(payload.raw).toBe("# Risks");
  });

  it("nodes_get infers the document from a block id alone (no doc/path)", async () => {
    const { payload: outline } = (await call("docs_outline", { path: "notes.md" })) as { payload: { ids: Record<string, string> } };
    const headingId = outline.ids.b01!;
    const { payload, isError } = (await call("nodes_get", { id: headingId, resolution: "raw" })) as { payload: { raw: string }; isError: boolean };
    expect(isError).toBe(false);
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

describe("doc-level MCP tools (docs_create/move/delete/set_meta)", () => {
  let root: string;

  beforeEach(async () => {
    // These tools write to disk, so use a real rootPath with the seed file.
    root = mkdtempSync(join(tmpdir(), "omg-mcpdoc-"));
    writeFileSync(join(root, "notes.md"), "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n");
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n");
    await connect(root);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("docs_create makes a new document with frontmatter", async () => {
    const { payload, isError } = (await call("docs_create", {
      path: "sub/fresh.md",
      markdown: "# Fresh\n\nbody\n",
      frontmatter: { title: "Fresh", status: "draft" },
    })) as { payload: { docId: string; path: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.path).toBe("sub/fresh.md");
    const { payload: q } = (await call("query", { from: "documents", filter: 'status == "draft"' })) as { payload: { hits: { path: string }[] } };
    expect(q.hits.map((h) => h.path)).toContain("sub/fresh.md");
  });

  it("docs_create fails path_taken on an existing path", async () => {
    const { payload, isError } = (await call("docs_create", { path: "notes.md", markdown: "# x\n" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("path_taken");
  });

  it("docs_set_meta patches frontmatter, preserving other keys", async () => {
    const { isError } = (await call("docs_set_meta", { doc: "notes.md", set: { status: "active", priority: 2 } })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("query", { from: "documents", filter: 'layer == "working" && status == "active"' })) as { payload: { hits: { path: string }[] } };
    expect(payload.hits.map((h) => h.path)).toContain("notes.md");
  });

  it("docs_move renames the document", async () => {
    const { payload, isError } = (await call("docs_move", { doc: "notes.md", to_path: "moved/notes.md" })) as { payload: { path: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.path).toBe("moved/notes.md");
    const { payload: q } = (await call("query", { from: "documents", filter: 'layer == "working"' })) as { payload: { hits: { path: string }[] } };
    expect(q.hits.map((h) => h.path)).toContain("moved/notes.md");
  });

  it("docs_delete tombstones the document", async () => {
    const { isError } = (await call("docs_delete", { doc: "notes.md" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("query", { from: "documents", filter: 'layer == "working"' })) as { payload: { hits: unknown[] } };
    expect(payload.hits).toHaveLength(0);
  });
});
