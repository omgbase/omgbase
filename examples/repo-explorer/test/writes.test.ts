import { describe, expect, it } from "vitest";
import { OmgError } from "../src/lib/mcp-client.ts";
import { executePlan, parseValue, planEffects, planIsNoop, planOf, receiptOf, setFrontmatterEffect, unsetFrontmatterEffect } from "../src/lib/writes.ts";
import { ScriptedCaller } from "./scripted.ts";

// The Plan the server returned for the probe's `set frontmatter.verified = false` (preview with diffs).
const PLAN_WIRE = {
  version: 1, planner_v: "p3",
  effects: [{ op: "set", target: { kind: "document", id: "d_7", path: "processes/calcination.md" }, field: "frontmatter.verified", value: false }],
  plan_id: "3f2b06a044d93c47b1e01741583dd6b82dacd4f5df90699d1525d5b1487f14e0",
  diagnostics: [],
  preview: {
    results: [],
    revisions: [{ id: "d_7", path: "/processes/calcination.md", hash: "dc27" }],
    diffs: { "/processes/calcination.md": { before: "---\nverified: true\n---\n\n# C\n", after: "---\nverified: false\n---\n\n# C\n" } },
    summary: ["set frontmatter.verified = false in /processes/calcination.md"],
  },
};

describe("effects and values", () => {
  it("spells the frontmatter effects with a bare rooted path as the document target", () => {
    expect(setFrontmatterEffect("processes/calcination.md", "verified", false)).toEqual({ op: "set", target: "/processes/calcination.md", field: "frontmatter.verified", value: false });
    expect(unsetFrontmatterEffect("/a.md", "stage")).toEqual({ op: "unset", target: "/a.md", field: "frontmatter.stage" });
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
    expect(p.summary).toEqual(["set frontmatter.verified = false in /processes/calcination.md"]);
    expect(Object.keys(p.diffs)).toEqual(["/processes/calcination.md"]);
    expect(p.revisions).toEqual([{ id: "d_7", path: "/processes/calcination.md", hash: "dc27" }]);
    expect(p.effects).toBe(given);
    expect(planIsNoop(p)).toBe(false);
    expect(planIsNoop(planOf({ ...PLAN_WIRE, preview: { revisions: [], summary: [] } }, given))).toBe(true);
  });
  it("receiptOf: commit null when nothing was committed", () => {
    expect(receiptOf({ plan_id: "p", commit: "c_20", revisions: [{ id: "d_14", path: "substances/salt.md", hash: "h" }], new_ids: {}, committed: true, summary: ["set …"] }))
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
      execute: () => new OmgError("plan_mismatch", "the effects or the documents they target changed since the plan was made; re-plan", { expected: "x", actual: "y", fix: '{"effects":[…]}' }),
    });
    const plan = await planEffects(s, [setFrontmatterEffect("/a.md", "k", 1)], null);
    await expect(executePlan(s, plan, null)).rejects.toMatchObject({ code: "plan_mismatch", data: { fix: '{"effects":[…]}' } });
  });
  it("a sugar tool is refused by the scripted minimal server, as the real one refuses it", async () => {
    const s = new ScriptedCaller({});
    await expect(s.call("docs_set_meta", { path: "/a.md", set: { k: 1 } })).rejects.toMatchObject({ code: "unknown_tool" });
  });
});
