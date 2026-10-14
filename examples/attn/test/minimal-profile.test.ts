// The claim the README makes — everything works on `omg mcp --tools minimal`
// — as a test: run each feature's data path against a scripted server that
// lists exactly the ten minimal tools and refuses every other name, and assert
// the tools it was asked for.
import { describe, expect, it } from "vitest";
import { dismissCueEffect, evaluateFocusCues, fetchCues, queryCueDelta } from "../src/lib/cues.ts";
import { fetchChanges } from "../src/lib/feed.ts";
import { fetchIntents, setStatusEffect } from "../src/lib/intents.ts";
import { fetchPointer } from "../src/lib/pointer.ts";
import { fetchStreamDay, fetchStreamDays } from "../src/lib/stream.ts";
import { MINIMAL_TOOLS, capabilities, missingToolsText, profileLabel } from "../src/lib/tools.ts";
import { surfaceProblem } from "../src/lib/paths.ts";
import { applyEffects, backEffects, createCueEffect, declareEffects, executePlan, interruptEffects, planEffects, stopEffects, switchEffects } from "../src/lib/writes.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const POINTER_WIRE = { id: "d_7", path: "/attn/current.md", rev: "r_7", properties: { frontmatter: { type: "attn-state", focused: "/attn/intents/a.md", since: "2026-10-13T15:02:00.000Z", return_stack: ["/attn/intents/b.md"] }, inline: {}, computed: {} }, raw: "" };

function minimalServer(): ScriptedCaller {
  return new ScriptedCaller({
    docs_read: (a) => (a.path === "/attn/current.md" ? POINTER_WIRE : { id: "d_9", path: a.path, rev: "r_1", raw: "# 2026-10-13\n\n- 15:02:00Z → /attn/intents/a.md (switch)\n" }),
    docs_tree: () => ({ prefix: "/attn/stream/", entries: [{ id: "d_9", path: "/attn/stream/2026-10-13.md", kind: "doc", docs: 1, blocks: 2 }], truncated: false, cursor: null }),
    query: (a) => {
      const q = String(a.query);
      if (q.startsWith("docs exists")) return { hits: [], truncated: false, cursor: null, consumer: "exists", exists: true };
      if (q.includes('type == "cue"')) return page([{ id: "d_c", path: "/attn/cues/c.md", title: "C", intent: "/attn/intents/a.md", trigger: "focus", status: "active", when: '"fire" in tags', raw: "" }, { id: "d_q", path: "/attn/cues/q.md", title: "Q", intent: "/attn/intents/a.md", trigger: "query", status: "active", raw: "```oqx\nselect path from docs where type == \"intent\"\n```\n" }]);
      return page([{ id: "d_a", path: "/attn/intents/a.md", title: "A", status: "active", tags: ["fire"], focus: { since: "2026-10-13T15:02:00.000Z" } }]);
    },
    changes_since: () => ({ digests: [], cursor: 1, truncated: false, head: 1 }),
    apply: () => ({ plan_id: "p", commit: "c_1", revisions: [], new_ids: {}, committed: true, summary: [] }),
    plan: () => ({ plan_id: "p2", preview: { revisions: [], summary: [], diffs: {} } }),
    execute: () => ({ plan_id: "p2", commit: "c_2", revisions: [], new_ids: {}, committed: true, summary: [] }),
    version: () => ({ specs: { surface: "4.7" }, profile: "minimal" }),
  });
}

describe("every feature over exactly the minimal ten", () => {
  it("pointer, intents (virtual #focus), cues (three triggers), stream, feed, every write", async () => {
    const s = minimalServer();
    const pointer = await fetchPointer(s, null);                                   // 1. the focus bar: the pointer
    const intents = await fetchIntents(s, null);                                   // 2. the intents with the virtual #focus
    const cues = await fetchCues(s, null);                                         // 3. the cues
    await evaluateFocusCues(s, cues, pointer.focused!, null);                      //    focus cues (one query each)
    await queryCueDelta(s, cues[1]!, null, null);                                  //    a query cue
    const days = await fetchStreamDays(s, null);                                   // 4. the stream's days
    await fetchStreamDay(s, days[0]!, null);                                       //    one day's lines
    await fetchChanges(s, null, null, 1);                                          // 6. live
    const ctx = { pointer, now: "2026-10-13T16:00:00.000Z", streamDays: days };
    await applyEffects(s, switchEffects(ctx, intents[0]!.path), null, "switch");   // writes: switch
    await applyEffects(s, interruptEffects(ctx, "/attn/intents/c.md"), null, "interrupt");
    await applyEffects(s, backEffects(ctx)!, null, "back");
    await applyEffects(s, stopEffects(ctx), null, "stop");
    await applyEffects(s, declareEffects(ctx, { path: "/attn/intents/d.md", title: "D", tags: [] }), null, "declare");
    await applyEffects(s, [setStatusEffect("/attn/intents/a.md", "released")], null, "release");
    await applyEffects(s, [dismissCueEffect("/attn/cues/c.md")], null, "dismiss");
    const plan = await planEffects(s, [createCueEffect({ path: "/attn/cues/n.md", title: "N", intent: "/attn/intents/a.md", trigger: "time", at: "2026-10-14T00:00:00Z", text: "" })], null); // 5. a new cue
    await executePlan(s, plan, null);
    const used = new Set(s.names());
    for (const name of used) expect(MINIMAL_TOOLS).toContain(name);
    expect([...used].sort()).toEqual(["apply", "changes_since", "docs_read", "docs_tree", "execute", "plan", "query"]);
    // `blocks_resolve` and `query_syntax` are not needed; `version` is the page's gate.
  });
  it("the scripted server refuses what the real minimal server refuses", async () => {
    const s = minimalServer();
    for (const name of ["repos", "docs_history", "docs_set_meta", "docs_create", "docs_append", "blocks_append", "docs_list"]) {
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
    expect(surfaceProblem("4.4")).toBeNull();
    expect(surfaceProblem("4.3")).toMatch(/needs omgbase surface ≥ 4\.4 .* the server reports 4\.3/);
    expect(surfaceProblem(null)).toMatch(/no surface version/);
  });
});
