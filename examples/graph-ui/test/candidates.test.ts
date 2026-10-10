import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { inferCandidates, pathValuedFields } from "../src/lib/candidates.ts";

const TIMELINE = `select $path, title, before, after
from docs
where $path == "timeline/kickoff.md"
follow $repo.docs collect { where after.contains("/" + ^$path) }
order by $ordinal`;

describe("inferCandidates", () => {
  it("reads a destination block's correlated where: a successor property points backward", () => {
    const c = inferCandidates(parse(TIMELINE), []);
    const after = c.find((x) => x.name === "after")!;
    expect(after).toBeDefined();
    expect(after.kind).toBe("frontmatter");
    expect(after.sources).toEqual(["follow"]);
    expect(after.defaults).toEqual({ edge: true, layout: true, direction: "backward" });
    expect(after.spans.length).toBe(1);
    // `order by $ordinal` is recursion metadata, not a sequence candidate.
    expect(c.some((x) => x.kind === "sequence")).toBe(false);
  });

  it("reads an outer-ref membership test as the frontier's property pointing forward", () => {
    const q = parse(`$path from docs where $path == "a.md" follow $repo.docs collect { where ("/" + $path) in ^before }`);
    const c = inferCandidates(q, []);
    expect(c.map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    expect(c[0]!.defaults.layout).toBe(true);
  });

  it("reads src_field literals under in_edges / out_edges", () => {
    const q = parse(`$path from docs where $path == "a.md" follow $repo.docs collect { where doc.in_edges exists { where src_field == "before" && $path == ^^$path } }`);
    expect(inferCandidates(q, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q2 = parse(`$path from docs where $path == "a.md" follow $repo.docs collect { where doc.out_edges exists { where predicate == "after" && $dst_path == ^^$path } }`);
    expect(inferCandidates(q2, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
  });

  it("maps plain destinations: doc.out → links, doc.in → backlinks, a bare name → frontmatter", () => {
    const c = inferCandidates(parse(`$path from docs where $path == "a.md" follow doc.out, doc.in, before`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["doc.out", "links", "forward"],
      ["doc.in", "backlinks", "backward"],
      ["before", "frontmatter", "forward"],
    ]);
    // Every follow destination is drawn; the first one lays out.
    expect(c.map((x) => x.defaults.edge)).toEqual([true, true, true]);
    expect(c.map((x) => x.defaults.layout)).toEqual([true, false, false]);
  });

  it("turns a non-intrinsic order by key into a sequence candidate", () => {
    const c = inferCandidates(parse(`$path, date from docs order by date desc, $path`), []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "date", kind: "sequence", sources: ["order by"], defaults: { edge: false, layout: true, direction: "backward" } });
  });

  it("infers path-valued fields from rows, drawn only when the query has no follow", () => {
    const rows = [
      { id: "d_1", path: "a.md", before: ["/b.md"], owner: "/people/ada.md", title: "A" },
      { id: "d_2", path: "b.md", before: [], after: ["/a.md"] },
    ];
    const c = inferCandidates(parse(`$path, before, after, owner, title from docs`), rows);
    expect(c.map((x) => x.name).sort()).toEqual(["after", "before", "owner"]);
    for (const x of c) expect(x.sources).toEqual(["inferred"]);
    expect(c.find((x) => x.name === "before")!.defaults).toEqual({ edge: true, layout: true, direction: "forward" });
    expect(c.find((x) => x.name === "after")!.defaults.direction).toBe("backward");
    expect(c.find((x) => x.name === "owner")!.defaults.layout).toBe(false);
  });

  it("merges the same name from follow and rows and keeps follow's roles", () => {
    const rows = [{ id: "d_1", path: "a.md", after: ["/b.md"], before: ["/c.md"] }];
    const c = inferCandidates(parse(TIMELINE), rows);
    const after = c.find((x) => x.name === "after")!;
    expect(after.sources).toEqual(["follow", "inferred"]);
    expect(after.defaults.edge).toBe(true);
    const before = c.find((x) => x.name === "before")!;
    expect(before.sources).toEqual(["inferred"]);
    expect(before.defaults.edge).toBe(false); // the query has a follow; inferred fields are not drawn by default
    expect(before.defaults.layout).toBe(false);
  });

  it("works without an AST (unparsable source) from rows alone", () => {
    expect(inferCandidates(null, [{ id: "x", path: "a.md", next: "/b.md" }]).map((c) => c.name)).toEqual(["next"]);
    expect(inferCandidates(null, [])).toEqual([]);
  });
});

describe("pathValuedFields", () => {
  it("accepts root paths, relative paths and lists; rejects metadata, mixed lists and non-paths", () => {
    expect(pathValuedFields([{ id: "a", path: "x.md", $path: "x.md", a: "/a.md", b: "dir/b.md", c: ["/a.md", "b.md"], d: ["/a.md", 3], e: "hello", f: [] }]))
      .toEqual(["a", "b", "c"]);
  });
});
