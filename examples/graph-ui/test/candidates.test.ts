import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { inferCandidates, pathValuedFields, refsField, relationKind } from "../src/lib/candidates.ts";

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

  it("reads `follow refs(<field>)` as the field, forward — the frontier owns it", () => {
    const src = `$path from docs where $path == "a.md" follow refs(before)`;
    const c = inferCandidates(parse(src), []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "before", kind: "frontmatter", sources: ["follow"], defaults: { edge: true, layout: true, direction: "forward" } });
    expect(src.slice(...c[0]!.spans[0]!)).toBe("refs(before)");
  });

  it("reads `refs(^field)` and a `refs(field) collect { … }` destination block the same way", () => {
    expect(inferCandidates(parse(`$path from docs follow refs(^before)`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const c = inferCandidates(parse(`$path from docs follow refs(before) collect { where phase != "x" }`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.sources])).toEqual([["before", "frontmatter", "forward", ["follow"]]]);
  });

  it("walks both ways with refs(before), refs(after): both drawn, the first lays out", () => {
    const c = inferCandidates(parse(`$path from docs follow refs(before), refs(after)`), []);
    expect(c.map((x) => [x.name, x.defaults.edge, x.defaults.layout, x.defaults.direction])).toEqual([
      ["before", true, true, "forward"],
      ["after", true, false, "forward"],
    ]);
  });

  it("reads a refs() receiver inside a destination block's where: the candidate row's field points backward, an outer one forward", () => {
    const back = parse(`$path from docs follow $repo.docs collect { where refs(after) exists { where $path == ^^$path } }`);
    expect(inferCandidates(back, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const fwd = parse(`$path from docs follow $repo.docs collect { where refs(^before) exists { where $path == ^$path } }`);
    expect(inferCandidates(fwd, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
  });

  it("reads the natural timeline query: refs(before) forward and the $it.in backlink block's `after` backward", () => {
    const src = `select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ("/" + ^$path) in list(after) }
order by $ordinal`;
    const c = inferCandidates(parse(src), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before", "frontmatter", "forward", true, true],
      ["after", "frontmatter", "backward", true, false],
    ]);
    expect(src.slice(...c[1]!.spans[0]!)).toBe(`("/" + ^$path) in list(after)`);
    // `$ordinal` is recursion metadata, not a sequence candidate.
    expect(c.some((x) => x.kind === "sequence")).toBe(false);
  });

  it("reads the bare `^$path` idiom (surface 2.0: $path is rooted) exactly like the slash-prefixed one", () => {
    const src = `select $path, title, phase, before, after
from docs
where $path == "/timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ^$path in list(after) }
order by $ordinal`;
    const c = inferCandidates(parse(src), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before", "frontmatter", "forward", true, true],
      ["after", "frontmatter", "backward", true, false],
    ]);
    expect(src.slice(...c[1]!.spans[0]!)).toBe("^$path in list(after)");
    for (const follow of [`^docs collect { where after.contains(^$path) }`, `$it.in collect { where ^$path in list(after) }`, `$repo.docs collect { where $path in ^before }`]) {
      const cands = inferCandidates(parse(`$path from docs where $path == "/a.md" follow ${follow}`), []);
      expect(cands.map((x) => [x.name, x.defaults.direction]), follow).toEqual([[follow.includes("^before") ? "before" : "after", follow.includes("^before") ? "forward" : "backward"]]);
    }
  });

  it("still reads the correlated-block forms: ^docs, $repo.docs and $it.in blocks", () => {
    for (const follow of [
      `^docs collect { where after.contains("/" + ^$path) }`,
      `$repo.docs collect { where after.contains("/" + ^$path) }`,
      `$it.in collect { where ("/" + ^$path) in list(after) }`,
    ]) {
      const c = inferCandidates(parse(`$path from docs where $path == "a.md" follow ${follow}`), []);
      expect(c.map((x) => [x.name, x.defaults.direction]), follow).toEqual([["after", "backward"]]);
    }
  });

  it("maps in / out / $it.in / $it.out to backlinks and links, named as written", () => {
    const c = inferCandidates(parse(`$path from docs follow in, $it.out, out, $it.in`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["in", "backlinks", "backward"],
      ["$it.out", "links", "forward"],
      ["out", "links", "forward"],
      ["$it.in", "backlinks", "backward"],
    ]);
  });

  it("merges refs(before) with the inferred before from the rows", () => {
    const rows = [{ id: "d_1", path: "a.md", before: ["/b.md"] }];
    const c = inferCandidates(parse(`$path, before from docs follow refs(before)`), rows);
    expect(c).toHaveLength(1);
    expect(c[0]!.sources).toEqual(["follow", "inferred"]);
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

describe("refsField / relationKind", () => {
  it("accepts refs(field) and refs(^field) only", () => {
    const expr = (src: string) => parse(`select x: ${src} from docs`).select[0]!.kind === "field" ? (parse(`select x: ${src} from docs`).select[0] as { expr: import("@omgbase/oqx").Expr }).expr : null!;
    expect(refsField(expr("refs(before)"))).toEqual({ name: "before", outer: false });
    expect(refsField(expr("refs(^before)"))).toEqual({ name: "before", outer: true });
    for (const src of ["refs($path)", "refs(\"/a.md\")", "refs(before, after)", "size(before)", "before.refs()", "before"]) {
      expect(refsField(expr(src)), src).toBeNull();
    }
  });

  it("names the link graph in its spellings", () => {
    expect(["doc.out", "out", "$it.out", "$it.doc.out"].map(relationKind)).toEqual(["links", "links", "links", "links"]);
    expect(["doc.in", "in", "$it.in"].map(relationKind)).toEqual(["backlinks", "backlinks", "backlinks"]);
    expect(["before", "owner", "meta.rel"].map(relationKind)).toEqual(["frontmatter", "frontmatter", "frontmatter"]);
  });
});
