// Cues as frontmatter entries: reading them off an intent row, the focus cue's
// MEMBERSHIP test (the query run as authored, the focused intent looked for
// among the hits), time cues against the injected clock, enter / exit cues as a
// delta against a checkpoint (the first run baselines silently), and the
// app-local delivery (once per cue per episode; snooze; persistence).
import { describe, expect, it } from "vitest";
import { Delivery, MemoryStorage, cueKey, cuedByIntent, cuesOf, dueTimeCues, evaluateFocusCues, firingScope, isMember, queryTransitionDelta, whyNow, type Cue, type FiredCue } from "../src/lib/cues.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const SALT = "/attn/intents/2026/10/2026-10-12-calcine-the-salt.md";
const DEW = "/attn/intents/2026/10/2026-10-09-distil-the-dew.md";
const cue = (over: Partial<Cue>): Cue => ({ intent: SALT, id: "c", on: "focus", query: null, at: null, ...over });

describe("shapes", () => {
  const list = [
    { id: "when-opus-focused", on: "focus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n' },
    { id: "review-tomorrow", on: "time", at: "2026-10-15T09:00:00-06:00" },
    { id: "new-parser-issues", on: "query-enter", query: 'from docs\nwhere status == "open"\n' },
    { id: "gone", on: "query-exit", query: "from docs" },
    { on: "focus", query: "no id" },
    { id: "odd", on: "semantic", query: "unknown variant" },
  ];
  it("cuesOf reads the list as a query hit carries it — wrapped once ([[…]]) or flat — and skips entries without an id or with an unknown `on`", () => {
    const expected = [
      { intent: SALT, id: "when-opus-focused", on: "focus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n', at: null },
      { intent: SALT, id: "review-tomorrow", on: "time", query: null, at: "2026-10-15T09:00:00-06:00" },
      { intent: SALT, id: "new-parser-issues", on: "query-enter", query: 'from docs\nwhere status == "open"\n', at: null },
      { intent: SALT, id: "gone", on: "query-exit", query: "from docs", at: null },
    ];
    expect(cuesOf(SALT, [list])).toEqual(expected);
    expect(cuesOf(SALT, list)).toEqual(expected);
    expect(cuesOf(SALT, undefined)).toEqual([]);
    expect(cuesOf(SALT, "cues")).toEqual([]);
    expect(cueKey(expected[0]!)).toBe(`${SALT}#when-opus-focused`);
  });
  it("whyNow names the cue and its kind", () => {
    expect(whyNow(cue({ id: "when-opus-focused" }))).toBe("when-opus-focused — the focused intent matches its query");
    expect(whyNow(cue({ id: "t", on: "time", at: "2026-10-15T09:00:00Z" }))).toBe("t — due 2026-10-15T09:00:00Z");
    expect(whyNow(cue({ id: "n", on: "query-enter" }), "/attn/intents/x.md")).toBe("n — /attn/intents/x.md entered its query");
    expect(whyNow(cue({ id: "g", on: "query-exit" }))).toBe("g — a row left its query");
  });
});

describe("on: focus — membership", () => {
  it("isMember matches the focused intent by the hit's _path, or by its _id when a hit has no path (the 5.0 hit envelope)", () => {
    const focused = { path: SALT, id: "d_salt" };
    expect(isMember([{ _id: "d_x", _path: "/x.md" }, { _id: "d_y", _path: SALT }], focused)).toBe(true);
    expect(isMember([{ _id: "d_salt" }], focused)).toBe(true);
    expect(isMember([{ _id: "d_x", _path: "/x.md" }], focused)).toBe(false);
    expect(isMember([], focused)).toBe(false);
    expect(isMember([{ _id: "d_salt" }], { path: SALT, id: null })).toBe(false);
    // A 4.x hit (`id`/`path`) is not read: the bare names are the user's namespace in 5.0.
    expect(isMember([{ id: "d_salt", path: SALT }], focused)).toBe(false);
  });
  it("one query per focus cue, run AS AUTHORED (every page); matched when the focused intent is among the hits; a query that does not parse is the engine's filter_invalid for that cue alone", async () => {
    const cues = [
      cue({ id: "opus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n' }),
      cue({ id: "rest", intent: DEW, query: 'from docs where "rest" in tags' }),
      cue({ id: "bad", query: "from docs where project == " }),
      cue({ id: "none", query: null }),
      cue({ id: "time", on: "time", at: "2026-10-13T16:00:00Z" }),
      cue({ id: "enter", on: "query-enter", query: "from docs" }),
    ];
    const s = new ScriptedCaller({
      query: (a) => {
        const q = String(a.query);
        if (q.endsWith("== ")) return new OmgError("filter_invalid", "unexpected end of input — expected a value (at offset 27)", { reason: "unexpected end", hint: "OQX" });
        if (q.includes("magnum-opus")) return page([{ _id: "d_salt", _path: SALT }, { _id: "d_dew", _path: DEW }]);
        return page([{ _id: "d_lunch", _path: "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md" }]);
      },
    });
    const r = await evaluateFocusCues(s, cues, { path: SALT, id: "d_salt" }, null);
    expect(r.map((x) => [x.cue.id, x.matched, x.error?.code ?? null])).toEqual([
      ["opus", true, null],
      ["rest", false, null],
      ["bad", false, "filter_invalid"],
      ["none", false, "no_query"],
    ]);
    expect(r[2]!.error).toMatchObject({ hint: "OQX", message: expect.stringContaining("unexpected end") });
    expect(s.names()).toEqual(["query", "query", "query"]);
    expect(s.argsOf("query", 0)).toEqual({ query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n', limit: 500 });
  });
});

describe("on: time", () => {
  it("fires when at ≤ the injected clock; unparsable or future ones do not", () => {
    const cues = [
      cue({ id: "a", on: "time", at: "2026-10-13T16:00:00Z" }),
      cue({ id: "b", on: "time", at: "2026-10-14T09:00:00.000Z" }),
      cue({ id: "d", on: "time", at: "soon" }),
      cue({ id: "e", on: "focus", query: "from docs" }),
    ];
    expect(dueTimeCues(cues, "2026-10-14T08:00:00.000Z").map((c) => c.id)).toEqual(["a"]);
    expect(dueTimeCues(cues, "2026-10-14T09:00:00.000Z").map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("on: query-enter / query-exit", () => {
  const enter = cue({ id: "new", on: "query-enter", query: 'from docs where type == "/terms/types/intent.md"' });
  const exit = cue({ id: "gone", on: "query-exit", query: 'from docs where status == "active"' });
  it("the first run only takes the checkpoint; later runs fire on ids that entered (enter) or left (exit)", async () => {
    let hits = [{ _id: "d_1", _path: "/attn/intents/2026/10/a.md" }, { _id: "d_2", _path: "/attn/intents/2026/10/b.md" }];
    const s = new ScriptedCaller({ query: () => page(hits) });
    const first = await queryTransitionDelta(s, enter, null, null);
    expect(first).toMatchObject({ ids: ["d_1", "d_2"], entered: [], exited: [], fires: [], error: null });
    const same = await queryTransitionDelta(s, enter, first.ids, null);
    expect(same.fires).toEqual([]);
    hits = [{ _id: "d_2", _path: "/attn/intents/2026/10/b.md" }, { _id: "d_3", _path: "/attn/intents/2026/10/c.md" }];
    const next = await queryTransitionDelta(s, enter, first.ids, null);
    expect(next).toMatchObject({ ids: ["d_2", "d_3"], entered: ["d_3"], exited: ["d_1"], fires: [{ id: "d_3", path: "/attn/intents/2026/10/c.md" }] });
    const left = await queryTransitionDelta(s, exit, first.ids, null);
    expect(left.fires).toEqual([{ id: "d_1", path: null }]); // the row that left is no longer a hit, so no path
    expect(s.argsOf("query", 0)).toEqual({ query: enter.query, limit: 500 });
  });
  it("a cue without a query, or a query the engine refuses, reports an error and keeps the checkpoint", async () => {
    const s = new ScriptedCaller({ query: () => new OmgError("filter_invalid", "`nope` is not a target", { hint: "OQX" }) });
    expect(await queryTransitionDelta(s, cue({ on: "query-enter" }), ["d_1"], null)).toMatchObject({ ids: ["d_1"], error: { code: "no_query" } });
    expect(await queryTransitionDelta(s, enter, ["d_1"], null)).toMatchObject({ ids: ["d_1"], fires: [], error: { code: "filter_invalid" } });
  });
});

describe("delivery (app-local)", () => {
  it("a cue fires once per (intent, cue id, episode); a new episode offers it again; the scope per variant", () => {
    const d = new Delivery(new MemoryStorage());
    const c = cue({ id: "opus" });
    const ep1 = `${SALT}@2026-10-13T15:02:00.000Z`;
    const ep2 = `${SALT}@2026-10-13T18:00:00.000Z`;
    expect(firingScope(c, ep1)).toBe(`episode:${ep1}`);
    expect(firingScope(cue({ on: "time", at: "T" }), ep1)).toBe("time:T");
    expect(firingScope(cue({ on: "query-enter" }), ep1, "d_3")).toBe("enter:d_3");
    expect(firingScope(cue({ on: "query-exit" }), ep1, "d_3")).toBe("exit:d_3");
    expect(d.shouldOffer(c, firingScope(c, ep1), ep1)).toBe(true);
    d.markFired(c, firingScope(c, ep1), "now");
    expect(d.shouldOffer(c, firingScope(c, ep1), ep1)).toBe(false);
    expect(d.shouldOffer(cue({ id: "opus", intent: DEW }), firingScope(c, ep1), ep1)).toBe(true); // another intent's cue with the same id is another cue
    expect(d.shouldOffer(c, firingScope(c, ep2), ep2)).toBe(true);
  });
  it("snooze is quiet until the next focus boundary", () => {
    const d = new Delivery(new MemoryStorage());
    const c = cue({ on: "time", at: "T" });
    d.snooze(c, "ep1");
    expect(d.isSnoozed(c, "ep1")).toBe(true);
    expect(d.shouldOffer(c, "time:T", "ep1")).toBe(false);
    expect(d.shouldOffer(c, "time:T", "ep2")).toBe(true);
    expect(d.isSnoozed(c, null)).toBe(false);
  });
  it("checkpoints key on intent path + cue id, persist to the storage and reload; a corrupt value is an empty state", () => {
    const storage = new MemoryStorage();
    const d = new Delivery(storage, "k");
    const c = cue({ id: "new", on: "query-enter" });
    d.setCheckpoint(c, ["d_2", "d_1"]);
    d.markFired(c, "enter:d_1", "now");
    const again = new Delivery(storage, "k");
    expect(again.checkpoint(c)).toEqual(["d_2", "d_1"]);
    expect(again.hasFired(c, "enter:d_1")).toBe(true);
    expect(again.checkpoint(cue({ id: "new", intent: DEW }))).toBeNull();
    expect(JSON.parse(storage.getItem("k")!).checkpoints).toEqual({ [`${SALT}#new`]: ["d_2", "d_1"] });
    storage.setItem("k", "{not json");
    expect(new Delivery(storage, "k").checkpoint(c)).toBeNull();
  });
  it("cuedByIntent lifts each intent once, with every distinct why", () => {
    const fired: FiredCue[] = [
      { cue: cue({ id: "a" }), reason: "a — the focused intent matches its query", scope: "episode:e", firedAt: "t" },
      { cue: cue({ id: "t", on: "time" }), reason: "t — due T", scope: "time:T", firedAt: "t" },
      { cue: cue({ id: "t", on: "time" }), reason: "t — due T", scope: "time:T", firedAt: "t" },
      { cue: cue({ id: "x", intent: DEW }), reason: "x — …", scope: "episode:e", firedAt: "t" },
    ];
    expect([...cuedByIntent(fired)]).toEqual([[SALT, ["a — the focused intent matches its query", "t — due T"]], [DEW, ["x — …"]]]);
  });
});
