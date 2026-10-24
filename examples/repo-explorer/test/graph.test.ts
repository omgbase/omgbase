import { describe, expect, it } from "vitest";
import { linkRowsOf, type DocLinks } from "../src/lib/links.ts";
import {
  applyRows, collapseNode, edgeDetail, edgeKey, edgeLabel, edgeOf, edgesOf, emptyModel, externalTitle, fetchDocLinks, fetchFields, fieldsQuery, listFieldsOf, neighborsOf, projectedFields, provenanceText, removeNode, setPin, titleOf, toView,
  unfetched, withNeighborhood,
} from "../src/lib/graph.ts";

const A = "/processes/calcination.md";

/** Link rows as the server spells them (5.0 `_`-names), through lib/links.ts's normaliser. */
function links(outbound: Record<string, unknown>[], inbound: Record<string, unknown>[] = []): DocLinks {
  return { inbound: linkRowsOf(inbound), outbound: linkRowsOf(outbound), byName: [] };
}
const out = (n: number, dst: string, extra: Record<string, unknown> = {}) => ({ _id: `e_o${n}`, _path: A, _dst_path: dst, _dst_id: `d_${n}`, _dst_kind: "document", _provenance: "link", _block_id: `b_${n}`, _field: null, _uri: null, ...extra });
const inn = (n: number, src: string, extra: Record<string, unknown> = {}) => ({ _id: `e_i${n}`, _path: src, _provenance: "link", _block_id: `b_${n}`, _field: null, _anchor: null, ...extra });

describe("the model", () => {
  it("starts with the root alone, rooted, unexpanded, its row the path only", () => {
    const m = emptyModel("processes/calcination.md");
    expect(m.root).toBe(A);
    expect([...m.nodes.keys()]).toEqual([A]);
    expect(m.nodes.get(A)).toMatchObject({ kind: "document", row: { _path: A }, fetched: [], pinned: null, expanded: false, degree: { in: null, out: null } });
    expect(titleOf(m.nodes.get(A)!)).toBe("calcination");
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
    expect([...m1.nodes.keys()]).toEqual([A, "/x.md", "/y.md", "https://example.com/", "/index.md"]);
    expect(m1.nodes.get(A)).toMatchObject({ expanded: true, degree: { in: 2, out: 3 } });
    expect(m1.nodes.get("/x.md")).toMatchObject({ kind: "document", id: "d_1", expanded: false, row: { _path: "/x.md" } });
    expect(m1.nodes.get("https://example.com/")).toMatchObject({ kind: "external", id: "x_1", row: { _url: "https://example.com/", _title: "example.com" }, expanded: true });
    expect(titleOf(m1.nodes.get("https://example.com/")!)).toBe("example.com");
    expect([...m1.edges.keys()]).toEqual([`${A}→/x.md#depends_on|`, `${A}→/y.md#|b_2`, `${A}→https://example.com/#|b_3`, `/index.md→${A}#|b_4`, `/index.md→${A}#|b_5b`]);
    expect(neighborsOf(m1, A)).toEqual(["/x.md", "/y.md", "https://example.com/", "/index.md"]);
    expect(edgesOf(m1, "/index.md")).toHaveLength(2);
  });

  it("bounds new neighbours per direction, counts the rest in `truncated`, and keeps edges to nodes already present for free", () => {
    const outs = [1, 2, 3, 4, 5].map((n) => out(n, `/o${n}.md`));
    const ins = [6, 7, 8].map((n) => inn(n, `/i${n}.md`));
    const m = withNeighborhood(emptyModel(A), A, links(outs, ins), { limit: 2 });
    expect([...m.nodes.keys()]).toEqual([A, "/o1.md", "/o2.md", "/i6.md", "/i7.md"]);
    expect(m.truncated.get(A)).toBe(4);
    const m2 = withNeighborhood(m, "/o1.md", links([{ ...out(9, A), _path: "/o1.md" }, { ...out(10, "/o1-a.md"), _path: "/o1.md" }, { ...out(11, "/o1-b.md"), _path: "/o1.md" }]), { limit: 1 });
    expect(m2.nodes.has("/o1-a.md")).toBe(true);
    expect(m2.nodes.has("/o1-b.md")).toBe(false);
    expect(m2.edges.has(`/o1.md→${A}#|b_9`)).toBe(true);
    expect(m2.truncated.get("/o1.md")).toBe(1);
    const m3 = withNeighborhood(m2, A, links(outs, ins), { limit: 10 });
    expect(m3.truncated.has(A)).toBe(false);
  });

  it("deduplicates edges by key and drops a self-loop", () => {
    const rows = [out(1, "/x.md"), out(1, "/x.md"), out(2, A)];
    const m = withNeighborhood(emptyModel(A), A, links(rows, [inn(3, A)]));
    expect([...m.edges.keys()]).toEqual([`${A}→/x.md#|b_1`]);
    expect([...m.nodes.keys()]).toEqual([A, "/x.md"]);
    expect(m.nodes.get(A)!.degree).toEqual({ in: 0, out: 1 });
  });

  it("an inbound row carries no _dst_path: the expanded document is its destination", () => {
    const [row] = linkRowsOf([inn(1, "/index.md", { _provenance: "frontmatter", _field: "children", _block_id: null })]);
    expect(edgeOf(row!)).toBeNull();
    expect(edgeOf(row!, "processes/calcination.md")).toEqual({ key: `/index.md→${A}#children|`, from: "/index.md", to: A, provenance: "frontmatter", field: "children", blockId: null, uri: null });
  });

  it("removes a node with its edges; pins are set and cleared on a copy", () => {
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md"), out(2, "/y.md")], [inn(3, "/x.md")]));
    const r = removeNode(m, "/x.md");
    expect(r.nodes.has("/x.md")).toBe(false);
    expect([...r.edges.keys()]).toEqual([`${A}→/y.md#|b_2`]);
    const p = setPin(m, "/x.md", { x: 10, y: 20 });
    expect(p.nodes.get("/x.md")!.pinned).toEqual({ x: 10, y: 20 });
    expect(m.nodes.get("/x.md")!.pinned).toBeNull();
    expect(setPin(p, "/x.md", null).nodes.get("/x.md")!.pinned).toBeNull();
    expect(setPin(m, "/nope.md", { x: 1, y: 1 })).toBe(m);
  });

  describe("collapseNode over the chain root → a → b", () => {
    const R = "/root.md";
    const from = (src: string, n: number, dst: string) => ({ _id: `e_${src}${n}`, _path: src, _dst_path: dst, _dst_id: `d_${n}`, _dst_kind: "document", _provenance: "link", _block_id: `b_${src}${n}` });
    const expanded = () => {
      let m = withNeighborhood(emptyModel(R), R, links([from(R, 1, "/a.md"), from(R, 2, "/c.md")]));
      m = withNeighborhood(m, "/a.md", links([from("/a.md", 3, R), from("/a.md", 4, "/b.md"), from("/a.md", 5, "/c.md"), from("/a.md", 6, "/x.md")], [{ _id: "e_in", _path: R, _provenance: "link", _block_id: "b_in" }]), { limit: 1 });
      m = withNeighborhood(m, "/b.md", links([from("/b.md", 7, "/a.md"), from("/b.md", 8, "/y.md")]));
      return setPin(m, "/y.md", { x: 1, y: 2 });
    };
    it("collapsing a removes its exclusive neighbour b and b's subtree; c stays — the root also links it", () => {
      const m = expanded();
      const c = collapseNode(m, "a.md");
      expect([...c.nodes.keys()].sort()).toEqual([R, "/a.md", "/c.md"].sort());
      expect(c.nodes.get("/a.md")).toMatchObject({ expanded: false, degree: { in: null, out: null } });
      expect(c.truncated.has("/a.md")).toBe(false);
      expect([...c.edges.keys()].sort()).toEqual([`${R}→/a.md#|b_${R}1`, `${R}→/a.md#|b_in`, `/a.md→${R}#|b_/a.md3`, `${R}→/c.md#|b_${R}2`].sort());
      expect(m.nodes.size).toBe(5);
    });
    it("collapsing b alone drops only y; collapsing the root leaves the root alone", () => {
      const c = collapseNode(expanded(), "/b.md");
      expect([...c.nodes.keys()].sort()).toEqual([R, "/a.md", "/b.md", "/c.md"].sort());
      const r = collapseNode(expanded(), R);
      expect([...r.nodes.keys()]).toEqual([R]);
      expect(r.edges.size).toBe(0);
      expect(collapseNode(r, "/gone.md")).toBe(r);
    });
  });

  it("labels and describes edges by provenance", () => {
    const fm = edgeOf(linkRowsOf([out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null })])[0]!)!;
    const body = edgeOf(linkRowsOf([out(2, "/y.md", { _block_id: "b_12" })])[0]!)!;
    const inline = edgeOf(linkRowsOf([out(3, "/z.md", { _provenance: "inline_field", _field: "see", _block_id: "b_3" })])[0]!)!;
    const ext = edgeOf(linkRowsOf([{ _id: "e_4", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_4", _uri: "https://example.com/" }])[0]!)!;
    expect(edgeLabel(fm)).toBe("depends_on");
    expect(edgeLabel(body)).toBe("body link");
    expect(edgeLabel(inline)).toBe("see (inline)");
    expect(edgeLabel(ext)).toBe("→ https://example.com/");
    expect(provenanceText(fm)).toBe(`authored in frontmatter field \`depends_on\` of ${A}`);
    expect(provenanceText(body)).toBe(`a link in block b_12 of ${A}`);
    expect(provenanceText(inline)).toBe(`an inline field \`see\` in block b_3 of ${A}`);
    expect(provenanceText(ext)).toBe(`an external link to https://example.com/ in block b_4 of ${A}`);
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(2, "/w.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(3, "/y.md")]));
    expect(edgeDetail(m, fm)).toEqual({ direction: `${A} → /x.md`, provenance: "frontmatter", text: provenanceText(fm), cardinality: 2, addressable: true });
    expect(edgeDetail(m, ext)).toMatchObject({ cardinality: null, addressable: false });
    expect(externalTitle("https://example.com/a/b/?q=1")).toBe("example.com/a/b?q=1");
  });
});

describe("rows", () => {
  it("projects _title always and the card's fields after — nothing of a repository's vocabulary (no `type`) — dotted paths by their head, never _path twice", () => {
    expect(projectedFields([])).toEqual(["_title"]);
    // `_display` is not an engine name the surface knows (yet): projecting it would be `filter_invalid`, so it is skipped.
    expect(projectedFields(["_display", "_title", "status", "_path", "owner.name", "status", " "])).toEqual(["_title", "status", "owner"]);
    expect(projectedFields(["_tags", "_bogus", "_data.x"])).toEqual(["_title", "_tags", "_data"]);
    expect(projectedFields(["type"])).toEqual(["_title", "type"]);
  });

  it("builds the batched row query exactly: `==` for one path, a tuple `in (…)` for several, deduplicated and rooted", () => {
    expect(fieldsQuery([])).toBeNull();
    expect(fieldsQuery(["/a.md"])).toBe('docs { select _path, _title where _path == "/a.md" }');
    expect(fieldsQuery(["/a.md", "b/c.md", "/a.md"], ["_display", "_title", "status"])).toBe('docs { select _path, _title, status where _path in ("/a.md", "/b/c.md") }');
    // The card convention: a bare `card` is read as authored; a computed alias replaces it in place; a computed name no template reads is appended.
    expect(fieldsQuery(["/a.md"], ["card", "_title"])).toBe('docs { select _path, _title, card where _path == "/a.md" }');
    expect(fieldsQuery(["/a.md"], ["card", "status"], { card: ' _title + " · " + status ' })).toBe('docs { select _path, _title, card: _title + " · " + status, status where _path == "/a.md" }');
    expect(fieldsQuery(["/a.md"], [], { card: "status" })).toBe('docs { select _path, _title, card: status where _path == "/a.md" }');
    expect(fieldsQuery(['/q"uote.md', "/x.md"], ["status", "type"])).toBe('docs { select _path, _title, status, type where _path in ("/q\\"uote.md", "/x.md") }');
  });

  it("applyRows merges each hit into its node's row, records the fetched fields; unfetched names the nodes still missing some", () => {
    const m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md"), { _id: "e_3", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_3", _uri: "https://example.com/" }]));
    expect(unfetched(m)).toEqual([A, "/x.md"]);
    const t = applyRows(m, [{ _id: "d_a", _path: A, _title: "Calcination" }, { _id: "d_1", _path: "/x.md", _title: null }, { _id: "d_9", _path: "/elsewhere.md", _title: "Nope" }]);
    expect(t.nodes.get(A)).toMatchObject({ id: "d_a", row: { _path: A, _title: "Calcination" }, fetched: ["_title"] });
    expect(titleOf(t.nodes.get(A)!)).toBe("Calcination");
    expect(titleOf(t.nodes.get("/x.md")!)).toBe("x");
    expect(t.nodes.has("/elsewhere.md")).toBe(false);
    expect(unfetched(t)).toEqual([]);
    // A wider card asks for more: only the new field is missing, and it merges over the old row.
    expect(unfetched(t, ["_display", "status"])).toEqual([A, "/x.md"]);
    const u = applyRows(t, [{ _id: "d_a", _path: A, _title: "Calcination", _display: "Calc", status: "done" }], ["_display", "status"]);
    expect(u.nodes.get(A)!.row).toEqual({ _path: A, _title: "Calcination", _display: "Calc", status: "done" });
    expect(u.nodes.get(A)!.fetched).toEqual(["_title", "status"]);
    expect(unfetched(u, ["status"])).toEqual(["/x.md"]);
    expect(m.nodes.get(A)!.fetched).toEqual([]);
  });

  it("fetchDocLinks runs the two link queries and fetchFields the one row query through the client's queryAll (none when nothing is missing)", async () => {
    const calls: { query: string; repo: unknown }[] = [];
    const client = {
      async queryAll(query: string, opts: { repo?: string | null } = {}) {
        calls.push({ query, repo: opts.repo });
        if (query.includes("_dst_path ==")) return [{ _id: "e_1", _path: "/index.md", _block_id: "b_1", _provenance: "link" }];
        if (query.startsWith("docs")) return [{ _id: "d_a", _path: A, _title: "Calcination", status: "done" }, { _id: "d_i", _path: "/index.md", _title: "Index", status: null }];
        return [{ _id: "e_2", _path: A, _dst_path: "/x.md", _dst_id: "d_x", _dst_kind: "document", _provenance: "frontmatter", _field: "depends_on" }];
      },
    };
    const l = await fetchDocLinks(client, A, { repo: "alchemy" });
    expect(l.inbound.map((r) => r.path)).toEqual(["/index.md"]);
    expect(l.outbound.map((r) => r.dstPath)).toEqual(["/x.md"]);
    const m = withNeighborhood(emptyModel(A), A, l);
    const t = await fetchFields(client, m, ["_display", "status"], { repo: "alchemy" });
    expect(calls.map((c) => c.query)).toEqual([
      `links { select _path, _block_id, _provenance, _field, _anchor where _dst_path == "${A}" }`,
      `links { select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor where _path == "${A}" }`,
      `docs { select _path, _title, status where _path in ("${A}", "/x.md", "/index.md") }`,
    ]);
    expect(calls.every((c) => c.repo === "alchemy")).toBe(true);
    expect(t.nodes.get(A)!.row.status).toBe("done");
    expect(t.nodes.get("/x.md")!.fetched).toEqual([]);
    const done = applyRows(t, [{ _id: "d_x", _path: "/x.md", _title: "X" }], ["_display", "status"]);
    expect(await fetchFields(client, done, ["_display", "status"])).toBe(done);
    expect(calls).toHaveLength(3);
  });
});

describe("toView — the <omg-graph> adapter", () => {
  it("emphasises the root, marks externals, makes documents expandable, carries truncation, rows and tooltips", () => {
    let m = withNeighborhood(emptyModel(A), A, links([out(1, "/x.md", { _provenance: "frontmatter", _field: "depends_on", _block_id: null }), out(2, "/y.md"), { _id: "e_3", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "link", _block_id: "b_3", _uri: "https://example.com/" }], [inn(4, "/i.md")]), { limit: 2 });
    m = applyRows(m, [{ _id: "d_a", _path: A, _title: "Calcination", type: "/terms/types/process.md" }], ["type"]);
    m = setPin(m, A, { x: 0, y: 0 });
    const v = toView(m);
    expect(v.nodes.map((n) => n.id)).toEqual([A, "/x.md", "/y.md", "/i.md"]);
    expect(v.nodes[0]).toEqual({
      id: A, row: { _path: A, _title: "Calcination", type: "/terms/types/process.md" }, kind: "document", pinned: { x: 0, y: 0 }, expandable: true, expanded: true, truncated: 1, emphasis: "root",
      tooltip: `${A}\n_title: Calcination\ntype: /terms/types/process.md`,
    });
    expect(v.nodes[1]).toMatchObject({ id: "/x.md", row: { _path: "/x.md" }, expandable: true, expanded: false, emphasis: null, tooltip: "/x.md" });
    expect("truncated" in v.nodes[1]!).toBe(false);
    expect(v.edges.map((e) => e.key)).toEqual([`${A}→/x.md#depends_on|`, `${A}→/y.md#|b_2`, `/i.md→${A}#|b_4`]);
    expect(v.edges[0]).toEqual({ key: `${A}→/x.md#depends_on|`, from: A, to: "/x.md", label: "depends_on", detail: `${A} → /x.md: authored in frontmatter field \`depends_on\` of ${A}`, kind: "frontmatter", style: "solid", writable: false });
    expect(v.edges[1]).toMatchObject({ kind: "body", style: "dotted", label: "body link" });
  });
  it("an external node is kind external, not expandable, its row the URL and host title", () => {
    const m = withNeighborhood(emptyModel(A), A, links([{ _id: "e_3", _path: A, _dst_path: null, _dst_id: "x_1", _dst_kind: "external", _provenance: "frontmatter", _field: "homepage", _uri: "https://example.com/docs/" }]));
    const v = toView(m);
    expect(v.nodes[1]).toMatchObject({ id: "https://example.com/docs/", kind: "external", expandable: false, row: { _url: "https://example.com/docs/", _title: "example.com/docs" }, tooltip: "https://example.com/docs/" });
    expect(v.edges[0]).toMatchObject({ kind: "external", style: "dashed", label: "→ https://example.com/docs/" });
  });
});

describe("listFieldsOf", () => {
  it("names the frontmatter fields holding a list of paths or a single path — the connector picker's extras", () => {
    expect(listFieldsOf({ title: "A", tags: ["x", "y"], depends_on: ["/c.md", "/d.md"], parent: "/p.md", wiki: ["[[salt]]"], empty: [], mixed: ["/c.md", 3], count: 2, url: "https://example.com/x.md" })).toEqual(["depends_on", "parent", "wiki"]);
    expect(listFieldsOf({})).toEqual([]);
  });
});
