import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer } from "./server.js";

let store: Store;
let repoId: string;
let client: Client;

async function connect(
  rootPath?: string,
  onMutation?: () => void,
  embedQuery?: (text: string) => Promise<{ model: string; vec: Float32Array }>,
): Promise<void> {
  const base = rootPath ? { store, repoId, rootPath } : { store, repoId };
  const withHooks = {
    ...base,
    ...(onMutation ? { onMutation } : {}),
    ...(embedQuery ? { embedQuery } : {}),
  };
  const server = buildServer(withHooks);
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
    for (const t of ["docs_outline", "docs_read", "nodes_get", "nodes_get_many", "query", "query_syntax", "graph_syntax", "text_search", "resolve", "apply", "tasks_complete", "node_set", "sections_append", "links_retarget", "links_stale", "links_repair", "docs_create", "docs_move", "docs_delete", "docs_set_meta", "graph_traverse", "graph_path", "history_node", "diff", "docs_read_at", "docs_history", "changes_since", "repos_status", "sync_status"]) {
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

  it("docs_outline returns the outline with full block ids inline", async () => {
    const { payload } = (await call("docs_outline", { path: "notes.md" })) as { payload: { text: string; ids?: unknown } };
    expect(payload.text).toContain("§");
    expect(payload.text).toMatch(/^b_[0-9a-z]+ /m);
    expect(payload.ids).toBeUndefined();
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

  it("docs_read include_ids adds the ordered block ids", async () => {
    const { payload } = (await call("docs_read", { path: "notes.md", include_ids: true })) as {
      payload: { ids: string[] };
    };
    expect(payload.ids.length).toBeGreaterThan(0);
    expect(payload.ids[0]).toMatch(/^b_/);
  });

  it("docs_read maps a missing doc to doc_missing", async () => {
    const { payload, isError } = (await call("docs_read", { path: "nope.md" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("docs_read_at time-travels to an earlier revision's exact bytes", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    // Edit the doc so the current revision differs from rev1.
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n\nA freshly added tail paragraph.\n");
    const { payload } = (await call("docs_read_at", { path: "notes.md", rev: rev1 })) as {
      payload: { content: string; rev: string; renderedHashMatch: boolean };
    };
    expect(payload.content).toBe("---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n");
    expect(payload.rev).toBe(rev1);
    expect(payload.renderedHashMatch).toBe(true);
  });

  it("docs_read_at with an unknown revision maps to target_missing", async () => {
    const { payload, isError } = (await call("docs_read_at", { path: "notes.md", rev: "r_nope" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("target_missing");
  });

  // Ref-resolution audit: doc-ref tools accept a d_ id OR a path in `doc`
  // (findDocByRef), and never silent-empty on an unresolvable ref.
  it("docs_read / docs_outline accept a d_ id in the `doc` field", async () => {
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='notes.md'").get() as { doc_id: string }).doc_id;
    const { payload: read } = (await call("docs_read", { doc: docId })) as { payload: { path: string } };
    expect(read.path).toBe("notes.md");
    const { payload: outline } = (await call("docs_outline", { doc: docId })) as { payload: { text: string } };
    expect(outline.text).toContain("§");
  });

  it("docs_read / docs_outline accept a PATH in the `doc` field (id-or-path symmetry)", async () => {
    const { payload: read } = (await call("docs_read", { doc: "notes.md" })) as { payload: { path: string } };
    expect(read.path).toBe("notes.md");
    const { payload: outline } = (await call("docs_outline", { doc: "notes.md" })) as { payload: { text: string } };
    expect(outline.text).toContain("§");
  });

  it("docs_read_at accepts a PATH in the `doc` field", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    const { payload } = (await call("docs_read_at", { doc: "notes.md", rev: rev1 })) as { payload: { rev: string } };
    expect(payload.rev).toBe(rev1);
  });

  it("a d_-shaped id that doesn't exist maps to doc_missing (loud, not path-fallthrough)", async () => {
    const { payload, isError } = (await call("docs_read", { doc: "d_0000000" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("diff resolves a PATH in `doc` and returns the real block-grain diff (not silent-empty)", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n\nAdded tail.\n");
    const rev2 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    const { payload, isError } = (await call("diff", { doc: "notes.md", from_rev: rev1, to_rev: rev2 })) as {
      payload: { kind: string }[]; isError: boolean;
    };
    expect(isError).toBe(false);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.some((e) => e.kind === "added")).toBe(true);
  });

  it("diff with an unresolvable doc errors doc_missing (not an empty diff)", async () => {
    const { payload, isError } = (await call("diff", { doc: "nope.md", from_rev: "r_a", to_rev: "r_b" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("docs_history lists per-doc version history for a path glob", async () => {
    ingestFile(store, repoId, "journal/x.md", "# X\n\nfirst version of x here\n");
    ingestFile(store, repoId, "journal/x.md", "# X\n\nsecond version of x here\n");
    ingestFile(store, repoId, "journal/y.md", "# Y\n\nonly version of y\n");
    ingestFile(store, repoId, "other/z.md", "# Z\n");
    const { payload } = (await call("docs_history", { path_glob: "journal/*" })) as {
      payload: { docs: { path: string; versions: { seq: number; isCurrent: boolean }[] }[]; truncated: boolean };
    };
    expect(payload.docs.map((d) => d.path)).toEqual(["journal/x.md", "journal/y.md"]);
    const x = payload.docs.find((d) => d.path === "journal/x.md")!;
    expect(x.versions.length).toBe(2);
    expect(x.versions[0]!.seq).toBeLessThan(x.versions[1]!.seq);
    expect(x.versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(x.versions[x.versions.length - 1]!.isCurrent).toBe(true);
  });

  it("docs_history without path_glob or doc is a validation error", async () => {
    const { payload, isError } = (await call("docs_history", {})) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("target_missing");
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

  it("resolve embeds the query when a provider is configured (hybrid, not FTS-only)", async () => {
    store.close();
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", "/tmp");
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n");
    let embeddedWith: string | undefined;
    await connect(undefined, undefined, async (text: string) => {
      embeddedWith = text;
      return { model: "test-1", vec: new Float32Array([0, 1, 0, 0]) };
    });
    await call("resolve", { query: "why isn't severity shown to artists" });
    expect(embeddedWith).toBe("why isn't severity shown to artists");
  });

  it("nodes_get hydrates a block by id at a resolution", async () => {
    const { payload: read } = (await call("docs_read", { path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const headingId = read.ids[0]!;
    const { payload } = (await call("nodes_get", { path: "notes.md", id: headingId, resolution: "raw" })) as { payload: { raw: string } };
    expect(payload.raw).toBe("# Risks");
  });

  it("nodes_get infers the document from a block id alone (no doc/path)", async () => {
    const { payload: read } = (await call("docs_read", { path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const headingId = read.ids[0]!;
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

  it("docs_move / docs_set_meta accept a d_ id in `doc` too (id-or-path regression)", async () => {
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='notes.md'").get() as { doc_id: string }).doc_id;
    const { isError: metaErr } = (await call("docs_set_meta", { doc: docId, set: { status: "byid" } })) as { isError: boolean };
    expect(metaErr).toBe(false);
    const { payload, isError } = (await call("docs_move", { doc: docId, to_path: "moved/byid.md" })) as { payload: { path: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.path).toBe("moved/byid.md");
  });
});

describe("link health MCP tools (links_stale / links_repair)", () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "omg-mcplinks-"));
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    // Ingest via checkpoint so the edge index is populated (edge extraction is
    // wired in the sync path, not plain ingestFile).
    writeFileSync(join(root, "a.md"), "# A\n\nSee [b](/b.md) and <https://example.com/x>.\n");
    processCheckpoint(store, repoId, root, [{ path: "a.md" }]);
    await connect(root);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("links_stale returns the LinkHealth shape with a dangling doc link", async () => {
    const { payload, isError } = (await call("links_stale", {})) as {
      payload: { stale: { target: string; srcPath: string; reason: string }[]; externalCount: number; totalOpenEdges: number; truncated: boolean };
      isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.stale).toHaveLength(1);
    expect(payload.stale[0]!.target).toBe("b.md");
    expect(payload.stale[0]!.srcPath).toBe("a.md");
    expect(payload.stale[0]!.reason).toBe("dangling_doc");
    expect(payload.externalCount).toBeGreaterThanOrEqual(1);
    expect(payload.truncated).toBe(false);
  });

  it("links_repair dry_run previews, commit rewrites and clears the stale link", async () => {
    // Give the repair a real destination doc so the edge re-resolves.
    await call("docs_create", { path: "c.md", markdown: "# C\n" });

    const { payload: dry, isError: dryErr } = (await call("links_repair", {
      from_target: "/b.md", to_target: "/c.md", dry_run: true,
    })) as { payload: { hits: unknown[]; applied: boolean }; isError: boolean };
    expect(dryErr).toBe(false);
    expect(dry.applied).toBe(false);
    expect(dry.hits).toHaveLength(1);
    // Still stale — dry run did not write.
    const { payload: mid } = (await call("links_stale", {})) as { payload: { stale: unknown[] } };
    expect(mid.stale).toHaveLength(1);

    const { isError: commitErr } = (await call("links_repair", {
      from_target: "/b.md", to_target: "/c.md", dry_run: false,
    })) as { isError: boolean };
    expect(commitErr).toBe(false);
    const { payload: after } = (await call("links_stale", {})) as { payload: { stale: unknown[] } };
    expect(after.stale).toHaveLength(0);
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
    const { payload: read } = (await call("docs_read", { path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    // pick the id whose block is the Launch heading via nodes_get
    let headingId = "";
    for (const id of read.ids) {
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
