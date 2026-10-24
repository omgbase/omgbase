// Layered (DAG) layout input for elkjs, plus the cycle report. Only the AXIS
// relationship's edges participate in layering; the other drawn relationships
// are routed as straight segments between the positioned nodes afterwards, so
// they cannot bend the timeline. The edges arrive already ORIENTED the way they
// are drawn (lib/edges.ts `orientEdge`), so the layout flows left → right the
// way the arrowheads point; `direction: "backward"` is still honoured here for a
// caller that passes stored edges. Cycles are not thrown: elk breaks them
// itself, and the members are reported for a banner.

import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { Direction } from "./candidates.ts";
import type { GraphEdge } from "./edges.ts";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface Point { x: number; y: number }

export interface ElkInput {
  graph: ElkNode;
  /** Ids of the elk edges, in `axisEdges` order, so sections map back. */
  edgeIds: string[];
  /** Nodes added only to help a layout (the radial centre); remove them from the result. */
  synthetic: string[];
}

export function elkEdgeId(e: GraphEdge): string {
  return `${e.rel}|${e.src}|${e.dst}`;
}

/** The elk algorithms the page offers (view.ts `LayoutAlgorithm` minus the
 * demo's own `force`). `tree` is elk's `mrtree`, `grid` is `rectpacking`. */
export type ElkAlgorithm = "layered" | "stress" | "radial" | "tree" | "grid";

const ELK_PADDING = "[top=24,left=24,bottom=24,right=24]";

/** elk's layout options for one algorithm. Only `layered` is routed by elk
 * (orthogonal, bent around the layers); the others place the nodes and the page
 * draws their edges as straight segments. */
export function elkOptions(algorithm: ElkAlgorithm): Record<string, string> {
  switch (algorithm) {
    case "layered":
      return {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "72",
        "elk.spacing.nodeNode": "28",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.cycleBreaking.strategy": "GREEDY",
        "elk.padding": ELK_PADDING,
      };
    case "stress":
      return { "elk.algorithm": "stress", "elk.stress.desiredEdgeLength": "200", "elk.spacing.nodeNode": "40", "elk.padding": ELK_PADDING };
    case "radial":
      return { "elk.algorithm": "radial", "elk.spacing.nodeNode": "40", "elk.padding": ELK_PADDING };
    case "tree":
      return { "elk.algorithm": "mrtree", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "36", "elk.padding": ELK_PADDING };
    case "grid":
      return { "elk.algorithm": "rectpacking", "elk.spacing.nodeNode": "28", "elk.aspectRatio": "1.6", "elk.padding": ELK_PADDING };
  }
}

/** The hidden node that joins a forest's trees for the radial layout. It is
 * placed like any other and then dropped (`ElkInput.synthetic`). */
export const SYNTHETIC_CENTER = "\u0000center";

/** A spanning forest of `edges` over `ids`: breadth-first from every node nothing
 * points at (in input order), then from whatever is left (a loop with no entry).
 * Radial and tree layouts want a tree; a graph with loops, shared targets or
 * isolated nodes is handed to them as this forest. The page still DRAWS every
 * edge — the forest only decides where the nodes go. */
export function spanningForest(ids: readonly string[], edges: readonly GraphEdge[]): { tree: GraphEdge[]; roots: string[] } {
  const known = new Set(ids);
  const out = new Map<string, GraphEdge[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const seenEdge = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.src) || !known.has(e.dst) || e.src === e.dst) continue;
    const key = `${e.src}→${e.dst}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    out.get(e.src)!.push(e);
    indegree.set(e.dst, (indegree.get(e.dst) ?? 0) + 1);
  }
  const reached = new Set<string>();
  const tree: GraphEdge[] = [];
  const roots: string[] = [];
  const grow = (root: string): void => {
    roots.push(root);
    reached.add(root);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      for (const e of out.get(queue[i]!)!) {
        if (reached.has(e.dst)) continue;
        reached.add(e.dst);
        tree.push(e);
        queue.push(e.dst);
      }
    }
  };
  for (const id of ids) if (indegree.get(id) === 0 && !reached.has(id)) grow(id);
  for (const id of ids) if (!reached.has(id)) grow(id);
  return { tree, roots };
}

export function buildElkGraph(
  nodes: readonly LayoutNode[],
  axisEdges: readonly GraphEdge[],
  direction: Direction,
  algorithm: ElkAlgorithm = "layered",
): ElkInput {
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ElkExtendedEdge[] = [];
  const edgeIds: string[] = [];
  const synthetic: string[] = [];
  const seen = new Set<string>();
  // Radial and tree place nodes from a TREE: the spanning forest of the edges, not all of them.
  const forest = algorithm === "radial" || algorithm === "tree" ? spanningForest(nodes.map((n) => n.id), axisEdges) : null;
  for (const e of forest ? forest.tree : axisEdges) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.src === e.dst) continue;
    const [from, to] = direction === "backward" ? [e.dst, e.src] : [e.src, e.dst];
    const id = elkEdgeId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, sources: [from], targets: [to] });
    edgeIds.push(id);
  }
  const children: ElkNode[] = nodes.map((n) => ({ id: n.id, width: n.width, height: n.height }));
  // Radial arranges rings around ONE root: with several trees (or isolated nodes) a hidden centre
  // joins them, so nothing stacks on top of anything else.
  if (algorithm === "radial" && forest && forest.roots.length > 1) {
    children.push({ id: SYNTHETIC_CENTER, width: 8, height: 8 });
    synthetic.push(SYNTHETIC_CENTER);
    for (const r of forest.roots) edges.push({ id: `center|${r}`, sources: [SYNTHETIC_CENTER], targets: [r] });
  }
  const graph: ElkNode = { id: "root", layoutOptions: elkOptions(algorithm), children, edges };
  return { graph, edgeIds, synthetic };
}

/** Strongly connected components with more than one member (or a self-loop),
 * over `edges` restricted to `nodeIds` — Tarjan, iterative enough for a demo. */
export function findCycles(nodeIds: readonly string[], edges: readonly GraphEdge[]): string[][] {
  const ids = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  let selfLoops = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.src) || !ids.has(e.dst)) continue;
    if (e.src === e.dst) { selfLoops.add(e.src); continue; }
    adj.get(e.src)!.push(e.dst);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v)!) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort());
      else if (selfLoops.has(v)) cycles.push([v]);
    }
  };
  for (const id of nodeIds) if (!idx.has(id)) strong(id);
  selfLoops = new Set();
  return cycles.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

export interface Positioned {
  nodes: Map<string, { x: number; y: number; width: number; height: number }>;
  /** Routed polylines for the axis edges, by elk edge id. */
  routes: Map<string, Point[]>;
  width: number;
  height: number;
}

/** Read a laid-out elk graph back into plain positions (absolute coordinates).
 * `routed` is false for the algorithms elk does not route: their edges are
 * left to the page, which draws a straight segment between the placed nodes. */
export function readElkLayout(laid: ElkNode, routed = true): Positioned {
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const c of laid.children ?? []) {
    nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
  }
  const routes = new Map<string, Point[]>();
  for (const e of routed ? (laid.edges ?? []) : []) {
    const s = e.sections?.[0];
    if (!s) continue;
    routes.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
  }
  return { nodes, routes, width: laid.width ?? 0, height: laid.height ?? 0 };
}

// ---- the cycle report ---------------------------------------------------------

/** A path's last segment without `.md` — the short name a list shows (the full
 * path stays in the tooltip). */
export function shortName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export interface CycleSummary {
  /** How many loops (strongly connected groups). */
  groups: number;
  /** Documents in them, in total. */
  nodes: number;
  /** The first `maxGroups` loops, each with its first `maxNames` members; the rest are counted. */
  listed: { names: { name: string; path: string }[]; more: number }[];
  moreGroups: number;
}

/** What `findCycles` found, for a note a person can read: a loop is a set of
 * documents that all reach each other — NOT an ordered path, so members are listed,
 * never joined with arrows — capped so a big estate does not fill the screen. */
export function summarizeCycles(cycles: readonly string[][], maxGroups = 4, maxNames = 6): CycleSummary {
  return {
    groups: cycles.length,
    nodes: cycles.reduce((n, c) => n + c.length, 0),
    listed: cycles.slice(0, maxGroups).map((c) => ({
      names: c.slice(0, maxNames).map((path) => ({ name: shortName(path), path })),
      more: Math.max(0, c.length - maxNames),
    })),
    moreGroups: Math.max(0, cycles.length - maxGroups),
  };
}
