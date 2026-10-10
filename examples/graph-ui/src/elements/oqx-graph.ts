// <oqx-graph>: the query hits as node cards, the view's relationships as edges.
// Fetches edges through the provided `fetchEdges` (the page wires it to the
// MCP `query` tool — this element never talks to a server itself), lays the
// graph out with elkjs along the axis (direction honoured, cycles reported in a
// banner) or with d3-force when there is no axis, and renders SVG.
//
// Cards: `view.projection` says which projected field is the title line (null =
// the node's fallback label, the de-rooted path) and which fields are listed
// under it as `key: value` lines (lib/cards.ts formats values compactly and
// sizes the card); the layout runs over the card sizes, so a projection change
// recomputes the layout and edges keep attaching to the card border.
//
// Pan / zoom: one `<g transform="translate(x y) scale(k)">`; the pointer is read
// in the SVG's own rect and mapped through the viewBox (lib/viewport.ts), so a
// wheel zooms about the pointer and a drag — pointer-captured, so it survives
// leaving the element — moves the picture exactly as far as the pointer;
// double-click resets the view.
//
//   properties: nodes (GraphNode[] — `label` is the fallback title line, `row` the projected row),
//               view (View — edges, layout, projection), candidates (Candidate[]),
//               fetchEdges ((candidate, paths) => Promise<GraphEdge[]>), selected (path | null),
//               armed (Candidate | null — the relationship being edited),
//               writable (string[] — relationships whose drawn edges can be ⌘-clicked away),
//               pending (PendingEdge[] — optimistic adds/removes, drawn dashed)
//   events:     node-select  detail: { node: GraphNode | null }
//               edge-toggle  detail: { candidate, from: GraphNode, to: GraphNode, present: boolean }
//                            — ⌘-click (Ctrl-click) on a node with a selection and an armed
//                            relationship, or on a drawn edge of a writable relationship.
//                            `from` is the OWNER (the document whose field stores the edge),
//                            `to` the document it refers to; `present` says whether the edge
//                            is drawn right now. The element never writes anything itself.
//               graph-state  detail: GraphStateDetail (edges drawn, cycles, layout kind, busy, error)
//
// Edit mode: while the modifier is held (tracked on window: keydown/keyup, and
// mousemove's metaKey/ctrlKey so a key pressed before the pointer arrived counts;
// reset on blur / hidden) with a selection and an armed relationship, nodes get a
// crosshair, the selected node a "source" ring, the banner says what a click
// does, and hovering another node draws a PREVIEW of the toggle (lib/preview.ts
// decides: add = accent dashed marching line, remove = the drawn edge overlaid in
// the danger colour with a "remove" label). Hovering a writable edge with the
// modifier previews its removal too. Pending (in-flight) edges keep their own,
// static dashed style; a small legend names the three while in edit mode.

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import ELK from "elkjs/lib/elk.bundled.js";
import type { Candidate } from "../lib/candidates.ts";
import type { GraphEdge } from "../lib/edges.ts";
import { sequenceEdges } from "../lib/edges.ts";
import { ownerFor } from "../lib/edit.ts";
import { buildElkGraph, elkEdgeId, findCycles, readElkLayout, type Point, type Positioned } from "../lib/layout-elk.ts";
import { forceLayout } from "../lib/layout-force.ts";
import { isDrawn, midpoint, modified, modifierName, previewFor, type EdgePreview } from "../lib/preview.ts";
import { NO_PROJECTION, type View } from "../lib/view.ts";
import { cardFor, cardTooltip, type Card } from "../lib/cards.ts";
import { IDENTITY, panBy, toViewBox, viewBoxMapping, wheelDeltaPx, zoomAbout, zoomFactor, type Transform, type ViewBoxMapping } from "../lib/viewport.ts";
import { relationColor } from "./oqx-relationship-picker.ts";

export interface GraphNode {
  id: string;
  path: string;
  /** The fallback title line (the de-rooted path) when the projection names no label field or the row lacks it. */
  label: string;
  /** The whole projected row — the cards read their fields from it. */
  row: Record<string, unknown>;
}

export type EdgeFetcher = (candidate: Candidate, paths: string[]) => Promise<GraphEdge[]>;

export interface GraphStateDetail {
  edges: number;
  cycles: string[][];
  layout: "elk" | "force" | null;
  busy: boolean;
  error: string | null;
}

export interface EdgeToggleDetail {
  candidate: Candidate;
  from: GraphNode;
  to: GraphNode;
  present: boolean;
}

/** An optimistic edge: drawn dashed while its write is in flight. */
export interface PendingEdge extends GraphEdge {
  action: "add" | "remove";
}

export function edgeKey(e: Pick<GraphEdge, "src" | "dst" | "rel">): string {
  return `${e.rel} ${e.src}→${e.dst}`;
}

const EMPTY_VIEW: View = { edges: [], layout: { axis: null, direction: "forward" }, projection: NO_PROJECTION };
const elk = new ELK();

@customElement("oqx-graph")
export class OqxGraph extends LitElement {
  static override styles = css`
    :host { display: block; position: relative; min-height: 320px; background: #fafbfc; border: 1px solid #d0d4dc; border-radius: 6px; overflow: hidden; font: 12px system-ui, sans-serif; }
    svg { display: block; width: 100%; height: 100%; min-height: 320px; cursor: grab; user-select: none; }
    svg.dragging { cursor: grabbing; }
    .node rect { fill: #fff; stroke: #8a94a6; stroke-width: 1; rx: 5; }
    .node text { font: 12px system-ui, sans-serif; fill: #1e2430; pointer-events: none; }
    .node text.line { font-size: 11px; fill: #3a4250; }
    .node text.line .key { fill: #7a8290; }
    .node .rule { stroke: #e3e6ec; stroke-width: 1; }
    .node:hover rect { stroke: #1565c0; stroke-width: 1.5; }
    .node.selected rect { fill: #e3f2fd; stroke: #1565c0; stroke-width: 2; }
    .node.cycle rect { stroke: #c62828; stroke-dasharray: 4 2; }
    .node.dim { opacity: 0.35; }
    .edge { fill: none; stroke-width: 1.4; opacity: 0.85; }
    .edge.axis { stroke-width: 2; }
    .edge.dim { opacity: 0.12; }
    .edge.lit { stroke-width: 2.6; opacity: 1; }
    .edge.pending { stroke-dasharray: 6 4; opacity: 0.9; }
    .edge.removing { stroke-dasharray: 3 5; opacity: 0.35; }
    .hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; }
    g.edge-g.writable:hover .edge { stroke-width: 2.6; opacity: 1; }
    .node { cursor: pointer; }
    /* edit mode: the modifier is held with a selection and an armed relationship */
    svg.editmode .node, svg.modifier g.edge-g.writable { cursor: crosshair; }
    .node.target rect { stroke: #ef6c00; stroke-dasharray: 5 3; }
    .node.source rect { stroke: #1565c0; stroke-width: 2; }
    .node.source .ring { fill: none; stroke: #1565c0; stroke-width: 1.5; stroke-dasharray: 4 3; opacity: 0.8; animation: march 0.8s linear infinite; }
    /* the preview: what a ⌘-click would do right now (never confused with pending —
       different colours, thicker, marching + pulsing, labelled) */
    .edge.preview { stroke-width: 2.6; stroke-dasharray: 8 6; opacity: 1; pointer-events: none; animation: march 0.5s linear infinite, pulse 1.1s ease-in-out infinite; }
    .edge.preview.add { stroke: #1565c0; }
    .edge.preview.remove { stroke: #c62828; }
    .preview-label { font: 600 11px system-ui, sans-serif; pointer-events: none; paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; animation: pulse 1.1s ease-in-out infinite; }
    .preview-label.add { fill: #1565c0; }
    .preview-label.remove { fill: #c62828; }
    @keyframes march { to { stroke-dashoffset: -28; } }
    @keyframes pulse { 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) {
      .edge.preview, .preview-label, .node.source .ring { animation: none; }
    }
    .banner { position: absolute; left: 8px; right: 8px; top: 8px; padding: 6px 10px; border-radius: 4px; background: #fff3e0; color: #7a4a00; border: 1px solid #ffcc80; }
    .banner code { font-family: ui-monospace, monospace; }
    .banner.edit { top: auto; bottom: 40px; background: #fff8e1; color: #6d4c00; border-color: #ffe082; }
    .banner.edit.active { background: #e3f2fd; color: #0d47a1; border-color: #64b5f6; font-weight: 500; }
    .banner.edit.active.remove { background: #ffebee; color: #b71c1c; border-color: #ef9a9a; }
    .banner.edit.hint { background: rgba(255,255,255,0.92); color: #5a6270; border-color: #e3e6ec; font-weight: normal; }
    .banner kbd { font: inherit; padding: 0 4px; border: 1px solid currentColor; border-radius: 3px; opacity: 0.8; }
    .overlay { position: absolute; right: 8px; bottom: 8px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); color: #5a6270; border: 1px solid #e3e6ec; }
    .error { position: absolute; left: 8px; right: 8px; bottom: 8px; padding: 6px 10px; border-radius: 4px; background: #fff5f5; color: #c62828; border: 1px solid #ef9a9a; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: #7a8290; }
    .legend { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); border: 1px solid #e3e6ec; }
    .legend i { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 4px; }
    /* the three edge styles, bottom-right while in edit mode (it takes the overlay's corner) */
    .legend.styles { left: auto; right: 8px; color: #5a6270; }
    .legend.styles i { height: 0; border-top: 2px dashed; }
    .legend.styles .add i { border-color: #1565c0; }
    .legend.styles .remove i { border-color: #c62828; }
    .legend.styles .pending i { border-color: #8a94a6; border-top-style: dotted; }
  `;

  @property({ attribute: false }) nodes: GraphNode[] = [];
  @property({ attribute: false }) view: View = EMPTY_VIEW;
  @property({ attribute: false }) candidates: Candidate[] = [];
  @property({ attribute: false }) fetchEdges: EdgeFetcher | null = null;
  @property() selected: string | null = null;
  @property({ attribute: false }) armed: Candidate | null = null;
  @property({ attribute: false }) writable: string[] = [];
  @property({ attribute: false }) pending: PendingEdge[] = [];

  @state() private edges: GraphEdge[] = [];
  @state() private positioned: Positioned | null = null;
  /** The cards as laid out (by path), from the nodes and `view.projection`. */
  @state() private cards: Map<string, Card> = new Map();
  @state() private cycles: string[][] = [];
  @state() private layoutKind: "elk" | "force" | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private hovered: string | null = null;
  @state() private hoveredEdge: GraphEdge | null = null;
  /** The platform modifier (⌘ / Ctrl) is held right now — see `trackModifier`. */
  @state() private modifier = false;
  @state() private transform: Transform = IDENTITY;

  private generation = 0;
  private edgeCache = new Map<string, Promise<GraphEdge[]>>();
  /** A drag in progress: the last pointer position (client px) — deltas accumulate from it. */
  private drag: { pointerId: number; x: number; y: number } | null = null;
  /** `@wheel` with `passive: false`, so `preventDefault` keeps the page from scrolling while zooming. */
  private readonly wheelListener = { handleEvent: (e: WheelEvent) => this.onWheel(e), passive: false };

  // ---- the modifier ---------------------------------------------------------------

  /** keydown/keyup carry the modifier state of every key event (a Meta keyup has
   * metaKey false), and mousemove carries it too, so a key pressed before the
   * pointer entered the window registers on the first move. */
  private readonly trackModifier = (e: KeyboardEvent | MouseEvent): void => {
    const held = modified(e);
    if (held !== this.modifier) this.modifier = held;
  };

  /** Keyups are lost when the window loses focus or the tab is hidden. */
  private readonly resetModifier = (): void => {
    if (document.visibilityState === "hidden" || !document.hasFocus()) this.modifier = false;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.trackModifier);
    window.addEventListener("keyup", this.trackModifier);
    window.addEventListener("mousemove", this.trackModifier);
    window.addEventListener("blur", this.resetModifier);
    document.addEventListener("visibilitychange", this.resetModifier);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.trackModifier);
    window.removeEventListener("keyup", this.trackModifier);
    window.removeEventListener("mousemove", this.trackModifier);
    window.removeEventListener("blur", this.resetModifier);
    document.removeEventListener("visibilitychange", this.resetModifier);
    this.modifier = false;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("nodes") || changed.has("view") || changed.has("candidates") || changed.has("fetchEdges")) {
      if (changed.has("nodes") || changed.has("fetchEdges")) this.edgeCache.clear();
      void this.recompute();
    }
  }

  private emitState(): void {
    this.dispatchEvent(new CustomEvent<GraphStateDetail>("graph-state", {
      detail: { edges: this.edges.length, cycles: this.cycles, layout: this.layoutKind, busy: this.busy, error: this.error },
      bubbles: true, composed: true,
    }));
  }

  /** Fetch the wanted relationships' edges, lay out, and publish — dropping the
   * result if a newer recompute started meanwhile. */
  private async recompute(): Promise<void> {
    const gen = ++this.generation;
    const nodes = this.nodes;
    const view = this.view;
    const paths = nodes.map((n) => n.path);
    const shown = new Set(paths);
    const wanted = new Set(view.edges);
    if (view.layout.axis) wanted.add(view.layout.axis);
    this.busy = true;
    this.error = null;
    this.emitState();
    try {
      const perRel = await Promise.all(
        [...wanted].map(async (name) => {
          const candidate = this.candidates.find((c) => c.name === name);
          if (!candidate || paths.length === 0) return [] as GraphEdge[];
          if (candidate.kind === "sequence") return sequenceEdges(name, paths);
          if (!this.fetchEdges) return [];
          const key = `${name} ${paths.join("")}`;
          let p = this.edgeCache.get(key);
          if (!p) {
            p = this.fetchEdges(candidate, paths);
            this.edgeCache.set(key, p);
          }
          return (await p).filter((e) => shown.has(e.src) && shown.has(e.dst));
        }),
      );
      if (gen !== this.generation) return;
      const all = perRel.flat();
      const cards = new Map(nodes.map((n) => [n.path, cardFor(n, view.projection)] as const));
      const layoutNodes = nodes.map((n) => { const c = cards.get(n.path)!; return { id: n.path, width: c.width, height: c.height }; });
      let positioned: Positioned;
      let cycles: string[][] = [];
      if (view.layout.axis) {
        const axisEdges = all.filter((e) => e.rel === view.layout.axis);
        cycles = findCycles(paths, axisEdges);
        const { graph } = buildElkGraph(layoutNodes, axisEdges, view.layout.direction);
        const laid = await elk.layout(graph);
        if (gen !== this.generation) return;
        positioned = readElkLayout(laid);
        this.layoutKind = "elk";
      } else {
        positioned = forceLayout(layoutNodes, all);
        this.layoutKind = "force";
      }
      this.edges = all.filter((e) => view.edges.includes(e.rel));
      this.cycles = cycles;
      this.cards = cards;
      this.positioned = positioned;
      this.transform = IDENTITY;
    } catch (e) {
      if (gen !== this.generation) return;
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.generation) {
        this.busy = false;
        this.emitState();
      }
    }
  }

  // ---- interaction ------------------------------------------------------------

  /** The SVG's rect and its viewBox → client mapping right now. */
  private mapping(): { rect: DOMRect; m: ViewBoxMapping } {
    const svgEl = this.renderRoot.querySelector("svg")!;
    const rect = svgEl.getBoundingClientRect();
    const pos = this.positioned;
    return { rect, m: viewBoxMapping(rect.width, rect.height, Math.max(pos?.width ?? 0, 10), Math.max(pos?.height ?? 0, 10)) };
  }

  /** Zoom about the pointer: the content under it stays under it. */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { rect, m } = this.mapping();
    const p = toViewBox(e.clientX - rect.left, e.clientY - rect.top, m);
    this.transform = zoomAbout(this.transform, zoomFactor(wheelDeltaPx(e)), p);
  }

  private onPointerDown(e: PointerEvent): void {
    if ((e.target as Element).closest(".node")) return;
    if (modified(e) && (e.target as Element).closest(".edge-g")) return;
    if (e.button !== 0) return;
    this.drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    const svgEl = e.currentTarget as Element;
    svgEl.classList.add("dragging");
    // Captured: the drag keeps moving at pointer rate when the pointer leaves the element.
    try { svgEl.setPointerCapture(e.pointerId); } catch { /* not a pointer that can be captured (synthetic) */ }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const { m } = this.mapping();
    this.transform = panBy(this.transform, e.clientX - this.drag.x, e.clientY - this.drag.y, m);
    this.drag = { ...this.drag, x: e.clientX, y: e.clientY };
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    const svgEl = e.currentTarget as Element;
    svgEl.classList.remove("dragging");
    if (svgEl.hasPointerCapture?.(e.pointerId)) svgEl.releasePointerCapture(e.pointerId);
  }

  /** Double-click on the canvas: back to the fitted view. */
  private onDoubleClick(e: MouseEvent): void {
    if ((e.target as Element).closest(".node, .edge-g")) return;
    this.transform = IDENTITY;
  }

  private select(node: GraphNode | null): void {
    this.selected = node?.path ?? null;
    this.dispatchEvent(new CustomEvent("node-select", { detail: { node }, bubbles: true, composed: true }));
  }

  private isDrawn(rel: string, src: string, dst: string): boolean {
    return isDrawn(this.edges, rel, src, dst);
  }

  /** The edge a ⌘-click would toggle right now, if the pointer is over one. */
  private preview(): EdgePreview<GraphNode> | null {
    return previewFor({
      modifier: this.modifier,
      nodes: this.nodes,
      selected: this.selected,
      armed: this.armed,
      hovered: this.hovered,
      hoveredEdge: this.hoveredEdge,
      writable: this.writable,
      edges: this.edges,
    });
  }

  private emitToggle(detail: EdgeToggleDetail): void {
    this.dispatchEvent(new CustomEvent<EdgeToggleDetail>("edge-toggle", { detail, bubbles: true, composed: true }));
  }

  /** A click on a node: plain → select; ⌘/Ctrl with a selection and an armed
   * relationship → toggle that relationship between the two (the candidate's
   * direction says which one owns the edge). */
  private onNodeClick(e: MouseEvent, node: GraphNode): void {
    if (!modified(e)) {
      this.select(this.selected === node.path ? null : node);
      return;
    }
    e.preventDefault();
    const selected = this.nodes.find((n) => n.path === this.selected);
    if (!this.armed || !selected || selected.path === node.path) return;
    const { owner, other } = ownerFor(this.armed.defaults.direction, selected, node);
    this.emitToggle({ candidate: this.armed, from: owner, to: other, present: this.isDrawn(this.armed.name, owner.path, other.path) });
  }

  /** ⌘/Ctrl-click on a drawn edge of a writable relationship removes it. */
  private onEdgeClick(e: MouseEvent, edge: GraphEdge): void {
    if (!modified(e) || !this.writable.includes(edge.rel)) return;
    e.preventDefault();
    e.stopPropagation();
    const candidate = this.candidates.find((c) => c.name === edge.rel);
    const from = this.nodes.find((n) => n.path === edge.src);
    const to = this.nodes.find((n) => n.path === edge.dst);
    if (!candidate || !from || !to) return;
    this.emitToggle({ candidate, from, to, present: true });
  }

  // ---- render -----------------------------------------------------------------

  /** Clip a straight segment to the node boxes so arrowheads land on borders. */
  private segment(e: GraphEdge): Point[] | null {
    const a = this.positioned?.nodes.get(e.src);
    const b = this.positioned?.nodes.get(e.dst);
    if (!a || !b) return null;
    const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const clip = (c: Point, o: Point, w: number, h: number): Point => {
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      if (dx === 0 && dy === 0) return c;
      const t = Math.min(Math.abs((w / 2) / (dx || 1e-9)), Math.abs((h / 2) / (dy || 1e-9)));
      return { x: c.x + dx * t, y: c.y + dy * t };
    };
    return [clip(ca, cb, a.width, a.height), clip(cb, ca, b.width, b.height)];
  }

  protected override render() {
    const pos = this.positioned;
    const focus = this.hovered ?? this.selected;
    const touching = new Set<string>();
    if (focus) {
      for (const e of this.edges) {
        if (e.src === focus || e.dst === focus) { touching.add(e.src); touching.add(e.dst); }
      }
    }
    const inCycle = new Set(this.cycles.flat());
    const axis = this.view.layout.axis;
    const pendingByKey = new Map(this.pending.map((p) => [edgeKey(p), p.action]));
    const drawnKeys = new Set(this.edges.map(edgeKey));
    const previews = this.pending.filter((p) => p.action === "add" && !drawnKeys.has(edgeKey(p)));
    const rels = [...new Set([...this.edges, ...previews].map((e) => e.rel))];
    const arming = this.armed !== null && this.selected !== null;
    // Edit mode: the modifier is held with a selection and an armed relationship.
    const editMode = this.modifier && arming;
    const preview = this.preview();
    const mod = modifierName();
    const { x, y, k } = this.transform;
    return html`
      ${this.nodes.length === 0 ? html`<div class="empty">no rows</div>` : nothing}
      <svg class="${arming ? "arming" : ""} ${this.writable.length ? "editing" : ""} ${editMode ? "editmode" : ""} ${this.modifier ? "modifier" : ""}"
        @wheel=${this.wheelListener} @pointerdown=${this.onPointerDown} @pointermove=${this.onPointerMove} @pointerup=${this.onPointerUp} @pointercancel=${this.onPointerUp} @dblclick=${this.onDoubleClick}
        viewBox="0 0 ${Math.max(pos?.width ?? 0, 10)} ${Math.max(pos?.height ?? 0, 10)}" preserveAspectRatio="xMidYMid meet">
        <defs>
          ${rels.map((rel) => svg`<marker id="arrow-${cssId(rel)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill=${relationColor(this.candidates, rel)}></path></marker>`)}
          ${preview ? svg`<marker id="arrow-preview-${preview.kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill=${preview.kind === "add" ? "#1565c0" : "#c62828"}></path></marker>` : nothing}
        </defs>
        <g transform="translate(${x} ${y}) scale(${k})">
          ${pos ? this.edges.map((e) => {
            const id = elkEdgeId(e);
            const pts = (e.rel === axis ? pos.routes.get(id) : undefined) ?? this.segment(e);
            if (!pts) return nothing;
            const lit = focus !== null && (e.src === focus || e.dst === focus);
            const dim = focus !== null && !lit;
            const removing = pendingByKey.get(edgeKey(e)) === "remove";
            const writable = this.writable.includes(e.rel);
            const points = pts.map((p) => `${p.x},${p.y}`).join(" ");
            return svg`<g class="edge-g ${writable ? "writable" : ""}" @click=${(ev: MouseEvent) => this.onEdgeClick(ev, e)}
              @pointerenter=${() => { this.hoveredEdge = e; }} @pointerleave=${() => { if (this.hoveredEdge === e) this.hoveredEdge = null; }}>
              <polyline class="edge ${e.rel === axis ? "axis" : ""} ${lit ? "lit" : ""} ${dim ? "dim" : ""} ${removing ? "removing" : ""}"
                points=${points} stroke=${relationColor(this.candidates, e.rel)}
                marker-end="url(#arrow-${cssId(e.rel)})"></polyline>
              ${writable ? svg`<polyline class="hit" points=${points}></polyline>` : nothing}
              <title>${e.src} -[${e.rel}]-> ${e.dst}${removing ? " (removing…)" : writable ? ` — ${mod}-click to remove` : ""}</title>
            </g>`;
          }) : nothing}
          ${pos ? previews.map((e) => {
            const pts = this.segment(e);
            if (!pts) return nothing;
            return svg`<polyline class="edge pending" points=${pts.map((p) => `${p.x},${p.y}`).join(" ")}
              stroke=${relationColor(this.candidates, e.rel)} marker-end="url(#arrow-${cssId(e.rel)})"><title>${e.src} -[${e.rel}]-> ${e.dst} (adding…)</title></polyline>`;
          }) : nothing}
          ${pos ? this.nodes.map((n) => {
            const p = pos.nodes.get(n.path);
            if (!p) return nothing;
            const dim = focus !== null && focus !== n.path && !touching.has(n.path);
            const target = arming && this.hovered === n.path && n.path !== this.selected;
            const source = editMode && this.selected === n.path;
            const card = this.cards.get(n.path) ?? cardFor(n, this.view.projection);
            const labelY = card.lines.length === 0 ? p.height / 2 + 4 : 20;
            return svg`<g class="node ${this.selected === n.path ? "selected" : ""} ${inCycle.has(n.path) ? "cycle" : ""} ${dim && !target ? "dim" : ""} ${target ? "target" : ""} ${source ? "source" : ""}"
              transform="translate(${p.x} ${p.y})" data-lines=${card.lines.length}
              @pointerenter=${() => { this.hovered = n.path; }} @pointerleave=${() => { this.hovered = null; }}
              @click=${(ev: MouseEvent) => this.onNodeClick(ev, n)}>
              ${source ? svg`<rect class="ring" x="-4" y="-4" width=${p.width + 8} height=${p.height + 8} rx="8"></rect>` : nothing}
              <rect width=${p.width} height=${p.height}></rect>
              <text class="label" x=${p.width / 2} y=${labelY} text-anchor="middle">${card.label}</text>
              ${card.lines.length > 0 ? svg`<line class="rule" x1="6" x2=${p.width - 6} y1="26" y2="26"></line>` : nothing}
              ${card.lines.map((l, i) => svg`<text class="line" x="9" y=${38 + i * 15} data-key=${l.key}><tspan class="key">${l.key}:</tspan> ${l.text}</text>`)}
              <title>${cardTooltip(n.path, card, this.view.projection)}${arming && n.path !== this.selected ? `\n${mod}-click to toggle ${this.armed!.name} with ${this.selected}` : ""}</title>
            </g>`;
          }) : nothing}
          ${pos && preview ? this.renderPreview(preview, pos, axis) : nothing}
        </g>
      </svg>
      ${this.renderBanner(preview, editMode, mod)}
      ${this.cycles.length > 0 ? html`<div class="banner">
        <b>${axis}</b> is not a strict order among the shown documents — ${this.cycles.length === 1 ? "a cycle" : `${this.cycles.length} cycles`} (elk broke it to lay the rest out):
        ${this.cycles.map((c) => html` <code>${c.join(" -> ")}</code>`)}
      </div>` : nothing}
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${rels.length > 0 ? html`<div class="legend">${rels.map((r) => html`<span><i style="background:${relationColor(this.candidates, r)}"></i>${r}${r === axis ? " (axis)" : ""}</span>`)}</div>` : nothing}
      ${editMode || preview
        ? html`<div class="legend styles" title="edge styles while editing"><span class="add"><i></i>will add</span><span class="remove"><i></i>will remove</span><span class="pending"><i></i>writing…</span></div>`
        : html`<div class="overlay">${this.busy ? "laying out…" : `${this.nodes.length} nodes · ${this.edges.length} edges · ${this.layoutKind ?? "—"}`}</div>`}
    `;
  }

  /** The preview edge: for an add, a fresh segment owner → target; for a remove,
   * the drawn edge's own route overlaid in the danger colour. Labelled at the midpoint. */
  private renderPreview(preview: EdgePreview<GraphNode>, pos: Positioned, axis: string | null) {
    const e: GraphEdge = { src: preview.owner.path, dst: preview.target.path, rel: preview.rel };
    const pts = (preview.kind === "remove" && e.rel === axis ? pos.routes.get(elkEdgeId(e)) : undefined) ?? this.segment(e);
    if (!pts) return nothing;
    const mid = midpoint(pts);
    const label = preview.kind === "add" ? `+ ${preview.rel}` : `remove ${preview.rel}`;
    return svg`<g class="preview-g" data-preview=${preview.kind} data-owner=${e.src} data-target=${e.dst} data-rel=${e.rel}>
      <polyline class="edge preview ${preview.kind}" points=${pts.map((p) => `${p.x},${p.y}`).join(" ")} marker-end="url(#arrow-preview-${preview.kind})"></polyline>
      ${mid ? svg`<text class="preview-label ${preview.kind}" x=${mid.x} y=${mid.y - 6} text-anchor="middle">${label}</text>` : nothing}
    </g>`;
  }

  /** The edit banner, most specific first: the concrete action under the pointer;
   * edit mode (modifier + selection + armed) saying what a click does; the
   * modifier held with nothing to act on (a hint, not an error); the armed
   * relationship's standing instructions. */
  private renderBanner(preview: EdgePreview<GraphNode> | null, editMode: boolean, mod: string) {
    if (preview) {
      return html`<div class="banner edit active ${preview.kind}" data-banner="action">
        <kbd>${mod}</kbd>-click to <b>${preview.kind === "add" ? "add" : "remove"}</b> <code>${preview.owner.path}</code> <b>-[${preview.rel}]-></b> <code>${preview.target.path}</code>
        — ${preview.kind === "add" ? "writes" : "edits"} <code>${preview.rel}</code> in <code>${preview.owner.path}</code>
      </div>`;
    }
    if (editMode) {
      const a = this.armed!;
      return html`<div class="banner edit active" data-banner="editmode">
        <kbd>${mod}</kbd>-click a node to add or remove <code>${a.name}</code> between it and <code>${this.selected}</code>${a.defaults.direction === "backward" ? " — the clicked node's field changes" : " — the selected node's field changes"}
      </div>`;
    }
    if (this.modifier && this.writable.length > 0) {
      return html`<div class="banner edit hint" data-banner="hint">
        <kbd>${mod}</kbd> held — ${this.armed
          ? html`click a node to select it, then ${mod}-click another to toggle <code>${this.armed.name}</code>`
          : "select a node and arm a relationship (the picker's edit column) to edit edges"}
      </div>`;
    }
    if (this.armed) {
      return html`<div class="banner edit" data-banner="armed">
        editing <b>${this.armed.name}</b>${this.selected
          ? html`: hold <kbd>${mod}</kbd> and click another node to toggle it with <code>${this.selected}</code>${this.armed.defaults.direction === "backward" ? " — the clicked node's field changes" : " — the selected node's field changes"}`
          : ": click a node to select it first"}
      </div>`;
    }
    return nothing;
  }
}

function cssId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

declare global {
  interface HTMLElementTagNameMap { "oqx-graph": OqxGraph }
}
