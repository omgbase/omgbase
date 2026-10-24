// The pure half of <omg-graph>: a renderer-neutral VIEW model (nodes carrying a
// projected row, edges carrying a label and provenance), card templates over the
// row, label fit and card sizing, and every piece of geometry the element draws
// with — hit-testing, keyboard stepping, the view transform, obstacle-aware
// Bézier edge routing with temporal easing, the force layout's numbers, the
// connector gesture's decisions. Nothing here knows what a node id means (a
// path, a row id) or talks to a server: the host app builds the view model from
// its own model and handles the element's events.
//
// Card templates. `renderCard(template, row, fallback)` reads a multi-line
// template over the row: `{field}` is `row.field` (`{a.b}` descends records),
// `{a|b|c}` the first PRESENT alternative (not null / undefined / "" / []),
// literal text stays, a line whose placeholders are ALL absent is dropped, a
// line with no placeholders stays, values render compactly (`formatValue`).
// The first kept line is the label, the rest are detail lines; when every line
// is dropped the label is the fallback. `DEFAULT_CARD` is `{_title}` — the
// element bakes in no display-property concept; an app passes its own template
// (graph-ui's is `{card|_title}`, `card` being a bare alias a query may compute).
//
// Sizes. Every geometry helper takes `Placed { id, x, y, w, h }` — cards have
// their own width and height (`sizeCard` from the label fit and a measured
// label width), the obstacles of a route are rectangles of varying size, and
// `forceCollide` keeps cards apart by `cardRadius(w, h)`.

import type { TemplateResult } from "lit";

// ---- the view model ------------------------------------------------------------------------

export interface Pin { x: number; y: number }

export interface GraphViewNode {
  /** Opaque to the element; the host's identity (a path, a row id). */
  id: string;
  /** The projected row the card template reads. */
  row: Record<string, unknown>;
  /** `"document"` (default) or `"external"` (drawn dashed, never expandable). */
  kind?: string;
  /** Session-local layout pin — presentation state. */
  pinned: Pin | null;
  expandable?: boolean;
  expanded?: boolean;
  /** Neighbours left out of the view ("+k more"). */
  truncated?: number;
  emphasis?: "root" | null;
  /** The hover text; the card's full lines when absent. */
  tooltip?: string;
}

export type EdgeLineStyle = "solid" | "dotted" | "dashed";

export interface GraphViewEdge {
  key: string;
  from: string;
  to: string;
  /** The short text shown on hover. */
  label?: string;
  /** The provenance / inspector text (the `<title>`). */
  detail?: string;
  /** A colour class: `frontmatter`, `body` and `external` have fixed styles; any other kind takes a palette colour (`edgeKindColor`). */
  kind?: string;
  /** An explicit stroke colour (CSS), winning over the kind's: for a host that keeps its own palette per relationship. */
  color?: string;
  style?: EdgeLineStyle;
  /** An optimistic edge whose write is in flight: drawn dashed and faded. */
  pending?: "add" | "remove";
  /** Whether a ⌘-click may toggle it (`edgeToggle` mode). */
  writable?: boolean;
}

export type EdgeStyle = "curved" | "straight";
export type LayoutMode = "force" | "fixed";

/** The fixed strokes of the three provenance kinds, and a palette for every other kind (deterministic by name). */
export const EDGE_PALETTE: readonly string[] = ["#6a1b9a", "#2e7d32", "#ef6c00", "#00838f", "#ad1457", "#5d4037", "#37474f", "#827717"];
export const FIXED_EDGE_KINDS: ReadonlySet<string> = new Set(["frontmatter", "body", "external"]);

/** A colour for an edge kind other than the fixed three (`null` for those — their styles are CSS). */
export function edgeKindColor(kind: string | undefined): string | null {
  if (!kind || FIXED_EDGE_KINDS.has(kind)) return null;
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return EDGE_PALETTE[h % EDGE_PALETTE.length]!;
}

/** A one-line description of the graph for assistive technology. */
export function graphDescription(nodes: readonly GraphViewNode[], edges: readonly GraphViewEdge[]): string {
  const docs = nodes.filter((n) => (n.kind ?? "document") !== "external").length;
  const ext = nodes.length - docs;
  const root = nodes.find((n) => n.emphasis === "root");
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  return `graph${root ? ` around ${root.id}` : ""}: ${n(docs, "node")}${ext > 0 ? `, ${n(ext, "external link")}` : ""}, ${n(edges.length, "relationship")}`;
}

// ---- card templates -------------------------------------------------------------------------

export type CardTemplate = string;
export const DEFAULT_CARD: CardTemplate = "{_title}";

/** A detail line: plain text, or a `key: value` pair drawn with the key dimmer (the key is kept whole when the value is truncated). */
export type CardLine = string | { key: string; text: string };

export interface CardText {
  /** The first kept line (bold). */
  label: string;
  /** The remaining kept lines (smaller). */
  lines: CardLine[];
  /** Every kept line with its values in full (the tooltip). */
  full: string[];
}

/** A detail line as one string (`key: value` for a keyed line). */
export function lineText(line: CardLine): string {
  return typeof line === "string" ? line : `${line.key}: ${line.text}`;
}

/** A detail line cut to `chars` glyphs: a keyed line keeps its key whole and truncates the value. */
export function truncateLine(line: CardLine, chars: number): CardLine {
  if (typeof line === "string") return truncate(line, chars);
  return { key: line.key, text: truncate(line.text, Math.max(1, chars - line.key.length - 2)) };
}

type Segment = { text: string } | { fields: string[] };

/** One template line as literal text and placeholders. */
export function parseCardLine(line: string): Segment[] {
  const out: Segment[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    const fields = m[1]!.split("|").map((f) => f.trim()).filter((f) => f.length > 0);
    if (fields.length > 0) out.push({ fields });
    else out.push({ text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/** The placeholder names of a template, in order, deduplicated — what the host projects. */
export function cardFields(template: CardTemplate): string[] {
  const out: string[] = [];
  for (const line of template.split("\n")) for (const seg of parseCardLine(line)) if ("fields" in seg) for (const f of seg.fields) if (!out.includes(f)) out.push(f);
  return out;
}

/** `row.a.b` for `a.b`; undefined when any step is not a record. */
export function readField(row: Record<string, unknown>, path: string): unknown {
  let cur: unknown = row;
  for (const step of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[step];
  }
  return cur;
}

/** A value counts as present unless null, undefined, "" or an empty array. */
export function isPresent(v: unknown): boolean {
  return !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
}

/** A value rendered compactly, on one line. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\s*\n\s*/g, " ⏎ ").trim();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    if (v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    return v.map((x) => (x !== null && typeof x === "object" ? (Array.isArray(x) ? "[…]" : "{…}") : formatValue(x))).join(", ");
  }
  if (typeof v === "object") return "{…}";
  return String(v);
}

/** The value for a tooltip: scalars and flat arrays as drawn, structures as one-line JSON, capped at `CARD.tooltipChars`. */
export function formatFull(v: unknown): string {
  let s: string;
  if (v !== null && typeof v === "object" && !(Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"))) {
    try { s = JSON.stringify(v); } catch { s = formatValue(v); }
  } else {
    s = formatValue(v);
  }
  return truncate(s, CARD.tooltipChars);
}

export function truncate(s: string, max: number): string {
  const n = Math.max(1, Math.floor(max));
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

/** Separator punctuation a template puts between placeholders — `·`, `-`, `—`, `–`, `|`, `,`, `:`, `;`, `/` — with its spaces. */
const SEPARATOR_ONLY = /^(?:\s*[·\-—–|,:;/])+\s*$/;

/** Is this literal template text nothing but separator glyphs (and spaces)? */
export function isSeparator(text: string): boolean {
  return SEPARATOR_ONLY.test(text);
}

/** One piece of a rendered template line: literal text (`sep` when it is only separator glyphs) or a value. */
export interface Piece { text: string; full: string; sep: boolean }

/** The kept pieces of one rendered line with the separators an absent placeholder
 * left dangling removed: a separator-only literal at either end of the line goes,
 * and of two separator-only literals made adjacent by a vanished value (`a · · b`)
 * the second goes. Only the TEMPLATE's own text is touched, never a value — a
 * `/`-rooted path or a negative number keeps its glyphs — and a literal with a
 * word in it (`by ` in `by {owner}`) stays. */
export function tidySeparators(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (p.sep && prev?.sep) continue;
    out.push(p);
  }
  while (out.length > 0 && out[0]!.sep) out.shift();
  while (out.length > 0 && out[out.length - 1]!.sep) out.pop();
  return out;
}

/** The card's text for a row: see the module header for the template language. */
export function renderCard(template: CardTemplate, row: Record<string, unknown>, fallback: string): CardText {
  const kept: { text: string; full: string }[] = [];
  for (const line of template.split("\n")) {
    const segs = parseCardLine(line);
    const placeholders = segs.filter((s): s is { fields: string[] } => "fields" in s);
    let pieces: Piece[] = [];
    let any = false, absent = false;
    for (const seg of segs) {
      if ("text" in seg) { pieces.push({ text: seg.text, full: seg.text, sep: isSeparator(seg.text) }); continue; }
      const v = seg.fields.map((f) => readField(row, f)).find(isPresent);
      if (v === undefined) { absent = true; continue; }
      any = true;
      pieces.push({ text: formatValue(v), full: formatFull(v), sep: false });
    }
    if (placeholders.length > 0 && !any) continue;
    // Only a line that lost a placeholder is tidied: separators the author wrote between present values stay.
    if (absent) pieces = tidySeparators(pieces);
    const text = pieces.map((p) => p.text).join("").trim();
    if (text === "") continue;
    kept.push({ text, full: pieces.map((p) => p.full).join("").trim() });
  }
  if (kept.length === 0) return { label: fallback, lines: [], full: [fallback] };
  return { label: kept[0]!.text, lines: kept.slice(1).map((k) => k.text), full: kept.map((k) => k.full) };
}

// ---- the card renderer hook ----------------------------------------------------------------------

/** A host function deciding a node's card: a template string (per kind, say), a
 * ready `CardText`, or a Lit `html` template drawn as HTML inside the card. */
export type CardRenderer = (node: GraphViewNode) => string | CardText | TemplateResult;

export type CardContent =
  | { kind: "text"; text: CardText }
  /** HTML content; `fallback` is the text card used for the size until the HTML is measured. */
  | { kind: "html"; html: TemplateResult; fallback: CardText };

/** A Lit `TemplateResult` is recognised by its `_$litType$` brand (no lit import needed at runtime). */
export function isTemplateResult(v: unknown): v is TemplateResult {
  return v !== null && typeof v === "object" && "_$litType$" in (v as Record<string, unknown>);
}

/** What a node's card shows: the `renderer`'s answer when one is set (a string is a template for this node), else the `template`. */
export function cardContent(renderer: CardRenderer | null, template: CardTemplate, node: GraphViewNode): CardContent {
  const fallback = node.id;
  if (!renderer) return { kind: "text", text: renderCard(template, node.row, fallback) };
  const out = renderer(node);
  if (typeof out === "string") return { kind: "text", text: renderCard(out, node.row, fallback) };
  if (isTemplateResult(out)) return { kind: "html", html: out, fallback: renderCard(template, node.row, fallback) };
  return { kind: "text", text: out };
}

/** A node's drawn size: the measured HTML box when there is one (never below the minimum card), else the text card's. */
export function nodeSize(measured: { w: number; h: number } | undefined, textSize: { width: number; height: number }): { w: number; h: number } {
  if (measured && measured.w > 0 && measured.h > 0) return { w: Math.max(CARD.minWidth, Math.ceil(measured.w)), h: Math.max(CARD.baseHeight, Math.ceil(measured.h)) };
  return { w: textSize.width, h: textSize.height };
}

// ---- label fit and card size ---------------------------------------------------------------------

export type LabelFit = "truncate" | "wrap" | "expand";
export const LABEL_FITS: readonly LabelFit[] = ["truncate", "wrap", "expand"];
export const DEFAULT_LABEL_FIT: LabelFit = "truncate";

export function isLabelFit(v: unknown): v is LabelFit {
  return typeof v === "string" && (LABEL_FITS as readonly string[]).includes(v);
}

/** Geometry (SVG user units ≈ CSS px at scale 1). */
export const CARD = {
  minWidth: 60,
  maxWidth: 260,
  padX: 9,
  /** A label-only card. */
  baseHeight: 30,
  /** Each detail line. */
  lineHeight: 15,
  /** Average glyph widths at the two font sizes (12px label, 11px lines). */
  labelCharWidth: 7,
  lineCharWidth: 6.2,
  /** The longest text kept for a tooltip. */
  tooltipChars: 240,
} as const;

/** The width of `text` in px, in the card's label font. */
export type Measure = (text: string) => number;

export const LABEL_FIT = {
  /** Lines a wrapped label may take before the ellipsis. */
  maxLines: 4,
  /** The widest an `expand` card grows before its label wraps. */
  expandMaxWidth: 480,
  /** Baseline to baseline between label lines (12px font). */
  lineHeight: 15,
  /** The label font — the same string as the element's label rule, so a canvas measures what the SVG draws. */
  font: "600 12px system-ui, sans-serif",
} as const;

export const ELLIPSIS = "…";

/** A measure for tests and for environments without a canvas: `perChar` px a character. */
export function fixedMeasure(perChar: number): Measure {
  return (text) => text.length * perChar;
}

/** A canvas `measureText` in `font`, memoised per string; the per-character estimate when no canvas exists. */
export function canvasMeasure(font: string = LABEL_FIT.font): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return fixedMeasure(CARD.labelCharWidth);
  ctx.font = font;
  const cache = new Map<string, number>();
  return (text) => {
    let w = cache.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      if (cache.size > 4096) cache.clear();
      cache.set(text, w);
    }
    return w;
  };
}

/** The longest prefix of `text` that, with `suffix` appended, measures within `maxWidth`. */
function clipTo(text: string, maxWidth: number, measure: Measure, suffix: string): string {
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join("") + suffix) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + suffix;
}

function breakWord(word: string, maxWidth: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let rest = [...word];
  while (rest.length > 0) {
    const n = Math.max(1, [...clipTo(rest.join(""), maxWidth, measure, "")].length);
    pieces.push(rest.slice(0, n).join(""));
    rest = rest.slice(n);
  }
  return pieces;
}

/** Greedy word wrap of `text` to `maxWidth` px: words packed while they fit, an
 * over-long word broken by characters, at most `maxLines` lines, the last one
 * clipped to end in a measured-in `…` when the text does not fit. An empty text is one empty line. */
export function wrapLabel(text: string, maxWidthPx: number, measure: Measure, maxLines: number = LABEL_FIT.maxLines): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const limit = Math.max(1, Math.floor(maxLines));
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  const flush = (): void => { lines.push(current); current = ""; };
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidthPx) { current = candidate; continue; }
    if (current !== "") flush();
    if (measure(word) <= maxWidthPx) { current = word; continue; }
    const pieces = breakWord(word, maxWidthPx, measure);
    for (const piece of pieces.slice(0, -1)) { current = piece; flush(); }
    current = pieces[pieces.length - 1]!;
  }
  if (current !== "") flush();
  if (lines.length <= limit) return lines;
  const kept = lines.slice(0, limit);
  kept[limit - 1] = clipTo(lines.slice(limit - 1).join(" "), maxWidthPx, measure, ELLIPSIS);
  return kept;
}

/** How many label / line glyphs fit a card of `width`. */
export function fitChars(width: number, charWidth: number): number {
  return Math.max(4, Math.floor((width - 2 * CARD.padX + 4) / charWidth));
}

/** The estimated one-line width that fits the longest text, within the bounds. */
export function cardWidth(labelChars: number, lineChars: number): number {
  const wanted = Math.max(2 * CARD.padX + labelChars * CARD.labelCharWidth, 2 * CARD.padX + lineChars * CARD.lineCharWidth);
  return Math.max(CARD.minWidth, Math.min(CARD.maxWidth, Math.ceil(wanted)));
}

/** The room for the label inside a card of `width`. */
export function labelRoom(width: number): number {
  return Math.max(1, width - 2 * CARD.padX);
}

/** The radius of the circle that covers a card plus a margin — what `forceCollide` keeps apart. */
export function cardRadius(width: number, height: number, margin = 8): number {
  return Math.hypot(width, height) / 2 + margin;
}

export interface CardSize {
  width: number;
  height: number;
  /** The label as drawn, one `<tspan>` per entry. */
  labelLines: string[];
  /** The detail lines as drawn (truncated to the width; a keyed line keeps its key). */
  detail: CardLine[];
}

/** The card's size for a card text under a label fit. `truncate`: one label
 * line with an ellipsis at the estimated width; `wrap`: the label wraps within
 * the measured width (capped at `CARD.maxWidth`), the card grows a line each up
 * to `LABEL_FIT.maxLines`; `expand`: the card widens to the whole label up to
 * `LABEL_FIT.expandMaxWidth`, then wraps. Detail lines are one line each. */
export function sizeCard(text: CardText, fit: LabelFit, measure: Measure): CardSize {
  const estimate = cardWidth(text.label.length, Math.max(0, ...text.lines.map((l) => lineText(l).length)));
  let width = estimate;
  let labelLines: string[];
  if (fit === "truncate") {
    labelLines = [truncate(text.label, fitChars(width, CARD.labelCharWidth))];
  } else {
    const cap = fit === "expand" ? LABEL_FIT.expandMaxWidth : CARD.maxWidth;
    const wanted = Math.ceil(measure(text.label) + 2 * CARD.padX);
    width = Math.max(estimate, Math.min(cap, wanted));
    labelLines = wrapLabel(text.label, labelRoom(width), measure);
  }
  const lineChars = fitChars(width, CARD.lineCharWidth);
  const detail = text.lines.map((l) => truncateLine(l, lineChars));
  return { width, height: CARD.baseHeight + (labelLines.length - 1) * LABEL_FIT.lineHeight + detail.length * CARD.lineHeight, labelLines, detail };
}

// ---- geometry ----------------------------------------------------------------------------------

/** A card placed in graph space: its centre and its size. */
export interface Placed { id: string; x: number; y: number; w: number; h: number }
export type Direction = "up" | "down" | "left" | "right";
type Pt = { x: number; y: number };

/** The topmost card (last in order) whose rectangle contains the point, else null. */
export function hitTest(placed: readonly Placed[], x: number, y: number): string | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (Math.abs(x - p.x) <= p.w / 2 && Math.abs(y - p.y) <= p.h / 2) return p.id;
  }
  return null;
}

/** The nearest card from `from` whose displacement points mostly in `dir`, else null. */
export function nearestInDirection(placed: readonly Placed[], from: string, dir: Direction): string | null {
  const origin = placed.find((p) => p.id === from);
  if (!origin) return placed[0]?.id ?? null;
  let best: { id: string; d: number } | null = null;
  for (const p of placed) {
    if (p.id === from) continue;
    const dx = p.x - origin.x, dy = p.y - origin.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { id: p.id, d };
  }
  return best?.id ?? null;
}

export interface ViewTransform { k: number; tx: number; ty: number }

/** The home view: graph (0, 0) at the viewport's centre, 1:1. */
export function initialView(width: number, height: number): ViewTransform {
  return { k: 1, tx: width / 2, ty: height / 2 };
}

/** The scale/translate that fits every card into `width`×`height` with `pad` around (scale capped at 1). */
export function fitTransform(placed: readonly Placed[], width: number, height: number, pad = 24): ViewTransform {
  if (placed.length === 0 || width <= 0 || height <= 0) return { k: 1, tx: 0, ty: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  const bw = maxX - minX, bh = maxY - minY;
  const k = Math.min(1, (width - 2 * pad) / bw, (height - 2 * pad) / bh);
  return { k, tx: (width - k * bw) / 2 - k * minX, ty: (height - k * bh) / 2 - k * minY };
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

/** Screen → graph coordinates under a transform. */
export function toGraph(view: ViewTransform, sx: number, sy: number): Pt {
  return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k };
}

/** The view scaled by `factor` about the screen point (sx, sy) — the graph point under it stays put — clamped to [min, max]. */
export function zoomAbout(view: ViewTransform, factor: number, sx: number, sy: number, min = ZOOM_MIN, max = ZOOM_MAX): ViewTransform {
  const k = Math.min(max, Math.max(min, view.k * factor));
  if (k === view.k) return view;
  const g = toGraph(view, sx, sy);
  return { k, tx: sx - g.x * k, ty: sy - g.y * k };
}

/** The view shifted by a screen offset. */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { k: view.k, tx: view.tx + dx, ty: view.ty + dy };
}

/** A wheel event's zoom factor: `ctrlKey` is a trackpad pinch (Chromium/Safari) and zooms faster per unit; line/page deltas are scaled to pixels. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (ctrlKey ? 0.01 : 0.002));
}

/** Where the segment from `from` to the centre of a `w`×`h` card at `to` meets that card's border. */
export function arrowEnd(from: Pt, to: Pt, w: number, h: number, gap = 2): Pt {
  const dx = from.x - to.x, dy = from.y - to.y;
  if (dx === 0 && dy === 0) return { x: to.x, y: to.y };
  const hw = w / 2 + gap, hh = h / 2 + gap;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: to.x + dx * t, y: to.y + dy * t };
}

/** What a press on a node starts: a connector (the ⟶ handle, ⌘/Ctrl held, or the node armed) when writes are allowed, else a reposition. */
export function dragMode(input: { handle: boolean; modifier: boolean; canWrite: boolean; armed: string | null }, id: string): "connector" | "move" {
  return input.canWrite && (input.handle || input.modifier || input.armed === id) ? "connector" : "move";
}

export type ConnectorDrop = { kind: "connect"; from: string; to: string } | { kind: "empty"; from: string; x: number; y: number };

/** Where a connector from `from` dropped at graph point (x, y) lands: on another node that `isTarget` accepts (never the source), else open canvas. */
export function connectorDrop(placed: readonly Placed[], from: string, x: number, y: number, isTarget: (id: string) => boolean): ConnectorDrop {
  const hit = hitTest(placed.filter((p) => p.id !== from), x, y);
  return hit !== null && isTarget(hit) ? { kind: "connect", from, to: hit } : { kind: "empty", from, x, y };
}

export interface ConnectorLine { x1: number; y1: number; x2: number; y2: number; hint: Pt }

/** The ghost connector from a source card's border to the pointer; a pointer still inside the card gives a zero-length line. */
export function connectorLine(source: Placed, pointer: Pt): ConnectorLine {
  const start = arrowEnd(pointer, source, source.w, source.h, 0);
  const inside = Math.abs(pointer.x - source.x) <= source.w / 2 && Math.abs(pointer.y - source.y) <= source.h / 2;
  const from = inside ? pointer : start;
  return { x1: from.x, y1: from.y, x2: pointer.x, y2: pointer.y, hint: { x: pointer.x + 14, y: pointer.y + 18 } };
}

// ---- edge routing: obstacle-aware quadratic Béziers -----------------------------------------------

export const ROUTE_MARGIN = 10;
export const ROUTE_STEP = 12;
export const ROUTE_SAMPLES = 16;
export const ROUTE_PASSES = 3;
export const ROUTE_MAX_PUSHES = 8;
/** An edge shorter than this many times the wider endpoint card is never deflected. */
/** Edges shorter than this many card HEIGHTS skip the obstacle pass (two touching
 * cards): the width-based rule of the first cut made every edge under 390 px
 * straight once cards were sized from their text — the usual neighbourhood. */
export const ROUTE_MIN_FACTOR = 2;
/** The control offset is capped at this fraction of the edge's length (a quadratic's bulge is half the
 * offset, so a chord through a hub ringed by its neighbours can still arc outside the ring). */
export const ROUTE_MAX_RATIO = 2;
/** Perpendicular spacing between parallel edges of one node pair. */
export const PARALLEL_GAP = 36;
/** A crossing through a card's body costs this many times a graze of its margin (a hub inside its ring of
 * neighbours: every bulge clips a neighbour's margin, and a plain count would tie with the straight line through the hub). */
export const ROUTE_BODY_COST = 8;
/** The best-effort sweep's bulge grows by this factor per step (24, 30, 37, 47, …). */
export const ROUTE_SWEEP_GROWTH = 1.25;

export interface EdgeRoute {
  /** `M … L …` when straight, `M … Q … …` when curved. */
  d: string;
  start: Pt;
  end: Pt;
  /** Unit direction of travel at the end (the arrowhead's). */
  tangent: Pt;
  control: Pt | null;
  /** The curve at t = 0.5 (where the label sits). */
  mid: Pt;
  /** How many obstacles deflected the control point. */
  bends: number;
  /** The signed control offset along the segment normal (parallel offset + pushes); 0 when straight. */
  offset: number;
}

export interface Rect { x: number; y: number; hw: number; hh: number }

function inflated(p: Placed, m: number): Rect {
  return { x: p.x, y: p.y, hw: p.w / 2 + m, hh: p.h / 2 + m };
}

/** Liang–Barsky: does the segment p→q cross the rectangle? */
export function segmentHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  const dx = q.x - p.x, dy = q.y - p.y;
  let t0 = 0, t1 = 1;
  const clip = (pk: number, qk: number): boolean => {
    if (pk === 0) return qk >= 0;
    const t = qk / pk;
    if (pk < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, p.x - (r.x - r.hw)) && clip(dx, r.x + r.hw - p.x) && clip(-dy, p.y - (r.y - r.hh)) && clip(dy, r.y + r.hh - p.y);
}

function quad(p0: Pt, c: Pt, p2: Pt, t: number): Pt {
  const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), d = t * t;
  return { x: a * p0.x + b * c.x + d * p2.x, y: a * p0.y + b * c.y + d * p2.y };
}

/** Does the quadratic p0–c–p2, sampled as `ROUTE_SAMPLES` segments, cross the rectangle? (The hull box is a cheap no.) */
export function curveHitsRect(p0: Pt, c: Pt, p2: Pt, r: Rect): boolean {
  if (Math.min(p0.x, c.x, p2.x) > r.x + r.hw || Math.max(p0.x, c.x, p2.x) < r.x - r.hw || Math.min(p0.y, c.y, p2.y) > r.y + r.hh || Math.max(p0.y, c.y, p2.y) < r.y - r.hh) return false;
  let prev = p0;
  for (let i = 1; i <= ROUTE_SAMPLES; i++) {
    const next = quad(p0, c, p2, i / ROUTE_SAMPLES);
    if (segmentHitsRect(prev, next, r)) return true;
    prev = next;
  }
  return false;
}

/** A deterministic side (+1 / −1) for an obstacle sitting exactly on the segment, from the edge key. */
export function keySide(key: string): 1 | -1 {
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
  return sum % 2 === 1 ? 1 : -1;
}

/** Below this length (1.5 × the wider endpoint) an edge is drawn straight whatever it crosses. */
export function routeMinLength(from: Placed, to: Placed): number {
  return ROUTE_MIN_FACTOR * Math.max(from.h, to.h);
}

export interface EdgePathOptions {
  /** The edge key (the side tie-break). */
  key?: string;
  /** A perpendicular offset applied before avoidance (`parallelOffsets`). */
  offset?: number;
  /** Skip obstacle avoidance (the "straight" style). */
  avoid?: boolean;
  /** Render with exactly this control offset (an eased value): replaces `offset` and the obstacle pass. */
  controlOffset?: number;
  margin?: number;
}

/** The route of one edge: a quadratic Bézier from `from`'s border to `to`'s
 * border whose control point starts at the midpoint (shifted by `offset` for
 * parallel edges) and is pushed along the segment normal, away from every card
 * it would cross (inflated by `margin`), nearest first, in doubling steps then a
 * bisection, over up to `ROUTE_PASSES` passes and `ROUTE_MAX_PUSHES` pushes; when
 * that leaves crossings a sweep of both sides keeps the cheapest — a crossing
 * through a card's body costs `ROUTE_BODY_COST`, a graze of its margin 1, so a
 * hub ringed by its neighbours is bent around at the price of grazing a margin.
 * Deterministic for equal inputs. */
export function edgePath(from: Placed, to: Placed, obstacles: readonly Placed[], opts: EdgePathOptions = {}): EdgeRoute {
  const m = opts.margin ?? ROUTE_MARGIN;
  const dx = to.x - from.x, dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L === 0) return { d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, start: { x: from.x, y: from.y }, end: { x: to.x, y: to.y }, tangent: { x: 1, y: 0 }, control: null, mid: { x: from.x, y: from.y }, bends: 0, offset: 0 };
  const u = { x: dx / L, y: dy / L }, n = { x: -u.y, y: u.x };
  const M = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const curveOf = (off: number) => {
    const c = { x: M.x + n.x * off, y: M.y + n.y * off };
    return { c, p0: arrowEnd(c, from, from.w, from.h, 2), p2: arrowEnd(c, to, to.w, to.h, 2) };
  };
  let offset = opts.controlOffset ?? opts.offset ?? 0;
  let bends = 0;
  if (opts.controlOffset === undefined && opts.avoid !== false && L >= routeMinLength(from, to)) {
    const reach = (ROUTE_MAX_RATIO * L) / 2 + Math.abs(offset) / 2 + m;
    const minX = Math.min(from.x, to.x) - reach, maxX = Math.max(from.x, to.x) + reach;
    const minY = Math.min(from.y, to.y) - reach, maxY = Math.max(from.y, to.y) + reach;
    const near = obstacles
      .filter((o) => o.id !== from.id && o.id !== to.id && o.x + o.w / 2 >= minX && o.x - o.w / 2 <= maxX && o.y + o.h / 2 >= minY && o.y - o.h / 2 <= maxY)
      .map((o) => ({ r: inflated(o, m), body: inflated(o, 0), d: Math.abs((o.x - from.x) * n.x + (o.y - from.y) * n.y) + Math.max(0, Math.abs((o.x - M.x) * u.x + (o.y - M.y) * u.y) - L / 2) }))
      .sort((a, b) => a.d - b.d);
    const rects = near.map((x) => x.r);
    /** The cost of a route at `off`: `ROUTE_BODY_COST` per card body it crosses, 1 per margin it only grazes; counting stops at `limit`. */
    const violations = (off: number, limit = Infinity): number => {
      const { c, p0, p2 } = curveOf(off);
      let v = 0;
      for (const o of near) {
        if (!curveHitsRect(p0, c, p2, o.r)) continue;
        v += curveHitsRect(p0, c, p2, o.body) ? ROUTE_BODY_COST : 1;
        if (v >= limit) break;
      }
      return v;
    };
    let best = { off: offset, v: violations(offset) };
    const cap = ROUTE_MAX_RATIO * L;
    outer: for (let pass = 0; pass < ROUTE_PASSES && best.v > 0 && bends < ROUTE_MAX_PUSHES; pass++) {
      let changed = false;
      for (const r of rects) {
        if (bends >= ROUTE_MAX_PUSHES) break;
        const cur = curveOf(offset);
        if (!curveHitsRect(cur.p0, cur.c, cur.p2, r)) continue;
        const sideOf = (r.x - M.x) * n.x + (r.y - M.y) * n.y;
        const side = Math.abs(sideOf) < 1e-6 ? keySide(opts.key ?? "") : sideOf > 0 ? 1 : -1;
        const hits = (off: number): boolean => { const k = curveOf(off); return curveHitsRect(k.p0, k.c, k.p2, r); };
        let lo = offset, hi = offset, step = ROUTE_STEP, cleared = false;
        while (Math.abs(hi - side * step) <= cap) {
          lo = hi;
          hi -= side * step;
          if (!hits(hi)) { cleared = true; break; }
          step *= 2;
        }
        if (!cleared) continue;
        for (let i = 0; i < 4; i++) {
          const midOff = (lo + hi) / 2;
          if (hits(midOff)) lo = midOff; else hi = midOff;
        }
        offset = Math.round(hi);
        bends++;
        changed = true;
        const v = violations(offset, best.v);
        if (v < best.v) best = { off: offset, v };
        if (v === 0) break outer;
      }
      if (!changed) break;
    }
    if (best.v > 0) {
      for (let off = ROUTE_STEP * 2; off <= cap && best.v > 0; off *= ROUTE_SWEEP_GROWTH) {
        for (const signed of keySide(opts.key ?? "") > 0 ? [off, -off] : [-off, off]) {
          const v = violations(signed, best.v);
          if (v < best.v) best = { off: signed, v };
          if (v === 0) break;
        }
      }
    }
    offset = best.off;
  }
  const { c, p0, p2 } = curveOf(offset);
  if (offset === 0) {
    const len = Math.hypot(p2.x - p0.x, p2.y - p0.y) || 1;
    return { d: `M ${p0.x} ${p0.y} L ${p2.x} ${p2.y}`, start: p0, end: p2, tangent: { x: (p2.x - p0.x) / len, y: (p2.y - p0.y) / len }, control: null, mid: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 }, bends, offset: 0 };
  }
  const tl = Math.hypot(p2.x - c.x, p2.y - c.y) || 1;
  return { d: `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`, start: p0, end: p2, tangent: { x: (p2.x - c.x) / tl, y: (p2.y - c.y) / tl }, control: c, mid: quad(p0, c, p2, 0.5), bends, offset };
}

/** The point halfway along a polyline (by length); null for no points. */
export function polylineMidpoint(pts: readonly Pt[]): Pt | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0]!;
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y); lens.push(l); total += l; }
  let remaining = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = lens[i - 1]!;
    if (remaining <= l) {
      const t = l === 0 ? 0 : remaining / l;
      return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t };
    }
    remaining -= l;
  }
  return pts[pts.length - 1]!;
}

/** An externally routed edge (a `fixed` layout's bend points — elk's orthogonal
 * routes) as an `EdgeRoute`: `M … L …` through every point, the arrowhead along
 * the last segment, the label at the polyline's midpoint. Null for fewer than two points. */
export function polylineRoute(pts: readonly Pt[]): EdgeRoute | null {
  if (pts.length < 2) return null;
  const start = pts[0]!, end = pts[pts.length - 1]!;
  let prev = pts[pts.length - 2]!;
  for (let i = pts.length - 2; i >= 0 && prev.x === end.x && prev.y === end.y; i--) prev = pts[i]!;
  const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
  return {
    d: `M ${start.x} ${start.y}${pts.slice(1).map((p) => ` L ${p.x} ${p.y}`).join("")}`,
    start, end,
    tangent: { x: (end.x - prev.x) / len, y: (end.y - prev.y) / len },
    control: null,
    mid: polylineMidpoint(pts) ?? start,
    bends: Math.max(0, pts.length - 2),
    offset: 0,
  };
}

/** The route drawn with a given (eased) control offset — no obstacle pass. */
export function pathFromOffset(from: Placed, to: Placed, offset: number): EdgeRoute {
  return edgePath(from, to, [], { controlOffset: offset });
}

/** How many cards (inflated by `margin`, the endpoints excluded) a route still crosses. */
export function routeViolations(route: EdgeRoute, from: Placed, to: Placed, obstacles: readonly Placed[], m = ROUTE_MARGIN): number {
  const c = route.control ?? { x: (route.start.x + route.end.x) / 2, y: (route.start.y + route.end.y) / 2 };
  let v = 0;
  for (const o of obstacles) {
    if (o.id === from.id || o.id === to.id) continue;
    if (curveHitsRect(route.start, c, route.end, inflated(o, m))) v++;
  }
  return v;
}

/** Perpendicular offsets that fan the edges of one node pair apart (either direction is the same pair): centred multiples of `PARALLEL_GAP`, in key order, in each edge's own frame. */
export function parallelOffsets(edges: readonly { key: string; from: string; to: string }[]): Map<string, number> {
  const groups = new Map<string, { key: string; from: string; to: string }[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const pair = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`;
    const g = groups.get(pair) ?? [];
    g.push(e);
    groups.set(pair, g);
  }
  const out = new Map<string, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    g.forEach((e, i) => {
      const canonical = (i - (g.length - 1) / 2) * PARALLEL_GAP;
      out.set(e.key, e.from < e.to ? canonical : -canonical);
    });
  }
  return out;
}

/** The arrowhead at a route's end as a closed path, aligned with the end tangent. */
export function arrowheadPath(end: Pt, tangent: Pt, length = 9, half = 4): string {
  const bx = end.x - tangent.x * length, by = end.y - tangent.y * length;
  const nx = -tangent.y * half, ny = tangent.x * half;
  return `M ${end.x} ${end.y} L ${bx + nx} ${by + ny} L ${bx - nx} ${by - ny} Z`;
}

// ---- temporal smoothing of the control offsets ---------------------------------------------------

export const EASE_TAU = 150;
export const EASE_SNAP = 0.5;
export const EASE_MAX_DT = 50;

/** One exponential step of `current` toward `target` over `dt` ms (clamped to `EASE_MAX_DT`), snapping within `snap`. */
export function easeToward(current: number, target: number, dt: number, tau = EASE_TAU, snap = EASE_SNAP): number {
  const t = Math.min(Math.max(dt, 0), EASE_MAX_DT);
  const next = current + (target - current) * (1 - Math.exp(-t / tau));
  return Math.abs(target - next) < snap ? target : next;
}

/** The rendered control offset of every edge, eased toward each frame's target so a changed push glides (through a straight line when the side flips). */
export class EdgeEaser {
  private readonly rendered = new Map<string, number>();
  private readonly tau: number;

  constructor(tau = EASE_TAU) {
    this.tau = tau;
  }

  /** Ease every key toward its target over `dt` ms; a new key starts at its target, absent keys are dropped. */
  step(targets: ReadonlyMap<string, number>, dt: number): Map<string, number> {
    for (const k of [...this.rendered.keys()]) if (!targets.has(k)) this.rendered.delete(k);
    for (const [k, target] of targets) {
      const cur = this.rendered.get(k);
      this.rendered.set(k, cur === undefined ? target : easeToward(cur, target, dt, this.tau));
    }
    return new Map(this.rendered);
  }

  /** Jump every key to its target (reduced motion). */
  snap(targets: ReadonlyMap<string, number>): Map<string, number> {
    this.rendered.clear();
    for (const [k, v] of targets) this.rendered.set(k, v);
    return new Map(this.rendered);
  }

  settled(targets: ReadonlyMap<string, number>): boolean {
    for (const [k, v] of targets) if (this.rendered.get(k) !== v) return false;
    return true;
  }

  get size(): number {
    return this.rendered.size;
  }
}

// ---- the force layout's numbers -------------------------------------------------------------------

export interface ForceConfig {
  /** Per-node pull toward the origin (`forceX(0)`/`forceY(0)`): weak, so pinned hubs at the edge do not drag free nodes away — never `forceCenter`. */
  gravity: { x: number; y: number; strength: number };
  /** `forceLink`: an explicit strength (d3's default `1/min(degree)` vanishes on a hub) and rest length. */
  link: { distance: number; strength: number };
  /** `forceManyBody`: moderate, short-range repulsion. */
  charge: { strength: number; distanceMax: number; theta: number };
  /** `forceCollide`: `cardRadius(w, h, margin)` per node. */
  collide: { margin: number; strength: number };
  alphaDecay: number;
  velocityDecay: number;
  /** The reheat after a pin / unpin / structural change. */
  reheatAlpha: number;
}

/** The layout's constants. A star of one pinned hub and 15 leaves settles in a ring around the hub wherever it is pinned (checked against d3-force). */
export function forceConfig(): ForceConfig {
  return {
    gravity: { x: 0, y: 0, strength: 0.04 },
    link: { distance: 100, strength: 0.8 },
    charge: { strength: -220, distanceMax: 350, theta: 0.9 },
    collide: { margin: 8, strength: 0.8 },
    alphaDecay: 0.02,
    velocityDecay: 0.35,
    reheatAlpha: 0.5,
  };
}
