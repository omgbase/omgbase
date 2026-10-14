// The claim the README makes — everything works on `omg mcp --tools minimal`
// — as a test: run each feature's data path against a scripted server that
// lists exactly the ten minimal tools and refuses every other name, and assert
// the tools it was asked for.
import { describe, expect, it } from "vitest";
import { evaluateFocusCues, queryTransitionDelta, setCuesEffect } from "../src/lib/cues.ts";
import { fetchChanges } from "../src/lib/feed.ts";
import { fetchPointerHistory } from "../src/lib/history.ts";
import { activeCues, fetchIntents, setContentEffect, setStatusEffect } from "../src/lib/intents.ts";
import { fetchPointer } from "../src/lib/pointer.ts";
import { MINIMAL_TOOLS, capabilities, missingToolsText, profileLabel } from "../src/lib/tools.ts";
import { surfaceProblem } from "../src/lib/paths.ts";
import { applyEffects, backEffects, declareAndFocusEffects, declareEffects, executePlan, interruptEffects, planEffects, stopEffects, switchEffects } from "../src/lib/writes.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const A = "/attn/intents/2026/10/2026-10-12-a.md";
const B = "/attn/intents/2026/10/2026-10-11-b.md";
const POINTER_RAW = `---\ntype: /terms/types/attn-state.md\nlayer: draft\nfocused_intent: ${A}\nsince: 2026-10-13T15:02:00.000Z\nreturn_stack:\n  - ${B}\n---\n\n# Current focus\n`;
const POINTER_WIRE = { id: "d_7", path: "/attn/focus.md", rev: "r_7", properties: { frontmatter: { type: "/terms/types/attn-state.md", layer: "draft", focused_intent: A, since: "2026-10-13T15:02:00.000Z", return_stack: [B] }, inline: {}, computed: {} }, raw: POINTER_RAW };

function minimalServer(): ScriptedCaller {
  return new ScriptedCaller({
    docs_read: (a) => (a.at ? { id: "d_7", path: "/attn/focus.md", rev: a.at, raw: POINTER_RAW, renderedHashMatch: true } : a.path === "/attn/focus.md" ? POINTER_WIRE : { id: "d_a", path: a.path, rev: "r_1", raw: "---\ntitle: A\n---\n# A\n" }),
    query: (a) => {
      const q = String(a.query);
      if (q.startsWith("select rev, seq, ts from revisions")) return page([{ id: "r_1", rev: "r_1", seq: 1, ts: "2026-10-13T15:02:01.000Z" }, { id: "r_7", rev: "r_7", seq: 2, ts: "2026-10-13T15:30:01.000Z" }]);
      if (q.includes('"/terms/types/intent.md"')) return page([
        { id: "d_a", path: A, title: "A", status: "active", tags: ["fire"], updated_at: "2026-10-13T08:00:00.000Z", cues: [[{ id: "f", on: "focus", query: 'from docs where "fire" in tags' }, { id: "n", on: "query-enter", query: 'from docs where type == "/terms/types/intent.md"' }, { id: "x", on: "query-exit", query: 'from docs where status == "active"' }]], focus: { since: "2026-10-13T15:02:00.000Z" } },
        { id: "d_b", path: B, title: "B", status: "active", tags: [], updated_at: "2026-10-12T08:00:00.000Z", focus: null },
      ]);
      return page([{ id: "d_a", path: A }]); // a cue's own query
    },
    changes_since: () => ({ digests: [], cursor: 1, truncated: false, head: 1 }),
    apply: () => ({ plan_id: "p", commit: "c_1", revisions: [], new_ids: {}, committed: true, summary: [] }),
    plan: () => ({ plan_id: "p2", preview: { revisions: [], summary: [], diffs: {} } }),
    execute: () => ({ plan_id: "p2", commit: "c_2", revisions: [], new_ids: {}, committed: true, summary: [] }),
    version: () => ({ specs: { surface: "4.7" }, profile: "minimal" }),
  });
}

describe("every feature over exactly the minimal ten", () => {
  it("pointer, feed (virtual #focus + cues), the four cue variants, the stream from revisions, live, every write", async () => {
    const s = minimalServer();
    const pointer = await fetchPointer(s, null);                                            // 1. the focus bar: the pointer
    const intents = await fetchIntents(s, null);                                            // 2. the feed: one query
    const cues = activeCues(intents);
    await evaluateFocusCues(s, cues, { path: pointer.focused!, id: intents[0]!.id }, null); //    focus cues (one query each, membership)
    await queryTransitionDelta(s, cues[1]!, null, null);                                    //    an enter cue
    await queryTransitionDelta(s, cues[2]!, ["d_a", "d_z"], null);                          //    an exit cue
    const states = await fetchPointerHistory(s, null);                                      // 3. the stream: revisions + docs_read { at }
    expect(states).toHaveLength(2);
    await fetchChanges(s, null, null, 1);                                                   // 4. live
    const ctx = { pointer, now: "2026-10-13T16:00:00.000Z" };
    await applyEffects(s, switchEffects(ctx, B), null, "switch");                           // writes: switch
    await applyEffects(s, interruptEffects(ctx, B), null, "interrupt");
    await applyEffects(s, backEffects(ctx)!, null, "back");
    await applyEffects(s, stopEffects(ctx), null, "stop");
    await applyEffects(s, declareEffects({ path: "/attn/intents/2026/10/2026-10-13-d.md", title: "D", tags: [] }), null, "add");
    await applyEffects(s, declareAndFocusEffects(ctx, { path: "/attn/intents/2026/10/2026-10-13-e.md", title: "E", tags: [] }), null, "add + focus");
    await applyEffects(s, [setStatusEffect(A, "released")], null, "release");
    await applyEffects(s, [setContentEffect(A, "---\ntitle: A\n---\n# A!\n")], null, "edit");
    await applyEffects(s, [setCuesEffect(A, cues.slice(1))], null, "remove cue");
    const plan = await planEffects(s, [setCuesEffect(A, [...cues, { id: "t", on: "time", query: null, at: "2026-10-14T00:00:00Z" }])], null); // 5. define a cue
    await executePlan(s, plan, null);
    const used = new Set(s.names());
    for (const name of used) expect(MINIMAL_TOOLS).toContain(name);
    expect([...used].sort()).toEqual(["apply", "changes_since", "docs_read", "execute", "plan", "query"]);
    // `blocks_resolve`, `docs_tree` and `query_syntax` are not needed; `version` is the page's gate.
    expect(s.calls.filter((c) => c.name === "docs_read" && c.args.at).map((c) => c.args.path)).toEqual(["/attn/focus.md", "/attn/focus.md"]);
  });
  it("the scripted server refuses what the real minimal server refuses", async () => {
    const s = minimalServer();
    for (const name of ["repos", "docs_history", "docs_read_at", "docs_set_meta", "docs_create", "docs_update", "docs_append", "docs_list"]) {
      await expect(s.call(name, {})).rejects.toMatchObject({ code: "unknown_tool" });
    }
  });
  it("capabilities and the gate", () => {
    const c = capabilities([...MINIMAL_TOOLS]);
    expect(c).toMatchObject({ minimal: true, missing: [], repos: false, beyondMinimal: [] });
    expect(profileLabel(null, c)).toBe("minimal (by its listing)");
    expect(missingToolsText(capabilities(MINIMAL_TOOLS.filter((t) => t !== "apply")))).toMatch(/`apply` \(every focus switch/);
    expect(capabilities(null).minimal).toBe(true);
    expect(surfaceProblem("4.7")).toBeNull();
    expect(surfaceProblem("5.0")).toBeNull();
    expect(surfaceProblem("4.6")).toMatch(/needs omgbase surface ≥ 4\.7 .* the server reports 4\.6/);
    expect(surfaceProblem(null)).toMatch(/no surface version/);
  });
});
