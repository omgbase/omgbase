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
import { canonicalJson } from "../mutate/canonical.js";

/** The `fix` of a stale or mismatched plan without a selector: `apply` over its effects (spec/mutate §8). */
const canonicalFix = (effects: unknown): string => canonicalJson({ effects });

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
  { op: "set", target: { kind: "document", _path: "/a.md" }, field: "_frontmatter.status", value: "active" },
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
    const { payload: plan, isError } = await call("plan", { effects: SLICE1, diffs: true });
    expect(isError).toBe(false);
    expect(plan.version).toBe(1);
    expect(plan.planner_v).toBe("p3");
    expect(plan.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect((plan.effects as { target: { _path: string } }[])[0]!.target._path).toBe("a.md");
    expect((plan.preconditions as { docs: { _path: string }[] }).docs[0]!._path).toBe("a.md");
    const preview = plan.preview as { revisions: { _path: string }[]; diffs: Record<string, unknown> };
    expect(preview.revisions[0]!._path).toBe("/a.md");
    expect(Object.keys(preview.diffs)).toEqual(["/a.md"]);
    expect(plan.new_ids).toEqual([{ symbol: "$new.0", kind: "block" }]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(DOC);
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("execute { plan } commits the plan and returns the Receipt with rooted revisions; a replay is stale_plan", async () => {
    const { payload: plan } = await call("plan", { effects: SLICE1 });
    const { payload: receipt, isError } = await call("execute", { plan, reason: "via mcp" });
    expect(isError).toBe(false);
    expect(receipt).toEqual({ plan_id: plan.plan_id, commit: "c_1", revisions: [{ _id: "d_0", _path: "/a.md", _hash: expect.any(String) }], new_ids: { "$new.0": expect.stringMatching(/^b_/) }, committed: true, summary: ['set _frontmatter.status = "active" in /a.md', 'insert 1 block at the end of section "Notes" in /a.md'] });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("---\nstatus: active\n---\n\n# Title\n\nIntro.\n\n## Notes\n\nFirst note.\n\nSecond note.\n");
    expect(store.db.prepare("SELECT actor, reason FROM commits WHERE commit_id = 'c_1'").get()).toEqual({ actor: "agent:mcp", reason: "via mcp" });
    const again = await call("execute", { plan });
    expect(again.isError).toBe(true);
    expect(again.payload).toMatchObject({ error: "stale_plan", retriable: true, data: { doc: "d_0", expected_revision: "r_0" } });
    // (4.4) the fix is the `apply` that re-plans and commits in one call, over the plan's concrete effects.
    expect((again.payload.data as { fix: string }).fix).toBe(canonicalFix(plan.effects));
  });

  it("the teaching surfaces (4.4): plan and every Receipt carry the summary in words; a selector plan's summary is its concrete effects'", async () => {
    const { payload: plan } = await call("plan", { effects: SLICE1 });
    expect((plan.preview as { summary: string[] }).summary).toEqual(['set _frontmatter.status = "active" in /a.md', 'insert 1 block at the end of section "Notes" in /a.md']);
    const { payload: receipt } = await call("apply", { effects: SLICE1 });
    expect(receipt.summary).toEqual((plan.preview as { summary: string[] }).summary);
    const sugar = await call("blocks_check", { _ids: [] });
    expect(sugar.isError).toBe(true); // an empty list is refused — the sugar tools' Receipts are covered by migration.test.ts
    const sel = await call("plan", { select: 'from docs where _path == "/a.md"', effects: [{ op: "set", field: "_frontmatter.seen", value: true }] });
    expect((sel.payload.preview as { summary: string[] }).summary).toEqual(["set _frontmatter.seen = true in /a.md"]);
    const none = await call("plan", { select: 'from docs where _path == "/nope.md"', effects: [{ op: "set", field: "_frontmatter.seen", value: true }] });
    expect((none.payload.preview as { summary: string[] }).summary).toEqual([]);
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

  it("apply takes `effects` (required; the 3.x `ops` and `dry_run` are retired by name); execute exactly one form", async () => {
    const neither = await call("apply", {});
    expect(neither.payload).toMatchObject({ error: "filter_invalid", message: "`effects` is required (apply takes effects, expect?, reason?, repo?, select?)", data: { hint: "arguments" } });
    const ops = await call("apply", { ops: [], effects: [] });
    expect(ops.payload).toMatchObject({ error: "filter_invalid", message: "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, expect?, reason?, repo?, select?)", data: { hint: "arguments" } });
    const dry = await call("apply", { effects: SLICE1, dry_run: true });
    expect(dry.payload).toMatchObject({ error: "filter_invalid", message: "`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (apply takes effects, expect?, reason?, repo?, select?)", data: { hint: "arguments" } });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
    const none = await call("execute", {});
    expect(none.payload).toMatchObject({ error: "filter_invalid", message: "pass exactly one of `plan` or `plan_id` + `effects` (execute takes effects?, expect?, plan?, plan_id?, reason?, repo?, select?)" });
    const half = await call("execute", { effects: SLICE1 });
    expect(half.payload).toMatchObject({ error: "filter_invalid", message: "the digest form needs both `plan_id` and `effects` (execute takes effects?, expect?, plan?, plan_id?, reason?, repo?, select?)" });
    const bothForms = await call("execute", { plan: { version: 1 }, plan_id: "x", effects: [] });
    expect(bothForms.payload.error).toBe("filter_invalid");
  });

  it("plan { effects } is the Plan; apply { effects } is the Receipt with the plan's id; a malformed effect is filter_invalid naming it", async () => {
    const dry = await call("plan", { effects: SLICE1 });
    expect(dry.isError).toBe(false);
    expect(dry.payload.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.payload.preview).toBeDefined();
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
    const wet = await call("apply", { effects: SLICE1, reason: "one shot" });
    expect(wet.isError).toBe(false);
    expect(wet.payload).toMatchObject({ plan_id: dry.payload.plan_id, commit: "c_1", committed: true });
    const bad = await call("apply", { effects: [{ op: "set", target: { kind: "document", _path: "/a.md" }, field: "title", value: 1 }] });
    expect(bad.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
    expect(bad.payload.message).toContain("effects[0]: a document's `field` is `_frontmatter.<key>` or `content`");
    const conflict = await call("apply", { effects: [SLICE1[0], { ...SLICE1[0]!, value: "other" }] });
    expect(conflict.payload).toMatchObject({ error: "conflicting_effects", retriable: false, data: { effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", _id: "d_0" }, field: "_frontmatter.status" } } });
  });

  it("every apply records its intent (`commits.ops`): the kernel ops path is gone from the surface (4.0)", async () => {
    const { payload, isError } = await call("apply", { effects: [{ op: "insert", into: { kind: "document", _id: "d_0" }, at: "end", markdown: "Appended." }] });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ revisions: [{ _id: "d_0", _path: "/a.md" }], new_ids: { "$new.0": expect.stringMatching(/^b_/) }, committed: true });
    const row = store.db.prepare("SELECT ops FROM commits WHERE origin = 'api'").get() as { ops: string };
    expect(row.ops).toMatch(/^\{"effects":\[/);
    const legacy = await call("apply", { ops: [{ op: "insert", doc: "d_0", to: { parent: { doc: true }, at: "end" }, markdown: "Appended." }] });
    expect(legacy.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
  });

  // ---- query-directed planning (4.1; spec/mutate §11.8) ----
  const SELECT = 'from docs where type == "note"';
  const TEMPLATES = [{ op: "set", field: "_frontmatter.seen", value: true }];
  async function seedNotes(): Promise<void> {
    writeFileSync(join(dir, "one.md"), "---\ntype: note\n---\n\n# One\n");
    writeFileSync(join(dir, "two.md"), "---\ntype: note\n---\n\n# Two\n");
    processCheckpoint(store, repoId, dir, [{ path: "one.md" }, { path: "two.md" }]);
  }

  it("plan { select, effects } returns the Plan with its selection verbatim and the concrete expansion; expect rides along", async () => {
    await seedNotes();
    const { payload, isError } = await call("plan", { select: SELECT, effects: TEMPLATES });
    expect(isError).toBe(false);
    expect(payload.planner_v).toBe("p3");
    expect(payload.selection).toEqual({ query: SELECT, templates: TEMPLATES, cardinality: 2, identities: ["d_1", "d_2"] });
    expect((payload.effects as { target: { _id: string; _path: string } }[]).map((e) => e.target)).toEqual([
      { kind: "document", _id: "d_1", _path: "one.md" }, { kind: "document", _id: "d_2", _path: "two.md" },
    ]);
    expect(Object.keys(payload.preview as object)).toEqual(["results", "revisions", "summary"]); // no `diffs` unless asked (4.5)
    const bounded = await call("plan", { select: SELECT, effects: TEMPLATES, expect: { max: 2 } });
    expect((bounded.payload.selection as { expect: unknown }).expect).toEqual({ max: 2 });
    const tooMany = await call("plan", { select: SELECT, effects: TEMPLATES, expect: { max: 1 } });
    expect(tooMany.payload).toMatchObject({ error: "selection_too_large", retriable: false, data: { cardinality: 2, max: 1 } });
    const refused = await call("plan", { select: `${SELECT} offset 1`, effects: TEMPLATES });
    expect(refused.payload).toMatchObject({ error: "filter_invalid", data: { hint: "selection" } });
    expect(refused.payload.message).toContain("`offset` is not allowed");
    const none = await call("plan", { select: 'from docs where type == "nope"', effects: TEMPLATES });
    expect(none.payload).toMatchObject({ effects: [], selection: { cardinality: 0, identities: [] } });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("apply { select } requires expect.max; the argument shapes of select/expect are checked first", async () => {
    await seedNotes();
    const noMax = await call("apply", { select: SELECT, effects: TEMPLATES });
    expect(noMax.payload).toMatchObject({ error: "filter_invalid", message: "`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`", data: { hint: "selection" } });
    const badExpect = await call("apply", { select: SELECT, effects: TEMPLATES, expect: 3 });
    expect(badExpect.payload).toMatchObject({ error: "filter_invalid", message: "`expect` must be an object (apply takes effects, expect?, reason?, repo?, select?)", data: { hint: "arguments" } });
    const badSelect = await call("apply", { select: 1, effects: TEMPLATES, expect: { max: 3 } });
    expect(badSelect.payload).toMatchObject({ error: "filter_invalid", message: "`select` must be a string (apply takes effects, expect?, reason?, repo?, select?)" });
    const noMaxKey = await call("apply", { select: SELECT, effects: TEMPLATES, expect: {} });
    expect(noMaxKey.payload).toMatchObject({ error: "filter_invalid", data: { hint: "arguments" } });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
    const ok = await call("apply", { select: SELECT, effects: TEMPLATES, expect: { max: 2 }, reason: "bulk" });
    expect(ok.isError).toBe(false);
    expect(ok.payload).toMatchObject({ commit: "c_3", revisions: [{ _id: "d_1", _path: "/one.md" }, { _id: "d_2", _path: "/two.md" }], new_ids: {}, committed: true });
    const row = store.db.prepare("SELECT ops FROM commits WHERE commit_id = 'c_3'").get() as { ops: string };
    expect(JSON.parse(row.ops)).toMatchObject({ v: 1, plan_id: ok.payload.plan_id, selection: { query: SELECT, expect: { max: 2 }, cardinality: 2 } });
    const zero = await call("apply", { select: 'from docs where type == "nope"', effects: TEMPLATES, expect: { max: 2 } });
    expect(zero.payload).toMatchObject({ commit: null, revisions: [], new_ids: {}, committed: true });
  });

  it("execute takes select/expect in the digest form only; the selector is re-run and digested", async () => {
    await seedNotes();
    const plan = await call("plan", { select: SELECT, effects: TEMPLATES, expect: { max: 5 } });
    const planForm = await call("execute", { plan: plan.payload, select: SELECT });
    expect(planForm.payload).toMatchObject({ error: "filter_invalid", message: "pass exactly one of `plan` or `plan_id` + `effects` (execute takes effects?, expect?, plan?, plan_id?, reason?, repo?, select?)" });
    const half = await call("execute", { select: SELECT, plan_id: plan.payload.plan_id });
    expect(half.payload).toMatchObject({ error: "filter_invalid", message: "the digest form needs both `plan_id` and `effects` (execute takes effects?, expect?, plan?, plan_id?, reason?, repo?, select?)" });
    const noExpect = await call("execute", { plan_id: plan.payload.plan_id, select: SELECT, effects: TEMPLATES });
    expect(noExpect.payload).toMatchObject({ error: "plan_mismatch", data: { expected: plan.payload.plan_id } });
    const done = await call("execute", { plan_id: plan.payload.plan_id, select: SELECT, effects: TEMPLATES, expect: { max: 5 } });
    expect(done.isError).toBe(false);
    expect(done.payload).toMatchObject({ plan_id: plan.payload.plan_id, commit: "c_3", committed: true });
    // the plan form of a selector plan replays without OQX: a fresh plan over the written state executes as given
    const again = await call("plan", { select: SELECT, effects: [{ op: "set", field: "_frontmatter.twice", value: true }] });
    const viaPlan = await call("execute", { plan: again.payload });
    expect(viaPlan.payload).toMatchObject({ plan_id: again.payload.plan_id, commit: "c_4" });
  });
});
