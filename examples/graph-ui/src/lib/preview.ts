// Edge-edit preview — the pure half of "what would a ⌘-click do right now".
// <oqx-graph> tracks whether the modifier is held and what the pointer is over;
// this module turns that state into the one edge to preview (or none), so the
// decision is unit-testable without a DOM.
//
//   previewFor(state) → { kind: "add" | "remove", rel, owner, target, via } | null
//
//   kind    "add" when the edge is not drawn (a click would write it),
//           "remove" when it is (a click would delete it).
//   owner   the document whose frontmatter field stores the edge — the edge's
//           source as drawn (ownerFor(direction) decides; never the inverse).
//   target  the document the owner's field refers to — the edge's destination.
//   via     "node": the pointer is over a node other than the selected one and a
//           relationship is armed; "edge": the pointer is over a drawn edge of a
//           writable relationship (always a removal, matching ⌘-click on an edge).
//
// Nothing is previewed without the modifier, over the selected node itself, or
// over empty canvas. A hovered node wins over a hovered edge (nodes are drawn on
// top, so both being set at once would be a stale hover).

import type { Direction } from "./candidates.ts";
import type { GraphEdge } from "./edges.ts";
import { ownerFor } from "./edit.ts";

export type PreviewKind = "add" | "remove";

export interface EdgePreview<N> {
  kind: PreviewKind;
  rel: string;
  owner: N;
  target: N;
  via: "node" | "edge";
}

export interface PreviewState<N extends { path: string }> {
  /** The platform modifier (⌘ / Ctrl) is held right now. */
  modifier: boolean;
  /** Every shown node (owner/target are picked from here). */
  nodes: readonly N[];
  /** Path of the selected node, if any. */
  selected: string | null;
  /** The relationship armed for editing, if any. */
  armed: { name: string; defaults: { direction: Direction } } | null;
  /** Path of the node under the pointer, if any. */
  hovered: string | null;
  /** The drawn edge under the pointer, if any. */
  hoveredEdge: GraphEdge | null;
  /** Relationships whose drawn edges may be ⌘-clicked away. */
  writable: readonly string[];
  /** The edges drawn right now. */
  edges: readonly GraphEdge[];
}

export function isDrawn(edges: readonly GraphEdge[], rel: string, src: string, dst: string): boolean {
  return edges.some((e) => e.rel === rel && e.src === src && e.dst === dst);
}

export function previewFor<N extends { path: string }>(s: PreviewState<N>): EdgePreview<N> | null {
  if (!s.modifier) return null;
  const byPath = (p: string | null): N | undefined => (p === null ? undefined : s.nodes.find((n) => n.path === p));
  if (s.hovered !== null) {
    const selected = byPath(s.selected);
    const hovered = byPath(s.hovered);
    if (!s.armed || !selected || !hovered || selected.path === hovered.path) return null;
    const { owner, other } = ownerFor(s.armed.defaults.direction, selected, hovered);
    const present = isDrawn(s.edges, s.armed.name, owner.path, other.path);
    return { kind: present ? "remove" : "add", rel: s.armed.name, owner, target: other, via: "node" };
  }
  if (s.hoveredEdge && s.writable.includes(s.hoveredEdge.rel)) {
    const owner = byPath(s.hoveredEdge.src);
    const target = byPath(s.hoveredEdge.dst);
    if (!owner || !target) return null;
    return { kind: "remove", rel: s.hoveredEdge.rel, owner, target, via: "edge" };
  }
  return null;
}

// ---- the modifier -----------------------------------------------------------------

/** The predicate every ⌘/Ctrl gesture in the graph shares: either key counts, so a
 * Mac user with Ctrl and a Linux user with Meta both get the same behaviour. */
export function modified(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/** Is this `KeyboardEvent.key` one of the modifier keys `modified` listens for? */
export function isModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control";
}

/** How the UI names the modifier: ⌘ on Apple platforms, Ctrl elsewhere. */
export function modifierName(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

// ---- geometry for the label ------------------------------------------------------

export interface Pt { x: number; y: number }

/** The point halfway along a polyline (by length), for the preview's label. */
export function midpoint(pts: readonly Pt[]): Pt | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0]!;
  let total = 0;
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    lens.push(l);
    total += l;
  }
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
