import { describe, expect, it } from "vitest";
import { linkRowsOf, type DocLinks } from "../src/lib/links.ts";
import {
  CARD_H, CARD_W, applyTitles, arrowEnd, edgeDetail, edgeKey, edgeLabel, edgeOf, edgesOf, emptyModel, externalTitle, fetchDocLinks, fetchTitles, fitTransform, graphDescription,
  hitTest, nearestInDirection, neighborsOf, provenanceText, removeNode, setPin, titleOf, titlesQuery, toGraph, truncateTitle, untitledPaths, withNeighborhood, type Placed,
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
