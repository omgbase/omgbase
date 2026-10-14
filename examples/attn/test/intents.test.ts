import { describe, expect, it } from "vitest";
import { INTENTS_QUERY, VIRTUAL_FOCUS_QUERY, fetchIntents, findByTitle, fuzzyScore, intentOf, rankIntents, setStatusEffect, sortIntents, type Intent } from "../src/lib/intents.ts";
import { episodeKey, fetchPointer, pointerOf, returnTarget } from "../src/lib/pointer.ts";
import { OmgError } from "../src/lib/mcp-client.ts";
import { ScriptedCaller, page } from "./scripted.ts";

const HITS = [
  { id: "d_2qgjkps", path: "/attn/intents/calcine-the-salt.md", title: "Calcine the salt", status: "active", tags: ["fire", "laboratory"], project: "magnum-opus", updated_at: "2026-10-14T08:17:55.962Z", focus: { since: "2026-10-13T15:02:00.000Z" } },
  { id: "d_n8gzkm4", path: "/attn/intents/distil-the-dew.md", title: "Distil the May dew", status: "active", tags: ["aqua", "laboratory"], project: "magnum-opus", updated_at: "2026-10-14T08:17:55.962Z", focus: null },
  { id: "d_n06c3kt", path: "/attn/intents/enjoy-lunch.md", title: "Enjoy lunch", status: "active", tags: ["rest"], updated_at: "2026-10-14T08:17:55.962Z", focus: null },
  { id: "d_x", path: "/attn/intents/grind-the-cinnabar.md", title: "Grind the cinnabar", status: "released", tags: ["laboratory", "fire"], project: "magnum-opus", focus: null },
];

describe("the virtual #focus", () => {
  it("is a correlated join against the pointer, not a tag — pinned text", () => {
    expect(INTENTS_QUERY).toBe('select path, title, status, tags, project, updated_at, focus: ^docs first { select since where path == "/attn/current.md" and focused == ^path } from docs where type == "intent" and path.startsWith("/attn/intents/")');
    expect(VIRTUAL_FOCUS_QUERY).toBe('select path, title, status, tags from docs where type == "intent" and status == "active" and ^docs exists { where path == "/attn/current.md" and focused == ^path }');
  });
  it("intentOf reads the focus column; sortIntents puts the focused first, then active, then by title", async () => {
    const s = new ScriptedCaller({ query: () => page(HITS) });
    const is = await fetchIntents(s, null);
    expect(s.argsOf("query")).toEqual({ query: INTENTS_QUERY, limit: 500 });
    expect(is.map((i) => [i.title, i.status, i.focusSince])).toEqual([
      ["Calcine the salt", "active", "2026-10-13T15:02:00.000Z"],
      ["Distil the May dew", "active", null],
      ["Enjoy lunch", "active", null],
      ["Grind the cinnabar", "released", null],
    ]);
    expect(intentOf({ id: "d", path: "/attn/intents/no-title.md" })).toMatchObject({ title: "no-title", tags: [], project: null, focusSince: null });
    expect(sortIntents([]).length).toBe(0);
  });
  it("setStatusEffect releases and reactivates by one frontmatter set", () => {
    expect(setStatusEffect("/attn/intents/enjoy-lunch.md", "released")).toEqual({ op: "set", target: "/attn/intents/enjoy-lunch.md", field: "frontmatter.status", value: "released" });
  });
});

describe("the pointer", () => {
  it("pointerOf reads docs_read; a missing document is never-focused; episodeKey and returnTarget", async () => {
    const wire = { id: "d_avkm6zx", path: "/attn/current.md", rev: "r_35bctb5", properties: { frontmatter: { type: "attn-state", focused: "/attn/intents/calcine-the-salt.md", since: "2026-10-13T15:02:00.000Z", return_stack: ["/attn/intents/distil-the-dew.md"] }, inline: {}, computed: {} }, raw: "" };
    const p = pointerOf(wire);
    expect(p).toEqual({ exists: true, docId: "d_avkm6zx", rev: "r_35bctb5", focused: "/attn/intents/calcine-the-salt.md", since: "2026-10-13T15:02:00.000Z", returnStack: ["/attn/intents/distil-the-dew.md"] });
    expect(episodeKey(p)).toBe("/attn/intents/calcine-the-salt.md@2026-10-13T15:02:00.000Z");
    expect(returnTarget(p)).toBe("/attn/intents/distil-the-dew.md");
    const s = new ScriptedCaller({ docs_read: (a) => (a.path === "/attn/current.md" ? new OmgError("doc_missing", "no document", {}) : wire) });
    expect(await fetchPointer(s, "attn")).toMatchObject({ exists: false, focused: null, returnStack: [] });
    expect(s.argsOf("docs_read")).toEqual({ path: "/attn/current.md", repo: "attn" });
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
    const recent = new Map([["/attn/intents/enjoy-lunch.md", "2026-10-13T12:00:00.000Z"], ["/attn/intents/distil-the-dew.md", "2026-10-13T12:40:00.000Z"]]);
    expect(rankIntents(intents, recent, "").map((r) => r.intent.title)).toEqual(["Distil the May dew", "Enjoy lunch", "Calcine the salt"]);
    expect(rankIntents(intents, recent, "lunch").map((r) => r.intent.title)).toEqual(["Enjoy lunch"]);
    expect(rankIntents(intents, recent, "#fire").map((r) => r.intent.title)).toEqual(["Calcine the salt"]);
    expect(rankIntents(intents, recent, "cinnabar")).toEqual([]);
  });
  it("findByTitle resumes a twin instead of declaring it", () => {
    expect(findByTitle(intents, "enjoy LUNCH ")?.path).toBe("/attn/intents/enjoy-lunch.md");
    expect(findByTitle(intents, "Enjoy brunch")).toBeNull();
  });
});
