// Planner-level tests for the spec/surface §1 decline (c): when a residual
// conjunct could raise an OQX eval error, the whole query runs unplanned (the
// pushed conjuncts must not hide the error by emptying the scan). The store is
// empty — only the plan/decline decision is under test here; the differential
// (corpus/surface, corpus/oqx/conformance) proves the results agree.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse } from "@omgbase/oqx";
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
  it("a bare reserved docs basename in the residual", () => {
    expect(planned('from docs where path == "x" && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && body')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && updated_at')).toBe(false);
  });

  it("`doc.<reserved>` on any target, at any depth", () => {
    expect(planned('from blocks where doc.path == "x" && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && nodes exists { where doc.path == "x" }')).toBe(false);
  });

  it("a method or function call in the residual (bad regex, unknown function, domain fn)", () => {
    expect(planned('from docs where $path.matches("[") && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where nope("x") && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where text("x") && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && nodes exists { where text("x") }')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && nodes count { order by name.lower() } > 0')).toBe(false);
  });

  it("a `^`-escaped name in the residual (outer reference or lift)", () => {
    expect(planned('from docs where ^x == 1 && $path == "nope.md"')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && nodes exists { where value == ^slug }')).toBe(false);
    expect(planned('from docs where $path == "nope.md" && nodes collect { ^open: value where kind == "md:task" }')).toBe(false);
  });

  it("a nested block with the `single` consumer (only reachable in select position)", () => {
    const w: Where = {
      kind: "op",
      receiver: { kind: "ident", name: "nodes" },
      op: "exists",
      sub: { from: [], where: null, orderBy: null, follow: null, select: [{ kind: "collect", name: "s", op: { kind: "op", receiver: { kind: "ident", name: "blocks" }, op: "single", sub: { from: [], where: null, select: [], orderBy: null, follow: null } } }] },
    };
    expect(residualMayRaise(w, "docs")).toBe(true);
    expect(residualMayRaise({ ...w, sub: { ...w.sub, select: [] } }, "docs")).toBe(false);
  });

  it("a residual of comparisons, logic, in/ranges, !, literals, bindings and plain reads keeps the push", () => {
    expect(planned('from docs where $path == "index.md" && era in 800..1000')).toBe(true);
    expect(planned('from docs where $path == "index.md" && !verified')).toBe(true);
    expect(planned('from docs where $path == "index.md" && (era == 800 || verified == true)')).toBe(true);
    expect(planned('from docs where $path == "index.md" && nodes exists { where kind == "md:task" && !checked }')).toBe(true);
    expect(planned('from docs where $path == "index.md" && nodes count { where kind == "md:section" } > 1')).toBe(true);
    expect(planned('from blocks where $path == "index.md" && checked == true')).toBe(true);
    expect(planned('from blocks where $path == "index.md" && nodes exists { where id == "x" }')).toBe(true); // `id` is not reserved inside a nodes block
  });

  it("no pushable conjunct at all → unplanned (as before)", () => {
    expect(planned('from docs where era == stages')).toBe(false); // prop × prop
    expect(planned('from blocks where $ordinal == checked')).toBe(false); // int × json
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
    expect(planned('select $path, checked from blocks where checked == true')).toBe(true);
    expect(planned('$repo.blocks count { where checked != true }')).toBe(true);
    expect(planned('select $path, level from blocks where level >= 2')).toBe(true);
    expect(planned('$repo.blocks count { where level != 2 }')).toBe(true);
  });

  it("the query-docs::planned-typed-* fixtures", () => {
    expect(planned('select $path, verified from docs where verified == true')).toBe(true);
    expect(planned('select $path, era from docs where era >= 800')).toBe(true);
    expect(planned('$repo.docs count { where era != 800 }')).toBe(true);
  });

  it("the same cells against a binding, and through `doc.<k>` / `attrs.<k>`", () => {
    // `parse` has no template form; swap the literal for a `{kind:"binding"}` leaf as the tagged template would.
    const bound = (q: string, value: unknown): boolean => {
      const query = parse(q);
      const w = query.where;
      if (w?.kind !== "scalar" || w.expr.kind !== "binary") throw new Error("expected one comparison");
      w.expr.right = { kind: "binding", index: 0 };
      return planner.plan(query, [value]) !== null;
    };
    expect(bound("from blocks where checked == false", false)).toBe(true);
    expect(bound("from docs where era < 1000", 1000)).toBe(true);
    expect(bound("from docs where era == 1000", "1000")).toBe(true); // a text binding pushes plainly (IS-typed)
    expect(bound("from docs where era < 1000", "1000")).toBe(false); // text × prop relational stays declined
    expect(bound("from blocks where checked == false", [1])).toBe(false); // a non-scalar binding declines
    expect(planned('from blocks where doc.verified == true && attrs.level > 1')).toBe(true);
  });

  it("the still-declined cells stay unplanned", () => {
    expect(planned('from blocks where checked == $ordinal')).toBe(false);
    expect(planned('from blocks where attrs.level == attrs.checked')).toBe(false);
    expect(planned('from docs where true == 1')).toBe(false);
    expect(planned('from docs where tags != null')).toBe(false);
    expect(planned('from blocks where level < "x"')).toBe(false);
  });
});
