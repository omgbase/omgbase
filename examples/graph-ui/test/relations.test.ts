import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/lib/candidates.ts";
import type { GraphEdge } from "../src/lib/edges.ts";
import { connectorKinds, detachFor, edgeProvenance, isFrontmatterField, provenanceOf, relationshipFor } from "../src/lib/relations.ts";

const candidate = (name: string, over: Partial<Candidate> = {}): Candidate => ({
  name, kind: "frontmatter", sources: ["inferred"], spans: [], defaults: { edge: true, layout: false, direction: "forward" }, ...over,
});
const before = candidate("before");
const after = candidate("after");
const pair = candidate("before/after", { kind: "sequence", sources: ["pair"], pair: { forward: "before", backward: "after", by: "name" } });
const links = candidate("_out_links", { kind: "links", sources: ["builtin"] });
const backlinks = candidate("_in_links", { kind: "backlinks", sources: ["builtin"] });
const phase = candidate("phase", { kind: "sequence", sources: ["order by"] });
const calls = candidate("calls", { projected: true });
const all = [pair, before, after, links, backlinks, phase, calls];

const e = (rel: string, src = "/a.md", dst = "/b.md", blockId?: string | null): GraphEdge => ({ src, dst, rel, ...(blockId !== undefined ? { blockId } : {}) });

describe("edgeProvenance", () => {
  it("a frontmatter field's edge is authored in that field; a link candidate's in the body; derived edges count for nothing", () => {
    expect(edgeProvenance(e("after"), all)).toEqual({ provenance: "frontmatter", field: "after" });
    expect(edgeProvenance(e("_out_links"), all)).toEqual({ provenance: "body", field: null });
    expect(edgeProvenance(e("_in_links"), all)).toEqual({ provenance: "body", field: null });
    expect(edgeProvenance(e("before/after"), all)).toBeNull();
    expect(edgeProvenance(e("phase"), all)).toBeNull();
    expect(edgeProvenance(e("calls"), all)).toBeNull();
    expect(edgeProvenance(e("nope"), all)).toBeNull();
    expect(provenanceOf([e("after"), e("phase"), e("before")], all)).toHaveLength(2);
    expect(all.filter(isFrontmatterField).map((c) => c.name)).toEqual(["before", "after"]);
  });
});

describe("connectorKinds", () => {
  it("the drawn fields by frequency (counted), then the query's other frontmatter relationships and the source's own list fields, then the body link", () => {
    const edges = [e("after"), e("after", "/b.md", "/c.md"), e("before"), e("before/after"), e("_out_links")];
    expect(connectorKinds(edges, all, { after: ["/x.md"], owner: "/people/zoe.md", tags: ["a"], title: "T" })).toEqual([
      { kind: "frontmatter", field: "after", label: "add to `after`", count: 2 },
      { kind: "frontmatter", field: "before", label: "add to `before`", count: 1 },
      { kind: "frontmatter", field: "owner", label: "add to `owner`" },
      { kind: "body-link", label: "a link in the body" },
    ]);
    expect(connectorKinds([], [links], null)).toEqual([{ kind: "body-link", label: "a link in the body" }]);
  });
});

describe("relationshipFor", () => {
  it("a field is drawn as itself when the query has it; a body link as the links candidate; else nothing", () => {
    expect(relationshipFor({ kind: "frontmatter", field: "after" }, all)).toBe("after");
    expect(relationshipFor({ kind: "frontmatter", field: "owner" }, all)).toBeNull();
    expect(relationshipFor({ kind: "frontmatter", field: "calls" }, all)).toBeNull();
    expect(relationshipFor({ kind: "body-link" }, all)).toBe("_out_links");
    expect(relationshipFor({ kind: "body-link" }, [before])).toBeNull();
  });
});

describe("detachFor", () => {
  it("a frontmatter edge severs its field on the source; a links edge its block; a backlinks edge is the stored link flipped", () => {
    expect(detachFor(e("after"), all)).toEqual({ from: "/a.md", to: "/b.md", how: { kind: "frontmatter", field: "after" }, blockId: null });
    expect(detachFor(e("_out_links", "/a.md", "/b.md", "b_7"), all)).toEqual({ from: "/a.md", to: "/b.md", how: { kind: "body-link" }, blockId: "b_7" });
    expect(detachFor(e("_in_links", "/a.md", "/b.md", "b_7"), all)).toEqual({ from: "/b.md", to: "/a.md", how: { kind: "body-link" }, blockId: "b_7" });
  });
  it("refuses a derived edge, an unknown relationship and a body link without its block, saying why", () => {
    expect(detachFor(e("before/after"), all)).toEqual({ refused: expect.stringMatching(/remove it from `before` or `after` directly/) });
    expect(detachFor(e("phase"), all)).toEqual({ refused: expect.stringMatching(/derived from order by/) });
    expect(detachFor(e("calls"), all)).toEqual({ refused: expect.stringMatching(/projected by the query/) });
    expect(detachFor(e("nope"), all)).toEqual({ refused: expect.stringMatching(/not a relationship of this query/) });
    expect(detachFor(e("_out_links"), all)).toEqual({ refused: expect.stringMatching(/block is unknown/) });
    expect(detachFor(e("_out_links", "/a.md", "/b.md", null), all)).toEqual({ refused: expect.stringMatching(/block is unknown/) });
  });
});
