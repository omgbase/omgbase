// Real storage adapter test: OQX → SQL over Node's built-in node:sqlite, with
// the in-memory engine finishing any residual. Skips cleanly if node:sqlite is
// unavailable in this runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, run, PlannedEngine } from "../src/index.ts";
import { parseTemplate } from "../src/parser.ts";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
let SqliteTable: typeof import("../src/adapters/sqlite.ts").SqliteTable | undefined;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  ({ SqliteTable } = await import("../src/adapters/sqlite.ts"));
} catch {
  // node:sqlite not available — tests below are skipped.
}

const employees = [
  { id: 1, name: "Bob", dept: "eng", level: 5, city: "NYC" },
  { id: 2, name: "Alice", dept: "eng", level: 7, city: "SF" },
  { id: 3, name: "Carol", dept: "sales", level: 4, city: "NYC" },
  { id: 4, name: "Dave", dept: "eng", level: 3, city: "SF" },
];

function makeDb() {
  const db = new DatabaseSync!(":memory:");
  db.exec("CREATE TABLE emp (id INTEGER, name TEXT, dept TEXT, level INTEGER, city TEXT)");
  const ins = db.prepare("INSERT INTO emp VALUES (?, ?, ?, ?, ?)");
  for (const e of employees) ins.run(e.id, e.name, e.dept, e.level, e.city);
  return db;
}

const opts = { columns: ["id", "name", "dept", "level", "city"] };

test("sqlite: pushes a comparison predicate into SQL and matches the in-memory engine", { skip: !DatabaseSync }, () => {
  const db = makeDb();
  const planner = new SqliteTable!(db, "emp", opts);
  const q = parse("name, level from emp where dept == \"eng\" && level >= 5 order by level desc");
  const sql = new PlannedEngine(planner).run(q, []);
  const mem = run(q, { roots: { emp: employees } });
  assert.deepEqual(sql, mem);
  assert.deepEqual((sql as { rows: Array<{ name: string }> }).rows.map((r) => r.name), ["Alice", "Bob"]);
});

test("sqlite: reduces rows in SQL before residual (only pushable conjuncts hit the DB)", { skip: !DatabaseSync }, () => {
  const db = makeDb();
  const planner = new SqliteTable!(db, "emp", opts);
  // `matches(...)` can't translate → residual; `dept == "eng"` is pushed, so SQL
  // returns the 3 eng rows and the in-memory residual applies the regex.
  const q = parse("name from emp where dept == \"eng\" && name.matches(\"^A\")");
  const plan = planner.plan(q, []);
  assert.ok(plan);
  assert.equal([...plan!.rows()].length, 3); // SQL reduced 4 rows → 3 before residual
  assert.notEqual(plan!.residual.where, null); // the regex remains as residual
  const res = new PlannedEngine(planner).run(q, []);
  assert.deepEqual((res as { rows: Array<{ name: string }> }).rows.map((r) => r.name), ["Alice"]);
});

test("sqlite: binding values become SQL parameters", { skip: !DatabaseSync }, () => {
  const db = makeDb();
  const planner = new SqliteTable!(db, "emp", opts);
  // A template binding (index 0) → a `?` SQL parameter bound to the passed value.
  const q = parseTemplate(["name from emp where level >= ", " order by name"], 1);
  const res = new PlannedEngine(planner).run(q, [4]);
  assert.deepEqual((res as { rows: Array<{ name: string }> }).rows.map((r) => r.name), ["Alice", "Bob", "Carol"]);
});

test("sqlite: unordered first pushes a LIMIT", { skip: !DatabaseSync }, () => {
  const db = makeDb();
  const planner = new SqliteTable!(db, "emp", opts);
  const q = parse("emp first { name where dept == \"eng\" }");
  const plan = planner.plan(q, []);
  assert.ok(plan);
  assert.equal([...plan!.rows()].length, 1); // LIMIT 1 applied in SQL
});
