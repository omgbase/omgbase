// <oqx-graph-pane>: the query hits as cards and the view's relationships as
// edges, drawn by `<omg-graph>` (@omgbase/elements) — the shared renderer with
// its obstacle-aware curved edges, pins, zoom and pan — wrapped in this demo's
// graph chrome: the relationship legend, the loop note, the empty-axis note, the
// edit banner and the ⌘-click preview. The pane owns the MODEL (lib/graph-view.ts):
// it fetches the wanted relationships' edges through the provided `fetchEdges`
// (the page wires it to the MCP `query` tool — nothing here talks to a server),
// lays the graph out with elkjs for the elk algorithms (positions and, for
// `layered`, the orthogonal routes are handed to the element as a `fixed`
// layout) or leaves the placing to the element's force simulation, and turns
// the result into the element's view model. The element owns the camera (auto-fit
// until the user pans or zooms), the cards' sizes and the pointer.
//
// Cards: `view.projection` says which projected field is the title line (null =
// the node's fallback label, the de-rooted path) and which fields are listed
// under it as `key: value` lines (`cardTextFor`), handed to the element through
// its `renderCard` hook; `labelFit` says how the title line fits (the element's
// three modes). elk needs the sizes first, so the pane measures each card with
// the element's own `sizeCard` + `canvasMeasure` — the same numbers the element
// draws with, so edges attach to the card border.
//
// Arrows: an edge is stored owner → target (`src` → `dst`, what editing reasons
// about) and DRAWN the way its relationship's direction says (lib/edges.ts
// `orientEdge`): the axis under the view's chosen direction, every other drawn
// relationship under its own default. The same oriented edges feed elk, so the
// layout flows the way the arrowheads point — flipping the direction flips both.
//
//   properties: nodes (GraphNode[]), view (View), candidates (Candidate[]),
//               fetchEdges ((candidate, paths) => Promise<GraphEdge[]>), selected (path | null),
//               armed (Candidate | null — the relationship being edited),
//               writable (string[] — relationships whose drawn edges can be ⌘-clicked away),
//               pending (PendingEdge[] — optimistic adds/removes, drawn dashed),
//               labelFit ("truncate" | "wrap" | "expand"; attribute label-fit),
//               canWrite (the element's connector gesture and edge deletion are offered),
//               edgeStyle ("curved" | "straight" — the element's; the toolbar's button reports back),
//               edgeGeneration (bump it to drop the edge cache and re-fetch — after a write)
//   events:     node-select  { node: GraphNode | null }
//               edge-toggle  { candidate, from: GraphNode, to: GraphNode, present } — ⌘-click on a node
//                            with a selection and an armed relationship, or on a drawn edge of a
//                            writable relationship; `from` is the OWNER (the document whose field
//                            stores the edge), `to` the document it refers to; `present` says whether
//                            the edge is drawn right now. Nothing is written here.
//               graph-state  GraphStateDetail (edges drawn, cycles, layout kind, busy, error, the axis's
//                            edge count and the count per fetched relationship)
//               axis-request { axis } / algorithm-request { algorithm } — the notes' one-click switches;
//                            the page hands them to the picker (the pane owns no overrides)
//               label-fit-change { labelFit } — the element's toolbar changed the fit; the page persists it
//               edge-style-change { edgeStyle } — the element's toolbar switched curved / straight
//               connect-request { from, to, anchor, edges } — a connector dropped on a node (or confirmed by
//                            keyboard): the two paths, the drop point in viewport px and the drawn STORED
//                            edges (what the page's relation picker reads its kinds from); nothing is written
//               connect-empty { from, anchor, edges } — a connector dropped on open canvas: the page finds or
//                            creates the destination
//               edge-delete  { edge } — the selected edge's ✕ or Delete: the drawn STORED edge; the page severs it
//   method:     fit() — the element's fit (the palette's action)
//
// Edit mode: while the modifier is held (tracked on window: keydown/keyup, and
// mousemove's metaKey/ctrlKey so a key pressed before the pointer arrived counts;
// reset on blur / hidden) with a selection and an armed relationship, the banner
// says what a click does and hovering another card (the element's `graph-hover`)
// previews the toggle (lib/preview.ts decides): an add as a dashed accent edge
// `+ rel`, a remove as the drawn edge recoloured and dashed. Hovering a writable
// edge with the modifier previews its removal too.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import "@omgbase/elements";
import type { GraphConnectDetail, GraphConnectEmptyDetail, GraphEdgeDeleteDetail, GraphEdgeHoverDetail, GraphEdgeStyleDetail, GraphEdgeToggleDetail, GraphHoverDetail, GraphLabelFitDetail, GraphPinDetail, GraphSelectDetail, GraphUnpinDetail, OmgGraph } from "@omgbase/elements";
import { DEFAULT_LABEL_FIT, LABEL_FIT, canvasMeasure, sizeCard, type EdgeStyle, type GraphViewNode, type LabelFit, type Measure, type Pin } from "@omgbase/elements/graph";
import type { Candidate } from "../lib/candidates.ts";
import type { GraphEdge } from "../lib/edges.ts";
import { ownerFor } from "../lib/edit.ts";
import { summarizeCycles } from "../lib/layout-elk.ts";
import { cardTextFor, computeGraph, edgeKey, viewEdges, viewNodes, type EdgeFetcher, type GraphModel, type GraphNode, type PendingEdge } from "../lib/graph-view.ts";
import { isDrawn, modified, modifierName, previewFor, type EdgePreview } from "../lib/preview.ts";
import { NO_PROJECTION, axisStatus, type EdgeCounts, type LayoutAlgorithm, type View } from "../lib/view.ts";
import { relationColor } from "./oqx-relationship-picker.ts";

export type { EdgeFetcher, GraphNode, PendingEdge } from "../lib/graph-view.ts";

export interface GraphStateDetail {
  edges: number;
  cycles: string[][];
  layout: "elk" | "force" | null;
  busy: boolean;
  error: string | null;
  /** The axis relationship's edges among the shown nodes (0 = nothing to order by); null without an axis. */
  axisEdges: number | null;
  /** Edges among the shown nodes per relationship the graph fetched (the drawn ones, the axis, and a pair's members). */
  edgeCounts: EdgeCounts;
}

export interface AxisRequestDetail { axis: string | null }
export interface AlgorithmRequestDetail { algorithm: LayoutAlgorithm }
export interface LabelFitChangeDetail { labelFit: LabelFit }

export interface EdgeToggleDetail {
  candidate: Candidate;
  from: GraphNode;
  to: GraphNode;
  present: boolean;
}

/** Where the connector was dropped, in viewport px (the page anchors its picker there). */
export type Anchor = { x: number; y: number };
export interface ConnectRequestDetail { from: string; to: string; anchor: Anchor; edges: GraphEdge[] }
export interface ConnectEmptyDetail { from: string; anchor: Anchor; edges: GraphEdge[] }
export interface EdgeDeleteDetail { edge: GraphEdge }
export interface EdgeStyleChangeDetail { edgeStyle: EdgeStyle }

const EMPTY_VIEW: View = { edges: [], layout: { axis: null, direction: "forward", algorithm: "force" }, projection: NO_PROJECTION };
const elk = new ELK();

@customElement("oqx-graph-pane")
export class OqxGraphPane extends LitElement {
  static override styles = css`
    :host { display: block; position: relative; min-height: 320px; border: 1px solid #d0d4dc; border-radius: 6px; overflow: hidden; font: 12px system-ui, sans-serif; color: #1e2430; }
    omg-graph { position: absolute; inset: 0; min-height: 0; --omg-graph-bg: #fafbfc; --omg-graph-card-border: #8a94a6; --omg-graph-accent: #1565c0; }
    /* a loose node (not one of the query's rows) is marked in its tooltip; the card itself draws like the others */
    .banner { position: absolute; left: 8px; right: 8px; top: 8px; padding: 6px 10px; border-radius: 4px; background: #fff3e0; color: #7a4a00; border: 1px solid #ffcc80; }
    .banner code { font-family: ui-monospace, monospace; }
    .banner.axis-empty { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .banner.axis-empty button { font: inherit; font-size: 12px; }
    .banner.quiet { top: auto; bottom: 40px; background: rgba(255,255,255,0.92); color: #5a6270; border-color: #e3e6ec; }
    /* the loop note: compact, never taller than a third of the canvas, dismissable */
    .banner.cycle { right: auto; max-width: min(640px, calc(100% - 16px)); font-size: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
    .cycle-head { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
    .cycle-actions { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .banner.cycle button { font: inherit; font-size: 12px; }
    .banner.cycle button.dismiss { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0 4px; }
    .cycle-list { margin: 6px 0 0; padding-left: 18px; max-height: min(30vh, 220px); overflow: auto; }
    .cycle-list li { margin: 2px 0; }
    .banner.edit { top: auto; bottom: 40px; background: #fff8e1; color: #6d4c00; border-color: #ffe082; }
    .banner.edit.active { background: #e3f2fd; color: #0d47a1; border-color: #64b5f6; font-weight: 500; }
    .banner.edit.active.remove { background: #ffebee; color: #b71c1c; border-color: #ef9a9a; }
    .banner.edit.hint { background: rgba(255,255,255,0.92); color: #5a6270; border-color: #e3e6ec; font-weight: normal; }
    .banner kbd { font: inherit; padding: 0 4px; border: 1px solid currentColor; border-radius: 3px; opacity: 0.8; }
    .overlay { position: absolute; right: 8px; bottom: 28px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); color: #5a6270; border: 1px solid #e3e6ec; pointer-events: none; }
    .error { position: absolute; left: 8px; right: 8px; bottom: 8px; padding: 6px 10px; border-radius: 4px; background: #fff5f5; color: #c62828; border: 1px solid #ef9a9a; }
    .legend { position: absolute; left: 8px; bottom: 28px; display: flex; gap: 10px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.9); border: 1px solid #e3e6ec; pointer-events: none; }
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
  /** How a card fits its label (the element's three modes); the default keeps the one-line cards. */
  @property({ attribute: "label-fit" }) labelFit: LabelFit = DEFAULT_LABEL_FIT;
  /** The element's connector gesture (⌘-drag, the ⟶ handle, `c`) and edge deletion (✕ / Delete) are offered. */
  @property({ type: Boolean }) canWrite = false;
  /** The element's edge style; its toolbar button reports a change back as `edge-style-change`. */
  @property({ attribute: "edge-style" }) edgeStyle: EdgeStyle = "curved";
  /** Bumped by the page after a write: the edge cache is dropped and every wanted relationship re-fetched. */
  @property({ type: Number }) edgeGeneration = 0;

  @state() private model: GraphModel | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  /** The loop note: expanded list, and the loops it was dismissed for (a different set shows it again). */
  @state() private cyclesOpen = false;
  @state() private cyclesDismissed = "";
  @state() private hovered: string | null = null;
  @state() private hoveredEdge: string | null = null;
  /** The platform modifier (⌘ / Ctrl) is held right now — see `trackModifier`. */
  @state() private modifier = false;
  /** Cards the user dragged (the element's `graph-pin`): they stay where they were put until unpinned. */
  @state() private pins: Map<string, Pin> = new Map();

  private generation = 0;
  private edgeCache = new Map<string, Promise<GraphEdge[]>>();
  /** The label measure (a canvas in the element's label font), made on first use. */
  private measureFn: Measure | null = null;

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

  // ---- the model ------------------------------------------------------------------

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("nodes") || changed.has("view") || changed.has("candidates") || changed.has("fetchEdges") || changed.has("labelFit") || changed.has("edgeGeneration")) {
      if (changed.has("nodes") || changed.has("fetchEdges") || changed.has("edgeGeneration")) this.edgeCache.clear();
      if (changed.has("nodes")) {
        const shown = new Set(this.nodes.map((n) => n.path));
        for (const p of [...this.pins.keys()]) if (!shown.has(p)) this.pins.delete(p);
      }
      void this.recompute();
    }
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private emitState(): void {
    const m = this.model;
    this.emit<GraphStateDetail>("graph-state", {
      edges: m?.edges.length ?? 0, cycles: m?.cycles ?? [], layout: m?.layout ?? null, busy: this.busy, error: this.error, axisEdges: m?.axisEdges ?? null, edgeCounts: m?.edgeCounts ?? {},
    });
  }

  /** The card sizes elk lays out — the element's own sizing over the same card text and label fit. */
  private sizes(nodes: readonly GraphNode[], view: View): Map<string, { width: number; height: number }> {
    this.measureFn ??= canvasMeasure(LABEL_FIT.font);
    const out = new Map<string, { width: number; height: number }>();
    for (const n of nodes) {
      const s = sizeCard(cardTextFor(n, view.projection), this.labelFit, this.measureFn);
      out.set(n.path, { width: s.width, height: s.height });
    }
    return out;
  }

  /** One fetch per frontmatter/link relationship, cached by name + node set. */
  private readonly cachedFetch: EdgeFetcher = (candidate, paths) => {
    if (!this.fetchEdges) return Promise.resolve([]);
    const key = `${candidate.name} ${paths.join("")}`;
    let p = this.edgeCache.get(key);
    if (!p) {
      p = this.fetchEdges(candidate, paths);
      this.edgeCache.set(key, p);
    }
    return p;
  };

  /** Fetch the wanted relationships' edges, lay out, and publish — dropping the
   * result if a newer recompute started meanwhile. */
  private async recompute(): Promise<void> {
    const gen = ++this.generation;
    const nodes = this.nodes;
    const view = this.view;
    this.busy = true;
    this.error = null;
    this.emitState();
    try {
      const model = await computeGraph({
        nodes, view, candidates: this.candidates, fetch: this.fetchEdges ? this.cachedFetch : null,
        sizes: this.sizes(nodes, view), elk: (graph: ElkNode) => elk.layout(graph), cancelled: () => gen !== this.generation,
      });
      if (gen !== this.generation || model === null) return;
      this.model = model;
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

  /** The element's fit (the palette's "fit the graph" action). */
  fit(): void {
    this.renderRoot.querySelector<OmgGraph>("omg-graph")?.fit();
  }

  /** The drawn STORED edges (the model's), for the connector's relation kinds. */
  private drawn(): GraphEdge[] {
    return [...(this.model?.edges ?? [])];
  }

  private onConnect(e: CustomEvent<GraphConnectDetail>): void {
    this.emit<ConnectRequestDetail>("connect-request", { from: e.detail.from, to: e.detail.to, anchor: { x: e.detail.clientX, y: e.detail.clientY }, edges: this.drawn() });
  }

  private onConnectEmpty(e: CustomEvent<GraphConnectEmptyDetail>): void {
    this.emit<ConnectEmptyDetail>("connect-empty", { from: e.detail.from, anchor: { x: e.detail.clientX, y: e.detail.clientY }, edges: this.drawn() });
  }

  /** The element asked to delete the selected edge (by its key): the stored edge, when it is one of the model's. */
  private onEdgeDelete(e: CustomEvent<GraphEdgeDeleteDetail>): void {
    const edge = (this.model?.edges ?? []).find((x) => edgeKey(x) === e.detail.key);
    if (edge) this.emit<EdgeDeleteDetail>("edge-delete", { edge });
  }

  private nodeAt(path: string | null): GraphNode | undefined {
    return path === null ? undefined : this.nodes.find((n) => n.path === path);
  }

  private select(node: GraphNode | null): void {
    this.selected = node?.path ?? null;
    this.emit("node-select", { node });
  }

  /** The edge a ⌘-click would toggle right now, if the pointer is over one. */
  private preview(): EdgePreview<GraphNode> | null {
    const edges = this.model?.edges ?? [];
    return previewFor({
      modifier: this.modifier,
      nodes: this.nodes,
      selected: this.selected,
      armed: this.armed,
      hovered: this.hovered,
      hoveredEdge: this.hoveredEdge === null ? null : edges.find((e) => edgeKey(e) === this.hoveredEdge) ?? null,
      writable: this.writable,
      edges,
    });
  }

  /** The element's ⌘-click: on a drawn edge (`present`, by key) → remove it; on a
   * node with another selected → toggle the armed relationship between the two
   * (the candidate's direction says which one owns the edge). */
  private onEdgeToggle(e: CustomEvent<GraphEdgeToggleDetail>): void {
    const edges = this.model?.edges ?? [];
    if (e.detail.present && e.detail.key !== undefined) {
      const edge = edges.find((x) => edgeKey(x) === e.detail.key);
      if (!edge || !this.writable.includes(edge.rel)) return;
      const candidate = this.candidates.find((c) => c.name === edge.rel);
      const from = this.nodeAt(edge.src), to = this.nodeAt(edge.dst);
      if (!candidate || !from || !to) return;
      this.emit<EdgeToggleDetail>("edge-toggle", { candidate, from, to, present: true });
      return;
    }
    const selected = this.nodeAt(e.detail.from), target = this.nodeAt(e.detail.to);
    if (!this.armed || !selected || !target || selected.path === target.path) return;
    const { owner, other } = ownerFor(this.armed.defaults.direction, selected, target);
    this.emit<EdgeToggleDetail>("edge-toggle", { candidate: this.armed, from: owner, to: other, present: isDrawn(edges, this.armed.name, owner.path, other.path) });
  }

  private requestAxis(axis: string | null): void {
    this.emit<AxisRequestDetail>("axis-request", { axis });
  }

  private requestAlgorithm(algorithm: LayoutAlgorithm): void {
    this.emit<AlgorithmRequestDetail>("algorithm-request", { algorithm });
  }

  // ---- render -----------------------------------------------------------------

  protected override render() {
    const m = this.model;
    const edges = m?.edges ?? [];
    const axis = this.view.layout.axis;
    const arming = this.armed !== null && this.selected !== null;
    // Edit mode: the modifier is held with a selection and an armed relationship.
    const editMode = this.modifier && arming;
    const preview = this.preview();
    const mod = modifierName();
    const colorFor = (rel: string) => relationColor(this.candidates, rel);
    const previews = this.pending.filter((p) => p.action === "add");
    const rels = [...new Set([...edges, ...previews].map((e) => e.rel))];
    const fixed = m !== null && m.positions !== null;
    const projection = this.view.projection;
    const byPath = new Map(this.nodes.map((n) => [n.path, n]));
    const renderCard = (n: GraphViewNode) => cardTextFor(byPath.get(n.id) ?? { label: n.id, row: n.row }, projection);
    return html`
      <omg-graph auto-fit edgeToggle ?canWrite=${this.canWrite}
        .nodes=${viewNodes(this.nodes, projection, this.pins)}
        .edges=${viewEdges(edges, { view: this.view, candidates: this.candidates, colorFor, writable: this.writable, pending: this.pending, preview, modifier: mod })}
        .renderCard=${renderCard} .labelFit=${this.labelFit} .selected=${this.selected} .edgeStyle=${this.edgeStyle}
        .layout=${fixed ? "fixed" : "force"} .positions=${m?.positions ?? null} .routes=${m?.routes ?? null}
        @graph-select=${(e: CustomEvent<GraphSelectDetail>) => this.select(this.nodeAt(e.detail.id) ?? null)}
        @graph-edge-toggle=${this.onEdgeToggle}
        @graph-connect=${this.onConnect}
        @graph-connect-empty=${this.onConnectEmpty}
        @graph-edge-delete=${this.onEdgeDelete}
        @graph-edge-style=${(e: CustomEvent<GraphEdgeStyleDetail>) => { this.edgeStyle = e.detail.edgeStyle; this.emit<EdgeStyleChangeDetail>("edge-style-change", { edgeStyle: e.detail.edgeStyle }); }}
        @graph-hover=${(e: CustomEvent<GraphHoverDetail>) => { this.hovered = e.detail.id; }}
        @graph-edge-hover=${(e: CustomEvent<GraphEdgeHoverDetail>) => { this.hoveredEdge = e.detail.key; }}
        @graph-pin=${(e: CustomEvent<GraphPinDetail>) => { this.pins = new Map(this.pins).set(e.detail.id, { x: e.detail.x, y: e.detail.y }); }}
        @graph-unpin=${(e: CustomEvent<GraphUnpinDetail>) => { const next = new Map(this.pins); next.delete(e.detail.id); this.pins = next; }}
        @graph-label-fit=${(e: CustomEvent<GraphLabelFitDetail>) => { this.labelFit = e.detail.labelFit; this.emit<LabelFitChangeDetail>("label-fit-change", { labelFit: e.detail.labelFit }); }}></omg-graph>
      ${this.renderBanner(preview, editMode, mod)}
      ${this.renderAxisNote()}
      ${this.renderCycleNote(axis)}
      ${m?.fellBack ? html`<div class="banner quiet" data-banner="fell-back">${m.fellBack}</div>` : nothing}
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
      ${rels.length > 0 ? html`<div class="legend">${rels.map((r) => html`<span><i style="background:${colorFor(r)}"></i>${r}${r === axis ? " (axis)" : ""}</span>`)}</div>` : nothing}
      ${editMode || preview
        ? html`<div class="legend styles" title="edge styles while editing"><span class="add"><i></i>will add</span><span class="remove"><i></i>will remove</span><span class="pending"><i></i>writing…</span></div>`
        : html`<div class="overlay">${this.busy ? "laying out…" : `${this.nodes.length} nodes · ${edges.length} edges · ${m?.algorithm ?? "—"}`}</div>`}
    `;
  }

  /** The loop note. A strict order needs no loops; `axis` has some among the
   * shown documents, so the layered layout broke them (drawing a few edges
   * against the flow) to place the rest. Say that in one line, offer layouts that
   * do not need an order, let the list be opened (names, not paths, capped), and
   * let the note be dismissed — for THESE loops: a different set shows it again. */
  private renderCycleNote(axis: string | null) {
    const cycles = this.model?.cycles ?? [];
    if (cycles.length === 0 || axis === null || this.view.layout.algorithm !== "layered") return nothing;
    const signature = `${axis}|${cycles.map((c) => c.join(",")).join(";")}`;
    if (signature === this.cyclesDismissed) return nothing;
    const s = summarizeCycles(cycles);
    const loops = s.groups === 1 ? "one loop" : `${s.groups} loops`;
    return html`<div class="banner cycle" data-banner="cycles" role="status">
      <div class="cycle-head">
        <span><b>${axis}</b> loops back on itself — ${s.nodes} documents in ${loops} that reach each other, so a left-to-right order has to draw a few edges backwards.</span>
        <span class="cycle-actions">
          <button type="button" data-layout="stress" title="elk stress: distance follows graph distance, no order needed" @click=${() => this.requestAlgorithm("stress")}>stress layout</button>
          <button type="button" data-layout="force" title="force-directed: no order needed" @click=${() => this.requestAlgorithm("force")}>force layout</button>
          <button type="button" data-action="details" aria-expanded=${this.cyclesOpen ? "true" : "false"} @click=${() => { this.cyclesOpen = !this.cyclesOpen; }}>${this.cyclesOpen ? "hide" : "which ones?"}</button>
          <button type="button" class="dismiss" data-action="dismiss" aria-label="dismiss" title="dismiss until the loops change" @click=${() => { this.cyclesDismissed = signature; this.cyclesOpen = false; }}>✕</button>
        </span>
      </div>
      ${this.cyclesOpen ? html`<ul class="cycle-list">
        ${s.listed.map((g) => html`<li>${g.names.map((n, i) => html`${i > 0 ? ", " : ""}<code title=${n.path}>${n.name}</code>`)}${g.more > 0 ? html` … and ${g.more} more` : nothing}</li>`)}
        ${s.moreGroups > 0 ? html`<li>… and ${s.moreGroups} more ${s.moreGroups === 1 ? "loop" : "loops"}</li>` : nothing}
      </ul>` : nothing}
    </div>`;
  }

  /** The axis has no edges among the shown documents (nothing to order by) —
   * say so and offer the relationships that do; or the force layout has no
   * drawn edges — the nodes only repel. */
  private renderAxisNote() {
    const axis = this.view.layout.axis;
    const algorithm = this.view.layout.algorithm;
    const m = this.model;
    if (this.busy || !m || this.nodes.length < 2) return nothing;
    // Only the layered layout reads the axis; every other one is told by its own name in the overlay.
    if (algorithm !== "layered") {
      if (m.edges.length > 0 || algorithm !== "force") return nothing;
      return html`<div class="banner quiet" data-banner="no-edges">no edges drawn — nodes only repel; pick a relationship (the picker's <b>edge</b> column) to connect them</div>`;
    }
    const status = axisStatus(axis, this.candidates, m.edgeCounts, this.nodes.length);
    if (!status.empty) return nothing;
    return html`<div class="banner axis-empty" data-banner="axis-empty" role="status">
      <span><code>${axis}</code> has no edges here — nothing to order by.</span>
      ${status.alternatives.map((a) => html`<button type="button" data-switch=${a.name} @click=${() => this.requestAxis(a.name)}>lay out along <code>${a.name}</code> (${a.edges})</button>`)}
      <button type="button" data-switch="" @click=${() => this.requestAxis(null)}>no axis (force)</button>
    </div>`;
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

declare global {
  interface HTMLElementTagNameMap { "oqx-graph-pane": OqxGraphPane }
}
