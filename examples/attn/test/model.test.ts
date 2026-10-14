import { describe, expect, it } from "vitest";
import { bodyOf, cueId, dayEnd, dayOf, formatDuration, frontmatterOf, intentPath, parseDeclaration, proseOf, secondsBetween, slugify, yamlScalar } from "../src/lib/model.ts";

describe("the declaration line", () => {
  it("#tags become tags (lower-cased, deduped, in order) and leave the title", () => {
    expect(parseDeclaration("Talk with Natalie #people #Garden #people")).toEqual({ title: "Talk with Natalie", tags: ["people", "garden"] });
    expect(parseDeclaration("#oqx Work on OQX indexing")).toEqual({ title: "Work on OQX indexing", tags: ["oqx"] });
    expect(parseDeclaration("Enjoy lunch")).toEqual({ title: "Enjoy lunch", tags: [] });
    expect(parseDeclaration("  spaced   out  #a ")).toEqual({ title: "spaced out", tags: ["a"] });
    // a # inside a word is not a tag; a bare # is not a tag
    expect(parseDeclaration("issue#12 and # alone")).toEqual({ title: "issue#12 and # alone", tags: [] });
  });
  it("slugs are kebab-case ASCII; intent paths are dated for the declaration day (UTC) and avoid taken names; cue ids likewise", () => {
    expect(slugify("Read the Mutus Liber, plate IV")).toBe("read-the-mutus-liber-plate-iv");
    expect(slugify("Écrire à Nicolas — vite!")).toBe("ecrire-a-nicolas-vite");
    expect(slugify("###")).toBe("intent");
    const now = "2026-10-14T23:30:00.000Z";
    expect(intentPath("Enjoy lunch", now)).toBe("/attn/intents/2026/10/2026-10-14-enjoy-lunch.md");
    expect(intentPath("Enjoy lunch", now, ["/attn/intents/2026/10/2026-10-14-enjoy-lunch.md"])).toBe("/attn/intents/2026/10/2026-10-14-enjoy-lunch-2.md");
    expect(intentPath("Enjoy lunch", now, new Set(["/attn/intents/2026/10/2026-10-14-enjoy-lunch.md", "/attn/intents/2026/10/2026-10-14-enjoy-lunch-2.md"]))).toBe("/attn/intents/2026/10/2026-10-14-enjoy-lunch-3.md");
    expect(intentPath("Enjoy lunch", "2026-11-01T00:00:00.000Z")).toBe("/attn/intents/2026/11/2026-11-01-enjoy-lunch.md");
    expect(cueId("When OQX is focused")).toBe("when-oqx-is-focused");
    expect(cueId("When OQX is focused", ["when-oqx-is-focused"])).toBe("when-oqx-is-focused-2");
    expect(cueId("")).toBe("cue");
  });
});

describe("the clock", () => {
  it("days are UTC", () => {
    const iso = "2026-10-13T15:02:00.000Z";
    expect(dayOf(iso)).toBe("2026-10-13");
    expect(dayEnd("2026-10-31")).toBe("2026-11-01T00:00:00.000Z");
    expect(secondsBetween(iso, "2026-10-13T16:10:00.000Z")).toBe(4080);
    expect(secondsBetween(iso, "2026-10-13T15:00:00.000Z")).toBe(0);
  });
  it("durations read as hours and minutes", () => {
    expect(formatDuration(4080)).toBe("1h 08m");
    expect(formatDuration(720)).toBe("12m");
    expect(formatDuration(40)).toBe("40s");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("bodies", () => {
  it("bodyOf drops the frontmatter; proseOf drops the title too", () => {
    const raw = "---\ntype: x\n---\n\n# Title\n\nText here.\n\nMore.\n";
    expect(bodyOf(raw)).toBe("\n# Title\n\nText here.\n\nMore.\n");
    expect(proseOf(raw)).toBe("Text here.\n\nMore.");
    expect(bodyOf("# No frontmatter\n")).toBe("# No frontmatter\n");
  });
});

describe("the pointer's frontmatter from raw bytes (docs_read { at } has no properties)", () => {
  it("reads scalars, quoted strings, null, flow and block lists — as authored and as the engine re-composes them", () => {
    expect(yamlScalar('"2026-10-13T15:02:00.000Z"')).toBe("2026-10-13T15:02:00.000Z");
    expect(yamlScalar("'it''s'")).toBe("it's");
    expect(yamlScalar("null")).toBeNull();
    expect(yamlScalar("~")).toBeNull();
    expect(yamlScalar("true")).toBe(true);
    expect(yamlScalar("42")).toBe(42);
    expect(yamlScalar("/attn/intents/2026/10/2026-10-12-calcine-the-salt.md")).toBe("/attn/intents/2026/10/2026-10-12-calcine-the-salt.md");
    const authored = '---\ntype: /terms/types/attn-state.md\nlayer: draft\nfocused_intent: /attn/intents/2026/10/2026-10-12-calcine-the-salt.md\nsince: "2026-10-13T15:02:00.000Z"\nreturn_stack: []\n---\n\n# Current focus\n\nBody.\n';
    expect(frontmatterOf(authored)).toEqual({ type: "/terms/types/attn-state.md", layer: "draft", focused_intent: "/attn/intents/2026/10/2026-10-12-calcine-the-salt.md", since: "2026-10-13T15:02:00.000Z", return_stack: [] });
    const recomposed = "---\ntype: /terms/types/attn-state.md\nlayer: draft\nfocused_intent: null\nsince: 2026-10-14T10:00:00.000Z\nreturn_stack:\n  - /attn/intents/2026/10/2026-10-12-calcine-the-salt.md\n  - /attn/intents/2026/10/2026-10-09-distil-the-dew.md\n---\n\n# Current focus\n";
    expect(frontmatterOf(recomposed)).toEqual({ type: "/terms/types/attn-state.md", layer: "draft", focused_intent: null, since: "2026-10-14T10:00:00.000Z", return_stack: ["/attn/intents/2026/10/2026-10-12-calcine-the-salt.md", "/attn/intents/2026/10/2026-10-09-distil-the-dew.md"] });
    expect(frontmatterOf("---\ntags: [a, b]\nnested:\n  key: v\n---\n")).toEqual({ tags: ["a", "b"], nested: [] });
    expect(frontmatterOf("# no frontmatter\n")).toEqual({});
  });
});
