import { describe, expect, it } from "vitest";
import { bodyOf, clockOf, cuePath, dayEnd, dayOf, formatDuration, intentPath, isoOf, parseDeclaration, proseOf, secondsBetween, slugify, streamDay, streamPath } from "../src/lib/model.ts";

describe("the declaration line", () => {
  it("#tags become tags (lower-cased, deduped, in order) and leave the title", () => {
    expect(parseDeclaration("Talk with Natalie #people #Garden #people")).toEqual({ title: "Talk with Natalie", tags: ["people", "garden"] });
    expect(parseDeclaration("#oqx Work on OQX indexing")).toEqual({ title: "Work on OQX indexing", tags: ["oqx"] });
    expect(parseDeclaration("Enjoy lunch")).toEqual({ title: "Enjoy lunch", tags: [] });
    expect(parseDeclaration("  spaced   out  #a ")).toEqual({ title: "spaced out", tags: ["a"] });
    // a # inside a word is not a tag; a bare # is not a tag
    expect(parseDeclaration("issue#12 and # alone")).toEqual({ title: "issue#12 and # alone", tags: [] });
  });
  it("slugs are kebab-case ASCII; intent and cue paths avoid taken names", () => {
    expect(slugify("Read the Mutus Liber, plate IV")).toBe("read-the-mutus-liber-plate-iv");
    expect(slugify("Écrire à Nicolas — vite!")).toBe("ecrire-a-nicolas-vite");
    expect(slugify("###")).toBe("intent");
    expect(intentPath("Enjoy lunch")).toBe("/attn/intents/enjoy-lunch.md");
    expect(intentPath("Enjoy lunch", ["/attn/intents/enjoy-lunch.md"])).toBe("/attn/intents/enjoy-lunch-2.md");
    expect(intentPath("Enjoy lunch", new Set(["/attn/intents/enjoy-lunch.md", "/attn/intents/enjoy-lunch-2.md"]))).toBe("/attn/intents/enjoy-lunch-3.md");
    expect(cuePath("Take the salt off", [])).toBe("/attn/cues/take-the-salt-off.md");
  });
});

describe("the clock", () => {
  it("days, stream paths and line clocks are UTC", () => {
    const iso = "2026-10-13T15:02:00.000Z";
    expect(dayOf(iso)).toBe("2026-10-13");
    expect(streamPath(iso)).toBe("/attn/stream/2026-10-13.md");
    expect(streamDay("/attn/stream/2026-10-13.md")).toBe("2026-10-13");
    expect(streamDay("/attn/stream/notes.md")).toBeNull();
    expect(clockOf(iso)).toBe("15:02:00Z");
    expect(isoOf("2026-10-13", "15:02:00Z")).toBe(iso);
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
  it("bodyOf drops the frontmatter; proseOf drops the title and fences too", () => {
    const raw = "---\ntype: cue\n---\n\n# Title\n\nText here.\n\n```oqx\nfrom docs\n```\n\nMore.\n";
    expect(bodyOf(raw)).toBe("\n# Title\n\nText here.\n\n```oqx\nfrom docs\n```\n\nMore.\n");
    expect(proseOf(raw)).toBe("Text here.\n\n\nMore.");
    expect(bodyOf("# No frontmatter\n")).toBe("# No frontmatter\n");
  });
});
