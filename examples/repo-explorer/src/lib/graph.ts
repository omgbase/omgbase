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
// fit transform, the arrow endpoint) are what <graph-pane> uses for its pointer
// and keyboard math, kept here so they are testable without a DOM.

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

/** A one-line description of the graph for assistive technology. */
export function graphDescription(model: GraphModel): string {
  const docs = [...model.nodes.values()].filter((n) => n.kind === "document").length;
  const ext = model.nodes.size - docs;
  return `graph around ${model.root}: ${docs} document${docs === 1 ? "" : "s"}${ext > 0 ? `, ${ext} external link${ext === 1 ? "" : "s"}` : ""}, ${model.edges.size} relationship${model.edges.size === 1 ? "" : "s"}`;
}
