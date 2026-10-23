// How a node card fits its label — the pure half. Three modes:
//
//   truncate  one line, ellipsis, the width lib/cards.ts estimates (the original
//             behaviour, and the default, so saved views do not jump);
//   wrap      the label wraps onto several lines within the card's width (the
//             measured one-line width, capped at `CARD.maxWidth` as before); the
//             card grows by a line each, up to `maxLines`, then the last line
//             ends in an ellipsis;
//   expand    the card widens to fit the whole label on one line, up to
//             `expandMaxWidth`, and wraps (as above) past that.
//
// The shown `key: value` lines keep their one-line treatment from lib/cards.ts;
// only the label changes shape. Widths are MEASURED through an injected
// `measure(text) → px` — in the browser a canvas `measureText` with the card's
// label font (`canvasMeasure`, cached per string), in tests a fixed width per
// character — so the wrapping is a unit-testable function and the SVG draws
// exactly the lines the layout was sized for.

import { CARD, type Card } from "./cards.ts";

export type LabelFit = "truncate" | "wrap" | "expand";
export const LABEL_FITS: readonly LabelFit[] = ["truncate", "wrap", "expand"];
export const DEFAULT_LABEL_FIT: LabelFit = "truncate";

export function isLabelFit(v: unknown): v is LabelFit {
  return typeof v === "string" && (LABEL_FITS as readonly string[]).includes(v);
}

/** The width of `text` in px, in the card's label font. */
export type Measure = (text: string) => number;

export const LABEL_FIT = {
  /** Lines a wrapped label may take before the ellipsis. */
  maxLines: 4,
  /** The widest an `expand` card grows before its label wraps. */
  expandMaxWidth: 480,
  /** Baseline to baseline between label lines (12px font). */
  lineHeight: 15,
  /** The label font — the same string as the element's `.node text` rule, so a
   * canvas measures what the SVG draws. */
  font: "12px system-ui, sans-serif",
} as const;

export const ELLIPSIS = "…";

/** A measure for tests and for environments without a canvas: `perChar` px a character. */
export function fixedMeasure(perChar: number): Measure {
  return (text) => text.length * perChar;
}

/** A canvas `measureText` in `font`, memoised per string (a graph re-measures
 * the same labels on every recompute). Falls back to the per-character
 * estimate lib/cards.ts uses when no canvas is available. */
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
  // Binary search over the prefix length: measure is monotone in the prefix.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join("") + suffix) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + suffix;
}

/** Break one over-long word into pieces that each measure within `maxWidth`
 * (at least one character a piece, so the loop always advances). */
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

/** Greedy word wrap of `text` to `maxWidth` px: words (split on whitespace) are
 * packed onto a line while they fit; a word wider than the line is broken by
 * characters. At most `maxLines` lines are returned; when the text does not
 * fit them, the last line is clipped to end in `…` (honestly — the ellipsis
 * itself is measured in). An empty text is one empty line. */
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
  // Over the cap: the last allowed line carries as much of the rest as fits
  // and ends in an ellipsis — measured in, so the line never overflows.
  const kept = lines.slice(0, limit);
  kept[limit - 1] = clipTo(lines.slice(limit - 1).join(" "), maxWidthPx, measure, ELLIPSIS);
  return kept;
}

export interface CardSize {
  width: number;
  height: number;
  /** The label as drawn, one entry per `<tspan>` line. */
  lines: string[];
}

/** The room for the label inside a card of `width`. */
export function labelRoom(width: number): number {
  return Math.max(1, width - 2 * CARD.padX);
}

/** The card's size under a label fit. `card` is lib/cards.ts `cardFor`'s card:
 * its `width` is the estimated one-line width (bounded by `CARD.maxWidth`),
 * its `height` the one-line-label height, its `lines` the shown fields. */
export function cardSize(card: Card, mode: LabelFit, measure: Measure): CardSize {
  if (mode === "truncate") return { width: card.width, height: card.height, lines: [card.label] };
  // The width the whole label would take on one line, bounded by the mode's cap:
  // `wrap` keeps lib/cards.ts's cap (the card stays as wide as a truncated one —
  // measured rather than estimated, so a label that fits gets its one line), `expand` the wider one.
  const cap = mode === "expand" ? LABEL_FIT.expandMaxWidth : CARD.maxWidth;
  const wanted = Math.ceil(measure(card.labelFull) + 2 * CARD.padX);
  const width = Math.max(card.width, Math.min(cap, wanted));
  const lines = wrapLabel(card.labelFull, labelRoom(width), measure);
  return { width, height: card.height + (lines.length - 1) * LABEL_FIT.lineHeight, lines };
}
