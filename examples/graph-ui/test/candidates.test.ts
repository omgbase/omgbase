import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { STRUCTURAL_RELATIONS, detectPairs, inferCandidates, linkRowsReceiver, pairName, pathValuedFields, reciprocal, refsField, relationKind } from "../src/lib/candidates.ts";

const TIMELINE = `select path, title, before, after
from docs
where path == "/timeline/kickoff.md"
follow ^docs collect { where after.contains(^path) }
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
    const q = parse(`path from docs where path == "a.md" follow ^docs collect { where path in ^before }`);
    const c = inferCandidates(q, []);
    expect(c.map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    expect(c[0]!.defaults.layout).toBe(true);
  });

  it("reads `field` / `predicate` literals under in_links / out_links / ^links (spec/surface §1.1–§1.2)", () => {
    const q = parse(`path from docs where path == "a.md" follow ^docs collect { where doc.in_links exists { where field == "before" && path == ^^path } }`);
    expect(inferCandidates(q, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q2 = parse(`path from docs where path == "a.md" follow ^docs collect { where doc.out_links exists { where predicate == "after" && dst_path == ^^path } }`);
    expect(inferCandidates(q2, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const q3 = parse(`path from docs where path == "a.md" follow ^docs collect { where $it.in_links exists { where field == "before" } }`);
    expect(inferCandidates(q3, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q4 = parse(`path from docs where path == "a.md" follow ^docs collect { where ^^links exists { where predicate == "owner" && dst_path == ^^path } }`);
    expect(inferCandidates(q4, []).map((x) => [x.name, x.defaults.direction])).toEqual([["owner", "forward"]]);
    // A literal under something that is not the link rows names nothing.
    const q5 = parse(`path from docs where path == "a.md" follow ^docs collect { where doc.blocks exists { where field == "x" } }`);
    expect(inferCandidates(q5, [])).toEqual([]);
  });

  it("linkRowsReceiver / STRUCTURAL_RELATIONS know the link rows", () => {
    expect(linkRowsReceiver("doc.in_links")).toBe("in");
    expect(linkRowsReceiver("in_links")).toBe("in");
    expect(linkRowsReceiver("$it.out_links")).toBe("out");
    expect(linkRowsReceiver("out_links")).toBe("out");
    expect(linkRowsReceiver("^links")).toBe("all");
    expect(linkRowsReceiver("^^links")).toBe("all");
    expect(linkRowsReceiver("links")).toBe("all");
    expect(linkRowsReceiver("doc.blocks")).toBeNull();
    expect(linkRowsReceiver("my_links")).toBeNull();
    expect(linkRowsReceiver("")).toBeNull();
    for (const r of ["in_links", "out_links", "dst", "doc", "children", "subsections"]) expect(STRUCTURAL_RELATIONS.has(r), r).toBe(true);
    expect(STRUCTURAL_RELATIONS.has("before")).toBe(false);
  });

  it("reads the link-graph walk through the link rows: `out_links collect { from dst }` → links, `in_links collect { from doc }` → backlinks, named by the receiver as written", () => {
    const c = inferCandidates(parse(`path from docs where path == "a.md" follow out_links collect { from dst }`), []);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([["out_links", "links", ["follow"], { edge: true, layout: true, direction: "forward" }]]);
    const b = inferCandidates(parse(`path from docs where path == "a.md" follow in_links collect { from doc depth 2 }`), []);
    expect(b.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([["in_links", "backlinks", ["follow"], { edge: true, layout: true, direction: "backward" }]]);
    // dotted receivers, `distinct`, several destinations, a filtered body — the receiver still names the relation
    const d = inferCandidates(parse(`path from docs where path == "a.md" follow distinct doc.out_links collect { from dst where provenance == "link" }, $it.in_links collect { from doc }, refs(before)`), []);
    expect(d.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([["doc.out_links", "links", "forward"], ["$it.in_links", "backlinks", "backward"], ["before", "frontmatter", "forward"]]);
    // a `field`/`predicate` literal in the body keeps the frontmatter-relation reading (beside the link-graph candidate)
    const f = inferCandidates(parse(`path from docs where path == "a.md" follow out_links collect { from dst where field == "owner" }`), []);
    expect(f.map((x) => [x.name, x.kind])).toEqual([["out_links", "links"], ["owner", "frontmatter"]]);
    // with a follow there is no builtin pair
    expect(c.some((x) => x.sources.includes("builtin"))).toBe(false);
  });

  it("maps plain destinations: the link rows → links / backlinks, a bare name → frontmatter", () => {
    const c = inferCandidates(parse(`path from docs where path == "a.md" follow doc.out_links, doc.in_links, before`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["doc.out_links", "links", "forward"],
      ["doc.in_links", "backlinks", "backward"],
      ["before", "frontmatter", "forward"],
    ]);
    // Every follow destination is drawn; the first one lays out.
    expect(c.map((x) => x.defaults.edge)).toEqual([true, true, true]);
    expect(c.map((x) => x.defaults.layout)).toEqual([true, false, false]);
  });

  it("turns a non-attribute order by key into a sequence candidate (`path`/`updated_at` are attributes, never keys)", () => {
    const c = inferCandidates(parse(`path, date from docs order by date desc, path, updated_at`), []);
    expect(c.map((x) => x.name)).toEqual(["date", "doc.out_links", "doc.in_links"]); // + the builtin links (no follow)
    expect(c[0]).toMatchObject({ name: "date", kind: "sequence", sources: ["order by"], defaults: { edge: false, layout: true, direction: "backward" } });
    expect(c.find((x) => x.name === "doc.out_links")!.defaults.edge).toBe(true); // nothing else is drawn
  });

  it("offers the builtin link graph when the query has no follow: doc.out_links drawn only when nothing else is, never the axis", () => {
    const bare = inferCandidates(parse(`select path, title from docs order by updated_at desc limit 40`), []);
    expect(bare.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([
      ["doc.out_links", "links", ["builtin"], { edge: true, layout: false, direction: "forward" }],
      ["doc.in_links", "backlinks", ["builtin"], { edge: false, layout: false, direction: "backward" }],
    ]);
    // With an inferred field the field is drawn and lays out; the links stay offered, undrawn.
    const withField = inferCandidates(parse(`path, before from docs`), [{ id: "d_1", path: "/a.md", before: ["/b.md"] }]);
    expect(withField.map((x) => [x.name, x.defaults.edge, x.defaults.layout])).toEqual([["before", true, true], ["doc.out_links", false, false], ["doc.in_links", false, false]]);
    // With a follow there is no builtin pair; a link-graph walk is the follow candidate itself.
    expect(inferCandidates(parse(`path from docs follow refs(before)`), []).map((x) => x.name)).toEqual(["before"]);
    expect(inferCandidates(parse(`path from docs follow out_links collect { from dst }`), []).map((x) => [x.name, x.sources])).toEqual([["out_links", ["follow"]]]);
  });

  it("infers path-valued fields from rows, drawn only when the query has no follow", () => {
    const rows = [
      { id: "d_1", path: "/a.md", before: ["/b.md"], owner: "/people/ada.md", title: "A" },
      { id: "d_2", path: "/b.md", before: [], after: ["/a.md"] },
    ];
    const c = inferCandidates(parse(`path, before, after, owner, title from docs`), rows).filter((x) => !x.sources.includes("builtin") && !x.pair);
    expect(c.map((x) => x.name).sort()).toEqual(["after", "before", "owner"]);
    for (const x of c) expect(x.sources).toEqual(["inferred"]);
    // `before` and `after` form a pair (rule 5), which takes the drawn/axis defaults; the fields stay listed.
    expect(c.find((x) => x.name === "before")!.defaults).toEqual({ edge: false, layout: false, direction: "forward" });
    expect(c.find((x) => x.name === "after")!.defaults.direction).toBe("backward");
    expect(c.find((x) => x.name === "owner")!.defaults.layout).toBe(false);
    // Without the inverse, the single field is drawn and lays out as before.
    const single = inferCandidates(parse(`path, before, owner from docs`), rows.map(({ after: _after, ...r }) => r)).filter((x) => !x.sources.includes("builtin"));
    expect(single.find((x) => x.name === "before")!.defaults).toEqual({ edge: true, layout: true, direction: "forward" });
  });

  it("merges the same name from follow and rows and keeps follow's roles", () => {
    const rows = [{ id: "d_1", path: "/a.md", after: ["/b.md"], owner: "/c.md" }];
    const c = inferCandidates(parse(TIMELINE), rows);
    const after = c.find((x) => x.name === "after")!;
    expect(after.sources).toEqual(["follow", "inferred"]);
    expect(after.defaults.edge).toBe(true);
    const owner = c.find((x) => x.name === "owner")!;
    expect(owner.sources).toEqual(["inferred"]);
    expect(owner.defaults.edge).toBe(false); // the query has a follow; inferred fields are not drawn by default
    expect(owner.defaults.layout).toBe(false);
  });

  it("reads `follow refs(<field>)` as the field, forward — the frontier owns it", () => {
    const src = `path from docs where path == "a.md" follow refs(before)`;
    const c = inferCandidates(parse(src), []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "before", kind: "frontmatter", sources: ["follow"], defaults: { edge: true, layout: true, direction: "forward" } });
    expect(src.slice(...c[0]!.spans[0]!)).toBe("refs(before)");
  });

  it("reads `refs(^field)` and a `refs(field) collect { … }` destination block the same way", () => {
    expect(inferCandidates(parse(`path from docs follow refs(^before)`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const c = inferCandidates(parse(`path from docs follow refs(before) collect { where phase != "x" }`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.sources])).toEqual([["before", "frontmatter", "forward", ["follow"]]]);
  });

  it("walks both ways with refs(before), refs(after): the pair is drawn and lays out, the fields stay listed undrawn", () => {
    const c = inferCandidates(parse(`path from docs follow refs(before), refs(after)`), []);
    expect(c.map((x) => [x.name, x.defaults.edge, x.defaults.layout, x.defaults.direction])).toEqual([
      ["before/after", true, true, "forward"],
      ["before", false, false, "forward"],
      ["after", false, false, "forward"],
    ]);
    // `refs(after)` walks the strings forward, but the pair still flips `after` edges: it is the field's meaning, not the walk's.
    expect(c[0]!.pair).toEqual({ forward: "before", backward: "after", by: "name" });
    // Two unrelated walks: no pair, the old rule.
    const two = inferCandidates(parse(`path from docs follow refs(owner), refs(see_also)`), []);
    expect(two.map((x) => [x.name, x.defaults.edge, x.defaults.layout])).toEqual([["owner", true, true], ["see_also", true, false]]);
  });

  it("reads a refs() receiver inside a destination block's where: the candidate row's field points backward, an outer one forward", () => {
    const back = parse(`path from docs follow ^docs collect { where refs(after) exists { where path == ^^path } }`);
    expect(inferCandidates(back, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const fwd = parse(`path from docs follow ^docs collect { where refs(^before) exists { where path == ^path } }`);
    expect(inferCandidates(fwd, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
  });

  it("reads the natural timeline query: refs(before) forward and the backlink block's `after` backward", () => {
    const src = `select path, title, phase, before, after
from docs
where path == "/timeline/kickoff.md"
follow distinct refs(before), in_links collect { from doc where ^path in list(after) }
order by $ordinal`;
    const c = inferCandidates(parse(src), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before/after", "sequence", "forward", true, true],
      ["before", "frontmatter", "forward", false, false],
      ["after", "frontmatter", "backward", false, false],
    ]);
    expect(src.slice(...c[2]!.spans[0]!)).toBe("^path in list(after)");
    // Hovering the pair lights both fields: its spans are the members'.
    expect(c[0]!.spans).toEqual([...c[1]!.spans, ...c[2]!.spans]);
    expect(c[0]!.sources).toEqual(["pair"]);
    // `$ordinal` is recursion metadata, not a sequence candidate (the pair is the only sequence-kinded one).
    expect(c.some((x) => x.kind === "sequence" && !x.pair)).toBe(false);
    // The backlink block correlates the reached document with the frontier (`^path in list(after)`), so the walk MEANS `after`:
    // the whole backlink graph (`in_links`) is not offered beside it.
    expect(c.map((x) => x.name)).toEqual(["before/after", "before", "after"]);
    expect(inferCandidates(parse(`path from docs follow in_links collect { from doc where phase == "x" }`), []).map((x) => x.name)).toEqual(["in_links"]); // an uncorrelated filter keeps the walk
  });

  it("reads the correlation idiom in its spellings — a membership test, a contains(), a nested refs() — without mistaking an attribute for a field", () => {
    for (const follow of [`^docs collect { where after.contains(^path) }`, `in_links collect { from doc where ^path in list(after) }`, `^docs collect { where refs(after) exists { where path == ^^path } }`]) {
      const cands = inferCandidates(parse(`path from docs where path == "/a.md" follow ${follow}`), []).filter((x) => x.kind === "frontmatter");
      expect(cands.map((x) => [x.name, x.defaults.direction]), follow).toEqual([["after", "backward"]]);
    }
    expect(inferCandidates(parse(`path from docs where path == "/a.md" follow ^docs collect { where path in ^before }`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
  });

  it("maps $it.in_links / doc.out_links / in_links / out_links to backlinks and links, named as written", () => {
    const c = inferCandidates(parse(`path from docs follow $it.in_links, out_links, doc.in_links, $it.out_links`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["$it.in_links", "backlinks", "backward"],
      ["out_links", "links", "forward"],
      ["doc.in_links", "backlinks", "backward"],
      ["$it.out_links", "links", "forward"],
    ]);
  });

  it("merges refs(before) with the inferred before from the rows", () => {
    const rows = [{ id: "d_1", path: "/a.md", before: ["/b.md"] }];
    const c = inferCandidates(parse(`path, before from docs follow refs(before)`), rows);
    expect(c).toHaveLength(1);
    expect(c[0]!.sources).toEqual(["follow", "inferred"]);
  });

  it("reads a hit's path through the envelope (`id`/`path`, rooted or bare)", () => {
    const rooted = [
      { id: "d_1", path: "/a.md", before: ["/b.md"] },
      { id: "d_2", path: "/b.md", after: ["/a.md"] },
    ];
    const bare = rooted.map(({ path, ...r }) => ({ path: path.slice(1), ...r }));
    expect(reciprocal(rooted, "before", "after")).toBe(true);
    expect(reciprocal(bare, "before", "after")).toBe(true);
    // A field whose values are rows-as-values (`{ id, path }`) references those documents.
    const nested = [
      { id: "d_1", path: "/a.md", before: [{ id: "d_2", path: "/b.md" }] },
      { id: "d_2", path: "/b.md", after: { id: "d_1", path: "a.md" } },
    ];
    expect(reciprocal(nested, "before", "after")).toBe(true);
    // The envelope is not a frontmatter field.
    expect(pathValuedFields([{ id: "d_1", path: "/a.md", owner: "/c.md" }])).toEqual(["owner"]);
  });

  it("works without an AST (unparsable source) from rows alone", () => {
    expect(inferCandidates(null, [{ id: "x", path: "a.md", next: "/b.md" }]).map((c) => c.name)).toEqual(["next", "doc.out_links", "doc.in_links"]);
    expect(inferCandidates(null, []).map((c) => c.name)).toEqual(["doc.out_links", "doc.in_links"]);
  });
});

describe("inverse pairs (rule 5)", () => {
  const field = (name: string, direction: "forward" | "backward" = "forward") => ({ name, kind: "frontmatter" as const, defaults: { edge: false, layout: false, direction } });

  it("pairs the sequence vocabulary by name — before/after, prev/next, previous/next, predecessor/successor — and nothing else", () => {
    expect(detectPairs([field("before"), field("after", "backward"), field("owner")])).toEqual([{ forward: "before", backward: "after", by: "name" }]);
    expect(detectPairs([field("next"), field("prev")])).toEqual([{ forward: "next", backward: "prev", by: "name" }]);
    expect(detectPairs([field("previous"), field("next")])).toEqual([{ forward: "next", backward: "previous", by: "name" }]);
    expect(detectPairs([field("successor"), field("predecessor")])).toEqual([{ forward: "successor", backward: "predecessor", by: "name" }]);
    // A tree is not a sequence; one end alone is not a pair; a field never pairs with itself.
    expect(detectPairs([field("parent"), field("children")])).toEqual([]);
    expect(detectPairs([field("before"), field("owner")])).toEqual([]);
    expect(detectPairs([field("after")])).toEqual([]);
    // Only frontmatter fields pair: the link graph (`doc.out_links`/`doc.in_links`), sequences and dotted paths never do.
    expect(detectPairs([{ ...field("before"), kind: "sequence" }, field("after")])).toEqual([]);
    expect(detectPairs([field("meta.before"), field("after")])).toEqual([]);
  });

  it("names the pair in the vocabulary's order whichever field is forward", () => {
    expect(pairName({ forward: "before", backward: "after" })).toBe("before/after");
    expect(pairName({ forward: "next", backward: "prev" })).toBe("prev/next");
    expect(pairName({ forward: "successor", backward: "predecessor" })).toBe("predecessor/successor");
    expect(pairName({ forward: "leads_to", backward: "comes_from" })).toBe("leads_to/comes_from");
  });

  it("pairs two fields whose rows reciprocate (A.x ∋ B and B.y ∋ A), the backward word as the backward end", () => {
    const rows = [
      { id: "1", path: "/a.md", leads_to: ["/b.md"] },
      { id: "2", path: "/b.md", comes_from: "/a.md", leads_to: ["/c.md"] },
      { id: "3", path: "/c.md", comes_from: "/b.md" },
    ];
    expect(reciprocal(rows, "leads_to", "comes_from")).toBe(true);
    expect(detectPairs([field("leads_to"), field("comes_from")], rows)).toEqual([{ forward: "leads_to", backward: "comes_from", by: "data" }]);
    // The vocabulary decides which end is which when it can.
    expect(detectPairs([field("x"), field("depends_on", "backward")], [{ id: "1", path: "/a.md", x: ["/b.md"] }, { id: "2", path: "/b.md", depends_on: "/a.md" }]))
      .toEqual([{ forward: "x", backward: "depends_on", by: "data" }]);
    // Bare and rooted paths reciprocate alike.
    expect(reciprocal([{ id: "1", path: "a.md", x: ["/b.md"] }, { id: "2", path: "b.md", y: ["/a.md"] }], "x", "y")).toBe(true);
  });

  it("finds no false pairs: parallel relations, one-way references, symmetric fields, unknown targets", () => {
    // `owner` and `see_also` both point from a to b: two relations the same way, not inverses.
    const parallel = [{ id: "1", path: "/a.md", owner: "/b.md", see_also: ["/b.md"] }, { id: "2", path: "/b.md" }];
    expect(reciprocal(parallel, "owner", "see_also")).toBe(false);
    expect(detectPairs([field("owner"), field("see_also")], parallel)).toEqual([]);
    // One-way: a → b under x, nothing back.
    expect(reciprocal([{ id: "1", path: "/a.md", x: "/b.md" }, { id: "2", path: "/b.md" }], "x", "y")).toBe(false);
    // A row naming the same document under both fields is a contradiction even when another row reciprocates.
    const mixed = [{ id: "1", path: "/a.md", x: ["/b.md"], y: ["/b.md"] }, { id: "2", path: "/b.md", y: ["/a.md"] }];
    expect(reciprocal(mixed, "x", "y")).toBe(false);
    // The target is not among the rows: nothing to confirm with.
    expect(reciprocal([{ id: "1", path: "/a.md", x: "/zz.md" }], "x", "y")).toBe(false);
    // No rows: only the vocabulary pairs.
    expect(detectPairs([field("leads_to"), field("comes_from")], [])).toEqual([]);
    // Each field is in at most one pair: a name pair is not re-paired by data.
    const rows = [{ id: "1", path: "/a.md", before: ["/b.md"], then: ["/b.md"] }, { id: "2", path: "/b.md", after: ["/a.md"] }];
    expect(detectPairs([field("before"), field("after", "backward"), field("then")], rows)).toEqual([{ forward: "before", backward: "after", by: "name" }]);
  });

  it("builds the combined candidate: sequence kind, source pair, inserted before its first member, the axis, undrawn members", () => {
    const rows = [{ id: "1", path: "/a.md", after: ["/b.md"], owner: "/p.md" }, { id: "2", path: "/b.md", before: ["/a.md"] }];
    const c = inferCandidates(parse(`path, owner, after, before from docs`), rows);
    // Inferred fields come in first-seen row order (`after`, `owner`, `before`); the pair sits just before its first member.
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before/after", "sequence", ["pair"], true, true],
      ["after", "frontmatter", ["inferred"], false, false],
      ["owner", "frontmatter", ["inferred"], true, false],
      ["before", "frontmatter", ["inferred"], false, false],
      ["doc.out_links", "links", ["builtin"], false, false],
      ["doc.in_links", "backlinks", ["builtin"], false, false],
    ]);
    expect(c[0]!.pair).toEqual({ forward: "before", backward: "after", by: "name" });
    // A repository authoring only `after` still gets the pair when the query names both ends (the sample starter).
    const onlyAfter = inferCandidates(parse(`path, before, after from docs where path == "/a.md" follow distinct refs(before), in_links collect { from doc where ^path in list(after) }`), [{ id: "1", path: "/a.md", after: ["/b.md"] }]);
    expect(onlyAfter.map((x) => [x.name, x.defaults.layout])).toEqual([["before/after", true], ["before", false], ["after", false]]);
    // The pair takes the axis even ahead of another follow destination.
    expect(inferCandidates(parse(`path from docs follow out_links collect { from dst }, refs(before), refs(after)`), []).map((x) => [x.name, x.defaults.layout, x.defaults.edge]))
      .toEqual([["out_links", false, true], ["before/after", true, true], ["before", false, false], ["after", false, false]]);
  });
});

describe("pathValuedFields", () => {
  it("accepts root paths, relative paths and lists; rejects metadata, mixed lists and non-paths", () => {
    expect(pathValuedFields([{ id: "a", path: "x.md", $depth: 1, a: "/a.md", b: "dir/b.md", c: ["/a.md", "b.md"], d: ["/a.md", 3], e: "hello", f: [] }]))
      .toEqual(["a", "b", "c"]);
  });
});

describe("refsField / relationKind", () => {
  it("accepts refs(field) and refs(^field) only", () => {
    const expr = (src: string) => parse(`select x: ${src} from docs`).select[0]!.kind === "field" ? (parse(`select x: ${src} from docs`).select[0] as { expr: import("@omgbase/oqx").Expr }).expr : null!;
    expect(refsField(expr("refs(before)"))).toEqual({ name: "before", outer: false });
    expect(refsField(expr("refs(^before)"))).toEqual({ name: "before", outer: true });
    for (const src of ["refs($it)", "refs(path)", "refs(\"/a.md\")", "refs(before, after)", "size(before)", "before.refs()", "before"]) {
      expect(refsField(expr(src)), src).toBeNull();
    }
  });

  it("names the link graph in its spellings", () => {
    expect(["out_links", "doc.out_links", "$it.out_links", "$it.doc.out_links"].map(relationKind)).toEqual(["links", "links", "links", "links"]);
    expect(["in_links", "doc.in_links", "$it.in_links"].map(relationKind)).toEqual(["backlinks", "backlinks", "backlinks"]);
    expect(["before", "owner", "meta.rel"].map(relationKind)).toEqual(["frontmatter", "frontmatter", "frontmatter"]);
  });
});
