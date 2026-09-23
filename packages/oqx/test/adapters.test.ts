import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, run, IndexedCollection, PlannedEngine, DefaultContext } from "../src/index.ts";
import type { DataContext } from "../src/index.ts";
import { coerceCollection } from "../src/semantics.ts";

// A shared dataset for the tier-2 / tier-3 tests.
const employees = [
  { id: 1, name: "Bob", dept: "eng", level: 5, city: "NYC" },
  { id: 2, name: "Alice", dept: "eng", level: 7, city: "SF" },
  { id: 3, name: "Carol", dept: "sales", level: 4, city: "NYC" },
  { id: 4, name: "Dave", dept: "eng", level: 3, city: "SF" },
];

// ---- tier 2: a custom DataContext (lazy graph navigation) -------------------

test("tier 2: a custom DataContext resolves relations its own way", () => {
  // Nodes stored by id; `children` is a relation resolved by id lookup, not a
  // stored array — the engine only sees it through the context.
  const nodes = new Map<number, { id: number; label: string; childIds: number[] }>([
    [1, { id: 1, label: "root", childIds: [2, 3] }],
    [2, { id: 2, label: "a", childIds: [4] }],
    [3, { id: 3, label: "b", childIds: [] }],
    [4, { id: 4, label: "a1", childIds: [] }],
  ]);
  const graph: DataContext = {
    root: (name) => (name === "tree" ? [nodes.get(1)] : undefined),
    get: (row, key) => {
      if (key === "children") return ((row as { childIds?: number[] }).childIds ?? []).map((i) => nodes.get(i));
      return (row as Record<string, unknown>)?.[key];
    },
    // `children` is a computed relation, not a stored key. Since a bare name is
    // read from the current row only (via `get`), nothing else is needed for the
    // engine to see it.
    toRows: (v) => coerceCollection(v),
    identity: (row) => (row as { id: number }).id,
  };
  const res = run(parse("id: id, depth: $depth from tree follow children order by $depth, id"), { context: graph });
  assert.deepEqual(res, {
    consumer: "collect",
    rows: [{ id: 1, depth: 1 }, { id: 2, depth: 2 }, { id: 3, depth: 2 }, { id: 4, depth: 3 }],
  });
});

// ---- tier 3: the indexed optimizing planner ---------------------------------

test("tier 3: IndexedCollection answers an equality from the index (not a scan)", () => {
  const idx = new IndexedCollection("emp", employees, ["dept", "city"]);
  // Direct plan inspection: only the eng rows are produced (index probe), and
  // the equality predicate is fully consumed (no residual where).
  const plan = idx.plan(parse("name from emp where dept == \"eng\""), []);
  assert.ok(plan, "planner should handle an indexed equality");
  assert.deepEqual([...plan!.rows()].map((r) => (r as { id: number }).id), [1, 2, 4]);
  assert.equal(plan!.residual.where, null);
});

test("tier 3: PlannedEngine finishes the residual over the reduced rows", () => {
  const idx = new IndexedCollection("emp", employees, ["dept"]);
  const engine = new PlannedEngine(idx);
  // `dept == "eng"` is pushed to the index; `level >= 5` is residual (in-memory).
  const res = engine.run(parse("name from emp where dept == \"eng\" && level >= 5 order by name"), []);
  assert.equal(res.consumer, "collect");
  assert.deepEqual((res as { rows: Array<{ name: string }> }).rows.map((r) => r.name), ["Alice", "Bob"]);
});

test("tier 3: planner declines a query it can't optimize (fallback stays correct)", () => {
  const idx = new IndexedCollection("emp", employees, ["dept"]);
  const engine = new PlannedEngine(idx, new DefaultContext({ emp: employees }));
  // No indexed equality → planner returns null → in-memory fallback over roots.
  const res = engine.run(parse("name from emp where level >= 5 order by name"), []);
  assert.deepEqual((res as { rows: Array<{ name: string }> }).rows.map((r) => r.name), ["Alice", "Bob"]);
});

test("tier 3: indexed planner agrees with the naive in-memory engine", () => {
  const q = parse("name, dept from emp where city == \"NYC\" order by name");
  const naive = run(q, { roots: { emp: employees } });
  const planned = new PlannedEngine(new IndexedCollection("emp", employees, ["city"])).run(q, []);
  assert.deepEqual(planned, naive);
});
