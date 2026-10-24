import { describe, expect, it } from "vitest";
import { linkRowsOf, type DocLinks } from "../src/lib/links.ts";
import {
  CARD_H, CARD_W, ZOOM_MAX, ZOOM_MIN, applyTitles, arrowEnd, collapseNode, edgeDetail, edgeKey, edgeLabel, edgeOf, edgesOf, emptyModel, externalTitle, fetchDocLinks, fetchTitles, fitTransform, graphDescription,
  EASE_MAX_DT, EASE_SNAP, EASE_TAU, EdgeEaser, PARALLEL_GAP, ROUTE_MARGIN, ROUTE_MIN_LEN, arrowheadPath, easeToward, pathFromOffset, connectorDrop, connectorLine, curveHitsRect, dragMode, edgePath, forceConfig, hitTest, initialView, keySide, parallelOffsets, routeViolations, segmentHitsRect, nearestInDirection, neighborsOf, panBy, provenanceText, removeNode, setPin, titleOf, titlesQuery, toGraph, truncateTitle, untitledPaths, wheelZoomFactor, withNeighborhood, zoomAbout, type Placed,
} from "../src/lib/graph.ts";

const A = "/processes/calcination.md";

/** Link rows as the server spells them (5.0 `_`-names), through lib/links.ts's normaliser. */
function links(outbound: Record<string, unknown>[], inbound: Record<string, unknown>[] = []): DocLinks {
  return { inbound: linkRowsOf(inbound), outbound: linkRowsOf(outbound), byName: [] };
}
const out = (n: number, dst: string, extra: Record<string, unknown> = {}) => ({ _id: `e_o${n}`, _path: A, _dst_path: dst, _dst_id: `d_${n}`, _dst_kind: "document", _provenance: "link", _block_id: `b_${n}`, _field: null, _uri: null, ...extra });
const inn = (n: number, src: string, extra: Record<string, unknown> = {}) => ({ _id: `e_i${n}`, _path: src, _provenance: "link", _block_id: `b_${n}`, _field: null, _anchor: null, ...extra });

describe("the model", () => {
  it("starts with the root alone, rooted, unexpanded and untitled", () => {
    const m = emptyModel("processes/calcination.md");
    expect(m.root).toBe(A);
    expect([...m.nodes.keys()]).toEqual([A]);
    expect(m.nodes.get(A)).toMatchObject({ kind: "document", title: "calcination", titled: false, pinned: null, expanded: false, degree: { in: null, out: null } });
    expect(m.edges.size).toBe(0);
  });

  it("projects a link row onto an edge: frontmatter, body, inline field, external; a dangling row is no edge", () => {
    const [fm, body, inline, ext, phantom] = linkRowsOf([
      out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }),
      out(2, "/y.md"),
      out(3, "/z.md", { _provenance: "inline_field", _field: "see" }),
      { _id: "e_4", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "frontmatter", _field: "homepage", _uri: "https://example.com/docs/" },
      { _id: "e_5", _path: A, _dst_path: null, _dst_id: "phantom:salt", _dst_kind: "document", _provenance: "link", _block_id: "b_9" },
    ]);
    expect(edgeOf(fm!)).toEqual({ key: `${A}→/x.md#depends_on|`, from: A, to: "/x.md", provenance: "frontmatter", field: "depends_on", blockId: null, uri: null });
    expect(edgeOf(body!)).toMatchObject({ key: `${A}→/y.md#|b_2`, provenance: "body", field: null, blockId: "b_2" });
    expect(edgeOf(inline!)).toMatchObject({ provenance: "body", field: "see", blockId: "b_3" });
    expect(edgeOf(ext!)).toMatchObject({ to: "https://example.com/docs/", provenance: "external", field: "homepage", uri: "https://example.com/docs/" });
    expect(edgeOf(phantom!)).toBeNull();
    expect(edgeKey("/a.md", "/b.md", null, null)).toBe("/a.md→/b.md#|");
  });

  it("expands a neighbourhood: both directions, external nodes, degrees, never mutating the input", () => {
    const m0 = emptyModel(A);
    const m1 = withNeighborhood(m0, A, links(
      [out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(2, "/y.md"), { _id: "e_3", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_3", _uri: "https://example.com/" }],
      [inn(4, "/index.md"), inn(5, "/index.md", { _block_id: "b_5b" })],
    ));
    expect(m0.nodes.size).toBe(1);
    expect(m0.edges.size).toBe(0);
    expect([...m1.nodes.keys()]).toEqual([A, "/x.md", "/y.md", "https://example.com/", "/index.md"]);
    expect(m1.nodes.get(A)).toMatchObject({ expanded: true, degree: { in: 2, out: 3 } });
    expect(m1.nodes.get("/x.md")).toMatchObject({ kind: "document", id: "d_1", expanded: false, title: "x", degree: { in: null, out: null } });
    expect(m1.nodes.get("https://example.com/")).toMatchObject({ kind: "external", id: "x_1", title: "example.com", titled: true, expanded: true });
    expect([...m1.edges.keys()]).toEqual([`${A}→/x.md#depends_on|`, `${A}→/y.md#|b_2`, `${A}→https://example.com/#|b_3`, `/index.md→${A}#|b_4`, `/index.md→${A}#|b_5b`]);
    expect(m1.truncated.size).toBe(0);
    expect(neighborsOf(m1, A)).toEqual(["/x.md", "/y.md", "https://example.com/", "/index.md"]);
    expect(edgesOf(m1, "/index.md")).toHaveLength(2);
  });

  it("bounds new neighbours per direction, counts the rest in `truncated`, and keeps edges to nodes already present for free", () => {
    const outs = [1, 2, 3, 4, 5].map((n) => out(n, `/o${n}.md`));
    const ins = [6, 7, 8].map((n) => inn(n, `/i${n}.md`));
    const m = withNeighborhood(emptyModel(A), A, links(outs, ins), { limit: 2 });
    expect([...m.nodes.keys()]).toEqual([A, "/o1.md", "/o2.md", "/i6.md", "/i7.md"]);
    expect(m.truncated.get(A)).toBe(4);
    expect(m.edges.size).toBe(4);
    // Expanding /o1.md: its link back to A costs nothing against the bound.
    const m2 = withNeighborhood(m, "/o1.md", links([{ ...out(9, A), _path: "/o1.md" }, { ...out(10, "/o1-a.md"), _path: "/o1.md" }, { ...out(11, "/o1-b.md"), _path: "/o1.md" }]), { limit: 1 });
    expect(m2.nodes.has("/o1-a.md")).toBe(true);
    expect(m2.nodes.has("/o1-b.md")).toBe(false);
    expect(m2.edges.has(`/o1.md→${A}#|b_9`)).toBe(true);
    expect(m2.truncated.get("/o1.md")).toBe(1);
    expect(m2.truncated.get(A)).toBe(4);
    // Re-expanding with a wider bound clears the entry.
    const m3 = withNeighborhood(m2, A, links(outs, ins), { limit: 10 });
    expect(m3.truncated.has(A)).toBe(false);
    expect(m3.nodes.size).toBe(1 + 5 + 3 + 1);
  });

  it("deduplicates edges by key and drops a self-loop (a document linking itself is no neighbour and no edge)", () => {
    const rows = [out(1, "/x.md"), out(1, "/x.md"), out(2, A)];
    const m = withNeighborhood(emptyModel(A), A, links([rows[0]!, rows[1]!, rows[2]!], [inn(3, A)]));
    expect([...m.edges.keys()]).toEqual([`${A}→/x.md#|b_1`]);
    expect([...m.nodes.keys()]).toEqual([A, "/x.md"]);
    expect(m.nodes.get(A)!.degree).toEqual({ in: 0, out: 1 });
  });

  it("an inbound row carries no _dst_path (the query selected by it): the expanded document is its destination", () => {
    const [row] = linkRowsOf([inn(1, "/index.md", { _provenance: "frontmatter", _field: "children", _block_id: null })]);
    expect(row!.dstPath).toBeNull();
    expect(edgeOf(row!)).toBeNull();
    expect(edgeOf(row!, "processes/calcination.md")).toEqual({ key: `/index.md→${A}#children|`, from: "/index.md", to: A, provenance: "frontmatter", field: "children", blockId: null, uri: null });
  });

  it("removes a node with its edges and truncation; pins are set and cleared on a copy", () => {
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md"), out(2, "/y.md")], [inn(3, "/x.md")]));
    const r = removeNode(m, "/x.md");
    expect(r.nodes.has("/x.md")).toBe(false);
    expect([...r.edges.keys()]).toEqual([`${A}→/y.md#|b_2`]);
    expect(m.nodes.has("/x.md")).toBe(true);
    const p = setPin(m, "/x.md", { x: 10, y: 20 });
    expect(p.nodes.get("/x.md")!.pinned).toEqual({ x: 10, y: 20 });
    expect(m.nodes.get("/x.md")!.pinned).toBeNull();
    expect(setPin(p, "/x.md", null).nodes.get("/x.md")!.pinned).toBeNull();
    expect(setPin(m, "/nope.md", { x: 1, y: 1 })).toBe(m);
  });

  describe("collapseNode over the chain root → a → b", () => {
    const R = "/root.md";
    const from = (src: string, n: number, dst: string) => ({ _id: `e_${src}${n}`, _path: src, _dst_path: dst, _dst_id: `d_${n}`, _dst_kind: "document", _provenance: "link", _block_id: `b_${src}${n}` });
    // root links a and c; a links root (back), b, c and x (x beyond a's bound of 1 new neighbour → truncated); b links a (back) and y.
    const expanded = () => {
      let m = withNeighborhood(emptyModel(R), R, links([from(R, 1, "/a.md"), from(R, 2, "/c.md")]));
      m = withNeighborhood(m, "/a.md", links([from("/a.md", 3, R), from("/a.md", 4, "/b.md"), from("/a.md", 5, "/c.md"), from("/a.md", 6, "/x.md")], [{ _id: "e_in", _path: R, _provenance: "link", _block_id: "b_in" }]), { limit: 1 });
      m = withNeighborhood(m, "/b.md", links([from("/b.md", 7, "/a.md"), from("/b.md", 8, "/y.md")]));
      return setPin(m, "/y.md", { x: 1, y: 2 });
    };
    it("collapsing a removes its exclusive neighbour b and b's subtree (y) and their edges; c stays — the root also links it", () => {
      const m = expanded();
      expect([...m.nodes.keys()].sort()).toEqual([R, "/a.md", "/b.md", "/c.md", "/y.md"].sort());
      expect(m.truncated.get("/a.md")).toBe(1);
      const c = collapseNode(m, "a.md");
      expect([...c.nodes.keys()].sort()).toEqual([R, "/a.md", "/c.md"].sort());
      expect(c.nodes.get("/a.md")).toMatchObject({ expanded: false, degree: { in: null, out: null } });
      expect(c.truncated.has("/a.md")).toBe(false);
      // Edges touching the still-expanded root stay (its expansion explains them, a→root included); a→c leaves with a's expansion though both ends remain.
      expect([...c.edges.keys()].sort()).toEqual([`${R}→/a.md#|b_${R}1`, `${R}→/a.md#|b_in`, `/a.md→${R}#|b_/a.md3`, `${R}→/c.md#|b_${R}2`].sort());
      expect(c.edges.has(`/a.md→/c.md#|b_/a.md5`)).toBe(false);
      expect(c.nodes.get("/a.md")!.pinned).toBeNull();
      // The input was not mutated.
      expect(m.nodes.size).toBe(5);
      expect(m.nodes.get("/a.md")!.expanded).toBe(true);
    });
    it("collapsing b alone keeps a's neighbourhood and drops only y", () => {
      const c = collapseNode(expanded(), "/b.md");
      expect([...c.nodes.keys()].sort()).toEqual([R, "/a.md", "/b.md", "/c.md"].sort());
      expect(c.edges.has(`/a.md→/b.md#|b_/a.md4`)).toBe(true);
      expect(c.edges.has(`/b.md→/y.md#|b_/b.md8`)).toBe(false);
    });
    it("collapsing the root leaves the root alone, unexpanded, with no edges", () => {
      const c = collapseNode(expanded(), R);
      expect([...c.nodes.keys()]).toEqual([R]);
      expect(c.nodes.get(R)!.expanded).toBe(false);
      expect(c.edges.size).toBe(0);
      expect(c.truncated.size).toBe(0);
      expect(collapseNode(c, "/gone.md")).toBe(c);
    });
  });

  it("labels and describes edges by provenance", () => {
    const fm = edgeOf(linkRowsOf([out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null })])[0]!)!;
    const body = edgeOf(linkRowsOf([out(2, "/y.md", { _block_id: "b_12" })])[0]!)!;
    const inline = edgeOf(linkRowsOf([out(3, "/z.md", { _provenance: "inline_field", _field: "see", _block_id: "b_3" })])[0]!)!;
    const ext = edgeOf(linkRowsOf([{ _id: "e_4", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_4", _uri: "https://example.com/" }])[0]!)!;
    const extFm = edgeOf(linkRowsOf([{ _id: "e_5", _path: A, _dst_path: null, _dst_id: "x_2", _dst_kind: "external", _provenance: "frontmatter", _field: "homepage", _uri: "https://example.com/" }])[0]!)!;
    expect(edgeLabel(fm)).toBe("depends_on");
    expect(edgeLabel(body)).toBe("body link");
    expect(edgeLabel(inline)).toBe("see (inline)");
    expect(edgeLabel(ext)).toBe("→ https://example.com/");
    expect(provenanceText(fm)).toBe(`authored in frontmatter field \`depends_on\` of ${A}`);
    expect(provenanceText(body)).toBe(`a link in block b_12 of ${A}`);
    expect(provenanceText(inline)).toBe(`an inline field \`see\` in block b_3 of ${A}`);
    expect(provenanceText(ext)).toBe(`an external link to https://example.com/ in block b_4 of ${A}`);
    expect(provenanceText(extFm)).toBe(`an external link to https://example.com/ authored in frontmatter field \`homepage\` of ${A}`);
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(2, "/w.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(3, "/y.md")]));
    expect(edgeDetail(m, fm)).toEqual({ direction: `${A} → /x.md`, provenance: "frontmatter", text: provenanceText(fm), cardinality: 2, addressable: true });
    expect(edgeDetail(m, body)).toMatchObject({ cardinality: null, addressable: true });
    expect(edgeDetail(m, ext)).toMatchObject({ cardinality: null, addressable: false });
    expect(externalTitle("https://example.com/a/b/?q=1")).toBe("example.com/a/b?q=1");
    expect(externalTitle("not a url")).toBe("not a url");
  });
});

describe("titles", () => {
  it("builds the batched query exactly: `==` for one path, a tuple `in (…)` for several, deduplicated and rooted", () => {
    expect(titlesQuery([])).toBeNull();
    expect(titlesQuery(["/a.md"])).toBe('docs { select _path, _title where _path == "/a.md" }');
    expect(titlesQuery(["/a.md", "b/c.md", "/a.md"])).toBe('docs { select _path, _title where _path in ("/a.md", "/b/c.md") }');
    expect(titlesQuery(['/q"uote.md', "/x.md"])).toBe('docs { select _path, _title where _path in ("/q\\"uote.md", "/x.md") }');
  });

  it("titleOf reads _title by _path, falling back to the stem", () => {
    const hits = [{ _id: "d_1", _path: "/a.md", _title: "Alpha" }, { _id: "d_2", _path: "/b.md", _title: null }];
    expect(titleOf("/a.md", hits)).toBe("Alpha");
    expect(titleOf("/b.md", hits)).toBe("b");
    expect(titleOf("/c.md", hits)).toBe("c");
  });

  it("applyTitles folds titles into the matching document nodes only and marks them titled", () => {
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md"), { _id: "e_3", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_3", _uri: "https://example.com/" }]));
    expect(untitledPaths(m)).toEqual([A, "/x.md"]);
    const t = applyTitles(m, [{ _id: "d_a", _path: A, _title: "Calcination" }, { _id: "d_1", _path: "/x.md", _title: "" }, { _id: "d_9", _path: "/elsewhere.md", _title: "Nope" }]);
    expect(t.nodes.get(A)).toMatchObject({ title: "Calcination", titled: true, id: "d_a" });
    expect(t.nodes.get("/x.md")).toMatchObject({ title: "x", titled: true });
    expect(t.nodes.has("/elsewhere.md")).toBe(false);
    expect(untitledPaths(t)).toEqual([]);
    expect(m.nodes.get(A)!.titled).toBe(false);
  });

  it("fetchDocLinks runs the two link queries and fetchTitles the one titles query through the client's queryAll", async () => {
    const calls: { query: string; repo: unknown }[] = [];
    const client = {
      async queryAll(query: string, opts: { repo?: string | null } = {}) {
        calls.push({ query, repo: opts.repo });
        if (query.includes("_dst_path ==")) return [{ _id: "e_1", _path: "/index.md", _block_id: "b_1", _provenance: "link" }];
        if (query.includes("_title")) return [{ _id: "d_a", _path: A, _title: "Calcination" }, { _id: "d_i", _path: "/index.md", _title: "Index" }];
        return [{ _id: "e_2", _path: A, _dst_path: "/x.md", _dst_id: "d_x", _dst_kind: "document", _provenance: "frontmatter", _field: "depends_on" }];
      },
    };
    const l = await fetchDocLinks(client, A, { repo: "alchemy" });
    expect(l.inbound.map((r) => r.path)).toEqual(["/index.md"]);
    expect(l.outbound.map((r) => r.dstPath)).toEqual(["/x.md"]);
    expect(l.byName).toEqual([]);
    const m = withNeighborhood(emptyModel(A), A, l);
    const t = await fetchTitles(client, m, { repo: "alchemy" });
    expect(calls.map((c) => c.query)).toEqual([
      `links { select _path, _block_id, _provenance, _field, _anchor where _dst_path == "${A}" }`,
      `links { select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor where _path == "${A}" }`,
      `docs { select _path, _title where _path in ("${A}", "/x.md", "/index.md") }`,
    ]);
    expect(calls.every((c) => c.repo === "alchemy")).toBe(true);
    expect(t.nodes.get(A)!.title).toBe("Calcination");
    expect(t.nodes.get("/index.md")!.title).toBe("Index");
    expect(t.nodes.get("/x.md")).toMatchObject({ title: "x", titled: false });
    // Nothing left untitled: no query is sent and the model comes back as is.
    const done = applyTitles(t, [{ _id: "d_x", _path: "/x.md", _title: "X" }]);
    expect(await fetchTitles(client, done)).toBe(done);
    expect(calls).toHaveLength(3);
    expect(graphDescription(t)).toBe(`graph around ${A}: 3 documents, 2 relationships`);
  });
});

describe("edge routing", () => {
  const A = { path: "/a", x: 0, y: 0 };
  const B = { path: "/b", x: 600, y: 0 };
  const dot = (p: { x: number; y: number }, q: { x: number; y: number }) => p.x * q.x + p.y * q.y;

  it("segment / rectangle (Liang–Barsky) and sampled-curve hits", () => {
    const r = { x: 300, y: 0, hw: 85, hh: 27 };
    expect(segmentHitsRect({ x: 0, y: 0 }, { x: 600, y: 0 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 100 }, { x: 600, y: 100 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 300, y: -200 }, { x: 300, y: 200 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 0 }, { x: 200, y: 0 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 290, y: 10 }, { x: 310, y: -10 }, r)).toBe(true);
    expect(curveHitsRect({ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }, r)).toBe(true);
    expect(curveHitsRect({ x: 0, y: 0 }, { x: 300, y: 200 }, { x: 600, y: 0 }, r)).toBe(false);
  });

  it("an unobstructed edge is a straight segment between the card borders, control null, bends 0", () => {
    const r = edgePath(A, B, [A, B, { path: "/far", x: 300, y: 400 }], { key: "k" });
    expect(r.control).toBeNull();
    expect(r.bends).toBe(0);
    expect(r.d).toBe(`M ${CARD_W / 2 + 2} 0 L ${600 - CARD_W / 2 - 2} 0`);
    expect(r.tangent).toEqual({ x: 1, y: 0 });
    expect(r.mid).toEqual({ x: 300, y: 0 });
  });

  it("a card on the segment pushes the control point to the far side and the sampled curve clears the inflated rect", () => {
    const above = { path: "/o", x: 300, y: -5 };
    const r = edgePath(A, B, [A, B, above], { key: "k" });
    expect(r.control).not.toBeNull();
    expect(r.control!.y).toBeGreaterThan(0);
    expect(r.bends).toBe(1);
    expect(r.d.startsWith("M ")).toBe(true);
    expect(r.d).toContain(" Q ");
    expect(routeViolations(r, A, B, [A, B, above])).toBe(0);
    // The curve clears the rect inflated by the margin, not just the card.
    expect(curveHitsRect(r.start, r.control!, r.end, { x: 300, y: -5, hw: CARD_W / 2 + ROUTE_MARGIN, hh: CARD_H / 2 + ROUTE_MARGIN })).toBe(false);
    const below = { path: "/o", x: 300, y: 5 };
    expect(edgePath(A, B, [A, B, below], { key: "k" }).control!.y).toBeLessThan(0);
    // The end tangent points into the target card; the start leaves the source.
    expect(dot(r.tangent, { x: B.x - r.end.x, y: B.y - r.end.y })).toBeGreaterThan(0);
    expect(Math.hypot(r.tangent.x, r.tangent.y)).toBeCloseTo(1);
    expect(r.end.x).toBeLessThan(B.x - CARD_W / 2 + 1);
  });

  it("obstacles on both sides: the offset with the fewest crossings wins, a bend is still reported, and nothing is NaN", () => {
    const S = { path: "/s", x: 0, y: 0 }, T = { path: "/t", x: 240, y: 0 };
    const wall = [-80, 0, 80].map((y, i) => ({ path: `/w${i}`, x: 120, y }));
    const r = edgePath(S, T, [S, T, ...wall], { key: "k" });
    expect(Number.isFinite(r.end.x) && Number.isFinite(r.end.y)).toBe(true);
    expect(r.d).not.toMatch(/NaN/);
    expect(routeViolations(r, S, T, wall)).toBeLessThanOrEqual(routeViolations(edgePath(S, T, [], { avoid: false }), S, T, wall));
    // A clearable two-sided case: one card above, one below, both crossing the line — greedy pushes oscillate, the sweep finds the bulge that clears both.
    const two = [{ path: "/p", x: 200, y: -20 }, { path: "/q", x: 400, y: 20 }];
    const r2 = edgePath(A, B, [A, B, ...two], { key: "k" });
    expect(r2.bends).toBeGreaterThanOrEqual(1);
    expect(r2.control).not.toBeNull();
    expect(routeViolations(r2, A, B, two)).toBe(0);
    expect(routeViolations(edgePath(A, B, [], { avoid: false }), A, B, two)).toBe(2);
  });

  it("short edges stay straight even through a card; `avoid: false` is the straight style", () => {
    const near = { path: "/n", x: 100, y: 0 };
    const r = edgePath(A, near, [A, near, { path: "/o", x: 50, y: -3 }], { key: "k" });
    expect(ROUTE_MIN_LEN).toBe(225);
    expect(r.control).toBeNull();
    const s = edgePath(A, B, [A, B, { path: "/o", x: 300, y: -5 }], { key: "k", avoid: false });
    expect(s.control).toBeNull();
  });

  it("is deterministic, and an obstacle exactly on the line takes its side from the edge key", () => {
    const on = { path: "/o", x: 300, y: 0 };
    const r1 = edgePath(A, B, [A, B, on], { key: "a" });
    const r2 = edgePath(A, B, [A, B, on], { key: "a" });
    expect(r1.d).toBe(r2.d);
    expect(keySide("a")).toBe(1);
    expect(keySide("b")).toBe(-1);
    const other = edgePath(A, B, [A, B, on], { key: "b" });
    expect(Math.sign(r1.control!.y)).toBe(-Math.sign(other.control!.y));
  });

  it("parallel edges of one pair fan apart with centred offsets, A→B and B→A included; a self-loop gets none", () => {
    const edges = [{ key: "e2", from: "/a", to: "/b" }, { key: "e1", from: "/a", to: "/b" }, { key: "e3", from: "/b", to: "/a" }, { key: "self", from: "/a", to: "/a" }, { key: "x", from: "/a", to: "/c" }];
    const o = parallelOffsets(edges);
    expect(o.get("e1")).toBe(-PARALLEL_GAP);
    expect(o.get("e2")).toBe(0);
    expect(o.get("e3")).toBe(-PARALLEL_GAP);
    expect(o.get("x")).toBe(0);
    expect(o.has("self")).toBe(false);
    expect(parallelOffsets([{ key: "p", from: "/a", to: "/b" }, { key: "q", from: "/a", to: "/b" }]).get("p")).toBe(-18);
    // In world space the two frames' offsets land on opposite sides: distinct control points.
    const ab = edgePath(A, B, [], { key: "e1", offset: o.get("e1")! });
    const ba = edgePath(B, A, [], { key: "e3", offset: o.get("e3")! });
    expect(ab.control!.y).toBeCloseTo(-PARALLEL_GAP);
    expect(ba.control!.y).toBeCloseTo(PARALLEL_GAP);
    expect(ab.bends).toBe(0);
  });

  it("reports its offset, and `controlOffset` / `pathFromOffset` draw exactly that offset with no obstacle pass", () => {
    const above = { path: "/o", x: 300, y: -5 };
    const routed = edgePath(A, B, [A, B, above], { key: "k" });
    expect(routed.offset).toBeGreaterThan(0);
    expect(routed.control!.y).toBeCloseTo(routed.offset);
    expect(edgePath(A, B, [], { avoid: false }).offset).toBe(0);
    expect(edgePath(A, B, [], { offset: -18 }).offset).toBe(-18);
    const forced = edgePath(A, B, [A, B, above], { key: "k", offset: 99, controlOffset: -40 });
    expect(forced.offset).toBe(-40);
    expect(forced.control!.y).toBeCloseTo(-40);
    expect(forced.bends).toBe(0);
    expect(pathFromOffset(A, B, -40)).toEqual(forced);
    expect(pathFromOffset(A, B, routed.offset).d).toBe(routed.d);
    expect(pathFromOffset(A, B, 0).control).toBeNull();
  });

  it("eases a control offset toward its target with the frame dt, snapping within half a pixel", () => {
    expect(easeToward(0, 100, 0)).toBe(0);
    // dt is clamped to EASE_MAX_DT (a hitch does not teleport the curve), so one step covers 1 − e^(−50/τ).
    expect(easeToward(0, 100, EASE_TAU)).toBeCloseTo(100 * (1 - Math.exp(-EASE_MAX_DT / EASE_TAU)));
    expect(easeToward(0, 100, 30, 30, 0)).toBeCloseTo(100 * (1 - Math.exp(-1)));
    expect(easeToward(0, 100, 16)).toBeLessThan(easeToward(0, 100, 32));
    expect(easeToward(0, 100, 1000)).toBe(easeToward(0, 100, EASE_MAX_DT));
    expect(easeToward(99.8, 100, 16)).toBe(100);
    expect(easeToward(100, 100 - EASE_SNAP / 2, 1)).toBe(100 - EASE_SNAP / 2);
    expect(easeToward(-30, 30, 16)).toBeGreaterThan(-30);
    expect(easeToward(-30, 30, 16)).toBeLessThan(0);
  });

  it("EdgeEaser: a new key starts at its target, glides toward a changed one through zero when the side flips, drops stale keys, reports settled, snaps", () => {
    const e = new EdgeEaser();
    const t1 = new Map([["a", 40], ["b", 0]]);
    expect(e.step(t1, 16)).toEqual(new Map([["a", 40], ["b", 0]]));
    expect(e.settled(t1)).toBe(true);
    const t2 = new Map([["a", -40]]);
    const trace: number[] = [];
    for (let i = 0; i < 60; i++) trace.push(e.step(t2, 16).get("a")!);
    expect(trace[0]).toBeLessThan(40);
    expect(trace[0]).toBeGreaterThan(-40);
    expect(trace.some((v) => Math.abs(v) < 10)).toBe(true);
    expect(trace.every((v, i) => i === 0 || v <= trace[i - 1]!)).toBe(true);
    expect(trace[trace.length - 1]).toBe(-40);
    expect(e.settled(t2)).toBe(true);
    expect(e.size).toBe(1);
    expect(e.step(t2, 16).has("b")).toBe(false);
    const t3 = new Map([["a", 0], ["c", 12]]);
    const after = e.step(t3, 16);
    expect(after.get("c")).toBe(12);
    expect(after.get("a")).toBeLessThan(0);
    expect(e.settled(t3)).toBe(false);
    expect(e.snap(t3)).toEqual(new Map([["a", 0], ["c", 12]]));
    expect(e.settled(t3)).toBe(true);
  });

  it("draws the arrowhead along the end tangent", () => {
    expect(arrowheadPath({ x: 100, y: 0 }, { x: 1, y: 0 })).toBe("M 100 0 L 91 4 L 91 -4 Z");
    expect(arrowheadPath({ x: 0, y: 50 }, { x: 0, y: 1 }, 10, 5)).toBe("M 0 50 L -5 40 L 5 40 Z");
  });
});

describe("geometry", () => {
  const placed: Placed[] = [
    { path: "/c.md", x: 0, y: 0 },
    { path: "/r.md", x: 300, y: 10 },
    { path: "/u.md", x: 20, y: -200 },
    { path: "/d.md", x: -5, y: 150 },
    { path: "/far.md", x: 900, y: 40 },
  ];
  it("truncates titles with an ellipsis", () => {
    expect(truncateTitle("short")).toBe("short");
    expect(truncateTitle("exactly twenty-four chars")).toBe("exactly twenty-four cha…");
    expect(truncateTitle("abcdefghij", 4)).toBe("abc…");
  });
  it("hit-tests the topmost card by its rectangle", () => {
    expect(hitTest(placed, 0, 0)).toBe("/c.md");
    expect(hitTest(placed, CARD_W / 2, CARD_H / 2)).toBe("/c.md");
    expect(hitTest(placed, CARD_W / 2 + 1, 0)).toBeNull();
    expect(hitTest(placed, 310, 15)).toBe("/r.md");
    expect(hitTest([{ path: "/a", x: 0, y: 0 }, { path: "/b", x: 10, y: 0 }], 5, 0)).toBe("/b");
  });
  it("steps to the nearest card in a direction", () => {
    expect(nearestInDirection(placed, "/c.md", "right")).toBe("/r.md");
    expect(nearestInDirection(placed, "/c.md", "up")).toBe("/u.md");
    expect(nearestInDirection(placed, "/c.md", "down")).toBe("/d.md");
    expect(nearestInDirection(placed, "/c.md", "left")).toBeNull();
    expect(nearestInDirection(placed, "/r.md", "right")).toBe("/far.md");
    expect(nearestInDirection(placed, "/r.md", "left")).toBe("/c.md");
    expect(nearestInDirection(placed, "/missing.md", "left")).toBe("/c.md");
    expect(nearestInDirection([], "/x", "up")).toBeNull();
  });
  it("fits every card into the viewport (scale capped at 1) and maps screen points back", () => {
    const one = fitTransform([{ path: "/a", x: 100, y: 100 }], 400, 300, 24);
    expect(one.k).toBe(1);
    expect(one.tx + 100).toBeCloseTo(200);
    expect(one.ty + 100).toBeCloseTo(150);
    const wide = fitTransform([{ path: "/a", x: 0, y: 0 }, { path: "/b", x: 1000, y: 0 }], 400, 300, 0);
    expect(wide.k).toBeCloseTo(400 / (1000 + CARD_W));
    expect(wide.tx).toBeCloseTo(wide.k * CARD_W / 2);
    expect(fitTransform([], 400, 300)).toEqual({ k: 1, tx: 0, ty: 0 });
    const v = { k: 2, tx: 10, ty: 20 };
    expect(toGraph(v, 10 + 2 * 7, 20 + 2 * 9)).toEqual({ x: 7, y: 9 });
  });
  it("zooms about a screen point (the graph point under it stays put), clamped, and pans by a screen offset", () => {
    const v = { k: 1, tx: 0, ty: 0 };
    const z = zoomAbout(v, 2, 100, 50);
    expect(z).toEqual({ k: 2, tx: -100, ty: -50 });
    expect(toGraph(z, 100, 50)).toEqual(toGraph(v, 100, 50));
    const back = zoomAbout(z, 0.5, 100, 50);
    expect(back.k).toBe(1);
    expect(back.tx).toBeCloseTo(0);
    expect(back.ty).toBeCloseTo(0);
    expect(zoomAbout(v, 100, 0, 0).k).toBe(ZOOM_MAX);
    expect(zoomAbout(v, 0.0001, 0, 0).k).toBe(ZOOM_MIN);
    // At the clamp already: the same view object comes back (no re-render).
    const atMax = { k: ZOOM_MAX, tx: 3, ty: 4 };
    expect(zoomAbout(atMax, 2, 10, 10)).toBe(atMax);
    expect(zoomAbout(v, 2, 0, 0, 0.5, 1.5)).toEqual({ k: 1.5, tx: 0, ty: 0 });
    expect(panBy({ k: 2, tx: 10, ty: 20 }, -5, 7)).toEqual({ k: 2, tx: 5, ty: 27 });
    // Wheel: a downward scroll zooms out, upward in; a pinch (ctrlKey) is steeper; line deltas are scaled.
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100, 0, false)).toBeCloseTo(Math.exp(0.2));
    expect(wheelZoomFactor(-10, 0, true)).toBeCloseTo(Math.exp(0.1));
    expect(wheelZoomFactor(-3, 1, false)).toBeCloseTo(wheelZoomFactor(-48, 0, false));
    expect(wheelZoomFactor(0, 0, false)).toBe(1);
  });
  it("decides what a press starts and where a connector lands", () => {
    expect(dragMode({ handle: true, modifier: false, canWrite: true, armed: null }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: true, canWrite: true, armed: null }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: false, canWrite: true, armed: "/a" }, "/a")).toBe("connector");
    expect(dragMode({ handle: false, modifier: false, canWrite: true, armed: "/b" }, "/a")).toBe("move");
    expect(dragMode({ handle: false, modifier: false, canWrite: true, armed: null }, "/a")).toBe("move");
    expect(dragMode({ handle: true, modifier: true, canWrite: false, armed: "/a" }, "/a")).toBe("move");
    const isDoc = (p: string) => p !== "/far.md";
    expect(connectorDrop(placed, "/c.md", 305, 12, isDoc)).toEqual({ kind: "connect", from: "/c.md", to: "/r.md" });
    // Dropping back on the source, on an external node, or on open canvas is "empty".
    expect(connectorDrop(placed, "/c.md", 0, 0, isDoc)).toEqual({ kind: "empty", from: "/c.md", x: 0, y: 0 });
    expect(connectorDrop(placed, "/c.md", 900, 40, isDoc)).toEqual({ kind: "empty", from: "/c.md", x: 900, y: 40 });
    expect(connectorDrop(placed, "/c.md", 500, 500, isDoc)).toEqual({ kind: "empty", from: "/c.md", x: 500, y: 500 });
  });
  it("draws the ghost connector from the card's border to the pointer, with the hint beside the pointer", () => {
    const g = connectorLine({ path: "/a", x: 0, y: 0 }, { x: 300, y: 0 });
    expect(g).toEqual({ x1: CARD_W / 2, y1: 0, x2: 300, y2: 0, hint: { x: 314, y: 18 } });
    const up = connectorLine({ path: "/a", x: 100, y: 100 }, { x: 100, y: -100 });
    expect(up).toMatchObject({ x1: 100, y1: 100 - CARD_H / 2, x2: 100, y2: -100 });
    // The pointer still over the source: a zero-length line (nothing to see yet).
    expect(connectorLine({ path: "/a", x: 0, y: 0 }, { x: 10, y: 5 })).toMatchObject({ x1: 10, y1: 5, x2: 10, y2: 5 });
  });
  it("the force layout's numbers: weak per-node gravity at the origin (no forceCenter), a non-vanishing link strength, short-range repulsion, a collide radius covering the card; the home view centres the origin", () => {
    const c = forceConfig();
    expect(c.gravity).toEqual({ x: 0, y: 0, strength: 0.04 });
    expect(initialView(1200, 600)).toEqual({ k: 1, tx: 600, ty: 300 });
    expect(toGraph(initialView(1200, 600), 600, 300)).toEqual({ x: 0, y: 0 });
    expect(c.gravity.strength).toBeLessThanOrEqual(0.05);
    expect(c.link.strength).toBeGreaterThanOrEqual(0.6);
    expect(c.link.distance).toBeGreaterThanOrEqual(90);
    expect(c.link.distance).toBeLessThanOrEqual(110);
    expect(c.charge.distanceMax).toBeLessThanOrEqual(400);
    expect(c.charge.strength).toBeGreaterThanOrEqual(-260);
    expect(c.charge.strength).toBeLessThanOrEqual(-180);
    expect(c.collide.radius).toBeGreaterThanOrEqual(Math.hypot(CARD_W, CARD_H) / 2);
    expect(c.reheatAlpha).toBeGreaterThanOrEqual(0.3);
    expect(c.reheatAlpha).toBeLessThanOrEqual(0.5);
  });
  it("ends an arrow at the target card's border", () => {
    const horizontal = arrowEnd({ x: 0, y: 0 }, { x: 300, y: 0 }, CARD_W, CARD_H, 0);
    expect(horizontal).toEqual({ x: 300 - CARD_W / 2, y: 0 });
    const vertical = arrowEnd({ x: 0, y: 0 }, { x: 0, y: -200 }, CARD_W, CARD_H, 0);
    expect(vertical).toEqual({ x: 0, y: -200 + CARD_H / 2 });
    const diagonal = arrowEnd({ x: 0, y: 0 }, { x: 100, y: 100 }, 100, 50, 0);
    expect(diagonal).toEqual({ x: 75, y: 75 });
    expect(arrowEnd({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});
