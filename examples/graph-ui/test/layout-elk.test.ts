import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { SYNTHETIC_CENTER, buildElkGraph, elkOptions, findCycles, readElkLayout, shortName, spanningForest, summarizeCycles, type ElkAlgorithm } from "../src/lib/layout-elk.ts";
import type { GraphEdge } from "../src/lib/edges.ts";
import { fixedMeasure, sizeCard } from "@omgbase/elements/graph";
import { cardTextFor } from "../src/lib/graph-view.ts";

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
      const sized = rows.map((r) => ({ id: r.id, ...sizeCard(cardTextFor({ label: r.id, row: r }, choice), fit, m) }));
      const { graph } = buildElkGraph(sized.map(({ id, width, height }) => ({ id, width, height })), [], "forward");
      expect(graph.children?.map((c) => [c.id, c.width, c.height])).toEqual(sized.map((n) => [n.id, n.width, n.height]));
    }
    // And the fits differ where it matters: wrap is taller, expand wider, than truncate.
    const long = cardTextFor({ label: "long", row: rows[1]! }, choice);
    const t = sizeCard(long, "truncate", m), w = sizeCard(long, "wrap", m), x = sizeCard(long, "expand", m);
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

describe("elk algorithms", () => {
  it("each algorithm names its own elk algorithm; only layered routes orthogonally", () => {
    expect(elkOptions("layered")["elk.algorithm"]).toBe("layered");
    expect(elkOptions("layered")["elk.edgeRouting"]).toBe("ORTHOGONAL");
    expect(elkOptions("stress")["elk.algorithm"]).toBe("stress");
    expect(elkOptions("radial")["elk.algorithm"]).toBe("radial");
    expect(elkOptions("tree")["elk.algorithm"]).toBe("mrtree");
    expect(elkOptions("grid")["elk.algorithm"]).toBe("rectpacking");
    for (const a of ["stress", "radial", "tree", "grid"] as const) expect(elkOptions(a)["elk.edgeRouting"]).toBeUndefined();
  });

  it("buildElkGraph defaults to layered and passes the algorithm's options through", () => {
    expect(buildElkGraph(N, E, "forward").graph.layoutOptions?.["elk.algorithm"]).toBe("layered");
    expect(buildElkGraph(N, E, "forward", "stress").graph.layoutOptions?.["elk.algorithm"]).toBe("stress");
    expect(buildElkGraph(N, E, "forward", "stress").graph.edges?.length).toBe(buildElkGraph(N, E, "forward").graph.edges?.length);
  });

  it("an unrouted read-back keeps the positions and drops elk's routes, leaving the edges to be drawn straight", () => {
    const laid = {
      id: "root", width: 200, height: 100,
      children: [{ id: "a", x: 1, y: 2, width: 10, height: 10 }],
      edges: [{ id: "e", sources: ["a"], targets: ["a"], sections: [{ id: "s", startPoint: { x: 0, y: 0 }, endPoint: { x: 5, y: 5 } }] }],
    };
    expect(readElkLayout(laid as never).routes.size).toBe(1);
    const flat = readElkLayout(laid as never, false);
    expect(flat.routes.size).toBe(0);
    expect(flat.nodes.get("a")).toEqual({ x: 1, y: 2, width: 10, height: 10 });
  });
});

describe("summarizeCycles", () => {
  const p = (n: string) => `/architecture-atlas/channels/${n}.md`;

  it("names documents, not paths; counts loops and documents", () => {
    expect(shortName("/architecture-atlas/systems/review-engine.md")).toBe("review-engine");
    const s = summarizeCycles([[p("a"), p("b")], [p("c"), p("d"), p("e")]]);
    expect(s.groups).toBe(2);
    expect(s.nodes).toBe(5);
    expect(s.listed[1]!.names.map((n) => n.name)).toEqual(["c", "d", "e"]);
    expect(s.listed[1]!.names[0]!.path).toBe(p("c"));
  });

  it("caps what it lists and says how many more there are", () => {
    const big = Array.from({ length: 10 }, (_, i) => p(`n${i}`));
    const many = Array.from({ length: 6 }, (_, i) => [p(`x${i}`), p(`y${i}`)]);
    const s = summarizeCycles([big, ...many], 4, 6);
    expect(s.listed).toHaveLength(4);
    expect(s.listed[0]!.names).toHaveLength(6);
    expect(s.listed[0]!.more).toBe(4);
    expect(s.moreGroups).toBe(3);
    expect(summarizeCycles([])).toEqual({ groups: 0, nodes: 0, listed: [], moreGroups: 0 });
  });
});

describe("spanningForest", () => {
  const e = (src: string, dst: string): GraphEdge => ({ src, dst, rel: "calls" });

  it("roots at what nothing points at, takes each node once, and drops the edges that close a loop or share a target", () => {
    const f = spanningForest(["a", "b", "c", "d"], [e("a", "b"), e("b", "c"), e("c", "a"), e("a", "d"), e("b", "d")]);
    expect(f.roots).toEqual(["a"]);
    expect(f.tree.map((x) => `${x.src}>${x.dst}`)).toEqual(["a>b", "a>d", "b>c"]);
  });

  it("every isolated node and every entry-less loop is a root of its own", () => {
    const f = spanningForest(["x", "a", "b", "z"], [e("a", "b"), e("b", "a")]);
    expect(f.roots).toEqual(["x", "z", "a"]);
    expect(f.tree.map((t) => `${t.src}>${t.dst}`)).toEqual(["a>b"]);
  });

  it("ignores self-edges, repeats and edges to unknown nodes", () => {
    const f = spanningForest(["a", "b"], [e("a", "a"), e("a", "b"), e("a", "b"), e("a", "nope")]);
    expect(f.tree).toHaveLength(1);
  });
});

describe("every elk algorithm lays out the awkward graphs without stacking nodes", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
  const nodes = (n: number) => ids(n).map((id) => ({ id, width: 120, height: 40 }));
  const e = (s: number, d: number): GraphEdge => ({ src: `n${s}`, dst: `n${d}`, rel: "calls" });
  const graphs: Record<string, { n: number; edges: GraphEdge[] }> = {
    "a loop with isolated nodes": { n: 7, edges: [e(0, 1), e(1, 2), e(2, 0), e(3, 4), e(0, 3), e(1, 3)] },
    "no edges at all": { n: 6, edges: [] },
    "one node": { n: 1, edges: [] },
    "two nodes, one edge": { n: 2, edges: [e(0, 1)] },
    "a tree": { n: 5, edges: [e(0, 1), e(1, 2), e(0, 3), e(3, 4)] },
    "two trees and a loop": { n: 8, edges: [e(0, 1), e(1, 2), e(3, 4), e(5, 6), e(6, 7), e(7, 5)] },
  };
  const elk = new ELK();

  for (const algorithm of ["layered", "stress", "radial", "tree", "grid"] as ElkAlgorithm[]) {
    for (const [label, g] of Object.entries(graphs)) {
      it(`${algorithm}: ${label}`, async () => {
        const { graph, synthetic } = buildElkGraph(nodes(g.n), g.edges, "forward", algorithm);
        const laid = await elk.layout(graph);
        const p = readElkLayout(laid, algorithm === "layered");
        for (const id of synthetic) p.nodes.delete(id);
        expect(p.nodes.size).toBe(g.n);
        const spots = new Set([...p.nodes.values()].map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
        expect(spots.size).toBe(g.n);
      }, 20000);
    }
  }

  it("radial gives several trees a hidden centre, which is dropped; one tree needs none", () => {
    const many = buildElkGraph(nodes(4), [e(0, 1), e(2, 3)], "forward", "radial");
    expect(many.synthetic).toEqual([SYNTHETIC_CENTER]);
    expect(many.graph.children?.some((c) => c.id === SYNTHETIC_CENTER)).toBe(true);
    const one = buildElkGraph(nodes(3), [e(0, 1), e(1, 2)], "forward", "radial");
    expect(one.synthetic).toEqual([]);
  });
});
