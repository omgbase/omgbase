import type { Store } from "../core/store/store.js";
import { docPropertiesMerged } from "../core/store/properties.js";
import { findDoc } from "../core/read/reader.js";
import { EngineError } from "../mcp/errors.js";

// Traversal API (05 §3). Iterative frontier expansion in SQL; visited set in
// memory; budgets enforced per step; truncated set honestly. No graph query
// language (ADR-006). as_of filters edges by validity interval.

export type Direction = "out" | "in" | "both";

export interface TraverseSpec {
  from: string[];
  repoId?: string;
  via?: string[]; // predicates; empty = any authored predicate
  direction?: Direction;
  depth?: number; // hard cap 8
  budget?: { maxNodes?: number; maxEdges?: number };
  asOf?: number | null; // commit seq; edges valid at that point
  /**
   * Project metadata for every node in the result. `["$path", "type", ...]`:
   * `$path` and bare frontmatter keys resolve against the node's document;
   * `$kind` marks document|phantom|external. Without this the result is opaque
   * ids and callers must hydrate each one — the graph API's sharpest edge.
   */
  select?: string[];
}

/** Projected metadata for one node id, keyed into TraverseResult.nodeInfo. */
export interface NodeInfo {
  kind: "document" | "phantom" | "external";
  path?: string; // doc path, phantom target path, or external uri
  [k: string]: unknown; // projected frontmatter keys
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
  /** node id → projected metadata; present only when `select` was requested. */
  nodeInfo?: Record<string, NodeInfo>;
}

const HARD_DEPTH_CAP = 8;

// Traversal is doc-grain: edges are keyed by source document, so seeds must be
// doc ids. Callers frequently hold a block id (from docs_outline, query, or
// resolve) and expect it to "just work"; silently returning no edges is the
// single sharpest edge in the graph API. Normalize any block-grain seed to its
// owning document id before expansion. Path strings are resolved to their
// document id when repoId is available; unresolvable paths throw seed_unresolved
// rather than silently minting a phantom node.
function normalizeSeeds(store: Store, seeds: string[], repoId?: string): string[] {
  const blockIds = seeds.filter((s) => s.startsWith("b_"));
  const out: string[] = [];

  // Batch-resolve block ids.
  const docByBlock = new Map<string, string>();
  if (blockIds.length > 0) {
    const placeholders = blockIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(`SELECT block_id, doc_id FROM blocks WHERE block_id IN (${placeholders})`)
      .all(...blockIds) as { block_id: string; doc_id: string }[];
    for (const r of rows) docByBlock.set(r.block_id, r.doc_id);
  }

  const unresolved: string[] = [];
  for (const s of seeds) {
    if (s.startsWith("b_")) {
      const mapped = docByBlock.get(s);
      if (mapped) out.push(mapped);
      // Unknown block ids drop out (they touch no edges anyway).
      continue;
    }
    // Recognized node ids (d_, x_, phantom:) pass through.
    if (s.startsWith("d_") || s.startsWith("x_") || s.startsWith("phantom:")) {
      out.push(s);
      continue;
    }
    // Anything else is treated as a document path.
    if (repoId) {
      const info = findDoc(store, { repoId, path: s });
      if (info) { out.push(info.docId); continue; }
    }
    unresolved.push(s);
  }

  if (unresolved.length > 0) {
    throw new EngineError("seed_unresolved",
      `Seed${unresolved.length > 1 ? "s" : ""} could not be resolved to a node: ${unresolved.join(", ")}`,
      { data: { seeds: unresolved } });
  }

  return [...new Set(out)];
}

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

  const seeds = normalizeSeeds(store, spec.from, spec.repoId);
  const visited = new Set<string>(seeds);
  const outEdges: { src: string; predicate: string; dst: string }[] = [];
  const seenEdge = new Set<string>();
  let frontier = [...seeds];
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

  const result: TraverseResult = {
    nodes: [...visited],
    edges: outEdges,
    truncated,
    frontier,
    budgetSpent: { nodes: visited.size, edges: outEdges.length },
  };
  if (spec.select && spec.select.length > 0) {
    result.nodeInfo = projectNodes(store, result.nodes, spec.select);
  }
  return result;
}

// Resolve every node id in the result to projected metadata. Document ids join
// `documents` for path + frontmatter; `phantom:<path>` ids carry their target
// path in the id itself (unresolved link targets — useful for graph health);
// external `x_*` ids join `external_nodes` for the uri. `$kind` is always set.
function projectNodes(store: Store, nodeIds: string[], select: string[]): Record<string, NodeInfo> {
  const out: Record<string, NodeInfo> = {};
  const docIds = nodeIds.filter((id) => id.startsWith("d_"));
  const externalIds = nodeIds.filter((id) => id.startsWith("x_"));

  const docMeta = new Map<string, { path: string }>();
  if (docIds.length > 0) {
    const ph = docIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(`SELECT doc_id, path FROM docs WHERE doc_id IN (${ph})`)
      .all(...docIds) as { doc_id: string; path: string }[];
    for (const r of rows) docMeta.set(r.doc_id, { path: r.path });
  }

  const extUri = new Map<string, string>();
  if (externalIds.length > 0) {
    const ph = externalIds.map(() => "?").join(",");
    const rows = store.db
      .prepare(`SELECT node_id, uri FROM external_nodes WHERE node_id IN (${ph})`)
      .all(...externalIds) as { node_id: string; uri: string }[];
    for (const r of rows) extUri.set(r.node_id, r.uri);
  }

  const wantPath = select.includes("$path");
  const fmKeys = select.filter((s) => !s.startsWith("$"));

  for (const id of nodeIds) {
    if (id.startsWith("phantom:")) {
      out[id] = { kind: "phantom", ...(wantPath ? { path: id.slice("phantom:".length) } : {}) };
      continue;
    }
    if (id.startsWith("x_")) {
      const uri = extUri.get(id);
      out[id] = { kind: "external", ...(wantPath && uri ? { path: uri } : {}) };
      continue;
    }
    const meta = docMeta.get(id);
    const info: NodeInfo = { kind: "document" };
    if (meta) {
      if (wantPath) info.path = meta.path;
      if (fmKeys.length > 0) {
        const bag = docPropertiesMerged(store.db, id);
        for (const k of fmKeys) if (bag[k] !== undefined) info[k] = bag[k];
      }
    }
    out[id] = info;
  }
  return out;
}

export interface PathSpec {
  from: string;
  to: string;
  repoId?: string;
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

  const [from] = normalizeSeeds(store, [spec.from], spec.repoId);
  const [to] = normalizeSeeds(store, [spec.to], spec.repoId);
  if (!from || !to) return { paths: [], truncated: false };

  const paths: string[][] = [];
  // BFS over partial paths; enqueue neighbors until we collect k paths to `to`.
  const queue: string[][] = [[from]];
  while (queue.length > 0 && paths.length < k) {
    const path = queue.shift()!;
    const tail = path[path.length - 1]!;
    if (tail === to && path.length > 1) { paths.push(path); continue; }
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
  repoId?: string;
  via?: string[];
  radius?: number; // ≤ 3
  budget?: { maxNodes?: number; maxEdges?: number };
}

/** graph_subgraph: induced subgraph around seeds (both directions). */
export function graphSubgraph(store: Store, spec: SubgraphSpec): TraverseResult {
  const traverseSpec: TraverseSpec = {
    from: spec.seeds,
    ...(spec.repoId ? { repoId: spec.repoId } : {}),
    direction: "both",
    depth: Math.min(spec.radius ?? 2, 3),
  };
  if (spec.via) traverseSpec.via = spec.via;
  if (spec.budget) traverseSpec.budget = spec.budget;
  return graphTraverse(store, traverseSpec);
}
