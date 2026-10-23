import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, MINIMAL_TOOLS, PLAN_MEMORY, PROFILES, TOOLS_PROFILES, parseToolsProfile, unknownTool } from "./server.js";
import { QUERY_SYNTAX, QUERY_SYNTAX_CARD, QUERY_SYNTAX_SECTIONS } from "./reference.js";

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
    for (const t of ["docs_tree", "docs_list", "docs_outline", "docs_read", "docs_read_many", "blocks_read", "blocks_read_many", "nodes_block_read", "query", "query_syntax", "graph", "blocks_search", "blocks_resolve", "apply", "blocks_insert", "blocks_update", "blocks_move", "blocks_remove", "blocks_split", "blocks_merge", "blocks_check", "nodes_set", "blocks_append", "docs_append", "links_retarget", "links_stale", "links_repair", "docs_create", "docs_move", "docs_delete", "docs_set_meta", "docs_update", "blocks_history", "docs_diff", "docs_diff_unified", "docs_read_at", "docs_history", "changes_since", "repos_status", "sync_status"]) {
      expect(names, `missing tool ${t}`).toContain(t);
    }
  });

  it("query_syntax serves the card, one chapter, or the whole manual; an unknown section is an argument error with a fix (5.1)", async () => {
    const { payload: card } = (await call("query_syntax", {})) as { payload: { syntax: string; sections: string[] } };
    expect(card.syntax).toBe(QUERY_SYNTAX_CARD);
    expect(card.syntax.length).toBeLessThan(4000);
    expect(card.sections).toEqual(QUERY_SYNTAX_SECTIONS.map((s) => s.slug));
    expect(Object.keys(card)).toEqual(["syntax", "sections"]);
    const { payload: follow } = (await call("query_syntax", { section: "follow" })) as { payload: { section: string; syntax: string } };
    expect(Object.keys(follow)).toEqual(["section", "syntax"]);
    expect(follow.section).toBe("follow");
    expect(follow.syntax.startsWith("## Graph traversal (follow) and links\n")).toBe(true);
    expect(follow.syntax).toContain("follow _out_links { from _dst depth 3 }");
    expect(follow.syntax).not.toContain("## semantic grain");
    expect(follow.syntax.endsWith("compiles to a follow query.)\n")).toBe(true);
    const { payload: all } = (await call("query_syntax", { section: "all" })) as { payload: { section: string; syntax: string } };
    expect(all.section).toBe("all");
    expect(all.syntax).toBe(QUERY_SYNTAX);
    expect(all.syntax).toContain("path.startsWith");
    const { payload: bad, isError } = (await call("query_syntax", { section: "folow" })) as { payload: { error: string; message: string; data: { hint: string; fix: string } }; isError: boolean };
    expect(isError).toBe(true);
    expect(bad.error).toBe("filter_invalid");
    expect(bad.message).toBe("unknown section `folow`; the sections are sugar, paths, targets, scoping, scalars, predicates, nested, select, flatten, order, follow, semantic, examples, all (query_syntax takes section?)");
    expect(bad.data).toEqual({ reason: bad.message, hint: "arguments", fix: "{\"section\":\"follow\"}" });
    const { payload: far } = (await call("query_syntax", { section: "grammar" })) as { payload: { data: { fix: string } } };
    expect(far.data.fix).toBe("{\"section\":\"all\"}");
  });

  it("docs_tree rolls up to directories by default; files lists lean document rows; updated adds _updated_at (5.1)", async () => {
    ingestFile(store, repoId, "projects/a.md", "# a\n");
    ingestFile(store, repoId, "projects/deep/b.md", "# b\n\ntext\n");
    const { payload } = (await call("docs_tree", {})) as {
      payload: { prefix: string; depth: number; total: { docs: number; blocks: number }; files_here: number; entries: Record<string, unknown>[]; truncated: boolean; cursor: string | null };
    };
    expect(Object.keys(payload)).toEqual(["prefix", "depth", "total", "files_here", "entries", "truncated", "cursor"]);
    expect(payload.prefix).toBe("/");
    expect(payload.depth).toBe(1);
    expect(payload.total.docs).toBe(3);
    expect(payload.files_here).toBe(1);
    expect(payload.entries).toEqual([{ _path: "/projects/", docs: 2, blocks: 3 }]);
    expect(payload.truncated).toBe(false);
    expect(payload.cursor).toBeNull();

    const { payload: deep } = (await call("docs_tree", { depth: 2 })) as { payload: { entries: Record<string, unknown>[] } };
    expect(deep.entries).toEqual([{ _path: "/projects/", docs: 2, blocks: 3 }, { _path: "/projects/deep/", docs: 1, blocks: 2 }]);

    const { payload: scoped } = (await call("docs_tree", { path: "projects", files: true, limit: 1 })) as { payload: { files_here: number; entries: Record<string, unknown>[]; truncated: boolean; cursor: string | null } };
    expect(scoped.files_here).toBe(1);
    expect(scoped.entries).toEqual([{ _id: expect.stringMatching(/^d_/), _path: "/projects/a.md", blocks: 1 }]);
    expect(scoped.truncated).toBe(true);
    const { payload: rest } = (await call("docs_tree", { path: "projects", files: true, limit: 1, cursor: scoped.cursor })) as { payload: { entries: Record<string, unknown>[]; truncated: boolean } };
    expect(rest.entries).toEqual([{ _path: "/projects/deep/", docs: 1, blocks: 2 }]);
    expect(rest.truncated).toBe(false);

    const { payload: updated } = (await call("docs_tree", { files: true, updated: true })) as { payload: { entries: Record<string, unknown>[] } };
    expect(updated.entries.map((e) => Object.keys(e))).toEqual([["_id", "_path", "blocks", "_updated_at"], ["_path", "docs", "blocks", "_updated_at"]]);
    expect(updated.entries.every((e) => typeof e._updated_at === "string")).toBe(true);
  });

  it("docs_list is a page under the uniform list contract (items + truncated + cursor)", async () => {
    ingestFile(store, repoId, "b.md", "# b\n");
    ingestFile(store, repoId, "c.md", "# c\n");
    const { payload } = (await call("docs_list", { limit: 2 })) as { payload: { items: { _id: string; _path: string; _updated_at: string | null; blocks: number }[]; truncated: boolean; cursor: string | null } };
    expect(payload.items.map((r) => r._path)).toEqual(["/b.md", "/c.md"]);
    expect(payload.truncated).toBe(true);
    expect(payload.cursor).not.toBeNull();
    const { payload: next } = (await call("docs_list", { limit: 2, cursor: payload.cursor })) as { payload: { items: { _path: string }[]; truncated: boolean; cursor: string | null } };
    expect(next.items.map((r) => r._path)).toEqual(["/notes.md"]);
    expect(next.truncated).toBe(false);
    expect(next.cursor).toBeNull();

    const { payload: bad, isError } = (await call("docs_list", { cursor: "garbage" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(bad.error).toBe("filter_invalid");
  });

  it("docs_outline returns the outline with full block ids inline", async () => {
    const { payload } = (await call("docs_outline", { _path: "notes.md" })) as { payload: { text: string; ids?: unknown } };
    expect(payload.text).toContain("§");
    expect(payload.text).toMatch(/^b_[0-9a-z]+ /m);
    expect(payload.ids).toBeUndefined();
  });

  it("docs_read returns the whole file bytes plus properties grouped by source", async () => {
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as {
      payload: { _id: string; _path: string; _raw: string; properties: Record<string, Record<string, unknown>>; rev: string; ids?: unknown };
    };
    expect(payload._path).toBe("/notes.md");
    expect(payload._raw).toBe("---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n");
    expect(payload.properties.frontmatter).toEqual({ layer: "working" });
    expect(payload.ids).toBeUndefined();
  });

  it("docs_read include_ids adds the ordered block ids", async () => {
    const { payload } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[] };
    };
    expect(payload.ids.length).toBeGreaterThan(0);
    expect(payload.ids[0]).toMatch(/^b_/);
  });

  it("docs_read maps a missing doc to doc_missing", async () => {
    const { payload, isError } = (await call("docs_read", { _path: "nope.md" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("docs_read_many hydrates several docs and lands misses in errors", async () => {
    ingestFile(store, repoId, "guide.md", "# Guide\n\nread me first\n");
    const { payload, isError } = (await call("docs_read_many", { docs: ["notes.md", "guide.md", "nope.md"] })) as {
      payload: { items: { _path: string; _raw: string }[]; errors: { ref: string; error: string }[]; truncated: boolean };
      isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.items.map((i) => i._path)).toEqual(["/notes.md", "/guide.md"]);
    expect(payload.items[1]!._raw).toBe("# Guide\n\nread me first\n");
    expect(payload.errors).toEqual([{ ref: "nope.md", error: "doc_not_found" }]);
    expect(payload.truncated).toBe(false);
  });

  it("docs_read_many collapses duplicate refs and supports include_ids", async () => {
    const { payload } = (await call("docs_read_many", { docs: ["notes.md", "notes.md"], include_ids: true })) as {
      payload: { items: { _path: string; ids: string[] }[] };
    };
    expect(payload.items.map((i) => i._path)).toEqual(["/notes.md"]);
    expect(payload.items[0]!.ids.length).toBeGreaterThan(0);
  });

  it("docs_read_at time-travels to an earlier revision's exact bytes", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    // Edit the doc so the current revision differs from rev1.
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n\nA freshly added tail paragraph.\n");
    const { payload } = (await call("docs_read_at", { _path: "notes.md", rev: rev1 })) as {
      payload: { _raw: string; rev: string; renderedHashMatch: boolean };
    };
    expect(payload._raw).toBe("---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n");
    expect(payload.rev).toBe(rev1);
    expect(payload.renderedHashMatch).toBe(true);
  });

  it("docs_read_at with an unknown revision maps to target_missing", async () => {
    const { payload, isError } = (await call("docs_read_at", { _path: "notes.md", rev: "r_nope" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("target_missing");
  });

  // Ref-resolution audit: doc-ref tools accept a d_ id OR a path (`_id` / `_path`)
  // (findDocByRef), and never silent-empty on an unresolvable ref.
  it("docs_read / docs_outline take a d_ id as `_id`", async () => {
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='notes.md'").get() as { doc_id: string }).doc_id;
    const { payload: read } = (await call("docs_read", { _id: docId })) as { payload: { _path: string } };
    expect(read._path).toBe("/notes.md");
    const { payload: outline } = (await call("docs_outline", { _id: docId })) as { payload: { text: string } };
    expect(outline.text).toContain("§");
  });

  it("docs_read / docs_outline take a path as `_path`", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _path: string } };
    expect(read._path).toBe("/notes.md");
    const { payload: outline } = (await call("docs_outline", { _path: "notes.md" })) as { payload: { text: string } };
    expect(outline.text).toContain("§");
  });

  it("docs_read_at takes a path as `_path`", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    const { payload } = (await call("docs_read_at", { _path: "notes.md", rev: rev1 })) as { payload: { rev: string } };
    expect(payload.rev).toBe(rev1);
  });

  it("a d_-shaped id that doesn't exist maps to doc_missing (loud, not path-fallthrough)", async () => {
    const { payload, isError } = (await call("docs_read", { _id: "d_0000000" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("docs_diff resolves `_path` and returns the real block-grain diff (not silent-empty)", async () => {
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    ingestFile(store, repoId, "notes.md", "---\nlayer: working\n---\n\n# Risks\n\nStable identity is hard.\n\n- [ ] decide write-back\n\nAdded tail.\n");
    const rev2 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='notes.md'").get() as { current_rev: string }).current_rev;
    const { payload, isError } = (await call("docs_diff", { _path: "notes.md", from_rev: rev1, to_rev: rev2 })) as {
      payload: { kind: string }[]; isError: boolean;
    };
    expect(isError).toBe(false);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.some((e) => e.kind === "added")).toBe(true);
  });

  it("diff with an unresolvable doc errors doc_missing (not an empty diff)", async () => {
    const { payload, isError } = (await call("docs_diff", { _path: "nope.md", from_rev: "r_a", to_rev: "r_b" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });

  it("docs_history lists per-doc version history for a path glob", async () => {
    ingestFile(store, repoId, "journal/x.md", "# X\n\nfirst version of x here\n");
    ingestFile(store, repoId, "journal/x.md", "# X\n\nsecond version of x here\n");
    ingestFile(store, repoId, "journal/y.md", "# Y\n\nonly version of y\n");
    ingestFile(store, repoId, "other/z.md", "# Z\n");
    const { payload } = (await call("docs_history", { path_glob: "journal/*" })) as {
      payload: { docs: { _path: string; versions: { _seq: number; _is_current: boolean }[] }[]; truncated: boolean };
    };
    expect(payload.docs.map((d) => d._path)).toEqual(["/journal/x.md", "/journal/y.md"]);
    const x = payload.docs.find((d) => d._path === "/journal/x.md")!;
    expect(x.versions.length).toBe(2);
    expect(x.versions[0]!._seq).toBeLessThan(x.versions[1]!._seq);
    expect(x.versions.filter((v) => v._is_current)).toHaveLength(1);
    expect(x.versions[x.versions.length - 1]!._is_current).toBe(true);
  });

  it("docs_history without path_glob or doc is a validation error", async () => {
    const { payload, isError } = (await call("docs_history", {})) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("target_missing");
  });

  it("query select projects _raw (whole document bytes) on docs", async () => {
    const { payload } = (await call("query", { query: 'select _raw from docs where layer == "working"' })) as {
      payload: { hits: { _path: string; _raw: string }[] };
    };
    expect(payload.hits[0]!._raw).toContain("# Risks");
    expect(payload.hits[0]!._raw).toContain("---\nlayer: working\n---");
  });

  it("query returns projected hits with truncated + cursor", async () => {
    const { payload } = (await call("query", { query: 'from docs where layer == "working"' })) as { payload: { hits: { _path: string }[]; truncated: boolean } };
    expect(payload.hits.map((h) => h._path)).toEqual(["/notes.md"]);
    expect(payload.truncated).toBe(false);
  });

  it("query select projects frontmatter onto hits", async () => {
    const { payload } = (await call("query", { query: 'select layer from docs where layer == "working"' })) as { payload: { hits: { _path: string; layer: string }[] } };
    expect(payload.hits[0]!.layer).toBe("working");
  });

  it("query bare returns the projection only; refuses no-select and values; names bare in the argument list (spec/surface §1.4, 4.2)", async () => {
    const { payload } = (await call("query", { query: 'select layer, _title from docs where layer == "working"', bare: true })) as { payload: { hits: unknown[] } };
    expect(payload.hits).toEqual([{ layer: "working", _title: "Risks" }]);
    const noSelect = (await call("query", { query: "from docs", bare: true })) as { payload: { error: string; message: string; data: { hint: string } }; isError: boolean };
    expect(noSelect.isError).toBe(true);
    expect(noSelect.payload.error).toBe("filter_invalid");
    expect(noSelect.payload.message).toBe("`bare` needs a `select` — without a projection a hit is only its envelope");
    expect(noSelect.payload.data.hint).toBe("OQX");
    const values = (await call("query", { query: "select _path values from docs", bare: true })) as { payload: { error: string; message: string }; isError: boolean };
    expect(values.isError).toBe(true);
    expect(values.payload.message).toBe("`bare` is redundant with `values` — `values` is already the bare-values form; drop one");
    // `bare: false` is the default; a non-boolean is an argument-shape error naming the list
    const off = (await call("query", { query: "from docs", bare: false })) as { payload: { hits: { _id: string; _path: string }[] } };
    expect(off.payload.hits).toEqual([{ _id: expect.any(String), _path: "/notes.md" }]);
    const bad = (await call("query", { query: "from docs", bare: "yes" })) as { payload: { error: string; message: string; data: { hint: string } }; isError: boolean };
    expect(bad.isError).toBe(true);
    expect(bad.payload.error).toBe("filter_invalid");
    expect(bad.payload.message).toBe("`bare` must be a boolean (query takes bare?, cursor?, limit?, query, repo?)");
    expect(bad.payload.data.hint).toBe("arguments");
  });

  it("query semantic without a provider yields provider_unavailable", async () => {
    const { payload, isError } = (await call("query", { query: 'from blocks where semantic("identity across edits") > 0.5' })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("provider_unavailable");
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
    await call("blocks_resolve", { query: "why isn't severity shown to artists" });
    expect(embeddedWith).toBe("why isn't severity shown to artists");
  });

  it("blocks_read hydrates a block by id at a resolution", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const headingId = read.ids[0]!;
    const { payload } = (await call("blocks_read", { _id: headingId, resolution: "raw" })) as { payload: { _raw: string } };
    expect(payload._raw).toBe("# Risks");
  });

  it("blocks_read infers the document from the block id", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const headingId = read.ids[0]!;
    const { payload, isError } = (await call("blocks_read", { _id: headingId, resolution: "raw" })) as { payload: { _raw: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload._raw).toBe("# Risks");
  });

  it("blocks_search returns bm25 hits", async () => {
    const { payload } = (await call("blocks_search", { q: "identity" })) as { payload: { hits: unknown[] } };
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  it("maps a bad filter to filter_invalid with reason + hint", async () => {
    // A genuine syntax error (unclosed consumer block). (ADR-013: arithmetic like
    // `a + b == 1` is now a valid supported expression, no longer a loud error.)
    const { payload, isError } = (await call("query", { query: "from docs where nodes count {" })) as { payload: { error: string; data: { hint: string } }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("filter_invalid");
    expect(payload.data.hint).toContain("OQX");
  });

  it("maps a missing doc to doc_missing", async () => {
    const { payload, isError } = (await call("docs_outline", { _path: "nope.md" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
  });
});

describe("blocks_read_many spans documents (ids are globally unique)", () => {
  it("without doc/path returns ids from three docs in request order and lists bogus ids as unresolved", async () => {
    ingestFile(store, repoId, "a.md", "# A\n\npara a\n");
    ingestFile(store, repoId, "b.md", "# B\n\npara b\n");
    const idsOf = (path: string): string[] =>
      (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = (SELECT doc_id FROM docs WHERE path = ?) AND deleted_commit IS NULL ORDER BY order_key").all(path) as { block_id: string }[]).map((r) => r.block_id);
    const notes = idsOf("notes.md");
    const a = idsOf("a.md");
    const b = idsOf("b.md");
    const ids = [b[1]!, notes[0]!, "b_bogus", a[1]!, notes[1]!, a[0]!, b[0]!];

    const { payload, isError } = (await call("blocks_read_many", { _ids: ids })) as {
      payload: { nodes: { _id: string }[]; truncated: boolean; unresolved: string[] };
      isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.nodes.map((n) => n._id)).toEqual([b[1], notes[0], a[1], notes[1], a[0], b[0]]);
    expect(payload.unresolved).toEqual(["b_bogus"]);
    expect(payload.truncated).toBe(false);
  });

  it("a `path` scope is no longer an argument (3.0; and no `_path` either): the shape error names the valid ones", async () => {
    ingestFile(store, repoId, "a.md", "# A\n");
    const aId = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = (SELECT doc_id FROM docs WHERE path = 'a.md')").get() as { block_id: string }).block_id;
    const { payload, isError } = (await call("blocks_read_many", { path: "notes.md", _ids: [aId] })) as {
      payload: { error: string; message: string; data: { hint: string } }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("filter_invalid");
    expect(payload.message).toBe("unknown argument `path` (blocks_read_many takes _ids, budget_tokens?, repo?, resolution?)");
    expect(payload.data.hint).toBe("arguments");
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
    })) as { payload: { revisions: { _id: string; _path: string }[]; new_ids: Record<string, string>; committed: boolean }; isError: boolean };
    expect(isError).toBe(false);
    // The Receipt (4.0): revisions[0] is the created document, `$new.0` its id.
    expect(payload.revisions[0]!._path).toBe("/sub/fresh.md");
    expect(payload.new_ids["$new.0"]).toBe(payload.revisions[0]!._id);
    expect(payload.committed).toBe(true);
    const { payload: q } = (await call("query", { query: 'from docs where status == "draft"' })) as { payload: { hits: { _path: string }[] } };
    expect(q.hits.map((h) => h._path)).toContain("/sub/fresh.md");
  });

  it("docs_create fails path_taken on an existing path", async () => {
    const { payload, isError } = (await call("docs_create", { path: "notes.md", markdown: "# x\n" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("path_taken");
  });

  it("docs_set_meta patches frontmatter, preserving other keys", async () => {
    const { isError } = (await call("docs_set_meta", { _path: "notes.md", set: { status: "active", priority: 2 } })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("query", { query: 'from docs where layer == "working" && status == "active"' })) as { payload: { hits: { _path: string }[] } };
    expect(payload.hits.map((h) => h._path)).toContain("/notes.md");
  });

  it("docs_move renames the document", async () => {
    const { payload, isError } = (await call("docs_move", { _path: "notes.md", to_path: "moved/notes.md" })) as { payload: { committed: boolean; commit: string; revisions: unknown[] }; isError: boolean };
    expect(isError).toBe(false);
    // The Receipt: a move with nothing to rewrite advances no revision; the commit is the rename.
    expect(payload).toMatchObject({ committed: true, revisions: [] });
    expect(payload.commit).toMatch(/^c_/);
    const { payload: q } = (await call("query", { query: 'from docs where layer == "working"' })) as { payload: { hits: { _path: string }[] } };
    expect(q.hits.map((h) => h._path)).toContain("/moved/notes.md");
  });

  it("docs_move with retarget_inbound:false reports dangling inbound links; the default rewrites them; destination phantoms are adopted", async () => {
    // b links to notes.md by path; a links to the FUTURE path (a phantom today).
    writeFileSync(join(root, "b.md"), "# B\n\nSee [notes](/notes.md#Risks) and `[code](/notes.md)`.\n");
    writeFileSync(join(root, "a.md"), "# A\n\nSoon [moved](/moved/notes.md).\n");
    processCheckpoint(store, repoId, root, [{ path: "notes.md" }, { path: "b.md" }, { path: "a.md" }]);
    const staleBefore = (await call("links_stale", {})) as { payload: { stale: { target: string }[] } };
    expect(staleBefore.payload.stale.map((s) => s.target)).toEqual(["/moved/notes.md"]);

    // Opted-out move: b's link dangles and is reported; a's phantom resolves.
    const { payload, isError } = (await call("docs_move", { _path: "notes.md", to_path: "moved/notes.md", retarget_inbound: false })) as {
      payload: { committed: boolean; dangling: { _doc_id: string; _path: string; _block_id: string | null; target: string; _anchor: string | null }[]; retargeted: unknown };
      isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    expect(payload.dangling).toHaveLength(1);
    expect(payload.dangling[0]).toMatchObject({ _path: "/b.md", target: "/notes.md", _anchor: "Risks" });
    expect(payload.retargeted).toBeNull();
    const staleAfter = (await call("links_stale", {})) as { payload: { stale: { _path: string; target: string }[] } };
    expect(staleAfter.payload.stale).toHaveLength(1);
    expect(staleAfter.payload.stale[0]).toMatchObject({ _path: "/b.md", target: "/notes.md" });

    // Move again with the default (retarget_inbound omitted): zero dangling, file rewritten, code span untouched.
    const { payload: p2 } = (await call("docs_move", { _path: "moved/notes.md", to_path: "final/notes.md" })) as {
      payload: { dangling: unknown[]; retargeted: { blocks: string[]; docs: string[] } | null };
    };
    expect(p2.dangling).toEqual([]);
    expect(p2.retargeted!.blocks).toHaveLength(1);
    const { payload: a } = (await call("docs_read", { _path: "a.md" })) as { payload: { _raw: string } };
    expect(a._raw).toBe("# A\n\nSoon [moved](/final/notes.md).\n");
    const staleEnd = (await call("links_stale", {})) as { payload: { stale: { _path: string; target: string }[] } };
    // b's link was dangling at notes.md (not the moved-from path), so it stays stale — only what pointed at the moved doc is retargeted.
    expect(staleEnd.payload.stale.map((s) => `${s._path}→${s.target}`)).toEqual(["/b.md→/notes.md"]);
  });

  it("`plan` returns `preview.diffs` only on `diffs: true`; the Plan is otherwise identical and `plan_id` unmoved (4.5)", async () => {
    const effects = [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "_frontmatter.status", value: "active" }];
    const lean = (await call("plan", { effects })) as { payload: { plan_id: string; preview: Record<string, unknown> }; isError: boolean };
    expect(lean.isError).toBe(false);
    expect(Object.keys(lean.payload.preview)).toEqual(["results", "revisions", "summary"]);
    const full = (await call("plan", { effects, diffs: true })) as { payload: { plan_id: string; preview: Record<string, unknown> }; isError: boolean };
    expect(Object.keys(full.payload.preview)).toEqual(["results", "revisions", "diffs", "summary"]);
    expect(full.payload.plan_id).toBe(lean.payload.plan_id);
    const { diffs: _d, ...rest } = full.payload.preview;
    expect(rest).toEqual(lean.payload.preview);
    const off = (await call("plan", { effects, diffs: false })) as { payload: { preview: Record<string, unknown> } };
    expect(Object.keys(off.payload.preview)).toEqual(["results", "revisions", "summary"]);
  });

  it("`execute { plan_id }` alone runs the plan this server remembers; an unknown id is plan_unknown; a remembered plan whose document moved on is stale_plan (5.1)", async () => {
    const effects = [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "_frontmatter.status", value: "active" }];
    const planned = (await call("plan", { effects })) as { payload: { plan_id: string; preview: { summary: string[] } }; isError: boolean };
    expect(planned.isError).toBe(false);
    // The memory survives an intervening unrelated call.
    await call("docs_read", { _path: "notes.md" });
    const unknown = (await call("execute", { plan_id: "0".repeat(64) })) as { payload: { error: string; message: string; data: unknown; retriable: boolean }; isError: boolean };
    expect(unknown.isError).toBe(true);
    expect(unknown.payload).toEqual({
      error: "plan_unknown",
      message: `this server has no plan ${"0".repeat(64)} — re-run plan, or pass the plan (or \`plan_id\` + \`effects\`) with execute`,
      data: { plan_id: "0".repeat(64) },
      retriable: true,
    });
    const done = (await call("execute", { plan_id: planned.payload.plan_id, reason: "by id" })) as { payload: { plan_id: string; committed: boolean; summary: string[]; revisions: { _path: string }[] }; isError: boolean };
    expect(done.isError).toBe(false);
    expect(done.payload.plan_id).toBe(planned.payload.plan_id);
    expect(done.payload.committed).toBe(true);
    expect(done.payload.summary).toEqual(planned.payload.preview.summary);
    expect(done.payload.revisions.map((r) => r._path)).toEqual(["/notes.md"]);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toContain("status: active");
    // The same id again: the plan form's own precondition check — stale_plan, not plan_mismatch and not plan_unknown.
    const again = (await call("execute", { plan_id: planned.payload.plan_id })) as { payload: { error: string; retriable: boolean }; isError: boolean };
    expect(again.isError).toBe(true);
    expect(again.payload.error).toBe("stale_plan");
    expect(again.payload.retriable).toBe(true);
    // The id with `select`/`expect` but no `effects` is still the half digest form; `effects` alone too.
    const half = (await call("execute", { plan_id: planned.payload.plan_id, expect: { max: 1 } })) as { payload: { message: string }; isError: boolean };
    expect(half.isError).toBe(true);
    expect(half.payload.message.startsWith("the digest form needs both `plan_id` and `effects` (")).toBe(true);
    const none = (await call("execute", {})) as { payload: { message: string } };
    expect(none.payload.message.startsWith("pass exactly one of `plan`, `plan_id` or `plan_id` + `effects` (")).toBe(true);
    const both = (await call("execute", { plan: {}, plan_id: "x" })) as { payload: { message: string } };
    expect(both.payload.message.startsWith("pass exactly one of `plan`, `plan_id` or `plan_id` + `effects` (")).toBe(true);
    // The memory is bounded: the oldest plan leaves after PLAN_MEMORY newer ones.
    const oldest = (await call("plan", { effects: [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "_frontmatter.n", value: -1 }] })) as { payload: { plan_id: string } };
    for (let i = 0; i < PLAN_MEMORY; i++) await call("plan", { effects: [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "_frontmatter.n", value: i }] });
    const evicted = (await call("execute", { plan_id: oldest.payload.plan_id })) as { payload: { error: string }; isError: boolean };
    expect(evicted.payload.error).toBe("plan_unknown");
  });

  it("a string-list argument takes one bare string as a one-element list; a comma-joined string is the array error with the split list as its fix (4.5)", async () => {
    const one = (await call("docs_read_many", { docs: "notes.md" })) as { payload: { items: { _path: string }[] }; isError: boolean };
    expect(one.isError).toBe(false);
    expect(one.payload.items.map((i) => i._path)).toEqual(["/notes.md"]);
    const roots = (await call("graph", { roots: "notes.md", degrees: 0 })) as { payload: { roots: string[] }; isError: boolean };
    expect(roots.isError).toBe(false);
    expect(roots.payload.roots).toHaveLength(1);
    const joined = (await call("docs_read_many", { docs: "notes.md, projects/a.md", include_ids: true })) as { payload: { error: string; message: string; data: { hint: string; fix: string } }; isError: boolean };
    expect(joined.isError).toBe(true);
    expect(joined.payload.error).toBe("filter_invalid");
    expect(joined.payload.message).toBe("`docs` must be an array of strings (docs_read_many takes budget_tokens?, docs, include_ids?, repo?)");
    expect(joined.payload.data).toEqual({ reason: joined.payload.message, hint: "arguments", fix: "{\"docs\":[\"notes.md\",\"projects/a.md\"],\"include_ids\":true}" });
    const wrong = (await call("docs_read_many", { docs: 7 })) as { payload: { message: string; data: Record<string, unknown> }; isError: boolean };
    expect(wrong.isError).toBe(true);
    expect(wrong.payload.message).toBe("`docs` must be an array of strings (docs_read_many takes budget_tokens?, docs, include_ids?, repo?)");
    expect(wrong.payload.data.fix).toBeUndefined();
  });

  it("`plan` over the document effects validates and previews without writing; `dry_run` is refused by name (4.0)", async () => {
    const created = (await call("plan", { effects: [{ op: "create", path: "sub/fresh.md", markdown: "# Fresh\n" }], diffs: true })) as { payload: { new_ids: unknown[]; preview: { diffs: Record<string, { before: string; after: string }> } }; isError: boolean };
    expect(created.isError).toBe(false);
    expect(created.payload.new_ids).toEqual([{ symbol: "$new.0", kind: "document" }, { symbol: "$new.1", kind: "block" }]);
    expect(created.payload.preview.diffs).toEqual({ "/sub/fresh.md": { before: "", after: "# Fresh\n" } });
    expect(existsSync(join(root, "sub/fresh.md"))).toBe(false);

    const meta = (await call("plan", { effects: [{ op: "set", target: { kind: "document", _path: "notes.md" }, field: "_frontmatter.status", value: "active" }], diffs: true })) as { payload: { preview: { diffs: Record<string, { before: string; after: string }> } }; isError: boolean };
    expect(meta.isError).toBe(false);
    expect(meta.payload.preview.diffs["/notes.md"]!.after).toContain("status: active");
    expect(readFileSync(join(root, "notes.md"), "utf8")).not.toContain("status: active");

    const moved = (await call("plan", { effects: [{ op: "move", target: { kind: "document", _path: "notes.md" }, to: "moved/notes.md" }], diffs: true })) as { payload: { preview: { diffs: Record<string, unknown> } }; isError: boolean };
    expect(moved.isError).toBe(false);
    expect(Object.keys(moved.payload.preview.diffs).sort()).toEqual(["/moved/notes.md", "/notes.md"]);
    expect(existsSync(join(root, "notes.md"))).toBe(true);

    const deleted = (await call("plan", { effects: [{ op: "remove", target: { kind: "document", _path: "notes.md" } }], diffs: true })) as { payload: { preview: { diffs: Record<string, { after: string }> } }; isError: boolean };
    expect(deleted.isError).toBe(false);
    expect(deleted.payload.preview.diffs["/notes.md"]!.after).toBe("");
    expect(existsSync(join(root, "notes.md"))).toBe(true);
    // A plan is still validated.
    const taken = (await call("plan", { effects: [{ op: "create", path: "notes.md", markdown: "# x\n" }] })) as { payload: { error: string }; isError: boolean };
    expect(taken.isError).toBe(true);
    expect(taken.payload.error).toBe("path_taken");
    // The 3.x `dry_run` is a retired name on every write tool, never silently stripped.
    for (const [tool, args] of [
      ["docs_create", { path: "sub/fresh.md", markdown: "# Fresh\n" }],
      ["docs_set_meta", { path: "notes.md", set: { status: "active" } }],
      ["docs_move", { path: "notes.md", to_path: "moved/notes.md" }],
      ["docs_delete", { path: "notes.md" }],
      ["docs_update", { path: "notes.md", content: "# x\n" }],
      ["apply", { effects: [] }],
    ] as const) {
      const r = (await call(tool, { ...args, dry_run: true })) as { payload: { error: string; message: string; data: { hint: string } }; isError: boolean };
      expect(r.isError, tool).toBe(true);
      expect(r.payload.error).toBe("filter_invalid");
      expect(r.payload.data.hint).toBe("arguments");
      expect(r.payload.message.startsWith("`dry_run` is no longer an argument — preview with `plan { effects: [...] }` ("), r.payload.message).toBe(true);
    }
    expect(existsSync(join(root, "sub/fresh.md"))).toBe(false);
    expect(readFileSync(join(root, "notes.md"), "utf8")).not.toContain("status: active");
  });

  it("docs_delete tombstones the document", async () => {
    const { isError } = (await call("docs_delete", { _path: "notes.md" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("query", { query: 'from docs where layer == "working"' })) as { payload: { hits: unknown[] } };
    expect(payload.hits).toHaveLength(0);
  });

  it("docs_move / docs_set_meta take a d_ id as `_id` too", async () => {
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='notes.md'").get() as { doc_id: string }).doc_id;
    const { isError: metaErr } = (await call("docs_set_meta", { _id: docId, set: { status: "byid" } })) as { isError: boolean };
    expect(metaErr).toBe(false);
    const { payload, isError } = (await call("docs_move", { _id: docId, to_path: "moved/byid.md" })) as { payload: { committed: boolean }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    const { payload: moved } = (await call("docs_read", { _id: docId })) as { payload: { _path: string } };
    expect(moved._path).toBe("/moved/byid.md");
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
      payload: { stale: { target: string; _path: string; reason: string }[]; externalCount: number; totalOpenEdges: number; truncated: boolean };
      isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.stale).toHaveLength(1);
    expect(payload.stale[0]!.target).toBe("/b.md");
    expect(payload.stale[0]!._path).toBe("/a.md");
    expect(payload.stale[0]!.reason).toBe("dangling_doc");
    expect(payload.externalCount).toBeGreaterThanOrEqual(1);
    expect(payload.truncated).toBe(false);
  });

  it("plan { retarget } previews; links_repair commits, rewrites and clears the stale link", async () => {
    // Give the repair a real destination doc so the edge re-resolves.
    await call("docs_create", { path: "c.md", markdown: "# C\n" });

    const { payload: dry, isError: dryErr } = (await call("plan", {
      effects: [{ op: "retarget", repairs: [{ from: "/b.md", to: "/c.md" }] }],
    })) as { payload: { preview: { retarget: { hits: unknown[] }[] } }; isError: boolean };
    expect(dryErr).toBe(false);
    expect(dry.preview.retarget[0]!.hits).toHaveLength(1);
    // Still stale — a plan does not write.
    const { payload: mid } = (await call("links_stale", {})) as { payload: { stale: unknown[] } };
    expect(mid.stale).toHaveLength(1);

    const { payload: done, isError: commitErr } = (await call("links_repair", {
      from_target: "/b.md", to_target: "/c.md",
    })) as { payload: { committed: boolean; hits: unknown[] }; isError: boolean };
    expect(commitErr).toBe(false);
    expect(done.committed).toBe(true);
    expect(done.hits).toHaveLength(1);
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
    await call("query", { query: 'from docs where layer == "working"' });
    expect(mutations).toBe(0);
  });

  it("fires once for a successful apply", async () => {
    const { payload: q } = (await call("query", { query: 'select _path from docs where layer == "working"' })) as { payload: { hits: { _id: string }[] } };
    const docId = q.hits[0]!._id;
    const { isError } = (await call("apply", { effects: [{ op: "insert", into: { kind: "document", _id: docId }, at: "end", markdown: "appended paragraph" }] })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
  });

  it("does not fire for a failed apply (validation error)", async () => {
    const r = (await client.callTool({ name: "apply", arguments: { effects: [{ op: "set", target: { kind: "block" }, field: "markdown", value: "x" }] } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(mutations).toBe(0);
  });

  it("does not fire for a plan", async () => {
    const { payload: q } = (await call("query", { query: 'select _path from docs where layer == "working"' })) as { payload: { hits: { _id: string }[] } };
    const docId = q.hits[0]!._id;
    const { isError } = (await call("plan", { effects: [{ op: "insert", into: { kind: "document", _id: docId }, at: "end", markdown: "preview only" }] })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(0);
  });

  it("fires for a doc-level write (docs_set_meta)", async () => {
    const { isError } = (await call("docs_set_meta", { _path: "notes.md", set: { status: "active" } })) as { isError: boolean };
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
  });
});

describe("apply op schema + blocks_append / docs_append section resolution", () => {
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

  it("apply publishes the effect vocabulary (`effects` required, `op` one of the nine); the kernel `ops` are a retired name", async () => {
    const tools = await client.listTools();
    const applyTool = tools.tools.find((t) => t.name === "apply")!;
    const schema = applyTool.inputSchema as unknown as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["effects", "expect", "reason", "repo", "select"]);
    expect(schema.required).toEqual(["effects"]);
    const items = (schema.properties.effects as { items: { properties: { op: { enum: string[] } } } }).items;
    expect(items.properties.op.enum).toEqual(["create", "insert", "set", "unset", "move", "remove", "split", "merge", "retarget"]);
    const r = (await call("apply", { ops: [{ op: "update", block: "b_x", markdown: "x" }] })) as { payload: { error: string; message: string }; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.payload.message).toBe("`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, expect?, reason?, repo?, select?)");
  });

  it("apply rejects a malformed effect as a validation error naming it, not block_missing", async () => {
    const r = (await client.callTool({ name: "apply", arguments: { effects: [{ op: "set", target: { kind: "block" }, field: "markdown", value: "x" }] } })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    // The planner's validation names the effect and the member; it never reaches
    // the engine's block_missing path (which would misreport "block undefined not found").
    expect(r.content[0]!.text).toContain("effects[0]");
    expect(r.content[0]!.text).not.toContain("block_missing");
  });

  it("docs_read include_ids returns hashes usable directly as raw apply's expect.content_hash", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[]; hashes: Record<string, string> };
    };
    // Pick the "intro body" paragraph via blocks_read, then update it through the
    // RAW apply kernel using ONLY the hash the same read handed back — no
    // blocks_read_many(resolution:"full") hydration round trip.
    let target = "";
    for (const id of read.ids) {
      const { payload } = (await call("blocks_read", { _id: id, resolution: "raw" })) as { payload: { _raw?: string } };
      if (payload._raw === "intro body") { target = id; break; }
    }
    expect(target).not.toBe("");
    expect(read.hashes[target]).toMatch(/^[0-9a-f]{64}$/);
    const { payload, isError } = (await call("apply", {
      effects: [{ op: "set", target: { kind: "block", _id: target }, field: "markdown", value: "rewritten intro", expect: { content_hash: read.hashes[target] } }],
    })) as { payload: { committed: boolean }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    const { payload: after } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(after._raw).toContain("rewritten intro");
  });

  it("a stale expect.content_hash on a `set markdown` effect returns the current hash so the error is directly retriable", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[]; hashes: Record<string, string> };
    };
    let target = "";
    for (const id of read.ids) {
      const { payload } = (await call("blocks_read", { _id: id, resolution: "raw" })) as { payload: { _raw?: string } };
      if (payload._raw === "intro body") { target = id; break; }
    }
    const { payload, isError } = (await call("apply", {
      effects: [{ op: "set", target: { kind: "block", _id: target }, field: "markdown", value: "stale hash supplied", expect: { content_hash: "00" } }],
    })) as { payload: { error: string; data: { retriable?: boolean; current?: { _hash?: string } } }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("stale_expectation");
    expect(payload.data.retriable).toBe(true);
    // The current hash is handed back and matches what the read reported.
    expect(payload.data.current!._hash).toBe(read.hashes[target]);
  });

  it("docs_append with `section` resolves heading text inside the named document", async () => {
    const { isError } = (await call("docs_append", { _path: "notes.md", section: "Launch", text: "appended item" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("appended item");
  });

  it("blocks_append on a heading appends into its section", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    // pick the id whose block is the Launch heading via blocks_read
    let headingId = "";
    for (const id of read.ids) {
      const { payload } = (await call("blocks_read", { _id: id, resolution: "raw" })) as { payload: { _raw?: string } };
      if (payload._raw === "## Launch") { headingId = id; break; }
    }
    expect(headingId).not.toBe("");
    const { isError } = (await call("blocks_append", { _id: headingId, text: "byid item" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("launch note\n\nbyid item");
  });

  it("blocks_append on a container appends to its children; on a leaf it is block_not_container", async () => {
    writeFileSync(join(root, "list.md"), "# L\n\n- one\n- two\n\nplain\n");
    ingestFile(store, repoId, "list.md", "# L\n\n- one\n- two\n\nplain\n");
    const rows = store.db.prepare("SELECT block_id, type FROM blocks WHERE doc_id = (SELECT doc_id FROM docs WHERE path = 'list.md') AND deleted_commit IS NULL ORDER BY order_key").all() as { block_id: string; type: string }[];
    const list = rows.find((r) => r.type === "list")!.block_id;
    const para = rows.filter((r) => r.type === "paragraph").at(-1)!.block_id;
    const { isError } = (await call("blocks_append", { _id: list, text: "- three" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "list.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("- two\n- three");
    const leaf = (await call("blocks_append", { _id: para, text: "x" })) as { payload: { error: string; message: string; data: { _id: string; _type: string } }; isError: boolean };
    expect(leaf.isError).toBe(true);
    expect(leaf.payload.error).toBe("block_not_container");
    // (4.4) the fix IS the sibling insert the message describes — a top-level leaf's parent is its document.
    expect(leaf.payload.data).toEqual({ _id: para, _type: "paragraph", fix: `blocks_insert {"at":{"after":"${para}"},"markdown":"x","to":"/list.md"}` });
    expect(leaf.payload.message).toContain("blocks_insert");
  });

  it("docs_append with a `section` spelled twice in the document errors ambiguous_heading with candidates", async () => {
    writeFileSync(join(root, "twice.md"), "## Launch\n\na\n\n## Launch\n\nb\n");
    ingestFile(store, repoId, "twice.md", "## Launch\n\na\n\n## Launch\n\nb\n");
    const { payload, isError } = (await call("docs_append", { _path: "twice.md", section: "Launch", text: "x" })) as {
      payload: { error: string; message: string; data: { section: string; candidates: { _id: string; _doc_id: string }[]; fix: string } }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("ambiguous_heading");
    expect(payload.data.section).toBe("Launch");
    expect(payload.data.candidates.length).toBe(2);
    expect(payload.data.fix).toBe(`blocks_append {"_id":"${payload.data.candidates[0]!._id}","text":"x"}`);
    expect(payload.message).toBe('heading "Launch" matches 2 headings in /twice.md; pass the heading\'s id to blocks_append');
  });

  it("docs_append with an unknown `section` errors parent_missing naming the heading", async () => {
    const { payload, isError } = (await call("docs_append", { _path: "notes.md", section: "Nonexistent", text: "x" })) as {
      payload: { error: string; message: string }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("parent_missing");
    expect(payload.message).toBe('no heading "Nonexistent" in /notes.md');
    // (4.4) no heading near it: the fix is the same append at the document's end.
    expect((payload as unknown as { data: { fix: string } }).data.fix).toBe('docs_append {"_path":"notes.md","text":"x"}');
    // one heading equal up to ASCII case: the fix names it for blocks_append.
    writeFileSync(join(root, "case.md"), "## Launch\n\na\n");
    ingestFile(store, repoId, "case.md", "## Launch\n\na\n");
    const heading = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = (SELECT doc_id FROM docs WHERE path = 'case.md') AND type = 'heading'").get() as { block_id: string }).block_id;
    const near = (await call("docs_append", { _path: "case.md", section: "launch", text: "x" })) as { payload: { error: string; data: { fix: string } } };
    expect(near.payload.error).toBe("parent_missing");
    expect(near.payload.data.fix).toBe(`blocks_append {"_id":"${heading}","text":"x"}`);
  });

  it("argument-shape errors are filter_invalid with the nearest name and the tool's shape", async () => {
    const retired = (await call("docs_read", { doc: "notes.md" })) as { payload: { error: string; message: string } };
    expect(retired.payload.error).toBe("filter_invalid");
    expect(retired.payload.message).toBe("`doc` is no longer an argument — pass `_id` or `_path` (docs_read takes _id?, _path?, at?, include_ids?, repo?)");
    const typo = (await call("blocks_search", { query: "x" })) as { payload: { message: string } };
    expect(typo.payload.message).toBe("unknown argument `query`; did you mean `q`? (blocks_search takes limit?, q, repo?)");
    const missing = (await call("query", {})) as { payload: { message: string } };
    expect(missing.payload.message).toBe("`query` is required (query takes bare?, cursor?, limit?, query, repo?)");
    const typed = (await call("query", { query: "from docs", limit: "5" })) as { payload: { message: string } };
    expect(typed.payload.message).toBe("`limit` must be an integer (query takes bare?, cursor?, limit?, query, repo?)");
    const neither = (await call("docs_read", {})) as { payload: { message: string } };
    expect(neither.payload.message).toBe("pass _id or _path (docs_read takes _id?, _path?, at?, include_ids?, repo?)");
    const both = (await call("docs_read", { _id: "d_0000000", _path: "notes.md" })) as { payload: { error: string; message: string } };
    expect(both.payload.error).toBe("doc_missing");
    expect(both.payload.message).toBe('no document with _id or _path "d_0000000"');
    const node = (await call("blocks_update", { block: "b_x", markdown: "x" })) as { payload: { message: string } };
    expect(node.payload.message).toBe("`block` is no longer an argument — pass `_id` (blocks_update takes _id, checked?, expect?, markdown?, repo?)");
    const attrs = (await call("blocks_update", { _id: "b_x", attrs: { checked: true } })) as { payload: { message: string } };
    expect(attrs.payload.message).toBe("`attrs` is no longer an argument — pass `checked` (blocks_update takes _id, checked?, expect?, markdown?, repo?)");
    const dry = (await call("blocks_insert", { to: "notes.md", markdown: "x", dry_run: true })) as { payload: { message: string } };
    expect(dry.payload.message).toBe("`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (blocks_insert takes at?, expect?, markdown, repo?, to)");
  });

  it("docs_append appends to the end of the document, preserving every existing block id", async () => {
    const { payload: before } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[]; _raw: string };
    };
    const { payload, isError } = (await call("docs_append", { _path: "notes.md", text: "a fresh trailing note\n" })) as {
      payload: { committed: boolean; new_ids: Record<string, string>; revisions: { _id: string; _path: string; _hash: string }[] }; isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    // the Receipt: the revision + the single inserted block id under its symbol
    expect(payload.revisions[0]!._path).toBe("/notes.md");
    expect(Object.keys(payload.new_ids)).toEqual(["$new.0"]);
    const newId = payload.new_ids["$new.0"]!;

    const { payload: after } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[]; _raw: string };
    };
    // IDENTITY STABILITY: every pre-existing block id is still present and in the
    // same leading order; the appended block id is new (not one of the old ones).
    expect(after.ids.slice(0, before.ids.length)).toEqual(before.ids);
    expect(before.ids).not.toContain(newId);
    expect(after.ids).toContain(newId);
    expect(after.ids.length).toBe(before.ids.length + 1);
    // additive, not a whole-body replace: the prior body is intact, new text after
    expect(after._raw.startsWith(before._raw.trimEnd())).toBe(true);
    expect(after._raw).toContain("a fresh trailing note");
    expect(after._raw.indexOf("a fresh trailing note")).toBeGreaterThan(after._raw.indexOf("launch note"));
  });

  it("docs_append inserts MULTI-block markdown as multiple new top-level blocks, none re-minted", async () => {
    const { payload: before } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const { payload, isError } = (await call("docs_append", { _path: "notes.md", text: "## New Section\n\nfirst para\n\nsecond para\n" })) as {
      payload: { committed: boolean; new_ids: Record<string, string> }; isError: boolean;
    };
    expect(isError).toBe(false);
    // three new top-level blocks: heading + two paragraphs
    const minted = Object.values(payload.new_ids);
    expect(minted.length).toBe(3);
    const { payload: after } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[]; _raw: string } };
    // no existing block was re-minted (all still present, in order)
    expect(after.ids.slice(0, before.ids.length)).toEqual(before.ids);
    for (const id of minted) expect(before.ids).not.toContain(id);
    expect(after.ids.length).toBe(before.ids.length + 3);
    expect(after._raw).toContain("## New Section");
    expect(after._raw).toContain("first para");
    expect(after._raw).toContain("second para");
  });

  it("docs_append takes a d_ id as `_id`", async () => {
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='notes.md'").get() as { doc_id: string }).doc_id;
    const { isError } = (await call("docs_append", { _id: docId, text: "by-id append\n" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("by-id append");
  });

  it("docs_append on a missing doc errors doc_missing (never auto-creates)", async () => {
    const { payload, isError } = (await call("docs_append", { _path: "does-not-exist.md", text: "x\n" })) as {
      payload: { error: string }; isError: boolean;
    };
    expect(isError).toBe(true);
    expect(payload.error).toBe("doc_missing");
    // and no document was created at that path
    const row = store.db.prepare("SELECT 1 FROM docs WHERE path = 'does-not-exist.md'").get();
    expect(row).toBeUndefined();
  });
});

describe("block-level MCP tools (blocks_* — ref resolution + CAS server-side)", () => {
  let root: string;

  // Return the ordered top-level block ids of notes.md, and the raw of each,
  // so tests can target a block by content without knowing its minted id.
  async function ids(): Promise<{ id: string; raw: string }[]> {
    const { payload } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as { payload: { ids: string[] } };
    const out: { id: string; raw: string }[] = [];
    for (const id of payload.ids) {
      const { payload: n } = (await call("blocks_read", { _id: id, resolution: "raw" })) as { payload: { _raw?: string } };
      out.push({ id: id, raw: n._raw ?? "" });
    }
    return out;
  }
  const idOf = async (raw: string) => (await ids()).find((b) => b.raw === raw)!.id;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "omg-mcpblocks-"));
    const body = "# Doc\n\nAlpha para.\n\nBeta para.\n\n## Tasks\n\n- [ ] wire it\n";
    writeFileSync(join(root, "notes.md"), body);
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    ingestFile(store, repoId, "notes.md", body);
    await connect(root);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks_insert accepts a block ref as an anchor and inserts through the kernel", async () => {
    const alpha = await idOf("Alpha para.");
    const { isError } = (await call("blocks_insert", { to: "notes.md", markdown: "Inserted child.", at: { after: alpha } })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("Alpha para.\n\nInserted child.");
  });

  it("blocks_insert into a leaf block is type_mismatch (spec/mutate 1.2) and touches nothing", async () => {
    const alpha = await idOf("Alpha para.");
    const r = (await call("blocks_insert", { to: alpha, markdown: "Inserted child.", at: "end" })) as { isError: boolean; payload: { error?: string; data?: { type?: string } } };
    expect(r.isError).toBe(true);
    expect(r.payload.error).toBe("type_mismatch");
    expect(r.payload.data?.type).toBe("paragraph");
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("Alpha para.");
    expect(payload._raw).not.toContain("Inserted child.");
  });

  it("blocks_update resolves a ref and pins CAS from current bytes server-side", async () => {
    const beta = await idOf("Beta para.");
    const { isError } = (await call("blocks_update", { _id: beta, markdown: "Beta, edited." })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("Beta, edited.");
    expect(payload._raw).not.toContain("Beta para.");
  });

  it("blocks_update honors a caller-supplied stale expect (CAS conflict)", async () => {
    const beta = await idOf("Beta para.");
    const { isError } = (await call("blocks_update", { _id: beta, markdown: "nope", expect: { content_hash: "deadbeef" } })) as { isError: boolean };
    expect(isError).toBe(true);
  });

  it("blocks_remove removes a block by ref", async () => {
    const alpha = await idOf("Alpha para.");
    const { isError } = (await call("blocks_remove", { blocks: [alpha] })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).not.toContain("Alpha para.");
  });

  it("blocks_remove accepts a container together with its children (flat include_ids set)", async () => {
    const { payload: read } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { ids: string[]; parents: Record<string, string | null> };
    };
    const list = read.ids.find((id) => read.parents[id] === null && read.ids.some((c) => read.parents[c] === id))!;
    const items = read.ids.filter((id) => read.parents[id] === list);
    expect(items.length).toBeGreaterThan(0);
    const { payload: plan } = (await call("plan", { effects: [{ op: "remove", targets: [list, ...items].map((id) => ({ kind: "block", _id: id })) }] })) as {
      payload: { preview: { results: { removed: string[] }[] } };
    };
    expect(plan.preview.results[0]!.removed.sort()).toEqual([list, ...items].sort());
    const { payload, isError } = (await call("blocks_remove", { blocks: [list, ...items] })) as { payload: { committed: boolean; commit: string }; isError: boolean };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    expect(payload.commit).toMatch(/^c_/);
    const { payload: after } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(after._raw).not.toContain("wire it");
  });

  it("blocks_insert accepts a DOCUMENT path as `to` and inserts at the top level", async () => {
    const { isError } = (await call("blocks_insert", { to: "notes.md", markdown: "## Appended\n\nBy path." })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md", include_ids: true })) as {
      payload: { _raw: string; ids: string[]; parents: Record<string, string | null> };
    };
    expect(payload._raw.trimEnd().endsWith("## Appended\n\nBy path.")).toBe(true);
    // `at: "start"` on a document parent lands before the first top-level block.
    const { isError: e2 } = (await call("blocks_insert", { to: "notes.md", markdown: "Preamble.", at: "start" })) as { isError: boolean };
    expect(e2).toBe(false);
    const { payload: p2 } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(p2._raw.startsWith("Preamble.")).toBe(true);
  });

  it("blocks_move accepts the source document as `to` (top level) and refuses another document's root", async () => {
    const alpha = await idOf("Alpha para.");
    const { isError } = (await call("blocks_move", { blocks: [alpha], to: "notes.md", at: "end" })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw.trimEnd().endsWith("Alpha para.")).toBe(true);
    writeFileSync(join(root, "other.md"), "# Other\n");
    ingestFile(store, repoId, "other.md", "# Other\n");
    const { payload: bad, isError: e2 } = (await call("blocks_move", { blocks: [alpha], to: "other.md" })) as { payload: { error: string }; isError: boolean };
    expect(e2).toBe(true);
    expect(bad.error).toBe("target_missing");
  });

  it("blocks_split splits a block at offsets (CAS pinned server-side)", async () => {
    const alpha = await idOf("Alpha para.");
    const { isError } = (await call("blocks_split", { _id: alpha, at: [5] })) as { isError: boolean };
    expect(isError).toBe(false);
    const { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toContain("Alpha");
  });

  it("blocks_merge joins adjacent blocks", async () => {
    const alpha = await idOf("Alpha para.");
    const beta = await idOf("Beta para.");
    const { isError } = (await call("blocks_merge", { blocks: [alpha, beta] })) as { isError: boolean };
    expect(isError).toBe(false);
  });

  it("a bogus ref errors block_missing", async () => {
    const { payload, isError } = (await call("blocks_update", { _id: "b_nope", markdown: "x" })) as { payload: { error: string }; isError: boolean };
    expect(isError).toBe(true);
    expect(payload.error).toBe("block_missing");
  });

  it("plan previews an insert without committing", async () => {
    const alpha = await idOf("Alpha para.");
    const { payload, isError } = (await call("plan", { effects: [{ op: "insert", into: { kind: "document", _path: "notes.md" }, at: { after: alpha }, markdown: "PREVIEW ONLY" }], diffs: true })) as {
      payload: { preview: { diffs?: Record<string, unknown> } }; isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.preview.diffs).toBeTruthy();
    const { payload: read } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(read._raw).not.toContain("PREVIEW ONLY");
  });

  it("blocks_check checks and unchecks a task by ref", async () => {
    // The task is a list item nested under a ul — resolve its id from the
    // outline (which lists nested block ids), not the top-level docs_read ids.
    const taskId = async () => {
      const { payload } = (await call("docs_outline", { _path: "notes.md" })) as { payload: { text: string } };
      const line = payload.text.split("\n").find((l) => l.includes("wire it"))!;
      return line.trim().split(/\s+/)[0]!;
    };
    await call("blocks_check", { _ids: [await taskId()] });
    let { payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } };
    expect(payload._raw).toMatch(/- \[x\] wire it/i);
    // uncheck — re-resolve (the id may change after the write)
    await call("blocks_check", { _ids: [await taskId()], checked: false });
    ({ payload } = (await call("docs_read", { _path: "notes.md" })) as { payload: { _raw: string } });
    expect(payload._raw).toContain("- [ ] wire it");
  });
});

describe("link maintenance tools: honest dry run, authored targets, summary, scoping, multi-block update", () => {
  let root: string;
  type Repair = { hits: { _id: string; _path: string; oldRaw: string; newRaw: string }[]; pairs: { from: string; to: string; hits: number }[]; committed: boolean; commit: string | null };
  type RetargetPlan = { preview: { retarget: { hits: Repair["hits"]; pairs: Repair["pairs"] }[]; diffs: Record<string, { before: string; after: string }> } };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "omg-mcplinks2-"));
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "t", root);
    writeFileSync(join(root, "list.md"), "# L\n\n- item [b](/b.md) here\n- other\n\nAlso [b](/b.md#Top) and `[b](/b.md)`.\n");
    processCheckpoint(store, repoId, root, [{ path: "list.md" }]);
    await connect(root);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("plan { retarget } previews through the planner (diffs, preview.retarget); links_repair then commits on list+item hits", async () => {
    await call("docs_create", { path: "c.md", markdown: "# C\n" });
    const repairs = [{ from: "b.md", to: "/c.md" }];
    const { payload: dry, isError } = (await call("plan", { effects: [{ op: "retarget", repairs }], diffs: true })) as { payload: RetargetPlan; isError: boolean };
    expect(isError).toBe(false);
    const after = dry.preview.diffs["/list.md"]!.after;
    expect(after).toContain("- item [b](/c.md) here");
    expect(after).toContain("[b](/c.md#Top) and `[b](/b.md)`.");
    // list (its item hit collapsed) + paragraph; the inline-code mention is not a hit
    const preview = dry.preview.retarget[0]!;
    expect(preview.hits.map((h) => h._path)).toEqual(["/list.md", "/list.md"]);
    expect(preview.pairs).toEqual([{ from: "b.md", to: "/c.md", hits: 2 }]);
    expect(readFileSync(join(root, "list.md"), "utf8")).not.toContain("/c.md");

    const { payload: done, isError: applyErr } = (await call("links_repair", { repairs })) as { payload: Repair; isError: boolean };
    expect(applyErr).toBe(false);
    expect(done.committed).toBe(true);
    expect(done.commit).toMatch(/^c_/);
    expect(done.hits).toEqual(preview.hits);
    expect(done.pairs).toEqual(preview.pairs);
    expect(readFileSync(join(root, "list.md"), "utf8")).toBe(after);
    // Every real link now resolves. The `[b](/b.md)` INSIDE inline code is not
    // an edge at all: the extractor (graph/extract.ts) masks code spans and
    // fences, and the repairer leaves code alone — so nothing is left stale.
    const { payload: health } = (await call("links_stale", {})) as { payload: { stale: { authored: string | null }[] } };
    expect(health.stale.map((s) => s.authored)).toEqual([]);
  });

  it("links_retarget commits (4.0: no dry-run default) with its hits and pairs beside the Receipt; path_glob scopes the sources; no hit → commit null", async () => {
    writeFileSync(join(root, "other.md"), "# O\n\n[b](/b.md)\n");
    processCheckpoint(store, repoId, root, [{ path: "other.md" }]);
    const { payload } = (await call("links_retarget", { from_target: "/b.md", to_target: "/c.md", path_glob: "other.md" })) as { payload: Repair & { revisions: { _path: string }[] } };
    expect(payload.committed).toBe(true);
    expect(payload.commit).toMatch(/^c_/);
    expect(payload.hits.map((h) => h._path)).toEqual(["/other.md"]);
    expect(payload.pairs).toEqual([{ from: "/b.md", to: "/c.md", hits: 1 }]);
    expect(payload.revisions.map((r) => r._path)).toEqual(["/other.md"]);
    expect(readFileSync(join(root, "other.md"), "utf8")).toContain("(/c.md)");
    const { payload: none } = (await call("links_retarget", { from_target: "/zzz.md", to_target: "/c.md" })) as { payload: Repair };
    expect(none).toMatchObject({ hits: [], pairs: [{ from: "/zzz.md", to: "/c.md", hits: 0 }], commit: null, committed: true });
  });

  it("links_stale rows carry `authored`; summary:true returns counts grouped by target and source", async () => {
    const { payload } = (await call("links_stale", {})) as { payload: { stale: { target: string; authored: string | null; _anchor: string | null }[] } };
    const authored = payload.stale.map((s) => s.authored).sort();
    expect(authored).toContain("/b.md");
    expect(authored).toContain("/b.md#Top");
    for (const s of payload.stale) expect(s.target).toBe("/b.md");

    const { payload: sum } = (await call("links_stale", { summary: true })) as {
      payload: { staleCount: number; byTarget: { target: string; count: number }[]; bySource: { _path: string; count: number }[]; externalCount: number; totalOpenEdges: number; stale?: unknown };
    };
    expect(sum.stale).toBeUndefined();
    expect(sum.staleCount).toBe(payload.stale.length);
    expect(sum.byTarget).toEqual([{ target: "/b.md", count: payload.stale.length }]);
    expect(sum.bySource).toEqual([{ _path: "/list.md", count: payload.stale.length }]);
    expect(sum.externalCount).toBe(0);
  });

  it("blocks_update accepts multi-block markdown: target keeps its id, the siblings are minted under `new_ids` (the Receipt, 4.0)", async () => {
    await call("docs_create", { path: "m.md", markdown: "# M\n\nBody.\n\nTail.\n" });
    const { payload: before } = (await call("docs_read", { _path: "m.md", include_ids: true })) as { payload: { ids: string[] } };
    const [headId, bodyId, tailId] = before.ids as [string, string, string];
    const { payload, isError } = (await call("blocks_update", { _id: bodyId, markdown: "Body, edited.\n\nExtra para.\n\n- li" })) as {
      payload: { new_ids: Record<string, string>; committed: boolean; _id?: unknown; id?: unknown; ids?: unknown }; isError: boolean;
    };
    expect(isError).toBe(false);
    expect(payload.committed).toBe(true);
    expect(payload._id).toBeUndefined();
    expect(payload.id).toBeUndefined();
    expect(payload.ids).toBeUndefined();
    // the re-parse mints the first paragraph too (discarded: the target keeps its id, spec/mutate §10),
    // then the extra paragraph, the list and its nested item — four symbols, three of them live
    const minted = Object.values(payload.new_ids);
    expect(minted.length).toBe(4);
    const { payload: after } = (await call("docs_read", { _path: "m.md", include_ids: true })) as { payload: { ids: string[]; _raw: string } };
    expect(after._raw).toBe("# M\n\nBody, edited.\n\nExtra para.\n\n- li\n\nTail.\n");
    // include_ids flattens children: head, body, extra, list, (its item), tail
    expect(after.ids).toHaveLength(6);
    expect(after.ids[0]).toBe(headId);
    expect(after.ids[1]).toBe(bodyId);
    expect(after.ids.slice(2, 5).every((id) => minted.includes(id))).toBe(true);
    expect(after.ids[5]).toBe(tailId);
  });
});

// ---- profiles (spec/surface §4 "Profiles", 4.3) -----------------------------------
describe("tools profiles (spec/surface §4 \"Profiles\", 4.3)", () => {
  async function profiled(tools: "full" | "minimal"): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = buildServer({ store, repoId, tools });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(serverT), c.connect(clientT)]);
    return { client: c, close: async () => { await c.close(); await server.close(); } };
  }

  it("the minimal profile lists exactly MINIMAL_TOOLS, in registration order; full lists everything", async () => {
    const min = await profiled("minimal");
    const names = (await min.client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual([...MINIMAL_TOOLS].sort());
    const full = await profiled("full");
    const all = (await full.client.listTools()).tools.map((t) => t.name);
    expect(all.length).toBeGreaterThan(names.length);
    expect(all.filter((n) => MINIMAL_TOOLS.includes(n))).toEqual(names);
    await min.close();
    await full.close();
  });

  it("a tools/call on a tool the profile hides — or one that never existed — is the JSON-RPC -32602 error `unknown tool <name>`", async () => {
    const min = await profiled("minimal");
    for (const name of ["blocks_insert", "docs_outline", "nope"]) {
      let err: unknown = null;
      try {
        await min.client.callTool({ name, arguments: {} });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(-32602);
      // The SDK client prefixes the wire message; the wire text itself is the pinned one.
      expect((err as McpError).message.replace(/^MCP error -?\d+: /, "")).toBe(`unknown tool ${name}`);
    }
    await min.close();
    // The same text under full for an unknown name (the profile does not change it).
    let full: unknown = null;
    try {
      await client.callTool({ name: "docs_lits", arguments: {} });
    } catch (e) {
      full = e;
    }
    expect((full as McpError).code).toBe(-32602);
    expect((full as McpError).message.replace(/^MCP error -?\d+: /, "")).toBe("unknown tool docs_lits");
  });

  it("a profile filters listing and calling, never semantics: a kept tool answers as under full; version reports the profile", async () => {
    const min = await profiled("minimal");
    const read = async (c: Client, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[] };
      return JSON.parse(r.content[0]!.text) as unknown;
    };
    const argsErr = (await read(min.client, "docs_read", { q: "x" })) as { error: string; message: string };
    expect(argsErr.error).toBe("filter_invalid");
    expect(argsErr.message).toContain("unknown argument `q`");
    expect(await read(min.client, "docs_read", { _path: "notes.md" })).toEqual(await read(client, "docs_read", { _path: "notes.md" }));
    expect((await read(min.client, "version", {}) as { profile: string }).profile).toBe("minimal");
    expect((await read(client, "version", {}) as { profile: string }).profile).toBe("full");
    await min.close();
  });

  it("the constants agree: PROFILES.minimal admits exactly MINIMAL_TOOLS, full admits anything; parseToolsProfile knows the two names", () => {
    for (const t of MINIMAL_TOOLS) expect(PROFILES.minimal(t)).toBe(true);
    expect(PROFILES.minimal("blocks_insert")).toBe(false);
    expect(PROFILES.full("blocks_insert")).toBe(true);
    expect(TOOLS_PROFILES).toEqual(["full", "minimal"]);
    expect(parseToolsProfile("minimal")).toBe("minimal");
    expect(parseToolsProfile("full")).toBe("full");
    expect(parseToolsProfile("lite")).toBeNull();
    expect(parseToolsProfile(undefined)).toBeNull();
    const e = unknownTool("x") as Error & { code: number };
    expect(e.message).toBe("unknown tool x");
    expect(e.code).toBe(-32602);
  });
});
