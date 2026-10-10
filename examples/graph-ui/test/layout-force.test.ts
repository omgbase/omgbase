import { describe, expect, it } from "vitest";
import { forceBounds, forceLayout } from "../src/lib/layout-force.ts";
import { cardRadius } from "../src/lib/cards.ts";
import { fitTransform, contentToViewBox } from "../src/lib/viewport.ts";
import type { GraphEdge } from "../src/lib/edges.ts";

const nodes = (n: number, w = 120, h = 30) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, width: w, height: h }));

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("forceLayout", () => {
  it("keeps every card inside the reported box with no two cards overlapping, even with no edges (nodes only repel)", () => {
    const p = forceLayout(nodes(14), []);
    const placed = [...p.nodes.values()];
    expect(placed).toHaveLength(14);
    for (const n of placed) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(p.width + 1e-6);
      expect(n.y + n.height).toBeLessThanOrEqual(p.height + 1e-6);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i]!, placed[j]!), `${i} vs ${j}`).toBe(false);
  });

  it("is bounded: an edgeless cloud stays within the box sized to the node count instead of flying apart", () => {
    const ns = nodes(20);
    const p = forceLayout(ns, []);
    const bound = forceBounds(ns);
    expect(p.width).toBeLessThanOrEqual(2 * bound + 2 * 24 + 1e-6);
    expect(p.height).toBeLessThanOrEqual(2 * bound + 2 * 24 + 1e-6);
    // …and the box has room for every card's covering circle.
    expect(bound).toBeGreaterThanOrEqual(cardRadius(120, 30));
    expect(forceBounds([])).toBe(0);
  });

  it("pulls linked nodes closer than unlinked ones, deterministically", () => {
    const ns = nodes(6);
    const edges: GraphEdge[] = [{ src: "n0", dst: "n1", rel: "r" }];
    const a = forceLayout(ns, edges);
    const b = forceLayout(ns, edges);
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
    const c = (id: string) => { const n = a.nodes.get(id)!; return { x: n.x + n.width / 2, y: n.y + n.height / 2 }; };
    const d = (p: string, q: string) => Math.hypot(c(p).x - c(q).x, c(p).y - c(q).y);
    expect(d("n0", "n1")).toBeLessThan(Math.min(d("n0", "n3"), d("n0", "n4"), d("n0", "n5")));
    // The old positional `ticks` argument still works.
    expect(forceLayout(ns, edges, 300)).toEqual(a);
  });

  it("fits into a view: the settled box, fitted, is fully inside the viewport", () => {
    const p = forceLayout(nodes(30, 200, 60), []);
    const t = fitTransform(p.width, p.height, 900, 500);
    for (const n of p.nodes.values()) {
      const tl = contentToViewBox(t, { x: n.x, y: n.y });
      const br = contentToViewBox(t, { x: n.x + n.width, y: n.y + n.height });
      expect(tl.x).toBeGreaterThanOrEqual(16 - 1e-6);
      expect(tl.y).toBeGreaterThanOrEqual(16 - 1e-6);
      expect(br.x).toBeLessThanOrEqual(900 - 16 + 1e-6);
      expect(br.y).toBeLessThanOrEqual(500 - 16 + 1e-6);
    }
    expect(forceLayout([], []).width).toBe(48);
  });
});
