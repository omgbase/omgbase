// Cue evaluation: the focus predicate wrapped around the focused row (and a
// predicate that does not parse surfacing as the engine's filter_invalid), time
// cues against the injected clock, query cues as a delta against a checkpoint,
// and the app-local delivery state (once per cue per episode; snooze; checkpoints).
import { describe, expect, it } from "vitest";
import { CUES_QUERY, Delivery, MemoryStorage, cueOf, dismissCueEffect, dueTimeCues, evaluateFocusCues, extractOqxFence, fetchCues, firingScope, focusCueQuery, queryCueDelta, type Cue } from "../src/lib/cues.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const QUERY_RAW = "---\ntype: cue\n---\n\n# New\n\nFires when:\n\n```oqx\nselect path from docs where type == \"intent\" and status == \"active\"\n```\n\nDoes it belong?\n";

const cue = (over: Partial<Cue>): Cue => ({ id: "d_c", path: "/attn/cues/c.md", title: "C", intent: "/attn/intents/calcine-the-salt.md", trigger: "focus", status: "active", when: null, at: null, query: null, text: "", ...over });

describe("shapes", () => {
  it("cueOf reads the frontmatter, the fence and the prose", () => {
    const c = cueOf({ id: "d_1", path: "/attn/cues/new.md", title: "New", intent: "/attn/intents/x.md", trigger: "query", status: "active", raw: QUERY_RAW });
    expect(c).toMatchObject({ trigger: "query", query: 'select path from docs where type == "intent" and status == "active"', text: "Fires when:\n\n\nDoes it belong?" });
    expect(extractOqxFence("no fence")).toBeNull();
    expect(cueOf({ id: "d", path: "/attn/cues/t.md", trigger: "time", at: "2026-10-13T16:00:00Z", status: "dismissed", raw: "" })).toMatchObject({ trigger: "time", at: "2026-10-13T16:00:00Z", status: "dismissed", title: "t" });
    expect(dismissCueEffect("/attn/cues/t.md")).toEqual({ op: "set", target: "/attn/cues/t.md", field: "frontmatter.status", value: "dismissed" });
  });
  it("fetchCues is one query over type == cue", async () => {
    const s = new ScriptedCaller({ query: () => page([{ id: "d_1", path: "/attn/cues/b.md", title: "B", trigger: "focus", when: "true", raw: "" }, { id: "d_2", path: "/attn/cues/a.md", title: "A", trigger: "time", at: "x", raw: "" }]) });
    const cs = await fetchCues(s, null);
    expect(cs.map((c) => c.title)).toEqual(["A", "B"]);
    expect(s.argsOf("query")).toEqual({ query: CUES_QUERY, limit: 500 });
    expect(CUES_QUERY).toBe('select path, title, intent, trigger, status, when, at, raw from docs where type == "cue" and path.startsWith("/attn/cues/")');
  });
});

describe("focus cues", () => {
  it("wrap the user's predicate around the newly focused row as an exists scalar", () => {
    expect(focusCueQuery("/attn/intents/calcine-the-salt.md", 'project == "magnum-opus" and "fire" in tags'))
      .toBe('docs exists { where path == "/attn/intents/calcine-the-salt.md" and (project == "magnum-opus" and "fire" in tags) }');
  });
  it("one query per active focus cue; fired on exists: true; a bad predicate is the engine's filter_invalid, per cue, never a throw", async () => {
    const cues = [
      cue({ path: "/attn/cues/heat.md", when: '"fire" in tags' }),
      cue({ path: "/attn/cues/dew.md", when: '"aqua" in tags' }),
      cue({ path: "/attn/cues/bad.md", when: "project == " }),
      cue({ path: "/attn/cues/off.md", when: "true", status: "dismissed" }),
      cue({ path: "/attn/cues/time.md", trigger: "time", at: "2026-10-13T16:00:00Z" }),
    ];
    const s = new ScriptedCaller({
      query: (a) => {
        const q = String(a.query);
        if (q.includes("project == )")) return new OmgError("filter_invalid", "unexpected ')' — expected a value (at offset 80)", { reason: "unexpected ')'", hint: "OQX" });
        return { hits: [], truncated: false, cursor: null, consumer: "exists", exists: q.includes('"fire"') };
      },
    });
    const r = await evaluateFocusCues(s, cues, "/attn/intents/calcine-the-salt.md", null);
    expect(r.map((x) => [x.cue.path, x.fired, x.error?.code ?? null])).toEqual([
      ["/attn/cues/heat.md", true, null],
      ["/attn/cues/dew.md", false, null],
      ["/attn/cues/bad.md", false, "filter_invalid"],
    ]);
    expect(r[2]!.error).toMatchObject({ hint: "OQX", message: expect.stringContaining("unexpected ')'") });
    expect(s.names()).toEqual(["query", "query", "query"]);
    expect(s.argsOf("query", 0)).toEqual({ query: 'docs exists { where path == "/attn/intents/calcine-the-salt.md" and ("fire" in tags) }' });
  });
});

describe("time cues", () => {
  it("fire when at ≤ the injected clock; dismissed, unparsable or future ones do not", () => {
    const cues = [
      cue({ path: "/a.md", trigger: "time", at: "2026-10-13T16:00:00Z" }),
      cue({ path: "/b.md", trigger: "time", at: "2026-10-14T09:00:00.000Z" }),
      cue({ path: "/c.md", trigger: "time", at: "2026-10-13T16:00:00Z", status: "dismissed" }),
      cue({ path: "/d.md", trigger: "time", at: "soon" }),
      cue({ path: "/e.md", trigger: "focus", when: "true" }),
    ];
    expect(dueTimeCues(cues, "2026-10-14T08:00:00.000Z").map((c) => c.path)).toEqual(["/a.md"]);
    expect(dueTimeCues(cues, "2026-10-14T09:00:00.000Z").map((c) => c.path)).toEqual(["/a.md", "/b.md"]);
  });
});

describe("query cues", () => {
  const q = cue({ path: "/attn/cues/new.md", trigger: "query", query: 'select path from docs where type == "intent"' });
  it("the first run only takes the checkpoint; later runs fire on ids that entered", async () => {
    let hits = [{ id: "d_1", path: "/attn/intents/a.md" }, { id: "d_2", path: "/attn/intents/b.md" }];
    const s = new ScriptedCaller({ query: () => page(hits) });
    const first = await queryCueDelta(s, q, null, null);
    expect(first).toMatchObject({ ids: ["d_1", "d_2"], entered: [], error: null });
    const same = await queryCueDelta(s, q, first.ids, null);
    expect(same.entered).toEqual([]);
    hits = [{ id: "d_2", path: "/attn/intents/b.md" }, { id: "d_3", path: "/attn/intents/c.md" }];
    const next = await queryCueDelta(s, q, first.ids, null);
    expect(next).toMatchObject({ ids: ["d_2", "d_3"], entered: ["d_3"], enteredHits: [{ id: "d_3", path: "/attn/intents/c.md" }] });
    expect(s.argsOf("query", 0)).toEqual({ query: q.query, limit: 500 });
  });
  it("a cue without a fence, or a query the engine refuses, reports an error and keeps the checkpoint", async () => {
    const s = new ScriptedCaller({ query: () => new OmgError("filter_invalid", "`nope` is not a target", { hint: "OQX" }) });
    expect((await queryCueDelta(s, cue({ trigger: "query" }), ["d_1"], null))).toMatchObject({ ids: ["d_1"], error: { code: "no_query" } });
    expect((await queryCueDelta(s, q, ["d_1"], null))).toMatchObject({ ids: ["d_1"], entered: [], error: { code: "filter_invalid" } });
  });
});

describe("delivery (app-local)", () => {
  it("a cue fires once per (cue, episode); a new episode offers it again; the scope per trigger", () => {
    const d = new Delivery(new MemoryStorage());
    const c = cue({});
    const ep1 = "/attn/intents/calcine-the-salt.md@2026-10-13T15:02:00.000Z";
    const ep2 = "/attn/intents/calcine-the-salt.md@2026-10-13T18:00:00.000Z";
    expect(firingScope(c, ep1)).toBe(`episode:${ep1}`);
    expect(firingScope(cue({ trigger: "time", at: "T" }), ep1)).toBe("time:T");
    expect(firingScope(cue({ trigger: "query" }), ep1, "d_3")).toBe("id:d_3");
    expect(d.shouldOffer(c, firingScope(c, ep1), ep1)).toBe(true);
    d.markFired(c, firingScope(c, ep1), "now");
    expect(d.shouldOffer(c, firingScope(c, ep1), ep1)).toBe(false);
    expect(d.shouldOffer(c, firingScope(c, ep2), ep2)).toBe(true);
    expect(d.shouldOffer(cue({ status: "dismissed" }), firingScope(c, ep2), ep2)).toBe(false);
  });
  it("snooze is quiet until the next focus boundary", () => {
    const d = new Delivery(new MemoryStorage());
    const c = cue({ trigger: "time", at: "T" });
    d.snooze(c, "ep1");
    expect(d.isSnoozed(c, "ep1")).toBe(true);
    expect(d.shouldOffer(c, "time:T", "ep1")).toBe(false);
    expect(d.shouldOffer(c, "time:T", "ep2")).toBe(true);
    expect(d.isSnoozed(c, null)).toBe(false);
  });
  it("persists to the storage and reloads from it; a corrupt value is an empty state", () => {
    const storage = new MemoryStorage();
    const d = new Delivery(storage, "k");
    const c = cue({ trigger: "query" });
    d.setCheckpoint(c, ["d_2", "d_1"]);
    d.markFired(c, "id:d_1", "now");
    const again = new Delivery(storage, "k");
    expect(again.checkpoint(c)).toEqual(["d_2", "d_1"]);
    expect(again.hasFired(c, "id:d_1")).toBe(true);
    expect(again.checkpoint(cue({ path: "/other.md" }))).toBeNull();
    storage.setItem("k", "{not json");
    expect(new Delivery(storage, "k").checkpoint(c)).toBeNull();
  });
});
