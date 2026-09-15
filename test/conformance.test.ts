// The scalar-semantics contract every backend must obey (see src/semantics.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { equals, relate, membership, arith, compareForSort, coerceCollection } from "../src/semantics.ts";

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
