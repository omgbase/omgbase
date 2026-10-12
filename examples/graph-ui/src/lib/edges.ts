// Edge fetching through the `query` tool, by generated OQX.
//
// Strategy: the link rows (`from links` on a 3.0 server, `from edges` before —
// spec/surface §1.1, spelled per server by `linksTarget`), restricted to the
// shown nodes with a chunked disjunction — OQX has no array literal (`path in
// [...]` is a lex error) and `in` only takes a lifted set or a range, so the
// node set is spelled `(path == "a" || path == "b" || …)` in chunks of CHUNK
// paths. The result is filtered client-side so only edges between SHOWN nodes
// remain (the disjunction constrains the source only). The alternative — a
// nested `doc.out_links collect { … }` (`doc.out_edges` before 3.0) per doc —
// also works against the engine but returns one row per doc with the edges
// inlined; the flat edge rows are simpler to merge across chunks and page
// with the tool's cursor. An edge is a link row read source → destination:
// its `path` (the source document, `doc_id`'s path) → its `dst_path` (the
// destination document, `dst_id`'s path — what `dst` reaches on 3.0); the
// builtin links candidate (`doc.out_links`) draws them as stored and the
// backlinks candidate (`doc.in_links`) flipped.
//
// Paths: the shown nodes are keyed by the `/`-rooted path (lib/paths.ts). The
// literals are spelled the way the connected server expects (`serverPath`:
// bare on surface 1.x, rooted on 2.0 — where both forms match) and the rows'
// paths are rooted before they are compared with the node keys, so the edges
// come out the same against either server.
//
// Field names: surface 3.0 renamed the link rows' attributes too (spec/surface
// §1.2 — `$path` → `path`, `$dst_path` → `dst_path`, `src_field` → `field`), so
// the query is spelled per server (`edgeFields`, lib/shapes.ts); the projection
// aliases (`src`/`dst`) are the demo's own and the same on both.

import type { Candidate, Direction, InversePair } from "./candidates.ts";
import { rooted, serverPath } from "./paths.ts";
import { edgeFields, linksTarget } from "./shapes.ts";

export interface GraphEdge {
  /** Source doc path (the edge's `path`, `/`-rooted). */
  src: string;
  /** Destination doc path (the edge's `dst_path` — `$dst_path` before 3.0 — `/`-rooted). */
  dst: string;
  /** The candidate name this edge belongs to. */
  rel: string;
}

export const CHUNK = 40;

/** An OQX string literal. */
export function oqxString(s: string): string {
  return JSON.stringify(s);
}

export function pathDisjunction(paths: readonly string[], field: string): string {
  return `(${paths.map((p) => `${field} == ${oqxString(p)}`).join(" || ")})`;
}

export function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The queries that fetch one relationship's edges among `paths` (one per
 * chunk), with the row kind (`links` / `edges`), the path literals and the
 * edge field names in the form `serverSurface` expects. */
export function edgeQueries(candidate: Pick<Candidate, "name" | "kind">, paths: readonly string[], serverSurface: string | null = null): string[] {
  if (paths.length === 0 || candidate.kind === "sequence") return [];
  const f = edgeFields(serverSurface);
  const target = linksTarget(serverSurface);
  const relation =
    candidate.kind === "frontmatter"
      ? `${f.field} == ${oqxString(candidate.name)} && provenance == "frontmatter"`
      : `provenance == "link" && dst_kind == "document"`;
  return chunked(paths).map(
    (chunk) => `select src: ${f.path}, dst: ${f.dstPath} from ${target} where ${relation} && ${pathDisjunction(chunk.map((p) => serverPath(serverSurface, p)), f.path)}`,
  );
}

/** Rows from the edge queries → edges between SHOWN nodes (`shown` holds the
 * rooted keys; the rows' paths are rooted before the lookup), deduped; a
 * backlinks candidate (`doc.in_links`; `doc.in` on 2.x) flips direction so an
 * edge points the way the walk goes. */
export function edgesFromRows(
  candidate: Pick<Candidate, "name" | "kind">,
  rows: readonly Record<string, unknown>[],
  shown: ReadonlySet<string>,
): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const row of rows) {
    const src = typeof row.src === "string" ? rooted(row.src) : null;
    const dst = typeof row.dst === "string" ? rooted(row.dst) : null;
    if (!src || !dst || !shown.has(src) || !shown.has(dst) || src === dst) continue;
    const edge = candidate.kind === "backlinks" ? { src: dst, dst: src } : { src, dst };
    const key = `${edge.src}→${edge.dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...edge, rel: candidate.name });
  }
  return out;
}

/** The edge as DRAWN (and laid out) under a direction: `forward` keeps the
 * stored orientation (owner → target, the arrowhead on the target); `backward`
 * flips it so the arrow points at the owner. The same direction feeds elk, so
 * the layout flows the way the arrows point and the picture cannot disagree
 * with itself. `src`/`dst` of the stored edge are what editing reasons about;
 * only the drawing passes through here. */
export function orientEdge<E extends Pick<GraphEdge, "src" | "dst">>(e: E, direction: Direction): E {
  return direction === "backward" ? { ...e, src: e.dst, dst: e.src } : e;
}

export function orientEdges<E extends Pick<GraphEdge, "src" | "dst">>(edges: readonly E[], direction: Direction): E[] {
  return edges.map((e) => orientEdge(e, direction));
}

/** An inverse pair's edges: the union of both members' edges normalised to ONE
 * direction, earlier → later. The `forward` member's edges (`before`: owner
 * precedes target) are kept; the `backward` member's (`after`: owner follows
 * target) are flipped. Deduped — a relation authored from both ends yields one
 * edge — and relabelled with the pair's name. */
export function pairEdges(name: string, pair: Pick<InversePair, "forward" | "backward">, edges: readonly GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    let src: string, dst: string;
    if (e.rel === pair.forward) { src = e.src; dst = e.dst; }
    else if (e.rel === pair.backward) { src = e.dst; dst = e.src; }
    else continue;
    if (src === dst) continue;
    const key = `${src}→${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src, dst, rel: name });
  }
  return out;
}

/** A sequence candidate's edges: consecutive pairs in result order. */
export function sequenceEdges(name: string, orderedPaths: readonly string[]): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (let i = 1; i < orderedPaths.length; i++) {
    const src = orderedPaths[i - 1]!;
    const dst = orderedPaths[i]!;
    if (src !== dst) out.push({ src, dst, rel: name });
  }
  return out;
}
