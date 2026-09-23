// order-by semantics: absent values sort last in BOTH directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/index.ts";

const docs = [{ name: "a", rank: 2 }, { name: "b" }, { name: "c", rank: 1 }];

function names(source: string): string[] {
  const rows = execute(source, { docs }) as { name: string }[];
  return rows.map((r) => r.name);
}

test("order by asc keeps absent last", () => {
  assert.deepEqual(names("name from docs order by rank asc"), ["c", "a", "b"]);
});

test("order by desc keeps absent last (does not hoist missing-key rows to the top)", () => {
  assert.deepEqual(names("name from docs order by rank desc"), ["a", "c", "b"]);
});
