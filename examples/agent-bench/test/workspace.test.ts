import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmgServer } from "../src/mcp.ts";
import { createWorkspace, fixtureBytes, parseOmgJson, resolveEmbedder, type Workspace } from "../src/workspace.ts";

const made: Workspace[] = [];
const spawned: OmgServer[] = [];
afterAll(async () => {
  for (const s of spawned) await s.close();
  for (const w of made) w.cleanup();
});

async function fresh(profile = "full"): Promise<{ ws: Workspace; server: OmgServer }> {
  const ws = createWorkspace();
  made.push(ws);
  const server = await OmgServer.spawn({ workspace: ws, profile });
  spawned.push(server);
  return { ws, server };
}

// The hit envelope is `{ _id, _path, … }` (spec/surface §1.4, 5.0); `docs { … }` and the row functions stay bare.
async function docs(server: OmgServer): Promise<{ _id: string; _path: string }[]> {
  const r = await server.call("query", { query: "docs { order by _path }" });
  expect(r.ok).toBe(true);
  return (r.result as { hits: { _id: string; _path: string }[] }).hits;
}

describe("the workspace", () => {
  it("bootstraps deterministically: two fresh workspaces mint the same ids under the seams", async () => {
    const a = await fresh();
    const b = await fresh();
    const da = await docs(a.server);
    const db = await docs(b.server);
    expect(da).toEqual(db);
    expect(da).toHaveLength(20);
    expect(da.find((d) => d._path === "/index.md")?._id).toBe("d_0");
    expect(da.find((d) => d._path === "/substances/salt.md")?._id).toBe("d_14");
    // the ids the tasks name — a node's engine attributes are `_kind`, `_name`, `_block_id`, `_path`
    const tasks = await a.server.call("query", { query: 'nodes { select _block_id where _kind == "md:section" and _name == "Tasks" and _path == "/processes/calcination.md" }' });
    expect((tasks.result as { hits: { _block_id: string }[] }).hits).toEqual([expect.objectContaining({ _block_id: "b_153" })]);
    const processes = await a.server.call("query", { query: 'nodes { select _block_id where _kind == "md:section" and _name == "Processes" and _path == "/index.md" }' });
    expect((processes.result as { hits: { _block_id: string }[] }).hits).toEqual([expect.objectContaining({ _block_id: "b_12" })]);
  });

  it("serves the corpus bytes verbatim (docs_read { _path } → _raw) and knows the fixture bytes", async () => {
    const { server } = await fresh();
    const r = await server.call("docs_read", { _path: "/substances/mercury.md" });
    expect(r.ok).toBe(true);
    expect((r.result as { _raw: string })._raw).toBe(fixtureBytes("/substances/mercury.md"));
    expect(fixtureBytes("substances/mercury.md")).toBe(fixtureBytes("/substances/mercury.md"));
    // No tolerance (spec/surface §4 "Arguments"): a bare `path` is an argument error whose `fix` is the `_path` spelling.
    const bare = await server.call("docs_read", { path: "/substances/mercury.md" });
    expect(bare.ok).toBe(false);
    expect(bare.error_code).toBe("filter_invalid");
    expect(bare.result).toMatchObject({ data: { hint: "arguments", fix: expect.stringContaining("_path") } });
  });

  it("tools/list under full is the 47-tool catalog, handed over verbatim", async () => {
    const { server } = await fresh();
    const tools = await server.tools();
    expect(tools).toHaveLength(47);
    expect(tools.map((t) => t.name)).toContain("docs_set_meta");
    const plan = tools.find((t) => t.name === "plan")!;
    expect(plan.description).toMatch(/^plan — /);
    expect(plan.input_schema).toMatchObject({ type: "object" });
  });

  it("an error envelope and a JSON-RPC refusal both come back as a failed call with a code", async () => {
    const { server } = await fresh();
    const bad = await server.call("docs_read", { q: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.error_code).toBe("filter_invalid");
    const unknown = await server.call("no_such_tool", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error_code).toBe("unknown_tool");
  });

  it("the minimal profile lists ten tools and refuses the rest (skipped when the omg build predates --tools)", async () => {
    const probe = await fresh();
    const v = await probe.server.call("version", {});
    if (!("profile" in (v.result as object))) return; // the flag is not in this build
    const { server } = await fresh("minimal");
    const tools = await server.tools();
    expect(tools.map((t) => t.name)).toEqual(["docs_read", "docs_tree", "query_syntax", "query", "blocks_resolve", "apply", "plan", "execute", "changes_since", "version"]);
    const hidden = await server.call("docs_set_meta", { _path: "/index.md", set: { x: 1 } });
    expect(hidden.ok).toBe(false);
    expect(hidden.error_code).toBe("unknown_tool");
    expect((await server.call("version", {})).result).toMatchObject({ profile: "minimal" });
  });
});

describe("omg's JSON output", () => {
  it("takes the last line that parses, tolerating a warning line before it; empty or non-JSON output is an error naming the command and what was printed", () => {
    expect(parseOmgJson({ stdout: '{"queued":0}\n', stderr: "" }, "omg --json embed status")).toEqual({ queued: 0 });
    expect(parseOmgJson({ stdout: 'warning: provider slow\n{"queued":3,"docsQueued":1}\n', stderr: "" }, "x")).toEqual({ queued: 3, docsQueued: 1 });
    expect(parseOmgJson({ stdout: '{"a":1}\n{"a":2}', stderr: "" }, "x")).toEqual({ a: 2 });
    expect(parseOmgJson({ stdout: "[1,2]\n", stderr: "" }, "x")).toEqual([1, 2]);
    // the provider crash: exit 0, nothing on stdout, the module error on stderr — the bare `Unexpected end of JSON input` of the 2026-10-21 run
    expect(() => parseOmgJson({ stdout: "", stderr: "Error: Cannot find module '/tmp/ws/packages/embedder/dist/src/bin.js'\n" }, "omg --json embed status"))
      .toThrow("omg --json embed status printed nothing on stdout; stderr: \"Error: Cannot find module '/tmp/ws/packages/embedder/dist/src/bin.js'\"");
    expect(() => parseOmgJson({ stdout: "not json at all\n", stderr: "" }, "omg --json sync")).toThrow('omg --json sync printed no JSON on stdout ("not json at all")');
  });

  it("resolveEmbedder makes a relative file path in the command absolute (omg spawns the provider inside the workspace); URLs, absolute paths and PATH commands pass through", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bench-embedder-"));
    mkdirSync(join(root, "packages/embedder/dist/src"), { recursive: true });
    writeFileSync(join(root, "packages/embedder/dist/src/bin.js"), "");
    expect(resolveEmbedder("node packages/embedder/dist/src/bin.js", root)).toBe(`node ${join(root, "packages/embedder/dist/src/bin.js")}`);
    expect(resolveEmbedder("node ./packages/embedder/dist/src/bin.js --flag", root)).toBe(`node ${join(root, "packages/embedder/dist/src/bin.js")} --flag`);
    expect(resolveEmbedder("node packages/embedder/dist/src/missing.js", root)).toBe("node packages/embedder/dist/src/missing.js"); // not a file: left for omg to report
    expect(resolveEmbedder("omgbase-embedder", root)).toBe("omgbase-embedder");
    expect(resolveEmbedder("http://localhost:8080/embed", root)).toBe("http://localhost:8080/embed");
    expect(resolveEmbedder(`node ${join(root, "packages/embedder/dist/src/bin.js")}`, root)).toBe(`node ${join(root, "packages/embedder/dist/src/bin.js")}`);
    // a bare JavaScript file as the command is run through node (omg spawns the provider directly; a built bin.js has a shebang but not always the executable bit)
    expect(resolveEmbedder("packages/embedder/dist/src/bin.js", root)).toBe(`node ${join(root, "packages/embedder/dist/src/bin.js")}`);
    expect(resolveEmbedder(`${join(root, "packages/embedder/dist/src/bin.js")} --flag`, root)).toBe(`node ${join(root, "packages/embedder/dist/src/bin.js")} --flag`);
    expect(resolveEmbedder("/elsewhere/embedder.mjs", root)).toBe("node /elsewhere/embedder.mjs");
    rmSync(root, { recursive: true, force: true });
  });
});
