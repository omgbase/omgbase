// The exact `apply` payloads: switching focus writes the pointer ONLY (set
// focused_intent under expect.revision, set since, set return_stack when the
// stack changes); add is one create; add + focus is the create plus the
// pointer; define-cue is one `set frontmatter.cues` with the whole list.
import { describe, expect, it } from "vitest";
import { setCuesEffect, wireCue } from "../src/lib/cues.ts";
import { setContentEffect, setStatusEffect } from "../src/lib/intents.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import type { FocusState } from "../src/lib/pointer.ts";
import { POINTER_BODY, applyEffects, backEffects, createIntentEffect, declareAndFocusEffects, declareEffects, executePlan, interruptEffects, planEffects, receiptOf, stopEffects, switchEffects, type SwitchContext } from "../src/lib/writes.ts";
import { ScriptedCaller } from "./scripted.ts";

const NOW = "2026-10-13T16:10:00.000Z";
const SALT = "/attn/intents/2026/10/2026-10-12-calcine-the-salt.md";
const DEW = "/attn/intents/2026/10/2026-10-09-distil-the-dew.md";
const LUNCH = "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md";
const LETTER = "/attn/intents/2026/10/2026-10-10-write-to-nicolas.md";
const POINTER: FocusState = { exists: true, docId: "d_avkm6zx", rev: "r_35bctb5", focused: SALT, since: "2026-10-13T15:02:00.000Z", returnStack: [DEW] };
const ctx = (over: Partial<SwitchContext> = {}): SwitchContext => ({ pointer: POINTER, now: NOW, ...over });

const SET_FOCUSED = (value: string | null) => ({ op: "set", target: "/attn/focus.md", field: "frontmatter.focused_intent", value, expect: { revision: "r_35bctb5" } });
const SET_SINCE = { op: "set", target: "/attn/focus.md", field: "frontmatter.since", value: NOW };
const SET_STACK = (value: string[]) => ({ op: "set", target: "/attn/focus.md", field: "frontmatter.return_stack", value });

describe("a focus switch", () => {
  it("is set focused_intent (under CAS) + set since on the pointer, nothing else; the return stack is untouched", () => {
    expect(switchEffects(ctx(), LUNCH)).toEqual([SET_FOCUSED(LUNCH), SET_SINCE]);
  });
  it("creates the pointer when the workspace never focused anything (no CAS to hold)", () => {
    const effects = switchEffects(ctx({ pointer: { exists: false, docId: null, rev: null, focused: null, since: null, returnStack: [] } }), LUNCH);
    expect(effects).toEqual([{ op: "create", path: "/attn/focus.md", markdown: POINTER_BODY, frontmatter: { type: "/terms/types/attn-state.md", layer: "draft", focused_intent: LUNCH, since: NOW, return_stack: [] } }]);
    expect(POINTER_BODY.split("\n\n")[1]!.split(/(?<=\.) /)).toHaveLength(2); // two sentences
  });
  it("omits expect.revision only when the pointer has no rev", () => {
    const e = switchEffects(ctx({ pointer: { ...POINTER, rev: null } }), LUNCH);
    expect(e[0]).toEqual({ op: "set", target: "/attn/focus.md", field: "frontmatter.focused_intent", value: LUNCH });
  });
  it("never addresses an intent document", () => {
    for (const effects of [switchEffects(ctx(), LUNCH), interruptEffects(ctx(), LETTER), backEffects(ctx())!, stopEffects(ctx())]) {
      expect(effects.every((e) => e.target === "/attn/focus.md" || e.path === "/attn/focus.md")).toBe(true);
    }
  });
});

describe("interrupt, back, stop", () => {
  it("interrupt pushes the displaced intent on the return stack", () => {
    expect(interruptEffects(ctx(), LETTER)).toEqual([SET_FOCUSED(LETTER), SET_SINCE, SET_STACK([DEW, SALT])]);
  });
  it("interrupt with nothing in focus is an ordinary switch", () => {
    expect(interruptEffects(ctx({ pointer: { ...POINTER, focused: null, since: null } }), LETTER)).toEqual([SET_FOCUSED(LETTER), SET_SINCE]);
  });
  it("back resumes the top of the stack and pops it; null on an empty stack", () => {
    expect(backEffects(ctx())).toEqual([SET_FOCUSED(DEW), SET_SINCE, SET_STACK([])]);
    expect(backEffects(ctx({ pointer: { ...POINTER, returnStack: [] } }))).toBeNull();
  });
  it("stop clears the focus and keeps the stack", () => {
    expect(stopEffects(ctx())).toEqual([SET_FOCUSED(null), SET_SINCE]);
  });
});

describe("add an intent", () => {
  const NATALIE = "/attn/intents/2026/10/2026-10-13-talk-with-natalie.md";
  const intent = { path: NATALIE, title: "Talk with Natalie", tags: ["people"] };
  const CREATE = { op: "create", path: NATALIE, markdown: "# Talk with Natalie\n", frontmatter: { type: "/terms/types/intent.md", layer: "draft", status: "active", title: "Talk with Natalie", tags: ["people"] } };
  it("declare (Enter) is the create alone — the pointer is not touched", () => {
    expect(declareEffects(intent)).toEqual([CREATE]);
  });
  it("declare + focus (⌘Enter) is the create, then the pointer, one request", () => {
    expect(declareAndFocusEffects(ctx(), intent)).toEqual([CREATE, SET_FOCUSED(NATALIE), SET_SINCE]);
  });
  it("declare + interrupt (Shift+Enter) pushes the displaced intent too", () => {
    expect(declareAndFocusEffects(ctx(), intent, "interrupt")).toEqual([CREATE, SET_FOCUSED(NATALIE), SET_SINCE, SET_STACK([DEW, SALT])]);
  });
  it("an intent without tags has no tags key; a project and a body are kept", () => {
    expect(createIntentEffect({ path: "/attn/intents/2026/10/2026-10-13-x.md", title: "X", tags: [] })).toEqual({ op: "create", path: "/attn/intents/2026/10/2026-10-13-x.md", markdown: "# X\n", frontmatter: { type: "/terms/types/intent.md", layer: "draft", status: "active", title: "X" } });
    expect(createIntentEffect({ path: "/attn/intents/2026/10/2026-10-13-x.md", title: "X", tags: [], project: "/projects/garden.md", body: "Water first." })).toMatchObject({ markdown: "# X\n\nWater first.\n", frontmatter: { project: "/projects/garden.md" } });
  });
});

describe("the intent edits", () => {
  it("release / reactivate / edit are one set each", () => {
    expect(setStatusEffect(LUNCH, "released")).toEqual({ op: "set", target: LUNCH, field: "frontmatter.status", value: "released" });
    expect(setStatusEffect(LUNCH, "active")).toEqual({ op: "set", target: LUNCH, field: "frontmatter.status", value: "active" });
    expect(setContentEffect(LUNCH, "---\ntitle: Lunch\n---\n# Lunch\n")).toEqual({ op: "set", target: LUNCH, field: "content", value: "---\ntitle: Lunch\n---\n# Lunch\n" });
  });
  it("define-cue is set frontmatter.cues with the WHOLE list; queries end in a newline (a `query: |` block); no cues left is unset", () => {
    const cues = [
      { id: "when-opus-focused", on: "focus" as const, query: 'from docs\nwhere project == "/projects/magnum-opus.md"', at: null },
      { id: "review-tomorrow", on: "time" as const, query: null, at: "2026-10-15T09:00:00Z" },
      { id: "new-rest", on: "query-enter" as const, query: 'from docs where "rest" in tags\n\n', at: null },
    ];
    expect(setCuesEffect(SALT, cues)).toEqual({ op: "set", target: SALT, field: "frontmatter.cues", value: [
      { id: "when-opus-focused", on: "focus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n' },
      { id: "review-tomorrow", on: "time", at: "2026-10-15T09:00:00Z" },
      { id: "new-rest", on: "query-enter", query: 'from docs where "rest" in tags\n' },
    ] });
    expect(setCuesEffect(SALT, [])).toEqual({ op: "unset", target: SALT, field: "frontmatter.cues" });
    expect(wireCue({ id: "t", on: "time", query: "ignored", at: null })).toEqual({ id: "t", on: "time" });
  });
});

describe("the calls", () => {
  const RECEIPT = { plan_id: "p1", commit: "c_9", revisions: [{ id: "d_avkm6zx", path: "/attn/focus.md", hash: "h" }], new_ids: {}, committed: true, summary: ["set frontmatter.focused_intent = … in /attn/focus.md"] };
  it("applyEffects is one `apply { effects, reason }`; the Receipt is decoded", async () => {
    const s = new ScriptedCaller({ apply: () => RECEIPT });
    const effects = switchEffects(ctx(), LUNCH);
    const r = await applyEffects(s, effects, null, "attn switch");
    expect(s.calls).toEqual([{ name: "apply", args: { effects, reason: "attn switch" } }]);
    expect(r).toEqual({ planId: "p1", commit: "c_9", revisions: [{ id: "d_avkm6zx", path: "/attn/focus.md", hash: "h" }], newIds: {}, committed: true, summary: ["set frontmatter.focused_intent = … in /attn/focus.md"] });
    expect(receiptOf({ plan_id: "p", commit: null, revisions: [], committed: true, summary: [] }).commit).toBeNull();
  });
  it("a pointer that moved under us: stale_plan with the engine's fix (the request re-pinned), retriable", async () => {
    const s = new ScriptedCaller({
      apply: () => new OmgError("stale_plan", "document d_avkm6zx is at revision r_next, not r_35bctb5; re-plan", { doc: "d_avkm6zx", expected_revision: "r_35bctb5", current: { revision: "r_next", hash: "h2" }, retriable: true, effect_index: 0, fix: '{"effects":[…]}' }, false),
    });
    await expect(applyEffects(s, switchEffects(ctx(), LUNCH), null, "attn switch")).rejects.toMatchObject({ code: "stale_plan", data: { current: { revision: "r_next" }, fix: '{"effects":[…]}' } });
  });
  it("a new cue is plan { effects, diffs: true } then execute { plan_id, effects } with the same effects", async () => {
    const s = new ScriptedCaller({
      plan: () => ({ plan_id: "p7", preview: { revisions: [{ id: "d_1", path: SALT, hash: "h" }], summary: [`set frontmatter.cues = [{"id":"a","on":"focus","query":"from docs\\n"}] in ${SALT}`], diffs: { [SALT]: { before: "---\n…", after: "---\ncues:\n  - id: a\n…" } } } }),
      execute: (a) => ({ ...RECEIPT, plan_id: a.plan_id }),
    });
    const effects = [setCuesEffect(SALT, [{ id: "a", on: "focus", query: "from docs", at: null }])];
    const plan = await planEffects(s, effects, "attn");
    expect(plan.summary[0]).toMatch(/^set frontmatter\.cues = /);
    expect(plan.diffs[SALT]!.after).toContain("- id: a");
    await executePlan(s, plan, "attn", "attn define cue");
    expect(s.calls).toEqual([
      { name: "plan", args: { effects, diffs: true, repo: "attn" } },
      { name: "execute", args: { plan_id: "p7", effects, reason: "attn define cue", repo: "attn" } },
    ]);
  });
});
