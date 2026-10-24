import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { BUILTIN_BACKLINKS, BUILTIN_LINKS, STRUCTURAL_RELATIONS, detectPairs, inferCandidates, linkRowsReceiver, pairName, pathValuedFields, reciprocal, refsField, relationKind } from "../src/lib/candidates.ts";
import { NAMES_4 } from "../src/lib/paths.ts";

const TIMELINE = `docs {
  select _path, _title, before, after
  where _path == "/timeline/kickoff.md"
  follow ^docs { after.contains(^_path) }
  order by $ordinal
}`;

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
    const q = parse(`docs { _path where _path == "a.md" follow ^docs { _path in ^before } }`);
    const c = inferCandidates(q, []);
    expect(c.map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    expect(c[0]!.defaults.layout).toBe(true);
  });

  it("reads `field` / `predicate` literals under _in_links / _out_links / ^links (spec/surface §1.1–§1.2)", () => {
    const q = parse(`docs { _path where _path == "a.md" follow ^docs { $it._in_links exists { _field == "before" && _path == ^^_path } } }`);
    expect(inferCandidates(q, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q2 = parse(`docs { _path where _path == "a.md" follow ^docs { $it._out_links exists { _predicate == "after" && _dst_path == ^^_path } } }`);
    expect(inferCandidates(q2, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const q3 = parse(`docs { _path where _path == "a.md" follow ^docs { $it._in_links exists { _field == "before" } } }`);
    expect(inferCandidates(q3, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q4 = parse(`docs { _path where _path == "a.md" follow ^docs { ^^links exists { _predicate == "owner" && _dst_path == ^^_path } } }`);
    expect(inferCandidates(q4, []).map((x) => [x.name, x.defaults.direction])).toEqual([["owner", "forward"]]);
    // A literal under something that is not the link rows names nothing.
    const q5 = parse(`docs { _path where _path == "a.md" follow ^docs { $it._blocks exists { _field == "x" } } }`);
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

  it("reads the link-graph walk through the link rows: `_out_links { from _dst }` → links, `_in_links { from _doc }` → backlinks, named by the receiver as written", () => {
    const c = inferCandidates(parse(`docs { _path where _path == "a.md" follow _out_links { from _dst } }`), []);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([["_out_links", "links", ["follow"], { edge: true, layout: true, direction: "forward" }]]);
    const b = inferCandidates(parse(`docs { _path where _path == "a.md" follow _in_links { from _doc depth 2 } }`), []);
    expect(b.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([["_in_links", "backlinks", ["follow"], { edge: true, layout: true, direction: "backward" }]]);
    // dotted receivers, `distinct`, several destinations, a filtered body — the receiver still names the relation
    const d = inferCandidates(parse(`docs { _path where _path == "a.md" follow distinct $it._out_links { from _dst where _provenance == "link" }, $it._in_links { from _doc }, refs(before) }`), []);
    expect(d.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([["$it._out_links", "links", "forward"], ["$it._in_links", "backlinks", "backward"], ["before", "frontmatter", "forward"]]);
    // a `field`/`predicate` literal in the body keeps the frontmatter-relation reading (beside the link-graph candidate)
    const f = inferCandidates(parse(`docs { _path where _path == "a.md" follow _out_links { from _dst where _field == "owner" } }`), []);
    expect(f.map((x) => [x.name, x.kind])).toEqual([["_out_links", "links"], ["owner", "frontmatter"]]);
    // with a follow there is no builtin pair
    expect(c.some((x) => x.sources.includes("builtin"))).toBe(false);
  });

  it("maps plain destinations: the link rows → links / backlinks, a bare name → frontmatter", () => {
    const c = inferCandidates(parse(`docs { _path where _path == "a.md" follow $it._out_links, $it._in_links, before }`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["$it._out_links", "links", "forward"],
      ["$it._in_links", "backlinks", "backward"],
      ["before", "frontmatter", "forward"],
    ]);
    // Every follow destination is drawn; the first one lays out.
    expect(c.map((x) => x.defaults.edge)).toEqual([true, true, true]);
    expect(c.map((x) => x.defaults.layout)).toEqual([true, false, false]);
  });

  it("turns a non-attribute order by key into a sequence candidate (`_path`/`_updated_at` are attributes, never keys)", () => {
    const c = inferCandidates(parse(`docs { _path, date order by date desc, _path, _updated_at }`), []);
    expect(c.map((x) => x.name)).toEqual(["date", "_out_links", "_in_links"]); // + the builtin links (no follow)
    expect(c[0]).toMatchObject({ name: "date", kind: "sequence", sources: ["order by"], defaults: { edge: false, layout: true, direction: "backward" } });
    expect(c.find((x) => x.name === "_out_links")!.defaults.edge).toBe(true); // nothing else is drawn
  });

  it("offers the builtin link graph when the query has no follow — the 4.x names: doc.out_links drawn only when nothing else is, never the axis", () => {
    const bare = inferCandidates(parse(`docs { select path, title order by updated_at desc limit 40 }`), [], NAMES_4);
    expect(bare.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([
      ["doc.out_links", "links", ["builtin"], { edge: true, layout: false, direction: "forward" }],
      ["doc.in_links", "backlinks", ["builtin"], { edge: false, layout: false, direction: "backward" }],
    ]);
    // With an inferred field the field is drawn and lays out; the links stay offered, undrawn.
    const withField = inferCandidates(parse(`docs { path, before }`), [{ id: "d_1", path: "/a.md", before: ["/b.md"] }], NAMES_4);
    expect(withField.map((x) => [x.name, x.defaults.edge, x.defaults.layout])).toEqual([["before", true, true], ["doc.out_links", false, false], ["doc.in_links", false, false]]);
    // With a follow there is no builtin pair; a link-graph walk is the follow candidate itself.
    expect(inferCandidates(parse(`docs { path follow refs(before) }`), []).map((x) => x.name)).toEqual(["before"]);
    expect(inferCandidates(parse(`docs { path follow out_links { from dst } }`), []).map((x) => [x.name, x.sources])).toEqual([["out_links", ["follow"]]]);
  });

  it("infers path-valued fields from rows, drawn only when the query has no follow", () => {
    const rows = [
      { _id: "d_1", _path: "/a.md", before: ["/b.md"], owner: "/people/ada.md", _title: "A" },
      { _id: "d_2", _path: "/b.md", before: [], after: ["/a.md"] },
    ];
    const c = inferCandidates(parse(`docs { _path, before, after, owner, _title }`), rows).filter((x) => !x.sources.includes("builtin") && !x.pair);
    expect(c.map((x) => x.name).sort()).toEqual(["after", "before", "owner"]);
    for (const x of c) expect(x.sources).toEqual(["inferred"]);
    // `before` and `after` form a pair (rule 5), which takes the drawn/axis defaults; the fields stay listed.
    expect(c.find((x) => x.name === "before")!.defaults).toEqual({ edge: false, layout: false, direction: "forward" });
    expect(c.find((x) => x.name === "after")!.defaults.direction).toBe("backward");
    expect(c.find((x) => x.name === "owner")!.defaults.layout).toBe(false);
    // Without the inverse, the single field is drawn and lays out as before.
    const single = inferCandidates(parse(`docs { _path, before, owner }`), rows.map(({ after: _after, ...r }) => r)).filter((x) => !x.sources.includes("builtin"));
    expect(single.find((x) => x.name === "before")!.defaults).toEqual({ edge: true, layout: true, direction: "forward" });
  });

  it("merges the same name from follow and rows and keeps follow's roles", () => {
    const rows = [{ _id: "d_1", _path: "/a.md", after: ["/b.md"], owner: "/c.md" }];
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
    const src = `docs { _path where _path == "a.md" follow refs(before) }`;
    const c = inferCandidates(parse(src), []);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: "before", kind: "frontmatter", sources: ["follow"], defaults: { edge: true, layout: true, direction: "forward" } });
    expect(src.slice(...c[0]!.spans[0]!)).toBe("refs(before)");
  });

  it("reads `refs(^field)` and a `refs(field) { … }` destination block the same way", () => {
    expect(inferCandidates(parse(`docs { _path follow refs(^before) }`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const c = inferCandidates(parse(`docs { _path follow refs(before) { phase != "x" } }`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.sources])).toEqual([["before", "frontmatter", "forward", ["follow"]]]);
  });

  it("walks both ways with refs(before), refs(after): the pair is drawn and lays out, the fields stay listed undrawn", () => {
    const c = inferCandidates(parse(`docs { _path follow refs(before), refs(after) }`), []);
    expect(c.map((x) => [x.name, x.defaults.edge, x.defaults.layout, x.defaults.direction])).toEqual([
      ["before/after", true, true, "forward"],
      ["before", false, false, "forward"],
      ["after", false, false, "forward"],
    ]);
    // `refs(after)` walks the strings forward, but the pair still flips `after` edges: it is the field's meaning, not the walk's.
    expect(c[0]!.pair).toEqual({ forward: "before", backward: "after", by: "name" });
    // Two unrelated walks: no pair, the old rule.
    const two = inferCandidates(parse(`docs { _path follow refs(owner), refs(see_also) }`), []);
    expect(two.map((x) => [x.name, x.defaults.edge, x.defaults.layout])).toEqual([["owner", true, true], ["see_also", true, false]]);
  });

  it("reads a refs() receiver inside a destination block's where: the candidate row's field points backward, an outer one forward", () => {
    const back = parse(`docs { _path follow ^docs { refs(after) exists { _path == ^^_path } } }`);
    expect(inferCandidates(back, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const fwd = parse(`docs { _path follow ^docs { refs(^before) exists { _path == ^_path } } }`);
    expect(inferCandidates(fwd, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
  });

  it("reads the natural timeline query: refs(before) forward and the backlink block's `after` backward", () => {
    const src = `docs {
  select _path, _title, phase, before, after
  where _path == "/timeline/kickoff.md"
  follow distinct refs(before), _in_links { from _doc where ^_path in list(after) }
  order by $ordinal
}`;
    const c = inferCandidates(parse(src), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before/after", "sequence", "forward", true, true],
      ["before", "frontmatter", "forward", false, false],
      ["after", "frontmatter", "backward", false, false],
    ]);
    expect(src.slice(...c[2]!.spans[0]!)).toBe("^_path in list(after)");
    // Hovering the pair lights both fields: its spans are the members'.
    expect(c[0]!.spans).toEqual([...c[1]!.spans, ...c[2]!.spans]);
    expect(c[0]!.sources).toEqual(["pair"]);
    // `$ordinal` is recursion metadata, not a sequence candidate (the pair is the only sequence-kinded one).
    expect(c.some((x) => x.kind === "sequence" && !x.pair)).toBe(false);
    // The backlink block correlates the reached document with the frontier (`^_path in list(after)`), so the walk MEANS `after`:
    // the whole backlink graph (`_in_links`) is not offered beside it.
    expect(c.map((x) => x.name)).toEqual(["before/after", "before", "after"]);
    expect(inferCandidates(parse(`docs { _path follow _in_links { from _doc where phase == "x" } }`), []).map((x) => x.name)).toEqual(["_in_links"]); // an uncorrelated filter keeps the walk
  });

  it("reads the correlation idiom in its spellings — a membership test, a contains(), a nested refs() — without mistaking an attribute for a field", () => {
    for (const follow of [`^docs { after.contains(^_path) }`, `_in_links { from _doc where ^_path in list(after) }`, `^docs { refs(after) exists { _path == ^^_path } }`]) {
      const cands = inferCandidates(parse(`docs { _path where _path == "/a.md" follow ${follow} }`), []).filter((x) => x.kind === "frontmatter");
      expect(cands.map((x) => [x.name, x.defaults.direction]), follow).toEqual([["after", "backward"]]);
    }
    expect(inferCandidates(parse(`docs { _path where _path == "/a.md" follow ^docs { _path in ^before } }`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
  });

  it("maps the 4.x spellings — $it.in_links / doc.out_links / in_links / out_links — to backlinks and links, named as written", () => {
    const c = inferCandidates(parse(`docs { path follow $it.in_links, out_links, doc.in_links, $it.out_links }`), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["$it.in_links", "backlinks", "backward"],
      ["out_links", "links", "forward"],
      ["doc.in_links", "backlinks", "backward"],
      ["$it.out_links", "links", "forward"],
    ]);
  });

  it("merges refs(before) with the inferred before from the rows", () => {
    const rows = [{ _id: "d_1", _path: "/a.md", before: ["/b.md"] }];
    const c = inferCandidates(parse(`docs { _path, before follow refs(before) }`), rows);
    expect(c).toHaveLength(1);
    expect(c[0]!.sources).toEqual(["follow", "inferred"]);
  });

  it("reads a hit's _path through the envelope (`_id`/`_path`, rooted or bare)", () => {
    const rooted = [
      { _id: "d_1", _path: "/a.md", before: ["/b.md"] },
      { _id: "d_2", _path: "/b.md", after: ["/a.md"] },
    ];
    const bare = rooted.map(({ _path, ...r }) => ({ _path: _path.slice(1), ...r }));
    expect(reciprocal(rooted, "before", "after")).toBe(true);
    expect(reciprocal(bare, "before", "after")).toBe(true);
    // A field whose values are rows-as-values (`{ _id, _path }`) references those documents.
    const nested = [
      { _id: "d_1", _path: "/a.md", before: [{ _id: "d_2", _path: "/b.md" }] },
      { _id: "d_2", _path: "/b.md", after: { _id: "d_1", _path: "a.md" } },
    ];
    expect(reciprocal(nested, "before", "after")).toBe(true);
    // The envelope is not a frontmatter field.
    expect(pathValuedFields([{ _id: "d_1", _path: "/a.md", owner: "/c.md" }])).toEqual(["owner"]);
  });

  it("works without an AST (unparsable source) from rows alone", () => {
    expect(inferCandidates(null, [{ _id: "x", _path: "a.md", next: "/b.md" }]).map((c) => c.name)).toEqual(["next", "_out_links", "_in_links"]);
    expect(inferCandidates(null, []).map((c) => c.name)).toEqual(["_out_links", "_in_links"]);
    // The builtins follow the server's names (a 4.x server: the link rows under the document's self alias).
    expect(inferCandidates(null, [{ id: "x", path: "a.md", next: "/b.md" }], NAMES_4).map((c) => c.name)).toEqual(["next", "doc.out_links", "doc.in_links"]);
    expect(inferCandidates(null, [], NAMES_4).map((c) => c.name)).toEqual(["doc.out_links", "doc.in_links"]);
  });
});

describe("inferCandidates — the surface 5.0 names (underscore = engine)", () => {
  it("names the builtin link graph `_out_links` / `_in_links` by default (the document's relations; `$it` is the self, a bare `doc` an authored key)", () => {
    expect(BUILTIN_LINKS).toBe("_out_links");
    expect(BUILTIN_BACKLINKS).toBe("_in_links");
    const bare = inferCandidates(parse(`docs { select _path, _title order by _updated_at desc limit 40 }`), []);
    expect(bare.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([
      ["_out_links", "links", ["builtin"], { edge: true, layout: false, direction: "forward" }],
      ["_in_links", "backlinks", ["builtin"], { edge: false, layout: false, direction: "backward" }],
    ]);
    // `_updated_at`/`_path` are engine attributes, never sequence keys; a bare `date` is.
    const c = inferCandidates(parse(`docs { _path, date order by date desc, _path, _updated_at }`), []);
    expect(c.map((x) => x.name)).toEqual(["date", "_out_links", "_in_links"]);
  });

  it("reads the link-graph walk in the 5.0 spelling: `_out_links { from _dst }`, `_in_links { from _doc }`, `$it._out_links`", () => {
    const c = inferCandidates(parse(`docs { _path where _path == "a.md" follow _out_links { from _dst } }`), []);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults])).toEqual([["_out_links", "links", ["follow"], { edge: true, layout: true, direction: "forward" }]]);
    const b = inferCandidates(parse(`docs { _path where _path == "a.md" follow _in_links { from _doc depth 2 } }`), []);
    expect(b.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([["_in_links", "backlinks", "backward"]]);
    const d = inferCandidates(parse(`docs { _path follow $it._in_links, _out_links, $it._out_links, before }`), []);
    expect(d.map((x) => [x.name, x.kind, x.defaults.direction])).toEqual([
      ["$it._in_links", "backlinks", "backward"], ["_out_links", "links", "forward"], ["$it._out_links", "links", "forward"], ["before", "frontmatter", "forward"],
    ]);
    expect(["_out_links", "$it._out_links"].map(relationKind)).toEqual(["links", "links"]);
    expect(["_in_links", "$it._in_links"].map(relationKind)).toEqual(["backlinks", "backlinks"]);
    expect(linkRowsReceiver("$it._in_links")).toBe("in");
    expect(linkRowsReceiver("_out_links")).toBe("out");
    for (const r of ["_in_links", "_out_links", "_dst", "_doc", "_children", "_subsections", "_block"]) expect(STRUCTURAL_RELATIONS.has(r), r).toBe(true);
  });

  it("reads `_field` / `_predicate` literals under `_in_links` / `_out_links` / `^links`", () => {
    const q = parse(`docs { _path where _path == "a.md" follow ^docs { _in_links exists { _field == "before" && _path == ^^_path } } }`);
    expect(inferCandidates(q, []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    const q2 = parse(`docs { _path where _path == "a.md" follow ^docs { $it._out_links exists { _predicate == "after" && _dst_path == ^^_path } } }`);
    expect(inferCandidates(q2, []).map((x) => [x.name, x.defaults.direction])).toEqual([["after", "backward"]]);
    const f = inferCandidates(parse(`docs { _path where _path == "a.md" follow _out_links { from _dst where _field == "owner" } }`), []);
    expect(f.map((x) => [x.name, x.kind])).toEqual([["_out_links", "links"], ["owner", "frontmatter"]]);
  });

  it("reads the natural timeline query in the 5.0 spelling: refs(before) forward and the backlink block's `after` backward, the walk meaning `after`", () => {
    const src = `docs {
  select _path, _title, phase, before, after
  where _path == "/timeline/kickoff.md"
  follow distinct refs(before), _in_links { from _doc where ^_path in list(after) }
  order by $ordinal
}`;
    const c = inferCandidates(parse(src), []);
    expect(c.map((x) => [x.name, x.kind, x.defaults.direction, x.defaults.edge, x.defaults.layout])).toEqual([
      ["before/after", "sequence", "forward", true, true],
      ["before", "frontmatter", "forward", false, false],
      ["after", "frontmatter", "backward", false, false],
    ]);
    expect(src.slice(...c[2]!.spans[0]!)).toBe("^_path in list(after)");
    for (const follow of [`^docs { after.contains(^_path) }`, `_in_links { from _doc where ^_path in list(after) }`, `^docs { refs(after) exists { _path == ^^_path } }`]) {
      const cands = inferCandidates(parse(`docs { _path where _path == "/a.md" follow ${follow} }`), []).filter((x) => x.kind === "frontmatter");
      expect(cands.map((x) => [x.name, x.defaults.direction]), follow).toEqual([["after", "backward"]]);
    }
    expect(inferCandidates(parse(`docs { _path where _path == "/a.md" follow ^docs { _path in ^before } }`), []).map((x) => [x.name, x.defaults.direction])).toEqual([["before", "forward"]]);
    expect(inferCandidates(parse(`docs { _path follow _in_links { from _doc where phase == "x" } }`), []).map((x) => x.name)).toEqual(["_in_links"]);
  });

  it("reads a hit's _path through the 5.0 envelope (`_id`/`_path`) and rows-as-values", () => {
    const rows = [
      { _id: "d_1", _path: "/a.md", before: [{ _id: "d_2", _path: "/b.md" }] },
      { _id: "d_2", _path: "/b.md", after: { _id: "d_1", _path: "a.md" } },
    ];
    expect(reciprocal(rows, "before", "after")).toBe(true);
    expect(pathValuedFields([{ _id: "d_1", _path: "/a.md", owner: "/c.md" }])).toEqual(["owner"]);
    expect(refsField((parse(`docs { select x: refs(_path) }`).select[0] as { expr: import("@omgbase/oqx").Expr }).expr)).toBeNull();
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
    // Only frontmatter fields pair: the link graph (`$it._out_links`/`$it._in_links`), sequences and dotted paths never do.
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
      { _id: "1", _path: "/a.md", leads_to: ["/b.md"] },
      { _id: "2", _path: "/b.md", comes_from: "/a.md", leads_to: ["/c.md"] },
      { _id: "3", _path: "/c.md", comes_from: "/b.md" },
    ];
    expect(reciprocal(rows, "leads_to", "comes_from")).toBe(true);
    expect(detectPairs([field("leads_to"), field("comes_from")], rows)).toEqual([{ forward: "leads_to", backward: "comes_from", by: "data" }]);
    // The vocabulary decides which end is which when it can.
    expect(detectPairs([field("x"), field("depends_on", "backward")], [{ _id: "1", _path: "/a.md", x: ["/b.md"] }, { _id: "2", _path: "/b.md", depends_on: "/a.md" }]))
      .toEqual([{ forward: "x", backward: "depends_on", by: "data" }]);
    // Bare and rooted paths reciprocate alike.
    expect(reciprocal([{ _id: "1", _path: "a.md", x: ["/b.md"] }, { _id: "2", _path: "b.md", y: ["/a.md"] }], "x", "y")).toBe(true);
  });

  it("finds no false pairs: parallel relations, one-way references, symmetric fields, unknown targets", () => {
    // `owner` and `see_also` both point from a to b: two relations the same way, not inverses.
    const parallel = [{ _id: "1", _path: "/a.md", owner: "/b.md", see_also: ["/b.md"] }, { _id: "2", _path: "/b.md" }];
    expect(reciprocal(parallel, "owner", "see_also")).toBe(false);
    expect(detectPairs([field("owner"), field("see_also")], parallel)).toEqual([]);
    // One-way: a → b under x, nothing back.
    expect(reciprocal([{ _id: "1", _path: "/a.md", x: "/b.md" }, { _id: "2", _path: "/b.md" }], "x", "y")).toBe(false);
    // A row naming the same document under both fields is a contradiction even when another row reciprocates.
    const mixed = [{ _id: "1", _path: "/a.md", x: ["/b.md"], y: ["/b.md"] }, { _id: "2", _path: "/b.md", y: ["/a.md"] }];
    expect(reciprocal(mixed, "x", "y")).toBe(false);
    // The target is not among the rows: nothing to confirm with.
    expect(reciprocal([{ _id: "1", _path: "/a.md", x: "/zz.md" }], "x", "y")).toBe(false);
    // No rows: only the vocabulary pairs.
    expect(detectPairs([field("leads_to"), field("comes_from")], [])).toEqual([]);
    // Each field is in at most one pair: a name pair is not re-paired by data.
    const rows = [{ _id: "1", _path: "/a.md", before: ["/b.md"], then: ["/b.md"] }, { _id: "2", _path: "/b.md", after: ["/a.md"] }];
    expect(detectPairs([field("before"), field("after", "backward"), field("then")], rows)).toEqual([{ forward: "before", backward: "after", by: "name" }]);
  });

  it("builds the combined candidate: sequence kind, source pair, inserted before its first member, the axis, undrawn members (the 4.x names, as the sample starter reads on a 4.x server)", () => {
    const rows = [{ id: "1", path: "/a.md", after: ["/b.md"], owner: "/p.md" }, { id: "2", path: "/b.md", before: ["/a.md"] }];
    const c = inferCandidates(parse(`docs { path, owner, after, before }`), rows, NAMES_4);
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
    const onlyAfter = inferCandidates(parse(`docs { path, before, after where path == "/a.md" follow distinct refs(before), in_links { from doc where ^path in list(after) } }`), [{ id: "1", path: "/a.md", after: ["/b.md"] }]);
    expect(onlyAfter.map((x) => [x.name, x.defaults.layout])).toEqual([["before/after", true], ["before", false], ["after", false]]);
    // The pair takes the axis even ahead of another follow destination.
    expect(inferCandidates(parse(`docs { path follow out_links { from dst }, refs(before), refs(after) }`), []).map((x) => [x.name, x.defaults.layout, x.defaults.edge]))
      .toEqual([["out_links", false, true], ["before/after", true, true], ["before", false, false], ["after", false, false]]);
  });
});

describe("pathValuedFields", () => {
  it("accepts root paths, relative paths and lists; rejects metadata, mixed lists and non-paths", () => {
    expect(pathValuedFields([{ _id: "a", _path: "x.md", $depth: 1, a: "/a.md", b: "dir/b.md", c: ["/a.md", "b.md"], d: ["/a.md", 3], e: "hello", f: [] }]))
      .toEqual(["a", "b", "c"]);
  });
});

describe("refsField / relationKind", () => {
  it("accepts refs(field) and refs(^field) only", () => {
    const expr = (src: string) => parse(`docs { select x: ${src} }`).select[0]!.kind === "field" ? (parse(`docs { select x: ${src} }`).select[0] as { expr: import("@omgbase/oqx").Expr }).expr : null!;
    expect(refsField(expr("refs(before)"))).toEqual({ name: "before", outer: false });
    expect(refsField(expr("refs(^before)"))).toEqual({ name: "before", outer: true });
    for (const src of ["refs($it)", "refs(_path)", "refs(\"/a.md\")", "refs(before, after)", "size(before)", "before.refs()", "before"]) {
      expect(refsField(expr(src)), src).toBeNull();
    }
  });

  it("names the link graph in its spellings", () => {
    expect(["out_links", "doc.out_links", "$it.out_links", "$it.doc.out_links"].map(relationKind)).toEqual(["links", "links", "links", "links"]);
    expect(["in_links", "doc.in_links", "$it.in_links"].map(relationKind)).toEqual(["backlinks", "backlinks", "backlinks"]);
    expect(["before", "owner", "meta.rel"].map(relationKind)).toEqual(["frontmatter", "frontmatter", "frontmatter"]);
  });
});

describe("nested bodies (rule 6) — OQX 0.26 allows `follow` in every body", () => {
  const brief = (c: ReturnType<typeof inferCandidates>) => c.map((x) => [x.name, x.kind, x.sources, x.defaults.direction, x.nested?.label ?? null]);

  it("reads the per-row reach metric: the nested `0^docs { where ^_path in list(after) }` walk names `after` backward, inside `reach` — listed, undrawn, never the axis; the builtins stay", () => {
    const src = `docs { select _path, _title, reach: ^docs count { where _path == ^_path follow distinct 0^docs { where ^_path in list(after) depth 4 } } }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)).toEqual([
      ["after", "frontmatter", ["nested"], "backward", "reach"],
      ["_out_links", "links", ["builtin"], "forward", null],
      ["_in_links", "backlinks", ["builtin"], "backward", null],
    ]);
    const after = c[0]!;
    expect(after.defaults).toEqual({ edge: false, layout: false, direction: "backward" });
    expect(after.spans.map((s) => src.slice(...s))).toEqual(["^_path in list(after)"]);
    // No top-level follow: the builtin link graph is offered as before and `_out_links` is still the one drawn; nothing is the axis.
    expect(c.map((x) => x.defaults.edge)).toEqual([false, true, false]);
    expect(c.some((x) => x.defaults.layout)).toBe(false);
  });

  it("reads the nested backlinks walk `n: _in_links count { follow _in_links { from _doc } }`: one `_in_links` candidate from the receiver and the walk, merged with the builtin", () => {
    const src = `docs { select _path, n: _in_links count { follow _in_links { from _doc } } }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)).toEqual([
      ["_in_links", "backlinks", ["nested", "builtin"], "backward", "n"],
      ["_out_links", "links", ["builtin"], "forward", null],
    ]);
    // the receiver and the destination are both mentions; the label is not repeated
    expect(c[0]!.spans.map((s) => src.slice(...s))).toEqual(["_in_links", "_in_links"]);
    expect(c[0]!.defaults).toEqual({ edge: false, layout: false, direction: "backward" });
    expect(c[1]!.defaults.edge).toBe(true);
  });

  it("reads a where-position lifting collect: the `before` walk inside `^docs { ^reach: _path … follow 0^docs { where _path in ^before } }` is forward, inside `where`", () => {
    const src = `docs { where ^docs { ^reach: _path where _path == "/x.md" follow distinct 0^docs { where _path in ^before depth 3 } } and _path in reach }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)[0]).toEqual(["before", "frontmatter", ["nested"], "forward", "where"]);
    expect(c[0]!.spans.map((s) => src.slice(...s))).toEqual(["_path in ^before"]);
    expect(c.map((x) => x.name)).toEqual(["before", "_out_links", "_in_links"]);
    // `^_path in list(before)` reads the same relation the other way round: the candidate's `before` names the frontier.
    const back = inferCandidates(parse(`docs { where ^docs { ^reach: _path where _path == "/x.md" follow 0^docs { where ^_path in list(before) } } and _path in reach }`), []);
    expect(brief(back)[0]).toEqual(["before", "frontmatter", ["nested"], "backward", "where"]);
    // A body that reads only the candidate's own properties (`_path in list(before)`: its path against its own list) correlates with
    // nothing, so it names no walk relation — the reader cannot classify it.
    const own = inferCandidates(parse(`docs { where ^docs { ^reach: _path where _path == "/x.md" follow 0^docs { where _path in list(before) } } and _path in reach }`), []);
    expect(own.map((x) => x.name)).toEqual(["_out_links", "_in_links"]);
  });

  it("reads a links walk nested in a select block whose receiver is the links relation: `desc: _out_links { from _dst follow _out_links { from _dst depth 2 } }` — one `_out_links`, still drawn by the builtin rule", () => {
    const src = `docs { select _path, desc: _out_links { from _dst follow _out_links { from _dst depth 2 } } }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)).toEqual([
      ["_out_links", "links", ["nested", "builtin"], "forward", "desc"],
      ["_in_links", "backlinks", ["builtin"], "backward", null],
    ]);
    expect(c[0]!.spans.map((s) => src.slice(...s))).toEqual(["_out_links", "_out_links"]);
    expect(c[0]!.defaults).toEqual({ edge: true, layout: false, direction: "forward" });
  });

  it("reads the receiver of a nested directive with no follow when it names a relationship: `n: _in_links count`, `where refs(after) exists { … }`, a correlated root block", () => {
    const count = inferCandidates(parse(`docs { select _path, n: _in_links count }`), []);
    expect(brief(count)).toEqual([
      ["_in_links", "backlinks", ["nested", "builtin"], "backward", "n"],
      ["_out_links", "links", ["builtin"], "forward", null],
    ]);
    const src = `docs { where refs(after) exists { _path == "/x.md" } }`;
    const refs = inferCandidates(parse(src), []);
    expect(brief(refs)[0]).toEqual(["after", "frontmatter", ["nested"], "forward", "where"]);
    expect(refs[0]!.spans.map((s) => src.slice(...s))).toEqual(["refs(after)"]);
    expect(refs[0]!.defaults).toEqual({ edge: false, layout: false, direction: "forward" });
    // `^docs exists { after.contains(^_path) }` in where position: the other document's `after` names this row — backward.
    const root = inferCandidates(parse(`docs { where ^docs exists { after.contains(^_path) } }`), []);
    expect(brief(root)[0]).toEqual(["after", "frontmatter", ["nested"], "backward", "where"]);
    // in a select item the alias is the label; `refs(after)` is the row's own field, forward
    const sel = inferCandidates(parse(`docs { select _path, a: refs(after) collect { _title } }`), []);
    expect(brief(sel)[0]).toEqual(["after", "frontmatter", ["nested"], "forward", "a"]);
    // a flatten block over the link rows: the receiver names the links, a `_field` literal the relation, both inside `flatten`
    const flat = inferCandidates(parse(`docs { select _path flatten _out_links { where _field == "owner" } as l }`), []);
    expect(brief(flat)).toEqual([
      ["_out_links", "links", ["nested", "builtin"], "forward", "flatten"],
      ["owner", "frontmatter", ["nested"], "backward", "flatten"],
      ["_in_links", "backlinks", ["builtin"], "backward", null],
    ]);
  });

  it("keeps the top-level defaults when the same relation is also mentioned nested, and unions the sources", () => {
    const src = `docs { select _path, n: _in_links count { follow _in_links { from _doc } } follow _in_links { from _doc } }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)).toEqual([["_in_links", "backlinks", ["follow", "nested"], "backward", "n"]]);
    expect(c[0]!.defaults).toEqual({ edge: true, layout: true, direction: "backward" });
    expect(c[0]!.spans).toHaveLength(3);
    // with a top-level follow there is no builtin pair, nested walks or not
    expect(c.some((x) => x.sources.includes("builtin"))).toBe(false);
    // a nested mention in two places lists both
    const two = inferCandidates(parse(`docs { select _path, n: _in_links count where _in_links exists { _field == "x" } }`), []);
    expect(two.find((x) => x.name === "_in_links")!.nested).toEqual({ label: "n, where" });
  });

  it("yields no candidate for a nested body over a non-relation receiver: a list field, entries(), rows, a plain name, an uncorrelated structural walk", () => {
    const only = ["_out_links", "_in_links"];
    expect(inferCandidates(parse(`docs { select _path, t: tags count, e: entries(meta) collect { key }, j: jobs collect { where x == 1 } }`), []).map((x) => x.name)).toEqual(only);
    expect(inferCandidates(parse(`docs { select phase, n: rows count { where x == 1 } group by phase }`), []).map((x) => x.name)).toEqual(only);
    expect(inferCandidates(parse(`docs { select _path, j: jobs collect { follow $it._blocks { where kind == "x" } } }`), []).map((x) => x.name)).toEqual(only);
    // a nested root block whose where does not correlate with the enclosing row names nothing either
    expect(inferCandidates(parse(`docs { select _path, n: 0^docs count { where phase == "x" } }`), []).map((x) => x.name)).toEqual(only);
  });

  it("reads outer references by their levels relative to the block: `0^docs` / `^^docs` are the root, `^_path` the frontier, `1^_path` from a depth-3 block an enclosing row (no walk relation)", () => {
    const src = `docs { select _path, r: ^docs count { where 1^_path == _path follow ^^docs { where ^_path in list(after) and 1^_path in list(see_also) } } }`;
    const c = inferCandidates(parse(src), []);
    expect(brief(c)).toEqual([
      ["after", "frontmatter", ["nested"], "backward", "r"],
      ["_out_links", "links", ["builtin"], "forward", null],
      ["_in_links", "backlinks", ["builtin"], "backward", null],
    ]);
    expect(c[0]!.spans.map((s) => src.slice(...s))).toEqual(["^_path in list(after)"]);
    // the same walk spelled with the absolute root and the frontier's own field: forward
    const fwd = inferCandidates(parse(`docs { select _path, r: ^docs count { where _path == ^_path follow 0^docs { where _path in ^before } } }`), []);
    expect(brief(fwd)[0]).toEqual(["before", "frontmatter", ["nested"], "forward", "r"]);
    // `^^links` / `0^links` from a block are the link rows; a `_predicate` literal under them names the relation
    const links = inferCandidates(parse(`docs { select _path, r: ^docs count { where 0^links exists { _predicate == "owner" && _dst_path == ^_path } } }`), []);
    expect(brief(links)[0]).toEqual(["owner", "frontmatter", ["nested"], "forward", "r"]);
  });
});

describe("projected relationships (rule 7)", () => {
  // oqx 0.27: a select alias is visible to `follow`, so the relationship may exist only in the query.
  const PROJECTED = `docs {
    select _path, calls: ^docs { select target values where origin == ^_path }
    where _path == "/a.md"
    follow refs(calls)
  }`;

  it("marks a relationship named by a select alias as projected, still drawn and still the axis", () => {
    const c = inferCandidates(parse(PROJECTED), []).find((x) => x.name === "calls")!;
    expect(c.kind).toBe("frontmatter");
    expect(c.sources).toEqual(["follow"]);
    expect(c.projected).toBe(true);
    expect(c.defaults.edge).toBe(true);
    expect(c.defaults.layout).toBe(true);
  });

  it("also marks it when the rows surface it as paths (the inferred mention merges into the same candidate)", () => {
    const rows = [{ _path: "/a.md", calls: ["/b.md"] }, { _path: "/b.md", calls: [] }];
    const calls = inferCandidates(parse(PROJECTED), rows).filter((x) => x.name === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projected).toBe(true);
    expect(calls[0]!.sources).toEqual(expect.arrayContaining(["follow", "inferred"]));
  });

  it("does not mark a bare read of a stored field, or a field the query never aliases", () => {
    const stored = inferCandidates(parse(`docs { select _path, before where _path == "/a.md" follow refs(before) }`), []);
    expect(stored.find((x) => x.name === "before")!.projected).toBeUndefined();
    const rows = [{ _path: "/a.md", before: ["/b.md"] }];
    expect(inferCandidates(parse(`docs { select _path, before }`), rows).every((x) => !x.projected)).toBe(true);
  });
});
