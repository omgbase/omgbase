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

// ---- outer references (explicit `^`; bare names never climb) ----------------

const accounts = [
  { owner: "x", budget: 100, orders: [{ amount: 50 }, { amount: 150 }] },
  { owner: "y", budget: 200, orders: [{ amount: 250 }] },
];
const owners = (rows: unknown): unknown[] => (rows as Array<{ owner: unknown }>).map((r) => r.owner);

test("^name correlates a nested predicate with the enclosing row", () => {
  assert.deepEqual(owners(oqx`owner from ${accounts} where orders exists { amount > ^budget }`), ["x", "y"]);
});

test("a bare identifier resolves against the current row only: an absent local name stays absent", () => {
  // `budget` is not a property of an order. It must NOT resolve to the enclosing
  // account's budget — it is absent, so `>` is false and nothing matches.
  assert.deepEqual(owners(oqx`owner from ${accounts} where orders exists { amount > budget }`), []);
  assert.equal(oqx`${accounts} exists { orders exists { has(budget) } }`, false);
  // …and projecting it yields an absent value, not the outer one.
  assert.deepEqual(
    oqx`owner, b: orders collect { budget } from ${accounts} where owner == "y"`,
    [{ owner: "y", b: [{ budget: undefined }] }],
  );
});

test("regression: adding a same-named property to an inner row cannot change an outer reference", () => {
  // Same accounts, but every order now ALSO carries a `budget`. Under implicit
  // climbing this would have silently re-pointed a bare `budget` from the
  // account to the order; with explicit `^budget` the outer reference is fixed.
  const shadowed = [
    { owner: "x", budget: 100, orders: [{ amount: 50, budget: 0 }, { amount: 150, budget: 1000 }] },
    { owner: "y", budget: 200, orders: [{ amount: 250, budget: 1000 }] },
  ];
  const outer = (rows: unknown) => owners(oqx`owner from ${rows} where orders exists { amount > ^budget }`);
  assert.deepEqual(outer(accounts), ["x", "y"]);
  assert.deepEqual(outer(shadowed), ["x", "y"]); // unchanged: `^budget` is the account's, always
  // The bare name is, and always was, the ORDER's own property.
  const local = (rows: unknown) => owners(oqx`owner from ${rows} where orders exists { amount > budget }`);
  assert.deepEqual(local(accounts), []); // absent on the order → no match
  assert.deepEqual(local(shadowed), ["x"]); // x: 50 > 0; y: 250 > 1000 is false
});

test("present-but-falsy local values are read locally; absence is absence (no outward fallback)", () => {
  const rows = [{ label: "outer", items: [{ label: null }, { label: false }, { label: 0 }, { label: "" }, {}] }];
  const out = oqx`each: items collect { local: label, outer: ^label, present: has(label) } from ${rows}`;
  assert.deepEqual(out, [{ each: [
    { local: null, outer: "outer", present: false }, // null ≡ absent for has(), but still never "outer"
    { local: false, outer: "outer", present: true },
    { local: 0, outer: "outer", present: true },
    { local: "", outer: "outer", present: true },
    { local: undefined, outer: "outer", present: false },
  ] }]);
  // `== null` matches the null AND the absent item — neither resolves outward.
  assert.equal(oqx`${rows} exists { items count { where label == null } == 2 }`, true);
  assert.equal(oqx`${rows} exists { items count { where label == ^label } == 0 }`, true);
});

test("^ reads exactly one scope out per caret; past the root it is absent", () => {
  const rows = [{ v: "top", mid: [{ v: "mid", leaf: [{ v: "leaf" }] }] }];
  const out = oqx`
    m: mid collect { l: leaf collect { own: v, one: ^v, two: ^^v, three: ^^^v, four: ^^^^v } }
    from ${rows}
  `;
  // ^^^v is the root scope, which has no row → absent (named roots live there);
  // ^^^^v is past the root → absent. Neither falls back to a nearer `v`.
  assert.deepEqual(out, [{ m: [{ l: [{ own: "leaf", one: "mid", two: "top", three: undefined, four: undefined }] }] }]);
});

test("named roots live on the root scope: reachable from a row only via ^, never by a bare name", () => {
  const folks = [
    { name: "Ada", city: "SF" }, { name: "Ben", city: "SF" }, { name: "Cy", city: "NYC" },
  ];
  // `^people` from a top-level row is the root scope's `people`; inside the
  // block, `^city` / `^name` are the enclosing person's.
  assert.deepEqual(
    execute("name, peers: ^people collect { name where city == ^city && name != ^name } from people", { people: folks }),
    [{ name: "Ada", peers: [{ name: "Ben" }] }, { name: "Ben", peers: [{ name: "Ada" }] }, { name: "Cy", peers: [] }],
  );
  // A bare `people` inside a person row is that row's (absent) property → an
  // empty receiver → exists is false for every row; `^people` is the root.
  assert.deepEqual(execute("name from people where people exists { name == ^name }", { people: folks }), []);
  assert.deepEqual(
    execute("name from people where ^people exists { city == ^city && name != ^name }", { people: folks }),
    [{ name: "Ada" }, { name: "Ben" }],
  );
});

test("^ outer reference reaches an enclosing row even when the name is shadowed", () => {
  const family = [
    { name: "Ada", parent: "Pat" },
    { name: "Ben", parent: "Pat" },
    { name: "Cy", parent: "Sam" },
  ];
  // Both the outer person and each inner candidate have `parent`; a bare
  // `parent` is the candidate's, `^parent` / `^name` are the outer person's.
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
  assert.equal(byId["root"], "interior");
  assert.equal(byId["a"], "depth"); // hit the cap
  assert.equal(byId["b"], "depth");
  assert.equal(out.find((r) => r.id === "a1"), undefined); // never reached
});

test("follow cycles terminate: a revisit is admitted once as $stop == 'cycle'", () => {
  const n1: Record<string, unknown> = { id: 1 };
  const n2: Record<string, unknown> = { id: 2 };
  n1.next = [n2];
  n2.next = [n1];
  const out = oqx`id, stop: $stop from ${[n1]} follow next order by $ordinal` as Array<Record<string, unknown>>;
  // seed 1 (interior) → 2 (interior) → back to 1, admitted once as a cycle and
  // never re-expanded, so the walk terminates.
  assert.deepEqual(out.map((r) => r.id), [1, 2, 1]);
  assert.deepEqual(out.map((r) => r.stop), ["interior", "interior", "cycle"]);
});

test("recursion intrinsics belong to the reached row's scope; a nested block reads them via ^", () => {
  const out = oqx`
    id, kids: children collect { id, own: $depth, parentDepth: ^$depth }
    from ${tree}
    follow children { depth 2 }
    order by $ordinal
  `;
  // Inside `children collect { … }` the rows are plain children, not follow
  // occurrences: a bare `$depth` is absent there and does not climb to the
  // occurrence's; `^$depth` names it explicitly.
  assert.deepEqual(out, [
    { id: "root", kids: [{ id: "a", own: undefined, parentDepth: 1 }, { id: "b", own: undefined, parentDepth: 1 }] },
    { id: "a", kids: [{ id: "a1", own: undefined, parentDepth: 2 }] },
    { id: "b", kids: [] },
  ]);
});

test("follow distinct collapses per-path occurrences to reached nodes", () => {
  const n1: Record<string, unknown> = { id: 1 };
  const n2: Record<string, unknown> = { id: 2 };
  n1.next = [n2];
  n2.next = [n1];
  const out = oqx`id from ${[n1]} follow distinct next order by id` as Array<Record<string, unknown>>;
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

// ---- distinct ---------------------------------------------------------------

test("select distinct dedups top-level result rows by projection", () => {
  const dupes = [{ id: 1 }, { id: 1 }, { id: 2 }];
  const rows = oqx`from ${dupes} select distinct id` as { id: number }[];
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
});

test("collect distinct dedups a nested relation's projected rows", () => {
  const bob = people[0]!; // two jobs, both at Globocorp
  const employers = oqx`from ${bob.jobs} select distinct employer` as { employer: string }[];
  assert.deepEqual(employers.map((r) => r.employer), ["Globocorp"]); // 2 rows → 1 distinct

  const collected = oqx`from ${[bob]} select n: jobs collect distinct { select employer }` as Array<{ n: unknown[] }>;
  assert.equal(collected[0]!.n.length, 1);
});

test("count distinct { … } counts distinct projections (meaningful counts)", () => {
  const bob = people[0]!; // 2 job rows, both Globocorp → 1 distinct employer
  assert.equal(oqx`${[bob]} exists { jobs count distinct { select employer } == 1 }` as boolean, true);
  assert.equal(oqx`${[bob]} exists { jobs count { select employer } == 2 }` as boolean, true); // without distinct: 2 rows
});

test("distinct is also spellable inside the block via `select distinct`", () => {
  const bob = people[0]!;
  const a = oqx`from ${[bob]} select n: jobs collect distinct { select employer }` as Array<{ n: unknown[] }>;
  const b = oqx`from ${[bob]} select n: jobs collect { select distinct employer }` as Array<{ n: unknown[] }>;
  assert.deepEqual(a, b);
});

// ---- ranges -----------------------------------------------------------------

const names = (rows: unknown): unknown[] => (rows as Array<{ name: unknown }>).map((r) => r.name);

test("range: `in lo..hi` is inclusive membership", () => {
  // ages: Bob 41, Alice 52, Carol 29
  assert.deepEqual(names(oqx`name from ${people} where age in 30..50`), ["Bob"]);
  assert.deepEqual(names(oqx`name from ${people} where age in 29..52`), ["Bob", "Alice", "Carol"]);
});

test("range: `in lo...hi` excludes the high endpoint", () => {
  assert.deepEqual(names(oqx`name from ${people} where age in 29...52`), ["Bob", "Carol"]); // 52 excluded
  assert.deepEqual(names(oqx`name from ${people} where age in 41...52`), ["Bob"]); // 41 ≤ x < 52 → only Bob(41)
});

test("range: open-ended `lo..` and `..hi`", () => {
  assert.deepEqual(names(oqx`name from ${people} where age in 41..`), ["Bob", "Alice"]); // 41 and up
  assert.deepEqual(names(oqx`name from ${people} where age in ..29`), ["Carol"]); // up to and incl 29
  assert.deepEqual(names(oqx`name from ${people} where age in ..28`), []); // up to but excluding Carol
});

test("range: an open-ended bound does not swallow a following clause", () => {
  // `41..` is open-high; the `order by` that follows must not be read as its bound.
  const out = oqx`name from ${people} where age in 40.. order by age`;
  assert.deepEqual(names(out), ["Bob", "Alice"]); // 41 then 52, ascending
});

test("range: bounds may be interpolated bindings", () => {
  const lo = 30, hi = 50;
  assert.deepEqual(names(oqx`name from ${people} where age in ${lo}..${hi}`), ["Bob"]);
});

test("range: date/time membership over ISO-8601 strings", () => {
  const events = [
    { label: "kickoff", on: "2026-01-15" },
    { label: "review", on: "2026-04-02" },
    { label: "launch", on: "2026-03-31" },
  ];
  const inQ1 = oqx`label from ${events} where on in "2026-01-01".."2026-03-31"` as Array<{ label: string }>;
  assert.deepEqual(inQ1.map((e) => e.label), ["kickoff", "launch"]);
});

test("range: parses to a range node with the exclusive-end flag", () => {
  const q = parse("from xs where n in 1...5");
  assert.deepEqual(q.where, {
    kind: "scalar",
    expr: {
      kind: "in",
      left: { kind: "ident", name: "n" },
      right: { kind: "range", lo: { kind: "lit", value: 1 }, hi: { kind: "lit", value: 5 }, exclusiveEnd: true },
    },
  });
});

test("range(s) coerces a string field to a range for membership", () => {
  // ranges that arrive as string DATA (not written as a literal in the query)
  const rows = [
    { label: "jan", window: "2026-01-01..2026-01-31" },
    { label: "feb", window: "2026-02-01..2026-02-28" },
    { label: "q1", span: "1..3" },
  ];
  assert.deepEqual(
    (oqx`label from ${rows} where "2026-01-15" in range(window)` as Array<{ label: string }>).map((r) => r.label),
    ["jan"],
  );
  assert.deepEqual(
    (oqx`label from ${rows} where 2 in range(span)` as Array<{ label: string }>).map((r) => r.label),
    ["q1"],
  );
  // a bare (unparsed) field is still just its string — range() is the opt-in
  assert.deepEqual(oqx`from ${rows} where window == "2026-01-01..2026-01-31"`, [rows[0]]);
});

// ---- errors -----------------------------------------------------------------

test("a missing source is a parse error", () => {
  assert.throws(() => oqx`name where active`, OqxError);
});

test("first { … } in where position is rejected", () => {
  assert.throws(() => execute("name from people where jobs first { employer }", { people }), OqxError);
});
