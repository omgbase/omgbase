// Implementation conformance: (1) the scalar-semantics contract every backend
// must obey (see src/semantics.ts); (2) the optimizer invariant — for every
// fixture under spec/oqx/cases, the optimized engine (the default rule set)
// and the naive engine (`rules: []`) produce the same canonical result, or the
// same error (stage and message). Planner behavior is implementation
// conformance, never a spec fixture (spec/oqx/README.md, "What does not belong
// in cases/"), so this is where the optimizer is proven against the language.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { equals, relate, membership, arith, compareForSort, coerceCollection, makeRange, isRange, rangeCovers, parseRangeString, BUILTIN_FUNCTIONS } from "../src/semantics.ts";
import { parseString, parseTemplate } from "../src/parser.ts";
import { DefaultContext, InMemoryEngine, OqxError, resolveAliases } from "../src/index.ts";
import type { OqxResult, Query, TraceEvent } from "../src/index.ts";

test("equality is typed and strict; absence normalizes", () => {
  assert.equal(equals(5, 5), true);
  assert.equal(equals(5, "5"), false); // no cross-type coercion
  assert.equal(equals(null, undefined), true); // absent ≡ absent
  assert.equal(equals(0, false), false);
});

test("ordering comparisons with an absent operand are false", () => {
  assert.equal(relate(">", 3, null), false);
  assert.equal(relate("<", undefined, 3), false);
  assert.equal(relate(">=", 3, 3), true);
  assert.equal(relate("<", "a", "b"), true);
});

test("membership: array / string / object", () => {
  assert.equal(membership(2, [1, 2, 3]), true);
  assert.equal(membership("ell", "hello"), true);
  assert.equal(membership("k", { k: 1 }), true);
  assert.equal(membership(9, [1, 2]), false);
});

test("range: makeRange / isRange and inclusive vs exclusive coverage", () => {
  const inclusive = makeRange(1, 5, false); // 1..5
  const exclusive = makeRange(1, 5, true); // 1...5
  assert.equal(isRange(inclusive), true);
  assert.equal(isRange({ lo: 1, hi: 5 }), false); // a plain object is not a range
  // inclusive `1..5` covers both endpoints
  assert.equal(rangeCovers(inclusive, 1), true);
  assert.equal(rangeCovers(inclusive, 5), true);
  assert.equal(rangeCovers(inclusive, 0), false);
  assert.equal(rangeCovers(inclusive, 6), false);
  // exclusive `1...5` excludes the high endpoint
  assert.equal(rangeCovers(exclusive, 5), false);
  assert.equal(rangeCovers(exclusive, 4), true);
});

test("range: open-ended bounds (..hi / lo..)", () => {
  assert.equal(rangeCovers(makeRange(null, 5, false), 5), true); // ..5 (inclusive)
  assert.equal(rangeCovers(makeRange(null, 5, false), 6), false);
  assert.equal(rangeCovers(makeRange(null, 5, true), 5), false); // ...5 (exclusive)
  assert.equal(rangeCovers(makeRange(1, null, false), 1000), true); // 1..
  assert.equal(rangeCovers(makeRange(1, null, false), 0), false);
});

test("range: an absent value is never covered (never throws)", () => {
  assert.equal(rangeCovers(makeRange(1, 5, false), null), false);
  assert.equal(rangeCovers(makeRange(1, 5, false), undefined), false);
});

test("range: date/time ranges compare over ISO-8601 strings", () => {
  const q1 = makeRange("2026-01-01", "2026-03-31", false); // a quarter, inclusive
  assert.equal(rangeCovers(q1, "2026-02-14"), true);
  assert.equal(rangeCovers(q1, "2026-03-31"), true);
  assert.equal(rangeCovers(q1, "2025-12-31"), false);
  assert.equal(rangeCovers(q1, "2026-04-01"), false);
});

test("membership routes a range RHS to coverage", () => {
  assert.equal(membership(3, makeRange(1, 5, false)), true);
  assert.equal(membership(5, makeRange(1, 5, true)), false); // exclusive end
  assert.equal(membership("2026-02-01", makeRange("2026-01-01", "2026-12-31", false)), true);
});

test("parseRangeString parses numeric / date / open-ended ranges", () => {
  assert.deepEqual(parseRangeString("1..5"), makeRange(1, 5, false));
  assert.deepEqual(parseRangeString("1...5"), makeRange(1, 5, true));
  assert.deepEqual(parseRangeString("..5"), makeRange(null, 5, false));
  assert.deepEqual(parseRangeString("1.."), makeRange(1, null, false));
  assert.deepEqual(parseRangeString("2026-01-01..2026-01-31"), makeRange("2026-01-01", "2026-01-31", false));
  // not ranges → null, so `x in range(s)` is simply false
  assert.equal(parseRangeString("hello"), null);
  assert.equal(parseRangeString("a..z"), null);
  assert.equal(parseRangeString("1..2026-01-01"), null); // mixed domains
  assert.equal(parseRangeString("../foo"), null);
});

test("the range(s) builtin coerces a string to a range value (and passes ranges through)", () => {
  const r = BUILTIN_FUNCTIONS.range!(["1..5"]);
  assert.equal(isRange(r), true);
  assert.equal(rangeCovers(r as ReturnType<typeof makeRange>, 3), true);
  assert.equal(membership(3, BUILTIN_FUNCTIONS.range!(["1..5"])), true);
  assert.equal(membership(9, BUILTIN_FUNCTIONS.range!(["1..5"])), false);
  assert.equal(BUILTIN_FUNCTIONS.range!(["not a range"]), null);
  assert.equal(isRange(BUILTIN_FUNCTIONS.range!([makeRange(1, 5, false)])), true); // pass-through
});

test("arithmetic: + concatenates when either side is a string", () => {
  assert.equal(arith("+", 1, 2), 3);
  assert.equal(arith("+", "a", 1), "a1");
  assert.equal(arith("*", 3, 4), 12);
});

test("sort order places absent values last", () => {
  const xs = [3, null, 1, undefined, 2];
  assert.deepEqual([...xs].sort(compareForSort), [1, 2, 3, null, undefined]);
});

test("coerceCollection normalizes sources", () => {
  assert.deepEqual(coerceCollection(null), []);
  assert.deepEqual(coerceCollection([1, 2]), [1, 2]);
  assert.deepEqual(coerceCollection(new Set([1, 2])), [1, 2]);
  assert.deepEqual(coerceCollection("x"), ["x"]); // a string is a single value, not chars
});

// ---- optimized ≡ naive over every spec fixture ---------------------------------------
//
// spec.test.ts validates the fixture files and checks each against its expected
// outcome; this pass only needs the inputs, and compares the two engines with
// each other — so an optimizer bug shows up even on a fixture whose expectation
// both engines happen to miss the same way.

const CASES_DIR = join(import.meta.dirname, "../../../spec/oqx/cases");

interface SpecCase {
  name: string;
  roots?: Record<string, unknown>;
  query?: string;
  template?: { strings: string[]; values: unknown[] };
}

type Outcome = { ok: true; value: unknown } | { ok: false; stage: string; message: string };

function unwrap(result: OqxResult): unknown {
  switch (result.consumer) {
    case "collect": return result.rows;
    case "exists": return result.exists;
    case "none": return result.none;
    case "count": return result.count;
    case "first": case "single": return result.row;
  }
}

/** JSON round trip with sorted keys: the spec's canonical form (README). */
function canonical(v: unknown): unknown {
  if (v === undefined) return null;
  const sorted = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sorted);
    if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sorted(o[k]);
      return out;
    }
    return x;
  };
  return sorted(JSON.parse(JSON.stringify(v)) as unknown);
}

function outcomeOf(c: SpecCase, optimized: boolean, trace?: (e: TraceEvent) => void): Outcome {
  try {
    let query: Query;
    let values: unknown[] = [];
    if (c.template) {
      values = c.template.values;
      query = parseTemplate(c.template.strings, values.length);
    } else {
      query = parseString(c.query!);
    }
    const engine = new InMemoryEngine(new DefaultContext(c.roots ?? {}), optimized ? { trace } : { rules: [] });
    return { ok: true, value: canonical(unwrap(engine.run(resolveAliases(query), values))) };
  } catch (e) {
    if (e instanceof OqxError) return { ok: false, stage: e.stage, message: e.message };
    throw e;
  }
}

const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
const exercised = { probe: 0, memo: 0, cardinality: 0, index: 0 };

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8")) as { cases: SpecCase[] };
  const stem = file.replace(/\.json$/, "");
  for (const c of doc.cases) {
    test(`optimized ≡ naive: ${stem}::${c.name}`, () => {
      const naive = outcomeOf(c, false);
      const planned = outcomeOf(c, true, (e) => {
        if (e.kind === "probe" || e.kind === "memo" || e.kind === "cardinality" || e.kind === "index") exercised[e.kind]++;
      });
      assert.deepStrictEqual(planned, naive);
    });
  }
}

test("optimized ≡ naive: the fixtures exercise the probe and the cardinality rules", (t) => {
  // (No fixture re-evaluates an invariant block across outer rows; optimize.test.ts covers the memo.)
  t.diagnostic(`optimizer actions over the spec fixtures: ${JSON.stringify(exercised)}`);
  assert.ok(exercised.index > 0 && exercised.probe > 0, "some fixture probed an index");
  assert.ok(exercised.cardinality > 0, "some fixture was answered from a cardinality");
});
