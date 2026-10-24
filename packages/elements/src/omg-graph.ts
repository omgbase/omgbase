// <omg-graph>: the view model of ./graph.ts drawn as cards on an SVG canvas —
// a d3-force layout (or externally computed positions), obstacle-routed Bézier
// edges with temporal easing, pins that spring back, zoom and pan, progressive
// expansion, a connector gesture and ⌘-click edge toggling. The element owns no
// truth: nodes and edges come in as properties, every completed user operation
// leaves as ONE event the host turns into a command, and pointer movement during
// a drag is provisional (only the drop emits `graph-pin`).
//
// Properties
//   nodes: GraphViewNode[]           edges: GraphViewEdge[]
//   card: string                     the card template (DEFAULT_CARD `{_title}`)
//   renderCard: CardRenderer | null  a function deciding a node's card (wins over `card`): a template
//                                    string for that node, a CardText, or a Lit html`…` drawn in a
//                                    <foreignObject> (measured; `.card-html` wrapper, inherits the
//                                    custom properties; `--omg-graph-card-pointer-events: auto` makes it
//                                    interactive — by default the card underneath takes the pointer)
//   labelFit (label-fit)             "truncate" | "wrap" | "expand"
//   selected: string | null          canWrite: boolean (connectors offered)
//   connectSource: string | null     the host arms a connector from a node
//   edgeStyle (edge-style)           "curved" | "straight"
//   layout                           "force" | "fixed" (positions from `positions`; no simulation)
//   positions: Map<id, {x, y}>       for `fixed`; a node without one takes the force seed
//   routes: Map<key, Point[]>        for `fixed`: an edge with a polyline here (elk's orthogonal
//                                    bend points) is drawn along it instead of a routed Bézier
//   autoFit (auto-fit)               keep the graph fitted to the view (after each layout change and
//                                    while the simulation settles) until the user pans or zooms;
//                                    `fit` hands the camera back
//   edgeToggle: boolean              ⌘/Ctrl-click toggles edges (graph-ui's gesture)
//   toolbar: boolean                 fit / 1:1 / edge style / label fit controls
// Events (every detail type exported; all bubble and compose)
//   graph-select { id | null }  graph-open { id }  graph-expand { id }  graph-collapse { id }
//   graph-pin { id, x, y, previous }  graph-unpin { id, previous }
//   graph-connect { from, to, clientX, clientY }  graph-connect-empty { from, x, y, clientX, clientY }
//                               (clientX/Y: the drop point in viewport px — where a host anchors its picker)
//   graph-edge-toggle { key?, from, to, present }  graph-edge-select { key | null }
//   graph-edge-delete { key }   (the ✕ at a selected edge's midpoint, or Delete / Backspace while an edge
//                               is selected; only with canWrite — the host runs the detach)
//   graph-hover { id | null }  graph-edge-hover { key | null }   (the pointer over a card / an edge)
//   graph-view { k, tx, ty }  graph-label-fit { labelFit }  (the toolbar's select)
// Keys: arrows select (or move the connector target), Enter opens (or confirms a
// connector), e expands/collapses, u / Backspace unpins (Delete / Backspace on a
// selected edge asks to delete it), c arms a connector,
// +/-/0 zoom, f fits, Esc cancels. Theming: CSS custom properties
// `--omg-graph-accent`, `--omg-graph-bg`, `--omg-graph-card-bg`,
// `--omg-graph-card-border`, `--omg-graph-text`, `--omg-graph-muted`,
// `--omg-graph-font`, `--omg-graph-external`, `--omg-graph-root-bg`.

import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceLink, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import {
  DEFAULT_CARD, DEFAULT_LABEL_FIT, EdgeEaser, LABEL_FIT, LABEL_FITS, arrowheadPath, canvasMeasure, cardContent, cardRadius, connectorDrop, connectorLine, dragMode, edgeKindColor, edgePath, fitTransform, forceConfig,
  graphDescription, initialView, nearestInDirection, nodeSize, panBy, parallelOffsets, pathFromOffset, polylineRoute, sizeCard, toGraph, wheelZoomFactor, zoomAbout,
  type CardRenderer, type CardSize, type CardText, type Direction, type EdgeRoute, type EdgeStyle, type GraphViewEdge, type GraphViewNode, type LabelFit, type LayoutMode, type Measure, type Pin, type Placed, type ViewTransform,
} from "./graph.js";

export interface GraphIdDetail { id: string }
/** `null`: open canvas was clicked (clear the selection). */
export interface GraphSelectDetail { id: string | null }
export interface GraphPinDetail { id: string; x: number; y: number; previous: Pin | null }
export interface GraphUnpinDetail { id: string; previous: Pin | null }
/** `clientX`/`clientY`: where the connector was dropped (or confirmed), in viewport px — an anchor for the host's picker. */
export interface GraphConnectDetail { from: string; to: string; clientX: number; clientY: number }
/** `x`/`y` in graph space (a seed position for a node created there); `clientX`/`clientY` in viewport px. */
export interface GraphConnectEmptyDetail { from: string; x: number; y: number; clientX: number; clientY: number }
/** The user asked to delete the selected edge (its ✕, or Delete / Backspace). */
export interface GraphEdgeDeleteDetail { key: string }
/** `present: true` — an existing edge (`key`) was ⌘-clicked; `present: false` — a node was ⌘-clicked with another selected (`from` the selection, `to` the click). */
export interface GraphEdgeToggleDetail { key?: string; from: string; to: string; present: boolean }
export interface GraphEdgeSelectDetail { key: string | null }
/** `null`: the pointer left the card / edge. */
export interface GraphHoverDetail { id: string | null }
export interface GraphEdgeHoverDetail { key: string | null }
export type GraphViewDetail = ViewTransform;
export interface GraphLabelFitDetail { labelFit: LabelFit }

/** A frame whose routing takes longer than this degrades to every-other-tick routing while hot. */
export const ROUTE_BUDGET_MS = 4;

interface SimNode extends SimulationNodeDatum { id: string; x: number; y: number; r: number }
interface SimLink extends SimulationLinkDatum<SimNode> { key: string }

interface Drag { id: string; pointerId: number; connector: boolean; handle: boolean; moved: boolean; offX: number; offY: number; previous: Pin | null; startX: number; startY: number; modifier: boolean }
interface Pan { pointerId: number; lastX: number; lastY: number; moved: boolean }
interface Sized { text: CardText; size: CardSize; html: TemplateResult | null }

const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

@customElement("omg-graph")
export class OmgGraph extends LitElement {
  static override styles = css`
    :host {
      display: block; position: relative; min-height: 240px; outline: none;
      --_accent: var(--omg-graph-accent, #1565c0);
      --_bg: var(--omg-graph-bg, #fbfbfd);
      --_card: var(--omg-graph-card-bg, #fff);
      --_border: var(--omg-graph-card-border, #c9cdd6);
      --_text: var(--omg-graph-text, #1e2430);
      --_muted: var(--omg-graph-muted, #8a94a6);
      --_external: var(--omg-graph-external, #b26a00);
      --_root: var(--omg-graph-root-bg, #eef4fd);
      font: 13px/1.4 var(--omg-graph-font, system-ui, sans-serif); color: var(--_text); background: var(--_bg);
    }
    :host(:focus-visible) { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--_accent) 45%, transparent); }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; cursor: default; }
    svg.panning { cursor: grabbing; }
    .edge { stroke: color-mix(in srgb, var(--_accent) 55%, transparent); stroke-width: 1.5; fill: none; stroke-linecap: round; }
    .edge.body { stroke: color-mix(in srgb, var(--_accent) 40%, transparent); stroke-dasharray: 1.5 4; }
    .edge.external { stroke: color-mix(in srgb, var(--_external) 60%, transparent); stroke-dasharray: 5 3; }
    .edge.dotted { stroke-dasharray: 1.5 4; }
    .edge.dashed { stroke-dasharray: 5 3; }
    .edge.pending { stroke-dasharray: 6 4; opacity: 0.55; }
    .head { fill: color-mix(in srgb, var(--_accent) 70%, transparent); stroke: none; }
    .head.body { fill: color-mix(in srgb, var(--_accent) 55%, transparent); }
    .head.external { fill: color-mix(in srgb, var(--_external) 70%, transparent); }
    .head.pending { opacity: 0.55; }
    g.hover .edge, g.selected-edge .edge { stroke-width: 2.8; stroke-dasharray: none; opacity: 1; }
    g.hover .head, g.selected-edge .head { opacity: 1; }
    g.writable .hit { cursor: pointer; }
    .hit { stroke: transparent; stroke-width: 12; fill: none; cursor: default; }
    .edge-label { font-size: 11px; fill: var(--_text); paint-order: stroke; stroke: var(--_bg); stroke-width: 4px; pointer-events: none; }
    .node { cursor: grab; }
    .node.dragging { cursor: grabbing; }
    .node.toggle-target { cursor: crosshair; }
    .node rect.card { fill: var(--_card); stroke: var(--_border); stroke-width: 1; }
    .node.root rect.card { stroke: var(--_accent); stroke-width: 2; fill: var(--_root); }
    .node.selected rect.card { stroke: var(--_accent); stroke-width: 2; }
    .node.external rect.card { stroke-dasharray: 4 3; fill: color-mix(in srgb, var(--_external) 8%, var(--_card)); stroke: var(--_external); }
    .node.pinned rect.card { fill: color-mix(in srgb, var(--_accent) 6%, var(--_card)); }
    .node.source rect.card { stroke: var(--_accent); stroke-width: 2.5; stroke-dasharray: 5 3; }
    .node.target rect.card { stroke: var(--_accent); stroke-width: 3; fill: color-mix(in srgb, var(--_accent) 12%, var(--_card)); }
    .node foreignObject { overflow: visible; pointer-events: var(--omg-graph-card-pointer-events, none); }
    .node .card-html { display: inline-block; max-width: ${LABEL_FIT.expandMaxWidth}px; box-sizing: border-box; padding: 6px 9px; font: 12px/1.35 var(--omg-graph-font, system-ui, sans-serif); color: var(--_text); white-space: normal; }
    .node text { fill: var(--_text); pointer-events: none; }
    .node text.label { font: 600 12px var(--omg-graph-font, system-ui, sans-serif); text-anchor: middle; }
    .node text.line { font: 11px var(--omg-graph-font, system-ui, sans-serif); fill: color-mix(in srgb, var(--_text) 75%, var(--_muted)); text-anchor: middle; }
    .node text.line .key { fill: var(--_muted); }
    .node.external text.label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 500; }
    .glyph { font-size: 11px; fill: var(--_muted); text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .affordance { cursor: pointer; }
    .affordance circle { fill: var(--_card); stroke: var(--_border); }
    .affordance:hover circle { fill: color-mix(in srgb, var(--_accent) 12%, var(--_card)); stroke: var(--_accent); }
    .affordance text { font-size: 12px; fill: var(--_text); text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .edge-delete circle { fill: #fff5f5; stroke: #c62828; }
    .edge-delete:hover circle { fill: #ffcdd2; stroke: #b71c1c; }
    .edge-delete text { fill: #b71c1c; font-size: 11px; }
    .handle { cursor: crosshair; }
    .handle circle { fill: #e8f5e9; stroke: #2e7d32; }
    .handle:hover circle, .handle.armed circle { fill: #c8e6c9; stroke: #1b5e20; }
    .badge rect { fill: #fff3e0; stroke: #ffb74d; }
    .badge text { font-size: 10px; fill: #8a5a00; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
    .ghost { pointer-events: none; }
    .ghost line { stroke: var(--_accent); stroke-width: 2; stroke-dasharray: 6 4; fill: none; }
    .ghost text { font-size: 11px; fill: var(--_accent); paint-order: stroke; stroke: var(--_bg); stroke-width: 4px; }
    .toolbar { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; }
    .toolbar button, .toolbar select { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid var(--_border); border-radius: 4px; background: var(--_card); color: var(--_text); cursor: pointer; }
    .toolbar button:hover { background: color-mix(in srgb, var(--_accent) 8%, var(--_card)); }
    .hint { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: var(--_muted); pointer-events: none; }
    .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--_muted); font-size: 12.5px; }
  `;

  @property({ attribute: false }) nodes: GraphViewNode[] = [];
  @property({ attribute: false }) edges: GraphViewEdge[] = [];
  @property({ type: String }) card: string = DEFAULT_CARD;
  @property({ attribute: false }) renderCard: CardRenderer | null = null;
  @property({ attribute: "label-fit" }) labelFit: LabelFit = DEFAULT_LABEL_FIT;
  @property({ type: String }) selected: string | null = null;
  @property({ type: Boolean }) canWrite = false;
  @property({ type: String }) connectSource: string | null = null;
  @property({ attribute: "edge-style" }) edgeStyle: EdgeStyle = "curved";
  @property({ type: String }) layout: LayoutMode = "force";
  @property({ attribute: false }) positions: ReadonlyMap<string, { x: number; y: number }> | null = null;
  /** Polylines for `fixed` layouts, by edge key: drawn as given (no routing, no easing). */
  @property({ attribute: false }) routes: ReadonlyMap<string, readonly { x: number; y: number }[]> | null = null;
  /** Keep the graph fitted until the user pans or zooms. */
  @property({ type: Boolean, attribute: "auto-fit" }) autoFit = false;
  @property({ type: Boolean }) edgeToggle = false;
  @property({ type: Boolean }) toolbar = true;
  /** Shown in the hint after "expand". */
  @property({ type: Number }) limit = 0;

  @state() private view: ViewTransform = initialView(600, 400);
  @state() private size = { w: 600, h: 400 };
  @state() private hoverEdge: string | null = null;
  @state() private hoverNode: string | null = null;
  @state() private selectedEdge: string | null = null;
  @state() private drag: Drag | null = null;
  @state() private pan: Pan | null = null;
  @state() private pointer: { x: number; y: number } | null = null;
  @state() private armed: string | null = null;
  @state() private connectTarget: string | null = null;

  private viewTouched = false;
  private readonly reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly linkForce: ForceLink<SimNode, SimLink>;
  private readonly config = forceConfig();
  private measure: Measure | null = null;
  private sized = new Map<string, Sized>();
  /** Measured HTML card boxes (graph units), keyed by node id; cleared when the renderer or a node's row changes. */
  private measured = new Map<string, { w: number; h: number }>();
  private measuredRows = new Map<string, Record<string, unknown>>();
  private resize: ResizeObserver | null = null;
  private lastShape = "";
  private routingSlow = false;
  private frame = 0;
  private lastTargets = new Map<string, number>();
  private readonly easer = new EdgeEaser();
  private lastFrameAt = 0;
  private tailFrame = 0;

  constructor() {
    super();
    const c = this.config;
    this.linkForce = forceLink<SimNode, SimLink>([]).id((d) => d.id).distance(c.link.distance).strength(c.link.strength);
    this.sim = forceSimulation<SimNode, SimLink>([])
      .force("link", this.linkForce)
      .force("charge", forceManyBody<SimNode>().strength(c.charge.strength).distanceMax(c.charge.distanceMax).theta(c.charge.theta))
      .force("x", forceX<SimNode>(c.gravity.x).strength(c.gravity.strength))
      .force("y", forceY<SimNode>(c.gravity.y).strength(c.gravity.strength))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r).strength(c.collide.strength))
      .alphaDecay(c.alphaDecay)
      .velocityDecay(c.velocityDecay)
      .on("tick", () => this.requestUpdate());
    this.sim.stop();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    if (typeof ResizeObserver === "function") {
      this.resize = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (!r || r.width === 0 || r.height === 0) return;
        this.size = { w: r.width, h: r.height };
        if (this.viewTouched) return;
        if (this.autoFit && this.nodes.length > 0) this.view = fitTransform(this.placed(), r.width, r.height);
        else this.view = initialView(r.width, r.height);
      });
      this.resize.observe(this);
    }
    this.addEventListener("keydown", this.onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resize?.disconnect();
    this.sim.stop();
    if (this.tailFrame) cancelAnimationFrame(this.tailFrame);
    this.tailFrame = 0;
    this.removeEventListener("keydown", this.onKey);
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("renderCard")) { this.measured.clear(); this.measuredRows.clear(); }
    if (changed.has("nodes") || changed.has("card") || changed.has("labelFit") || changed.has("renderCard")) this.resize_cards();
    if (changed.has("nodes") || changed.has("edges") || changed.has("card") || changed.has("labelFit") || changed.has("layout") || changed.has("positions") || changed.has("renderCard")) this.syncSimulation();
    if (changed.has("connectSource") && this.connectSource) {
      this.armed = this.connectSource;
      this.connectTarget = null;
    }
    // A selected edge that left the model (deleted, collapsed away) is no longer selected.
    if (changed.has("edges") && this.selectedEdge !== null && !this.edges.some((e) => e.key === this.selectedEdge)) this.selectedEdge = null;
    this.autoFitNow();
  }

  /** Under `autoFit`, while the user has not taken the camera: fit the cards as placed right now
   * (a changed layout, a settling simulation, a re-measured HTML card). Called before a render,
   * so the fit costs no extra frame. */
  private autoFitNow(): void {
    if (!this.autoFit || this.viewTouched || this.nodes.length === 0) return;
    const next = fitTransform(this.placed(), this.size.w, this.size.h);
    const v = this.view;
    if (Math.abs(next.k - v.k) > 1e-6 || Math.abs(next.tx - v.tx) > 0.01 || Math.abs(next.ty - v.ty) > 0.01) this.setView(next, false);
  }

  // ---- cards -------------------------------------------------------------------------------

  /** Every node's card content and text size under the renderer / template and the label fit; a node whose row changed is re-measured. */
  private resize_cards(): void {
    this.measure ??= canvasMeasure(LABEL_FIT.font);
    const next = new Map<string, Sized>();
    for (const n of this.nodes) {
      const c = cardContent(this.renderCard, this.card, n);
      const text = c.kind === "text" ? c.text : c.fallback;
      next.set(n.id, { text, size: sizeCard(text, this.labelFit, this.measure), html: c.kind === "html" ? c.html : null });
      if (this.measuredRows.get(n.id) !== n.row) { this.measured.delete(n.id); this.measuredRows.set(n.id, n.row); }
    }
    for (const id of [...this.measured.keys()]) if (!next.has(id)) { this.measured.delete(id); this.measuredRows.delete(id); }
    this.sized = next;
  }

  private sizeOf(id: string): { w: number; h: number } {
    const s = this.sized.get(id);
    if (!s) return { w: 150, h: 30 };
    return nodeSize(s.html ? this.measured.get(id) : undefined, s.size);
  }

  /** After a render: measure every HTML card's wrapper (in graph units) and, when a size changed, resize the node and re-render. */
  override updated(_changed: PropertyValues): void {
    const wrappers = this.renderRoot.querySelectorAll<HTMLElement>(".card-html");
    if (wrappers.length === 0) return;
    let dirty = false;
    for (const el of wrappers) {
      const id = el.dataset.id;
      if (!id) continue;
      const r = el.getBoundingClientRect();
      const w = r.width / this.view.k, h = r.height / this.view.k;
      const prev = this.measured.get(id);
      if (!prev || Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5) { this.measured.set(id, { w, h }); dirty = true; }
    }
    if (dirty) { this.lastShape = ""; this.syncSimulation(); this.requestUpdate(); }
  }

  // ---- simulation --------------------------------------------------------------------------

  private syncSimulation(): void {
    const current = new Map(this.sim.nodes().map((n) => [n.id, n]));
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const neighbours = new Map<string, string[]>();
    for (const e of this.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
      neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
    }
    const fixed = this.layout === "fixed";
    const nodes: SimNode[] = [];
    for (const node of this.nodes) {
      const { w, h } = this.sizeOf(node.id);
      let n = current.get(node.id);
      if (!n) {
        const near = (neighbours.get(node.id) ?? []).map((p) => current.get(p)).find((p) => p !== undefined);
        const a = Math.random() * Math.PI * 2;
        n = { id: node.id, x: (near?.x ?? 0) + Math.cos(a) * 60, y: (near?.y ?? 0) + Math.sin(a) * 60, r: 0 };
      }
      n.r = cardRadius(w, h, this.config.collide.margin);
      const fixedPos = fixed ? this.positions?.get(node.id) : undefined;
      if (node.pinned) { n.fx = node.pinned.x; n.fy = node.pinned.y; n.x = node.pinned.x; n.y = node.pinned.y; }
      else if (fixedPos) { n.fx = fixedPos.x; n.fy = fixedPos.y; n.x = fixedPos.x; n.y = fixedPos.y; }
      else if (!this.drag || this.drag.id !== node.id) { n.fx = undefined; n.fy = undefined; }
      nodes.push(n);
    }
    const links: SimLink[] = [];
    for (const e of this.edges) {
      if (e.from === e.to || !byId.has(e.from) || !byId.has(e.to) || e.pending === "add") continue;
      links.push({ key: e.key, source: e.from, target: e.to });
    }
    const shape = `${this.layout}#${nodes.map((n) => `${n.id}${n.fx ?? ""},${n.fy ?? ""}:${n.r.toFixed(0)}`).join("|")}#${links.map((l) => l.key).join("|")}`;
    this.sim.nodes(nodes);
    this.linkForce.links(links);
    if (shape === this.lastShape) return;
    this.lastShape = shape;
    if (fixed) { this.sim.stop(); this.requestUpdate(); return; }
    this.reheat(this.config.reheatAlpha);
  }

  private reheat(alpha: number): void {
    if (this.layout === "fixed") { this.requestUpdate(); return; }
    if (this.reduced) {
      this.sim.alpha(1).stop();
      this.sim.tick(300);
      this.requestUpdate();
    } else {
      this.sim.alpha(Math.max(this.sim.alpha(), alpha)).restart();
    }
  }

  private placed(): Placed[] {
    return this.sim.nodes().map((n) => ({ id: n.id, x: n.x, y: n.y, ...this.sizeOf(n.id) }));
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private setView(view: ViewTransform, touched = true): void {
    this.view = view;
    this.viewTouched = touched;
    this.emit<GraphViewDetail>("graph-view", { ...view });
  }

  private setHoverNode(id: string | null): void {
    if (this.hoverNode === id) return;
    this.hoverNode = id;
    this.emit<GraphHoverDetail>("graph-hover", { id });
  }

  private setHoverEdge(key: string | null): void {
    if (this.hoverEdge === key) return;
    this.hoverEdge = key;
    this.emit<GraphEdgeHoverDetail>("graph-edge-hover", { key });
  }

  private isTarget(id: string): boolean {
    const n = this.nodes.find((x) => x.id === id);
    return !!n && (n.kind ?? "document") !== "external";
  }

  // ---- pointer ---------------------------------------------------------------------------

  private graphPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.getBoundingClientRect();
    return toGraph(this.view, e.clientX - r.left, e.clientY - r.top);
  }

  /** A graph point in viewport px (the inverse of `graphPoint`), for a keyboard-confirmed connector's anchor. */
  private clientPoint(gx: number, gy: number): { clientX: number; clientY: number } {
    const r = this.getBoundingClientRect();
    return { clientX: r.left + gx * this.view.k + this.view.tx, clientY: r.top + gy * this.view.k + this.view.ty };
  }

  private deleteEdge(key: string): void {
    if (!this.canWrite) return;
    this.emit<GraphEdgeDeleteDetail>("graph-edge-delete", { key });
  }

  private onNodeDown(e: PointerEvent, id: string, handle = false): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this.focus();
    const node = this.sim.nodes().find((n) => n.id === id);
    if (!node) return;
    const g = this.graphPoint(e);
    const modifier = e.metaKey || e.ctrlKey;
    const connector = dragMode({ handle, modifier, canWrite: this.canWrite, armed: this.connectSource ?? this.armed }, id) === "connector";
    const pin = this.nodes.find((n) => n.id === id)?.pinned ?? null;
    this.drag = { id, pointerId: e.pointerId, connector, handle, moved: false, offX: node.x - g.x, offY: node.y - g.y, previous: pin ? { ...pin } : null, startX: g.x, startY: g.y, modifier };
    this.pointer = connector ? g : null;
  }

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
      this.setView(panBy(this.view, dx, dy));
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const g = this.graphPoint(e);
    if (!d.moved && Math.hypot(g.x - d.startX, g.y - d.startY) < 3) return;
    d.moved = true;
    if (d.connector) {
      this.pointer = g;
      const drop = connectorDrop(this.placed(), d.id, g.x, g.y, (p) => this.isTarget(p));
      this.connectTarget = drop.kind === "connect" ? drop.to : null;
      return;
    }
    const node = this.sim.nodes().find((n) => n.id === d.id);
    if (!node) return;
    node.fx = g.x + d.offX;
    node.fy = g.y + d.offY;
    if (this.reduced || this.layout === "fixed") { node.x = node.fx; node.y = node.fy; this.requestUpdate(); }
    else this.sim.alphaTarget(0.3).restart();
  }

  private onUp(e: PointerEvent): void {
    const pan = this.pan;
    if (pan && e.pointerId === pan.pointerId) {
      this.pan = null;
      if (!pan.moved) { this.selectedEdge = null; this.emit<GraphSelectDetail>("graph-select", { id: null }); this.emit<GraphEdgeSelectDetail>("graph-edge-select", { key: null }); }
      return;
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    this.pointer = null;
    const g = this.graphPoint(e);
    if (d.connector) {
      if (!d.moved) {
        if (d.handle) { this.armed = this.armed === d.id ? null : d.id; this.connectTarget = null; }
        else { this.armed = null; this.clickNode(d); }
        return;
      }
      this.armed = null;
      this.connectTarget = null;
      const drop = connectorDrop(this.placed(), d.id, g.x, g.y, (p) => this.isTarget(p));
      const at = { clientX: e.clientX, clientY: e.clientY };
      if (drop.kind === "connect") this.emit<GraphConnectDetail>("graph-connect", { from: drop.from, to: drop.to, ...at });
      else this.emit<GraphConnectEmptyDetail>("graph-connect-empty", { from: drop.from, x: drop.x, y: drop.y, ...at });
      return;
    }
    if (!this.reduced && this.layout !== "fixed") this.sim.alphaTarget(0);
    if (!d.moved) { this.clickNode(d); return; }
    const node = this.sim.nodes().find((n) => n.id === d.id);
    if (!node) return;
    this.emit<GraphPinDetail>("graph-pin", { id: d.id, x: node.fx ?? node.x, y: node.fy ?? node.y, previous: d.previous });
  }

  /** A click on a card: a ⌘-click with another node selected toggles an edge (`edgeToggle`), else selects. */
  private clickNode(d: Drag): void {
    if (this.edgeToggle && d.modifier && this.selected && this.selected !== d.id) {
      this.emit<GraphEdgeToggleDetail>("graph-edge-toggle", { from: this.selected, to: d.id, present: false });
      return;
    }
    this.selectedEdge = null;
    this.emit<GraphSelectDetail>("graph-select", { id: d.id });
  }

  private onEdgeClick(e: MouseEvent, edge: GraphViewEdge): void {
    e.stopPropagation();
    if (this.edgeToggle && (e.metaKey || e.ctrlKey) && edge.writable) {
      this.emit<GraphEdgeToggleDetail>("graph-edge-toggle", { key: edge.key, from: edge.from, to: edge.to, present: true });
      return;
    }
    this.selectedEdge = edge.key;
    this.emit<GraphEdgeSelectDetail>("graph-edge-select", { key: edge.key });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.getBoundingClientRect();
    this.setView(zoomAbout(this.view, wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX - r.left, e.clientY - r.top));
  }

  private zoom(factor: number): void {
    this.setView(zoomAbout(this.view, factor, this.size.w / 2, this.size.h / 2));
  }

  /** 1:1 with the origin centred — the user's choice, so `autoFit` stands down. */
  private home(): void {
    this.setView(initialView(this.size.w, this.size.h), this.autoFit);
  }

  /** Fit every card into the view; under `autoFit` this also hands the camera back to the element. */
  fit(): void {
    this.setView(fitTransform(this.placed(), this.size.w, this.size.h), !this.autoFit);
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
      const node = this.sim.nodes().find((n) => n.id === d.id);
      if (node) {
        node.fx = d.previous?.x;
        node.fy = d.previous?.y;
        this.reheat(this.config.reheatAlpha);
      }
    }
    this.requestUpdate();
  }

  private unpin(id: string): void {
    const previous = this.nodes.find((n) => n.id === id)?.pinned ?? null;
    if (!previous) return;
    this.emit<GraphUnpinDetail>("graph-unpin", { id, previous });
    const node = this.sim.nodes().find((n) => n.id === id);
    if (node) { node.fx = undefined; node.fy = undefined; }
    this.reheat(this.config.reheatAlpha);
  }

  private toggleExpand(id: string): void {
    const node = this.nodes.find((n) => n.id === id);
    if (!node || !node.expandable) return;
    if (node.expanded) this.emit<GraphIdDetail>("graph-collapse", { id });
    else this.emit<GraphIdDetail>("graph-expand", { id });
  }

  // ---- keyboard --------------------------------------------------------------------------

  private readonly onKey = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement | null)?.tagName === "SELECT") return;
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
        const next = sel ? nearestInDirection(placed, sel, dir) : placed[0]?.id ?? null;
        if (next) this.emit<GraphSelectDetail>("graph-select", { id: next });
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (source) {
        const to = this.connectTarget;
        this.armed = null;
        this.connectTarget = null;
        if (to && to !== source && this.isTarget(to)) {
          const n = this.sim.nodes().find((x) => x.id === to);
          this.emit<GraphConnectDetail>("graph-connect", { from: source, to, ...this.clientPoint(n?.x ?? 0, n?.y ?? 0) });
        } else {
          const n = this.sim.nodes().find((x) => x.id === source);
          const x = (n?.x ?? 0) + this.sizeOf(source).w, y = n?.y ?? 0;
          this.emit<GraphConnectEmptyDetail>("graph-connect-empty", { from: source, x, y, ...this.clientPoint(x, y) });
        }
      } else if (sel) this.emit<GraphIdDetail>("graph-open", { id: sel });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedEdge !== null) {
      e.preventDefault();
      this.deleteEdge(this.selectedEdge);
      return;
    }
    switch (e.key) {
      case "e": if (sel) { e.preventDefault(); this.toggleExpand(sel); } break;
      case "u":
      case "Backspace": if (sel) { e.preventDefault(); this.unpin(sel); } break;
      case "c": if (sel && this.canWrite && this.isTarget(sel)) { e.preventDefault(); this.armed = sel; this.connectTarget = null; } break;
      case "f": e.preventDefault(); this.fit(); break;
      case "+":
      case "=": e.preventDefault(); this.zoom(1.25); break;
      case "-": e.preventDefault(); this.zoom(1 / 1.25); break;
      case "0": e.preventDefault(); this.home(); break;
    }
  };

  // ---- rendering -------------------------------------------------------------------------

  private routeEdges(pos: Map<string, SimNode>): Map<string, EdgeRoute> {
    const edges = this.edges.filter((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to));
    const curved = this.edgeStyle === "curved";
    const hot = this.layout !== "fixed" && this.sim.alpha() > 0.1;
    const now = typeof performance === "undefined" ? 0 : performance.now();
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 16;
    this.lastFrameAt = now;
    this.frame++;
    const place = (id: string): Placed => { const n = pos.get(id)!; return { id, x: n.x, y: n.y, ...this.sizeOf(id) }; };
    const route = curved && (!this.routingSlow || !hot || this.frame % 2 === 0);
    const targets = new Map<string, number>();
    if (route) {
      const offsets = parallelOffsets(edges);
      const placed = this.placed();
      for (const e of edges) targets.set(e.key, edgePath(place(e.from), place(e.to), placed, { key: e.key, offset: offsets.get(e.key) ?? 0 }).offset);
      const spent = (typeof performance === "undefined" ? 0 : performance.now()) - now;
      if (spent > ROUTE_BUDGET_MS) this.routingSlow = true;
      else if (!hot) this.routingSlow = false;
      this.lastTargets = targets;
    } else {
      for (const e of edges) targets.set(e.key, curved ? this.lastTargets.get(e.key) ?? 0 : 0);
    }
    const eased = this.reduced ? this.easer.snap(targets) : this.easer.step(targets, dt);
    const routes = new Map<string, EdgeRoute>();
    const given = this.layout === "fixed" ? this.routes : null;
    for (const e of edges) {
      const poly = given?.get(e.key);
      const r = poly ? polylineRoute(poly) : null;
      routes.set(e.key, r ?? pathFromOffset(place(e.from), place(e.to), eased.get(e.key) ?? 0));
    }
    if (!this.reduced && !this.easer.settled(targets) && !this.tailFrame && typeof requestAnimationFrame === "function") {
      this.tailFrame = requestAnimationFrame(() => { this.tailFrame = 0; this.requestUpdate(); });
    }
    return routes;
  }

  private renderEdge(e: GraphViewEdge, route: EdgeRoute): TemplateResult {
    const hover = this.hoverEdge === e.key;
    const color = e.color ?? edgeKindColor(e.kind);
    const cls = [e.kind ?? "", e.style ?? "", e.pending ? "pending" : ""].join(" ");
    const strokeStyle = color ? `stroke: ${color}` : "";
    const fillStyle = color ? `fill: ${color}` : "";
    const selected = this.selectedEdge === e.key;
    const title = `${e.detail ?? `${e.from} → ${e.to}`}${e.label ? ` · ${e.label}` : ""}${e.pending ? ` (${e.pending === "add" ? "adding…" : "removing…"})` : e.writable && this.edgeToggle ? " — ⌘-click to remove" : ""}`;
    const stop = (ev: Event) => ev.stopPropagation();
    return svg`<g class="${hover ? "hover" : ""} ${selected ? "selected-edge" : ""} ${e.writable ? "writable" : ""}" @click=${(ev: MouseEvent) => this.onEdgeClick(ev, e)}
        @pointerenter=${() => this.setHoverEdge(e.key)} @pointerleave=${() => { if (this.hoverEdge === e.key) this.setHoverEdge(null); }}>
      <path class="edge ${cls}" d=${route.d} style=${strokeStyle}></path>
      <path class="head ${cls}" d=${arrowheadPath(route.end, route.tangent)} style=${fillStyle}></path>
      <path class="hit" d=${route.d}><title>${title}</title></path>
      ${(hover || selected) && e.label ? svg`<text class="edge-label" x=${route.mid.x} y=${route.mid.y - (selected && this.canWrite ? 14 : 7)} text-anchor="middle">${e.label}</text>` : nothing}
      ${selected && this.canWrite && !e.pending ? svg`<g class="affordance edge-delete" @pointerdown=${stop} @click=${(ev: Event) => { ev.stopPropagation(); this.deleteEdge(e.key); }}><title>delete this edge (Delete / Backspace)</title><circle cx=${route.mid.x} cy=${route.mid.y} r="8"></circle><text x=${route.mid.x} y=${route.mid.y}>✕</text></g>` : nothing}
    </g>`;
  }

  private renderNode(node: GraphViewNode, n: SimNode, sized: Sized): TemplateResult {
    const isRoot = node.emphasis === "root";
    const isSel = this.selected === node.id;
    const hover = this.hoverNode === node.id;
    const dragging = this.drag?.id === node.id;
    const external = (node.kind ?? "document") === "external";
    const source = (this.drag?.connector ? this.drag.id : null) ?? this.connectSource ?? this.armed;
    const more = node.truncated ?? 0;
    const toggleTarget = this.edgeToggle && this.selected !== null && this.selected !== node.id && !external;
    const cls = ["node", node.kind ?? "document", isRoot ? "root" : "", isSel ? "selected" : "", node.pinned ? "pinned" : "", dragging ? "dragging" : "", source === node.id ? "source" : "", this.connectTarget === node.id ? "target" : "", toggleTarget ? "toggle-target" : ""].join(" ");
    const stop = (ev: Event) => ev.stopPropagation();
    const { w, h } = this.sizeOf(node.id);
    const hw = w / 2, hh = h / 2;
    const lines = sized.size.labelLines;
    const labelTop = -hh + 19;
    const detailTop = labelTop + (lines.length - 1) * LABEL_FIT.lineHeight + 15;
    const tooltip = node.tooltip ?? sized.text.full.join("\n");
    return svg`<g class=${cls} part="card" transform=${`translate(${n.x},${n.y})`} data-id=${node.id} aria-selected=${isSel ? "true" : "false"}
        @pointerdown=${(ev: PointerEvent) => this.onNodeDown(ev, node.id)}
        @dblclick=${() => this.emit<GraphIdDetail>("graph-open", { id: node.id })}
        @pointerenter=${() => this.setHoverNode(node.id)} @pointerleave=${() => { if (this.hoverNode === node.id) this.setHoverNode(null); }}>
      <title>${tooltip}${node.pinned ? "\n(pinned)" : ""}${source === node.id ? "\nconnector armed" : ""}</title>
      <rect class="card" x=${-hw} y=${-hh} width=${w} height=${h} rx="8"></rect>
      ${sized.html
        ? svg`<foreignObject x=${-hw} y=${-hh} width=${Math.max(w, LABEL_FIT.expandMaxWidth)} height=${Math.max(h, 400)}><div xmlns="http://www.w3.org/1999/xhtml" class="card-html" data-id=${node.id}>${sized.html}</div></foreignObject>`
        : svg`<text class="label" x=${node.pinned ? -6 : 0} y=${labelTop}>${lines.map((l, i) => svg`<tspan x=${node.pinned ? -6 : 0} dy=${i === 0 ? 0 : LABEL_FIT.lineHeight}>${l}</tspan>`)}</text>
      ${sized.size.detail.map((l, i) => svg`<text class="line" x="0" y=${detailTop + i * 15}>${typeof l === "string" ? l : svg`<tspan class="key">${l.key}:</tspan> ${l.text}`}</text>`)}`}
      ${node.pinned ? svg`<text class="glyph" x=${hw - 12} y=${-hh + 10}>📌</text>` : nothing}
      ${node.pinned && (hover || isSel) ? svg`<g class="affordance" @pointerdown=${stop} @click=${(ev: Event) => { ev.stopPropagation(); this.unpin(node.id); }}><title>unpin (u)</title><circle cx=${hw} cy=${-hh} r="8"></circle><text x=${hw} y=${-hh}>✕</text></g>` : nothing}
      ${node.expandable ? svg`<g class="affordance" @pointerdown=${stop} @click=${(ev: Event) => { ev.stopPropagation(); this.toggleExpand(node.id); }}><title>${node.expanded ? "collapse (e)" : "expand (e)"}</title><circle cx=${hw} cy="0" r="8"></circle><text x=${hw} y="0">${node.expanded ? "⊖" : "⊕"}</text></g>` : nothing}
      ${isSel && this.canWrite && !external ? svg`<g class="affordance handle ${this.armed === node.id ? "armed" : ""}" @pointerdown=${(ev: PointerEvent) => this.onNodeDown(ev, node.id, true)} @dblclick=${stop}><title>drag to connect (click arms the keyboard connector; c)</title><circle cx=${-hw} cy="0" r="10"></circle><text x=${-hw} y="0">⟶</text></g>` : nothing}
      ${more > 0 ? svg`<g class="badge"><title>${more} more neighbour${more === 1 ? "" : "s"} not loaded</title><rect x=${hw - 34} y=${hh - 8} width="44" height="14" rx="7"></rect><text x=${hw - 12} y=${hh - 1}>+${more} more</text></g>` : nothing}
    </g>`;
  }

  override render() {
    const simNodes = this.sim.nodes();
    const pos = new Map(simNodes.map((n) => [n.id, n]));
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const source = (this.drag?.connector ? this.drag.id : null) ?? this.connectSource ?? this.armed;
    const src = source ? pos.get(source) : undefined;
    const connectorEnd = this.pointer ?? (this.connectTarget ? pos.get(this.connectTarget) : undefined);
    const ghost = src && connectorEnd ? connectorLine({ id: src.id, x: src.x, y: src.y, ...this.sizeOf(src.id) }, connectorEnd) : null;
    const routes = this.routeEdges(pos);
    const { k, tx, ty } = this.view;
    return html`
      <svg role="application" aria-label=${graphDescription(this.nodes, this.edges)} class=${this.pan?.moved ? "panning" : ""}
          @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${() => this.cancelDrag()}
          @pointerdown=${this.onCanvasDown} @wheel=${this.onWheel}>
        <g transform=${`translate(${tx},${ty}) scale(${k})`}>
          ${this.edges.map((e) => { const r = routes.get(e.key); return r ? this.renderEdge(e, r) : nothing; })}
          ${simNodes.map((n) => { const node = byId.get(n.id); const s = this.sized.get(n.id); return node && s ? this.renderNode(node, n, s) : nothing; })}
          ${ghost ? svg`<g class="ghost">
            <line x1=${ghost.x1} y1=${ghost.y1} x2=${ghost.x2} y2=${ghost.y2}></line>
            ${this.connectTarget ? nothing : svg`<text x=${ghost.hint.x} y=${ghost.hint.y}>${this.drag?.connector ? "drop here: find or create…" : "Enter: find or create…"}</text>`}
          </g>` : nothing}
        </g>
      </svg>
      ${this.nodes.length === 0 ? html`<div class="empty">no graph yet</div>` : nothing}
      ${this.toolbar ? html`<div class="toolbar">
        <button @click=${() => { this.edgeStyle = this.edgeStyle === "curved" ? "straight" : "curved"; }} title=${this.edgeStyle === "curved" ? "edges: curved around cards — switch to straight" : "edges: straight — switch to curved"}>${this.edgeStyle === "curved" ? "⤳" : "→"} edges</button>
        <select title="how a card fits its label" .value=${this.labelFit} @change=${(e: Event) => { this.labelFit = (e.target as HTMLSelectElement).value as LabelFit; this.emit<GraphLabelFitDetail>("graph-label-fit", { labelFit: this.labelFit }); }}>${LABEL_FITS.map((f) => html`<option value=${f} ?selected=${f === this.labelFit}>${f}</option>`)}</select>
        <button @click=${() => this.fit()} title="fit the graph to the view (f)">fit</button>
        <button @click=${() => this.home()} title="1:1 with the origin centred (0)">1:1</button>
      </div>` : nothing}
      <div class="hint">drag: move (pins) · ${this.canWrite ? "⌘/Ctrl-drag, the ⟶ handle or c: connect · " : ""}e / ⊕⊖: expand${this.limit ? ` ${this.limit} per side` : ""} / collapse · u: unpin · Enter: open · arrows: select · wheel: zoom · drag canvas: pan · f: fit · +/-/0${this.edgeToggle ? " · ⌘-click: toggle an edge" : ""}${this.canWrite ? " · click an edge, then ✕ or Delete: remove it" : ""}${source ? ` · connector from ${source} — drop on a node or Esc` : ""}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "omg-graph": OmgGraph }
}
