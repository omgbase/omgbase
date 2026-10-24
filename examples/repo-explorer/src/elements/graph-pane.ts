// <graph-pane>: the graph model (lib/graph.ts) on an SVG canvas under a
// d3-force layout. The pane owns no truth: the model comes in as a property,
// every completed user operation leaves as ONE event the page turns into a
// command (lib/graph-commands.ts, lib/relations.ts), and pointer movement
// during a drag is provisional — the simulation node's `fx/fy` follow the
// pointer and only the drop emits `graph-pin`.
//
// Properties: `model`, `selected` (a path), `canWrite` (connectors offered),
// `connectSource` (the page arms a connector from the keyboard/palette flow).
// Events (all `{ bubbles, composed }`):
//   graph-select { path | null }          click (null: open canvas), or an arrow key moved the selection
//   graph-open { path }                   double-click / Enter on the selected node
//   graph-expand { path }                 the ⊕ affordance or `e` on an unexpanded node
//   graph-collapse { path }               the ⊖ affordance or `e` on an expanded node (`e` toggles)
//   graph-pin { path, x, y, previous }    a drop after a drag (previous: the pin before it, or null)
//   graph-unpin { path, previous }        the ✕ affordance, `u` or Backspace
//   graph-connect { from, to }            a connector dropped on another node (or Enter on a keyboard target)
//   graph-connect-empty { from, x, y }    a connector dropped on open canvas (the page opens the palette)
// A connector starts by dragging the selected node's "⟶" handle (no modifier),
// with ⌘/Ctrl held on a node drag, after `c` / a click on the handle armed the
// node, or when `connectSource` is set; Esc cancels. Pinned nodes
// hold `fx/fy`; an unpin reheats the simulation so the node eases back (under
// `prefers-reduced-motion: reduce` the layout is ticked to rest synchronously
// and positions are set without animation). The pointer and keyboard math is
// lib/graph.ts's pure helpers (`connectorDrop`, `dragMode`, `nearestInDirection`, `fitTransform`,
// `arrowEnd`, `toGraph`, `zoomAbout`, `panBy`). The view: the wheel zooms about
// the cursor (a pinch arrives as `wheel` + ctrlKey), a drag on open canvas pans,
// `+`/`-`/`0` zoom in/out/reset, `f` fits; the transform is one `ViewTransform`.

import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceLink, type ForceX, type ForceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { CARD_H, CARD_W, arrowEnd, connectorDrop, connectorLine, dragMode, edgeLabel, emptyModel, fitTransform, forceConfig, initialView, graphDescription, nearestInDirection, neighborsOf, panBy, toGraph, truncateTitle, wheelZoomFactor, zoomAbout, type Direction, type GraphEdge, type GraphModel, type GraphNode, type Pin, type Placed, type ViewTransform } from "../lib/graph.ts";

export interface GraphPathDetail { path: string }
export interface GraphCollapseDetail { path: string }
/** `null`: open canvas was clicked (clear the selection). */
export interface GraphSelectDetail { path: string | null }
export interface GraphPinDetail { path: string; x: number; y: number; previous: Pin | null }
export interface GraphUnpinDetail { path: string; previous: Pin | null }
export interface GraphConnectDetail { from: string; to: string }
export interface GraphConnectEmptyDetail { from: string; x: number; y: number }

interface SimNode extends SimulationNodeDatum { path: string; x: number; y: number }
interface SimLink extends SimulationLinkDatum<SimNode> { key: string }

interface Drag {
  path: string;
  pointerId: number;
  connector: boolean;
  /** Started on the ⟶ handle (a click there arms the keyboard flow instead of selecting). */
  handle: boolean;
  moved: boolean;
  /** Pointer offset from the node centre, in graph coordinates. */
  offX: number;
  offY: number;
  /** The node's pin before the drag (restored on Esc). */
  previous: Pin | null;
  startX: number;
  startY: number;
}

interface Pan { pointerId: number; lastX: number; lastY: number; moved: boolean }

const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

@customElement("graph-pane")
export class GraphPane extends LitElement {
  static override styles = css`
    :host { display: block; position: relative; min-height: 240px; font: 13px/1.4 system-ui, sans-serif; color: #1e2430; outline: none; background: #fbfbfd; }
    :host(:focus-visible) { box-shadow: inset 0 0 0 2px #90b4e8; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; cursor: default; }
    svg.panning { cursor: grabbing; }
    .edge { stroke: #9aa3b2; stroke-width: 1.4; fill: none; }
    .edge.frontmatter { stroke: #1565c0; }
    .edge.body { stroke: #6f7a8c; }
    .edge.external { stroke: #b26a00; stroke-dasharray: 4 3; }
    .edge.hover { stroke-width: 2.6; }
    .hit { stroke: transparent; stroke-width: 12; fill: none; cursor: default; }
    .edge-label { font-size: 11px; fill: #1e2430; paint-order: stroke; stroke: #fbfbfd; stroke-width: 4px; pointer-events: none; }
    .node { cursor: grab; }
    .node.dragging { cursor: grabbing; }
    .node rect.card { fill: #fff; stroke: #c9cdd6; stroke-width: 1; }
    .node.root rect.card { stroke: #0d47a1; stroke-width: 2; fill: #eef4fd; }
    .node.selected rect.card { stroke: #1565c0; stroke-width: 2; }
    .node.external rect.card { stroke-dasharray: 4 3; fill: #fff8ee; stroke: #b26a00; }
    .node.pinned rect.card { fill: #f6f3ff; }
    .node.target rect.card { stroke: #1565c0; stroke-width: 3; fill: #e3edfb; }
    .node text.title { font-size: 12.5px; fill: #1e2430; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .node.external text.title { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .glyph { font-size: 11px; fill: #5a6270; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .affordance { cursor: pointer; }
    .affordance circle { fill: #fff; stroke: #c9cdd6; }
    .affordance:hover circle { fill: #e3edfb; stroke: #1565c0; }
    .handle { cursor: crosshair; }
    .handle circle { fill: #e8f5e9; stroke: #2e7d32; }
    .handle:hover circle, .handle.armed circle { fill: #c8e6c9; stroke: #1b5e20; }
    .affordance text { font-size: 12px; fill: #1e2430; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .badge rect { fill: #fff3e0; stroke: #ffb74d; }
    .badge text { font-size: 10px; fill: #8a5a00; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .ghost { pointer-events: none; }
    .ghost line { stroke: #1565c0; stroke-width: 2; stroke-dasharray: 6 4; fill: none; }
    .ghost text { font-size: 11px; fill: #1565c0; paint-order: stroke; stroke: #fbfbfd; stroke-width: 4px; }
    .node.source rect.card { stroke: #1565c0; stroke-width: 2.5; stroke-dasharray: 5 3; }
    .toolbar { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; }
    .toolbar button { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; }
    .toolbar button:hover { background: #f1f3f7; }
    .hint { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: #8a94a6; pointer-events: none; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8a94a6; font-size: 12.5px; }
  `;

  @property({ attribute: false }) model: GraphModel = emptyModel("/");
  @property({ type: String }) selected: string | null = null;
  @property({ type: Boolean }) canWrite = false;
  @property({ type: String }) connectSource: string | null = null;
  /** New neighbours per direction the page loads on expand (shown in the hint). */
  @property({ type: Number }) limit = 12;

  @state() private view: ViewTransform = initialView(600, 400);
  @state() private size = { w: 600, h: 400 };
  /** The user has zoomed/panned/fit: a resize no longer re-centres the view. */
  private viewTouched = false;
  @state() private hoverEdge: string | null = null;
  @state() private hoverNode: string | null = null;
  @state() private drag: Drag | null = null;
  @state() private pan: Pan | null = null;
  @state() private pointer: { x: number; y: number } | null = null;
  /** The source a keyboard/button connector is armed from. */
  @state() private armed: string | null = null;
  /** The keyboard connector's current target. */
  @state() private connectTarget: string | null = null;

  private readonly reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly linkForce: ForceLink<SimNode, SimLink>;
  private readonly gravityX: ForceX<SimNode>;
  private readonly gravityY: ForceY<SimNode>;
  private readonly config = forceConfig();
  private resize: ResizeObserver | null = null;
  private lastShape = "";

  constructor() {
    super();
    // The numbers are lib/graph.ts's `forceConfig`. No `forceCenter`: it translates every
    // node so the centroid sits at the centre, and with a hub pinned at the periphery that
    // drags the hub's free neighbours away from it each tick (the pin pathology).
    const c = this.config;
    this.linkForce = forceLink<SimNode, SimLink>([]).id((d) => d.path).distance(c.link.distance).strength(c.link.strength);
    this.gravityX = forceX<SimNode>(c.gravity.x).strength(c.gravity.strength);
    this.gravityY = forceY<SimNode>(c.gravity.y).strength(c.gravity.strength);
    this.sim = forceSimulation<SimNode, SimLink>([])
      .force("link", this.linkForce)
      .force("charge", forceManyBody<SimNode>().strength(c.charge.strength).distanceMax(c.charge.distanceMax).theta(c.charge.theta))
      .force("x", this.gravityX)
      .force("y", this.gravityY)
      .force("collide", forceCollide<SimNode>().radius(c.collide.radius).strength(c.collide.strength))
      .alphaDecay(c.alphaDecay)
      .velocityDecay(c.velocityDecay)
      .on("tick", () => this.requestUpdate());
    this.sim.stop();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Focusable host (not in the constructor: an attribute may not be added there).
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (typeof ResizeObserver === "function") {
      this.resize = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (!r || r.width === 0 || r.height === 0) return;
        this.size = { w: r.width, h: r.height };
        // A pane that mounted at 0×0 (or any untouched view) takes the home view of its real size.
        if (!this.viewTouched) this.view = initialView(r.width, r.height);
      });
      this.resize.observe(this);
    }
    this.addEventListener("keydown", this.onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resize?.disconnect();
    this.sim.stop();
    this.removeEventListener("keydown", this.onKey);
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("model")) this.syncSimulation();
    if (changed.has("connectSource") && this.connectSource) {
      this.armed = this.connectSource;
      this.connectTarget = null;
    }
  }

  // ---- simulation ------------------------------------------------------------------

  /** Mirror the model into the simulation: keep placed nodes, seed new ones near a neighbour, pins as fx/fy; reheat on a structural change. */
  private syncSimulation(): void {
    const current = new Map(this.sim.nodes().map((n) => [n.path, n]));
    const nodes: SimNode[] = [];
    // Graph space is centred on the origin (the page pins the root at (0, 0)); a new node seeds near a placed neighbour, else around the origin.
    const cx = 0, cy = 0;
    for (const node of this.model.nodes.values()) {
      let n = current.get(node.path);
      if (!n) {
        const near = neighborsOf(this.model, node.path).map((p) => current.get(p)).find((p) => p !== undefined);
        const a = Math.random() * Math.PI * 2;
        n = { path: node.path, x: (near?.x ?? cx) + Math.cos(a) * 60, y: (near?.y ?? cy) + Math.sin(a) * 60 };
      }
      if (node.pinned) { n.fx = node.pinned.x; n.fy = node.pinned.y; n.x = node.pinned.x; n.y = node.pinned.y; }
      else if (!this.drag || this.drag.path !== node.path) { n.fx = undefined; n.fy = undefined; }
      nodes.push(n);
    }
    const links: SimLink[] = [];
    for (const e of this.model.edges.values()) {
      if (e.from === e.to || !this.model.nodes.has(e.from) || !this.model.nodes.has(e.to)) continue;
      links.push({ key: e.key, source: e.from, target: e.to });
    }
    const shape = `${nodes.map((n) => `${n.path}${n.fx ?? ""},${n.fy ?? ""}`).join("|")}#${links.map((l) => l.key).join("|")}`;
    this.sim.nodes(nodes);
    this.linkForce.links(links);
    if (shape === this.lastShape) return;
    this.lastShape = shape;
    this.reheat(this.config.reheatAlpha);
  }

  private reheat(alpha: number): void {
    if (this.reduced) {
      this.sim.alpha(1).stop();
      this.sim.tick(300);
      this.requestUpdate();
    } else {
      this.sim.alpha(Math.max(this.sim.alpha(), alpha)).restart();
    }
  }

  private placed(): Placed[] {
    return this.sim.nodes().map((n) => ({ path: n.path, x: n.x, y: n.y }));
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  // ---- pointer -----------------------------------------------------------------------

  private graphPoint(e: PointerEvent): { x: number; y: number } {
    const r = this.getBoundingClientRect();
    return toGraph(this.view, e.clientX - r.left, e.clientY - r.top);
  }

  /** A press on a card (or, `handle`, on its ⟶ handle): a reposition or a connector begins. Neither the card nor the canvas sees the press again. */
  private onNodeDown(e: PointerEvent, path: string, handle = false): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this.focus();
    const node = this.sim.nodes().find((n) => n.path === path);
    if (!node) return;
    const g = this.graphPoint(e);
    const connector = dragMode({ handle, modifier: e.metaKey || e.ctrlKey, canWrite: this.canWrite, armed: this.connectSource ?? this.armed }, path) === "connector";
    const pin = this.model.nodes.get(path)?.pinned ?? null;
    this.drag = { path, pointerId: e.pointerId, connector, handle, moved: false, offX: node.x - g.x, offY: node.y - g.y, previous: pin ? { ...pin } : null, startX: g.x, startY: g.y };
    this.pointer = connector ? g : null;
  }

  /** A press on open canvas: a pan begins (a press that never moves is a click → clear the selection). */
  private onCanvasDown(e: PointerEvent): void {
    this.focus();
    if (e.button !== 0 || this.drag) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this.pan = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const pan = this.pan;
    if (pan && e.pointerId === pan.pointerId) {
      const dx = e.clientX - pan.lastX, dy = e.clientY - pan.lastY;
      if (!pan.moved && Math.hypot(dx, dy) < 3) return;
      pan.moved = true;
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
      this.view = panBy(this.view, dx, dy);
      this.viewTouched = true;
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const g = this.graphPoint(e);
    if (!d.moved && Math.hypot(g.x - d.startX, g.y - d.startY) < 3) return;
    d.moved = true;
    if (d.connector) {
      this.pointer = g;
      const drop = connectorDrop(this.placed(), d.path, g.x, g.y, (p) => this.model.nodes.get(p)?.kind === "document");
      this.connectTarget = drop.kind === "connect" ? drop.to : null;
      return;
    }
    const node = this.sim.nodes().find((n) => n.path === d.path);
    if (!node) return;
    node.fx = g.x + d.offX;
    node.fy = g.y + d.offY;
    if (this.reduced) { node.x = node.fx; node.y = node.fy; this.requestUpdate(); }
    else this.sim.alphaTarget(0.3).restart();
  }

  private onUp(e: PointerEvent): void {
    const pan = this.pan;
    if (pan && e.pointerId === pan.pointerId) {
      this.pan = null;
      if (!pan.moved) this.emit<GraphSelectDetail>("graph-select", { path: null });
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    this.pointer = null;
    const g = this.graphPoint(e);
    if (d.connector) {
      if (!d.moved) {
        // A click: on the handle it toggles the armed (keyboard) connector; on the card it selects.
        if (d.handle) { this.armed = this.armed === d.path ? null : d.path; this.connectTarget = null; }
        else { this.armed = null; this.emit<GraphPathDetail>("graph-select", { path: d.path }); }
        return;
      }
      this.armed = null;
      this.connectTarget = null;
      const drop = connectorDrop(this.placed(), d.path, g.x, g.y, (p) => this.model.nodes.get(p)?.kind === "document");
      if (drop.kind === "connect") this.emit<GraphConnectDetail>("graph-connect", { from: drop.from, to: drop.to });
      else this.emit<GraphConnectEmptyDetail>("graph-connect-empty", { from: drop.from, x: drop.x, y: drop.y });
      return;
    }
    if (!this.reduced) this.sim.alphaTarget(0);
    if (!d.moved) { this.emit<GraphPathDetail>("graph-select", { path: d.path }); return; }
    const node = this.sim.nodes().find((n) => n.path === d.path);
    if (!node) return;
    this.emit<GraphPinDetail>("graph-pin", { path: d.path, x: node.fx ?? node.x, y: node.fy ?? node.y, previous: d.previous });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.getBoundingClientRect();
    this.view = zoomAbout(this.view, wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX - r.left, e.clientY - r.top);
    this.viewTouched = true;
  }

  /** Zoom by `factor` about the viewport's centre (the keyboard). */
  private zoom(factor: number): void {
    this.view = zoomAbout(this.view, factor, this.size.w / 2, this.size.h / 2);
    this.viewTouched = true;
  }

  /** The home view: the origin (the pinned root) at the centre, 1:1; a resize keeps it centred again. */
  private home(): void {
    this.view = initialView(this.size.w, this.size.h);
    this.viewTouched = false;
  }

  private cancelDrag(): void {
    this.pan = null;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.pointer = null;
    this.armed = null;
    this.connectTarget = null;
    if (!d.connector) {
      const node = this.sim.nodes().find((n) => n.path === d.path);
      if (node) {
        node.fx = d.previous?.x;
        node.fy = d.previous?.y;
        this.reheat(this.config.reheatAlpha);
      }
    }
    this.requestUpdate();
  }

  private unpin(path: string): void {
    const previous = this.model.nodes.get(path)?.pinned ?? null;
    if (!previous) return;
    this.emit<GraphUnpinDetail>("graph-unpin", { path, previous });
    // The page clears the pin in the model; the node eases back from here.
    const node = this.sim.nodes().find((n) => n.path === path);
    if (node) { node.fx = undefined; node.fy = undefined; }
    this.reheat(this.config.reheatAlpha);
  }

  /** Expand an unexpanded document, collapse an expanded one. */
  private toggleExpand(path: string): void {
    const node = this.model.nodes.get(path);
    if (!node || node.kind !== "document") return;
    if (node.expanded) this.emit<GraphCollapseDetail>("graph-collapse", { path });
    else this.emit<GraphPathDetail>("graph-expand", { path });
  }

  private fit(): void {
    this.view = fitTransform(this.placed(), this.size.w, this.size.h);
    this.viewTouched = true;
  }

  // ---- keyboard ----------------------------------------------------------------------

  private readonly onKey = (e: KeyboardEvent): void => {
    const source = this.connectSource ?? this.armed;
    const sel = this.selected;
    if (e.key === "Escape") {
      if (this.drag) this.cancelDrag();
      this.armed = null;
      this.connectTarget = null;
      e.preventDefault();
      return;
    }
    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      const placed = this.placed();
      if (source) {
        const next = nearestInDirection(placed, this.connectTarget ?? source, dir);
        if (next) this.connectTarget = next;
      } else {
        const next = sel ? nearestInDirection(placed, sel, dir) : placed[0]?.path ?? null;
        if (next) this.emit<GraphPathDetail>("graph-select", { path: next });
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (source) {
        const to = this.connectTarget;
        this.armed = null;
        this.connectTarget = null;
        if (to && to !== source && this.model.nodes.get(to)?.kind === "document") this.emit<GraphConnectDetail>("graph-connect", { from: source, to });
        else {
          const n = this.sim.nodes().find((x) => x.path === source);
          this.emit<GraphConnectEmptyDetail>("graph-connect-empty", { from: source, x: (n?.x ?? 0) + CARD_W, y: n?.y ?? 0 });
        }
      } else if (sel) this.emit<GraphPathDetail>("graph-open", { path: sel });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "e": if (sel) { e.preventDefault(); this.toggleExpand(sel); } break;
      case "+":
      case "=": e.preventDefault(); this.zoom(1.25); break;
      case "-": e.preventDefault(); this.zoom(1 / 1.25); break;
      case "0": e.preventDefault(); this.home(); break;
      case "u":
      case "Backspace": if (sel) { e.preventDefault(); this.unpin(sel); } break;
      case "c": if (sel && this.canWrite && this.model.nodes.get(sel)?.kind === "document") { e.preventDefault(); this.armed = sel; this.connectTarget = null; } break;
      case "f": e.preventDefault(); this.fit(); break;
    }
  };

  // ---- rendering ---------------------------------------------------------------------

  private renderEdge(e: GraphEdge, pos: Map<string, SimNode>): TemplateResult | typeof nothing {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b || e.from === e.to) return nothing;
    const end = arrowEnd(a, b);
    const hover = this.hoverEdge === e.key;
    const mx = (a.x + end.x) / 2, my = (a.y + end.y) / 2;
    return svg`<g @pointerenter=${() => { this.hoverEdge = e.key; }} @pointerleave=${() => { if (this.hoverEdge === e.key) this.hoverEdge = null; }}>
      <line class="edge ${e.provenance} ${hover ? "hover" : ""}" x1=${a.x} y1=${a.y} x2=${end.x} y2=${end.y} marker-end="url(#arrow)"></line>
      <line class="hit" x1=${a.x} y1=${a.y} x2=${end.x} y2=${end.y}><title>${e.from} → ${e.to}: ${edgeLabel(e)}</title></line>
      ${hover ? svg`<text class="edge-label" x=${mx} y=${my - 6} text-anchor="middle">${edgeLabel(e)}</text>` : nothing}
    </g>`;
  }

  private renderNode(node: GraphNode, n: SimNode): TemplateResult {
    const isRoot = node.path === this.model.root;
    const isSel = this.selected === node.path;
    const hover = this.hoverNode === node.path;
    const dragging = this.drag?.path === node.path;
    const source = (this.drag?.connector ? this.drag.path : null) ?? this.connectSource ?? this.armed;
    const more = this.model.truncated.get(node.path) ?? 0;
    const cls = ["node", node.kind, isRoot ? "root" : "", isSel ? "selected" : "", node.pinned ? "pinned" : "", dragging ? "dragging" : "", source === node.path ? "source" : "", this.connectTarget === node.path ? "target" : ""].join(" ");
    const stop = (ev: Event) => ev.stopPropagation();
    const hw = CARD_W / 2, hh = CARD_H / 2;
    return svg`<g class=${cls} transform=${`translate(${n.x},${n.y})`} data-path=${node.path} aria-selected=${isSel ? "true" : "false"}
        @pointerdown=${(ev: PointerEvent) => this.onNodeDown(ev, node.path)}
        @dblclick=${() => this.emit<GraphPathDetail>("graph-open", { path: node.path })}
        @pointerenter=${() => { this.hoverNode = node.path; }} @pointerleave=${() => { if (this.hoverNode === node.path) this.hoverNode = null; }}>
      <title>${node.path}${node.pinned ? " (pinned)" : ""}${source === node.path ? " — connector armed" : ""}</title>
      <rect class="card" x=${-hw} y=${-hh} width=${CARD_W} height=${CARD_H} rx="8"></rect>
      <text class="title" x=${node.pinned ? -6 : 0} y="0">${truncateTitle(node.title)}</text>
      ${node.pinned ? svg`<text class="glyph" x=${hw - 12} y=${-hh + 10}>📌</text>` : nothing}
      ${node.pinned && (hover || isSel) ? svg`<g class="affordance" @pointerdown=${stop} @click=${(ev: Event) => { ev.stopPropagation(); this.unpin(node.path); }}><title>unpin</title><circle cx=${hw} cy=${-hh} r="8"></circle><text x=${hw} y=${-hh}>✕</text></g>` : nothing}
      ${node.kind === "document" ? svg`<g class="affordance" @pointerdown=${stop} @click=${(ev: Event) => { ev.stopPropagation(); this.toggleExpand(node.path); }}><title>${node.expanded ? "collapse (e)" : "expand (e)"}</title><circle cx=${hw} cy="0" r="8"></circle><text x=${hw} y="0">${node.expanded ? "⊖" : "⊕"}</text></g>` : nothing}
      ${isSel && this.canWrite && node.kind === "document" ? svg`<g class="affordance handle ${this.armed === node.path ? "armed" : ""}" @pointerdown=${(ev: PointerEvent) => this.onNodeDown(ev, node.path, true)} @dblclick=${stop}><title>drag to connect (click arms the keyboard connector; c)</title><circle cx=${-hw} cy="0" r="10"></circle><text x=${-hw} y="0">⟶</text></g>` : nothing}
      ${more > 0 ? svg`<g class="badge"><title>${more} more neighbour${more === 1 ? "" : "s"} not loaded</title><rect x=${hw - 34} y=${hh - 8} width="44" height="14" rx="7"></rect><text x=${hw - 12} y=${hh - 1}>+${more} more</text></g>` : nothing}
    </g>`;
  }

  override render() {
    const nodes = this.sim.nodes();
    const pos = new Map(nodes.map((n) => [n.path, n]));
    // The ghost's source: the connector being dragged (⌘-drag, the ⟶ handle), else the armed keyboard source.
    const source = (this.drag?.connector ? this.drag.path : null) ?? this.connectSource ?? this.armed;
    const src = source ? pos.get(source) : undefined;
    const connectorEnd = this.pointer ?? (this.connectTarget ? pos.get(this.connectTarget) : undefined);
    const ghost = src && connectorEnd ? connectorLine(src, connectorEnd) : null;
    const { k, tx, ty } = this.view;
    return html`
      <svg role="application" aria-label=${graphDescription(this.model)} class=${this.pan?.moved ? "panning" : ""}
          @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${() => this.cancelDrag()}
          @pointerdown=${this.onCanvasDown} @wheel=${this.onWheel}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a94a6"></path>
          </marker>
          <marker id="arrow-ghost" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#1565c0"></path>
          </marker>
        </defs>
        <g transform=${`translate(${tx},${ty}) scale(${k})`}>
          ${[...this.model.edges.values()].map((e) => this.renderEdge(e, pos))}
          ${nodes.map((n) => { const node = this.model.nodes.get(n.path); return node ? this.renderNode(node, n) : nothing; })}
          ${ghost ? svg`<g class="ghost">
            <line x1=${ghost.x1} y1=${ghost.y1} x2=${ghost.x2} y2=${ghost.y2} marker-end="url(#arrow-ghost)"></line>
            ${this.connectTarget ? nothing : svg`<text x=${ghost.hint.x} y=${ghost.hint.y}>${this.drag?.connector ? "drop here: find or create…" : "Enter: find or create…"}</text>`}
          </g>` : nothing}
        </g>
      </svg>
      ${this.model.nodes.size === 0 ? html`<div class="empty">no graph yet</div>` : nothing}
      <div class="toolbar">
        <button @click=${() => this.fit()} title="fit the graph to the view (f)">fit</button>
        <button @click=${() => this.home()} title="1:1 with the origin (the pinned root) centred (0)">1:1</button>
      </div>
      <div class="hint">drag: move (pins) · ${this.canWrite ? "⌘/Ctrl-drag or c: connect · " : ""}e / ⊕⊖: expand ${this.limit} per side / collapse · u: unpin · Enter: open · arrows: select · wheel: zoom · drag canvas: pan · f: fit · +/-/0${source ? ` · connector from ${source} — drop on a document or Esc` : ""}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "graph-pane": GraphPane }
}
