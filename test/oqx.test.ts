import { test } from "node:test";
import assert from "node:assert/strict";
import { oqx, execute, parse, run, OqxError } from "../src/index.ts";

// ---- fixtures ---------------------------------------------------------------

const people = [
  {
    name: "Bob", id: 124, title: "Engineer", active: true, age: 41,
    jobs: [
      { employer: "Globocorp", start_date: "1984/05/01", end_date: "1990/01/01" },
      { employer: "Globocorp", start_date: "2001/03/01" }, // current
    ],
  },
  {
    name: "Alice", id: 7, title: "Director", active: true, age: 52,
    jobs: [
      { employer: "Initech", start_date: "1999/01/01", end_date: "2005/01/01" },
      { employer: "Globocorp", start_date: "2010/06/01", end_date: "2015/01/01" }, // past
    ],
  },
  {
    name: "Carol", id: 55, title: "Analyst", active: false, age: 29,
    jobs: [
      { employer: "Globocorp", start_date: "2020/01/01" }, // current
    ],
  },
];

// ---- the acceptance example -------------------------------------------------

test("acceptance: current Globocorp employees via nested exists", () => {
  const company = "Globocorp";
  const employees = oqx`name, id, title from ${people} where jobs exists { employer == ${company} && !end_date }`;
  assert.deepEqual(employees, [
    { name: "Bob", id: 124, title: "Engineer" },
    { name: "Carol", id: 55, title: "Analyst" },
  ]);
});

test("acceptance example is whitespace-insensitive (multiline)", () => {
  const company = "Globocorp";
  const employees = oqx`
    name, id, title
    from ${people}
    where jobs exists { employer == ${company} && !end_date }
  ` as Array<Record<string, unknown>>;
  assert.deepEqual(employees.map((e) => e.name), ["Bob", "Carol"]);
});

// ---- basic collect / projection --------------------------------------------

test("bare source with no projection returns the raw rows", () => {
  const out = oqx`from ${people} where active` as unknown[];
  assert.deepEqual(out, [people[0], people[1]]);
});

test("dotted projection keys default to the last segment", () => {
  const data = [{ meta: { slug: "a" } }, { meta: { slug: "b" } }];
  const out = oqx`meta.slug from ${data}`;
  assert.deepEqual(out, [{ slug: "a" }, { slug: "b" }]);
});

test("named projections and value expressions", () => {
  const out = oqx`label: name, decade: age from ${people} where name == "Bob"`;
  assert.deepEqual(out, [{ label: "Bob", decade: 41 }]);
});

test("the optional `select` keyword is accepted (hook for future `select distinct`)", () => {
  const explicit = oqx`select name, id from ${people} where name == "Bob"`;
  const implicit = oqx`name, id from ${people} where name == "Bob"`;
  assert.deepEqual(explicit, [{ name: "Bob", id: 124 }]);
  assert.deepEqual(explicit, implicit);
});

test("`select` works after `from` too (order-flexible clauses)", () => {
  const out = oqx`from ${people} select name where age > 50`;
  assert.deepEqual(out, [{ name: "Alice" }]);
});

// ---- bindings as values -----------------------------------------------------

test("binding used as a scalar predicate value", () => {
  const min = 40;
  const out = oqx`name from ${people} where age >= ${min}` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.name), ["Bob", "Alice"]);
});

test("bindings never alter grammar (a string value stays a value)", () => {
  const evil = "Bob || true";
  const out = oqx`name from ${people} where name == ${evil}`;
  assert.deepEqual(out, []); // matched literally, not interpreted as OQX
});

// ---- nested consumers -------------------------------------------------------

test("count { … } with a comparison in where", () => {
  const out = oqx`name from ${people} where jobs count {} >= 2` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.name), ["Bob", "Alice"]);
});

test("select-position collect projects a nested array", () => {
  const out = oqx`
    name,
    current: jobs collect { employer where !end_date }
    from ${people}
    where name == "Bob"
  `;
  assert.deepEqual(out, [{ name: "Bob", current: [{ employer: "Globocorp" }] }]);
});

test("select-position first { … } returns a single record or null", () => {
  const out = oqx`
    name,
    firstJob: jobs first { employer }
    from ${people}
    where name == "Alice"
  `;
  assert.deepEqual(out, [{ name: "Alice", firstJob: { employer: "Initech" } }]);
});

test("single { … } throws when more than one row matches", () => {
  assert.throws(
    () => oqx`name, j: jobs single { employer } from ${people} where name == "Bob"`,
    OqxError,
  );
});

// ---- outer references (lexical scope climbing) ------------------------------

test("nested predicate can reference an outer-row field", () => {
  const accounts = [
    { owner: "x", budget: 100, orders: [{ amount: 50 }, { amount: 150 }] },
    { owner: "y", budget: 200, orders: [{ amount: 250 }] },
  ];
  const out = oqx`owner from ${accounts} where orders exists { amount > budget }` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.owner), ["x", "y"]);
});

test("^ outer reference reaches an enclosing row even when the name is shadowed", () => {
  const family = [
    { name: "Ada", parent: "Pat" },
    { name: "Ben", parent: "Pat" },
    { name: "Cy", parent: "Sam" },
  ];
  // Both the outer person and each inner candidate have `parent`; `^parent` /
  // `^name` reach the outer row that the inner row would otherwise shadow.
  const out = oqx`
    name,
    siblings: ${family} collect { name where parent == ^parent && name != ^name }
    from ${family}
  `;
  assert.deepEqual(out, [
    { name: "Ada", siblings: [{ name: "Ben" }] },
    { name: "Ben", siblings: [{ name: "Ada" }] },
    { name: "Cy", siblings: [] },
  ]);
});

// ---- top-level consumers ----------------------------------------------------

test("top-level exists / count directives", () => {
  const company = "Initech";
  assert.equal(oqx`${people} exists { jobs exists { employer == ${company} } }`, true);
  assert.equal(oqx`${people} count { where active }`, 2);
});

test("top-level first directive", () => {
  const out = oqx`${people} first { name where age > 50 }`;
  assert.deepEqual(out, { name: "Alice" });
});

// ---- order by ---------------------------------------------------------------

test("order by desc", () => {
  const out = oqx`name from ${people} order by age desc` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.name), ["Alice", "Bob", "Carol"]);
});

// ---- lifts ------------------------------------------------------------------

test("^lift binds a per-row collection from a where-position collect", () => {
  const out = oqx`
    name, currentEmployers
    from ${people}
    where jobs collect { ^currentEmployers: employer where !end_date }
  `;
  assert.deepEqual(out, [
    { name: "Bob", currentEmployers: ["Globocorp"] },
    { name: "Carol", currentEmployers: ["Globocorp"] },
  ]);
});

test("^^ multi-level lift binds N scopes out and flatten-appends", () => {
  const departments = [
    { name: "Eng", teams: [
      { id: "t1", members: [{ name: "Ada" }, { name: "Ben" }] },
      { id: "t2", members: [{ name: "Cy" }] },
    ] },
    { name: "Sales", teams: [{ id: "t3", members: [{ name: "Dee" }] }] },
  ];
  // ^teamIds binds one scope out (the dept); ^^allMembers binds two scopes out,
  // accumulating every team's members into one flat list per department.
  const out = oqx`
    name, teamIds, allMembers
    from ${departments}
    where teams collect { ^teamIds: id where members collect { ^^allMembers: name } }
  `;
  assert.deepEqual(out, [
    { name: "Eng", teamIds: ["t1", "t2"], allMembers: ["Ada", "Ben", "Cy"] },
    { name: "Sales", teamIds: ["t3"], allMembers: ["Dee"] },
  ]);
});

test("^^^ lift exports three scopes out", () => {
  const orgs = [{ name: "Acme", divisions: [
    { d: "D1", teams: [{ members: [{ name: "Ada" }] }, { members: [{ name: "Ben" }] }] },
    { d: "D2", teams: [{ members: [{ name: "Cy" }] }] },
  ] }];
  const out = oqx`
    name, everyone
    from ${orgs}
    where divisions collect { ^divs: d where teams collect { ^^tc: 1 where members collect { ^^^everyone: name } } }
  `;
  assert.deepEqual(out, [{ name: "Acme", everyone: ["Ada", "Ben", "Cy"] }]);
});

// ---- data-context (string) API ----------------------------------------------

test("execute() with named roots", () => {
  const out = execute("name from people where age >= 40", { people }) as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.name), ["Bob", "Alice"]);
});

test("run() returns the discriminated result", () => {
  const q = parse("people count { where active }");
  const res = run(q, { roots: { people } });
  assert.deepEqual(res, { consumer: "count", count: 2 });
});

// ---- follow (recursion) -----------------------------------------------------

const tree = [
  {
    id: "root", label: "Root",
    children: [
      { id: "a", label: "A", children: [{ id: "a1", label: "A1", children: [] }] },
      { id: "b", label: "B", children: [] },
    ],
  },
];

test("follow collects all reachable descendants with $depth intrinsic", () => {
  const out = oqx`
    id, depth: $depth
    from ${tree}
    follow children
    order by $depth, id
  `;
  assert.deepEqual(out, [
    { id: "root", depth: 1 },
    { id: "a", depth: 2 },
    { id: "b", depth: 2 },
    { id: "a1", depth: 3 },
  ]);
});

test("follow depth cap and $stop intrinsic", () => {
  const out = oqx`
    id, stop: $stop
    from ${tree}
    follow children { depth 2 }
    order by id
  ` as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(out.map((r) => [r.id, r.stop]));
  assert.equal(byId["root"], "continue");
  assert.equal(byId["a"], "depth"); // hit the cap
  assert.equal(byId["b"], "depth");
  assert.equal(out.find((r) => r.id === "a1"), undefined); // never reached
});

test("follow cycles terminate via identity dedup", () => {
  const n1: Record<string, unknown> = { id: 1 };
  const n2: Record<string, unknown> = { id: 2 };
  n1.next = [n2];
  n2.next = [n1];
  const out = oqx`id from ${[n1]} follow next order by id` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

// ---- errors -----------------------------------------------------------------

test("a missing source is a parse error", () => {
  assert.throws(() => oqx`name where active`, OqxError);
});

test("first { … } in where position is rejected", () => {
  assert.throws(() => execute("name from people where jobs first { employer }", { people }), OqxError);
});
