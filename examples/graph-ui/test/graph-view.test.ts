import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk.bundled.js";
import { CARD, cardWidth, fixedMeasure, sizeCard } from "@omgbase/elements/graph";
import type { Candidate } from "../src/lib/candidates.ts";
import type { GraphEdge } from "../src/lib/edges.ts";
import {
  CARD_KEY, PREVIEW_COLORS, cardTemplateFor, cardTextFor, cardTooltip, computeGraph, directionFor, edgeKey, fallbackLabel, graphNodes, lineValue, positionsOf, routesOf, titleKey, viewEdges, viewNodes, wantedRelationships,
  type GraphNode, type PendingEdge,
} from "../src/lib/graph-view.ts";
import type { View } from "../src/lib/view.ts";

const candidate = (name: string, over: Partial<Candidate> = {}): Candidate => ({
  name, kind: "frontmatter", sources: ["inferred"], spans: [], defaults: { edge: true, layout: false, direction: "forward" }, ...over,
});
const before = candidate("before");
const after = candidate("after", { defaults: { edge: false, layout: false, direction: "backward" } });
const pair = candidate("before/after", { kind: "sequence", sources: ["pair"], defaults: { edge: true, layout: true, direction: "forward" }, pair: { forward: "before", backward: "after", by: "name" } });
const links = candidate("_out_links", { kind: "links", sources: ["builtin"], defaults: { edge: false, layout: false, direction: "forward" } });

const node = (path: string, row: Record<string, unknown> = {}): GraphNode => ({ id: path, path, label: fallbackLabel(path), row: { _path: path, ...row } });
const A = node("/timeline/alpha.md", { _title: "Alpha", phase: "plan", after: ["/timeline/kickoff.md"] });
const B = node("/timeline/beta.md", { _title: "Beta" });
const K = node("/timeline/kickoff.md", { _title: "Kickoff", before: ["/timeline/alpha.md"] });

const view = (over: Partial<View["layout"]> = {}, edges = ["before/after"]): View => ({
  edges, layout: { axis: "before/after", direction: "forward", algorithm: "layered", ...over }, projection: { label: "_title", shown: ["_title"] },
});

describe("graphNodes", () => {
  it("keys every hit by its rooted path, keeps the whole row and derives the fallback label", () => {
    const rows = [{ _id: "d_1", _path: "timeline/alpha.md", _title: "Alpha" }, { path: "/x/y.md" }, { _id: "d_3" }];
    expect(graphNodes(rows)).toEqual([
      { id: "d_1", path: "/timeline/alpha.md", label: "timeline/alpha", row: rows[0] },
      { id: "/x/y.md", path: "/x/y.md", label: "x/y", row: rows[1] },
      { id: "d_3", path: "d_3", label: "d_3", row: rows[2] },
    ]);
    expect(fallbackLabel("/notes/readme.md")).toBe("notes/readme");
  });
});

describe("cards", () => {
  it("cardTextFor: the label field's value (else the fallback) on top, one keyed line per shown field, the full values for the tooltip", () => {
    const t = cardTextFor(A, { label: "_title", shown: ["_title", "phase", "after", "missing"] });
    expect(t.label).toBe("Alpha");
    expect(t.lines).toEqual([{ key: "phase", text: "plan" }, { key: "after", text: "/timeline/kickoff.md" }, { key: "missing", text: "—" }]);
    expect(t.full).toEqual(["Alpha", "phase: plan", "after: /timeline/kickoff.md", "missing: "]);
    expect(cardTextFor(B, { label: "phase", shown: ["phase"] }).label).toBe("timeline/beta");
    expect(cardTextFor(B, { label: null, shown: [] })).toEqual({ label: "timeline/beta", lines: [], full: ["timeline/beta"] });
    // The label field never repeats as a line.
    expect(cardTextFor(A, { label: "phase", shown: ["phase", "_title"] }).lines).toEqual([{ key: "_title", text: "Alpha" }]);
  });

  it("a bare `card` alias the query projects or computes drives the title line with no settings: `{card|<label>}`", () => {
    expect(CARD_KEY).toBe("card");
    expect(cardTemplateFor({ label: "_title" })).toBe("{card|_title}");
    expect(cardTemplateFor({ label: null })).toBe("{card}");
    expect(cardTemplateFor({ label: "card" })).toBe("{card}");
    const computed = node("/t/a.md", { _title: "Alpha", status: "live", card: "Alpha · live" });
    const t = cardTextFor(computed, { label: "_title", shown: ["_title", "status", "card"] });
    expect(t.label).toBe("Alpha · live");
    // Neither the label field nor `card` repeats as a line; the other shown fields do.
    expect(t.lines).toEqual([{ key: "status", text: "live" }]);
    expect(t.full).toEqual(["Alpha · live", "status: live"]);
    expect(titleKey(computed.row, { label: "_title" })).toBe("card");
    expect(titleKey(A.row, { label: "_title" })).toBe("_title");
    expect(cardTooltip(computed.path, t, { label: "_title", shown: ["_title", "status", "card"] }, "card")).toBe("/t/a.md\ncard: Alpha · live\nstatus: live");
    // An empty `card` is absent: the label field (then the path) stands in.
    expect(cardTextFor(node("/t/b.md", { _title: "Beta", card: "" }), { label: "_title", shown: ["_title"] }).label).toBe("Beta");
    expect(cardTextFor(node("/t/c.md", { card: [] }), { label: null, shown: [] }).label).toBe("t/c");
    // When `card` is the chosen label it is shown once, as the title.
    expect(cardTextFor(computed, { label: "card", shown: ["card", "_title"] }).lines).toEqual([{ key: "_title", text: "Alpha" }]);
  });

  it("lineValue: absent is a dash, an empty list says so, everything else is the element's compact form", () => {
    expect(lineValue(undefined)).toBe("—");
    expect(lineValue(null)).toBe("—");
    expect(lineValue([])).toBe("[]");
    expect(lineValue(["a", "b"])).toBe("a, b");
    expect(lineValue([{ x: 1 }, { x: 2 }])).toBe("2 items");
    expect(lineValue(3)).toBe("3");
  });

  it("cardTooltip: the path, the label field when it differs from the path, then every shown value in full", () => {
    const choice = { label: "_title", shown: ["_title", "phase"] };
    expect(cardTooltip(A.path, cardTextFor(A, choice), choice)).toBe("/timeline/alpha.md\n_title: Alpha\nphase: plan");
    expect(cardTooltip(B.path, cardTextFor(B, { label: null, shown: [] }), { label: null, shown: [] })).toBe("/timeline/beta.md");
  });

  it("the element sizes a keyed card the way the old cards were sized: the key counts, the value is cut, the key stays whole", () => {
    const m = fixedMeasure(7);
    const t = cardTextFor(A, { label: "_title", shown: ["_title", "after"] });
    const s = sizeCard(t, "truncate", m);
    expect(s.width).toBe(cardWidth("Alpha".length, "after: /timeline/kickoff.md".length));
    expect(s.height).toBe(CARD.baseHeight + CARD.lineHeight);
    expect(s.detail).toEqual([{ key: "after", text: "/timeline/kickoff.md" }]);
    const long = cardTextFor(node("/x.md", { note: "n".repeat(100) }), { label: null, shown: ["note"] });
    const d = sizeCard(long, "truncate", m).detail[0]!;
    expect(typeof d === "object" && d.key).toBe("note");
    expect(typeof d === "object" && d.text.endsWith("…")).toBe(true);
  });
});

describe("viewNodes", () => {
  it("one view node per node, keyed by the path, with the row, the pin and the tooltip", () => {
    const pins = new Map([[A.path, { x: 10, y: 20 }]]);
    const out = viewNodes([A, B], { label: "_title", shown: ["_title"] }, pins);
    expect(out).toEqual([
      { id: A.path, row: A.row, pinned: { x: 10, y: 20 }, tooltip: "/timeline/alpha.md\n_title: Alpha" },
      { id: B.path, row: B.row, pinned: null, tooltip: "/timeline/beta.md\n_title: Beta" },
    ]);
  });
});

describe("viewEdges", () => {
  const stored: GraphEdge[] = [
    { src: K.path, dst: A.path, rel: "before" },
    { src: A.path, dst: K.path, rel: "after" },
  ];
  const base = { view: view({ axis: "before", direction: "forward" as const }), candidates: [before, after], colorFor: (rel: string) => `c(${rel})`, writable: ["after"], modifier: "⌘" };

  it("keeps the STORED edge as the key, draws it the relationship's way round, colours per relationship, marks writability", () => {
    const out = viewEdges(stored, base);
    expect(out.map((e) => e.key)).toEqual(["before /timeline/kickoff.md→/timeline/alpha.md", "after /timeline/alpha.md→/timeline/kickoff.md"]);
    // `before` forward: kickoff → alpha; `after` is backward by default: drawn kickoff → alpha too.
    expect(out.map((e) => [e.from, e.to])).toEqual([[K.path, A.path], [K.path, A.path]]);
    expect(out.map((e) => e.color)).toEqual(["c(before)", "c(after)"]);
    expect(out.map((e) => e.kind)).toEqual(["before", "after"]);
    expect(out.map((e) => e.writable)).toEqual([false, true]);
    expect(out[0]!.detail).toBe("/timeline/kickoff.md -[before]-> /timeline/alpha.md");
    expect(out[1]!.detail).toBe("/timeline/alpha.md -[after]-> /timeline/kickoff.md — ⌘-click to remove");
    expect(out.every((e) => e.pending === undefined)).toBe(true);
  });

  it("the axis takes the view's direction, every other relationship its own default", () => {
    expect(directionFor(view({ axis: "after", direction: "forward" }), [before, after], "after")).toBe("forward");
    expect(directionFor(view({ axis: "before", direction: "backward" }), [before, after], "after")).toBe("backward");
    expect(directionFor(view({ axis: "before" }), [before, after], "unknown")).toBe("forward");
    const flipped = viewEdges(stored, { ...base, view: view({ axis: "after", direction: "forward" }) });
    expect([flipped[1]!.from, flipped[1]!.to]).toEqual([A.path, K.path]);
  });

  it("pending: a remove dashes its drawn edge, an add appears as a dashed edge, a drawn add is not duplicated", () => {
    const pending: PendingEdge[] = [
      { src: A.path, dst: K.path, rel: "after", action: "remove" },
      { src: A.path, dst: B.path, rel: "after", action: "add" },
      { src: K.path, dst: A.path, rel: "before", action: "add" },
    ];
    const out = viewEdges(stored, { ...base, pending });
    expect(out).toHaveLength(3);
    expect(out[1]!.pending).toBe("remove");
    expect(out[1]!.detail).toBe("/timeline/alpha.md -[after]-> /timeline/kickoff.md");
    const added = out[2]!;
    expect(added.key).toBe(edgeKey(pending[1]!));
    expect(added.pending).toBe("add");
    expect([added.from, added.to]).toEqual([B.path, A.path]); // `after` drawn backward
    expect(added.color).toBe("c(after)");
  });

  it("the hover preview: an add is a new dashed accent edge, a remove recolours the drawn edge; never doubled with a pending edge", () => {
    const add = viewEdges(stored, { ...base, preview: { kind: "add", rel: "after", owner: B, target: A, via: "node" } });
    expect(add).toHaveLength(3);
    expect(add[2]).toMatchObject({ key: `preview ${edgeKey({ src: B.path, dst: A.path, rel: "after" })}`, from: A.path, to: B.path, pending: "add", color: PREVIEW_COLORS.add, label: "+ after" });
    expect(add[2]!.detail).toBe("⌘-click to add /timeline/beta.md -[after]-> /timeline/alpha.md");
    const remove = viewEdges(stored, { ...base, preview: { kind: "remove", rel: "after", owner: A, target: K, via: "edge" } });
    expect(remove).toHaveLength(2);
    expect(remove[1]).toMatchObject({ pending: "remove", color: PREVIEW_COLORS.remove });
    expect(remove[1]!.detail).toBe("⌘-click to remove /timeline/alpha.md -[after]-> /timeline/kickoff.md");
    const both = viewEdges(stored, { ...base, pending: [{ src: B.path, dst: A.path, rel: "after", action: "add" }], preview: { kind: "add", rel: "after", owner: B, target: A, via: "node" } });
    expect(both).toHaveLength(3);
    expect(both[2]!.key).toBe(edgeKey({ src: B.path, dst: A.path, rel: "after" }));
  });
});

describe("wantedRelationships", () => {
  it("the drawn ones and the axis, plus a pair's whole family when any member is wanted", () => {
    expect(wantedRelationships({ edges: ["_out_links"], layout: { axis: null, direction: "forward", algorithm: "force" } }, [links, before, after, pair])).toEqual(["_out_links"]);
    expect(wantedRelationships({ edges: ["before"], layout: { axis: null, direction: "forward", algorithm: "force" } }, [before, after, pair])).toEqual(["before", "before/after", "after"]);
    expect(wantedRelationships({ edges: [], layout: { axis: "after", direction: "forward", algorithm: "layered" } }, [before, after])).toEqual(["after"]);
  });
});

describe("positions and routes", () => {
  it("positionsOf turns elk's top-left corners into card centres; routesOf re-keys elk's routes by the STORED edge", () => {
    const laid = {
      nodes: new Map([["a", { x: 0, y: 0, width: 100, height: 30 }], ["b", { x: 200, y: 10, width: 60, height: 50 }]]),
      routes: new Map([["after|b|a", [{ x: 200, y: 35 }, { x: 100, y: 15 }]]]),
    };
    expect(positionsOf(laid)).toEqual(new Map([["a", { x: 50, y: 15 }], ["b", { x: 230, y: 35 }]]));
    // Stored a -[after]-> b, drawn backward (b → a): the route is found under the drawn id and keyed by the stored edge.
    const stored: GraphEdge = { src: "a", dst: "b", rel: "after" };
    const routes = routesOf(laid, [stored, { src: "a", dst: "b", rel: "other" }], (e) => (e.rel === "after" ? { ...e, src: e.dst, dst: e.src } : e));
    expect(routes).toEqual(new Map([["after a→b", [{ x: 200, y: 35 }, { x: 100, y: 15 }]]]));
  });
});

describe("computeGraph", () => {
  const elk = new ELK();
  const layout = (g: ElkNode) => elk.layout(g);
  const sizes = new Map([A, B, K].map((n) => [n.path, { width: 120, height: 30 }]));
  const fetched: Record<string, GraphEdge[]> = {
    before: [{ src: K.path, dst: A.path, rel: "before" }],
    after: [{ src: A.path, dst: K.path, rel: "after" }, { src: B.path, dst: A.path, rel: "after" }, { src: B.path, dst: "/elsewhere.md", rel: "after" }],
  };
  const fetch = async (c: Candidate) => fetched[c.name] ?? [];

  it("layered along a pair: the pair's edges deduped earlier → later, counts for the family, positions as centres, elk routes by edge key", async () => {
    const m = (await computeGraph({ nodes: [A, B, K], view: view(), candidates: [pair, before, after], fetch, sizes, elk: layout }))!;
    expect(m.layout).toBe("elk");
    expect(m.algorithm).toBe("layered");
    expect(m.edges.map((e) => [e.src, e.dst])).toEqual([[K.path, A.path], [A.path, B.path]]);
    expect(m.edgeCounts).toEqual({ "before/after": 2, before: 1, after: 2 });
    expect(m.axisEdges).toBe(2);
    expect(m.cycles).toEqual([]);
    expect(m.fellBack).toBeNull();
    expect([...m.positions!.keys()].sort()).toEqual([A.path, B.path, K.path].sort());
    // Left to right along the axis: kickoff, alpha, beta.
    const x = (p: string) => m.positions!.get(p)!.x;
    expect(x(K.path)).toBeLessThan(x(A.path));
    expect(x(A.path)).toBeLessThan(x(B.path));
    expect([...m.routes!.keys()].sort()).toEqual(m.edges.map(edgeKey).sort());
    for (const r of m.routes!.values()) expect(r.length).toBeGreaterThanOrEqual(2);
  });

  it("force: no positions (the element simulates), only the drawn relationships fetched; a loop on the axis is reported under layered", async () => {
    const f = (await computeGraph({ nodes: [A, B, K], view: view({ axis: null, algorithm: "force" }, ["after"]), candidates: [before, after], fetch, sizes, elk: layout }))!;
    expect(f.layout).toBe("force");
    expect(f.positions).toBeNull();
    expect(f.routes).toBeNull();
    expect(f.axisEdges).toBeNull();
    expect(f.edgeCounts).toEqual({ after: 2 });
    expect(f.edges.map((e) => e.rel)).toEqual(["after", "after"]);
    const loop = async (c: Candidate) => (c.name === "after" ? [{ src: A.path, dst: K.path, rel: "after" }, { src: K.path, dst: A.path, rel: "after" }] : []);
    const l = (await computeGraph({ nodes: [A, K], view: view({ axis: "after" }, ["after"]), candidates: [after], fetch: loop, sizes, elk: layout }))!;
    expect(l.cycles).toEqual([[A.path, K.path]]);
    expect(l.axisEdges).toBe(2);
  });

  it("a sequence candidate needs no fetch, a projected one reads the rows, a fetcher that is null draws nothing; a cancelled compute resolves to null", async () => {
    const seq = candidate("$ordinal", { kind: "sequence", sources: ["order by"] });
    const projected = candidate("after", { projected: true });
    let calls = 0;
    const counting = async (c: Candidate) => { calls++; return fetched[c.name] ?? []; };
    const m = (await computeGraph({ nodes: [K, A, B], view: view({ axis: null, algorithm: "force" }, ["$ordinal", "after"]), candidates: [seq, projected], fetch: counting, sizes, elk: layout }))!;
    expect(calls).toBe(0);
    expect(m.edgeCounts).toEqual({ $ordinal: 2, after: 1 });
    expect(m.edges.filter((e) => e.rel === "after")).toEqual([{ src: A.path, dst: K.path, rel: "after" }]);
    const none = (await computeGraph({ nodes: [A, K], view: view({ axis: null, algorithm: "force" }, ["before"]), candidates: [before], fetch: null, sizes, elk: layout }))!;
    expect(none.edges).toEqual([]);
    expect(await computeGraph({ nodes: [A, K], view: view(), candidates: [before], fetch, sizes, elk: layout, cancelled: () => true })).toBeNull();
  });

  it("an elk algorithm that throws falls back to force with a note; the radial centre never reaches the positions", async () => {
    const boom = () => Promise.reject(new Error("no"));
    const m = (await computeGraph({ nodes: [A, K], view: view({ axis: null, algorithm: "stress" }, ["before"]), candidates: [before], fetch, sizes, elk: boom }))!;
    expect(m.algorithm).toBe("force");
    expect(m.layout).toBe("force");
    expect(m.fellBack).toMatch(/^stress could not lay this graph out \(no\) — showing force$/);
    const r = (await computeGraph({ nodes: [A, B, K], view: view({ axis: null, algorithm: "radial" }, ["before"]), candidates: [before], fetch, sizes, elk: layout }))!;
    expect(r.layout).toBe("elk");
    expect([...r.positions!.keys()].sort()).toEqual([A.path, B.path, K.path].sort());
  });
});
