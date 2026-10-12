import { describe, expect, it } from "vitest";
import { docOf, docOpOf, docReadOf, edgeOf, graphEdgeRows } from "../src/lib/shapes.ts";

describe("edgeOf / graphEdgeRows — the `graph` tool's link rows", () => {
  const link = { id: "e_1", doc_id: "d_a", block_id: "b_7", via_id: null, dst_id: "d_b", dst_path: "b.md", uri: null, dst_kind: "document", predicate: "before", provenance: "frontmatter", anchor: null, field: "before" };
  it("graphEdgeRows: the result's `links[]`, objects only", () => {
    expect(graphEdgeRows({ documents: [], links: [link], frontier: [] })).toEqual([link]);
    expect(graphEdgeRows({ documents: [] })).toEqual([]);
    expect(graphEdgeRows({ links: "nope" })).toEqual([]);
    expect(graphEdgeRows({ links: [link, null, 3] })).toEqual([link]);
    expect(graphEdgeRows({ links: [link] }).map(edgeOf)).toEqual([edgeOf(link)]);
  });
  it("reads a link row and roots the destination path", () => {
    expect(edgeOf(link)).toEqual({ id: "e_1", docId: "d_a", blockId: "b_7", viaId: null, dstId: "d_b", dstPath: "/b.md", uri: null, dstKind: "document", predicate: "before", provenance: "frontmatter", anchor: null, field: "before" });
  });
  it("an external link keeps its uri and a null path; a row without its identity is no edge", () => {
    expect(edgeOf({ ...link, dst_id: "x_1", dst_path: null, uri: "https://example.com/", dst_kind: "external", field: null })).toMatchObject({ dstId: "x_1", dstPath: null, uri: "https://example.com/", field: null });
    expect(edgeOf({ id: "e_1", dst_id: "d_b" })).toBeNull();
    expect(edgeOf({})).toBeNull();
  });
});

describe("docOf — a `graph` document / frontier entry", () => {
  it("keeps the projections under their own keys, drops the envelope and the walk's degree/frontier", () => {
    expect(docOf({ id: "d_a", path: "a.md", degree: 1, frontier: true, title: "A", layer: "canon" }))
      .toEqual({ id: "d_a", path: "/a.md", degree: 1, frontier: true, fields: { title: "A", layer: "canon" } });
    expect(docOf({ id: "d_a", path: "/a.md" })).toMatchObject({ id: "d_a", path: "/a.md", degree: null, frontier: false, fields: {} });
    expect(docOf({ path: "/a.md" })).toBeNull();
  });
});

describe("docReadOf / docOpOf", () => {
  it("docs_read: `{ id, path, rev, properties, raw }`; the frontmatter bag is `properties.frontmatter`", () => {
    const fm = { before: ["/a.md"] };
    expect(docReadOf({ id: "d_b", path: "b.md", rev: "r_2", properties: { frontmatter: fm }, raw: "---\nbefore: [/a.md]\n---\n" }))
      .toEqual({ id: "d_b", path: "/b.md", rev: "r_2", raw: "---\nbefore: [/a.md]\n---\n", frontmatter: fm });
    expect(docReadOf({})).toEqual({ id: null, path: null, rev: null, raw: null, frontmatter: {} });
  });
  it("a document op's result: `{ id, path, committed }`", () => {
    expect(docOpOf({ id: "d_b", path: "/b.md", committed: true })).toEqual({ id: "d_b", path: "/b.md", committed: true });
    expect(docOpOf({ id: "d_b", path: "b.md" })).toEqual({ id: "d_b", path: "/b.md", committed: false });
  });
});
