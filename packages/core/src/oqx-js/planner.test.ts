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
    expect(planned('from docs where era == 800')).toBe(false);
    expect(planned('from blocks where checked == 1')).toBe(false);
    expect(planned('from docs')).toBe(false);
  });

  it("residualMayRaise on a null residual is false", () => {
    expect(residualMayRaise(null, "docs")).toBe(false);
  });
});
