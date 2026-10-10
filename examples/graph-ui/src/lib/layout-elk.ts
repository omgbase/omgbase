// Layered (DAG) layout input for elkjs, plus the cycle report. Only the AXIS
// relationship's edges participate in layering; the other drawn relationships
// are routed as straight segments between the positioned nodes afterwards, so
// they cannot bend the timeline. `direction: "backward"` reverses the axis
// edges before layering (an `after` edge points at the past; the layout still
// flows left → right). Cycles are not thrown: elk breaks them itself, and the
// members are reported for a banner.

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
}

export function elkEdgeId(e: GraphEdge): string {
  return `${e.rel}|${e.src}|${e.dst}`;
}

export function buildElkGraph(
  nodes: readonly LayoutNode[],
  axisEdges: readonly GraphEdge[],
  direction: Direction,
): ElkInput {
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ElkExtendedEdge[] = [];
  const edgeIds: string[] = [];
  const seen = new Set<string>();
  for (const e of axisEdges) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.src === e.dst) continue;
    const [from, to] = direction === "backward" ? [e.dst, e.src] : [e.src, e.dst];
    const id = elkEdgeId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, sources: [from], targets: [to] });
    edgeIds.push(id);
  }
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.nodeNode": "28",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges,
  };
  return { graph, edgeIds };
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

/** Read a laid-out elk graph back into plain positions (absolute coordinates). */
export function readElkLayout(laid: ElkNode): Positioned {
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const c of laid.children ?? []) {
    nodes.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 });
  }
  const routes = new Map<string, Point[]>();
  for (const e of laid.edges ?? []) {
    const s = e.sections?.[0];
    if (!s) continue;
    routes.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
  }
  return { nodes, routes, width: laid.width ?? 0, height: laid.height ?? 0 };
}
