// The exact `apply` payloads: every mutation is one request of several
// effects, the stream line first (so a created stream day is `$new.0`), then
// the intent's create when declaring, then the pointer under `expect.revision`.
import { describe, expect, it } from "vitest";
import { OmgError } from "../src/lib/mcp-client.ts";
import type { FocusState } from "../src/lib/pointer.ts";
import { applyEffects, backEffects, createCueEffect, createIntentEffect, declareEffects, executePlan, interruptEffects, planEffects, receiptOf, stopEffects, streamLine, switchEffects, type SwitchContext } from "../src/lib/writes.ts";
import { ScriptedCaller } from "./scripted.ts";

const NOW = "2026-10-13T16:10:00.000Z";
const POINTER: FocusState = { exists: true, docId: "d_avkm6zx", rev: "r_35bctb5", focused: "/attn/intents/calcine-the-salt.md", since: "2026-10-13T15:02:00.000Z", returnStack: ["/attn/intents/distil-the-dew.md"] };
const ctx = (over: Partial<SwitchContext> = {}): SwitchContext => ({ pointer: POINTER, now: NOW, streamDays: ["2026-10-12", "2026-10-13"], ...over });

const SET_FOCUSED = (value: string | null) => ({ op: "set", target: "/attn/current.md", field: "frontmatter.focused", value, expect: { revision: "r_35bctb5" } });
const SET_SINCE = { op: "set", target: "/attn/current.md", field: "frontmatter.since", value: NOW };
const SET_STACK = (value: string[]) => ({ op: "set", target: "/attn/current.md", field: "frontmatter.return_stack", value });
const INSERT = (line: string) => ({ op: "insert", into: "/attn/stream/2026-10-13.md", at: "end", markdown: line });

describe("the stream line", () => {
  it("is one list item: the clock, the target (or none), the kind", () => {
    expect(streamLine(NOW, "/attn/intents/distil-the-dew.md", "switch")).toBe("- 16:10:00Z → /attn/intents/distil-the-dew.md (switch)");
    expect(streamLine(NOW, null, "stop")).toBe("- 16:10:00Z → none (stop)");
  });
});

describe("a focus switch", () => {
  it("is the stream insert + set focused (under CAS) + set since; the return stack is untouched", () => {
    expect(switchEffects(ctx(), "/attn/intents/enjoy-lunch.md")).toEqual([
      INSERT("- 16:10:00Z → /attn/intents/enjoy-lunch.md (switch)"),
      SET_FOCUSED("/attn/intents/enjoy-lunch.md"),
      SET_SINCE,
    ]);
  });
  it("creates today's stream document first when the day has none, and inserts into $new.0", () => {
    expect(switchEffects(ctx({ streamDays: ["2026-10-12"] }), "/attn/intents/enjoy-lunch.md")).toEqual([
      { op: "create", path: "/attn/stream/2026-10-13.md", markdown: "# 2026-10-13\n", frontmatter: { type: "attn-stream", date: "2026-10-13" } },
      { op: "insert", into: "$new.0", at: "end", markdown: "- 16:10:00Z → /attn/intents/enjoy-lunch.md (switch)" },
      SET_FOCUSED("/attn/intents/enjoy-lunch.md"),
      SET_SINCE,
    ]);
  });
  it("creates the pointer when the workspace never focused anything (no CAS to hold)", () => {
    const effects = switchEffects(ctx({ pointer: { exists: false, docId: null, rev: null, focused: null, since: null, returnStack: [] } }), "/attn/intents/enjoy-lunch.md");
    expect(effects[0]).toEqual(INSERT("- 16:10:00Z → /attn/intents/enjoy-lunch.md (switch)"));
    expect(effects[1]).toMatchObject({ op: "create", path: "/attn/current.md", frontmatter: { type: "attn-state", focused: "/attn/intents/enjoy-lunch.md", since: NOW, return_stack: [] } });
    expect(effects).toHaveLength(2);
  });
  it("omits expect.revision only when the pointer has no rev", () => {
    const e = switchEffects(ctx({ pointer: { ...POINTER, rev: null } }), "/attn/intents/enjoy-lunch.md");
    expect(e[1]).toEqual({ op: "set", target: "/attn/current.md", field: "frontmatter.focused", value: "/attn/intents/enjoy-lunch.md" });
  });
});

describe("interrupt, back, stop", () => {
  it("interrupt pushes the displaced intent on the return stack", () => {
    expect(interruptEffects(ctx(), "/attn/intents/write-to-nicolas.md")).toEqual([
      INSERT("- 16:10:00Z → /attn/intents/write-to-nicolas.md (interrupt)"),
      SET_FOCUSED("/attn/intents/write-to-nicolas.md"),
      SET_SINCE,
      SET_STACK(["/attn/intents/distil-the-dew.md", "/attn/intents/calcine-the-salt.md"]),
    ]);
  });
  it("interrupt with nothing in focus is an ordinary switch", () => {
    const e = interruptEffects(ctx({ pointer: { ...POINTER, focused: null, since: null } }), "/attn/intents/write-to-nicolas.md");
    expect(e.map((x) => x.op)).toEqual(["insert", "set", "set"]);
    expect(e[0]!.markdown).toContain("(switch)");
  });
  it("back resumes the top of the stack and pops it; null on an empty stack", () => {
    expect(backEffects(ctx())).toEqual([
      INSERT("- 16:10:00Z → /attn/intents/distil-the-dew.md (back)"),
      SET_FOCUSED("/attn/intents/distil-the-dew.md"),
      SET_SINCE,
      SET_STACK([]),
    ]);
    expect(backEffects(ctx({ pointer: { ...POINTER, returnStack: [] } }))).toBeNull();
  });
  it("stop clears the focus and keeps the stack", () => {
    expect(stopEffects(ctx())).toEqual([INSERT("- 16:10:00Z → none (stop)"), SET_FOCUSED(null), SET_SINCE]);
  });
});

describe("declare + focus", () => {
  const intent = { path: "/attn/intents/talk-with-natalie.md", title: "Talk with Natalie", tags: ["people"] };
  it("is the stream line, the intent's create, then the pointer — one request", () => {
    expect(declareEffects(ctx(), intent)).toEqual([
      INSERT("- 16:10:00Z → /attn/intents/talk-with-natalie.md (switch)"),
      { op: "create", path: "/attn/intents/talk-with-natalie.md", markdown: "# Talk with Natalie\n", frontmatter: { type: "intent", status: "active", tags: ["people"] } },
      SET_FOCUSED("/attn/intents/talk-with-natalie.md"),
      SET_SINCE,
    ]);
  });
  it("with a new stream day the created stream document stays $new.0 (the intent's create comes after the insert)", () => {
    const e = declareEffects(ctx({ streamDays: [] }), intent, "interrupt");
    expect(e.map((x) => `${x.op}:${x.path ?? x.into ?? x.field}`)).toEqual([
      "create:/attn/stream/2026-10-13.md", "insert:$new.0", "create:/attn/intents/talk-with-natalie.md", "set:frontmatter.focused", "set:frontmatter.since", "set:frontmatter.return_stack",
    ]);
    expect(e[1]!.markdown).toBe("- 16:10:00Z → /attn/intents/talk-with-natalie.md (interrupt)");
    expect(e[5]!.value).toEqual(["/attn/intents/distil-the-dew.md", "/attn/intents/calcine-the-salt.md"]);
  });
  it("an intent without tags has no tags key; a project is kept", () => {
    expect(createIntentEffect({ path: "/attn/intents/x.md", title: "X", tags: [] })).toEqual({ op: "create", path: "/attn/intents/x.md", markdown: "# X\n", frontmatter: { type: "intent", status: "active" } });
    expect(createIntentEffect({ path: "/attn/intents/x.md", title: "X", tags: [], project: "garden" }).frontmatter).toEqual({ type: "intent", status: "active", project: "garden" });
  });
});

describe("cues", () => {
  it("createCueEffect spells each trigger kind", () => {
    expect(createCueEffect({ path: "/attn/cues/a.md", title: "A", intent: "/attn/intents/x.md", trigger: "focus", when: '"fire" in tags', text: "Mind the heat." })).toEqual({
      op: "create", path: "/attn/cues/a.md", markdown: "# A\n\nMind the heat.\n", frontmatter: { type: "cue", intent: "/attn/intents/x.md", trigger: "focus", status: "active", when: '"fire" in tags' },
    });
    expect(createCueEffect({ path: "/attn/cues/b.md", title: "B", intent: "/attn/intents/x.md", trigger: "time", at: "2026-10-14T16:00:00Z", text: "" })).toEqual({
      op: "create", path: "/attn/cues/b.md", markdown: "# B\n", frontmatter: { type: "cue", intent: "/attn/intents/x.md", trigger: "time", status: "active", at: "2026-10-14T16:00:00Z" },
    });
    expect(createCueEffect({ path: "/attn/cues/c.md", title: "C", intent: "/attn/intents/x.md", trigger: "query", query: "select path from docs where type == \"intent\"", text: "New?" }).markdown)
      .toBe("# C\n\n```oqx\nselect path from docs where type == \"intent\"\n```\n\nNew?\n");
  });
});

describe("the calls", () => {
  const RECEIPT = { plan_id: "p1", commit: "c_9", revisions: [{ id: "d_avkm6zx", path: "/attn/current.md", hash: "h" }], new_ids: { "$new.0": "b_1" }, committed: true, summary: ["set frontmatter.focused = … in /attn/current.md"] };
  it("applyEffects is one `apply { effects, reason }`; the Receipt is decoded", async () => {
    const s = new ScriptedCaller({ apply: () => RECEIPT });
    const effects = switchEffects(ctx(), "/attn/intents/enjoy-lunch.md");
    const r = await applyEffects(s, effects, null, "attn switch");
    expect(s.calls).toEqual([{ name: "apply", args: { effects, reason: "attn switch" } }]);
    expect(r).toEqual({ planId: "p1", commit: "c_9", revisions: [{ id: "d_avkm6zx", path: "/attn/current.md", hash: "h" }], newIds: { "$new.0": "b_1" }, committed: true, summary: ["set frontmatter.focused = … in /attn/current.md"] });
    expect(receiptOf({ plan_id: "p", commit: null, revisions: [], committed: true, summary: [] }).commit).toBeNull();
  });
  it("a pointer that moved under us: stale_plan with the engine's fix (the request re-pinned), retriable", async () => {
    const s = new ScriptedCaller({
      apply: () => new OmgError("stale_plan", "document d_avkm6zx is at revision r_next, not r_35bctb5; re-plan", { doc: "d_avkm6zx", expected_revision: "r_35bctb5", current: { revision: "r_next", hash: "h2" }, retriable: true, effect_index: 1, fix: '{"effects":[…]}' }, false),
    });
    await expect(applyEffects(s, switchEffects(ctx(), "/attn/intents/enjoy-lunch.md"), null, "attn switch")).rejects.toMatchObject({ code: "stale_plan", data: { current: { revision: "r_next" }, fix: '{"effects":[…]}' } });
  });
  it("a new cue is plan { effects, diffs: true } then execute { plan_id, effects } with the same effects", async () => {
    const s = new ScriptedCaller({
      plan: () => ({ plan_id: "p7", preview: { revisions: [{ id: "$new.0", path: "/attn/cues/a.md", hash: "h" }], summary: ["create /attn/cues/a.md (2 blocks)"], diffs: { "/attn/cues/a.md": { before: "", after: "---\n…" } } } }),
      execute: (a) => ({ ...RECEIPT, plan_id: a.plan_id }),
    });
    const effects = [createCueEffect({ path: "/attn/cues/a.md", title: "A", intent: "/attn/intents/x.md", trigger: "focus", when: "true", text: "t" })];
    const plan = await planEffects(s, effects, "attn");
    expect(plan.summary).toEqual(["create /attn/cues/a.md (2 blocks)"]);
    expect(plan.diffs["/attn/cues/a.md"]!.after).toBe("---\n…");
    await executePlan(s, plan, "attn", "attn new cue");
    expect(s.calls).toEqual([
      { name: "plan", args: { effects, diffs: true, repo: "attn" } },
      { name: "execute", args: { plan_id: "p7", effects, reason: "attn new cue", repo: "attn" } },
    ]);
  });
});
