import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer } from "./server.js";

// spec/surface §4 (3.1): the Effect layer's verbs over MCP — `plan`, `execute`
// (both forms), `apply { effects }`; the argument exclusivity rules and their
// pinned messages; the error envelopes of the three new codes.

let dir: string;
let store: Store;
let repoId: string;
let client: Client;

type Res = { payload: Record<string, unknown>; isError: boolean };
async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { payload: JSON.parse(r.content[0]!.text), isError: r.isError ?? false };
}

const DOC = "---\nstatus: draft\n---\n\n# Title\n\nIntro.\n\n## Notes\n\nFirst note.\n";
const SLICE1 = [
  { op: "set", target: { kind: "document", path: "/a.md" }, field: "frontmatter.status", value: "active" },
  { op: "insert", into: { kind: "section", heading_id: "b_2" }, markdown: "Second note." },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-mcp-effects-"));
  store = new Store({ path: ":memory:" });
  setIdMinter(sequentialMinter());
  repoId = ensureRepo(store, "t", dir);
  writeFileSync(join(dir, "a.md"), DOC);
  processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
  const server = buildServer({ store, repoId, rootPath: dir });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});
afterEach(() => {
  setIdMinter(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("plan / execute / apply { effects } over MCP", () => {
  it("plan returns the Plan with its core in the storage form and its preview rooted; nothing is written", async () => {
    const { payload: plan, isError } = await call("plan", { effects: SLICE1 });
    expect(isError).toBe(false);
    expect(plan.version).toBe(1);
    expect(plan.planner_v).toBe("p2");
    expect(plan.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect((plan.effects as { target: { path: string } }[])[0]!.target.path).toBe("a.md");
    expect((plan.preconditions as { docs: { path: string }[] }).docs[0]!.path).toBe("a.md");
    const preview = plan.preview as { revisions: { path: string }[]; diffs: Record<string, unknown> };
    expect(preview.revisions[0]!.path).toBe("/a.md");
    expect(Object.keys(preview.diffs)).toEqual(["/a.md"]);
    expect(plan.new_ids).toEqual([{ symbol: "$new.0", kind: "block" }]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(DOC);
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("execute { plan } commits the plan and returns the Receipt with rooted revisions; a replay is stale_plan", async () => {
    const { payload: plan } = await call("plan", { effects: SLICE1 });
    const { payload: receipt, isError } = await call("execute", { plan, reason: "via mcp" });
    expect(isError).toBe(false);
    expect(receipt).toEqual({ plan_id: plan.plan_id, commit: "c_1", revisions: [{ id: "d_0", path: "/a.md", hash: expect.any(String) }], new_ids: { "$new.0": expect.stringMatching(/^b_/) }, committed: true });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("---\nstatus: active\n---\n\n# Title\n\nIntro.\n\n## Notes\n\nFirst note.\n\nSecond note.\n");
    expect(store.db.prepare("SELECT actor, reason FROM commits WHERE commit_id = 'c_1'").get()).toEqual({ actor: "agent:mcp", reason: "via mcp" });
    const again = await call("execute", { plan });
    expect(again.isError).toBe(true);
    expect(again.payload).toMatchObject({ error: "stale_plan", retriable: true, data: { doc: "d_0", expected_revision: "r_0" } });
  });

  it("execute { plan_id, effects } commits on digest equality and is plan_mismatch otherwise", async () => {
    const { payload: plan } = await call("plan", { effects: SLICE1 });
    const bad = await call("execute", { plan_id: "0".repeat(64), effects: SLICE1 });
    expect(bad.isError).toBe(true);
    expect(bad.payload).toMatchObject({ error: "plan_mismatch", retriable: false, data: { expected: "0".repeat(64), actual: plan.plan_id } });
    const good = await call("execute", { plan_id: plan.plan_id, effects: SLICE1 });
    expect(good.isError).toBe(false);
    expect(good.payload.commit).toBe("c_1");
  });

  it("execute refuses an unsupported plan version and an edited plan", async () => {
    const v2 = await call("execute", { plan: { version: 2 } });
    expect(v2.payload).toMatchObject({ error: "unsupported_plan_version", retriable: false, data: { version: 2, supported: [1] } });
    const { payload: plan } = await call("plan", { effects: SLICE1 });
    const edited = await call("execute", { plan: { ...plan, planner_v: "p9" } });
    expect(edited.payload).toMatchObject({ error: "plan_mismatch", data: { expected: plan.plan_id } });
    const malformed = await call("execute", { plan: { version: 1, planner_v: "p1" } });
    expect(malformed.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
  });

  it("argument exclusivity: apply takes exactly one of ops/effects; execute exactly one form", async () => {
    const neither = await call("apply", {});
    expect(neither.payload).toMatchObject({ error: "filter_invalid", message: "pass exactly one of `ops` or `effects` (apply takes dry_run?, effects?, ops?, reason?, repo?)", data: { hint: "arguments" } });
    const both = await call("apply", { ops: [], effects: [] });
    expect(both.payload.error).toBe("filter_invalid");
    const none = await call("execute", {});
    expect(none.payload).toMatchObject({ error: "filter_invalid", message: "pass exactly one of `plan` or `plan_id` + `effects` (execute takes effects?, plan?, plan_id?, reason?, repo?)" });
    const half = await call("execute", { effects: SLICE1 });
    expect(half.payload).toMatchObject({ error: "filter_invalid", message: "the digest form needs both `plan_id` and `effects` (execute takes effects?, plan?, plan_id?, reason?, repo?)" });
    const bothForms = await call("execute", { plan: { version: 1 }, plan_id: "x", effects: [] });
    expect(bothForms.payload.error).toBe("filter_invalid");
  });

  it("apply { effects, dry_run } is the Plan; apply { effects } is the Receipt; a malformed effect is filter_invalid naming it", async () => {
    const dry = await call("apply", { effects: SLICE1, dry_run: true });
    expect(dry.isError).toBe(false);
    expect(dry.payload.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.payload.preview).toBeDefined();
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
    const wet = await call("apply", { effects: SLICE1, reason: "one shot" });
    expect(wet.isError).toBe(false);
    expect(wet.payload).toMatchObject({ plan_id: dry.payload.plan_id, commit: "c_1", committed: true });
    const bad = await call("apply", { effects: [{ op: "set", target: { kind: "document", path: "/a.md" }, field: "title", value: 1 }] });
    expect(bad.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
    expect(bad.payload.message).toContain("effects[0]: a document's `field` is `frontmatter.<key>` or `content`");
    const conflict = await call("apply", { effects: [SLICE1[0], { ...SLICE1[0]!, value: "other" }] });
    expect(conflict.payload).toMatchObject({ error: "conflicting_effects", retriable: false, data: { effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", id: "d_0" }, field: "frontmatter.status" } } });
  });

  it("the legacy ops path is unchanged", async () => {
    const { payload, isError } = await call("apply", { ops: [{ op: "insert", doc: "d_0", to: { parent: { doc: true }, at: "end" }, markdown: "Appended." }] });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ results: [{ ids: [expect.stringMatching(/^b_/)] }], revisions: [{ id: "d_0", path: "/a.md" }], committed: true });
    expect(store.db.prepare("SELECT ops FROM commits WHERE origin = 'api'").get()).toEqual({ ops: null });
  });
});
