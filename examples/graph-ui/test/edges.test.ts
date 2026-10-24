import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { edgeQueries, edgesFromRows, edgesFromValues, oqxString, orientEdge, orientEdges, pairEdges, sequenceEdges, type GraphEdge } from "../src/lib/edges.ts";
import { NAMES_4 } from "../src/lib/paths.ts";

describe("edgeQueries", () => {
  it("generates parsable OQX over the link rows, chunked", () => {
    const paths = Array.from({ length: 85 }, (_, i) => `/d/${i}.md`);
    const qs = edgeQueries({ name: "before", kind: "frontmatter" }, paths);
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(() => parse(q)).not.toThrow();
    expect(qs[0]).toMatch(/^links \{ select src: _path, dst: _dst_path where _field == "before" && _provenance == "frontmatter" && \(_path == "\/d\/0\.md" \|\| /);
    for (const q of edgeQueries({ name: "before", kind: "frontmatter" }, paths, NAMES_4)) expect(() => parse(q)).not.toThrow();
  });

  it("spells `links { … }` with `_path`/`_dst_path`/`_field` (spec/surface 5.0 §1.1–§1.2) — bare for a 4.x server; the aliases are the demo's own", () => {
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, ["/a.md"])[0]).toBe('links { select src: _path, dst: _dst_path where _field == "before" && _provenance == "frontmatter" && (_path == "/a.md") }');
    expect(edgeQueries({ name: "_out_links", kind: "links" }, ["/a.md"])[0]).toBe('links { select src: _path, dst: _dst_path where _provenance == "link" && _dst_kind == "document" && (_path == "/a.md") }');
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, ["/a.md"], NAMES_4)[0]).toBe('links { select src: path, dst: dst_path where field == "before" && provenance == "frontmatter" && (path == "/a.md") }');
    expect(edgeQueries({ name: "doc.out_links", kind: "links" }, ["/a.md"], NAMES_4)[0]).toBe('links { select src: path, dst: dst_path where provenance == "link" && dst_kind == "document" && (path == "/a.md") }');
  });

  it("spells the path literals rooted whatever form the keys came in", () => {
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, ["/a.md", "dir/b.md"])[0]).toContain('(_path == "/a.md" || _path == "/dir/b.md")');
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, ["/a.md", "dir/b.md"], NAMES_4)[0]).toContain('(path == "/a.md" || path == "/dir/b.md")');
  });

  it("links and backlinks share the link-provenance query; sequences fetch nothing", () => {
    const q = edgeQueries({ name: "_in_links", kind: "backlinks" }, ["a.md"]);
    expect(q[0]).toContain('_provenance == "link" && _dst_kind == "document"');
    expect(edgeQueries({ name: "doc.in_links", kind: "backlinks" }, ["a.md"], NAMES_4)[0]).toContain('provenance == "link" && dst_kind == "document"');
    expect(edgeQueries({ name: "date", kind: "sequence" }, ["a.md"])).toEqual([]);
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, [])).toEqual([]);
  });

  it("escapes string literals", () => {
    expect(oqxString('we"ird')).toBe('"we\\"ird"');
  });
});

describe("edgesFromRows", () => {
  const rows = [
    { src: "/a.md", dst: "/b.md" }, { src: "/a.md", dst: "/b.md" }, { src: "/b.md", dst: "/zz.md" }, { src: "/c.md", dst: null }, { src: "/c.md", dst: "/c.md" },
  ];
  const shown = new Set(["/a.md", "/b.md", "/c.md"]);
  it("keeps edges between shown nodes, deduped, keyed by the rooted path", () => {
    expect(edgesFromRows({ name: "before", kind: "frontmatter" }, rows, shown))
      .toEqual([{ src: "/a.md", dst: "/b.md", rel: "before" }]);
  });
  it("roots a row's paths before the lookup", () => {
    const bare = rows.map((r) => ({ src: r.src.slice(1), dst: r.dst === null ? null : r.dst.slice(1) }));
    expect(edgesFromRows({ name: "before", kind: "frontmatter" }, bare, shown)).toEqual(edgesFromRows({ name: "before", kind: "frontmatter" }, rows, shown));
  });
  it("flips backlinks", () => {
    expect(edgesFromRows({ name: "_in_links", kind: "backlinks" }, rows, new Set(["/a.md", "/b.md"])))
      .toEqual([{ src: "/b.md", dst: "/a.md", rel: "_in_links" }]);
  });
});

describe("orientEdge — the arrow follows the direction", () => {
  const e: GraphEdge = { src: "/alpha.md", dst: "/prototype.md", rel: "after" };
  it("keeps the stored owner → target under forward and flips it under backward", () => {
    expect(orientEdge(e, "forward")).toEqual(e);
    expect(orientEdge(e, "backward")).toEqual({ src: "/prototype.md", dst: "/alpha.md", rel: "after" });
    // Flipping twice is the identity; the input is not mutated.
    expect(orientEdge(orientEdge(e, "backward"), "backward")).toEqual(e);
    expect(e).toEqual({ src: "/alpha.md", dst: "/prototype.md", rel: "after" });
  });
  it("orients a whole set and keeps extra fields (a pending edge's action)", () => {
    const pending = [{ ...e, action: "add" as const }, { src: "/x.md", dst: "/y.md", rel: "after", action: "remove" as const }];
    expect(orientEdges(pending, "backward")).toEqual([
      { src: "/prototype.md", dst: "/alpha.md", rel: "after", action: "add" },
      { src: "/y.md", dst: "/x.md", rel: "after", action: "remove" },
    ]);
    expect(orientEdges(pending, "forward")).toEqual(pending);
  });
});

describe("pairEdges — one sequence from both ends", () => {
  const pair = { forward: "before", backward: "after" };
  it("keeps the forward field's edges, flips the backward field's, relabels, dedupes", () => {
    const edges: GraphEdge[] = [
      { src: "/kickoff.md", dst: "/design.md", rel: "before" }, // kickoff before design: earlier → later as stored
      { src: "/alpha.md", dst: "/prototype.md", rel: "after" }, // alpha after prototype: flipped to prototype → alpha
      { src: "/design.md", dst: "/kickoff.md", rel: "after" }, // the same fact authored from the other end: one edge
      { src: "/x.md", dst: "/y.md", rel: "owner" }, // not a member
      { src: "/loop.md", dst: "/loop.md", rel: "before" }, // self loop dropped
    ];
    expect(pairEdges("before/after", pair, edges)).toEqual([
      { src: "/kickoff.md", dst: "/design.md", rel: "before/after" },
      { src: "/prototype.md", dst: "/alpha.md", rel: "before/after" },
    ]);
  });
  it("is the whole sequence when only one field is authored (a repository with `after` alone)", () => {
    const onlyAfter: GraphEdge[] = [
      { src: "/b.md", dst: "/a.md", rel: "after" },
      { src: "/c.md", dst: "/b.md", rel: "after" },
    ];
    expect(pairEdges("before/after", pair, onlyAfter)).toEqual([
      { src: "/a.md", dst: "/b.md", rel: "before/after" },
      { src: "/b.md", dst: "/c.md", rel: "before/after" },
    ]);
    expect(pairEdges("before/after", pair, [])).toEqual([]);
  });
  it("normalises to the same picture whichever end authored it", () => {
    const viaBefore = pairEdges("p", pair, [{ src: "/a.md", dst: "/b.md", rel: "before" }]);
    const viaAfter = pairEdges("p", pair, [{ src: "/b.md", dst: "/a.md", rel: "after" }]);
    expect(viaBefore).toEqual(viaAfter);
    // …and a backward view of the pair flips every arrow at once.
    expect(orientEdges(viaBefore, "backward")).toEqual([{ src: "/b.md", dst: "/a.md", rel: "p" }]);
  });
});

describe("sequenceEdges", () => {
  it("chains consecutive rows", () => {
    expect(sequenceEdges("date", ["a", "b", "b", "c"])).toEqual([
      { src: "a", dst: "b", rel: "date" }, { src: "b", dst: "c", rel: "date" },
    ]);
  });
});

describe("edgesFromValues (a projected relationship)", () => {
  const node = (path: string, row: Record<string, unknown>) => ({ path, row });
  const shown = new Set(["/a.md", "/b.md", "/c.md"]);

  it("reads each shown row's own value: paths, lists of paths and rows that surfaced as values", () => {
    const nodes = [
      node("/a.md", { calls: ["/b.md", "/c.md"] }),
      node("/b.md", { calls: [{ _id: "d_c000000", _path: "/c.md" }] }),
      node("/c.md", { calls: [] }),
    ];
    expect(edgesFromValues("calls", nodes, shown)).toEqual([
      { src: "/a.md", dst: "/b.md", rel: "calls" },
      { src: "/a.md", dst: "/c.md", rel: "calls" },
      { src: "/b.md", dst: "/c.md", rel: "calls" },
    ]);
  });

  it("keeps only edges between shown nodes, never a self-edge, deduped, rooted", () => {
    const nodes = [node("a.md", { calls: ["/a.md", "/x.md", "b.md", "/b.md"] }), node("/b.md", { calls: "/a.md" })];
    expect(edgesFromValues("calls", nodes, shown)).toEqual([
      { src: "/a.md", dst: "/b.md", rel: "calls" },
      { src: "/b.md", dst: "/a.md", rel: "calls" },
    ]);
  });

  it("a row without the field names no one", () => {
    expect(edgesFromValues("calls", [node("/a.md", { title: "x" })], shown)).toEqual([]);
  });
});
