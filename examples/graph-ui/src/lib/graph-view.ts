// The graph model and its adapters to `<omg-graph>` (@omgbase/elements) — the
// pure half of <oqx-graph-pane>. This demo keeps its own model: nodes keyed by
// the `/`-rooted document path, STORED edges (`src` → `dst` = owner → target,
// what editing reasons about) per relationship, the view record (which
// relationships are drawn, the axis, the direction, the algorithm, the
// projection) and the edge edits in flight. The element draws a renderer-neutral
// view model — `GraphViewNode { id, row, pinned, tooltip }` and `GraphViewEdge {
// key, from, to, kind, color, pending, writable }` — so this module turns one
// into the other:
//
//   graphNodes(rows)                 the query hits as nodes (id, rooted path, fallback label, row)
//   cardTemplateFor(projection)      the title line's template: `{card|<label field>}` — a bare `card`
//                                    alias the query projects or computes wins, else the chosen label
//   cardTextFor(node, projection)    the card: that template over the row (else the de-rooted path)
//                                    and one `key: value` line per shown field (a keyed `CardLine`,
//                                    drawn with the key dimmer, the key kept whole when truncated)
//   cardTooltip(path, text, choice)  the path, then every shown value in full
//   viewNodes(nodes, projection, pins)  a loose node (lib/loose.ts) draws as kind `loose` with the note in its tooltip
//   viewEdges(edges, opts)           drawn the relationship's way round (`orientEdge`), keyed by the
//                                    STORED edge (`edgeKey`), coloured per relationship, `pending`
//                                    for in-flight toggles and the hover preview, `writable` per
//                                    the editability
//   computeGraph(input)              fetch the wanted relationships' edges, count them, find the
//                                    axis's loops, lay out with elk (positions as card CENTRES and,
//                                    for `layered`, the orthogonal routes) — or leave the placing to
//                                    the element's force simulation (`positions: null`)
//
// Sizes: elk needs each card's size before it places it; the element sizes a
// card from the same `CardText` with the same `sizeCard` and label fit, so the
// pane measures with `canvasMeasure(LABEL_FIT.font)` and the two agree.

import type { ElkNode } from "elkjs/lib/elk-api";
import { formatFull, formatValue, isPresent, renderCard, type CardText, type GraphViewEdge, type GraphViewNode, type Pin } from "@omgbase/elements/graph";
import type { Candidate, Direction, Row } from "./candidates.ts";
import { edgesFromValues, orientEdge, pairEdges, sequenceEdges, type GraphEdge } from "./edges.ts";
import { buildElkGraph, elkEdgeId, findCycles, readElkLayout, type ElkAlgorithm, type LayoutNode, type Point } from "./layout-elk.ts";
import { hitId, hitPath, rooted, unrooted } from "./paths.ts";
import type { EdgePreview } from "./preview.ts";
import type { ProjectionChoice } from "./projection.ts";
import type { EdgeCounts, LayoutAlgorithm, View } from "./view.ts";

// ---- the model -----------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  /** The `/`-rooted document path — the node's key, what edges name. */
  path: string;
  /** The fallback title line (the de-rooted path without `.md`) when the projection names no label field or the row lacks it. */
  label: string;
  /** The whole projected row — the cards read their fields from it. */
  row: Record<string, unknown>;
  /** Not one of the query's rows: found through the palette, created, or picked
   * as a connector's destination (lib/loose.ts); kept until the query re-runs. */
  loose?: boolean;
}

/** An optimistic edge: drawn dashed while its write is in flight. */
export interface PendingEdge extends GraphEdge {
  action: "add" | "remove";
}

/** The key of a STORED edge — the element's edge identity, stable whichever way the edge is drawn. */
export function edgeKey(e: Pick<GraphEdge, "src" | "dst" | "rel">): string {
  return `${e.rel} ${e.src}→${e.dst}`;
}

/** The query hits as nodes, keyed by the rooted path (what the server returns;
 * rooted again defensively; a hit without a path falls back to its id). */
export function graphNodes(rows: readonly Row[]): GraphNode[] {
  return rows.map((row) => {
    const rawPath = hitPath(row);
    const path = rawPath !== null ? rooted(rawPath) : hitId(row) ?? "";
    return { id: hitId(row) ?? path, path, label: fallbackLabel(path), row };
  });
}

/** The de-rooted path without `.md` — the title line when nothing better is projected. */
export function fallbackLabel(path: string): string {
  return unrooted(path).replace(/\.md$/, "");
}

// ---- cards ---------------------------------------------------------------------------------

/** A shown field's value on a card: the element's compact form, with an absent
 * value as `—` and an empty list as `[]` (a card line names its key, so an empty
 * value should still say something). */
export function lineValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v) && v.length === 0) return "[]";
  return formatValue(v);
}

/** The row key a query may project or compute to shape the cards with no settings:
 * `docs { select _path, _title, card: title + " · " + status }`. A BARE alias —
 * the user's namespace (a `_`-name is the engine's and an unknown one is
 * `filter_invalid`; a `$`-name is the language's and cannot be aliased), absent
 * when the query does not name it, and since OQX 0.27 an alias shadows a
 * same-named field, so it can be computed. */
export const CARD_KEY = "card";

/** The title line's template (`<omg-graph>`'s template language): `{card|<label
 * field>}` — the `card` alias when the row carries it, else the label the cards
 * panel chose; `{card}` alone when the label is the path. */
export function cardTemplateFor(choice: Pick<ProjectionChoice, "label">): string {
  return choice.label === null || choice.label === CARD_KEY ? `{${CARD_KEY}}` : `{${CARD_KEY}|${choice.label}}`;
}

/** The card for one node under a projection choice: the title template over the
 * row (else the fallback) on top, then one keyed line per shown field other than
 * the label (and other than `card` when it is the title); `full` carries the
 * label and `key: value` in full for the tooltip. */
export function cardTextFor(node: Pick<GraphNode, "label" | "row">, choice: ProjectionChoice): CardText {
  const title = renderCard(cardTemplateFor(choice), node.row, node.label);
  const titled = titleKey(node.row, choice);
  const keys = choice.shown.filter((k) => k !== choice.label && k !== titled);
  return {
    label: title.label,
    lines: keys.map((key) => ({ key, text: lineValue(node.row[key]) })),
    full: [title.full[0] ?? title.label, ...keys.map((key) => `${key}: ${formatFull(node.row[key])}`)],
  };
}

/** The row key the title line came from: `card` when the row carries it, else the chosen label (null = the path). */
export function titleKey(row: Record<string, unknown>, choice: Pick<ProjectionChoice, "label">): string | null {
  return isPresent(row[CARD_KEY]) ? CARD_KEY : choice.label;
}

/** The tooltip text: the path, the title's field when it differs from the path, then every shown field in full. */
export function cardTooltip(path: string, text: CardText, choice: ProjectionChoice, title: string | null = choice.label): string {
  const head = title !== null && text.label !== path ? `${path}\n${title}: ${text.full[0]}` : path;
  return [head, ...text.full.slice(1)].join("\n");
}

// ---- adapters to the element's view model -------------------------------------------------

/** The tooltip's last line on a loose node. */
export const LOOSE_NOTE = "(not in the query's result — added from the palette or a connector; gone when the query re-runs)";

export function viewNodes(nodes: readonly GraphNode[], projection: ProjectionChoice, pins: ReadonlyMap<string, Pin> = new Map()): GraphViewNode[] {
  return nodes.map((n) => {
    const tooltip = cardTooltip(n.path, cardTextFor(n, projection), projection, titleKey(n.row, projection));
    return { id: n.path, row: n.row, pinned: pins.get(n.path) ?? null, tooltip: n.loose ? `${tooltip}\n${LOOSE_NOTE}` : tooltip, ...(n.loose ? { kind: "loose" } : {}) };
  });
}

/** The direction a relationship's edges are drawn (and laid out) in: the axis as the view says, every other one as the candidate's default. */
export function directionFor(view: Pick<View, "layout">, candidates: readonly Pick<Candidate, "name" | "defaults">[], rel: string): Direction {
  if (rel === view.layout.axis) return view.layout.direction;
  return candidates.find((c) => c.name === rel)?.defaults.direction ?? "forward";
}

export interface ViewEdgeOptions {
  view: Pick<View, "layout">;
  candidates: readonly Pick<Candidate, "name" | "defaults">[];
  /** A colour per relationship (the picker's swatch). */
  colorFor: (rel: string) => string;
  /** Relationships whose drawn edges may be ⌘-clicked away. */
  writable: readonly string[];
  /** In-flight toggles: a `remove` marks its drawn edge, an `add` adds a dashed edge. */
  pending?: readonly PendingEdge[];
  /** What a ⌘-click would do under the pointer right now (lib/preview.ts). */
  preview?: EdgePreview<Pick<GraphNode, "path">> | null;
  /** How the UI names the modifier (`⌘` / `Ctrl`), for the titles. */
  modifier?: string;
}

/** The preview colours: an add is the accent, a remove the danger colour. */
export const PREVIEW_COLORS = { add: "#1565c0", remove: "#c62828" } as const;

/** The element's edges: every drawn STORED edge the relationship's way round, then
 * the in-flight adds, then the hover preview (an add as a new dashed edge, a
 * remove recolouring the drawn edge). Keys are the stored edges' (`edgeKey`), so
 * a `graph-edge-toggle` names the file that changes whichever way it was drawn. */
export function viewEdges(edges: readonly GraphEdge[], o: ViewEdgeOptions): GraphViewEdge[] {
  const mod = o.modifier ?? "⌘";
  const pendingByKey = new Map((o.pending ?? []).map((p) => [edgeKey(p), p.action]));
  const drawnKeys = new Set(edges.map(edgeKey));
  const previewKey = o.preview ? edgeKey({ src: o.preview.owner.path, dst: o.preview.target.path, rel: o.preview.rel }) : null;
  const out: GraphViewEdge[] = [];
  for (const e of edges) {
    const d = orientEdge(e, directionFor(o.view, o.candidates, e.rel));
    const key = edgeKey(e);
    const removing = pendingByKey.get(key) === "remove";
    const previewRemove = o.preview?.kind === "remove" && previewKey === key;
    const writable = o.writable.includes(e.rel);
    out.push({
      key, from: d.src, to: d.dst, kind: e.rel, label: e.rel,
      color: previewRemove ? PREVIEW_COLORS.remove : o.colorFor(e.rel),
      detail: previewRemove ? `${mod}-click to remove ${e.src} -[${e.rel}]-> ${e.dst}` : `${e.src} -[${e.rel}]-> ${e.dst}${writable && !removing ? ` — ${mod}-click to remove` : ""}`,
      writable,
      ...(removing || previewRemove ? { pending: "remove" as const } : {}),
    });
  }
  for (const p of o.pending ?? []) {
    if (p.action !== "add" || drawnKeys.has(edgeKey(p))) continue;
    const d = orientEdge(p, directionFor(o.view, o.candidates, p.rel));
    out.push({ key: edgeKey(p), from: d.src, to: d.dst, kind: p.rel, label: p.rel, color: o.colorFor(p.rel), detail: `${p.src} -[${p.rel}]-> ${p.dst}`, pending: "add" });
  }
  const pv = o.preview;
  if (pv && pv.kind === "add" && previewKey !== null && !drawnKeys.has(previewKey) && !pendingByKey.has(previewKey)) {
    const stored = { src: pv.owner.path, dst: pv.target.path, rel: pv.rel };
    const d = orientEdge(stored, directionFor(o.view, o.candidates, pv.rel));
    out.push({ key: `preview ${previewKey}`, from: d.src, to: d.dst, kind: pv.rel, label: `+ ${pv.rel}`, color: PREVIEW_COLORS.add, detail: `${mod}-click to add ${stored.src} -[${pv.rel}]-> ${stored.dst}`, pending: "add" });
  }
  return out;
}

// ---- fetch + layout ----------------------------------------------------------------------

export type EdgeFetcher = (candidate: Candidate, paths: string[]) => Promise<GraphEdge[]>;

export interface GraphInput {
  nodes: readonly GraphNode[];
  view: View;
  candidates: readonly Candidate[];
  /** One fetch per frontmatter / link relationship (the page's `query` tool call; the pane caches it). */
  fetch: EdgeFetcher | null;
  /** Each card's size, by path, as the element will draw it. */
  sizes: ReadonlyMap<string, { width: number; height: number }>;
  /** elk's `layout` (injected so the model is testable without the 1.5 MB bundle). */
  elk: (graph: ElkNode) => Promise<ElkNode>;
  /** Set to true by the caller when a newer compute started; the pending one gives up at its next await. */
  cancelled?: () => boolean;
}

export interface GraphModel {
  /** The drawn edges, STORED orientation, only the view's relationships. */
  edges: GraphEdge[];
  /** Edges among the shown nodes per relationship fetched (the drawn ones, the axis, a pair's members). */
  edgeCounts: EdgeCounts;
  /** The axis relationship's edges among the shown nodes (0 = nothing to order by); null without an axis. */
  axisEdges: number | null;
  /** The axis's loops among the shown documents (layered only). */
  cycles: string[][];
  layout: "elk" | "force";
  /** The algorithm that placed the nodes (`force` when an elk algorithm fell back). */
  algorithm: LayoutAlgorithm;
  fellBack: string | null;
  /** Card centres by path for the element's `fixed` layout; null under force (the element simulates). */
  positions: Map<string, Point> | null;
  /** elk's orthogonal routes for the axis edges, by the element's edge key (`layered` only). */
  routes: Map<string, Point[]> | null;
}

/** The relationships whose edges are needed: the drawn ones and the axis, plus —
 * so the empty-axis note can offer the switch — every inverse pair and its
 * members whenever one of the family is wanted. */
export function wantedRelationships(view: Pick<View, "edges" | "layout">, candidates: readonly Pick<Candidate, "name" | "pair">[]): string[] {
  const wanted = new Set(view.edges);
  if (view.layout.axis) wanted.add(view.layout.axis);
  for (const c of candidates) {
    if (!c.pair) continue;
    if (wanted.has(c.name) || wanted.has(c.pair.forward) || wanted.has(c.pair.backward)) {
      wanted.add(c.name); wanted.add(c.pair.forward); wanted.add(c.pair.backward);
    }
  }
  return [...wanted];
}

/** A laid-out elk graph as the element's `positions` (card centres; elk gives top-left corners). */
export function positionsOf(laid: { nodes: ReadonlyMap<string, { x: number; y: number; width: number; height: number }> }): Map<string, Point> {
  return new Map([...laid.nodes].map(([id, n]) => [id, { x: n.x + n.width / 2, y: n.y + n.height / 2 }]));
}

/** elk's routes (by elk edge id of the DRAWN edge) re-keyed by the element's edge key (of the STORED edge). */
export function routesOf(laid: { routes: ReadonlyMap<string, Point[]> }, edges: readonly GraphEdge[], orient: (e: GraphEdge) => GraphEdge): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const e of edges) {
    const r = laid.routes.get(elkEdgeId(orient(e)));
    if (r) out.set(edgeKey(e), r);
  }
  return out;
}

/** Fetch, count, find loops, lay out. Resolves to null when `cancelled()` turned true meanwhile. */
export async function computeGraph(input: GraphInput): Promise<GraphModel | null> {
  const { nodes, view, candidates } = input;
  const cancelled = input.cancelled ?? (() => false);
  const paths = nodes.map((n) => n.path);
  const shown = new Set(paths);
  const fetchFor = async (name: string): Promise<GraphEdge[]> => {
    const candidate = candidates.find((c) => c.name === name);
    if (!candidate || paths.length === 0 || candidate.pair) return [];
    if (candidate.kind === "sequence") return sequenceEdges(name, paths);
    // A projected relationship has no stored link rows: its edges are the rows' own values.
    if (candidate.projected) return edgesFromValues(name, nodes, shown).filter((e) => shown.has(e.src) && shown.has(e.dst));
    if (!input.fetch) return [];
    return (await input.fetch(candidate, paths)).filter((e) => shown.has(e.src) && shown.has(e.dst));
  };
  const names = wantedRelationships(view, candidates);
  const perRel = await Promise.all(names.map(async (name) => {
    const candidate = candidates.find((c) => c.name === name);
    if (candidate?.pair) {
      const members = await Promise.all([fetchFor(candidate.pair.forward), fetchFor(candidate.pair.backward)]);
      return pairEdges(name, candidate.pair, members.flat());
    }
    return fetchFor(name);
  }));
  if (cancelled()) return null;
  const all = perRel.flat();
  const edgeCounts: Record<string, number> = {};
  names.forEach((name, i) => { edgeCounts[name] = perRel[i]!.length; });
  const orient = (e: GraphEdge): GraphEdge => orientEdge(e, directionFor(view, candidates, e.rel));
  const layoutNodes: LayoutNode[] = nodes.map((n) => { const s = input.sizes.get(n.path) ?? { width: 150, height: 30 }; return { id: n.path, width: s.width, height: s.height }; });
  const drawnEdges = all.map(orient);
  const drawnOnly = drawnEdges.filter((e) => view.edges.includes(e.rel));
  const drawnStored = all.filter((e) => view.edges.includes(e.rel));
  let algorithm = view.layout.algorithm;
  let fellBack: string | null = null;
  let positions: Map<string, Point> | null = null;
  let routes: Map<string, Point[]> | null = null;
  let cycles: string[][] = [];
  let axisEdges: number | null = null;
  if (algorithm === "layered") {
    // Layered: only the axis's edges are layered (elk routes them); a loop is reported, not an error.
    const onAxis = drawnEdges.filter((e) => e.rel === view.layout.axis);
    axisEdges = onAxis.length;
    cycles = findCycles(paths, onAxis);
    const { graph } = buildElkGraph(layoutNodes, onAxis, "forward", "layered");
    const laid = readElkLayout(await input.elk(graph));
    if (cancelled()) return null;
    positions = positionsOf(laid);
    routes = routesOf(laid, drawnStored.filter((e) => e.rel === view.layout.axis), orient);
  } else if (algorithm !== "force") {
    // The other elk algorithms place the nodes from every drawn relationship; the element draws the edges.
    try {
      const { graph, synthetic } = buildElkGraph(layoutNodes, drawnOnly, "forward", algorithm as ElkAlgorithm);
      const laid = readElkLayout(await input.elk(graph), false);
      if (cancelled()) return null;
      for (const id of synthetic) laid.nodes.delete(id);
      positions = positionsOf(laid);
    } catch (e) {
      if (cancelled()) return null;
      fellBack = `${algorithm} could not lay this graph out (${e instanceof Error ? e.message : String(e)}) — showing force`;
      algorithm = "force";
    }
  }
  return { edges: drawnStored, edgeCounts, axisEdges, cycles, layout: positions ? "elk" : "force", algorithm, fellBack, positions, routes };
}
