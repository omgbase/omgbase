import { describe, expect, it } from "vitest";
import { buildElkGraph, findCycles, readElkLayout } from "../src/lib/layout-elk.ts";
import type { GraphEdge } from "../src/lib/edges.ts";
import { cardSize, fixedMeasure } from "../src/lib/card-size.ts";
import { cardFor } from "../src/lib/cards.ts";

const N = ["a", "b", "c", "d"].map((id) => ({ id, width: 100, height: 30 }));
const E: GraphEdge[] = [
  { src: "a", dst: "b", rel: "before" },
  { src: "b", dst: "c", rel: "before" },
  { src: "b", dst: "c", rel: "before" }, // duplicate
  { src: "c", dst: "zz", rel: "before" }, // not shown
  { src: "d", dst: "d", rel: "before" }, // self loop
];

describe("buildElkGraph", () => {
  it("emits one layered graph with deduped edges between shown nodes only", () => {
    const { graph, edgeIds } = buildElkGraph(N, E, "forward");
    expect(graph.layoutOptions?.["elk.algorithm"]).toBe("layered");
    expect(graph.children?.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(graph.edges?.map((e) => [e.sources[0], e.targets[0]])).toEqual([["a", "b"], ["b", "c"]]);
    expect(edgeIds).toEqual(["before|a|b", "before|b|c"]);
  });

  it("reverses the axis edges for a backward relationship", () => {
    const { graph } = buildElkGraph(N, E, "backward");
    expect(graph.edges?.map((e) => [e.sources[0], e.targets[0]])).toEqual([["b", "a"], ["c", "b"]]);
  });

  it("gives every elk child the card's own size — the label fit's width and height, not a fixed box", () => {
    const m = fixedMeasure(10);
    const choice = { label: "title", shown: ["title"] };
    const rows = [
      { id: "short", title: "Kickoff" },
      { id: "long", title: "A rather long document title that will not fit on a single card line" },
    ];
    for (const fit of ["truncate", "wrap", "expand"] as const) {
      const sized = rows.map((r) => ({ id: r.id, ...cardSize(cardFor({ label: r.id, row: r }, choice), fit, m) }));
      const { graph } = buildElkGraph(sized.map(({ id, width, height }) => ({ id, width, height })), [], "forward");
      expect(graph.children?.map((c) => [c.id, c.width, c.height])).toEqual(sized.map((n) => [n.id, n.width, n.height]));
    }
    // And the fits differ where it matters: wrap is taller, expand wider, than truncate.
    const long = cardFor({ label: "long", row: rows[1]! }, choice);
    const t = cardSize(long, "truncate", m), w = cardSize(long, "wrap", m), x = cardSize(long, "expand", m);
    expect(w.height).toBeGreaterThan(t.height);
    expect(w.width).toBe(t.width);
    expect(x.width).toBeGreaterThan(t.width);
  });
});

describe("findCycles", () => {
  it("reports strongly connected components and self loops, sorted", () => {
    const edges: GraphEdge[] = [
      { src: "a", dst: "b", rel: "r" }, { src: "b", dst: "c", rel: "r" }, { src: "c", dst: "a", rel: "r" },
      { src: "c", dst: "d", rel: "r" }, { src: "e", dst: "e", rel: "r" }, { src: "x", dst: "a", rel: "r" },
    ];
    expect(findCycles(["a", "b", "c", "d", "e", "x"], edges)).toEqual([["a", "b", "c"], ["e"]]);
    expect(findCycles(["a", "b"], [{ src: "a", dst: "b", rel: "r" }])).toEqual([]);
  });
});

describe("readElkLayout", () => {
  it("reads absolute positions and polylines back", () => {
    const laid = {
      id: "root", width: 300, height: 100,
      children: [{ id: "a", x: 10, y: 20, width: 100, height: 30 }],
      edges: [{ id: "e", sources: ["a"], targets: ["b"], sections: [{ id: "s", startPoint: { x: 1, y: 2 }, bendPoints: [{ x: 3, y: 4 }], endPoint: { x: 5, y: 6 } }] }],
    };
    const p = readElkLayout(laid);
    expect(p.nodes.get("a")).toEqual({ x: 10, y: 20, width: 100, height: 30 });
    expect(p.routes.get("e")).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
    expect([p.width, p.height]).toEqual([300, 100]);
  });
});
