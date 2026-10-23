import { describe, expect, it } from "vitest";
import { DEFAULT_LABEL_FIT, ELLIPSIS, LABEL_FIT, LABEL_FITS, cardSize, fixedMeasure, isLabelFit, labelRoom, wrapLabel } from "../src/lib/card-size.ts";
import { CARD, cardFor, cardWidth } from "../src/lib/cards.ts";

// Ten px a character: a 100 px line holds ten characters.
const m = fixedMeasure(10);

describe("wrapLabel — greedy word wrap under a measured width", () => {
  it("keeps a short label on one line, and an empty one as one empty line", () => {
    expect(wrapLabel("Kickoff", 100, m)).toEqual(["Kickoff"]);
    expect(wrapLabel("", 100, m)).toEqual([""]);
    expect(wrapLabel("   ", 100, m)).toEqual([""]);
  });

  it("packs words greedily and never lets a line measure over the width", () => {
    const lines = wrapLabel("the quick brown fox jumps over", 100, m);
    expect(lines).toEqual(["the quick", "brown fox", "jumps over"]);
    for (const l of lines) expect(m(l)).toBeLessThanOrEqual(100);
    // A word that exactly fills the line sits alone on it.
    expect(wrapLabel("abcdefghij klm", 100, m)).toEqual(["abcdefghij", "klm"]);
    // Runs of whitespace (and newlines) count as one space.
    expect(wrapLabel("a   b\n c", 100, m)).toEqual(["a b c"]);
  });

  it("breaks a single over-long word by characters", () => {
    expect(wrapLabel("abcdefghijklmnopqrstuvwxyz", 100, m)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    // The broken word's tail shares its line with the words that follow.
    expect(wrapLabel("abcdefghijklm no", 100, m)).toEqual(["abcdefghij", "klm no"]);
    // A width under one character still advances one character a line (no infinite loop).
    expect(wrapLabel("abc", 5, m, 10)).toEqual(["a", "b", "c"]);
  });

  it("caps the lines and ends the last allowed one in a measured-in ellipsis", () => {
    const text = "one two three four five six seven eight nine ten";
    const lines = wrapLabel(text, 100, m, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("one two");
    expect(lines[1]!.endsWith(ELLIPSIS)).toBe(true);
    // The ellipsis is measured in: the line (ellipsis included) fits the width…
    expect(m(lines[1]!)).toBeLessThanOrEqual(100);
    // …and carries as much of the rest as fits ("three four" is 10 chars; with the ellipsis, 9 of them).
    expect(lines[1]).toBe(`three fou${ELLIPSIS}`);
    // The default cap is LABEL_FIT.maxLines (4).
    expect(wrapLabel(text, 100, m)).toHaveLength(LABEL_FIT.maxLines);
    expect(wrapLabel(text, 100, m)[3]!.endsWith(ELLIPSIS)).toBe(true);
    // Under the cap: no ellipsis anywhere.
    expect(wrapLabel(text, 100, m, 10).join(" ")).toBe(text);
    // A cap below one is one line.
    expect(wrapLabel(text, 100, m, 0)).toEqual([`one two t${ELLIPSIS}`]);
  });
});

describe("cardSize — the three fits", () => {
  const long = "A rather long document title that will not fit on a single card line";
  const card = cardFor({ label: "p", row: { title: long } }, { label: "title", shown: ["title"] });
  const withLines = cardFor({ label: "p", row: { title: long, phase: "plan", owner: "/people/zoe.md" } }, { label: "title", shown: ["title", "phase", "owner"] });

  it("truncate is today's card untouched: one line, the estimated width and height", () => {
    const s = cardSize(card, "truncate", m);
    expect(s).toEqual({ width: card.width, height: card.height, lines: [card.label] });
    expect(card.width).toBe(CARD.maxWidth);
    expect(card.label.endsWith("…")).toBe(true);
    expect(cardSize(withLines, "truncate", m).height).toBe(withLines.height);
  });

  it("wrap keeps the width (capped at CARD.maxWidth) and grows the height by a line per extra label line, up to the cap", () => {
    const s = cardSize(card, "wrap", m);
    expect(s.width).toBe(card.width);
    expect(s.width).toBe(CARD.maxWidth);
    // 260 wide → 242 px of room → 24 chars a line; the 69-char title takes 3 lines.
    expect(labelRoom(card.width)).toBe(card.width - 2 * CARD.padX);
    expect(s.lines).toEqual(wrapLabel(long, labelRoom(card.width), m));
    expect(s.lines.length).toBe(3);
    expect(s.height).toBe(card.height + 2 * LABEL_FIT.lineHeight);
    for (const l of s.lines) expect(m(l)).toBeLessThanOrEqual(labelRoom(card.width));
    // The field lines still count: the height is the wrapped label plus the lines as before.
    const w = cardSize(withLines, "wrap", m);
    expect(w.height).toBe(withLines.height + (w.lines.length - 1) * LABEL_FIT.lineHeight);
    expect(withLines.height).toBe(CARD.baseHeight + 2 * CARD.lineHeight);
    // Past the cap the last line ends in an ellipsis and the height stops growing.
    const huge = cardFor({ label: "p", row: { title: "word ".repeat(80).trim() } }, { label: "title", shown: ["title"] });
    const h = cardSize(huge, "wrap", m);
    expect(h.lines).toHaveLength(LABEL_FIT.maxLines);
    expect(h.lines[LABEL_FIT.maxLines - 1]!.endsWith(ELLIPSIS)).toBe(true);
    expect(h.height).toBe(huge.height + (LABEL_FIT.maxLines - 1) * LABEL_FIT.lineHeight);
  });

  it("a short label stays one line under wrap and expand, the width measured (not estimated) and never below the estimate", () => {
    const short = cardFor({ label: "p", row: { title: "Kickoff" } }, { label: "title", shown: ["title"] });
    // The estimate is 7 px a character (67 wide); the test measure is 10, so the card is 70 + padding.
    expect(short.width).toBe(7 * CARD.labelCharWidth + 2 * CARD.padX);
    expect(cardSize(short, "wrap", m)).toEqual({ width: 70 + 2 * CARD.padX, height: short.height, lines: ["Kickoff"] });
    expect(cardSize(short, "expand", m)).toEqual({ width: 70 + 2 * CARD.padX, height: short.height, lines: ["Kickoff"] });
    // A measure that agrees with the estimate leaves the card exactly as truncate draws it.
    const same = fixedMeasure(CARD.labelCharWidth);
    expect(cardSize(short, "wrap", same)).toEqual({ width: short.width, height: short.height, lines: ["Kickoff"] });
    expect(cardSize(short, "expand", same)).toEqual({ width: short.width, height: short.height, lines: ["Kickoff"] });
  });

  it("expand widens the card to the measured label, then wraps at the maximum width", () => {
    // 36 chars × 10 px + padding = 378 < 480: one line, the card widened past CARD.maxWidth.
    const mid = cardFor({ label: "p", row: { title: "x".repeat(36) } }, { label: "title", shown: ["title"] });
    const s = cardSize(mid, "expand", m);
    expect(mid.width).toBe(CARD.maxWidth);
    expect(s.width).toBe(360 + 2 * CARD.padX);
    expect(s.lines).toEqual(["x".repeat(36)]);
    expect(s.height).toBe(mid.height);
    // 69 chars × 10 px = 690 > 480: the width caps and the label wraps inside it.
    const e = cardSize(card, "expand", m);
    expect(e.width).toBe(LABEL_FIT.expandMaxWidth);
    expect(e.lines).toEqual(wrapLabel(long, labelRoom(LABEL_FIT.expandMaxWidth), m));
    expect(e.lines.length).toBe(2);
    expect(e.height).toBe(card.height + LABEL_FIT.lineHeight);
    // The card never shrinks below what the field lines need.
    const wide = cardFor({ label: "p", row: { title: "T", note: "n".repeat(60) } }, { label: "title", shown: ["title", "note"] });
    expect(cardSize(wide, "expand", m).width).toBe(wide.width);
    expect(wide.width).toBe(cardWidth(1, "note: ".length + 60));
  });

  it("the modes are the three names, truncate the default", () => {
    expect(LABEL_FITS).toEqual(["truncate", "wrap", "expand"]);
    expect(DEFAULT_LABEL_FIT).toBe("truncate");
    expect(isLabelFit("wrap")).toBe(true);
    expect(isLabelFit("stretch")).toBe(false);
    expect(isLabelFit(null)).toBe(false);
  });
});
