// Planner-level tests for the spec/surface §1 decline (c): when a residual
// conjunct could raise an OQX eval error, the whole query runs unplanned (the
// pushed conjuncts must not hide the error by emptying the scan). The store is
// empty — only the plan/decline decision is under test here; the differential
// (corpus/surface, corpus/oqx/conformance) proves the results agree.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse, build } from "@omgbase/oqx";
import type { Where } from "@omgbase/oqx";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { SQLiteQueryPlanner, residualMayRaise } from "./planner.js";

let store: Store;
let planner: SQLiteQueryPlanner;
beforeAll(() => {
  store = new Store({ path: ":memory:" });
  planner = new SQLiteQueryPlanner(store, ensureRepo(store, "planner"));
});
afterAll(() => store.close());

const planned = (q: string): boolean => planner.plan(parse(q), []) !== null;

describe("planner — decline (c): a residual that could raise sends the whole query unplanned", () => {
  it("a bare attribute is never a raise (3.0: no loud-error set) — `path` pushes, `raw`/`updated_at` are plain residuals", () => {
    expect(planned('from docs where _path == "x" && _path == "nope.md"')).toBe(true);
    expect(planned('from docs where _path == "nope.md" && _raw')).toBe(true);
    expect(planned('from docs where _path == "nope.md" && _updated_at')).toBe(true);
    expect(planned('from docs where _path == "nope.md" && _tags')).toBe(true);
  });

  it("`doc.<attribute>` on any target, at any depth, is a plain read too", () => {
    expect(planned('from blocks where _doc._path == "x" && _path == "nope.md"')).toBe(true);
    expect(planned('from docs where _path == "nope.md" && _nodes exists { where _doc._path == "x" }')).toBe(true);
  });

  it("a key read through a source handle is pushed (3.0: data/frontmatter/inline), the whole handle is residual", () => {
    expect(planned('from docs where _data.layer == "canon"')).toBe(true);
    expect(planned('from docs where _frontmatter.layer == "canon" && _inline.element == "fire"')).toBe(true);
    expect(planned('from blocks where _doc._inline.element == "fire"')).toBe(true);
    expect(planned('from docs where _frontmatter == null && _path == "x"')).toBe(true); // the whole handle is a declined conjunct (residual), not a raise
  });

  it("a method or function call in the residual (bad regex, unknown function, domain fn)", () => {
    expect(planned('from docs where _path.matches("[") && _path == "nope.md"')).toBe(false);
    expect(planned('from docs where nope("x") && _path == "nope.md"')).toBe(false);
    expect(planned('from docs where text("x") && _path == "nope.md"')).toBe(false);
    expect(planned('from docs where _path == "nope.md" && _nodes exists { where text("x") }')).toBe(false);
    expect(planned('from docs where _path == "nope.md" && _nodes count { order by _name.lower() } > 0')).toBe(false);
  });

  it("a `^`-escaped name in the residual (outer reference or lift)", () => {
    expect(planned('from docs where ^x == 1 && _path == "nope.md"')).toBe(false);
    expect(planned('from docs where _path == "nope.md" && _nodes exists { where _value == ^slug }')).toBe(false);
    expect(planned('from docs where _path == "nope.md" && _nodes collect { ^open: _value where _kind == "md:task" }')).toBe(false);
  });

  it("a nested block with the `single` consumer (only reachable in select position)", () => {
    const w: Where = build.op(build.ident("_nodes"), "exists", build.subquery({
      select: [build.collect("s", build.op(build.ident("_blocks"), "single"))],
    }));
    expect(residualMayRaise(w, "docs")).toBe(true);
    expect(residualMayRaise({ ...w, sub: { ...w.sub, select: [] } }, "docs")).toBe(false);
  });

  it("a residual of comparisons, logic, in/ranges, !, literals, bindings and plain reads keeps the push", () => {
    expect(planned('from docs where _path == "index.md" && era in 800..1000')).toBe(true);
    expect(planned('from docs where _path == "index.md" && !verified')).toBe(true);
    expect(planned('from docs where _path == "index.md" && (era == 800 || verified == true)')).toBe(true);
    expect(planned('from docs where _path == "index.md" && _nodes exists { where _kind == "md:task" && !checked }')).toBe(true);
    expect(planned('from docs where _path == "index.md" && _nodes count { where _kind == "md:section" } > 1')).toBe(true);
    expect(planned('from blocks where _path == "index.md" && checked == true')).toBe(true);
    expect(planned('from blocks where _path == "index.md" && _nodes exists { where _id == "x" }')).toBe(true); // `id` is not reserved inside a nodes block
  });

  it("a body-level `frontier` (oqx 0.20) plans like the `follow` it needs: unplanned, in memory", () => {
    expect(planned('from docs where _path == "index.md" frontier type == "hub" follow distinct _out_links collect { from _dst }')).toBe(false);
    expect(planned('from docs where _path == "index.md" frontier type == "hub" follow distinct _out_links collect { from _dst frontier type == "practitioner" }')).toBe(false);
  });

  it("no pushable conjunct at all → unplanned (as before)", () => {
    expect(planned('from docs where era == stages')).toBe(false); // prop × prop
    expect(planned('from blocks where _ordinal == checked')).toBe(false); // int × json
    expect(planned('from docs')).toBe(false);
  });

  it("residualMayRaise on a null residual is false", () => {
    expect(residualMayRaise(null, "docs")).toBe(false);
  });
});

// spec/surface 1.2 patch: bool/num literals against json/prop reads are TYPED
// pushes, so the queries the `planned-typed-*` fixtures run plan on their own
// (before the patch every one of these was residual → unplanned).
describe("planner — typed pushes (1.2): a bool or num literal against a json or prop read plans", () => {
  it("the query-blocks::planned-typed-* fixtures", () => {
    expect(planned('select _path, checked from blocks where checked == true')).toBe(true);
    expect(planned('blocks count { where checked != true }')).toBe(true);
    expect(planned('select _path, level from blocks where level >= 2')).toBe(true);
    expect(planned('blocks count { where level != 2 }')).toBe(true);
  });

  it("the query-docs::planned-typed-* fixtures", () => {
    expect(planned('select _path, verified from docs where verified == true')).toBe(true);
    expect(planned('select _path, era from docs where era >= 800')).toBe(true);
    expect(planned('docs count { where era != 800 }')).toBe(true);
  });

  it("the same cells against a binding, and through `doc.<k>` / `attrs.<k>`", () => {
    // `parse` has no template form; swap the literal for a `{kind:"binding"}` leaf as the tagged template would.
    const bound = (q: string, value: unknown): boolean => {
      const query = parse(q);
      const w = query.where;
      if (w?.kind !== "scalar" || w.expr.kind !== "binary") throw new Error("expected one comparison");
      w.expr.right = build.binding(0);
      return planner.plan(query, [value]) !== null;
    };
    expect(bound("from blocks where checked == false", false)).toBe(true);
    expect(bound("from docs where era < 1000", 1000)).toBe(true);
    expect(bound("from docs where era == 1000", "1000")).toBe(true); // a text binding pushes plainly (IS-typed)
    expect(bound("from docs where era < 1000", "1000")).toBe(false); // text × prop relational stays declined
    expect(bound("from blocks where checked == false", [1])).toBe(false); // a non-scalar binding declines
    expect(planned('from blocks where _doc.verified == true && _attrs.level > 1')).toBe(true);
  });

  it("the still-declined cells stay unplanned", () => {
    expect(planned('from blocks where checked == _ordinal')).toBe(false);
    expect(planned('from blocks where _attrs.level == _attrs.checked')).toBe(false);
    expect(planned('from docs where true == 1')).toBe(false);
    expect(planned('from docs where _tags != null')).toBe(false);
    expect(planned('from blocks where level < "x"')).toBe(false);
  });
});
