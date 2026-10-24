import { describe, expect, it } from "vitest";
import { OmgError } from "../src/lib/mcp-client.ts";
import { executePlan, frontmatterPlanCommand, parseValue, planEffects, planIsNoop, planOf, receiptOf, setFrontmatterEffect, unsetFrontmatterEffect } from "../src/lib/writes.ts";
import { ScriptedCaller } from "./scripted.ts";

// The Plan the server returned for the probe's `set _frontmatter.verified = false` (preview with diffs), in the 5.0 spelling:
// the resolved target `{ kind: "document", _id, _path }`, the field `_frontmatter.<k>`, the preview revisions `{ _id, _path, _hash }`.
const PLAN_WIRE = {
  version: 1, planner_v: "p3",
  effects: [{ op: "set", target: { kind: "document", _id: "d_7", _path: "processes/calcination.md" }, field: "_frontmatter.verified", value: false }],
  plan_id: "3f2b06a044d93c47b1e01741583dd6b82dacd4f5df90699d1525d5b1487f14e0",
  diagnostics: [],
  preview: {
    results: [],
    revisions: [{ _id: "d_7", _path: "/processes/calcination.md", _hash: "dc27" }],
    diffs: { "/processes/calcination.md": { before: "---\nverified: true\n---\n\n# C\n", after: "---\nverified: false\n---\n\n# C\n" } },
    summary: ["set _frontmatter.verified = false in /processes/calcination.md"],
  },
};

describe("effects and values", () => {
  it("spells the frontmatter effects with a bare rooted path as the document target and the field as _frontmatter.<key> (spec/mutate 4.0)", () => {
    expect(setFrontmatterEffect("processes/calcination.md", "verified", false)).toEqual({ op: "set", target: "/processes/calcination.md", field: "_frontmatter.verified", value: false });
    expect(unsetFrontmatterEffect("/a.md", "stage")).toEqual({ op: "unset", target: "/a.md", field: "_frontmatter.stage" });
  });
  it("parseValue reads scalars the YAML-ish way, JSON for lists/objects/quoted strings, else text", () => {
    expect(parseValue("true")).toBe(true);
    expect(parseValue(" false ")).toBe(false);
    expect(parseValue("null")).toBeNull();
    expect(parseValue("3")).toBe(3);
    expect(parseValue("-1.5")).toBe(-1.5);
    expect(parseValue('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseValue('{"k": 1}')).toEqual({ k: 1 });
    expect(parseValue('"quoted"')).toBe("quoted");
    expect(parseValue("[not json")).toBe("[not json");
    expect(parseValue("nigredo")).toBe("nigredo");
    expect(parseValue("")).toBe("");
  });
});

describe("plan and receipt shapes", () => {
  it("planOf keeps the id, the summary, the rooted diffs, the preview revisions and the effects AS GIVEN", () => {
    const given = [setFrontmatterEffect("/processes/calcination.md", "verified", false)];
    const p = planOf(PLAN_WIRE, given);
    expect(p.planId).toBe(PLAN_WIRE.plan_id);
    expect(p.summary).toEqual(["set _frontmatter.verified = false in /processes/calcination.md"]);
    expect(Object.keys(p.diffs)).toEqual(["/processes/calcination.md"]);
    expect(p.revisions).toEqual([{ id: "d_7", path: "/processes/calcination.md", hash: "dc27" }]);
    expect(p.effects).toBe(given);
    expect(planIsNoop(p)).toBe(false);
    expect(planIsNoop(planOf({ ...PLAN_WIRE, preview: { revisions: [], summary: [] } }, given))).toBe(true);
  });
  it("receiptOf: the Receipt's revisions are { _id, _path, _hash }; commit null when nothing was committed", () => {
    expect(receiptOf({ plan_id: "p", commit: "c_20", revisions: [{ _id: "d_14", _path: "substances/salt.md", _hash: "h" }], new_ids: {}, committed: true, summary: ["set …"] }))
      .toEqual({ planId: "p", commit: "c_20", revisions: [{ id: "d_14", path: "/substances/salt.md", hash: "h" }], committed: true, summary: ["set …"] });
    expect(receiptOf({ plan_id: "p", commit: null, revisions: [], committed: true, summary: [] }).commit).toBeNull();
  });
});

describe("the write flow over a scripted minimal server", () => {
  it("plan { effects, diffs: true } then execute { plan_id, effects } with the same effects — never apply, never docs_set_meta", async () => {
    const s = new ScriptedCaller({
      plan: () => PLAN_WIRE,
      execute: (a) => ({ plan_id: a.plan_id, commit: "c_23", revisions: PLAN_WIRE.preview.revisions, new_ids: {}, committed: true, summary: PLAN_WIRE.preview.summary }),
    });
    const effects = [setFrontmatterEffect("/processes/calcination.md", "verified", parseValue("false"))];
    const plan = await planEffects(s, effects, "alchemy");
    const receipt = await executePlan(s, plan, "alchemy", "repo-explorer frontmatter edit");
    expect(receipt.commit).toBe("c_23");
    expect(s.calls).toEqual([
      { name: "plan", args: { effects, diffs: true, repo: "alchemy" } },
      { name: "execute", args: { plan_id: PLAN_WIRE.plan_id, effects, reason: "repo-explorer frontmatter edit", repo: "alchemy" } },
    ]);
  });
  it("a document that moved on: plan_mismatch with the engine's fix, retriable by planning again", async () => {
    const s = new ScriptedCaller({
      plan: () => PLAN_WIRE,
      execute: () => new OmgError("plan_mismatch", "the effects or the documents they target changed since the plan was made; re-plan", { data: { expected: "x", actual: "y", fix: '{"effects":[…]}' } }),
    });
    const plan = await planEffects(s, [setFrontmatterEffect("/a.md", "k", 1)], null);
    await expect(executePlan(s, plan, null)).rejects.toMatchObject({ code: "plan_mismatch", data: { fix: '{"effects":[…]}' } });
  });
  it("a sugar tool is refused by the scripted minimal server, as the real one refuses it", async () => {
    const s = new ScriptedCaller({});
    await expect(s.call("docs_set_meta", { _path: "/a.md", set: { k: 1 } })).rejects.toMatchObject({ code: "unknown_tool" });
  });
});

describe("frontmatterPlanCommand (the confirmed plan on the command log)", () => {
  const plan = planOf(PLAN_WIRE, [{ op: "set", target: "/processes/calcination.md", field: "_frontmatter.verified", value: false }]);
  const receipt = { plan_id: plan.planId, commit: "c_9", revisions: [{ _id: "d_7", _path: "/processes/calcination.md", _hash: "h2" }], new_ids: {}, committed: true, summary: ["set verified"] };
  const docAt = (verified: unknown, rev = "r_8") => ({ _id: "d_7", _path: "/processes/calcination.md", rev, properties: { frontmatter: verified === undefined ? {} : { verified }, inline: {}, computed: {} }, _raw: "" });
  const fake = (fm: unknown) => {
    const calls: { name: string; args: unknown }[] = [];
    const client = {
      call: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return receipt; },
      docsRead: async () => { calls.push({ name: "docs_read", args: {} }); return docAt(fm); },
      apply: async () => receipt, query: async () => ({ hits: [], truncated: false, cursor: null, consumer: "collect" as const }),
    };
    return { calls, ctx: { client: client as never } };
  };
  const cmd = frontmatterPlanCommand({ plan, path: "/processes/calcination.md", key: "verified", value: false, previous: true, existed: true, repo: "alchemy", reason: "edit" });

  it("apply commits the plan in the digest form (plan_id + the effects as given) with reason and repo, and remembers the key's previous value", async () => {
    const f = fake(false);
    const applied = await cmd.apply(f.ctx, { redo: false, previous: null });
    expect(f.calls).toEqual([{ name: "execute", args: { plan_id: plan.planId, effects: plan.effects, reason: "edit", repo: "alchemy" } }]);
    expect(applied.receipts[0]!.commit).toBe("c_9");
    expect(applied.state).toEqual({ key: "verified", value: false, previous: true, existed: true });
    expect(cmd.label).toBe("set verified in /processes/calcination.md");
  });

  it("compensate restores the previous value pinned to the current revision when the key still holds what the plan wrote", async () => {
    const f = fake(false);
    const c = await cmd.compensate(f.ctx, { receipts: [], revisions: [], state: { key: "verified", value: false, previous: true, existed: true } });
    expect(c).toEqual({ effects: [{ op: "set", target: { kind: "document", _path: "/processes/calcination.md" }, field: "_frontmatter.verified", value: true, expect: { revision: "r_8" } }], reason: "restore verified" });
  });

  it("compensate unsets a key the plan created, and REFUSES when the key moved on since", async () => {
    const created = await frontmatterPlanCommand({ plan, path: "/processes/calcination.md", key: "verified", value: false, previous: undefined, existed: false, repo: null })
      .compensate(fake(false).ctx, { receipts: [], revisions: [], state: { key: "verified", value: false, previous: undefined, existed: false } });
    expect(created).toEqual({ effects: [{ op: "unset", target: { kind: "document", _path: "/processes/calcination.md" }, field: "_frontmatter.verified", expect: { revision: "r_8" } }], reason: "restore verified" });
    const moved = await cmd.compensate(fake("later").ctx, { receipts: [], revisions: [], state: { key: "verified", value: false, previous: true, existed: true } });
    expect(moved).toEqual({ refused: expect.stringMatching(/verified in \/processes\/calcination\.md no longer holds what this edit wrote \(now "later"\)/) });
    const gone = await cmd.compensate(fake(undefined).ctx, { receipts: [], revisions: [], state: { key: "verified", value: false, previous: true, existed: true } });
    expect(gone).toEqual({ refused: expect.stringMatching(/now absent/) });
  });
});
