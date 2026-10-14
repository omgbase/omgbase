// The Stream reconstructed from the daily logs: lines → transitions → episodes with durations.
import { describe, expect, it } from "vitest";
import { episodesOf, fetchStreamDay, fetchStreamDays, intentTotals, lastFocused, parseStream, streamTreeArgs, tagTotals } from "../src/lib/stream.ts";
import { ScriptedCaller } from "./scripted.ts";

const DAY = "2026-10-12";
const RAW = `---
type: attn-stream
date: '2026-10-12'
---

# 2026-10-12

- 07:40:00Z → /attn/intents/tend-the-garden.md (switch)
- 08:55:00Z → /attn/intents/distil-the-dew.md (switch)
- 11:30:00Z → /attn/intents/enjoy-lunch.md (switch)
- 12:10:00Z → /attn/intents/distil-the-dew.md (switch)
- 14:00:00Z → /attn/intents/write-to-nicolas.md (interrupt)
- 14:20:00Z → /attn/intents/distil-the-dew.md (back)
- correct 11:30:00Z was 11:35:00Z
- 17:05:00Z → none (stop)
`;

describe("parseStream", () => {
  it("reads every well-formed line, skips what it does not know, and reads `none` as a stop", () => {
    const t = parseStream(RAW, DAY);
    expect(t).toHaveLength(7);
    expect(t[0]).toEqual({ at: "2026-10-12T07:40:00.000Z", target: "/attn/intents/tend-the-garden.md", kind: "switch" });
    expect(t[4]).toEqual({ at: "2026-10-12T14:00:00.000Z", target: "/attn/intents/write-to-nicolas.md", kind: "interrupt" });
    expect(t[5]!.kind).toBe("back");
    expect(t[6]).toEqual({ at: "2026-10-12T17:05:00.000Z", target: null, kind: "stop" });
  });
});

describe("episodesOf", () => {
  const t = parseStream(RAW, DAY);
  it("each line's time ends the previous episode; a stop ends the last; a past day's open last episode runs to the day's end", () => {
    const e = episodesOf(t, DAY, { now: "2026-10-14T09:00:00.000Z" });
    expect(e.map((x) => [x.intent.replace("/attn/intents/", ""), x.seconds, x.endedBy])).toEqual([
      ["tend-the-garden.md", 75 * 60, "transition"],
      ["distil-the-dew.md", 155 * 60, "transition"],
      ["enjoy-lunch.md", 40 * 60, "transition"],
      ["distil-the-dew.md", 110 * 60, "transition"],
      ["write-to-nicolas.md", 20 * 60, "transition"],
      ["distil-the-dew.md", 165 * 60, "transition"],
    ]);
    const noStop = episodesOf(t.slice(0, 2), DAY, { now: "2026-10-14T09:00:00.000Z" });
    expect(noStop[1]).toMatchObject({ end: "2026-10-13T00:00:00.000Z", endedBy: "day-end" });
  });
  it("today's open episode runs to the clock", () => {
    const e = episodesOf(t.slice(0, 2), DAY, { now: "2026-10-12T10:00:00.000Z" });
    expect(e[1]).toMatchObject({ seconds: 65 * 60, endedBy: "now" });
  });
  it("a focus that began the day before is carried in from the pointer's since", () => {
    const pointer = { focused: "/attn/intents/read-mutus-liber.md", since: "2026-10-11T22:00:00.000Z" };
    const e = episodesOf(t.slice(0, 1), DAY, { now: "2026-10-12T08:00:00.000Z", pointer });
    expect(e[0]).toMatchObject({ intent: "/attn/intents/read-mutus-liber.md", start: "2026-10-12T00:00:00.000Z", end: "2026-10-12T07:40:00.000Z", seconds: 460 * 60, carried: true });
    expect(e[1]).toMatchObject({ intent: "/attn/intents/tend-the-garden.md", endedBy: "now" });
    // nothing carried when the day already starts with a line at 00:00, or the pointer's since is on this day
    expect(episodesOf(t, DAY, { now: "2026-10-14T09:00:00.000Z", pointer: { focused: "/x.md", since: "2026-10-12T01:00:00.000Z" } })[0]!.carried).toBe(false);
  });
  it("tag totals and intent totals sum the day", () => {
    const e = episodesOf(t, DAY, { now: "2026-10-14T09:00:00.000Z" });
    const tags = (p: string) => ({ "/attn/intents/tend-the-garden.md": ["garden", "rest"], "/attn/intents/distil-the-dew.md": ["aqua", "laboratory"], "/attn/intents/enjoy-lunch.md": ["rest"] } as Record<string, string[]>)[p] ?? [];
    expect(tagTotals(e, tags)).toEqual([
      { tag: "aqua", seconds: 430 * 60 }, { tag: "laboratory", seconds: 430 * 60 }, { tag: "rest", seconds: 115 * 60 }, { tag: "garden", seconds: 75 * 60 }, { tag: "untagged", seconds: 20 * 60 },
    ]);
    expect(intentTotals(e)[0]).toEqual({ intent: "/attn/intents/distil-the-dew.md", seconds: 430 * 60 });
  });
  it("lastFocused keeps the latest moment per intent", () => {
    const m = lastFocused(t);
    expect(m.get("/attn/intents/distil-the-dew.md")).toBe("2026-10-12T14:20:00.000Z");
    expect(m.get("/attn/intents/enjoy-lunch.md")).toBe("2026-10-12T11:30:00.000Z");
    expect(m.has("none")).toBe(false);
  });
});

describe("the calls", () => {
  it("days come from docs_tree over /attn/stream/ (following the cursor), newest first; a day from docs_read; a missing day is empty", async () => {
    const s = new ScriptedCaller({
      docs_tree: (a) => (a.cursor
        ? { prefix: "/attn/stream/", entries: [{ id: "d_3", path: "/attn/stream/2026-10-13.md", kind: "doc", docs: 1, blocks: 3 }], truncated: false, cursor: null }
        : { prefix: "/attn/stream/", entries: [{ id: "d_1", path: "/attn/stream/2026-10-11.md", kind: "doc", docs: 1, blocks: 3 }, { id: "d_2", path: "/attn/stream/2026-10-12.md", kind: "doc", docs: 1, blocks: 3 }, { path: "/attn/stream/old/", kind: "dir", docs: 1, blocks: 1 }], truncated: true, cursor: "c1" }),
      docs_read: (a) => (a.path === "/attn/stream/2026-10-12.md" ? { id: "d_2", path: a.path, rev: "r_1", raw: RAW } : { error: "doc_missing" }),
    });
    expect(await fetchStreamDays(s, null)).toEqual(["2026-10-13", "2026-10-12", "2026-10-11"]);
    expect(s.argsOf("docs_tree", 0)).toEqual(streamTreeArgs(null));
    expect(s.argsOf("docs_tree", 1)).toEqual({ path: "/attn/stream/", depth: 1, cursor: "c1" });
    expect((await fetchStreamDay(s, "2026-10-12", "attn"))).toHaveLength(7);
    expect(s.argsOf("docs_read", 0)).toEqual({ path: "/attn/stream/2026-10-12.md", repo: "attn" });
  });
});
