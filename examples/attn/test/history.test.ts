// The Stream reconstructed from the pointer's revisions: a scripted
// `revisions` query + `docs_read { at }` per revision → states → transitions
// (kinds inferred from the stack) → episodes with durations, clipped to a day.
import { describe, expect, it } from "vitest";
import { REVISIONS_QUERY, daysOf, episodesOf, episodesOn, fetchPointerHistory, intentTotals, kindOf, lastFocused, tagTotals, transitionsOf, type PointerSnapshot } from "../src/lib/history.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const GARDEN = "/attn/intents/2026/10/2026-10-07-tend-the-garden.md";
const DEW = "/attn/intents/2026/10/2026-10-09-distil-the-dew.md";
const LUNCH = "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md";
const LETTER = "/attn/intents/2026/10/2026-10-10-write-to-nicolas.md";

/** The pointer's bytes as the engine renders them after a `set` (ISO unquoted, the stack a block list). */
const raw = (focused: string | null, since: string, stack: string[] = []) => `---
type: /terms/types/attn-state.md
layer: draft
focused_intent: ${focused ?? "null"}
since: ${since}
return_stack:${stack.length ? `\n${stack.map((s) => `  - ${s}`).join("\n")}` : " []"}
---

# Current focus

This document records the current focus.
`;

const REVS = [
  { rev: "r_1", seq: 1, ts: "2026-10-12T07:40:05.000Z", raw: raw(GARDEN, "2026-10-12T07:40:00.000Z") },
  { rev: "r_2", seq: 2, ts: "2026-10-12T08:55:01.000Z", raw: raw(DEW, "2026-10-12T08:55:00.000Z") },
  { rev: "r_3", seq: 3, ts: "2026-10-12T11:30:01.000Z", raw: raw(LUNCH, "2026-10-12T11:30:00.000Z") },
  { rev: "r_4", seq: 4, ts: "2026-10-12T12:10:01.000Z", raw: raw(DEW, "2026-10-12T12:10:00.000Z") },
  { rev: "r_5", seq: 5, ts: "2026-10-12T14:00:01.000Z", raw: raw(LETTER, "2026-10-12T14:00:00.000Z", [DEW]) },
  { rev: "r_6", seq: 6, ts: "2026-10-12T14:20:01.000Z", raw: raw(DEW, "2026-10-12T14:20:00.000Z") },
  { rev: "r_7", seq: 7, ts: "2026-10-12T17:05:01.000Z", raw: raw(null, "2026-10-12T17:05:00.000Z") },
  { rev: "r_8", seq: 8, ts: "2026-10-13T22:00:01.000Z", raw: raw(GARDEN, "2026-10-13T22:00:00.000Z") },
];

function server(revs = REVS): ScriptedCaller {
  return new ScriptedCaller({
    query: (a) => (String(a.query).startsWith("select rev, seq, ts from revisions") ? page(revs.map((r) => ({ id: r.rev, path: "/attn/focus.md", rev: r.rev, seq: r.seq, ts: r.ts }))) : page([])),
    docs_read: (a) => {
      const r = revs.find((x) => x.rev === a.at);
      return r ? { id: "d_focus", path: "/attn/focus.md", rev: r.rev, raw: r.raw, renderedHashMatch: true } : { error: "target_missing" };
    },
  });
}

describe("the calls", () => {
  it("one revisions query (pinned), then docs_read { path, at } per revision; the states read focused_intent / since / return_stack off raw", async () => {
    expect(REVISIONS_QUERY).toBe('select rev, seq, ts from revisions where path == "/attn/focus.md" order by seq');
    const s = server();
    const states = await fetchPointerHistory(s, "attn");
    expect(s.names()).toEqual(["query", ...Array<string>(8).fill("docs_read")]);
    expect(s.argsOf("query")).toEqual({ query: REVISIONS_QUERY, limit: 500, repo: "attn" });
    expect(s.argsOf("docs_read", 4)).toEqual({ path: "/attn/focus.md", at: "r_5", repo: "attn" });
    expect(states.map((x) => [x.seq, x.focused, x.since, x.returnStack])).toEqual([
      [1, GARDEN, "2026-10-12T07:40:00.000Z", []],
      [2, DEW, "2026-10-12T08:55:00.000Z", []],
      [3, LUNCH, "2026-10-12T11:30:00.000Z", []],
      [4, DEW, "2026-10-12T12:10:00.000Z", []],
      [5, LETTER, "2026-10-12T14:00:00.000Z", [DEW]],
      [6, DEW, "2026-10-12T14:20:00.000Z", []],
      [7, null, "2026-10-12T17:05:00.000Z", []],
      [8, GARDEN, "2026-10-13T22:00:00.000Z", []],
    ]);
  });
  it("revisions are immutable: a cache makes the second load read only the new revision", async () => {
    const cache = new Map();
    const s = server(REVS.slice(0, 7));
    await fetchPointerHistory(s, null, cache);
    expect(s.names().filter((n) => n === "docs_read")).toHaveLength(7);
    const s2 = server();
    const states = await fetchPointerHistory(s2, null, cache);
    expect(s2.names()).toEqual(["query", "docs_read"]);
    expect(s2.argsOf("docs_read")).toEqual({ path: "/attn/focus.md", at: "r_8" });
    expect(states).toHaveLength(8);
  });
});

describe("states → transitions", () => {
  const states: PointerSnapshot[] = REVS.map((r) => ({ rev: r.rev, seq: r.seq, ts: r.ts, focused: /focused_intent: (.*)/.exec(r.raw)![1] === "null" ? null : /focused_intent: (.*)/.exec(r.raw)![1]!, since: /since: (.*)/.exec(r.raw)![1]!, returnStack: r.raw.includes("  - ") ? [DEW] : [] }));
  it("infers the kind from the stack: grown → interrupt, shrunk → back, no focus → stop, else switch; at = since", () => {
    const t = transitionsOf(states);
    expect(t.map((x) => [x.at.slice(11, 16), x.target?.replace(/^.*\d{2}-/, "") ?? null, x.kind])).toEqual([
      ["07:40", "tend-the-garden.md", "switch"],
      ["08:55", "distil-the-dew.md", "switch"],
      ["11:30", "enjoy-lunch.md", "switch"],
      ["12:10", "distil-the-dew.md", "switch"],
      ["14:00", "write-to-nicolas.md", "interrupt"],
      ["14:20", "distil-the-dew.md", "back"],
      ["17:05", null, "stop"],
      ["22:00", "tend-the-garden.md", "switch"],
    ]);
    expect(kindOf(null, { focused: DEW, since: "t", returnStack: [] })).toBe("switch");
    expect(kindOf(null, { focused: DEW, since: "t", returnStack: [GARDEN] })).toBe("switch"); // an authored first state with a stack is not an interrupt
    expect(kindOf(null, { focused: null, since: "t", returnStack: [] })).toBe("stop");
  });
  it("a revision that did not move the focus is not a transition; a fresh pointer with nothing in focus is not a stop; a state without since falls back to ts", () => {
    const base: PointerSnapshot = { rev: "r_a", seq: 1, ts: "2026-10-12T07:00:00.000Z", focused: null, since: null, returnStack: [] };
    const t = transitionsOf([base, { ...base, rev: "r_b", seq: 2, ts: "2026-10-12T07:40:05.000Z", focused: GARDEN, since: "2026-10-12T07:40:00.000Z" }, { ...base, rev: "r_c", seq: 3, ts: "2026-10-12T08:00:00.000Z", focused: GARDEN, since: "2026-10-12T07:40:00.000Z", returnStack: ["/x.md"] }]);
    expect(t.map((x) => x.rev)).toEqual(["r_b"]);
    expect(transitionsOf([{ ...base, focused: GARDEN }])[0]!.at).toBe("2026-10-12T07:00:00.000Z");
  });
  it("episodes end at the next transition, the last at the clock; a day's view clips and carries; tag and intent totals; lastFocused", () => {
    const t = transitionsOf(states);
    const all = episodesOf(t, "2026-10-14T09:00:00.000Z");
    expect(all.map((e) => [e.intent.replace(/^.*\d{2}-/, ""), e.seconds, e.endedBy])).toEqual([
      ["tend-the-garden.md", 75 * 60, "transition"],
      ["distil-the-dew.md", 155 * 60, "transition"],
      ["enjoy-lunch.md", 40 * 60, "transition"],
      ["distil-the-dew.md", 110 * 60, "transition"],
      ["write-to-nicolas.md", 20 * 60, "transition"],
      ["distil-the-dew.md", 165 * 60, "transition"],
      ["tend-the-garden.md", 11 * 3600, "now"],
    ]);
    expect(all[4]!.kind).toBe("interrupt");
    const day12 = episodesOn(all, "2026-10-12");
    expect(day12).toHaveLength(6);
    expect(day12.every((e) => !e.carried)).toBe(true);
    const day13 = episodesOn(all, "2026-10-13");
    expect(day13).toEqual([{ ...all[6]!, start: "2026-10-13T22:00:00.000Z", end: "2026-10-14T00:00:00.000Z", seconds: 2 * 3600, endedBy: "day-end", carried: false }]);
    const day14 = episodesOn(all, "2026-10-14");
    expect(day14[0]).toMatchObject({ start: "2026-10-14T00:00:00.000Z", end: "2026-10-14T09:00:00.000Z", seconds: 9 * 3600, endedBy: "now", carried: true });
    expect(episodesOn(all, "2026-10-11")).toEqual([]);
    expect(daysOf(t, "2026-10-14T09:00:00.000Z")).toEqual(["2026-10-14", "2026-10-13", "2026-10-12"]);
    expect(daysOf([], "2026-10-14T09:00:00.000Z")).toEqual(["2026-10-14"]);
    const tags = (p: string) => ({ [GARDEN]: ["garden", "rest"], [DEW]: ["aqua", "laboratory"], [LUNCH]: ["rest"] } as Record<string, string[]>)[p] ?? [];
    expect(tagTotals(day12, tags)).toEqual([
      { tag: "aqua", seconds: 430 * 60 }, { tag: "laboratory", seconds: 430 * 60 }, { tag: "rest", seconds: 115 * 60 }, { tag: "garden", seconds: 75 * 60 }, { tag: "untagged", seconds: 20 * 60 },
    ]);
    expect(intentTotals(day12)[0]).toEqual({ intent: DEW, seconds: 430 * 60 });
    expect(lastFocused(t).get(DEW)).toBe("2026-10-12T14:20:00.000Z");
    expect(lastFocused(t).get(GARDEN)).toBe("2026-10-13T22:00:00.000Z");
  });
});
