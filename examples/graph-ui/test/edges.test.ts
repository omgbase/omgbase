import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { edgeQueries, edgesFromRows, oqxString, sequenceEdges } from "../src/lib/edges.ts";

describe("edgeQueries", () => {
  it("generates parsable OQX over the edges target, chunked", () => {
    const paths = Array.from({ length: 85 }, (_, i) => `d/${i}.md`);
    const qs = edgeQueries({ name: "before", kind: "frontmatter" }, paths);
    expect(qs).toHaveLength(3);
    for (const q of qs) expect(() => parse(q)).not.toThrow();
    expect(qs[0]).toMatch(/^select src: \$path, dst: \$dst_path from edges where src_field == "before" && provenance == "frontmatter" && \(\$path == "d\/0\.md" \|\| /);
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
  const rows = [
    { src: "a.md", dst: "b.md" }, { src: "a.md", dst: "b.md" }, { src: "b.md", dst: "zz.md" }, { src: "c.md", dst: null }, { src: "c.md", dst: "c.md" },
  ];
  it("keeps edges between shown nodes, deduped", () => {
    expect(edgesFromRows({ name: "before", kind: "frontmatter" }, rows, new Set(["a.md", "b.md", "c.md"])))
      .toEqual([{ src: "a.md", dst: "b.md", rel: "before" }]);
  });
  it("flips backlinks", () => {
    expect(edgesFromRows({ name: "doc.in", kind: "backlinks" }, rows, new Set(["a.md", "b.md"])))
      .toEqual([{ src: "b.md", dst: "a.md", rel: "doc.in" }]);
  });
});

describe("sequenceEdges", () => {
  it("chains consecutive rows", () => {
    expect(sequenceEdges("date", ["a", "b", "b", "c"])).toEqual([
      { src: "a", dst: "b", rel: "date" }, { src: "b", dst: "c", rel: "date" },
    ]);
  });
});
