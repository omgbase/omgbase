import { describe, expect, it } from "vitest";
import { CARD, cardFor, cardHeight, cardRadius, cardTooltip, cardWidth, fitChars, formatFull, formatValue, truncate } from "../src/lib/cards.ts";

describe("cardRadius", () => {
  it("covers the card's diagonal plus a margin", () => {
    expect(cardRadius(60, 80)).toBe(50 + 12);
    expect(cardRadius(60, 80, 0)).toBe(50);
    expect(cardRadius(120, 30)).toBeGreaterThan(60);
  });
});

describe("formatValue", () => {
  it("renders scalars as text, absent as a dash", () => {
    expect(formatValue("Kickoff")).toBe("Kickoff");
    expect(formatValue("a\n  b")).toBe("a ⏎ b");
    expect(formatValue(3)).toBe("3");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
  });

  it("renders arrays as a, b, c and structures compactly — never a JSON wall", () => {
    expect(formatValue(["/a.md", "/b.md"])).toBe("/a.md, /b.md");
    expect(formatValue([1, "x", false])).toBe("1, x, false");
    expect(formatValue([])).toBe("[]");
    expect(formatValue([{ employer: "A" }, { employer: "B" }])).toBe("2 items");
    expect(formatValue([{ employer: "A" }])).toBe("1 item");
    expect(formatValue([{ a: 1 }, "x", [1]])).toBe("{…}, x, […]");
    expect(formatValue({ k: 1 })).toBe("{…}");
  });

  it("formatFull keeps flat values as drawn and structures as one-line JSON, capped", () => {
    expect(formatFull("Kickoff")).toBe("Kickoff");
    expect(formatFull(["/a.md", "/b.md"])).toBe("/a.md, /b.md");
    expect(formatFull({ k: 1 })).toBe('{"k":1}');
    expect(formatFull([{ a: 1 }])).toBe('[{"a":1}]');
    expect(formatFull("x".repeat(500)).length).toBe(CARD.tooltipChars);
    expect(formatFull("x".repeat(500)).endsWith("…")).toBe(true);
  });

  it("truncate keeps max chars including the ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcd", 4)).toBe("abcd");
  });
});

describe("card sizing", () => {
  const node = { label: "timeline/kickoff", row: { $path: "/timeline/kickoff.md", title: "Kickoff", phase: "plan", before: [], after: ["/timeline/alpha.md"], n: 3 } };

  it("a label-only card is the original node size (30 high); the label is the chosen field's value", () => {
    const c = cardFor(node, { label: "title", shown: ["title"] });
    expect(c.label).toBe("Kickoff");
    expect(c.lines).toEqual([]);
    expect(c.height).toBe(30);
    expect(c.width).toBe(cardWidth("Kickoff".length, 0));
    expect(c.width).toBeGreaterThanOrEqual(CARD.minWidth);
  });

  it("falls back to the node label when no label field is chosen or the row lacks it", () => {
    expect(cardFor(node, { label: null, shown: [] }).label).toBe("timeline/kickoff");
    expect(cardFor(node, { label: "missing", shown: ["missing"] }).label).toBe("timeline/kickoff");
    expect(cardFor(node, { label: "$path", shown: ["$path"] }).label).toBe("/timeline/kickoff.md");
  });

  it("adds one key: value line per shown field other than the label and grows the card by a line each", () => {
    const c = cardFor(node, { label: "title", shown: ["title", "phase", "after"] });
    expect(c.lines.map((l) => [l.key, l.text, l.full])).toEqual([["phase", "plan", "plan"], ["after", "/timeline/alpha.md", "/timeline/alpha.md"]]);
    expect(c.height).toBe(cardHeight(2));
    expect(c.height).toBe(30 + 2 * CARD.lineHeight);
    // The widest line sets the width, bounded.
    expect(c.width).toBe(cardWidth("Kickoff".length, "after: /timeline/alpha.md".length));
    expect(c.width).toBeLessThanOrEqual(CARD.maxWidth);
    // An absent field is still a line (so the user sees the key is projected but empty here).
    expect(cardFor(node, { label: "title", shown: ["title", "owner"] }).lines).toEqual([{ key: "owner", text: "—", full: "—" }]);
  });

  it("truncates long values to the card width (keeping the key whole) and keeps the full value for the tooltip", () => {
    const long = "x".repeat(200);
    const c = cardFor({ label: "p", row: { title: "T", note: long } }, { label: "title", shown: ["title", "note"] });
    expect(c.width).toBe(CARD.maxWidth);
    const line = c.lines[0]!;
    expect(line.key).toBe("note");
    expect(line.text.endsWith("…")).toBe(true);
    expect(line.key.length + 2 + line.text.length).toBeLessThanOrEqual(fitChars(CARD.maxWidth, CARD.lineCharWidth));
    expect(line.full).toBe(long);
    const lbl = cardFor({ label: "p", row: { title: long } }, { label: "title", shown: ["title"] });
    expect(lbl.label.endsWith("…")).toBe(true);
    expect(lbl.labelFull).toBe(long);
  });

  it("cardTooltip lists the path, the label field and every line in full", () => {
    const c = cardFor(node, { label: "title", shown: ["title", "phase"] });
    expect(cardTooltip("/timeline/kickoff.md", c, { label: "title", shown: ["title", "phase"] })).toBe("/timeline/kickoff.md\ntitle: Kickoff\nphase: plan");
    const p = cardFor(node, { label: null, shown: [] });
    expect(cardTooltip("/timeline/kickoff.md", p, { label: null, shown: [] })).toBe("/timeline/kickoff.md");
  });
});
