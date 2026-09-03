import type { Store } from "../core/store/store.js";

// Traversal API (05 §3). Iterative frontier expansion in SQL; visited set in
// memory; budgets enforced per step; truncated set honestly. No graph query
// language (ADR-006). as_of filters edges by validity interval.

export type Direction = "out" | "in" | "both";

export interface TraverseSpec {
  from: string[];
  via?: string[]; // predicates; empty = any authored predicate
  direction?: Direction;
  depth?: number; // hard cap 8
  budget?: { maxNodes?: number; maxEdges?: number };
  asOf?: number | null; // commit seq; edges valid at that point
}

export interface EdgeRow {
  edge_id: string;
  src_doc: string;
  src_block: string | null;
  predicate: string;
  dst_node: string;
  from_commit: string;
  to_commit: string | null;
}

export interface TraverseResult {
  nodes: string[];
  edges: { src: string; predicate: string; dst: string }[];
  truncated: boolean;
  frontier: string[];
  budgetSpent: { nodes: number; edges: number };
}

const HARD_DEPTH_CAP = 8;

// Fetch edges touching a frontier in a direction. Traversal is doc-grain (05
// §3): nodes are keyed by SOURCE DOCUMENT (src_doc), so a frontier of doc ids
// expands to doc ids; dst_node is already a doc/external/collection id.
// Temporal validity uses the commit-seq interval; asOf null ⇒ open rows.
function stepEdges(store: Store, frontier: string[], via: string[] | undefined, direction: Direction, asOfSeq: number | null): EdgeRow[] {
  if (frontier.length === 0) return [];
  const placeholders = frontier.map(() => "?").join(",");
  const viaClause = via && via.length > 0 ? `AND e.predicate IN (${via.map(() => "?").join(",")})` : "";
  const timeClause = asOfSeq === null
    ? "AND e.to_commit IS NULL"
    : `AND (SELECT seq FROM commits WHERE commit_id = e.from_commit) <= ?
       AND (e.to_commit IS NULL OR (SELECT seq FROM commits WHERE commit_id = e.to_commit) > ?)`;

  const query = (matchCol: "src_doc" | "dst_node"): EdgeRow[] => {
    const params: unknown[] = [...frontier];
    if (via && via.length > 0) params.push(...via);
    if (asOfSeq !== null) params.push(asOfSeq, asOfSeq);
    return store.db.prepare(
      `SELECT e.edge_id, e.src_doc, e.src_block, e.predicate, e.dst_node, e.from_commit, e.to_commit
       FROM edges e WHERE e.${matchCol} IN (${placeholders}) ${viaClause} ${timeClause}`,
    ).all(...params) as EdgeRow[];
  };

  const rows: EdgeRow[] = [];
  if (direction === "out" || direction === "both") rows.push(...query("src_doc"));
  if (direction === "in" || direction === "both") rows.push(...query("dst_node"));
  return rows;
}

export function graphTraverse(store: Store, spec: TraverseSpec): TraverseResult {
  const direction = spec.direction ?? "out";
  const depth = Math.min(spec.depth ?? 3, HARD_DEPTH_CAP);
  const maxNodes = spec.budget?.maxNodes ?? 200;
  const maxEdges = spec.budget?.maxEdges ?? 800;
  const asOfSeq = spec.asOf ?? null;

  const visited = new Set<string>(spec.from);
  const outEdges: { src: string; predicate: string; dst: string }[] = [];
  const seenEdge = new Set<string>();
  let frontier = [...spec.from];
  let truncated = false;

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const edges = stepEdges(store, frontier, spec.via, direction, asOfSeq);
    const nextFrontier: string[] = [];
    for (const e of edges) {
      if (seenEdge.has(e.edge_id)) continue;
      seenEdge.add(e.edge_id);
      const src = e.src_doc; // doc-grain node key
      outEdges.push({ src, predicate: e.predicate, dst: e.dst_node });
      if (outEdges.length >= maxEdges) { truncated = true; break; }
      // Determine the newly-reached node depending on which side matched.
      for (const cand of [e.dst_node, src]) {
        if (!visited.has(cand)) {
          if (visited.size >= maxNodes) { truncated = true; break; }
          visited.add(cand);
          nextFrontier.push(cand);
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = nextFrontier;
  }

  return {
    nodes: [...visited],
    edges: outEdges,
    truncated,
    frontier,
    budgetSpent: { nodes: visited.size, edges: outEdges.length },
  };
}

export interface PathSpec {
  from: string;
  to: string;
  via?: string[];
  direction?: Direction;
  maxLen?: number; // ≤ 8
  k?: number; // ≤ 5, default 1
  asOf?: number | null;
}

/** graph_path: up to k shortest paths via BFS. */
export function graphPath(store: Store, spec: PathSpec): { paths: string[][]; truncated: boolean } {
  const direction = spec.direction ?? "out";
  const maxLen = Math.min(spec.maxLen ?? HARD_DEPTH_CAP, HARD_DEPTH_CAP);
  const k = Math.min(spec.k ?? 1, 5);
  const asOfSeq = spec.asOf ?? null;

  const paths: string[][] = [];
  // BFS over partial paths; enqueue neighbors until we collect k paths to `to`.
  const queue: string[][] = [[spec.from]];
  while (queue.length > 0 && paths.length < k) {
    const path = queue.shift()!;
    const tail = path[path.length - 1]!;
    if (tail === spec.to && path.length > 1) { paths.push(path); continue; }
    if (path.length > maxLen) continue;
    const edges = stepEdges(store, [tail], spec.via, direction, asOfSeq);
    const neighbors = new Set<string>();
    for (const e of edges) {
      const src = e.src_doc; // doc-grain node key
      if (src === tail) neighbors.add(e.dst_node);
      if (e.dst_node === tail) neighbors.add(src);
    }
    for (const n of [...neighbors].sort()) {
      if (!path.includes(n)) queue.push([...path, n]);
    }
  }
  return { paths, truncated: paths.length >= k };
}

export interface SubgraphSpec {
  seeds: string[];
  via?: string[];
  radius?: number; // ≤ 3
  budget?: { maxNodes?: number; maxEdges?: number };
}

/** graph_subgraph: induced subgraph around seeds (both directions). */
export function graphSubgraph(store: Store, spec: SubgraphSpec): TraverseResult {
  const traverseSpec: TraverseSpec = {
    from: spec.seeds,
    direction: "both",
    depth: Math.min(spec.radius ?? 2, 3),
  };
  if (spec.via) traverseSpec.via = spec.via;
  if (spec.budget) traverseSpec.budget = spec.budget;
  return graphTraverse(store, traverseSpec);
}
