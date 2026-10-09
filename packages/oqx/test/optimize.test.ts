// The optimizer (src/optimize): every rule is checked two ways — the optimized
// engine must produce exactly the naive engine's result or error, AND the trace
// must show the rule actually fired (or, for the fallbacks, that it did not).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, run, InMemoryEngine, DefaultContext, IndexedCollection, PlannedEngine, OqxError } from "../src/index.ts";
import type { Query, TraceEvent, OqxResult, DataContext } from "../src/index.ts";
import { parseTemplate } from "../src/parser.ts";

// ---- harness ------------------------------------------------------------------

type Outcome = { ok: true; value: unknown } | { ok: false; stage: string; message: string };

function unwrap(r: OqxResult): unknown {
  switch (r.consumer) {
    case "collect": return r.rows;
    case "exists": return r.exists;
    case "none": return r.none;
    case "count": return r.count;
    case "first": case "single": return r.row;
  }
}

function outcome(f: () => OqxResult): Outcome {
  try {
    return { ok: true, value: unwrap(f()) };
  } catch (e) {
    if (e instanceof OqxError) return { ok: false, stage: e.stage, message: e.message };
    throw e;
  }
}

/** Run `q` naive and optimized over `ctx`; assert identical outcomes; return the
 * optimized outcome plus the optimizer's trace. */
function both(q: Query | string, ctx: DataContext | Record<string, unknown>, values: unknown[] = []): Outcome & { events: TraceEvent[] } {
  const query = typeof q === "string" ? parse(q) : q;
  const context = isContext(ctx) ? ctx : new DefaultContext(ctx);
  const events: TraceEvent[] = [];
  const naive = outcome(() => new InMemoryEngine(context, { rules: [] }).run(query, values));
  const optimized = outcome(() => new InMemoryEngine(context, { trace: (e) => events.push(e) }).run(query, values));
  assert.deepEqual(optimized, naive, `optimized ≠ naive for ${typeof q === "string" ? q : "<query>"}`);
  return { ...optimized, events };
}

function isContext(x: DataContext | Record<string, unknown>): x is DataContext {
  return typeof (x as DataContext).toRows === "function" && typeof (x as DataContext).root === "function";
}

function value(o: Outcome): unknown {
  assert.ok(o.ok, `expected a result, got error: ${o.ok ? "" : o.message}`);
  return o.value;
}

function count(events: TraceEvent[], kind: TraceEvent["kind"]): number {
  return events.filter((e) => e.kind === kind).length;
}

// ---- data ---------------------------------------------------------------------

const customers = [
  { id: 1, name: "Ann", region: "west" },
  { id: 2, name: "Bob", region: "east" },
  { id: 3, name: "Cy", region: "west" },
];
const orders = [
  { id: 10, customer_id: 1, total: 5, region: "west" },
  { id: 11, customer_id: 2, total: 7, region: "east" },
  { id: 12, customer_id: 1, total: 9, region: "east" },
  { id: 13, customer_id: 9, total: 1, region: "west" }, // no such customer
];
const roots = { customers, orders };

// ---- the four motivating queries ------------------------------------------------

test("zip one-to-one: first { … where id == ^customer_id }", () => {
  const r = both('select id, total, customer: ^customers first { where id == ^customer_id } from orders', roots);
  assert.deepEqual(value(r), [
    { id: 10, total: 5, customer: { id: 1, name: "Ann", region: "west" } },
    { id: 11, total: 7, customer: { id: 2, name: "Bob", region: "east" } },
    { id: 12, total: 9, customer: { id: 1, name: "Ann", region: "west" } },
    { id: 13, total: 1, customer: null },
  ]);
  assert.equal(count(r.events, "index"), 1, "one index per collection+path per run");
  assert.equal(count(r.events, "probe"), 4, "one probe per outer row");
});

test("zip via bindings: ${customers} first { name values where id == ^customer_id } from ${orders}", () => {
  const q = parseTemplate(["select id, name: ", " first { name values where id == ^customer_id } from ", ""], 2);
  const r = both(q, {}, [customers, orders]);
  assert.deepEqual(value(r), [{ id: 10, name: "Ann" }, { id: 11, name: "Bob" }, { id: 12, name: "Ann" }, { id: 13, name: null }]);
  assert.equal(count(r.events, "probe"), 4);
});

test("one-to-many: collect { id, total where customer_id == ^id }", () => {
  const r = both('select name, orders: ^orders collect { id, total where customer_id == ^id } from customers', roots);
  assert.deepEqual(value(r), [
    { name: "Ann", orders: [{ id: 10, total: 5 }, { id: 12, total: 9 }] },
    { name: "Bob", orders: [{ id: 11, total: 7 }] },
    { name: "Cy", orders: [] },
  ]);
  assert.equal(count(r.events, "probe"), 3);
});

test("semi-join: where ^customers exists { where id == ^customer_id }", () => {
  const r = both('select id from orders where ^customers exists { where id == ^customer_id }', roots);
  assert.deepEqual(value(r), [{ id: 10 }, { id: 11 }, { id: 12 }]);
  // no residual predicate → answered from the bucket's cardinality
  assert.equal(count(r.events, "cardinality"), 4);
});

// ---- every consumer, both positions ----------------------------------------------

test("select position: first / single / collect, values, distinct, order by + limit inside the block", () => {
  const r1 = both('select name, last: ^orders first { id values where customer_id == ^id order by total desc } from customers', roots);
  assert.deepEqual(value(r1), [{ name: "Ann", last: 12 }, { name: "Bob", last: 11 }, { name: "Cy", last: null }]);

  const r2 = both('select name, one: ^orders single { total values where customer_id == ^id && total > 6 } from customers', roots);
  assert.deepEqual(value(r2), [{ name: "Ann", one: 9 }, { name: "Bob", one: 7 }, { name: "Cy", one: null }]);

  const r3 = both('select name, regions: ^orders collect distinct { region values where customer_id == ^id } from customers', roots);
  assert.deepEqual(value(r3), [{ name: "Ann", regions: ["west", "east"] }, { name: "Bob", regions: ["east"] }, { name: "Cy", regions: [] }]);

  const r4 = both('select name, top: ^orders collect { id values where customer_id == ^id order by total desc limit 1 } from customers', roots);
  assert.deepEqual(value(r4), [{ name: "Ann", top: [12] }, { name: "Bob", top: [11] }, { name: "Cy", top: [] }]);

  const r5 = both('select name, rows: ^orders collect { where customer_id == ^id offset 1 } from customers', roots);
  assert.deepEqual(value(r5), [{ name: "Ann", rows: [orders[2]] }, { name: "Bob", rows: [] }, { name: "Cy", rows: [] }]);

  for (const r of [r1, r2, r3, r4, r5]) assert.ok(count(r.events, "probe") >= 2, "the probe fired");
});

test("where position: exists / none / count (with and without a comparison) / collect with lifts", () => {
  const r1 = both('select name from customers where ^orders exists { where customer_id == ^id }', roots);
  assert.deepEqual(value(r1), [{ name: "Ann" }, { name: "Bob" }]);

  const r2 = both('select name from customers where ^orders none { where customer_id == ^id }', roots);
  assert.deepEqual(value(r2), [{ name: "Cy" }]);

  const r3 = both('select name from customers where ^orders count { where customer_id == ^id } >= 2', roots);
  assert.deepEqual(value(r3), [{ name: "Ann" }]);

  const r4 = both('select name from customers where ^orders count { where customer_id == ^id }', roots);
  assert.deepEqual(value(r4), [{ name: "Ann" }, { name: "Bob" }]);

  // a where-position collect binds its lifts from the probed bucket
  const r5 = both('select name, totals from customers where ^orders collect { ^totals: total where customer_id == ^id }', roots);
  assert.deepEqual(value(r5), [{ name: "Ann", totals: [5, 9] }, { name: "Bob", totals: [7] }]);
  assert.ok(count(r5.events, "probe") >= 2);
});

test("exists / none with a bound are answered from the bounded cardinality", () => {
  const r = both('select name from customers where ^orders exists { where customer_id == ^id offset 1 }', roots);
  assert.deepEqual(value(r), [{ name: "Ann" }]);
  assert.equal(count(r.events, "cardinality"), 3);
  const r2 = both('select name from customers where ^orders none { where customer_id == ^id limit 0 }', roots);
  assert.deepEqual(value(r2), [{ name: "Ann" }, { name: "Bob" }, { name: "Cy" }]);
});

// ---- multiple equalities and residuals ----------------------------------------------

test("two correlated equalities intersect their buckets; a residual conjunct filters the bucket", () => {
  const r = both('select name, same: ^orders collect { id values where customer_id == ^id && region == ^region } from customers', roots);
  assert.deepEqual(value(r), [{ name: "Ann", same: [10] }, { name: "Bob", same: [11] }, { name: "Cy", same: [] }]);
  const probe = r.events.find((e) => e.kind === "probe");
  assert.ok(probe && probe.kind === "probe" && probe.paths.length === 2, "both equalities probed");
  assert.equal(count(r.events, "index"), 2, "one index per path");

  const r2 = both('select name, big: ^orders collect { id values where customer_id == ^id && total > 6 } from customers', roots);
  assert.deepEqual(value(r2), [{ name: "Ann", big: [12] }, { name: "Bob", big: [7].map(() => 11) }, { name: "Cy", big: [] }]);

  // equality after a raise-free conjunct is still hoisted; the constant side may be a literal or arithmetic
  const r3 = both('select name, x: ^orders collect { id values where total > 1 && customer_id == ^id - 0 } from customers', roots);
  assert.deepEqual(value(r3), [{ name: "Ann", x: [10, 12] }, { name: "Bob", x: [11] }, { name: "Cy", x: [] }]);
  assert.ok(count(r3.events, "probe") >= 2);

  // a bare equality against a literal is a (constant) correlation too
  const r4 = both('select name, w: ^orders collect { id values where region == "west" } from customers', roots);
  assert.deepEqual(value(r4), [{ name: "Ann", w: [10, 13] }, { name: "Bob", w: [10, 13] }, { name: "Cy", w: [10, 13] }]);
});

test("member chains on the row and $value are local paths", () => {
  const items = [{ meta: { k: 1 }, v: "a" }, { meta: { k: 2 }, v: "b" }, { v: "c" }];
  const keys = [{ k: 1 }, { k: 2 }, { k: 3 }];
  const r = both('select k, v: ^items first { v values where meta.k == ^k } from keys', { items, keys });
  assert.deepEqual(value(r), [{ k: 1, v: "a" }, { k: 2, v: "b" }, { k: 3, v: null }]);
  const r2 = both('select k from keys where ^ids exists { where $value == ^k }', { ids: [2, 3, 3], keys });
  assert.deepEqual(value(r2), [{ k: 2 }, { k: 3 }]);
  assert.ok(count(r2.events, "probe") >= 2);
});

// ---- the sound rule: errors keep their place -----------------------------------------

const BAD = { ...roots, lonely: [{ id: 3, name: "Cy" }] };

test("a raising conjunct LEFT of the equality blocks the hoist, so the error still surfaces", () => {
  const r = both('select name from customers where ^orders exists { where nope(total) && customer_id == ^id }', BAD);
  assert.deepEqual(r, { ok: false, stage: "eval", message: "unknown function 'nope(…)'", events: r.events });
  assert.equal(count(r.events, "probe"), 0, "not hoisted");
  // …and for an outer row whose bucket would be EMPTY the scan still raises (the orphan customer has orders to scan)
  const r2 = both('select name from lonely where ^orders exists { where nope(total) && customer_id == ^id }', BAD);
  assert.equal(r2.ok, false);
  assert.equal(count(r2.events, "probe"), 0);
  // a directive left of the equality that could raise (a call inside it) likewise
  const r3 = both('select name from lonely where ^orders exists { where ^^customers count { where nope(name) } > 0 && customer_id == ^id }', BAD);
  assert.deepEqual(r3.ok ? null : r3.message, "unknown function 'nope(…)'");
  assert.equal(count(r3.events, "probe"), 0);
  // …while a raise-free directive left of it does not block the hoist
  const r3b = both('select name from lonely where ^orders exists { where ^^customers exists { where region == "west" } && customer_id == ^id }', BAD);
  assert.deepEqual(value(r3b), []);
  assert.equal(count(r3b.events, "probe"), 1);
  // a lift inside the where likewise (a lift is a side effect a skipped row would have performed)
  const r4 = both('select name from customers where ^orders exists { where ^^customers collect { ^^^seen: name } && customer_id == ^id }', BAD);
  assert.equal(count(r4.events, "probe"), 0);
});

test("a raising conjunct RIGHT of the equality is evaluated only over the bucket — raising iff the scan would", () => {
  // Ann has orders → the residual raises on her first bucket row, as the scan does on that same row.
  const r = both('select name from customers where ^orders exists { where customer_id == ^id && nope(total) }', BAD);
  assert.deepEqual(r.ok ? null : r.message, "unknown function 'nope(…)'");
  // Cy has none → the scan rejects every order at the equality and never reaches nope(); so does the probe.
  const r2 = both('select name from lonely where ^orders exists { where customer_id == ^id && nope(total) }', BAD);
  assert.deepEqual(value(r2), []);
  assert.equal(count(r2.events, "probe"), 1);
  // ranges in a result and `single` over several rows raise identically from the bucket
  const r3 = both('select name, r: ^orders first { x: 1..2 where customer_id == ^id } from customers', BAD);
  assert.equal(r3.ok ? null : r3.message, "a range (lo..hi) cannot appear in a result; test membership with `x in lo..hi` instead");
  const r4 = both('select name, r: ^orders single { where customer_id == ^id } from customers', BAD);
  assert.equal(r4.ok ? null : r4.message, "single { … } for 'receiver' matched 2 rows");
});

test("the outer side must be raise-free: a call or an out-of-range binding is not hoisted", () => {
  const r = both('select name from customers where ^orders exists { where customer_id == nope(^id) }', BAD);
  assert.equal(r.ok ? null : r.message, "unknown function 'nope(…)'");
  assert.equal(count(r.events, "probe"), 0);
  const q = parseTemplate(["select name from customers where ^orders exists { where customer_id == ", " }"], 1);
  const r2 = both(q, BAD, []); // fewer values than referenced
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.message.includes("out of range"));
  assert.equal(count(r2.events, "probe"), 0);
});

test("an invalid bound inside the block raises before any access, both ways", () => {
  const r = both('select name, o: ^orders first { where customer_id == ^id limit ^missing } from customers', BAD);
  assert.ok(!r.ok && r.message.includes("limit must be a non-negative integer"));
  assert.equal(count(r.events, "probe"), 0, "the bound raised before any access");
});

// ---- equality is §5 equality ---------------------------------------------------------

test("hash keys reproduce strict equality: NaN matches nothing, -0 is 0, absent is null, objects by reference", () => {
  const o = { tag: "same" };
  const keys = [{ k: NaN }, { k: -0 }, { k: null }, {}, { k: o }, { k: { tag: "same" } }, { k: "1" }, { k: 1 }, { k: true }];
  const items = [
    { k: NaN, v: "nan" }, { k: 0, v: "zero" }, { k: null, v: "null" }, { v: "absent" },
    { k: o, v: "ref" }, { k: "1", v: "str" }, { k: 1, v: "num" }, { k: true, v: "bool" },
  ];
  const r = both('select hits: ^items collect { v values where k == ^k } from keys', { items, keys });
  assert.deepEqual(value(r), [
    { hits: [] },                 // NaN
    { hits: ["zero"] },           // -0 == 0
    { hits: ["null", "absent"] }, // null ≡ absent
    { hits: ["null", "absent"] }, // absent ≡ null
    { hits: ["ref"] },            // same reference
    { hits: [] },                 // structurally equal, different object
    { hits: ["str"] },
    { hits: ["num"] },
    { hits: ["bool"] },
  ]);
  assert.ok(count(r.events, "probe") >= 8);
});

test("entries as rows: $value and member paths key by the entry's value", () => {
  const dict = { a: { id: 1 }, b: { id: 2 } };
  const keys = [{ id: 2 }, { id: 1 }, { id: 3 }];
  const r = both('select id, key: entries(^dict) first { $key values where id == ^id } from keys', { dict, keys });
  assert.deepEqual(value(r), [{ id: 2, key: "b" }, { id: 1, key: "a" }, { id: 3, key: null }]);
});

// ---- receiver stability -------------------------------------------------------------

test("a receiver that varies per outer row is never indexed; one that is the same object is", () => {
  const shared = [{ cid: 1, t: 1 }, { cid: 2, t: 2 }, { cid: 1, t: 3 }];
  const varying = [
    { id: 1, lines: [{ cid: 1, t: 1 }, { cid: 2, t: 9 }] },
    { id: 2, lines: [{ cid: 2, t: 2 }] },
    { id: 1, lines: [{ cid: 1, t: 3 }] },
  ];
  const r = both('select id, mine: lines collect { t values where cid == ^id } from varying', { varying });
  assert.deepEqual(value(r), [{ id: 1, mine: [1] }, { id: 2, mine: [2] }, { id: 1, mine: [3] }]);
  assert.equal(count(r.events, "index"), 0, "a fresh array per row is never indexed");
  assert.equal(count(r.events, "probe"), 0);

  const sharing = [{ id: 1, lines: shared }, { id: 2, lines: shared }, { id: 1, lines: shared }];
  const r2 = both('select id, mine: lines collect { t values where cid == ^id } from sharing', { sharing });
  assert.deepEqual(value(r2), [{ id: 1, mine: [1, 3] }, { id: 2, mine: [2] }, { id: 1, mine: [1, 3] }]);
  assert.equal(count(r2.events, "index"), 1, "the same array seen twice is indexed once");
  assert.equal(count(r2.events, "probe"), 2, "probed from the second sight on");

  // a scalar receiver coerces to one row; a statically stable one is still probed (a one-row index is harmless)
  const r3 = both('select id from varying where ^one exists { where $value == ^id }', { varying, one: 1 });
  assert.deepEqual(value(r3), [{ id: 1 }, { id: 1 }]);
  assert.equal(count(r3.events, "index"), 1);
  // …while a per-row scalar receiver is never a collection to index
  const r4 = both('select id from varying where id exists { where $value == ^id }', { varying });
  assert.deepEqual(value(r4), [{ id: 1 }, { id: 2 }, { id: 1 }]);
  assert.equal(count(r4.events, "probe"), 0);
  assert.ok(r4.events.some((e) => e.kind === "fallback" && e.reason === "not-a-collection"));
});

test("a context whose root() yields a fresh array each call is still indexed when the receiver is statically stable", () => {
  let served = 0;
  const ctx: DataContext = {
    ...new DefaultContext(),
    root: (name) => (name === "orders" ? (served++, orders.map((o) => ({ ...o }))) : name === "customers" ? customers : undefined),
    get: (row, key) => (row as Record<string, unknown>)?.[key],
    toRows: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    identity: (row) => row,
  };
  const r = both('select name, n: ^orders collect { id values where customer_id == ^id } from customers', ctx);
  assert.deepEqual(value(r), [{ name: "Ann", n: [10, 12] }, { name: "Bob", n: [11] }, { name: "Cy", n: [] }]);
  assert.equal(count(r.events, "index"), 1);
  assert.equal(count(r.events, "probe"), 3);
});

test("a context whose get() throws while the index is built falls back to the scan (and the scan's error)", () => {
  const strict: DataContext = {
    root: (name) => (roots as Record<string, unknown>)[name],
    get: (row, key) => {
      if (key === "customer_id" && (row as { id: number }).id === 12) throw new OqxError("row 12 is sealed", "eval");
      return (row as Record<string, unknown>)?.[key];
    },
    toRows: (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    identity: (row) => row,
    callFunction: (n, a) => new DefaultContext().callFunction(n, a),
    callMethod: (n, r, a) => new DefaultContext().callMethod(n, r, a),
  };
  const r = both('select name from customers where ^orders exists { where customer_id == ^id }', strict);
  assert.equal(r.ok ? null : r.message, "row 12 is sealed"); // the scan reaches row 12 for Ann? no — Ann matches at row 10; Bob matches at 11; Cy scans to 12 and throws
  assert.equal(count(r.events, "probe"), 0);
  assert.ok(r.events.some((e) => e.kind === "fallback" && e.reason === "index"));
});

// ---- IndexedCollection / the indexFor seam -----------------------------------------------

test("IndexedCollection.context(): the engine reuses the pre-built index instead of building one", () => {
  const idx = new IndexedCollection("orders", orders, ["customer_id"]);
  const r = both('select name, o: ^orders collect { id values where customer_id == ^id } from customers', idx.context({ customers }));
  assert.deepEqual(value(r), [{ name: "Ann", o: [10, 12] }, { name: "Bob", o: [11] }, { name: "Cy", o: [] }]);
  const built = r.events.filter((e) => e.kind === "index");
  assert.deepEqual(built, [{ kind: "index", path: ["customer_id"], rows: 4, source: "context" }]);
  // a path the collection did not index is built by the engine
  const r2 = both('select name, o: ^orders collect { id values where region == ^region } from customers', idx.context({ customers }));
  assert.deepEqual(value(r2), [{ name: "Ann", o: [10, 13] }, { name: "Bob", o: [11, 12] }, { name: "Cy", o: [10, 13] }]);
  assert.deepEqual(r2.events.filter((e) => e.kind === "index"), [{ kind: "index", path: ["region"], rows: 4, source: "engine" }]);
});

test("IndexedCollection keys under §5 equality (absent ≡ null; NaN matches nothing) and agrees with the scan", () => {
  const rows = [{ id: 1, tag: null }, { id: 2 }, { id: 3, tag: "x" }, { id: 4, tag: NaN }];
  const idx = new IndexedCollection("t", rows, ["tag"]);
  const planned = new PlannedEngine(idx, idx.context());
  for (const src of ["id from t where tag == null", "id from t where tag == \"x\"", "id from t where tag == 7"]) {
    const q = parse(src);
    assert.deepEqual(planned.run(q, []), run(q, { roots: { t: rows } }), src);
  }
  const nan = parseTemplate(["id from t where tag == ", ""], 1);
  assert.deepEqual(planned.run(nan, [NaN]), { consumer: "collect", rows: [] });
  // the plan's residual context still resolves the collection's own root for nested blocks
  const q = parse('id, twin: ^t first { id values where tag == ^tag && id != ^id } from t where tag == null');
  assert.deepEqual(planned.run(q, []), run(q, { roots: { t: rows } }));
});

// ---- invariant blocks ----------------------------------------------------------------------

test("a nested block that reads nothing from the enclosing rows is evaluated once per run", () => {
  const r = both('select name, all: ^customers collect { name values } from customers', roots);
  assert.deepEqual(value(r), [
    { name: "Ann", all: ["Ann", "Bob", "Cy"] }, { name: "Bob", all: ["Ann", "Bob", "Cy"] }, { name: "Cy", all: ["Ann", "Bob", "Cy"] },
  ]);
  assert.equal(count(r.events, "memo"), 2, "three rows: one evaluation, two memo hits");

  // where position, with a constant correlation (probe and memo both apply; memo wins after the first row)
  const r2 = both('select id from orders where ^customers exists { where region == "east" }', roots);
  assert.deepEqual(value(r2), [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }]);
  assert.equal(count(r2.events, "memo"), 3);

  // `^^name` from a doubly nested block reaches the root → invariant there too
  const r3 = both('select name, o: ^orders collect { id, n: ^^customers first { name values } where customer_id == ^id } from customers', roots);
  assert.deepEqual(value(r3), [
    { name: "Ann", o: [{ id: 10, n: "Ann" }, { id: 12, n: "Ann" }] }, { name: "Bob", o: [{ id: 11, n: "Ann" }] }, { name: "Cy", o: [] },
  ]);
  assert.equal(count(r3.events, "memo"), 2);
});

test("a block that reads an enclosing row, or lifts into one, is not memoized", () => {
  const r = both('select name, totals from customers where ^orders collect { ^totals: total }', roots);
  assert.deepEqual(value(r), [
    { name: "Ann", totals: [5, 7, 9, 1] }, { name: "Bob", totals: [5, 7, 9, 1] }, { name: "Cy", totals: [5, 7, 9, 1] },
  ]);
  assert.equal(count(r.events, "memo"), 0, "lifts are side effects on the enclosing scope: re-run per row");

  const r2 = both('select name, mine: ^orders collect { id values where customer_id == ^id } from customers', roots);
  assert.equal(count(r2.events, "memo"), 0);

  // a nested block reading the intermediate row through `^` (depth 1 from depth 2) varies with it
  const r3 = both('select name, o: ^orders collect { id, same: ^^orders collect { id values where region == ^region } where customer_id == ^id } from customers', roots);
  assert.deepEqual(value(r3), [
    { name: "Ann", o: [{ id: 10, same: [10, 13] }, { id: 12, same: [11, 12] }] }, { name: "Bob", o: [{ id: 11, same: [11, 12] }] }, { name: "Cy", o: [] },
  ]);
  assert.equal(count(r3.events, "memo"), 0);
});

test("an invariant block that raises does so once, at the first row, as the scan does", () => {
  const r = both('select name, x: ^customers single { } from customers', roots);
  assert.equal(r.ok ? null : r.message, "single { … } for 'receiver' matched 3 rows");
  const r2 = both('select name from customers where ^orders exists { where nope(total) }', roots);
  assert.equal(r2.ok ? null : r2.message, "unknown function 'nope(…)'");
});

// ---- cardinality ---------------------------------------------------------------------------

test("exists / none / count with no residual never enter a row", () => {
  const r = both('select name from customers where ^orders count { } == 4', roots);
  assert.deepEqual(value(r), [{ name: "Ann" }, { name: "Bob" }, { name: "Cy" }]);
  assert.equal(count(r.events, "cardinality"), 1, "invariant too: computed once, memoized twice");
  assert.equal(count(r.events, "memo"), 2);
  const r2 = both('select name from customers where ^orders count { where customer_id == ^id } == 1', roots);
  assert.deepEqual(value(r2), [{ name: "Bob" }]);
  assert.equal(count(r2.events, "cardinality"), 3);
  // distinct / order by keep the per-row path (they project / evaluate keys)
  const r3 = both('select name from customers where ^orders count distinct { region where customer_id == ^id } == 2', roots);
  assert.deepEqual(value(r3), [{ name: "Ann" }]);
  assert.equal(count(r3.events, "cardinality"), 0);
});

// ---- the semi-join short-circuit survives the probe -------------------------------------------

test("exists over a probed bucket stops at the first match (as the scan does)", () => {
  let ticks = 0;
  const ctx = new (class extends DefaultContext {
    override callMethod(name: string, recv: unknown, args: unknown[]) {
      if (name === "tick") { ticks++; return { handled: true, value: recv }; }
      return super.callMethod(name, recv, args);
    }
  })(roots);
  const q = parse('select name from customers where ^orders exists { where customer_id == ^id && total.tick() > 0 }');
  const naive = new InMemoryEngine(ctx, { rules: [] }).run(q, []);
  const naiveTicks = ticks;
  ticks = 0;
  const events: TraceEvent[] = [];
  const optimized = new InMemoryEngine(ctx, { trace: (e) => events.push(e) }).run(q, []);
  assert.deepEqual(optimized, naive);
  assert.equal(ticks, naiveTicks);
  assert.equal(ticks, 2, "Ann stops at order 10, Bob at 11, Cy's bucket is empty");
  assert.equal(count(events, "probe"), 3);
});

// ---- the whole point: complexity ------------------------------------------------------------

test("perf: 5k orders × 5k customers zip in well under a second (scan vs probe timings printed)", (t) => {
  const N = 5000;
  const cs = Array.from({ length: N }, (_, i) => ({ id: i, name: `c${i}` }));
  const os = Array.from({ length: N }, (_, j) => ({ id: 100000 + j, customer_id: (j * 7919) % N, total: j % 100 }));
  const q = parse('select id, total, customer: ^customers first { name values where id == ^customer_id } from orders');
  const ctx = new DefaultContext({ customers: cs, orders: os });

  const t0 = performance.now();
  const fast = new InMemoryEngine(ctx).run(q, []);
  const probeMs = performance.now() - t0;
  assert.equal(fast.consumer, "collect");
  const rows = (fast as { rows: Array<{ id: number; customer: string }> }).rows;
  assert.equal(rows.length, N);
  assert.equal(rows[0]!.customer, "c0");
  assert.equal(rows[1]!.customer, `c${7919 % N}`);

  // the naive scan at 1k×1k (a 25th of the work) for the printed comparison; the
  // full 5k×5k scan is ~25M row evaluations and only runs under OQX_PERF_FULL.
  const M = process.env.OQX_PERF_FULL ? N : 1000;
  const small = new DefaultContext({ customers: cs.slice(0, M), orders: os.slice(0, M).map((o) => ({ ...o, customer_id: o.customer_id % M })) });
  const t1 = performance.now();
  const slow = new InMemoryEngine(small, { rules: [] }).run(q, []);
  const scanMs = performance.now() - t1;
  const t2 = performance.now();
  const fastSmall = new InMemoryEngine(small).run(q, []);
  const probeSmallMs = performance.now() - t2;
  assert.deepEqual(fastSmall, slow);

  t.diagnostic(`probe ${N}×${N}: ${probeMs.toFixed(1)} ms; scan ${M}×${M}: ${scanMs.toFixed(1)} ms; probe ${M}×${M}: ${probeSmallMs.toFixed(1)} ms`);
  assert.ok(probeMs < 1500, `probe ${N}×${N} took ${probeMs.toFixed(0)} ms`);
  assert.ok(probeSmallMs * 5 < scanMs, `probe (${probeSmallMs.toFixed(1)} ms) should be far cheaper than the scan (${scanMs.toFixed(1)} ms)`);
});
