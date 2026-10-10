// Pan / zoom math for <oqx-graph> — pure, so the two invariants are testable:
// zooming about a point leaves the content under that point where it is, and a
// drag moves the content exactly as far as the pointer.
//
// Coordinate spaces, outermost first:
//   client px   — e.clientX / e.clientY; the SVG's own origin is its
//                 getBoundingClientRect() corner (never raw clientX or pageX).
//   viewBox     — the SVG's user units. The element has `viewBox="0 0 W H"`
//                 with `preserveAspectRatio="xMidYMid meet"`, so the browser
//                 maps viewBox → client with one uniform scale `s` and a
//                 centring offset (`viewBoxMapping`). Pointer positions and drag
//                 deltas have to pass through this mapping, or a drag runs at
//                 the wrong rate whenever the picture is not drawn 1:1.
//   content     — the laid-out graph. One `<g transform="translate(x y) scale(k)">`
//                 maps content → viewBox: v = t + k·c (translate applied after
//                 the scale, so x/y are viewBox units and a pan adds viewBox
//                 deltas without dividing by k).

export interface Transform { x: number; y: number; k: number }
export interface Point { x: number; y: number }

export interface ViewBoxMapping {
  /** viewBox units → client px. */
  s: number;
  /** The viewBox origin in client px (relative to the SVG's rect). */
  ox: number;
  oy: number;
}

export const IDENTITY: Transform = { x: 0, y: 0, k: 1 };
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;

/** `xMidYMid meet`: the uniform scale that fits the viewBox, centred. Degenerate sizes map 1:1. */
export function viewBoxMapping(clientW: number, clientH: number, vbW: number, vbH: number): ViewBoxMapping {
  if (!(clientW > 0) || !(clientH > 0) || !(vbW > 0) || !(vbH > 0)) return { s: 1, ox: 0, oy: 0 };
  const s = Math.min(clientW / vbW, clientH / vbH);
  return { s, ox: (clientW - vbW * s) / 2, oy: (clientH - vbH * s) / 2 };
}

/** A pointer position (client px relative to the SVG's rect) in viewBox units. */
export function toViewBox(px: number, py: number, m: ViewBoxMapping): Point {
  return { x: (px - m.ox) / m.s, y: (py - m.oy) / m.s };
}

/** Where a content point lands in the viewBox under `t`. */
export function contentToViewBox(t: Transform, c: Point): Point {
  return { x: t.x + t.k * c.x, y: t.y + t.k * c.y };
}

/** The content point under a viewBox point. */
export function viewBoxToContent(t: Transform, v: Point): Point {
  return { x: (v.x - t.x) / t.k, y: (v.y - t.y) / t.k };
}

/** Scale by `factor` about `p` (viewBox units): the content under `p` stays under `p`. */
export function zoomAbout(t: Transform, factor: number, p: Point, min = MIN_SCALE, max = MAX_SCALE): Transform {
  const k = Math.min(max, Math.max(min, t.k * factor));
  const r = k / t.k;
  return { k, x: p.x - (p.x - t.x) * r, y: p.y - (p.y - t.y) * r };
}

/** Pan by a pointer delta given in client px: converted to viewBox units, never divided by k. */
export function panBy(t: Transform, dxPx: number, dyPx: number, m: ViewBoxMapping): Transform {
  return { ...t, x: t.x + dxPx / m.s, y: t.y + dyPx / m.s };
}

/** A wheel event's vertical delta in px whatever its `deltaMode` (0 px, 1 lines, 2 pages). */
export function wheelDeltaPx(e: { deltaY: number; deltaMode: number }, lineHeight = 16, pageHeight = 800): number {
  if (e.deltaMode === 1) return e.deltaY * lineHeight;
  if (e.deltaMode === 2) return e.deltaY * pageHeight;
  return e.deltaY;
}

/** The zoom factor for a wheel delta: smooth, symmetric (−d undoes +d). */
export function zoomFactor(deltaPx: number): number {
  return Math.exp(-deltaPx * 0.001);
}
