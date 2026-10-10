// <oqx-graph>: the query hits as nodes, the view's relationships as edges.
// Fetches edges through the provided `fetchEdges` (the page wires it to the
// MCP `query` tool — this element never talks to a server itself), lays the
// graph out with elkjs along the axis (direction honoured, cycles reported in a
// banner) or with d3-force when there is no axis, and renders SVG.
//
//   properties: nodes (GraphNode[]), view (View), candidates (Candidate[]),
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

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import ELK from "elkjs/lib/elk.bundled.js";
import type { Candidate } from "../lib/candidates.ts";
import type { GraphEdge } from "../lib/edges.ts";
import { sequenceEdges } from "../lib/edges.ts";
import { ownerFor } from "../lib/edit.ts";
import { buildElkGraph, elkEdgeId, findCycles, readElkLayout, type Point, type Positioned } from "../lib/layout-elk.ts";
import { forceLayout } from "../lib/layout-force.ts";
import type { View } from "../lib/view.ts";
import { relationColor } from "./oqx-relationship-picker.ts";

export interface GraphNode {
  id: string;
  path: string;
  label: string;
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

const modified = (e: MouseEvent): boolean => e.metaKey || e.ctrlKey;

const EMPTY_VIEW: View = { edges: [], layout: { axis: null, direction: "forward" } };
const NODE_H = 30;
const elk = new ELK();

function nodeWidth(label: string): number {
  return Math.max(60, Math.min(240, 18 + label.length * 7));
}

@customElement("oqx-graph")
export class OqxGraph extends LitElement {
  static override styles = css`
    :host { display: block; position: relative; min-height: 320px; background: #fafbfc; border: 1px solid #d0d4dc; border-radius: 6px; overflow: hidden; font: 12px system-ui, sans-serif; }
    svg { display: block; width: 100%; height: 100%; min-height: 320px; cursor: grab; user-select: none; }
    svg.dragging { cursor: grabbing; }
    .node rect { fill: #fff; stroke: #8a94a6; stroke-width: 1; rx: 5; }
    .node text { font: 12px system-ui, sans-serif; fill: #1e2430; pointer-events: none; }
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
    svg.arming .node, svg.editing g.edge-g.writable { cursor: crosshair; }
    .node.target rect { stroke: #ef6c00; stroke-dasharray: 5 3; }
    .banner { position: absolute; left: 8px; right: 8px; top: 8px; padding: 6px 10px; border-radius: 4px; background: #fff3e0; color: #7a4a00; border: 1px solid #ffcc80; }
    .banner code { font-family: ui-monospace, monospace; }
    .banner.edit { top: auto; bottom: 40px; background: #fff8e1; color: #6d4c00; border-color: #ffe082; }
    .overlay { position: absolute; right: 8px; bottom: 8px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); color: #5a6270; border: 1px solid #e3e6ec; }
    .error { position: absolute; left: 8px; right: 8px; bottom: 8px; padding: 6px 10px; border-radius: 4px; background: #fff5f5; color: #c62828; border: 1px solid #ef9a9a; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: #7a8290; }
    .legend { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); border: 1px solid #e3e6ec; }
    .legend i { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 4px; }
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
  @state() private cycles: string[][] = [];
  @state() private layoutKind: "elk" | "force" | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private hovered: string | null = null;
  @state() private transform = { x: 0, y: 0, k: 1 };

  private generation = 0;
  private edgeCache = new Map<string, Promise<GraphEdge[]>>();
  private drag: { x: number; y: number; tx: number; ty: number } | null = null;

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
      const layoutNodes = nodes.map((n) => ({ id: n.path, width: nodeWidth(n.label), height: NODE_H }));
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
      this.positioned = positioned;
      this.transform = { x: 0, y: 0, k: 1 };
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

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const k = Math.min(4, Math.max(0.2, this.transform.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    const svgEl = this.renderRoot.querySelector("svg")!;
    const r = svgEl.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const { x, y, k: k0 } = this.transform;
    this.transform = { k, x: mx - ((mx - x) * k) / k0, y: my - ((my - y) * k) / k0 };
  }

  private onPointerDown(e: PointerEvent): void {
    if ((e.target as Element).closest(".node")) return;
    if (modified(e) && (e.target as Element).closest(".edge-g")) return;
    this.drag = { x: e.clientX, y: e.clientY, tx: this.transform.x, ty: this.transform.y };
    (e.currentTarget as Element).classList.add("dragging");
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    this.transform = { ...this.transform, x: this.drag.tx + e.clientX - this.drag.x, y: this.drag.ty + e.clientY - this.drag.y };
  }

  private onPointerUp(e: PointerEvent): void {
    this.drag = null;
    (e.currentTarget as Element).classList.remove("dragging");
  }

  private select(node: GraphNode | null): void {
    this.selected = node?.path ?? null;
    this.dispatchEvent(new CustomEvent("node-select", { detail: { node }, bubbles: true, composed: true }));
  }

  private isDrawn(rel: string, src: string, dst: string): boolean {
    return this.edges.some((e) => e.rel === rel && e.src === src && e.dst === dst);
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
    const { x, y, k } = this.transform;
    return html`
      ${this.nodes.length === 0 ? html`<div class="empty">no rows</div>` : nothing}
      <svg class="${arming ? "arming" : ""} ${this.writable.length ? "editing" : ""}"
        @wheel=${this.onWheel} @pointerdown=${this.onPointerDown} @pointermove=${this.onPointerMove} @pointerup=${this.onPointerUp} @pointerleave=${this.onPointerUp}
        viewBox="0 0 ${Math.max(pos?.width ?? 0, 10)} ${Math.max(pos?.height ?? 0, 10)}" preserveAspectRatio="xMidYMid meet">
        <defs>
          ${rels.map((rel) => svg`<marker id="arrow-${cssId(rel)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill=${relationColor(this.candidates, rel)}></path></marker>`)}
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
            return svg`<g class="edge-g ${writable ? "writable" : ""}" @click=${(ev: MouseEvent) => this.onEdgeClick(ev, e)}>
              <polyline class="edge ${e.rel === axis ? "axis" : ""} ${lit ? "lit" : ""} ${dim ? "dim" : ""} ${removing ? "removing" : ""}"
                points=${points} stroke=${relationColor(this.candidates, e.rel)}
                marker-end="url(#arrow-${cssId(e.rel)})"></polyline>
              ${writable ? svg`<polyline class="hit" points=${points}></polyline>` : nothing}
              <title>${e.src} -[${e.rel}]-> ${e.dst}${removing ? " (removing…)" : writable ? " — ⌘-click to remove" : ""}</title>
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
            return svg`<g class="node ${this.selected === n.path ? "selected" : ""} ${inCycle.has(n.path) ? "cycle" : ""} ${dim && !target ? "dim" : ""} ${target ? "target" : ""}"
              transform="translate(${p.x} ${p.y})"
              @pointerenter=${() => { this.hovered = n.path; }} @pointerleave=${() => { this.hovered = null; }}
              @click=${(ev: MouseEvent) => this.onNodeClick(ev, n)}>
              <rect width=${p.width} height=${p.height}></rect>
              <text x=${p.width / 2} y=${p.height / 2 + 4} text-anchor="middle">${truncate(n.label, p.width)}</text>
              <title>${n.path}${arming && n.path !== this.selected ? ` — ⌘-click to toggle ${this.armed!.name} with ${this.selected}` : ""}</title>
            </g>`;
          }) : nothing}
        </g>
      </svg>
      ${this.armed ? html`<div class="banner edit">
        editing <b>${this.armed.name}</b>${this.selected
          ? html`: ⌘-click (Ctrl-click) another node to toggle it with <code>${this.selected}</code>${this.armed.defaults.direction === "backward" ? " — the clicked node's field changes" : " — the selected node's field changes"}`
          : ": click a node to select it first"}
      </div>` : nothing}
      ${this.cycles.length > 0 ? html`<div class="banner">
        <b>${axis}</b> is not a strict order among the shown documents — ${this.cycles.length === 1 ? "a cycle" : `${this.cycles.length} cycles`} (elk broke it to lay the rest out):
        ${this.cycles.map((c) => html` <code>${c.join(" -> ")}</code>`)}
      </div>` : nothing}
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${rels.length > 0 ? html`<div class="legend">${rels.map((r) => html`<span><i style="background:${relationColor(this.candidates, r)}"></i>${r}${r === axis ? " (axis)" : ""}</span>`)}</div>` : nothing}
      <div class="overlay">${this.busy ? "laying out…" : `${this.nodes.length} nodes · ${this.edges.length} edges · ${this.layoutKind ?? "—"}`}</div>
    `;
  }
}

function cssId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function truncate(label: string, width: number): string {
  const max = Math.max(4, Math.floor((width - 14) / 7));
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

declare global {
  interface HTMLElementTagNameMap { "oqx-graph": OqxGraph }
}
