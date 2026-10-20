// `graph` — a one-call neighborhood macro OVER OQX `follow`.
//
// ADR-006: OQX `follow` is the ONE traversal engine; the removed
// graph_traverse/path/subgraph tools are not resurrected. This macro owns NO
// graph-walking logic — it compiles its arguments into an OQX `follow _out_links
// collect { from _dst }` / `follow _in_links collect { from _doc }` query (the
// exact walk the `query` tool exposes over the link rows),
// runs it through the shared runner (oqxRunAsync), and then only SHAPES the
// walk's own output (its `$depth`/`$stop` intrinsics and projected edges) into
// the { documents, links, frontier } envelope. Every hop, cycle-guard and depth
// bound is `follow`'s; nothing here re-implements BFS/DFS.
//
// Mapping (args → follow query):
//   roots      → the seed `where _id == … or …` (refs resolved to doc ids first; literals in the AST, never spliced text)
//   degrees    → `follow … collect { … depth degrees+1 }` (seed is $depth 1, so N hops = depth N+1)
//   direction  → `follow _out_links collect { from _dst }` (the linked documents)
//                | `follow _in_links collect { from _doc }` (the linking documents)
//                | both (two walks, unioned)
//   predicate  → restricts the neighborhood to docs reachable via that predicate
//                (recomputed over the walk's collected edges; no `via` clause)
//   select     → extra doc projections spliced into the walk's `select`
//   max_documents → a post-walk cap on the distinct document set
//
// Edges are surfaced by projecting the reached doc's `_out_links`/`_in_links`
// in the SAME walk (a select-position collect), then keeping the induced-subgraph
// edges (both endpoints in the neighborhood) plus dangling stubs to external/
// phantom targets — so external (`x_…`) and phantom endpoints are never dropped,
// exactly as `from links` surfaces them.

import { build, parse, print, OqxError } from "@omgbase/oqx";
import type { Query, SelectItem } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { findDocByRef } from "../core/read/reader.js";
import { oqxRunAsync, type EmbedQuery } from "../oqx/run.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { EngineError } from "./errors.js";

const DEFAULT_DEGREES = 1;
const DEFAULT_MAX_DOCUMENTS = 200;
const MAX_DEPTH = 8; // OQX follow depth cap (1..8)

// Bytewise (UTF-8) order — the order every path-ordered surface uses (spec/surface §4).
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export type GraphDirection = "in" | "out" | "both";

export interface GraphArgs {
  /** one or more document refs — paths and/or ids. Root nodes are depth 0. */
  roots: string[];
  /** max hop depth from a root (root = 0). Default 1; clamped so degrees+1 ≤ 8. */
  degrees?: number | undefined;
  /** which edges to follow: outgoing links, backlinks, or both. Default "both". */
  direction?: GraphDirection | undefined;
  /** restrict the neighborhood to documents reachable from a root via edges of
   * this predicate, within `degrees` (both the docs and the edges are filtered). */
  predicate?: string | undefined;
  /** extra document projections (OQX select expressions, e.g. "layer", "_path"). */
  select?: string[] | undefined;
  /** cap on the distinct documents returned (default 200). */
  max_documents?: number | undefined;
}

/** A traversed edge: a row of the `links` target under its own field names
 *  (spec/surface §1.2, 5.0 — `_id` the edge, `_doc_id`/`_block_id` the source,
 *  `_via_id`, `_dst_id` the destination node, `_dst_path`/`_uri` its path or
 *  URI, `_field` the authoring key). No rename table: what the walk projects is
 *  what the result carries. */
export interface GraphEdge {
  _id: string;
  _doc_id: string;
  _block_id: string | null;
  _via_id: string | null;
  _dst_id: string;
  _dst_path: string | null;
  _uri: string | null;
  _dst_kind: string;
  _predicate: string;
  _provenance: string;
  _anchor: string | null;
  _field: string | null;
}

/** A reached document: `_id`/`_path` (the row's own names, as a `query` hit)
 *  + walk metadata + any requested projections. */
export interface GraphDoc {
  _id: string;
  _path: string;
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
  links: GraphEdge[];
  frontier: { _id: string; _path: string; degree: number }[];
  truncated: boolean;
  /** the exact OQX `follow` query/queries this macro generated — it delegates. */
  queries: string[];
}

// Build the extra `select` items for caller projections. Each expression gets a
// stable internal alias (_u0, _u1, …) so it can never collide with a reserved
// word or the macro's own aliases; the clean output name is derived separately.
// A bare-name selection (`layer`, `_title`) is its own output key, exactly as a
// `query` hit projects it (spec/surface §1.4, 5.0) — so `_id`/`_path` collapse
// onto the envelope keys (the engine reads the same value) and any other name
// is an ordinary column, deduped by suffix. Anything else (an expression) is
// `sel_<i>`, so a projection can never overwrite the envelope here.
function buildUserSelect(select: string[] | undefined): { items: SelectItem[]; outNames: string[] } {
  const items: SelectItem[] = [];
  const outNames: string[] = [];
  if (!select || select.length === 0) return { items, outNames };
  const used = new Set<string>(["_id", "_path"]);
  select.forEach((expr, i) => {
    const trimmed = expr.trim();
    if (!trimmed) return;
    const m = /^(\$?[A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    let name = m ? m[1]! : `sel_${i}`;
    // The envelope keys are the row's own identity: an `_id`/`_path` selection
    // lands on them rather than beside them (the engine reads the same value).
    if (name !== "_id" && name !== "_path") {
      while (used.has(name)) name = `${name}_${i}`;
      used.add(name);
    }
    outNames[i] = name;
    items.push(...userItems(trimmed, `_u${i}`));
  });
  return { items, outNames };
}

// A caller's projection expression as AST: parsed as the item of a projection,
// so it may be anything a `select` item may be (a navigation, an expression, a
// nested block) and nothing more. A malformed expression is `filter_invalid`,
// as it would be in the `query` tool.
function userItems(src: string, alias: string): SelectItem[] {
  let q: Query;
  try {
    q = parse(`select ${alias}: ${src} from docs`);
  } catch (e) {
    if (e instanceof OqxError) throw new FilterInvalid(e.message, "OQX");
    throw e;
  }
  return q.select;
}

// The edge fields projected from `_out_links`/`_in_links` — the `links`
// target's own names, projected under themselves (spec/surface §1.2, 5.0: no
// rename between the language and the result) — identical for both directions
// so a single filter handles either scan (an edge is a directional fact
// regardless of which endpoint the walk reached it from).
const EDGE_FIELDS: (keyof GraphEdge)[] = [
  "_id", "_doc_id", "_block_id", "_via_id", "_dst_id", "_dst_path", "_uri",
  "_dst_kind", "_predicate", "_provenance", "_anchor", "_field",
];

// The macro's own aliases: `__oqx_`/`__omg_` (two underscores) are the runner's
// and the selector compiler's reserved prefixes; a single underscore is the
// engine prefix of 5.0, which an ALIAS may use freely (an alias is never a row
// read), and keeps these off any authored key.
const DEPTH_ALIAS = "_depth";
const STOP_ALIAS = "_stop";
const LINKS_ALIAS = "_links";

// The walk, as an AST (spec/oqx/AST.md §7) printed canonically — never spliced
// strings: the seed ids are literals, the caller's projections parsed items.
//
//   select _depth: $depth, _stop: $stop, _links: _<dir>_links collect { <edge fields> } <user items>
//   from docs where _id == <root> or … follow distinct _<dir>_links collect { from <_dst | _doc> depth <depth> }
//
// The destination block walks the link rows to the documents at their other
// end (spec/surface §1.2, 3.0 follow-up: there are no `out`/`in` relations —
// `_dst` is a link's destination document, `_doc` its source; a `from` over an
// absent `_dst` — an external or phantom target — contributes no successor).
function buildQuery(rootIds: readonly string[], dir: "out" | "in", depth: number, userSelect: SelectItem[]): string {
  const edges = build.op(build.ident(`_${dir}_links`), "collect", build.subquery({
    select: EDGE_FIELDS.map((name) => build.field(name, build.ident(name))),
  }));
  const seed = rootIds.map((id) => build.scalar(build.binary("==", build.ident("_id"), build.lit(id))));
  const q = build.query(build.ident("docs"), {
    select: [
      build.field(DEPTH_ALIAS, build.ident("$depth")),
      build.field(STOP_ALIAS, build.ident("$stop")),
      build.collect(LINKS_ALIAS, edges),
      ...userSelect,
    ],
    where: seed.length === 1 ? seed[0]! : build.or(seed),
    // `depth` is the destination block's own clause (oqx 0.20).
    follow: build.follow(
      [build.op(build.ident(`_${dir}_links`), "collect", build.subquery({ from: [build.ident(dir === "out" ? "_dst" : "_doc")], depth }))],
      { distinct: true },
    ),
  });
  return print(q);
}

/**
 * Run the `graph` neighborhood macro: compile the args into OQX `follow`
 * query(ies), execute via the shared runner, and shape the walk output into
 * { documents, links, frontier }. Throws EngineError (doc_missing/target_missing)
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

  const { items: userSelect, outNames } = buildUserSelect(args.select);

  const queries: string[] = [];
  const docMap = new Map<string, GraphDoc>();
  const edgeMap = new Map<string, GraphEdge>();
  let queryTruncated = false;

  for (const dir of dirs) {
    const q = buildQuery(rootIds, dir, depth, userSelect);
    queries.push(q);
    // Fetch one more than the cap to detect truncation of a single scan; `follow
    // distinct` yields one row per reached node so the row count == node count.
    const res = await oqxRunAsync(store, repoId, q, { limit: maxDocuments + 1 }, embedQuery);
    if (res.truncated) queryTruncated = true;

    for (const hit of res.hits) {
      const hopDepth = Number(hit[DEPTH_ALIAS]); // $depth: seed = 1
      const degree = hopDepth - 1; // root = 0
      // The walk's hits carry `_id`/`_path` (spec/surface §1.4, 5.0) and so
      // does `graph`'s document: one notation for a document everywhere.
      const prev = docMap.get(hit._id);
      if (!prev || degree < prev.degree) {
        const doc: GraphDoc = { _id: hit._id, _path: hit._path, degree, frontier: false };
        outNames.forEach((name, i) => {
          // An `_id`/`_path` selection is the envelope key itself (same value).
          if (name !== undefined && name !== "_id" && name !== "_path") doc[name] = hit[`_u${i}`] ?? null;
        });
        docMap.set(hit._id, doc);
      }
      // Gather this node's edges; dedup by edge id (an a→b edge is reachable as
      // a's out-edge AND b's in-edge in "both" mode).
      const raw = (hit[LINKS_ALIAS] as GraphEdge[] | null) ?? [];
      for (const e of raw) if (!edgeMap.has(e._id)) edgeMap.set(e._id, e);
    }
  }

  // Predicate filter restricts the NEIGHBORHOOD, not just the edge list: a doc is
  // in-neighborhood only if reachable from a root by edges of that predicate
  // within `degrees`. The unrestricted walk already collected every edge in the
  // wider neighborhood (and any predicate-P path of length ≤ degrees stays inside
  // it, since each prefix is reachable at ≤ that depth), so we recompute
  // reachability over the P-filtered edges rather than issuing more queries.
  if (args.predicate) {
    const P = args.predicate;
    const adj = new Map<string, string[]>();
    const link = (from: string, to: string): void => { (adj.get(from) ?? adj.set(from, []).get(from)!).push(to); };
    for (const e of edgeMap.values()) {
      if (e._predicate !== P) continue;
      if (dirs.includes("out")) link(e._doc_id, e._dst_id); // forward
      if (dirs.includes("in")) link(e._dst_id, e._doc_id); // backward
    }
    const depthOf = new Map<string, number>(rootIds.map((id) => [id, 0]));
    let wave = [...rootIds];
    for (let lvl = 1; lvl <= effectiveDegrees && wave.length > 0; lvl++) {
      const next: string[] = [];
      for (const from of wave) {
        for (const to of adj.get(from) ?? []) {
          // Only traverse to real reached documents (external/phantom targets stay
          // edge stubs, handled below — never in-neighborhood nodes).
          if (docMap.has(to) && !depthOf.has(to)) { depthOf.set(to, lvl); next.push(to); }
        }
      }
      wave = next;
    }
    const restricted = new Map<string, GraphDoc>();
    for (const [id, d] of depthOf) {
      const orig = docMap.get(id);
      if (orig) restricted.set(id, { ...orig, degree: d });
    }
    docMap.clear();
    for (const [id, d] of restricted) docMap.set(id, d);
  }

  // Cap the distinct document set (nearest-first), then bound edges to it.
  const allDocs = [...docMap.values()].sort((a, b) => a.degree - b.degree || cmpBytes(a._path, b._path));
  const capped = allDocs.length > maxDocuments;
  const documents = allDocs.slice(0, maxDocuments);
  const reached = new Set(documents.map((d) => d._id));
  const truncated = queryTruncated || capped;

  // Mark the outer boundary: a node whose MIN degree equals the requested reach
  // was only ever touched at the edge of the walk (never expanded past). At
  // degrees 0 the roots themselves are the boundary.
  const frontier: { _id: string; _path: string; degree: number }[] = [];
  for (const d of documents) {
    d.frontier = d.degree === effectiveDegrees;
    if (d.frontier) frontier.push({ _id: d._id, _path: d._path, degree: d.degree });
  }

  // Keep the induced-subgraph edges (both endpoints in the neighborhood) plus
  // dangling stubs to external/phantom targets, so external (x_…) and phantom
  // endpoints survive the way `from links` surfaces them. A `predicate` filter
  // keeps only that predicate's edges (the neighborhood was already restricted to
  // predicate-reachable docs above).
  const edges: GraphEdge[] = [];
  for (const e of edgeMap.values()) {
    if (args.predicate && e._predicate !== args.predicate) continue;
    const srcIn = reached.has(e._doc_id);
    const dstDangling = e._dst_kind === "external" || (e._dst_kind === "document" && e._dst_path === null);
    const dstIn = reached.has(e._dst_id) || dstDangling;
    if (srcIn && dstIn) edges.push(e);
  }
  edges.sort((a, b) => cmpBytes(a._doc_id, b._doc_id) || cmpBytes(a._id, b._id));

  return {
    roots: rootIds,
    degrees: effectiveDegrees,
    direction,
    documents,
    links: edges,
    frontier,
    truncated,
    queries,
  };
}
