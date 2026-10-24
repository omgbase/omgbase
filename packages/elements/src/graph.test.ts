import { describe, expect, it } from "vitest";
import {
  CARD, DEFAULT_CARD, DEFAULT_LABEL_FIT, EASE_MAX_DT, EASE_SNAP, EASE_TAU, EDGE_PALETTE, ELLIPSIS, EdgeEaser, LABEL_FIT, LABEL_FITS, PARALLEL_GAP, ROUTE_MARGIN, ZOOM_MAX, ZOOM_MIN,
  arrowEnd, arrowheadPath, cardContent, cardFields, cardRadius, cardWidth, connectorDrop, connectorLine, curveHitsRect, dragMode, easeToward, edgeKindColor, edgePath, fitTransform, fixedMeasure, forceConfig, formatValue,
  graphDescription, hitTest, initialView, isLabelFit, isSeparator, isTemplateResult, keySide, lineText, nodeSize, labelRoom, nearestInDirection, panBy, parallelOffsets, pathFromOffset, polylineMidpoint, polylineRoute, readField, renderCard, routeMinLength, routeViolations, segmentHitsRect, sizeCard, tidySeparators, toGraph,
  truncateLine, wheelZoomFactor, wrapLabel, zoomAbout, type GraphViewEdge, type GraphViewNode, type Placed,
} from "./graph.js";

const W = 150, H = 34;
const card = (id: string, x: number, y: number, w = W, h = H): Placed => ({ id, x, y, w, h });

describe("card templates", () => {
  it("DEFAULT_CARD is the title alone (no display-property concept in the element); the fallback stands in when it is absent", () => {
    expect(DEFAULT_CARD).toBe("{_title}");
    expect(renderCard(DEFAULT_CARD, { _title: "Title", card: "Ignored here" }, "fb")).toEqual({ label: "Title", lines: [], full: ["Title"] });
    expect(renderCard(DEFAULT_CARD, { _title: null }, "fb")).toEqual({ label: "fb", lines: [], full: ["fb"] });
    // An app's own template: a bare `card` alias the query may compute wins over the title.
    expect(renderCard("{card|_title}", { _title: "Title", card: "Shown" }, "fb").label).toBe("Shown");
    expect(renderCard("{card|_title}", { _title: "Title" }, "fb").label).toBe("Title");
    expect(renderCard(DEFAULT_CARD, {}, "calcination")).toEqual({ label: "calcination", lines: [], full: ["calcination"] });
  });

  it("multi-line templates: literal text stays, a line whose placeholders are all absent is dropped, a literal-only line stays, blank lines vanish", () => {
    const t = "{_title}\nphase: {phase}\nowner: {owner|lead}\n\n— static —\n{missing} {also_missing}";
    expect(renderCard(t, { _title: "Kickoff", phase: "plan", lead: "/people/zoe.md" }, "fb")).toEqual({
      label: "Kickoff",
      lines: ["phase: plan", "owner: /people/zoe.md", "— static —"],
      full: ["Kickoff", "phase: plan", "owner: /people/zoe.md", "— static —"],
    });
    // The label is the first KEPT line: a dropped first line hands the label to the next.
    expect(renderCard("{nope}\n{title}", { title: "T" }, "fb").label).toBe("T");
    // A partially absent line keeps its present values — and loses the separator left dangling.
    expect(renderCard("{a} / {b}", { a: "x" }, "fb")).toEqual({ label: "x", lines: [], full: ["x"] });
  });

  it("an absent neighbour's separator goes: dangling at either end, doubled in the middle; a word stays; literal separators between present values stay", () => {
    expect(renderCard("{_title}\n{layer} · {stage}", { _title: "T", layer: "canon" }, "fb").lines).toEqual(["canon"]);
    expect(renderCard("{_title}\n{layer} · {stage}", { _title: "T", stage: "draft" }, "fb").lines).toEqual(["draft"]);
    expect(renderCard("{_title}\n{layer} · {stage}", { _title: "T" }, "fb").lines).toEqual([]);
    expect(renderCard("{a}, {b}, {c}", { a: "x", c: "z" }, "fb").label).toBe("x, z");
    expect(renderCard("{a} — {b} | {c}", { b: "y" }, "fb").label).toBe("y");
    // A literal WORD next to an absent field is kept as it was: `T by` (only separator-only text is tidied) —
    // and a line whose every placeholder is absent is still dropped, words or not (`by {owner}` alone → fallback).
    expect(renderCard("{_title} by {owner}", { _title: "T" }, "fb").label).toBe("T by");
    expect(renderCard("by {owner}", {}, "fb").label).toBe("fb");
    expect(renderCard("{_title}\nby {owner}", { _title: "T" }, "fb").lines).toEqual([]);
    // Values are never touched: a rooted path keeps its slash, a negative number its sign.
    expect(renderCard("{owner} · {stage}", { owner: "/people/zoe.md" }, "fb").label).toBe("/people/zoe.md");
    expect(renderCard("{n} / {m}", { n: -5 }, "fb").label).toBe("-5");
    // Separators the author wrote between PRESENT values stay, even doubled.
    expect(renderCard("{a} · · {b}", { a: "x", b: "y" }, "fb").label).toBe("x · · y");
    expect(renderCard("{a} / {b}", { a: "x", b: "y" }, "fb").label).toBe("x / y");
    // The tooltip's full text is tidied the same way.
    expect(renderCard("{layer} · {stage}", { layer: "canon" }, "fb").full).toEqual(["canon"]);
    expect(isSeparator(" · ")).toBe(true);
    expect(isSeparator(", ")).toBe(true);
    expect(isSeparator(" / ")).toBe(true);
    expect(isSeparator("by ")).toBe(false);
    expect(isSeparator("")).toBe(false);
    const sep = { text: " · ", full: " · ", sep: true }, a = { text: "a", full: "a", sep: false };
    expect(tidySeparators([sep, a, sep, sep, a, sep]).map((p) => p.text)).toEqual(["a", " · ", "a"]);
  });

  it("dotted paths descend records; empty braces are literal", () => {
    expect(readField({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
    expect(readField({ a: [1] }, "a.0")).toBeUndefined();
    expect(readField({ a: "s" }, "a.b")).toBeUndefined();
    expect(renderCard("{meta.owner.name}", { meta: { owner: { name: "Zoe" } } }, "fb").label).toBe("Zoe");
    expect(renderCard("{}", { x: 1 }, "fb").label).toBe("{}");
    expect(cardFields("{}")).toEqual([]);
  });

  it("renders values compactly, with the full value kept for the tooltip", () => {
    expect(formatValue("a\n  b")).toBe("a ⏎ b");
    expect(formatValue(3)).toBe("3");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(10n)).toBe("10");
    expect(formatValue(["a", "b", 1])).toBe("a, b, 1");
    expect(formatValue([{ a: 1 }, { b: 2 }])).toBe("2 items");
    expect(formatValue([[1], { a: 1 }, "x"])).toBe("[…], {…}, x");
    expect(formatValue({ a: 1 })).toBe("{…}");
    expect(formatValue(null)).toBe("");
    const r = renderCard("{tags}\n{meta}", { tags: ["x", "y"], meta: { k: 1 } }, "fb");
    expect(r.label).toBe("x, y");
    expect(r.lines).toEqual(["{…}"]);
    expect(r.full).toEqual(["x, y", '{"k":1}']);
    // An empty array counts as absent, so the alternative is taken.
    expect(renderCard("{tags|_title}", { tags: [], _title: "T" }, "fb").label).toBe("T");
    // Long values are capped in the tooltip.
    expect(renderCard("{long}", { long: "x".repeat(500) }, "fb").full[0]!.length).toBe(CARD.tooltipChars);
  });

  it("cardFields lists the placeholders in order, deduplicated, across lines and alternatives", () => {
    expect(cardFields(DEFAULT_CARD)).toEqual(["_title"]);
    expect(cardFields("{card|_title}")).toEqual(["card", "_title"]);
    expect(cardFields("{_title}\n{phase} · {owner|lead}\n{_title} again {meta.owner}")).toEqual(["_title", "phase", "owner", "lead", "meta.owner"]);
    expect(cardFields("no placeholders")).toEqual([]);
    expect(cardFields("{ spaced | names }")).toEqual(["spaced", "names"]);
  });
});

describe("the renderCard hook", () => {
  const node: GraphViewNode = { id: "/a.md", row: { _title: "Alpha", kind: "person", name: "Zoe" }, pinned: null };
  const lit = { _$litType$: 1, strings: ["<b>x</b>"], values: [] } as unknown as import("lit").TemplateResult;

  it("no renderer: the template; a string answer is a template for that node; a CardText passes through; a TemplateResult is HTML with the template as the size fallback", () => {
    expect(cardContent(null, DEFAULT_CARD, node)).toEqual({ kind: "text", text: { label: "Alpha", lines: [], full: ["Alpha"] } });
    expect(cardContent((n) => (n.row.kind === "person" ? "{name}\n{kind}" : "{_title}"), DEFAULT_CARD, node)).toEqual({ kind: "text", text: { label: "Zoe", lines: ["person"], full: ["Zoe", "person"] } });
    const text = { label: "custom", lines: ["l"], full: ["custom", "l"] };
    expect(cardContent(() => text, DEFAULT_CARD, node)).toEqual({ kind: "text", text });
    const c = cardContent(() => lit, DEFAULT_CARD, node);
    expect(c.kind).toBe("html");
    if (c.kind === "html") { expect(c.html).toBe(lit); expect(c.fallback.label).toBe("Alpha"); }
    expect(isTemplateResult(lit)).toBe(true);
    expect(isTemplateResult("x")).toBe(false);
    expect(isTemplateResult({ label: "x", lines: [], full: [] })).toBe(false);
  });

  it("renderCard beats card, and the fallback is the id when the renderer's template finds nothing", () => {
    const c = cardContent(() => "{nope}", "{_title}", node);
    expect(c.kind === "text" ? c.text.label : null).toBe("/a.md");
  });

  it("nodeSize takes the measured HTML box (floored to the minimum card) and the text size until then", () => {
    const text = { width: 120, height: 30 };
    expect(nodeSize(undefined, text)).toEqual({ w: 120, h: 30 });
    expect(nodeSize({ w: 0, h: 0 }, text)).toEqual({ w: 120, h: 30 });
    expect(nodeSize({ w: 210.2, h: 47.6 }, text)).toEqual({ w: 211, h: 48 });
    expect(nodeSize({ w: 20, h: 10 }, text)).toEqual({ w: CARD.minWidth, h: CARD.baseHeight });
  });
});

describe("label fit", () => {
  const m = fixedMeasure(10);

  it("wrapLabel: greedy word wrap under a measured width, over-long words broken, a measured-in ellipsis past the cap", () => {
    expect(wrapLabel("Kickoff", 100, m)).toEqual(["Kickoff"]);
    expect(wrapLabel("", 100, m)).toEqual([""]);
    expect(wrapLabel("the quick brown fox jumps over", 100, m)).toEqual(["the quick", "brown fox", "jumps over"]);
    expect(wrapLabel("abcdefghij klm", 100, m)).toEqual(["abcdefghij", "klm"]);
    expect(wrapLabel("a   b\n c", 100, m)).toEqual(["a b c"]);
    expect(wrapLabel("abcdefghijklmnopqrstuvwxyz", 100, m)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(wrapLabel("abcdefghijklm no", 100, m)).toEqual(["abcdefghij", "klm no"]);
    expect(wrapLabel("abc", 5, m, 10)).toEqual(["a", "b", "c"]);
    const text = "one two three four five six seven eight nine ten";
    const lines = wrapLabel(text, 100, m, 2);
    expect(lines).toEqual(["one two", `three fou${ELLIPSIS}`]);
    expect(m(lines[1]!)).toBeLessThanOrEqual(100);
    expect(wrapLabel(text, 100, m)).toHaveLength(LABEL_FIT.maxLines);
    expect(wrapLabel(text, 100, m, 10).join(" ")).toBe(text);
    expect(wrapLabel(text, 100, m, 0)).toEqual([`one two t${ELLIPSIS}`]);
  });

  it("sizeCard: truncate keeps the estimated width and one label line; wrap grows by a line; expand widens then wraps; detail lines count", () => {
    const long = "A rather long document title that will not fit on a single card line";
    const text = { label: long, lines: [], full: [long] };
    const t = sizeCard(text, "truncate", m);
    expect(t.width).toBe(CARD.maxWidth);
    expect(t.labelLines).toHaveLength(1);
    expect(t.labelLines[0]!.endsWith("…")).toBe(true);
    expect(t.height).toBe(CARD.baseHeight);
    const w = sizeCard(text, "wrap", m);
    expect(w.width).toBe(CARD.maxWidth);
    expect(w.labelLines).toEqual(wrapLabel(long, labelRoom(CARD.maxWidth), m));
    expect(w.labelLines).toHaveLength(3);
    expect(w.height).toBe(CARD.baseHeight + 2 * LABEL_FIT.lineHeight);
    const e = sizeCard(text, "expand", m);
    expect(e.width).toBe(LABEL_FIT.expandMaxWidth);
    expect(e.labelLines).toHaveLength(2);
    const mid = sizeCard({ label: "x".repeat(36), lines: [], full: [] }, "expand", m);
    expect(mid.width).toBe(360 + 2 * CARD.padX);
    expect(mid.labelLines).toEqual(["x".repeat(36)]);
    // A short label: wrap/expand measure (10/char) rather than estimate (7/char), never below the estimate.
    const short = sizeCard({ label: "Kickoff", lines: [], full: [] }, "wrap", m);
    expect(short).toEqual({ width: 70 + 2 * CARD.padX, height: CARD.baseHeight, labelLines: ["Kickoff"], detail: [] });
    expect(sizeCard({ label: "Kickoff", lines: [], full: [] }, "truncate", m).width).toBe(cardWidth(7, 0));
    // Detail lines: one each, truncated to the width, counted in the height.
    const d = sizeCard({ label: "T", lines: ["phase: plan", "note: " + "n".repeat(80)], full: [] }, "truncate", m);
    expect(d.detail[0]).toBe("phase: plan");
    expect(lineText(d.detail[1]!).endsWith("…")).toBe(true);
    expect(d.width).toBe(CARD.maxWidth);
    expect(d.height).toBe(CARD.baseHeight + 2 * CARD.lineHeight);
    expect(cardRadius(150, 34)).toBeCloseTo(Math.hypot(150, 34) / 2 + 8);
  });

  it("keyed detail lines: measured as `key: value`, truncated on the value with the key kept whole", () => {
    expect(lineText("plain")).toBe("plain");
    expect(lineText({ key: "phase", text: "plan" })).toBe("phase: plan");
    expect(truncateLine("abcdef", 4)).toBe("abc…");
    expect(truncateLine({ key: "phase", text: "abcdefgh" }, 12)).toEqual({ key: "phase", text: "abcd…" });
    expect(truncateLine({ key: "a-very-long-key", text: "v" }, 4)).toEqual({ key: "a-very-long-key", text: "v" });
    const k = sizeCard({ label: "T", lines: [{ key: "phase", text: "plan" }, { key: "note", text: "n".repeat(80) }], full: [] }, "truncate", m);
    expect(k.detail[0]).toEqual({ key: "phase", text: "plan" });
    const second = k.detail[1]!;
    expect(typeof second === "object" && second.key).toBe("note");
    expect(typeof second === "object" && second.text.endsWith("…")).toBe(true);
    expect(k.width).toBe(CARD.maxWidth);
    expect(k.height).toBe(CARD.baseHeight + 2 * CARD.lineHeight);
    // A keyed line widens the card like its `key: value` text would.
    expect(sizeCard({ label: "T", lines: [{ key: "phase", text: "plan" }], full: [] }, "truncate", m).width).toBe(cardWidth(1, "phase: plan".length));
  });

  it("the modes are the three names, truncate the default", () => {
    expect(LABEL_FITS).toEqual(["truncate", "wrap", "expand"]);
    expect(DEFAULT_LABEL_FIT).toBe("truncate");
    expect(isLabelFit("wrap")).toBe(true);
    expect(isLabelFit("stretch")).toBe(false);
  });
});

describe("the view model", () => {
  it("edge kinds: the three provenance kinds have CSS styles (no colour), any other kind a deterministic palette colour", () => {
    expect(edgeKindColor("frontmatter")).toBeNull();
    expect(edgeKindColor("body")).toBeNull();
    expect(edgeKindColor("external")).toBeNull();
    expect(edgeKindColor(undefined)).toBeNull();
    const a = edgeKindColor("depends_on");
    expect(EDGE_PALETTE).toContain(a);
    expect(edgeKindColor("depends_on")).toBe(a);
  });
  it("describes the graph for assistive technology", () => {
    const nodes: GraphViewNode[] = [{ id: "/a.md", row: {}, pinned: null, emphasis: "root" }, { id: "/b.md", row: {}, pinned: null }, { id: "https://x/", row: {}, pinned: null, kind: "external" }];
    const edges: GraphViewEdge[] = [{ key: "e", from: "/a.md", to: "/b.md" }];
    expect(graphDescription(nodes, edges)).toBe("graph around /a.md: 2 nodes, 1 external link, 1 relationship");
    expect(graphDescription([], [])).toBe("graph: 0 nodes, 0 relationships");
  });
});

describe("geometry", () => {
  const placed: Placed[] = [card("/c", 0, 0), card("/r", 300, 10), card("/u", 20, -200), card("/d", -5, 150), card("/far", 900, 40)];

  it("hit-tests the topmost card by its own rectangle", () => {
    expect(hitTest(placed, 0, 0)).toBe("/c");
    expect(hitTest(placed, W / 2, H / 2)).toBe("/c");
    expect(hitTest(placed, W / 2 + 1, 0)).toBeNull();
    expect(hitTest([card("/a", 0, 0), card("/b", 10, 0)], 5, 0)).toBe("/b");
    expect(hitTest([card("/wide", 0, 0, 400, 60)], 190, 25)).toBe("/wide");
    expect(hitTest([card("/narrow", 0, 0, 60, 30)], 190, 25)).toBeNull();
  });

  it("steps to the nearest card in a direction", () => {
    expect(nearestInDirection(placed, "/c", "right")).toBe("/r");
    expect(nearestInDirection(placed, "/c", "up")).toBe("/u");
    expect(nearestInDirection(placed, "/c", "down")).toBe("/d");
    expect(nearestInDirection(placed, "/c", "left")).toBeNull();
    expect(nearestInDirection(placed, "/r", "right")).toBe("/far");
    expect(nearestInDirection(placed, "/missing", "left")).toBe("/c");
    expect(nearestInDirection([], "/x", "up")).toBeNull();
  });

  it("fits every card (by its size) into the viewport, scale capped at 1; the home view centres the origin", () => {
    const one = fitTransform([card("/a", 100, 100)], 400, 300, 24);
    expect(one.k).toBe(1);
    expect(one.tx + 100).toBeCloseTo(200);
    const wide = fitTransform([card("/a", 0, 0), card("/b", 1000, 0, 300, 34)], 400, 300, 0);
    expect(wide.k).toBeCloseTo(400 / (1000 + W / 2 + 150));
    expect(fitTransform([], 400, 300)).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(initialView(1200, 600)).toEqual({ k: 1, tx: 600, ty: 300 });
    expect(toGraph(initialView(1200, 600), 600, 300)).toEqual({ x: 0, y: 0 });
    expect(toGraph({ k: 2, tx: 10, ty: 20 }, 10 + 2 * 7, 20 + 2 * 9)).toEqual({ x: 7, y: 9 });
  });

  it("zooms about a screen point, clamped, and pans by a screen offset", () => {
    const v = { k: 1, tx: 0, ty: 0 };
    const z = zoomAbout(v, 2, 100, 50);
    expect(z).toEqual({ k: 2, tx: -100, ty: -50 });
    expect(toGraph(z, 100, 50)).toEqual(toGraph(v, 100, 50));
    expect(zoomAbout(v, 100, 0, 0).k).toBe(ZOOM_MAX);
    expect(zoomAbout(v, 0.0001, 0, 0).k).toBe(ZOOM_MIN);
    const atMax = { k: ZOOM_MAX, tx: 3, ty: 4 };
    expect(zoomAbout(atMax, 2, 10, 10)).toBe(atMax);
    expect(panBy({ k: 2, tx: 10, ty: 20 }, -5, 7)).toEqual({ k: 2, tx: 5, ty: 27 });
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 0, false)).toBeCloseTo(Math.exp(0.2));
    expect(wheelZoomFactor(-10, 0, true)).toBeCloseTo(Math.exp(0.1));
    expect(wheelZoomFactor(-3, 1, false)).toBeCloseTo(wheelZoomFactor(-48, 0, false));
  });

  it("ends an arrow at the target card's border, by the target's size", () => {
    expect(arrowEnd({ x: 0, y: 0 }, { x: 300, y: 0 }, W, H, 0)).toEqual({ x: 300 - W / 2, y: 0 });
    expect(arrowEnd({ x: 0, y: 0 }, { x: 0, y: -200 }, W, H, 0)).toEqual({ x: 0, y: -200 + H / 2 });
    expect(arrowEnd({ x: 0, y: 0 }, { x: 100, y: 100 }, 100, 50, 0)).toEqual({ x: 75, y: 75 });
    expect(arrowEnd({ x: 0, y: 0 }, { x: 300, y: 0 }, 400, 60, 0)).toEqual({ x: 100, y: 0 });
    expect(arrowEnd({ x: 5, y: 5 }, { x: 5, y: 5 }, W, H)).toEqual({ x: 5, y: 5 });
  });

  it("decides what a press starts and where a connector lands", () => {
    expect(dragMode({ handle: true, modifier: false, canWrite: true, armed: null }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: true, canWrite: true, armed: null }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: false, canWrite: true, armed: "/a" }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: false, canWrite: true, armed: "/b" }, "/a")).toBe("move");
    expect(dragMode({ handle: true, modifier: true, canWrite: false, armed: "/a" }, "/a")).toBe("move");
    const isDoc = (id: string) => id !== "/far";
    expect(connectorDrop(placed, "/c", 305, 12, isDoc)).toEqual({ kind: "connect", from: "/c", to: "/r" });
    expect(connectorDrop(placed, "/c", 0, 0, isDoc)).toEqual({ kind: "empty", from: "/c", x: 0, y: 0 });
    expect(connectorDrop(placed, "/c", 900, 40, isDoc)).toEqual({ kind: "empty", from: "/c", x: 900, y: 40 });
    const g = connectorLine(card("/a", 0, 0), { x: 300, y: 0 });
    expect(g).toEqual({ x1: W / 2, y1: 0, x2: 300, y2: 0, hint: { x: 314, y: 18 } });
    expect(connectorLine(card("/a", 0, 0), { x: 10, y: 5 })).toMatchObject({ x1: 10, y1: 5, x2: 10, y2: 5 });
  });

  it("the force layout's numbers", () => {
    const c = forceConfig();
    expect(c.gravity).toEqual({ x: 0, y: 0, strength: 0.04 });
    expect(c.link).toEqual({ distance: 100, strength: 0.8 });
    expect(c.charge).toEqual({ strength: -220, distanceMax: 350, theta: 0.9 });
    expect(c.collide.margin).toBe(8);
    expect(c.reheatAlpha).toBe(0.5);
  });
});

describe("edge routing", () => {
  const A = card("/a", 0, 0);
  const B = card("/b", 600, 0);
  const dot = (p: { x: number; y: number }, q: { x: number; y: number }) => p.x * q.x + p.y * q.y;

  it("segment / rectangle (Liang–Barsky) and sampled-curve hits", () => {
    const r = { x: 300, y: 0, hw: 85, hh: 27 };
    expect(segmentHitsRect({ x: 0, y: 0 }, { x: 600, y: 0 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 100 }, { x: 600, y: 100 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 300, y: -200 }, { x: 300, y: 200 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 0 }, { x: 200, y: 0 }, r)).toBe(false);
    expect(curveHitsRect({ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }, r)).toBe(true);
    expect(curveHitsRect({ x: 0, y: 0 }, { x: 300, y: 200 }, { x: 600, y: 0 }, r)).toBe(false);
  });

  it("an unobstructed edge is a straight segment between the card borders", () => {
    const r = edgePath(A, B, [A, B, card("/far", 300, 400)], { key: "k" });
    expect(r.control).toBeNull();
    expect(r.bends).toBe(0);
    expect(r.offset).toBe(0);
    expect(r.d).toBe(`M ${W / 2 + 2} 0 L ${600 - W / 2 - 2} 0`);
    expect(r.tangent).toEqual({ x: 1, y: 0 });
    // A wider target card: the arrow ends at ITS border.
    const wide = card("/wide", 600, 0, 300, 60);
    expect(edgePath(A, wide, [], { key: "k" }).end.x).toBe(600 - 150 - 2);
  });

  it("a card on the segment pushes the control point to the far side and the curve clears the inflated rect", () => {
    const above = card("/o", 300, -5);
    const r = edgePath(A, B, [A, B, above], { key: "k" });
    expect(r.control!.y).toBeGreaterThan(0);
    expect(r.bends).toBe(1);
    expect(r.d).toContain(" Q ");
    expect(routeViolations(r, A, B, [A, B, above])).toBe(0);
    expect(curveHitsRect(r.start, r.control!, r.end, { x: 300, y: -5, hw: W / 2 + ROUTE_MARGIN, hh: H / 2 + ROUTE_MARGIN })).toBe(false);
    expect(edgePath(A, B, [A, B, card("/o", 300, 5)], { key: "k" }).control!.y).toBeLessThan(0);
    expect(dot(r.tangent, { x: B.x - r.end.x, y: B.y - r.end.y })).toBeGreaterThan(0);
    // A taller obstacle needs a bigger bulge.
    const tall = edgePath(A, B, [A, B, card("/o", 300, -5, 150, 120)], { key: "k" });
    expect(Math.abs(tall.offset)).toBeGreaterThan(Math.abs(r.offset));
    expect(routeViolations(tall, A, B, [card("/o", 300, -5, 150, 120)])).toBe(0);
  });

  it("obstacles on both sides: the fewest crossings win, nothing is NaN; a clearable two-sided case is cleared", () => {
    const S = card("/s", 0, 0), T = card("/t", 240, 0);
    const wall = [-80, 0, 80].map((y, i) => card(`/w${i}`, 120, y));
    const r = edgePath(S, T, [S, T, ...wall], { key: "k" });
    expect(r.d).not.toMatch(/NaN/);
    expect(routeViolations(r, S, T, wall)).toBeLessThanOrEqual(routeViolations(edgePath(S, T, [], { avoid: false }), S, T, wall));
    const two = [card("/p", 200, -20), card("/q", 400, 20)];
    const r2 = edgePath(A, B, [A, B, ...two], { key: "k" });
    expect(r2.bends).toBeGreaterThanOrEqual(1);
    expect(routeViolations(r2, A, B, two)).toBe(0);
  });

  it("only tiny edges stay straight (2 × the taller endpoint — two touching cards); `avoid: false` is the straight style", () => {
    expect(routeMinLength(A, B)).toBe(68);
    expect(routeMinLength(A, card("/w", 0, 0, 300, 40))).toBe(80);
    // Width no longer matters: a 200 px edge (under the old 225 px rule) still routes around a card on its line.
    const near = card("/n", 200, 0);
    expect(edgePath(A, near, [A, near, card("/o", 100, -3, 40, 34)], { key: "k" }).bends).toBeGreaterThanOrEqual(1);
    const tiny = card("/t", 60, 0);
    expect(edgePath(A, tiny, [A, tiny, card("/o", 30, -3)], { key: "k" }).control).toBeNull();
    expect(edgePath(A, B, [A, B, card("/o", 300, -5)], { key: "k", avoid: false }).control).toBeNull();
  });

  it("is deterministic; an obstacle exactly on the line takes its side from the key", () => {
    const on = card("/o", 300, 0);
    expect(edgePath(A, B, [A, B, on], { key: "a" }).d).toBe(edgePath(A, B, [A, B, on], { key: "a" }).d);
    expect(keySide("a")).toBe(1);
    expect(keySide("b")).toBe(-1);
    expect(Math.sign(edgePath(A, B, [A, B, on], { key: "a" }).control!.y)).toBe(-Math.sign(edgePath(A, B, [A, B, on], { key: "b" }).control!.y));
  });

  it("parallel edges of one pair fan apart; A→B and B→A spread; controlOffset / pathFromOffset draw exactly an offset", () => {
    const o = parallelOffsets([{ key: "e2", from: "/a", to: "/b" }, { key: "e1", from: "/a", to: "/b" }, { key: "e3", from: "/b", to: "/a" }, { key: "self", from: "/a", to: "/a" }]);
    expect(o.get("e1")).toBe(-PARALLEL_GAP);
    expect(o.get("e2")).toBe(0);
    expect(o.get("e3")).toBe(-PARALLEL_GAP);
    expect(o.has("self")).toBe(false);
    expect(edgePath(A, B, [], { key: "e1", offset: o.get("e1")! }).control!.y).toBeCloseTo(-PARALLEL_GAP);
    expect(edgePath(B, A, [], { key: "e3", offset: o.get("e3")! }).control!.y).toBeCloseTo(PARALLEL_GAP);
    const forced = edgePath(A, B, [A, B, card("/o", 300, -5)], { key: "k", offset: 99, controlOffset: -40 });
    expect(forced.offset).toBe(-40);
    expect(forced.bends).toBe(0);
    expect(pathFromOffset(A, B, -40)).toEqual(forced);
    expect(pathFromOffset(A, B, 0).control).toBeNull();
    expect(arrowheadPath({ x: 100, y: 0 }, { x: 1, y: 0 })).toBe("M 100 0 L 91 4 L 91 -4 Z");
  });

  it("easing: exponential approach with a clamped dt, a snap, and an EdgeEaser that glides through zero on a side flip", () => {
    expect(easeToward(0, 100, 0)).toBe(0);
    expect(easeToward(0, 100, EASE_TAU)).toBeCloseTo(100 * (1 - Math.exp(-EASE_MAX_DT / EASE_TAU)));
    expect(easeToward(99.8, 100, 16)).toBe(100);
    expect(easeToward(100, 100 - EASE_SNAP / 2, 1)).toBe(100 - EASE_SNAP / 2);
    const e = new EdgeEaser();
    const t1 = new Map([["a", 40], ["b", 0]]);
    expect(e.step(t1, 16)).toEqual(t1);
    expect(e.settled(t1)).toBe(true);
    const t2 = new Map([["a", -40]]);
    const trace: number[] = [];
    for (let i = 0; i < 60; i++) trace.push(e.step(t2, 16).get("a")!);
    expect(trace[0]).toBeLessThan(40);
    expect(trace.some((v) => Math.abs(v) < 10)).toBe(true);
    expect(trace.every((v, i) => i === 0 || v <= trace[i - 1]!)).toBe(true);
    expect(trace[trace.length - 1]).toBe(-40);
    expect(e.size).toBe(1);
    const t3 = new Map([["a", 0], ["c", 12]]);
    expect(e.step(t3, 16).get("c")).toBe(12);
    expect(e.settled(t3)).toBe(false);
    expect(e.snap(t3)).toEqual(t3);
    expect(e.settled(t3)).toBe(true);
  });
});

describe("polyline routes (fixed layouts)", () => {
  it("polylineMidpoint is halfway by length; degenerate inputs", () => {
    expect(polylineMidpoint([])).toBeNull();
    expect(polylineMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual({ x: 10, y: 0 });
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toEqual({ x: 0, y: 0 });
  });

  it("polylineRoute draws M/L through every point, aims the arrowhead along the last segment and labels the midpoint", () => {
    expect(polylineRoute([])).toBeNull();
    expect(polylineRoute([{ x: 1, y: 1 }])).toBeNull();
    const r = polylineRoute([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }])!;
    expect(r.d).toBe("M 0 0 L 10 0 L 10 20");
    expect(r.start).toEqual({ x: 0, y: 0 });
    expect(r.end).toEqual({ x: 10, y: 20 });
    expect(r.tangent).toEqual({ x: 0, y: 1 });
    expect(r.control).toBeNull();
    expect(r.mid).toEqual({ x: 10, y: 5 });
    expect(r.bends).toBe(1);
    expect(r.offset).toBe(0);
    // A repeated end point does not zero the tangent.
    expect(polylineRoute([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }])!.tangent).toEqual({ x: 1, y: 0 });
    expect(arrowheadPath(r.end, r.tangent).startsWith("M 10 20")).toBe(true);
  });
});
