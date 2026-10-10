// The fallback when no relationship lays the graph out: d3-force run to
// quiescence synchronously (no animation — the picture should be stable the
// moment it appears). Nodes repel (`forceManyBody`), the drawn edges pull
// (`forceLink`), cards keep apart by their covering radius (`forceCollide`,
// lib/cards.ts `cardRadius`), the whole drifts back to the origin
// (`forceCenter`) and every node is kept inside a box sized to the node count,
// so a graph with no edges — nothing pulls — settles as a compact cloud instead
// of flying apart. Deterministic: a spiral seed, no randomness.

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { cardRadius } from "./cards.ts";
import type { GraphEdge } from "./edges.ts";
import type { LayoutNode, Positioned } from "./layout-elk.ts";

interface SimNode extends SimulationNodeDatum { id: string; width: number; height: number; r: number }

export interface ForceOptions {
  /** Simulation ticks (d3's alpha decays over ~300). */
  ticks?: number;
  /** Margin around the cloud. */
  pad?: number;
}

/** Half the side of the box the nodes are kept in: room for every card's
 * covering circle on a square grid, with slack for the repulsion to spread
 * them, never smaller than one card. */
export function forceBounds(nodes: readonly { width: number; height: number }[]): number {
  if (nodes.length === 0) return 0;
  const radii = nodes.map((n) => cardRadius(n.width, n.height));
  const maxR = Math.max(...radii);
  const area = radii.reduce((sum, r) => sum + (2 * r) ** 2, 0);
  return Math.max(maxR, Math.sqrt(area) * 0.9);
}

export function forceLayout(nodes: readonly LayoutNode[], edges: readonly GraphEdge[], options: ForceOptions | number = {}): Positioned {
  const { ticks = 300, pad = 24 } = typeof options === "number" ? { ticks: options } : options;
  const sim: SimNode[] = nodes.map((n, i) => ({
    id: n.id, width: n.width, height: n.height, r: cardRadius(n.width, n.height),
    // A deterministic seed (a spiral) so the same graph lays out the same way.
    x: Math.cos(i * 2.4) * 20 * Math.sqrt(i + 1),
    y: Math.sin(i * 2.4) * 20 * Math.sqrt(i + 1),
  }));
  const ids = new Set(sim.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => ids.has(e.src) && ids.has(e.dst) && e.src !== e.dst)
    .map((e) => ({ source: e.src, target: e.dst }));
  const bound = forceBounds(sim);
  const simulation = forceSimulation(sim)
    .force("charge", forceManyBody<SimNode>().strength(-260).distanceMax(Math.max(200, bound)))
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(110))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r).iterations(2))
    .force("center", forceCenter(0, 0))
    .stop();
  // The box: after each tick (forces, then velocities integrated) a node past
  // the bound is put back on it and stops moving outward, so the pile inside
  // still resolves while nothing escapes.
  const clamp = (): void => {
    for (const n of sim) {
      const x = Math.max(-bound + n.width / 2, Math.min(bound - n.width / 2, n.x!));
      const y = Math.max(-bound + n.height / 2, Math.min(bound - n.height / 2, n.y!));
      if (x !== n.x) { n.x = x; n.vx = 0; }
      if (y !== n.y) { n.y = y; n.vy = 0; }
    }
  };
  for (let i = 0; i < ticks; i++) { simulation.tick(); clamp(); }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of sim) {
    minX = Math.min(minX, n.x! - n.width / 2); maxX = Math.max(maxX, n.x! + n.width / 2);
    minY = Math.min(minY, n.y! - n.height / 2); maxY = Math.max(maxY, n.y! + n.height / 2);
  }
  if (sim.length === 0) { minX = minY = 0; maxX = maxY = 0; }
  const out: Positioned["nodes"] = new Map();
  for (const n of sim) {
    out.set(n.id, { x: n.x! - n.width / 2 - minX + pad, y: n.y! - n.height / 2 - minY + pad, width: n.width, height: n.height });
  }
  return { nodes: out, routes: new Map(), width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}
