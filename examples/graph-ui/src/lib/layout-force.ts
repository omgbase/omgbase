// The undirected fallback: d3-force run to quiescence synchronously (no
// animation — the picture should be stable the moment it appears).

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { GraphEdge } from "./edges.ts";
import type { LayoutNode, Positioned } from "./layout-elk.ts";

interface SimNode extends SimulationNodeDatum { id: string; width: number; height: number }

export function forceLayout(nodes: readonly LayoutNode[], edges: readonly GraphEdge[], ticks = 300): Positioned {
  const sim: SimNode[] = nodes.map((n, i) => ({
    id: n.id, width: n.width, height: n.height,
    // A deterministic seed (a spiral) so the same graph lays out the same way.
    x: Math.cos(i * 2.4) * 20 * Math.sqrt(i + 1),
    y: Math.sin(i * 2.4) * 20 * Math.sqrt(i + 1),
  }));
  const ids = new Set(sim.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => ids.has(e.src) && ids.has(e.dst) && e.src !== e.dst)
    .map((e) => ({ source: e.src, target: e.dst }));
  const simulation = forceSimulation(sim)
    .force("charge", forceManyBody().strength(-260))
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(110))
    .force("collide", forceCollide<SimNode>().radius((d) => Math.max(d.width, d.height) / 2 + 12))
    .force("center", forceCenter(0, 0))
    .stop();
  for (let i = 0; i < ticks; i++) simulation.tick();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of sim) {
    minX = Math.min(minX, n.x! - n.width / 2); maxX = Math.max(maxX, n.x! + n.width / 2);
    minY = Math.min(minY, n.y! - n.height / 2); maxY = Math.max(maxY, n.y! + n.height / 2);
  }
  if (sim.length === 0) { minX = minY = 0; maxX = maxY = 0; }
  const pad = 24;
  const out: Positioned["nodes"] = new Map();
  for (const n of sim) {
    out.set(n.id, { x: n.x! - n.width / 2 - minX + pad, y: n.y! - n.height / 2 - minY + pad, width: n.width, height: n.height });
  }
  return { nodes: out, routes: new Map(), width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}
