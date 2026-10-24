// The graph projection's MODEL: a bounded, progressively expanded neighbourhood
// of documents joined by the `links` rows lib/links.ts already reads. The model
// is immutable — every function returns a NEW model — so a signal can hold it and
// a `view`/`query` command (lib/graph-commands.ts) can swap whole models for
// undo/redo. Drawing is `<omg-graph>` (@omgbase/elements): `toView(model)` turns
// this model into the element's renderer-neutral view model, and every piece of
// geometry (routing, pins, zoom) lives in the package.
//
// A node is a document (`kind: "document"`, keyed by its rooted `_path`) or an
// external destination (`kind: "external"`, keyed by its URL; never expandable).
// An edge is ONE authored link row projected onto the node pair: `provenance`
// says where it was authored (`frontmatter` field, `body` link — a `[text](/x.md)`
// or an inline `key:: /x.md` field — or `external` for a URL destination) and
// keeps the field / block id / URL so the inspector can say exactly what the
// line stands for (`provenanceText`). Rendered edges are not writable by
// themselves — the connector's write side is lib/relations.ts.
//
// Expansion is bounded: `withNeighborhood` adds at most `limit` NEW neighbours
// per direction (edges to nodes already in the model are free) and records the
// number left out in `truncated`. Pins are presentation state: they live only
// in this model, never in a document.
//
// Rows. Each document node carries the ROW the card template reads (`row`), fetched
// by one batched query per expansion: `fieldsQuery(paths, fields)` →
// `docs { select _path, _title, <fields…> where _path in (…) }` (`x in (a, b)` is
// OQX's tuple membership; a single path is `_path == …` because `(x)` alone is
// grouping), `applyRows(model, hits, fields)` folds the hits in and remembers
// which fields each node has been fetched with, `unfetched(model, fields)` names
// the nodes still missing some of them. `_title` is always fetched (the
// connector's link text and the card fallback); every other field is the card's.

import type { Hit, OmgClient } from "@omgbase/client";
import type { GraphViewEdge, GraphViewNode } from "@omgbase/elements/graph";
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
  /** The projected row (`_path`, `_title`, the card's fields) as fetched so far. */
  row: Record<string, unknown>;
  /** The fields `row` has been fetched with (a field absent from the document is still "fetched"). */
  fetched: string[];
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
  return { path, kind: "document", id, row: { _path: path }, fetched: [], pinned: null, expanded: false, degree: { in: null, out: null } };
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
  return { path: uri, kind: "external", id, row: { _url: uri, _title: externalTitle(uri) }, fetched: [], pinned: null, expanded: true, degree: { in: null, out: 0 } };
}

/** A node's title: the fetched `_title`, else the path's stem (an external node's host and path). */
export function titleOf(node: GraphNode): string {
  const t = node.row._title;
  return typeof t === "string" && t.trim() !== "" ? t : node.kind === "external" ? externalTitle(node.path) : wikiStem(node.path);
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

export function rowProvenance(row: LinkRow, kind: NodeKind): Provenance {
  if (kind === "external") return "external";
  return row.provenance === "frontmatter" ? "frontmatter" : "body";
}

/** The edge a row projects to. An inbound row (`inboundQuery`) carries no `_dst_path` — the query selected it by one — so its destination is passed in. */
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

/** Group a direction's rows by the neighbour they name (row order kept), dropping dangling rows, self-loops and duplicate keys. */
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

/** The model with `path`'s neighbourhood loaded from its link rows: at most `limit` new neighbours per direction (the rest counted in `truncated`), every edge keyed and deduplicated, the node marked expanded with its degrees. */
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

/** The model without a node and its edges. */
export function removeNode(model: GraphModel, path: string): GraphModel {
  const next = copy(model);
  next.nodes.delete(path);
  next.truncated.delete(path);
  for (const [k, e] of next.edges) if (e.from === path || e.to === path) next.edges.delete(k);
  return next;
}

/** The model with `path` collapsed: no longer expanded, its `truncated` entry
 * cleared, and every node that nothing now explains removed with its edges — a
 * node is explained when it is reached from the root by walking OUT of expanded
 * nodes only, so a neighbour that also hangs off another reachable expanded node
 * stays and a collapsed root shows alone. An edge stays only when one of its
 * ends is a retained expanded node. Pins leave with their nodes. */
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
  direction: string;
  provenance: Provenance;
  text: string;
  /** For a frontmatter field: how many edges that field holds from the same source; null otherwise. */
  cardinality: number | null;
  /** Whether the link's storage is known precisely enough to write back (a URL destination is not). */
  addressable: boolean;
}

export function edgeDetail(model: GraphModel, edge: GraphEdge): EdgeDetail {
  const cardinality = edge.provenance === "frontmatter" && edge.field ? [...model.edges.values()].filter((e) => e.from === edge.from && e.field === edge.field && e.provenance === "frontmatter").length : null;
  return { direction: `${edge.from} → ${edge.to}`, provenance: edge.provenance, text: provenanceText(edge), cardinality, addressable: edge.provenance !== "external" };
}

// ---- rows -------------------------------------------------------------------------------

/** The field every row carries whatever the card asks for: the title (the connector's link text, the card fallback). Nothing else is assumed about a repository's vocabulary. */
export const BASE_FIELDS: readonly string[] = ["_title"];

/** The `_`-names a `docs` projection may name (spec/surface §1.2, the names
 * rule): an authored key is bare and reads absent when a document lacks it,
 * but an engine name the surface does not know is the hard error
 * `filter_invalid` ("`_display` is not an engine name of docs"). So a card
 * template's `_display` — the default's first choice, for the day an engine
 * computes it — is dropped from the projection until it is in this list. */
export const PROJECTABLE_ENGINE_FIELDS: ReadonlySet<string> = new Set(["_id", "_path", "_raw", "_hash", "_updated_at", "_created_at", "_title", "_tags", "_format", "_data", "_frontmatter", "_inline"]);

/** The projection a card's fields need: `_title` first, then the card's fields
 * in order — `_path` never repeated (the hit envelope carries it), an unknown
 * engine name skipped (above), a dotted path projected by its head — deduplicated. */
export function projectedFields(fields: readonly string[]): string[] {
  const out: string[] = [...BASE_FIELDS];
  for (const f of fields) {
    const name = f.trim();
    if (name === "" || name === "_path" || out.includes(name)) continue;
    // A dotted card path reads inside a projected record: project its head.
    const head = name.split(".")[0]!;
    if (head.startsWith("_") && !PROJECTABLE_ENGINE_FIELDS.has(head)) continue;
    if (!out.includes(head)) out.push(head);
  }
  return out;
}

/** The batched row query for `paths` (deduplicated, order kept); null for none. */
export function fieldsQuery(paths: readonly string[], fields: readonly string[] = []): string | null {
  const unique = [...new Set(paths.map(rooted))];
  if (unique.length === 0) return null;
  const select = ["_path", ...projectedFields(fields)].join(", ");
  if (unique.length === 1) return `docs { select ${select} where _path == ${JSON.stringify(unique[0])} }`;
  return `docs { select ${select} where _path in (${unique.map((p) => JSON.stringify(p)).join(", ")}) }`;
}

/** The document nodes whose row lacks some of `fields` (as projected). */
export function unfetched(model: GraphModel, fields: readonly string[] = []): string[] {
  const need = projectedFields(fields);
  return [...model.nodes.values()].filter((n) => n.kind === "document" && need.some((f) => !n.fetched.includes(f))).map((n) => n.path);
}

/** The model with each hit's row folded into its node (merged over what was there), the fields recorded as fetched. */
export function applyRows(model: GraphModel, hits: readonly Record<string, unknown>[], fields: readonly string[] = []): GraphModel {
  const next = copy(model);
  const got = projectedFields(fields);
  for (const h of hits) {
    if (typeof h._path !== "string") continue;
    const p = rooted(h._path);
    const node = next.nodes.get(p);
    if (!node) continue;
    const id = typeof h._id === "string" ? h._id : node.id;
    const row: Record<string, unknown> = { ...node.row };
    for (const [k, v] of Object.entries(h)) if (k !== "_id") row[k] = v;
    row._path = p;
    next.nodes.set(p, { ...node, id, row, fetched: [...new Set([...node.fetched, ...got])] });
  }
  return next;
}

// ---- reads through the shared client -------------------------------------------------

export type GraphReader = Pick<OmgClient, "query" | "queryAll" | "docsRead">;

/** Both link directions of one document through `OmgClient.queryAll` (the queries are lib/links.ts's; `byName` phantoms are not graph edges, so it is empty). */
export async function fetchDocLinks(client: Pick<GraphReader, "queryAll">, path: string, opts: { repo?: string | null } = {}): Promise<DocLinks> {
  const [inbound, outbound] = await Promise.all([
    client.queryAll(inboundQuery(path), { repo: opts.repo }),
    client.queryAll(outboundQuery(path), { repo: opts.repo }),
  ]);
  return { inbound: linkRowsOf(inbound), outbound: linkRowsOf(outbound), byName: [] };
}

/** The rows of every document node missing some of `fields`, folded in; the model unchanged when none are. */
export async function fetchFields(client: Pick<GraphReader, "queryAll">, model: GraphModel, fields: readonly string[] = [], opts: { repo?: string | null } = {}): Promise<GraphModel> {
  const q = fieldsQuery(unfetched(model, fields), fields);
  if (q === null) return model;
  const hits: Hit[] = await client.queryAll(q, { repo: opts.repo });
  return applyRows(model, hits, fields);
}

// ---- the view model for <omg-graph> ----------------------------------------------------

export interface GraphView { nodes: GraphViewNode[]; edges: GraphViewEdge[] }

/** The model as `<omg-graph>` draws it: the root emphasised, external nodes
 * dashed and never expandable, every document node expandable, truncation
 * counts, and each edge labelled and described by its provenance (its `kind`
 * is the provenance, so the element's fixed styles apply; a body link is dotted,
 * an external one dashed). Rendered edges are not writable here. */
export function toView(model: GraphModel): GraphView {
  const nodes: GraphViewNode[] = [...model.nodes.values()].map((n) => ({
    id: n.path,
    row: n.row,
    kind: n.kind,
    pinned: n.pinned,
    expandable: n.kind === "document",
    expanded: n.expanded,
    ...(model.truncated.has(n.path) ? { truncated: model.truncated.get(n.path)! } : {}),
    emphasis: n.path === model.root ? "root" : null,
    tooltip: n.kind === "document" ? [n.path, ...Object.entries(n.row).filter(([k, v]) => k !== "_path" && v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)].join("\n") : n.path,
  }));
  const edges: GraphViewEdge[] = [...model.edges.values()].map((e) => ({
    key: e.key,
    from: e.from,
    to: e.to,
    label: edgeLabel(e),
    detail: `${e.from} → ${e.to}: ${provenanceText(e)}`,
    kind: e.provenance,
    style: e.provenance === "body" ? "dotted" : e.provenance === "external" ? "dashed" : "solid",
    writable: false,
  }));
  return { nodes, edges };
}
