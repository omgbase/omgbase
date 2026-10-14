// The feed: one query (pinned) with the virtual #focus and each intent's cues;
// active intents most recently edited first; the Cued lift; the focused intent
// never sorted in; released behind the toggle. And the design note's rule as a
// test: focusing an intent does not change its updated_at.
import { describe, expect, it } from "vitest";
import { INTENTS_QUERY, VIRTUAL_FOCUS_QUERY, activeCues, feedOf, fetchIntents, findByTitle, fuzzyScore, intentOf, rankIntents, setContentEffect, sortByEdited, type Intent } from "../src/lib/intents.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import { episodeKey, fetchPointer, pointerOf, returnTarget } from "../src/lib/pointer.ts";
import { applyEffects, switchEffects } from "../src/lib/writes.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const SALT = "/attn/intents/2026/10/2026-10-12-calcine-the-salt.md";
const DEW = "/attn/intents/2026/10/2026-10-09-distil-the-dew.md";
const LUNCH = "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md";
const CINNABAR = "/attn/intents/2026/10/2026-10-03-grind-the-cinnabar.md";

const HITS = [
  { id: "d_2qgjkps", path: SALT, title: "Calcine the salt", status: "active", tags: ["fire", "laboratory"], project: "/projects/magnum-opus.md", updated_at: "2026-10-13T08:17:55.962Z", cues: [[{ id: "when-opus-focused", on: "focus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n' }, { id: "off-the-fire", on: "time", at: "2026-10-13T16:00:00Z" }]], focus: { since: "2026-10-13T15:02:00.000Z" } },
  { id: "d_n8gzkm4", path: DEW, title: "Distil the May dew", status: "active", tags: ["aqua", "laboratory"], project: "/projects/magnum-opus.md", updated_at: "2026-10-14T08:17:55.962Z", focus: null },
  { id: "d_n06c3kt", path: LUNCH, title: "Enjoy lunch", status: "active", tags: ["rest"], updated_at: "2026-10-12T08:17:55.962Z", focus: null },
  { id: "d_x", path: CINNABAR, title: "Grind the cinnabar", status: "released", tags: ["laboratory", "fire"], project: "/projects/magnum-opus.md", updated_at: "2026-10-14T09:00:00.000Z", cues: [[{ id: "released-cue", on: "time", at: "2026-10-01T00:00:00Z" }]], focus: null },
];

describe("the query", () => {
  it("is pinned: cues and updated_at projected, the virtual #focus a correlated join against the pointer, most recently edited first", () => {
    expect(INTENTS_QUERY).toBe('select path, title, status, tags, project, updated_at, cues, focus: ^docs first { select since where path == "/attn/focus.md" and focused_intent == ^path } from docs where type == "/terms/types/intent.md" and path.startsWith("/attn/intents/") order by updated_at desc');
    expect(VIRTUAL_FOCUS_QUERY).toBe('select path, title, status, tags from docs where type == "/terms/types/intent.md" and status == "active" and ^docs exists { where path == "/attn/focus.md" and focused_intent == ^path }');
  });
  it("intentOf reads the focus column and the cues; fetchIntents orders by updated_at desc", async () => {
    const s = new ScriptedCaller({ query: () => page([...HITS].reverse()) });
    const is = await fetchIntents(s, null);
    expect(s.argsOf("query")).toEqual({ query: INTENTS_QUERY, limit: 500 });
    expect(is.map((i) => [i.title, i.status, i.focusSince, i.cues.length])).toEqual([
      ["Grind the cinnabar", "released", null, 1],
      ["Distil the May dew", "active", null, 0],
      ["Calcine the salt", "active", "2026-10-13T15:02:00.000Z", 2],
      ["Enjoy lunch", "active", null, 0],
    ]);
    expect(is[2]!.cues[0]).toEqual({ intent: SALT, id: "when-opus-focused", on: "focus", query: 'from docs\nwhere project == "/projects/magnum-opus.md"\n', at: null });
    expect(intentOf({ id: "d", path: "/attn/intents/2026/10/2026-10-14-no-title.md" })).toMatchObject({ title: "2026-10-14-no-title", tags: [], project: null, focusSince: null, cues: [] });
    expect(sortByEdited([]).length).toBe(0);
  });
  it("activeCues is every cue of the active intents — a released intent's cues do not fire", () => {
    expect(activeCues(HITS.map(intentOf)).map((c) => c.id)).toEqual(["when-opus-focused", "off-the-fire"]);
  });
});

describe("the feed", () => {
  const intents: Intent[] = HITS.map(intentOf);
  it("recent = active intents most recently edited first, without the focused one; released apart", () => {
    const f = feedOf(intents, SALT, new Map());
    expect(f.cued).toEqual([]);
    expect(f.recent.map((i) => i.title)).toEqual(["Distil the May dew", "Enjoy lunch"]);
    expect(f.released.map((i) => i.title)).toEqual(["Grind the cinnabar"]);
  });
  it("cued intents are lifted out of recent (never duplicated), with their why; the focused and released ones are never lifted", () => {
    const cued = new Map([[LUNCH, ["rest-cue — due 2026-10-13T12:00:00Z"]], [SALT, ["x"]], [CINNABAR, ["y"]]]);
    const f = feedOf(intents, SALT, cued);
    expect(f.cued.map((c) => [c.intent.title, c.why])).toEqual([["Enjoy lunch", ["rest-cue — due 2026-10-13T12:00:00Z"]]]);
    expect(f.recent.map((i) => i.title)).toEqual(["Distil the May dew"]);
    expect(f.released.map((i) => i.title)).toEqual(["Grind the cinnabar"]);
  });
  it("with nothing in focus every active intent is in the feed", () => {
    expect(feedOf(intents, null, new Map()).recent.map((i) => i.title)).toEqual(["Distil the May dew", "Calcine the salt", "Enjoy lunch"]);
  });
});

describe("focusing does not edit the intent", () => {
  /** A tiny stateful server: documents with updated_at; `apply` bumps the updated_at of every document an effect addresses. */
  function repo() {
    const docs = new Map<string, { updated_at: string; rev: string }>([[SALT, { updated_at: "2026-10-13T08:17:55.962Z", rev: "r_s" }], [LUNCH, { updated_at: "2026-10-12T08:17:55.962Z", rev: "r_l" }], ["/attn/focus.md", { updated_at: "2026-10-13T15:02:00.000Z", rev: "r_35bctb5" }]]);
    let n = 0;
    const s = new ScriptedCaller({
      query: () => page(HITS.filter((h) => docs.has(h.path)).map((h) => ({ ...h, updated_at: docs.get(h.path)!.updated_at }))),
      docs_read: (a) => ({ id: "d_f", path: a.path, rev: docs.get(String(a.path))!.rev, properties: { frontmatter: { focused_intent: SALT, since: "2026-10-13T15:02:00.000Z", return_stack: [] } }, raw: "" }),
      apply: (a) => {
        for (const e of a.effects as Record<string, unknown>[]) {
          const path = String(e.target ?? e.path);
          docs.set(path, { updated_at: `2026-10-14T10:00:0${++n}.000Z`, rev: `r_${n}` });
        }
        return { plan_id: "p", commit: `c_${n}`, revisions: [], new_ids: {}, committed: true, summary: [] };
      },
    });
    return { s, docs };
  }
  it("a switch writes the pointer only: every intent's updated_at is what it was; an edit (set content) legitimately moves it", async () => {
    const { s, docs } = repo();
    const before = (await fetchIntents(s, null)).map((i) => [i.path, i.updatedAt]);
    const pointer = await fetchPointer(s, null);
    await applyEffects(s, switchEffects({ pointer, now: "2026-10-14T10:00:00.000Z" }, LUNCH), null, "attn switch");
    const after = (await fetchIntents(s, null)).map((i) => [i.path, i.updatedAt]);
    expect(after).toEqual(before);
    expect(docs.get("/attn/focus.md")!.updated_at).not.toBe("2026-10-13T15:02:00.000Z");
    await applyEffects(s, [setContentEffect(LUNCH, "---\n---\n# Enjoy lunch\n")], null, "attn edit intent");
    const edited = (await fetchIntents(s, null)).find((i) => i.path === LUNCH)!;
    expect(edited.updatedAt).not.toBe(before.find(([p]) => p === LUNCH)![1]);
  });
});

describe("the pointer", () => {
  it("pointerOf reads docs_read (focused_intent); a missing document is never-focused; episodeKey and returnTarget", async () => {
    const wire = { id: "d_avkm6zx", path: "/attn/focus.md", rev: "r_35bctb5", properties: { frontmatter: { type: "/terms/types/attn-state.md", layer: "draft", focused_intent: SALT, since: "2026-10-13T15:02:00.000Z", return_stack: [DEW] }, inline: {}, computed: {} }, raw: "" };
    const p = pointerOf(wire);
    expect(p).toEqual({ exists: true, docId: "d_avkm6zx", rev: "r_35bctb5", focused: SALT, since: "2026-10-13T15:02:00.000Z", returnStack: [DEW] });
    expect(episodeKey(p)).toBe(`${SALT}@2026-10-13T15:02:00.000Z`);
    expect(returnTarget(p)).toBe(DEW);
    const s = new ScriptedCaller({ docs_read: (a) => (a.path === "/attn/focus.md" ? new OmgError("doc_missing", "no document", {}) : wire) });
    expect(await fetchPointer(s, "attn")).toMatchObject({ exists: false, focused: null, returnStack: [] });
    expect(s.argsOf("docs_read")).toEqual({ path: "/attn/focus.md", repo: "attn" });
    expect(episodeKey({ focused: null, since: null })).toBeNull();
  });
});

describe("the chooser", () => {
  const intents: Intent[] = HITS.map(intentOf);
  it("fuzzyScore: subsequence match, word starts and runs score higher, no match is 0", () => {
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("dew", "Distil the May dew")).toBeGreaterThan(0);
    expect(fuzzyScore("zzz", "Distil the May dew")).toBe(0);
    expect(fuzzyScore("calc", "Calcine the salt")).toBeGreaterThan(fuzzyScore("cals", "Calcine the salt"));
  });
  it("rankIntents: active only, most recently focused first without a query, by score with one", () => {
    const recent = new Map([[LUNCH, "2026-10-13T12:00:00.000Z"], [DEW, "2026-10-13T12:40:00.000Z"]]);
    expect(rankIntents(intents, recent, "").map((r) => r.intent.title)).toEqual(["Distil the May dew", "Enjoy lunch", "Calcine the salt"]);
    expect(rankIntents(intents, recent, "lunch").map((r) => r.intent.title)).toEqual(["Enjoy lunch"]);
    expect(rankIntents(intents, recent, "#fire").map((r) => r.intent.title)).toEqual(["Calcine the salt"]);
    expect(rankIntents(intents, recent, "cinnabar")).toEqual([]);
  });
  it("findByTitle resumes a twin instead of declaring it", () => {
    expect(findByTitle(intents, "enjoy LUNCH ")?.path).toBe(LUNCH);
    expect(findByTitle(intents, "Enjoy brunch")).toBeNull();
  });
});
