// `graph` — a one-call neighborhood macro OVER OQX `follow`.
//
// ADR-006: OQX `follow` is the ONE traversal engine; the removed
// graph_traverse/path/subgraph tools are not resurrected. This macro owns NO
// graph-walking logic — it compiles its arguments into an OQX `follow doc.out`
// / `doc.in` query (the exact recursive-CTE walk the `query` tool exposes),
// runs it through the shared runner (oqxRunAsync), and then only SHAPES the
// walk's own output (its `$depth`/`$stop` intrinsics and projected edges) into
// the { documents, edges, frontier } envelope. Every hop, cycle-guard and depth
// bound is `follow`'s; nothing here re-implements BFS/DFS.
//
// Mapping (args → follow query):
//   roots      → the seed `where $id == … || …` (refs resolved to doc ids first)
//   degrees    → `follow … { depth degrees+1 }` (seed is $depth 1, so N hops = depth N+1)
//   direction  → `follow doc.out` | `doc.in` | both (two walks, unioned)
//   predicate  → `follow … { via predicate == "…" }` (edge-scoped filter)
//   select     → extra doc projections spliced into the walk's `select`
//   max_documents → a post-walk cap on the distinct document set
//
// Edges are surfaced by projecting the reached doc's `doc.out_edges`/`doc.in_edges`
// in the SAME walk (a select-position collect), then keeping the induced-subgraph
// edges (both endpoints in the neighborhood) plus dangling stubs to external/
// phantom targets — so external (`x_…`) and phantom endpoints are never dropped,
// exactly as `from edges` surfaces them.

import type { Store } from "../core/store/store.js";
import { findDocByRef } from "../core/read/reader.js";
import { oqxRunAsync, type EmbedQuery } from "../oqx/run.js";
import { EngineError } from "./errors.js";

const DEFAULT_DEGREES = 1;
const DEFAULT_MAX_DOCUMENTS = 200;
const MAX_DEPTH = 8; // OQX follow depth cap (1..8)

export type GraphDirection = "in" | "out" | "both";

export interface GraphArgs {
  /** one or more document refs — paths and/or ids. Root nodes are depth 0. */
  roots: string[];
  /** max hop depth from a root (root = 0). Default 1; clamped so degrees+1 ≤ 8. */
  degrees?: number | undefined;
  /** which edges to follow: outgoing links, backlinks, or both. Default "both". */
  direction?: GraphDirection | undefined;
  /** restrict the walk to edges with this predicate (maps to follow `{ via }`). */
  predicate?: string | undefined;
  /** extra document projections (OQX select expressions, e.g. "layer", "$path"). */
  select?: string[] | undefined;
  /** cap on the distinct documents returned (default 200). */
  max_documents?: number | undefined;
}

/** A traversed edge with full provenance (mirrors the `edges` target's rows). */
export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  dst_path: string | null;
  dst_uri: string | null;
  dst_kind: string;
  predicate: string;
  provenance: string;
  anchor: string | null;
  src_field: string | null;
}

/** A reached document: id/path + walk metadata + any requested projections. */
export interface GraphDoc {
  id: string;
  path: string;
  /** minimum hop distance from a root (root = 0). */
  degree: number;
  /** true when this node sits on the outer boundary (its min degree == degrees). */
  frontier: boolean;
  [k: string]: unknown;
}

export interface GraphResult {
  roots: string[];
  degrees: number;
  direction: GraphDirection;
  documents: GraphDoc[];
  edges: GraphEdge[];
  frontier: { id: string; path: string; degree: number }[];
  truncated: boolean;
  /** the exact OQX `follow` query/queries this macro generated — it delegates. */
  queries: string[];
}

// Raw edge as projected by the walk's `doc.*_edges collect { … }`.
interface RawEdge {
  id: string;
  src: string;
  dst: string;
  dst_path: string | null;
  dst_uri: string | null;
  dst_kind: string;
  predicate: string;
  provenance: string;
  anchor: string | null;
  src_field: string | null;
}

// Build the extra `select` items for caller projections. Each expression gets a
// stable internal alias (_u0, _u1, …) so it can never collide with a reserved
// word or the macro's own aliases; the clean output name is derived separately.
function buildUserSelect(select: string[] | undefined): { clause: string; outNames: string[] } {
  if (!select || select.length === 0) return { clause: "", outNames: [] };
  const items: string[] = [];
  const outNames: string[] = [];
  const used = new Set<string>();
  select.forEach((expr, i) => {
    const trimmed = expr.trim();
    if (!trimmed) return;
    const m = /^\$?([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    let name = m ? m[1]! : `sel_${i}`;
    while (used.has(name)) name = `${name}_${i}`;
    used.add(name);
    outNames[i] = name;
    items.push(`_u${i}: ${trimmed}`);
  });
  return { clause: items.length ? `, ${items.join(", ")}` : "", outNames };
}

// The edge fields projected from doc.out_edges/doc.in_edges — identical for both
// directions so a single filter handles either scan (an edge is a directional
// src→dst fact regardless of which endpoint the walk reached it from).
const EDGE_COLLECT =
  "{ id: $id, src: $src, dst: $dst, dst_path: $dst_path, dst_uri: $dst_uri, " +
  "dst_kind: dst_kind, predicate: predicate, provenance: provenance, anchor: anchor, src_field: src_field }";

function buildQuery(seed: string, dir: "out" | "in", depth: number, via: string, userSelect: string): string {
  const edgesRel = dir === "out" ? "doc.out_edges" : "doc.in_edges";
  return (
    `from docs where ${seed} ` +
    `select _depth: $depth, _stop: $stop, _edges: ${edgesRel} collect ${EDGE_COLLECT}${userSelect} ` +
    `follow distinct doc.${dir} { depth ${depth}${via} }`
  );
}

/**
 * Run the `graph` neighborhood macro: compile the args into OQX `follow`
 * query(ies), execute via the shared runner, and shape the walk output into
 * { documents, edges, frontier }. Throws EngineError (doc_missing/target_missing)
 * for an empty or unresolvable roots list — never a silent empty result.
 */
export async function graphNeighborhood(
  store: Store,
  repoId: string,
  args: GraphArgs,
  embedQuery?: EmbedQuery,
): Promise<GraphResult> {
  if (!args.roots || args.roots.length === 0) {
    throw new EngineError("target_missing", "graph requires at least one root (path or id)");
  }

  // Resolve every root ref to a concrete doc id up front — the seed is built
  // from ids only, so no caller-supplied string is interpolated into the query.
  const rootIds: string[] = [];
  for (const ref of args.roots) {
    const info = findDocByRef(store, repoId, ref);
    if (!info) throw new EngineError("doc_missing", `no document for ${JSON.stringify(ref)}`, { data: { root: ref } });
    if (!rootIds.includes(info.docId)) rootIds.push(info.docId);
  }

  const degrees = Math.max(0, Math.floor(args.degrees ?? DEFAULT_DEGREES));
  const depth = Math.min(MAX_DEPTH, degrees + 1); // seed = $depth 1 ⇒ N hops = depth N+1
  const effectiveDegrees = depth - 1; // after the depth-cap clamp
  const direction: GraphDirection = args.direction ?? "both";
  const maxDocuments = Math.max(1, Math.floor(args.max_documents ?? DEFAULT_MAX_DOCUMENTS));
  const dirs: ("out" | "in")[] = direction === "both" ? ["out", "in"] : [direction];

  const seed = rootIds.map((id) => `$id == ${JSON.stringify(id)}`).join(" || ");
  const via = args.predicate ? ` via predicate == ${JSON.stringify(args.predicate)}` : "";
  const { clause: userSelect, outNames } = buildUserSelect(args.select);

  const queries: string[] = [];
  const docMap = new Map<string, GraphDoc>();
  const edgeMap = new Map<string, RawEdge>();
  let queryTruncated = false;

  for (const dir of dirs) {
    const q = buildQuery(seed, dir, depth, via, userSelect);
    queries.push(q);
    // Fetch one more than the cap to detect truncation of a single scan; `follow
    // distinct` yields one row per reached node so the row count == node count.
    const res = await oqxRunAsync(store, repoId, q, { limit: maxDocuments + 1 }, embedQuery);
    if (res.truncated) queryTruncated = true;

    for (const hit of res.hits) {
      const hopDepth = Number(hit._depth); // $depth: seed = 1
      const degree = hopDepth - 1; // root = 0
      const prev = docMap.get(hit.id);
      if (!prev || degree < prev.degree) {
        const doc: GraphDoc = { id: hit.id, path: hit.path, degree, frontier: false };
        outNames.forEach((name, i) => {
          if (name !== undefined) doc[name] = hit[`_u${i}`] ?? null;
        });
        docMap.set(hit.id, doc);
      }
      // Gather this node's edges; dedup by edge id (an a→b edge is reachable as
      // a's out-edge AND b's in-edge in "both" mode).
      const raw = (hit._edges as RawEdge[] | null) ?? [];
      for (const e of raw) if (!edgeMap.has(e.id)) edgeMap.set(e.id, e);
    }
  }

  // Cap the distinct document set (nearest-first), then bound edges to it.
  const allDocs = [...docMap.values()].sort((a, b) => a.degree - b.degree || a.path.localeCompare(b.path));
  const capped = allDocs.length > maxDocuments;
  const documents = allDocs.slice(0, maxDocuments);
  const reached = new Set(documents.map((d) => d.id));
  const truncated = queryTruncated || capped;

  // Mark the outer boundary: a node whose MIN degree equals the requested reach
  // was only ever touched at the edge of the walk (never expanded past). At
  // degrees 0 the roots themselves are the boundary.
  const frontier: { id: string; path: string; degree: number }[] = [];
  for (const d of documents) {
    d.frontier = d.degree === effectiveDegrees;
    if (d.frontier) frontier.push({ id: d.id, path: d.path, degree: d.degree });
  }

  // Keep the induced-subgraph edges (both endpoints in the neighborhood) plus
  // dangling stubs to external/phantom targets, so external (x_…) and phantom
  // endpoints survive the way `from edges` surfaces them. When a predicate
  // filter is set only that predicate's edges count as traversed.
  const edges: GraphEdge[] = [];
  for (const e of edgeMap.values()) {
    if (args.predicate && e.predicate !== args.predicate) continue;
    const srcIn = reached.has(e.src);
    const dstDangling = e.dst_kind === "external" || (e.dst_kind === "document" && e.dst_path === null);
    const dstIn = reached.has(e.dst) || dstDangling;
    if (srcIn && dstIn) edges.push(e);
  }
  edges.sort((a, b) => (a.src === b.src ? a.id.localeCompare(b.id) : a.src.localeCompare(b.src)));

  return {
    roots: rootIds,
    degrees: effectiveDegrees,
    direction,
    documents,
    edges,
    frontier,
    truncated,
    queries,
  };
}
