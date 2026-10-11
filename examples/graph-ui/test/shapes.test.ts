import { describe, expect, it } from "vitest";
import { docOf, docOpOf, docReadOf, surface3, edgeFields, edgeOf } from "../src/lib/shapes.ts";

describe("surface3 — which generation of tool shapes the server speaks", () => {
  it("is 3.0 and later; unknown and 1.x/2.x are the old spellings", () => {
    expect(surface3("3.0")).toBe(true);
    expect(surface3("3.4")).toBe(true);
    expect(surface3("2.0")).toBe(false);
    expect(surface3("1.5")).toBe(false);
    expect(surface3("1.x")).toBe(false);
    expect(surface3(null)).toBe(false);
  });
});

describe("edgeFields — the `edges` target's names in generated OQX", () => {
  it("3.0 plain fields vs the 2.x intrinsics", () => {
    expect(edgeFields("3.0")).toEqual({ path: "path", dstPath: "dst_path", field: "field", docId: "doc_id", dstId: "dst_id", uri: "uri" });
    expect(edgeFields("2.0")).toEqual({ path: "$path", dstPath: "$dst_path", field: "src_field", docId: "$src", dstId: "$dst", uri: "$dst_uri" });
    expect(edgeFields(null)).toEqual(edgeFields("1.5"));
  });
});

describe("edgeOf — a `graph` tool edge under both shapes", () => {
  const v3 = { id: "e_1", doc_id: "d_a", block_id: "b_7", via_id: null, dst_id: "d_b", dst_path: "b.md", uri: null, dst_kind: "document", predicate: "before", provenance: "frontmatter", anchor: null, field: "before" };
  const v2 = { id: "e_1", src: "d_a", dst: "d_b", dst_path: "/b.md", dst_uri: null, dst_kind: "document", predicate: "before", provenance: "frontmatter", anchor: null, src_field: "before" };
  it("reads each generation by the server's version and roots the destination path; 2.x has no block/via", () => {
    expect(edgeOf("3.0", v3)).toEqual({ id: "e_1", docId: "d_a", blockId: "b_7", viaId: null, dstId: "d_b", dstPath: "/b.md", uri: null, dstKind: "document", predicate: "before", provenance: "frontmatter", anchor: null, field: "before" });
    expect(edgeOf("2.0", v2)).toEqual({ ...edgeOf("3.0", v3)!, blockId: null, viaId: null });
  });
  it("an external edge keeps its uri and a null path; the wrong generation reads as no edge", () => {
    expect(edgeOf("3.0", { ...v3, dst_id: "x_1", dst_path: null, uri: "https://example.com/", dst_kind: "external", field: null })).toMatchObject({ dstId: "x_1", dstPath: null, uri: "https://example.com/", field: null });
    expect(edgeOf("2.0", { ...v2, dst: "x_1", dst_path: null, dst_uri: "https://example.com/" })).toMatchObject({ dstId: "x_1", dstPath: null, uri: "https://example.com/" });
    expect(edgeOf("3.0", v2)).toBeNull();
    expect(edgeOf("2.0", v3)).toBeNull();
  });
});

describe("docOf — a `graph` document / frontier entry", () => {
  it("keeps the projections under their own keys, drops the envelope and the walk's degree/frontier", () => {
    expect(docOf("3.0", { id: "d_a", path: "a.md", degree: 1, frontier: true, title: "A", layer: "canon" }))
      .toEqual({ id: "d_a", path: "/a.md", degree: 1, frontier: true, fields: { title: "A", layer: "canon" } });
    expect(docOf("2.0", { id: "d_a", path: "/a.md", degree: 0, frontier: false, title: "A" }))
      .toEqual({ id: "d_a", path: "/a.md", degree: 0, frontier: false, fields: { title: "A" } });
    expect(docOf("3.0", { $id: "d_a", $path: "/a.md" })).toBeNull(); // the unreleased `$` interlude is not read
    expect(docOf(null, { id: "d_a", path: "/a.md" })).toMatchObject({ id: "d_a", path: "/a.md", degree: null, frontier: false });
  });
});

describe("docReadOf / docOpOf", () => {
  it("docs_read: `id/path/raw` on 3.0, `docId/path/content` before; the frontmatter bag is the same on both", () => {
    const fm = { before: ["/a.md"] };
    expect(docReadOf("3.0", { id: "d_b", path: "b.md", rev: "r_2", properties: { frontmatter: fm }, raw: "---\nbefore: [/a.md]\n---\n" }))
      .toEqual({ id: "d_b", path: "/b.md", rev: "r_2", raw: "---\nbefore: [/a.md]\n---\n", frontmatter: fm });
    expect(docReadOf("2.0", { path: "/b.md", docId: "d_b", rev: "r_2", properties: { frontmatter: fm }, content: "x" }))
      .toEqual({ id: "d_b", path: "/b.md", rev: "r_2", raw: "x", frontmatter: fm });
    expect(docReadOf("3.0", {})).toEqual({ id: null, path: null, rev: null, raw: null, frontmatter: {} });
  });
  it("a document op's result: `id/path` on 3.0, `docId/path` before", () => {
    expect(docOpOf("3.0", { id: "d_b", path: "/b.md", committed: true })).toEqual({ id: "d_b", path: "/b.md", committed: true });
    expect(docOpOf("2.0", { docId: "d_b", path: "b.md", committed: false })).toEqual({ id: "d_b", path: "/b.md", committed: false });
  });
});
