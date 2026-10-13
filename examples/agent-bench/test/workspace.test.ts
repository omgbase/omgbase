import { afterAll, describe, expect, it } from "vitest";
import { OmgServer } from "../src/mcp.ts";
import { createWorkspace, fixtureBytes, type Workspace } from "../src/workspace.ts";

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

async function docs(server: OmgServer): Promise<{ id: string; path: string }[]> {
  const r = await server.call("query", { query: "select id, path from docs order by path" });
  expect(r.ok).toBe(true);
  return (r.result as { hits: { id: string; path: string }[] }).hits;
}

describe("the workspace", () => {
  it("bootstraps deterministically: two fresh workspaces mint the same ids under the seams", async () => {
    const a = await fresh();
    const b = await fresh();
    const da = await docs(a.server);
    const db = await docs(b.server);
    expect(da).toEqual(db);
    expect(da).toHaveLength(20);
    expect(da.find((d) => d.path === "/index.md")?.id).toBe("d_0");
    expect(da.find((d) => d.path === "/substances/salt.md")?.id).toBe("d_14");
    // the ids the tasks name
    const tasks = await a.server.call("query", { query: 'select block_id from nodes where kind == "md:section" and name == "Tasks" and path == "/processes/calcination.md"' });
    expect((tasks.result as { hits: { block_id: string }[] }).hits).toEqual([expect.objectContaining({ block_id: "b_153" })]);
    const processes = await a.server.call("query", { query: 'select block_id from nodes where kind == "md:section" and name == "Processes" and path == "/index.md"' });
    expect((processes.result as { hits: { block_id: string }[] }).hits).toEqual([expect.objectContaining({ block_id: "b_12" })]);
  });

  it("serves the corpus bytes verbatim and knows the fixture bytes", async () => {
    const { server } = await fresh();
    const r = await server.call("docs_read", { path: "/substances/mercury.md" });
    expect(r.ok).toBe(true);
    expect((r.result as { raw: string }).raw).toBe(fixtureBytes("/substances/mercury.md"));
    expect(fixtureBytes("substances/mercury.md")).toBe(fixtureBytes("/substances/mercury.md"));
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
    const hidden = await server.call("docs_set_meta", { path: "/index.md", set: { x: 1 } });
    expect(hidden.ok).toBe(false);
    expect(hidden.error_code).toBe("unknown_tool");
    expect((await server.call("version", {})).result).toMatchObject({ profile: "minimal" });
  });
});
