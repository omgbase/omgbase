// The graph projection: a bounded, progressively expanded neighbourhood of
// documents joined by the `links` rows lib/links.ts already reads. The model is
// renderer-neutral and immutable — every function returns a NEW model — so a
// signal can hold it and a `view`/`query` command (lib/graph-commands.ts) can
// swap whole models for undo/redo.
//
// A node is a document (`kind: "document"`, keyed by its rooted `_path`) or an
// external destination (`kind: "external"`, keyed by its URL; never expandable).
// An edge is ONE authored link row projected onto the node pair: its
// `provenance` says where it was authored (`frontmatter` field, `body` link —
// a `[text](/x.md)` or an inline `key:: /x.md` field — or `external` for a URL
// destination) and keeps the field / block id / URL so the inspector can state
// exactly what the line stands for (`provenanceText`). Rendered edges are not
// writable by themselves — the connector's write side is lib/relations.ts.
//
// Expansion is bounded: `withNeighborhood` adds at most `limit` NEW neighbours
// per direction (edges to nodes already in the model are free) and records the
// number left out in `truncated` so the pane can show "+k more". Pins
// (`pinned`) are presentation state: they live only in this model, never in a
// document.
//
// Titles arrive by one batched query the page runs after an expansion:
// `titlesQuery(paths)` → `docs { select _path, _title where _path in (…) }`
// (`x in (a, b)` is OQX's tuple membership, GRAMMAR §4 / SEMANTICS §9; a
// single path is `_path == …` because `(x)` alone is grouping, not a tuple),
// and `applyTitles(model, hits)` folds the `_title` of each hit back in.
//
// The pure geometry helpers at the end (hit-testing, direction stepping, the
// fit transform, the arrow endpoint, the obstacle-aware edge routing) are what
// <graph-pane> uses for its pointer, keyboard and drawing math, kept here so
// they are testable without a DOM.

import type { Hit, OmgClient } from "@omgbase/client";
import { inboundQuery, linkRowsOf, outboundQuery, wikiStem, type DocLinks, type LinkRow } from "./links.ts";
import { rooted } from "./paths.ts";

// ---- the model -----------------------------------------------------------------------

export type Provenance = "frontmatter" | "body" | "external";
export type NodeKind = "document" | "external";

export interface Pin { x: number; y: number }

export interface GraphNode {
  /** A document's rooted path, or an external node's URL. */
  path: string;
  kind: NodeKind;
  /** The engine id when a link row carried it (`_dst_id`), else null. */
  id: string | null;
  title: string;
  /** Whether `title` came from the engine (`_title`) rather than the path's stem. */
  titled: boolean;
  /** Session-local layout pin — presentation state, never written anywhere. */
  pinned: Pin | null;
  /** Its neighbourhood has been loaded into the model. */
  expanded: boolean;
  /** Link counts known after expansion (null before). */
  degree: { in: number | null; out: number | null };
}

export interface GraphEdge {
  /** `${from}→${to}#${field ?? ""}|${blockId ?? ""}`. */
  key: string;
  from: string;
  to: string;
  provenance: Provenance;
  /** The frontmatter (or inline) field the link was authored in; null for a body link. */
  field: string | null;
  blockId: string | null;
  /** The URL of an external destination. */
  uri: string | null;
}

export interface GraphModel {
  root: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Expanded path → how many neighbours were left out by the bound. */
  truncated: Map<string, number>;
}

export const DEFAULT_LIMIT = 12;

export function emptyModel(root: string): GraphModel {
  const path = rooted(root);
  return { root: path, nodes: new Map([[path, documentNode(path, null)]]), edges: new Map(), truncated: new Map() };
}

function copy(model: GraphModel): GraphModel {
  return { root: model.root, nodes: new Map(model.nodes), edges: new Map(model.edges), truncated: new Map(model.truncated) };
}

function documentNode(path: string, id: string | null): GraphNode {
  return { path, kind: "document", id, title: wikiStem(path), titled: false, pinned: null, expanded: false, degree: { in: null, out: null } };
}

/** A URL's display title: host and path, no scheme, no trailing slash. */
export function externalTitle(uri: string): string {
  try {
    const u = new URL(uri);
    const p = u.pathname.replace(/\/$/, "");
    return `${u.host}${p}${u.search}`;
  } catch {
    return uri;
  }
}

function externalNode(uri: string, id: string | null): GraphNode {
  return { path: uri, kind: "external", id, title: externalTitle(uri), titled: true, pinned: null, expanded: true, degree: { in: null, out: 0 } };
}

export function edgeKey(from: string, to: string, field: string | null, blockId: string | null): string {
  return `${from}→${to}#${field ?? ""}|${blockId ?? ""}`;
}

/** The destination a link row projects to: a document path, a URL, or nothing (dangling / phantom). */
export function rowDestination(row: LinkRow): { path: string; kind: NodeKind } | null {
  if (row.dstPath) return { path: row.dstPath, kind: "document" };
  if (row.uri) return { path: row.uri, kind: "external" };
  return null;
}

/** A row's provenance in the model's three words. */
export function rowProvenance(row: LinkRow, kind: NodeKind): Provenance {
  if (kind === "external") return "external";
  return row.provenance === "frontmatter" ? "frontmatter" : "body";
}

/** The edge a row projects to. An inbound row (`inboundQuery`) carries no
 * `_dst_path` — the query selected it by one — so its destination is passed in. */
export function edgeOf(row: LinkRow, inboundTo?: string): GraphEdge | null {
  const dst = inboundTo !== undefined ? { path: rooted(inboundTo), kind: "document" as NodeKind } : rowDestination(row);
  if (!dst) return null;
  return {
    key: edgeKey(row.path, dst.path, row.field, row.blockId),
    from: row.path,
    to: dst.path,
    provenance: rowProvenance(row, dst.kind),
    field: row.field,
    blockId: row.blockId,
    uri: dst.kind === "external" ? dst.path : null,
  };
}

interface Candidate { path: string; kind: NodeKind; id: string | null; edges: GraphEdge[] }

/** Group a direction's rows by the neighbour they name (row order kept), dropping dangling rows and self-loops. */
function candidates(rows: readonly LinkRow[], side: "in" | "out", self: string): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const row of rows) {
    const edge = side === "out" ? edgeOf(row) : edgeOf(row, self);
    if (!edge || edge.from === edge.to) continue;
    const neighbour = side === "out" ? rowDestination(row)! : { path: row.path, kind: "document" as NodeKind };
    const c = out.get(neighbour.path) ?? { path: neighbour.path, kind: neighbour.kind, id: side === "out" ? row.dstId : null, edges: [] };
    if (!c.edges.some((e) => e.key === edge.key)) c.edges.push(edge);
    out.set(neighbour.path, c);
  }
  return [...out.values()];
}

/** The model with `path`'s neighbourhood loaded from its link rows: at most
 * `limit` new neighbours per direction (the rest counted in `truncated`), every
 * edge keyed and deduplicated, the node marked expanded with its degrees. */
export function withNeighborhood(model: GraphModel, path: string, links: DocLinks, opts: { limit?: number } = {}): GraphModel {
  const limit = Math.max(0, opts.limit ?? DEFAULT_LIMIT);
  const p = rooted(path);
  const next = copy(model);
  const outC = candidates(links.outbound, "out", p);
  const inC = candidates(links.inbound, "in", p);
  const self = next.nodes.get(p) ?? documentNode(p, null);
  next.nodes.set(p, { ...self, expanded: true, degree: { in: inC.reduce((n, c) => n + c.edges.length, 0), out: outC.reduce((n, c) => n + c.edges.length, 0) } });
  let left = 0;
  for (const side of [outC, inC]) {
    let added = 0;
    for (const c of side) {
      const present = next.nodes.has(c.path);
      if (!present && added >= limit) { left++; continue; }
      if (!present) {
        next.nodes.set(c.path, c.kind === "external" ? externalNode(c.path, c.id) : documentNode(c.path, c.id));
        added++;
      } else if (c.id && !next.nodes.get(c.path)!.id) {
        next.nodes.set(c.path, { ...next.nodes.get(c.path)!, id: c.id });
      }
      for (const e of c.edges) next.edges.set(e.key, e);
    }
  }
  if (left > 0) next.truncated.set(p, left);
  else next.truncated.delete(p);
  return next;
}

/** The model without a node and its edges (the root included, if asked). */
export function removeNode(model: GraphModel, path: string): GraphModel {
  const next = copy(model);
  next.nodes.delete(path);
  next.truncated.delete(path);
  for (const [k, e] of next.edges) if (e.from === path || e.to === path) next.edges.delete(k);
  return next;
}

/** The model with `path` collapsed: no longer expanded, its `truncated` entry
 * cleared, and every node that nothing now explains removed with its edges. A
 * node is explained when it is reached from the root by walking OUT of expanded
 * nodes only (the root's neighbours if the root is expanded, then the
 * neighbours of each reached node that is itself expanded, …), so a neighbour
 * that also hangs off another reachable expanded node stays and a collapsed
 * root shows alone. An edge stays only when one of its ends is a retained
 * expanded node (the expansion that loaded it). Pins leave with their nodes. */
export function collapseNode(model: GraphModel, path: string): GraphModel {
  const p = rooted(path);
  const node = model.nodes.get(p);
  if (!node) return model;
  const next = copy(model);
  next.nodes.set(p, { ...node, expanded: false, degree: { in: null, out: null } });
  next.truncated.delete(p);
  const keep = new Set<string>([next.root]);
  const queue = [next.root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (!next.nodes.get(cur)?.expanded) continue;
    for (const n of neighborsOf(next, cur)) {
      if (keep.has(n)) continue;
      keep.add(n);
      queue.push(n);
    }
  }
  for (const k of next.nodes.keys()) if (!keep.has(k)) { next.nodes.delete(k); next.truncated.delete(k); }
  for (const [k, e] of next.edges) {
    const explained = (next.nodes.get(e.from)?.expanded ?? false) || (next.nodes.get(e.to)?.expanded ?? false);
    if (!explained || !next.nodes.has(e.from) || !next.nodes.has(e.to)) next.edges.delete(k);
  }
  return next;
}

export function setPin(model: GraphModel, path: string, pin: Pin | null): GraphModel {
  const node = model.nodes.get(path);
  if (!node) return model;
  const next = copy(model);
  next.nodes.set(path, { ...node, pinned: pin ? { x: pin.x, y: pin.y } : null });
  return next;
}

export function edgesOf(model: GraphModel, path: string): GraphEdge[] {
  return [...model.edges.values()].filter((e) => e.from === path || e.to === path);
}

/** The distinct nodes joined to `path` by any edge, in edge order. */
export function neighborsOf(model: GraphModel, path: string): string[] {
  const out: string[] = [];
  for (const e of edgesOf(model, path)) {
    const other = e.from === path ? e.to : e.from;
    if (other !== path && !out.includes(other)) out.push(other);
  }
  return out;
}

/** The short label drawn on a hovered edge. */
export function edgeLabel(edge: GraphEdge): string {
  if (edge.provenance === "external") return `→ ${edge.uri ?? edge.to}`;
  if (edge.field) return edge.provenance === "frontmatter" ? edge.field : `${edge.field} (inline)`;
  return "body link";
}

/** Where the relationship was authored, for the inspector. */
export function provenanceText(edge: GraphEdge): string {
  const where = edge.blockId ? `block ${edge.blockId} of ${edge.from}` : edge.from;
  if (edge.provenance === "external") {
    return edge.field ? `an external link to ${edge.uri} authored in frontmatter field \`${edge.field}\` of ${edge.from}` : `an external link to ${edge.uri} in ${where}`;
  }
  if (edge.provenance === "frontmatter") return `authored in frontmatter field \`${edge.field}\` of ${edge.from}`;
  if (edge.field) return `an inline field \`${edge.field}\` in ${where}`;
  return `a link in ${where}`;
}

export interface EdgeDetail {
  /** `/a.md → /b.md`. */
  direction: string;
  provenance: Provenance;
  text: string;
  /** For a frontmatter field: how many edges that field holds from the same source (its list size as the model sees it); null otherwise. */
  cardinality: number | null;
  /** Whether the link's storage is known precisely enough to write back (a URL destination is not). */
  addressable: boolean;
}

/** Source, direction, cardinality and provenance of one edge, for the inspector. */
export function edgeDetail(model: GraphModel, edge: GraphEdge): EdgeDetail {
  const cardinality = edge.provenance === "frontmatter" && edge.field ? [...model.edges.values()].filter((e) => e.from === edge.from && e.field === edge.field && e.provenance === "frontmatter").length : null;
  return { direction: `${edge.from} → ${edge.to}`, provenance: edge.provenance, text: provenanceText(edge), cardinality, addressable: edge.provenance !== "external" };
}

// ---- titles ---------------------------------------------------------------------------

/** The batched title query for `paths` (deduplicated, order kept); null for none. */
export function titlesQuery(paths: readonly string[]): string | null {
  const unique = [...new Set(paths.map(rooted))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `docs { select _path, _title where _path == ${JSON.stringify(unique[0])} }`;
  return `docs { select _path, _title where _path in (${unique.map((p) => JSON.stringify(p)).join(", ")}) }`;
}

/** The document nodes whose title has not been fetched yet. */
export function untitledPaths(model: GraphModel): string[] {
  return [...model.nodes.values()].filter((n) => n.kind === "document" && !n.titled).map((n) => n.path);
}

/** The `_title` of the hit for `path`, else the path's stem. */
export function titleOf(path: string, hits: readonly Record<string, unknown>[]): string {
  const p = rooted(path);
  const hit = hits.find((h) => typeof h._path === "string" && rooted(h._path) === p);
  const t = hit?._title;
  return typeof t === "string" && t.trim() !== "" ? t : wikiStem(p);
}

/** The model with each hit's `_title` applied (a hit without one keeps the stem but counts as titled). */
export function applyTitles(model: GraphModel, hits: readonly Record<string, unknown>[]): GraphModel {
  const next = copy(model);
  for (const h of hits) {
    if (typeof h._path !== "string") continue;
    const p = rooted(h._path);
    const node = next.nodes.get(p);
    if (!node) continue;
    const id = typeof h._id === "string" ? h._id : node.id;
    next.nodes.set(p, { ...node, id, title: titleOf(p, [h]), titled: true });
  }
  return next;
}

// ---- reads through the shared client -------------------------------------------------

export type GraphReader = Pick<OmgClient, "query" | "queryAll" | "docsRead">;

/** Both link directions of one document through `OmgClient.queryAll` (the
 * queries are lib/links.ts's; `byName` phantoms are not graph edges, so it is empty). */
export async function fetchDocLinks(client: Pick<GraphReader, "queryAll">, path: string, opts: { repo?: string | null } = {}): Promise<DocLinks> {
  const [inbound, outbound] = await Promise.all([
    client.queryAll(inboundQuery(path), { repo: opts.repo }),
    client.queryAll(outboundQuery(path), { repo: opts.repo }),
  ]);
  return { inbound: linkRowsOf(inbound), outbound: linkRowsOf(outbound), byName: [] };
}

/** The titles of every untitled document node, folded in; the model unchanged when none are missing. */
export async function fetchTitles(client: Pick<GraphReader, "queryAll">, model: GraphModel, opts: { repo?: string | null } = {}): Promise<GraphModel> {
  const q = titlesQuery(untitledPaths(model));
  if (q === null) return model;
  const hits: Hit[] = await client.queryAll(q, { repo: opts.repo });
  return applyTitles(model, hits);
}

// ---- geometry (the pane's pointer and keyboard math) --------------------------------

export const CARD_W = 150;
export const CARD_H = 34;
export const TITLE_MAX = 24;

export interface Placed { path: string; x: number; y: number }
export type Direction = "up" | "down" | "left" | "right";

/** A title cut to `max` characters with an ellipsis. */
export function truncateTitle(title: string, max = TITLE_MAX): string {
  const t = title.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** The topmost card (last in order) whose rectangle contains the point, else null. */
export function hitTest(placed: readonly Placed[], x: number, y: number, w = CARD_W, h = CARD_H): string | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (Math.abs(x - p.x) <= w / 2 && Math.abs(y - p.y) <= h / 2) return p.path;
  }
  return null;
}

/** The nearest card from `from` whose displacement points mostly in `dir` (ties by distance), else null. */
export function nearestInDirection(placed: readonly Placed[], from: string, dir: Direction): string | null {
  const origin = placed.find((p) => p.path === from);
  if (!origin) return placed[0]?.path ?? null;
  let best: { path: string; d: number } | null = null;
  for (const p of placed) {
    if (p.path === from) continue;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { path: p.path, d };
  }
  return best?.path ?? null;
}

export interface ViewTransform { k: number; tx: number; ty: number }

/** The home view: graph (0, 0) — where the root is pinned — at the viewport's centre, 1:1. */
export function initialView(width: number, height: number): ViewTransform {
  return { k: 1, tx: width / 2, ty: height / 2 };
}

/** The scale/translate that fits every card into `width`×`height` with `pad` around (scale capped at 1). */
export function fitTransform(placed: readonly Placed[], width: number, height: number, pad = 24, w = CARD_W, h = CARD_H): ViewTransform {
  if (placed.length === 0 || width <= 0 || height <= 0) return { k: 1, tx: 0, ty: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - w / 2);
    maxX = Math.max(maxX, p.x + w / 2);
    minY = Math.min(minY, p.y - h / 2);
    maxY = Math.max(maxY, p.y + h / 2);
  }
  const bw = maxX - minX, bh = maxY - minY;
  const k = Math.min(1, (width - 2 * pad) / bw, (height - 2 * pad) / bh);
  const tx = (width - k * bw) / 2 - k * minX;
  const ty = (height - k * bh) / 2 - k * minY;
  return { k, tx, ty };
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

/** The view scaled by `factor` about the screen point (sx, sy) — the graph point under it stays put — clamped to [min, max]. */
export function zoomAbout(view: ViewTransform, factor: number, sx: number, sy: number, min = ZOOM_MIN, max = ZOOM_MAX): ViewTransform {
  const k = Math.min(max, Math.max(min, view.k * factor));
  if (k === view.k) return view;
  const g = toGraph(view, sx, sy);
  return { k, tx: sx - g.x * k, ty: sy - g.y * k };
}

/** The view shifted by a screen offset. */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { k: view.k, tx: view.tx + dx, ty: view.ty + dy };
}

/** A wheel event's zoom factor: `ctrlKey` is a trackpad pinch (Chromium/Safari) and zooms faster per unit; line/page deltas are scaled to pixels. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * (ctrlKey ? 0.01 : 0.002));
}

/** Screen → graph coordinates under a transform. */
export function toGraph(view: ViewTransform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k };
}

/** Where the segment from `from` to the centre of the card at `to` meets that card's border (the arrowhead's tip). */
export function arrowEnd(from: { x: number; y: number }, to: { x: number; y: number }, w = CARD_W, h = CARD_H, gap = 2): { x: number; y: number } {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (dx === 0 && dy === 0) return { x: to.x, y: to.y };
  const hw = w / 2 + gap, hh = h / 2 + gap;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: to.x + dx * t, y: to.y + dy * t };
}

/** What a press on a node starts: a connector (the ⟶ handle, ⌘/Ctrl held, or the node armed by `connectSource`/`c`) when writes are allowed, else a reposition. */
export function dragMode(input: { handle: boolean; modifier: boolean; canWrite: boolean; armed: string | null }, path: string): "connector" | "move" {
  return input.canWrite && (input.handle || input.modifier || input.armed === path) ? "connector" : "move";
}

export type ConnectorDrop = { kind: "connect"; from: string; to: string } | { kind: "empty"; from: string; x: number; y: number };

/** Where a connector from `from` dropped at graph point (x, y) lands: on another document node (never the source, never an external node), else open canvas. */
export function connectorDrop(placed: readonly Placed[], from: string, x: number, y: number, isDocument: (path: string) => boolean): ConnectorDrop {
  const hit = hitTest(placed.filter((p) => p.path !== from), x, y);
  return hit !== null && isDocument(hit) ? { kind: "connect", from, to: hit } : { kind: "empty", from, x, y };
}

export interface ConnectorLine { x1: number; y1: number; x2: number; y2: number; /** Where the "find or create…" hint sits, beside the pointer. */ hint: { x: number; y: number } }

/** The ghost connector from a source card to the pointer, in GRAPH coordinates:
 * it leaves the card at its border toward the pointer (not from under the title)
 * and ends at the pointer; a pointer still inside the card gives a zero-length line. */
export function connectorLine(source: Placed, pointer: { x: number; y: number }, w = CARD_W, h = CARD_H): ConnectorLine {
  const start = arrowEnd(pointer, source, w, h, 0);
  const inside = Math.abs(pointer.x - source.x) <= w / 2 && Math.abs(pointer.y - source.y) <= h / 2;
  const from = inside ? pointer : start;
  return { x1: from.x, y1: from.y, x2: pointer.x, y2: pointer.y, hint: { x: pointer.x + 14, y: pointer.y + 18 } };
}

// ---- edge routing: obstacle-aware quadratic Béziers ---------------------------------------

export type EdgeStyle = "curved" | "straight";

export const ROUTE_MARGIN = 10;
export const ROUTE_STEP = 12;
export const ROUTE_SAMPLES = 16;
export const ROUTE_PASSES = 3;
/** At most this many pushes per edge (oscillation between two-sided obstacles is bounded). */
export const ROUTE_MAX_PUSHES = 8;
/** Edges shorter than this (1.5 card widths) are never deflected around obstacles. */
export const ROUTE_MIN_LEN = CARD_W * 1.5;
/** The control offset is capped at this fraction of the edge's length. */
export const ROUTE_MAX_RATIO = 1.2;
/** Perpendicular spacing between parallel edges of one node pair. */
export const PARALLEL_GAP = 36;

export interface EdgeRoute {
  /** The SVG path: `M … L …` when straight, `M … Q … …` when curved. */
  d: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Unit direction of travel at the end (the arrowhead's). */
  tangent: { x: number; y: number };
  control: { x: number; y: number } | null;
  /** The curve at t = 0.5 (where the label sits). */
  mid: { x: number; y: number };
  /** How many obstacles deflected the control point. */
  bends: number;
}

interface Rect { x: number; y: number; hw: number; hh: number }
type Pt = { x: number; y: number };

function inflated(p: Placed, w: number, h: number, m: number): Rect {
  return { x: p.x, y: p.y, hw: w / 2 + m, hh: h / 2 + m };
}

/** Liang–Barsky: does the segment p→q cross the rectangle? */
export function segmentHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  const dx = q.x - p.x, dy = q.y - p.y;
  let t0 = 0, t1 = 1;
  const clip = (pk: number, qk: number): boolean => {
    if (pk === 0) return qk >= 0;
    const t = qk / pk;
    if (pk < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, p.x - (r.x - r.hw)) && clip(dx, r.x + r.hw - p.x) && clip(-dy, p.y - (r.y - r.hh)) && clip(dy, r.y + r.hh - p.y);
}

function quad(p0: Pt, c: Pt, p2: Pt, t: number): Pt {
  const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), d = t * t;
  return { x: a * p0.x + b * c.x + d * p2.x, y: a * p0.y + b * c.y + d * p2.y };
}

/** Does the quadratic p0–c–p2, sampled as `ROUTE_SAMPLES` segments, cross the rectangle?
 * The curve lies in the hull of its three points, so a hull box that misses the rect is a cheap no. */
export function curveHitsRect(p0: Pt, c: Pt, p2: Pt, r: Rect): boolean {
  if (Math.min(p0.x, c.x, p2.x) > r.x + r.hw || Math.max(p0.x, c.x, p2.x) < r.x - r.hw || Math.min(p0.y, c.y, p2.y) > r.y + r.hh || Math.max(p0.y, c.y, p2.y) < r.y - r.hh) return false;
  let prev = p0;
  for (let i = 1; i <= ROUTE_SAMPLES; i++) {
    const next = quad(p0, c, p2, i / ROUTE_SAMPLES);
    if (segmentHitsRect(prev, next, r)) return true;
    prev = next;
  }
  return false;
}

/** A deterministic side (+1 / −1) for an obstacle sitting exactly on the segment, from the edge key. */
export function keySide(key: string): 1 | -1 {
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
  return sum % 2 === 1 ? 1 : -1;
}

export interface EdgePathOptions {
  /** The edge key (the side tie-break). */
  key?: string;
  /** A perpendicular offset applied before avoidance (`parallelOffsets`). */
  offset?: number;
  /** Skip obstacle avoidance (the "straight" style). */
  avoid?: boolean;
  w?: number;
  h?: number;
  margin?: number;
}

/** The route of one edge: a quadratic Bézier from `from`'s border to `to`'s border
 * whose control point starts at the midpoint (a straight line, shifted by
 * `offset` for parallel edges) and is pushed perpendicular to the segment, away
 * from every card it would cross (inflated by `margin`), nearest obstacle first,
 * in `ROUTE_STEP` steps up to `ROUTE_MAX_RATIO` × the length, over up to
 * `ROUTE_PASSES` passes (geometric steps then a bisection per obstacle). When
 * the pushes do not clear everything a coarse sweep of both sides keeps the
 * offset with the fewest crossings. Deterministic for equal inputs. */
export function edgePath(from: Placed, to: Placed, obstacles: readonly Placed[], opts: EdgePathOptions = {}): EdgeRoute {
  const w = opts.w ?? CARD_W, h = opts.h ?? CARD_H, m = opts.margin ?? ROUTE_MARGIN;
  const dx = to.x - from.x, dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L === 0) return { d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, start: { x: from.x, y: from.y }, end: { x: to.x, y: to.y }, tangent: { x: 1, y: 0 }, control: null, mid: { x: from.x, y: from.y }, bends: 0 };
  const u = { x: dx / L, y: dy / L }, n = { x: -u.y, y: u.x };
  const M = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const curveOf = (off: number) => {
    const c = { x: M.x + n.x * off, y: M.y + n.y * off };
    return { c, p0: arrowEnd(c, from, w, h, 2), p2: arrowEnd(c, to, w, h, 2) };
  };
  let offset = opts.offset ?? 0;
  let bends = 0;
  if (opts.avoid !== false && L >= ROUTE_MIN_LEN) {
    // Prune to the cards whose inflated box meets the segment's box widened by the curve's largest possible bulge.
    const reach = (ROUTE_MAX_RATIO * L) / 2 + Math.abs(offset) / 2 + m + Math.max(w, h);
    const minX = Math.min(from.x, to.x) - reach, maxX = Math.max(from.x, to.x) + reach;
    const minY = Math.min(from.y, to.y) - reach, maxY = Math.max(from.y, to.y) + reach;
    const rects = obstacles
      .filter((o) => o.path !== from.path && o.path !== to.path && o.x >= minX && o.x <= maxX && o.y >= minY && o.y <= maxY)
      .map((o) => inflated(o, w, h, m))
      .map((r) => ({ r, d: Math.abs((r.x - from.x) * n.x + (r.y - from.y) * n.y) + Math.max(0, Math.abs((r.x - M.x) * u.x + (r.y - M.y) * u.y) - L / 2) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.r);
    /** Crossings at `off`, counting no further than `limit` (we only ask "is it better?"). */
    const violations = (off: number, limit = Infinity): number => {
      const { c, p0, p2 } = curveOf(off);
      let v = 0;
      for (const r of rects) if (curveHitsRect(p0, c, p2, r) && ++v >= limit) break;
      return v;
    };
    let best = { off: offset, v: violations(offset) };
    const cap = ROUTE_MAX_RATIO * L;
    outer: for (let pass = 0; pass < ROUTE_PASSES && best.v > 0 && bends < ROUTE_MAX_PUSHES; pass++) {
      let changed = false;
      for (const r of rects) {
        if (bends >= ROUTE_MAX_PUSHES) break;
        const cur = curveOf(offset);
        if (!curveHitsRect(cur.p0, cur.c, cur.p2, r)) continue;
        const sideOf = (r.x - M.x) * n.x + (r.y - M.y) * n.y;
        const side = Math.abs(sideOf) < 1e-6 ? keySide(opts.key ?? "") : sideOf > 0 ? 1 : -1;
        // Geometric steps (12, 24, 48, …) away from the obstacle until the curve clears it, then a short bisection back toward the last hit — ≈ 12 curve tests, not one per `ROUTE_STEP`.
        const hits = (off: number): boolean => { const k = curveOf(off); return curveHitsRect(k.p0, k.c, k.p2, r); };
        let lo = offset, hi = offset, step = ROUTE_STEP, cleared = false;
        while (Math.abs(hi - side * step) <= cap) {
          lo = hi;
          hi -= side * step;
          if (!hits(hi)) { cleared = true; break; }
          step *= 2;
        }
        if (!cleared) continue;
        for (let i = 0; i < 4; i++) {
          const midOff = (lo + hi) / 2;
          if (hits(midOff)) lo = midOff; else hi = midOff;
        }
        offset = Math.round(hi);
        bends++;
        changed = true;
        const v = violations(offset, best.v);
        if (v < best.v) best = { off: offset, v };
        if (v === 0) break outer;
      }
      if (!changed) break;
    }
    if (best.v > 0) {
      // Greedy pushes oscillated between obstacles on both sides: sweep both sides at doubling bulges (24, 48, 96, … ≤ cap) and keep the fewest crossings (ties: the smaller bulge, then the key's side).
      for (let off = ROUTE_STEP * 2; off <= cap && best.v > 0; off *= 2) {
        for (const signed of keySide(opts.key ?? "") > 0 ? [off, -off] : [-off, off]) {
          const v = violations(signed, best.v);
          if (v < best.v) best = { off: signed, v };
          if (v === 0) break;
        }
      }
    }
    offset = best.off;
  }
  const { c, p0, p2 } = curveOf(offset);
  if (offset === 0) {
    const len = Math.hypot(p2.x - p0.x, p2.y - p0.y) || 1;
    return { d: `M ${p0.x} ${p0.y} L ${p2.x} ${p2.y}`, start: p0, end: p2, tangent: { x: (p2.x - p0.x) / len, y: (p2.y - p0.y) / len }, control: null, mid: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 }, bends };
  }
  const tl = Math.hypot(p2.x - c.x, p2.y - c.y) || 1;
  return { d: `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`, start: p0, end: p2, tangent: { x: (p2.x - c.x) / tl, y: (p2.y - c.y) / tl }, control: c, mid: quad(p0, c, p2, 0.5), bends };
}

/** How many cards (inflated by `margin`, the endpoints excluded) a route still crosses. */
export function routeViolations(route: EdgeRoute, from: Placed, to: Placed, obstacles: readonly Placed[], w = CARD_W, h = CARD_H, m = ROUTE_MARGIN): number {
  const c = route.control ?? { x: (route.start.x + route.end.x) / 2, y: (route.start.y + route.end.y) / 2 };
  let v = 0;
  for (const o of obstacles) {
    if (o.path === from.path || o.path === to.path) continue;
    if (curveHitsRect(route.start, c, route.end, inflated(o, w, h, m))) v++;
  }
  return v;
}

/** Perpendicular offsets that fan the edges of one node pair apart (either
 * direction counts as the same pair): centred multiples of `PARALLEL_GAP`
 * (±18 for two, −36/0/36 for three, …), assigned in key order and expressed in
 * each edge's own frame so A→B and B→A spread rather than overlap. */
export function parallelOffsets(edges: readonly { key: string; from: string; to: string }[]): Map<string, number> {
  const groups = new Map<string, { key: string; from: string; to: string }[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const pair = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
    const g = groups.get(pair) ?? [];
    g.push(e);
    groups.set(pair, g);
  }
  const out = new Map<string, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    g.forEach((e, i) => {
      const canonical = (i - (g.length - 1) / 2) * PARALLEL_GAP;
      out.set(e.key, e.from < e.to ? canonical : -canonical);
    });
  }
  return out;
}

/** The arrowhead at a route's end as a closed path, aligned with the end tangent. */
export function arrowheadPath(end: Pt, tangent: Pt, length = 9, half = 4): string {
  const bx = end.x - tangent.x * length, by = end.y - tangent.y * length;
  const nx = -tangent.y * half, ny = tangent.x * half;
  return `M ${end.x} ${end.y} L ${bx + nx} ${by + ny} L ${bx - nx} ${by - ny} Z`;
}

// ---- the force layout's numbers ---------------------------------------------------------

export interface ForceConfig {
  /** Per-node positional pull toward the graph origin (`forceX(0)`/`forceY(0)`): weak, so pinned hubs at the edge do not drag the free nodes away — never `forceCenter`, which translates every node each tick. */
  gravity: { x: number; y: number; strength: number };
  /** `forceLink`: an explicit strength (d3's default `1/min(degree)` vanishes on a hub) and rest length. */
  link: { distance: number; strength: number };
  /** `forceManyBody`: moderate, short-range repulsion. */
  charge: { strength: number; distanceMax: number; theta: number };
  /** `forceCollide`: half the card's diagonal plus a margin, so cards never overlap. */
  collide: { radius: number; strength: number };
  alphaDecay: number;
  velocityDecay: number;
  /** The reheat after a pin / unpin / structural change. */
  reheatAlpha: number;
}

/** The layout's constants. Graph space is centred on the origin — the page pins
 * the root at (0, 0) and `initialView` puts the origin at the viewport's centre.
 * A star of one pinned hub and 15 leaves settles in a ring (radius ≈ 165–330
 * with the collide radius) around the hub wherever it is pinned, not in a
 * column by the centre (checked against d3-force). */
export function forceConfig(): ForceConfig {
  return {
    gravity: { x: 0, y: 0, strength: 0.04 },
    link: { distance: 100, strength: 0.8 },
    charge: { strength: -220, distanceMax: 350, theta: 0.9 },
    collide: { radius: Math.hypot(CARD_W, CARD_H) / 2 + 6, strength: 0.8 },
    alphaDecay: 0.02,
    velocityDecay: 0.35,
    reheatAlpha: 0.5,
  };
}

/** A one-line description of the graph for assistive technology. */
export function graphDescription(model: GraphModel): string {
  const docs = [...model.nodes.values()].filter((n) => n.kind === "document").length;
  const ext = model.nodes.size - docs;
  return `graph around ${model.root}: ${docs} document${docs === 1 ? "" : "s"}${ext > 0 ? `, ${ext} external link${ext === 1 ? "" : "s"}` : ""}, ${model.edges.size} relationship${model.edges.size === 1 ? "" : "s"}`;
}
