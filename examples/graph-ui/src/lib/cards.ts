// Node cards — the pure half. What a card says (the label line and one
// `key: value` line per shown field), how values are rendered compactly, and
// how big the card is, so the layouts (elk / force) place cards of the size
// that is drawn and edges attach to the card border.
//
// Values: strings as they are (newlines collapsed), numbers and booleans as
// text, arrays as `a, b, c` (records inside as `{…}`), a list of records (a
// nested block) as `n items`, a record as `{…}`, absent as `—`. Long text is
// truncated with `…` to the card's width; the full text is kept for the tooltip.

import type { ProjectionChoice } from "./projection.ts";

export interface CardLine {
  key: string;
  /** The value as drawn (fitted to the card). */
  text: string;
  /** The value in full (for the tooltip). */
  full: string;
}

export interface Card {
  /** The title line as drawn. */
  label: string;
  labelFull: string;
  lines: CardLine[];
  width: number;
  height: number;
}

export interface CardInput {
  /** The fallback label when no label field is chosen or the row lacks it (the de-rooted path). */
  label: string;
  row: Record<string, unknown>;
}

/** Geometry (SVG user units ≈ CSS px at scale 1). */
export const CARD = {
  minWidth: 60,
  maxWidth: 260,
  padX: 9,
  /** A label-only card — the original node size. */
  baseHeight: 30,
  /** Each `key: value` line. */
  lineHeight: 15,
  /** Average glyph widths at the two font sizes (12px label, 11px lines). */
  labelCharWidth: 7,
  lineCharWidth: 6.2,
  /** The longest text kept for a tooltip. */
  tooltipChars: 240,
} as const;

/** A value rendered compactly, on one line. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.replace(/\s*\n\s*/g, " ⏎ ").trim();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    return v.map((x) => (x !== null && typeof x === "object" ? (Array.isArray(x) ? "[…]" : "{…}") : formatValue(x))).join(", ");
  }
  if (typeof v === "object") return "{…}";
  return String(v);
}

/** The value for a tooltip: scalars and flat arrays as drawn, structures as
 * one-line JSON, everything capped at `CARD.tooltipChars`. */
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

/** How many label / line glyphs fit a card of `width`. */
export function fitChars(width: number, charWidth: number): number {
  return Math.max(4, Math.floor((width - 2 * CARD.padX + 4) / charWidth));
}

/** The width that fits the longest text, within the bounds. */
export function cardWidth(labelChars: number, lineChars: number): number {
  const wanted = Math.max(2 * CARD.padX + labelChars * CARD.labelCharWidth, 2 * CARD.padX + lineChars * CARD.lineCharWidth);
  return Math.max(CARD.minWidth, Math.min(CARD.maxWidth, Math.ceil(wanted)));
}

export function cardHeight(lines: number): number {
  return CARD.baseHeight + lines * CARD.lineHeight;
}

/** The radius of the circle that covers a card of `width × height` plus a
 * margin — what the force layout's collision keeps apart, so two cards never
 * overlap whatever their aspect. */
export function cardRadius(width: number, height: number, margin = 12): number {
  return Math.hypot(width, height) / 2 + margin;
}

/** The card for one node under a projection choice: the label field's value
 * (else the fallback) on top, then one line per shown field other than the label. */
export function cardFor(node: CardInput, choice: ProjectionChoice): Card {
  const labelValue = choice.label === null ? undefined : node.row[choice.label];
  const labelFull = labelValue === undefined || labelValue === null ? node.label : formatValue(labelValue);
  const keys = choice.shown.filter((k) => k !== choice.label);
  const fulls = keys.map((key) => ({ key, full: formatFull(node.row[key]), text: formatValue(node.row[key]) }));
  const width = cardWidth(labelFull.length, Math.max(0, ...fulls.map((l) => l.key.length + 2 + l.text.length)));
  const lineChars = fitChars(width, CARD.lineCharWidth);
  const lines: CardLine[] = fulls.map((l) => ({
    key: l.key,
    // Keep the key whole; truncate the value to what remains of the line.
    text: truncate(l.text, Math.max(1, lineChars - l.key.length - 2)),
    full: l.full,
  }));
  return { label: truncate(labelFull, fitChars(width, CARD.labelCharWidth)), labelFull, lines, width, height: cardHeight(lines.length) };
}

/** The tooltip text: the path, then every shown field in full. */
export function cardTooltip(path: string, card: Card, choice: ProjectionChoice): string {
  const head = choice.label !== null && card.labelFull !== path ? `${path}\n${choice.label}: ${card.labelFull}` : path;
  return [head, ...card.lines.map((l) => `${l.key}: ${l.full}`)].join("\n");
}
