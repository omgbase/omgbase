// Edge fetching through the `query` tool, by generated OQX.
//
// Strategy: the link rows (`links { … }`, spec/surface §1.1), restricted to the
// shown nodes with a chunked disjunction — OQX has no array literal (`_path in
// [...]` is a lex error) and `in` only takes a lifted set or a range, so the
// node set is spelled `(_path == "a" || _path == "b" || …)` in chunks of CHUNK
// paths. The result is filtered client-side so only edges between SHOWN nodes
// remain (the disjunction constrains the source only). The alternative — a
// nested `_out_links { … }` per doc — also works against the engine
// but returns one row per doc with the edges inlined; the flat edge rows are
// simpler to merge across chunks and page with the tool's cursor. An edge is a
// link row read source → destination: its `_path` (the source document,
// `_doc_id`'s path) → its `_dst_path` (the destination document, `_dst_id`'s
// path — what `_dst` reaches); the builtin links candidate (`_out_links`) draws
// them as stored and the backlinks candidate (`_in_links`) flipped.
//
// The attributes are spelled for the connected server (lib/paths.ts
// `EngineNames`: `_path`/`_dst_path`/`_field`/`_provenance`/`_dst_kind` from
// surface 5.0, bare before). Paths: the shown nodes are keyed by the
// `/`-rooted path (lib/paths.ts), the literals are spelled rooted, and the
// rows' paths are rooted before they are compared with the node keys. The
// projection aliases (`src`/`dst`) are the demo's own.

import type { Candidate, Direction, InversePair } from "./candidates.ts";
import { NAMES_5, rooted, type EngineNames } from "./paths.ts";

export interface GraphEdge {
  /** Source doc path (the link row's `_path`, `/`-rooted). */
  src: string;
  /** Destination doc path (the link row's `_dst_path`, `/`-rooted). */
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
 * chunk), in the server's spelling of the link-row attributes. */
export function edgeQueries(candidate: Pick<Candidate, "name" | "kind">, paths: readonly string[], names: EngineNames = NAMES_5): string[] {
  if (paths.length === 0 || candidate.kind === "sequence") return [];
  const relation =
    candidate.kind === "frontmatter"
      ? `${names.field} == ${oqxString(candidate.name)} && ${names.provenance} == "frontmatter"`
      : `${names.provenance} == "link" && ${names.dst_kind} == "document"`;
  return chunked(paths).map(
    (chunk) => `links { select src: ${names.path}, dst: ${names.dst_path} where ${relation} && ${pathDisjunction(chunk.map(rooted), names.path)} }`,
  );
}

/** Rows from the edge queries → edges between SHOWN nodes (`shown` holds the
 * rooted keys; the rows' paths are rooted before the lookup), deduped; a
 * backlinks candidate (`_in_links`) flips direction so an edge points the
 * way the walk goes. */
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
