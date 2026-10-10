// Edge fetching through the `query` tool, by generated OQX.
//
// Strategy: the `edges` target, restricted to the shown nodes with a chunked
// disjunction — OQX has no array literal (`$path in [...]` is a lex error) and
// `in` only takes a lifted set or a range, so the node set is spelled
// `($path == "a" || $path == "b" || …)` in chunks of CHUNK paths. The result is
// filtered client-side so only edges between SHOWN nodes remain (the
// disjunction constrains the source only). The alternative — a nested
// `doc.out_edges collect { … }` per doc — also works against the engine but
// returns one row per doc with the edges inlined; the flat edge rows are
// simpler to merge across chunks and page with the tool's cursor.
//
// Paths: the shown nodes are keyed by the `/`-rooted path (lib/paths.ts). The
// literals are spelled the way the connected server expects (`serverPath`:
// bare on surface 1.x, rooted on 2.0 — where both forms match) and the rows'
// `$path`/`$dst_path` are rooted before they are compared with the node keys,
// so the edges come out the same against either server.

import type { Candidate } from "./candidates.ts";
import { rooted, serverPath } from "./paths.ts";

export interface GraphEdge {
  /** Source doc path (`$path`, `/`-rooted). */
  src: string;
  /** Destination doc path (`$dst_path`, `/`-rooted). */
  dst: string;
  /** The candidate name this edge belongs to. */
  rel: string;
}

export const CHUNK = 40;

/** An OQX string literal. */
export function oqxString(s: string): string {
  return JSON.stringify(s);
}

export function pathDisjunction(paths: readonly string[], field = "$path"): string {
  return `(${paths.map((p) => `${field} == ${oqxString(p)}`).join(" || ")})`;
}

export function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The queries that fetch one relationship's edges among `paths` (one per
 * chunk), with the path literals in the form `serverSurface` expects. */
export function edgeQueries(candidate: Pick<Candidate, "name" | "kind">, paths: readonly string[], serverSurface: string | null = null): string[] {
  if (paths.length === 0 || candidate.kind === "sequence") return [];
  const relation =
    candidate.kind === "frontmatter"
      ? `src_field == ${oqxString(candidate.name)} && provenance == "frontmatter"`
      : `provenance == "link" && dst_kind == "document"`;
  return chunked(paths).map(
    (chunk) => `select src: $path, dst: $dst_path from edges where ${relation} && ${pathDisjunction(chunk.map((p) => serverPath(serverSurface, p)))}`,
  );
}

/** Rows from the edge queries → edges between SHOWN nodes (`shown` holds the
 * rooted keys; the rows' paths are rooted before the lookup), deduped; `doc.in`
 * (backlinks) flips direction so an edge points the way the walk goes. */
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
