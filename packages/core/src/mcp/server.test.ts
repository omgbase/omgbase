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

async function connect(rootPath?: string, onMutation?: () => void): Promise<void> {
  const base = rootPath ? { store, repoId, rootPath } : { store, repoId };
  const server = buildServer(onMutation ? { ...base, onMutation } : base);
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
    for (const t of ["docs_outline", "docs_read", "nodes_get", "nodes_get_many", "query", "query_syntax", "graph_syntax", "text_search", "resolve", "apply", "tasks_complete", "sections_append", "links_retarget", "docs_create", "docs_move", "docs_delete", "docs_set_meta", "graph_traverse", "graph_path", "history_node", "diff", "changes_since", "repos_status", "sync_status"]) {
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

  it("docs_read returns the whole file bytes plus properties grouped by source", async () => {
    const { payload } = (await call("docs_read", { path: "notes.md" })) as {
      payload: { path: string; content: string; properties: Record<string, Record<string, unknown>>; rev: string; ids?: unknown };
    };
    expect(payload.path).toBe("notes.md");
    expect(payload.content).toBe("---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n");
    expect(payload.properties.frontmatter).toEqual({ layer: "working" });
    expect(payload.ids).toBeUndefined();
  });

  it("docs_read include_ids adds the outline id map", async () => {
    const { payload } = (await call("docs_read", { path: "notes.md", include_ids: true })) as {
      payload: { ids: Record<string, string> };
    };
    expect(Object.keys(payload.ids).length).toBeGreaterThan(0);
  });

  it("docs_read maps a missing doc to doc_missing", async () => {
    const { payload, isError } = (await call("docs_read", { path: "nope.md" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("query select projects $body (whole document bytes) on docs", async () => {
    const { payload } = (await call("query", { from: "docs", filter: 'layer == "working"', select: ["$body"] })) as {
      payload: { hits: { path: string; $body: string }[] };
    };
    expect(payload.hits[0]!.$body).toContain("# Risks");
    expect(payload.hits[0]!.$body).toContain("---\nlayer: working\n---");
  });

  it("query returns projected hits with truncated + cursor", async () => {
    const { payload } = (await call("query", { from: "docs", filter: 'layer == "working"' })) as { payload: { hits: { path: string }[]; truncated: boolean } };
    expect(payload.hits.map((h) => h.path)).toEqual(["notes.md"]);
    expect(payload.truncated).toBe(false);
  });

  it("query select projects frontmatter onto hits", async () => {
    const { payload } = (await call("query", { from: "docs", filter: 'layer == "working"', select: ["layer"] })) as { payload: { hits: { path: string; layer: string }[] } };
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
    const { payload, isError } = (await call("query", { from: "docs", filter: "a + b == 1" })) as { payload: { error: string; data: { hint: string } }; isError: boolean };
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
    const { payload: q } = (await call("query", { from: "docs", filter: 'status == "draft"' })) as { payload: { hits: { path: string }[] } };
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
    const { payload } = (await call("query", { from: "docs", filter: 'layer == "working" && status == "active"' })) as { payload: { hits: { path: string }[] } };
    expect(payload.hits.map((h) => h.path)).toContain("notes.md");
  });

  it("docs_move renames the document", async () => {
    const { payload, isError } = (await call("docs_move", { doc: "notes.md", to_path: "moved/notes.md" })) as { payload: { path: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.path).toBe("moved/notes.md");
    const { payload: q } = (await call("query", { from: "docs", filter: 'layer == "working"' })) as { payload: { hits: { path: string }[] } };
    expect(q.hits.map((h) => h.path)).toContain("moved/notes.md");
  });

  it("docs_delete tombstones the document", async () => {
    const { isError } = (await call("docs_delete", { doc: "notes.md" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("query", { from: "docs", filter: 'layer == "working"' })) as { payload: { hits: unknown[] } };
    expect(payload.hits).toHaveLength(0);
  });
});

describe("onMutation fires for writes (embed-drain trigger)", () => {
  let root: string;
  let mutations: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "omg-mcpmut-"));
    writeFileSync(join(root, "notes.md"), "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n");
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n");
    mutations = 0;
    await connect(root, () => { mutations++; });
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not fire for a read (query)", async () => {
    await call("query", { from: "docs", filter: 'layer == "working"' });
    expect(mutations).toBe(0);
  });

  it("fires once for a successful apply", async () => {
    const { payload: q } = (await call("query", { from: "docs", filter: 'layer == "working"', select: ["$path"] })) as { payload: { hits: { id: string }[] } };
    const docId = q.hits[0]!.id;
    const { isError } = (await call("apply", { ops: [{ op: "insert", doc: docId, to: { parent: { doc: true }, at: "end" }, markdown: "appended paragraph" }] })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
  });

  it("does not fire for a failed apply (validation error)", async () => {
    const r = (await client.callTool({ name: "apply", arguments: { ops: [{ op: "update", markdown: "x" }] } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(mutations).toBe(0);
  });

  it("does not fire for a dry-run apply", async () => {
    const { payload: q } = (await call("query", { from: "docs", filter: 'layer == "working"', select: ["$path"] })) as { payload: { hits: { id: string }[] } };
    const docId = q.hits[0]!.id;
    const { isError } = (await call("apply", { ops: [{ op: "insert", doc: docId, to: { parent: { doc: true }, at: "end" }, markdown: "preview only" }], dry_run: true })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(0);
  });

  it("fires for a doc-level write (docs_set_meta)", async () => {
    const { isError } = (await call("docs_set_meta", { doc: "notes.md", set: { status: "active" } })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
  });
});

describe("apply op schema + sections_append heading resolution", () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "omg-mcpapply-"));
    writeFileSync(join(root, "notes.md"), "# Intro\n\nintro body\n\n## Launch\n\nlaunch note\n");
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    ingestFile(store, repoId, "notes.md", "# Intro\n\nintro body\n\n## Launch\n\nlaunch note\n");
    writeFileSync(join(root, "other.md"), "## Launch\n\nother launch\n");
    ingestFile(store, repoId, "other.md", "## Launch\n\nother launch\n");
    await connect(root);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("apply publishes a discriminated op schema (update requires `block`)", async () => {
    const tools = await client.listTools();
    const applyTool = tools.tools.find((t) => t.name === "apply")!;
    const opsSchema = (applyTool.inputSchema as unknown as { properties: { ops: { items: { anyOf?: unknown[]; oneOf?: unknown[] } } } }).properties.ops;
    const variants = (opsSchema.items.anyOf ?? opsSchema.items.oneOf) as { properties?: { op?: { const?: string } } }[];
    expect(variants, "ops.items should be a union of per-op schemas, not z.any()").toBeTruthy();
    const ops = new Set(variants.map((v) => v.properties?.op?.const));
    expect(ops).toEqual(new Set(["insert", "update", "move", "remove", "split", "merge"]));
  });

  it("apply rejects an update op missing `block` as a validation error, not block_missing", async () => {
    const r = (await client.callTool({ name: "apply", arguments: { ops: [{ op: "update", markdown: "x" }] } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    // The boundary schema names the missing field; it never reaches the engine's
    // block_missing path (which would misreport "block undefined not found").
    expect(r.content[0]!.text).toContain("block");
    expect(r.content[0]!.text).not.toContain("block_missing");
  });

  it("sections_append resolves heading text to a block id (unique)", async () => {
    const { isError } = (await call("sections_append", { heading: "Launch", markdown: "appended item", path: "notes.md" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { path: "notes.md" })) as { payload: { content: string } };
    expect(payload.content).toContain("appended item");
  });

  it("sections_append still accepts a heading block id", async () => {
    const { payload: outline } = (await call("docs_outline", { path: "notes.md" })) as { payload: { ids: Record<string, string> } };
    const launchId = Object.values(outline.ids).find((id) => id.startsWith("b"))!;
    void launchId;
    const { payload: read } = (await call("docs_read", { path: "notes.md", include_ids: true })) as { payload: { ids: Record<string, string> } };
    // pick the id whose block is the Launch heading via nodes_get
    let headingId = "";
    for (const id of Object.values(read.ids)) {
      const { payload } = (await call("nodes_get", { id, resolution: "raw" })) as { payload: { raw?: string } };
      if (payload.raw === "## Launch") { headingId = id; break; }
    }
    expect(headingId).not.toBe("");
    const { isError } = (await call("sections_append", { heading: headingId, markdown: "byid item" })) as { isError: boolean };
    expect(isError).toBe(false);
  });

  it("sections_append with ambiguous heading text errors ambiguous_heading with candidates", async () => {
    const { payload, isError } = (await call("sections_append", { heading: "Launch", markdown: "x" })) as {
      payload: { error: string; data: { candidates: { block: string; doc: string }[] } }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("ambiguous_heading");
    expect(payload.data.candidates.length).toBe(2);
  });

  it("sections_append with unknown heading text errors parent_missing", async () => {
    const { payload, isError } = (await call("sections_append", { heading: "Nonexistent", markdown: "x", path: "notes.md" })) as {
      payload: { error: string }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("parent_missing");
  });
});
