import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { edgeQueries, edgesFromRows, oqxString, orientEdge, orientEdges, pairEdges, sequenceEdges, type GraphEdge } from "../src/lib/edges.ts";

describe("edgeQueries", () => {
  it("generates parsable OQX over the link rows (`edges` on a pre-3.0 server), chunked", () => {
    const paths = Array.from({ length: 85 }, (_, i) => `d/${i}.md`);
    const qs = edgeQueries({ name: "before", kind: "frontmatter" }, paths);
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(() => parse(q)).not.toThrow();
    expect(qs[0]).toMatch(/^select src: \$path, dst: \$dst_path from edges where src_field == "before" && provenance == "frontmatter" && \(\$path == "d\/0\.md" \|\| /);
  });

  it("spells the row kind and the edge fields per server: `from edges` + `$path`/`$dst_path`/`src_field` through 2.x, `from links` + `path`/`dst_path`/`field` on 3.0 (spec/surface §1.1–§1.2); the aliases are the demo's own", () => {
    const keys = ["/a.md"];
    for (const surface of [null, "1.5", "2.0"]) {
      const q = edgeQueries({ name: "before", kind: "frontmatter" }, keys, surface)[0]!;
      expect(q, String(surface)).toContain('select src: $path, dst: $dst_path from edges where src_field == "before"');
      expect(q, String(surface)).not.toContain("links");
      expect(() => parse(q)).not.toThrow();
    }
    for (const surface of ["3.0", "3.2"]) {
      const q = edgeQueries({ name: "before", kind: "frontmatter" }, keys, surface)[0]!;
      expect(q, surface).toBe('select src: path, dst: dst_path from links where field == "before" && provenance == "frontmatter" && (path == "/a.md")');
      expect(() => parse(q)).not.toThrow();
      expect(q).not.toContain("$");
      expect(q).not.toContain("edges"); // `from edges` is an unknown target on 3.0
    }
    expect(edgeQueries({ name: "doc.out", kind: "links" }, keys, "3.0")[0]).toBe('select src: path, dst: dst_path from links where provenance == "link" && dst_kind == "document" && (path == "/a.md")');
    expect(edgeQueries({ name: "doc.out", kind: "links" }, keys, "2.0")[0]).toBe('select src: $path, dst: $dst_path from edges where provenance == "link" && dst_kind == "document" && ($path == "/a.md")');
  });

  it("spells the path literals in the server's form: bare for 1.x (and unknown), rooted for 2.0", () => {
    const keys = ["/a.md", "/dir/b.md"]; // node keys are always rooted
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, keys, "1.5")[0]).toContain('($path == "a.md" || $path == "dir/b.md")');
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, keys)[0]).toContain('($path == "a.md" || $path == "dir/b.md")');
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, keys, "2.0")[0]).toContain('($path == "/a.md" || $path == "/dir/b.md")');
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, ["a.md"], "2.0")[0]).toContain('$path == "/a.md"');
  });

  it("links and backlinks share the link-provenance query; sequences fetch nothing", () => {
    const q = edgeQueries({ name: "doc.in", kind: "backlinks" }, ["a.md"]);
    expect(q[0]).toContain('provenance == "link" && dst_kind == "document"');
    expect(edgeQueries({ name: "date", kind: "sequence" }, ["a.md"])).toEqual([]);
    expect(edgeQueries({ name: "before", kind: "frontmatter" }, [])).toEqual([]);
  });

  it("escapes string literals", () => {
    expect(oqxString('we"ird')).toBe('"we\\"ird"');
  });
});

describe("edgesFromRows", () => {
  // 1.x rows (bare paths); the shown set holds the rooted node keys.
  const rows = [
    { src: "a.md", dst: "b.md" }, { src: "a.md", dst: "b.md" }, { src: "b.md", dst: "zz.md" }, { src: "c.md", dst: null }, { src: "c.md", dst: "c.md" },
  ];
  const shown = new Set(["/a.md", "/b.md", "/c.md"]);
  it("keeps edges between shown nodes, deduped, keyed by the rooted path", () => {
    expect(edgesFromRows({ name: "before", kind: "frontmatter" }, rows, shown))
      .toEqual([{ src: "/a.md", dst: "/b.md", rel: "before" }]);
  });
  it("reads 2.0 rows (rooted paths) to the same edges", () => {
    const rooted = rows.map((r) => ({ src: `/${r.src}`, dst: r.dst === null ? null : `/${r.dst}` }));
    expect(edgesFromRows({ name: "before", kind: "frontmatter" }, rooted, shown)).toEqual(edgesFromRows({ name: "before", kind: "frontmatter" }, rows, shown));
  });
  it("flips backlinks", () => {
    expect(edgesFromRows({ name: "doc.in", kind: "backlinks" }, rows, new Set(["/a.md", "/b.md"])))
      .toEqual([{ src: "/b.md", dst: "/a.md", rel: "doc.in" }]);
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
