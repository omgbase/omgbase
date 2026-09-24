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
  const employees = oqx`name, id, title from ${people} where jobs exists { where employer == ${company} && !end_date }`;
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
    where jobs exists { where employer == ${company} && !end_date }
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

// ---- the fixed clause order (ADR-020) ----------------------------------------

test("each of the four legal leading forms parses", () => {
  assert.deepEqual(oqx`select name from ${people} where age > 50`, [{ name: "Alice" }]); // select-first, keyword
  assert.deepEqual(oqx`name from ${people} where age > 50`, [{ name: "Alice" }]); // select-first, keyword dropped
  assert.deepEqual(oqx`from ${people} where age > 50`, [people[1]]); // from-first (no projection)
  assert.equal(oqx`${people} count { where age > 50 }`, 1); // receiver + consumer
  // inside a block the same rule holds: a leading run is the projection
  assert.deepEqual(oqx`${people} first { name where age > 50 }`, { name: "Alice" });
  assert.deepEqual(oqx`${people} first { select name where age > 50 }`, { name: "Alice" });
});

test("out-of-order clauses fail naming the fixed order", () => {
  const ordering = /OQX clause order is select, from, where, follow, order by, limit, offset/;
  const outOfOrder = (src: string, first: string, second: string) => assert.throws(
    () => parse(src),
    (e: unknown) => e instanceof OqxError && ordering.test(e.message) && e.message.includes(`\`${first}\` must come before \`${second}\``),
    src,
  );
  outOfOrder("from people select name", "select", "from");
  outOfOrder("from people where age > 50 select name", "select", "where");
  outOfOrder("name from people order by age where age > 50", "where", "order by");
  outOfOrder("name from people follow jobs where age > 50", "where", "follow");
  outOfOrder("name from people limit 1 order by age", "order by", "limit");
  outOfOrder("name from people offset 1 limit 1", "limit", "offset");
  outOfOrder("people count { where age > 50 select name }", "select", "where");
  // a clause appears at most once
  assert.throws(() => parse("from people from jobs"), (e: unknown) => e instanceof OqxError && /duplicate `from`/.test(e.message));
  assert.throws(() => parse("name from people where a where b"), (e: unknown) => e instanceof OqxError && /duplicate `where`/.test(e.message));
});

test("a bare predicate in a block fails asking for `where` (there is no implicit where)", () => {
  const wantsWhere = (e: unknown) => e instanceof OqxError && /write `where /.test(e.message) && /never implicit/.test(e.message);
  assert.throws(() => parse("people exists { age > 50 }"), wantsWhere);
  assert.throws(() => parse("people exists { !active }"), wantsWhere);
  assert.throws(() => parse('name from people where jobs exists { employer == "X" && !end_date }'), wantsWhere);
  assert.throws(() => parse("people exists { jobs count {} >= 2 }"), wantsWhere);
  // …and a bare leading predicate at the top level is the same mistake
  assert.throws(() => parse("!active from people"), wantsWhere);
  assert.throws(() => parse("age > 40 from people"), wantsWhere);
  // a bare NAME is a projection, at the top level and in a block alike
  assert.deepEqual(oqx`active from ${people}`, [{ active: true }, { active: true }, { active: false }]);
  assert.deepEqual(oqx`${people} first { active }`, { active: true });
});

test("a bare run after `from` is an error; `from people count` gets the consumer hint", () => {
  assert.throws(
    () => parse("from people count"),
    (e: unknown) => e instanceof OqxError
      && e.message.includes("unexpected `count` after `from`")
      && e.message.includes("`<collection> count { … }`")
      && e.message.includes("`select count from …`"),
  );
  assert.throws(() => parse("from people exists { where active }"), (e: unknown) => e instanceof OqxError && /unexpected `exists` after `from`/.test(e.message));
  assert.throws(
    () => parse("from people active"),
    (e: unknown) => e instanceof OqxError && /unexpected 'active' after `from`/.test(e.message) && /no implicit where/.test(e.message),
  );
  assert.throws(() => parse("from people name, id"), (e: unknown) => e instanceof OqxError && /unexpected 'name' after `from`/.test(e.message));
  // the legal spellings of what those meant
  assert.equal(oqx`${people} count { where active }`, 2);
  assert.deepEqual(oqx`select count from ${[{ count: 3 }]}`, [{ count: 3 }]);
});

test("`where` may reference `select` aliases (inlined at parse time)", () => {
  assert.deepEqual(oqx`select name, adult: age >= 30 from ${people} where adult`, [
    { name: "Bob", adult: true }, { name: "Alice", adult: true },
  ]);
  assert.deepEqual(oqx`select name, decade: age / 10 from ${people} where decade > 5`, [{ name: "Alice", decade: 5.2 }]);
  // the rewrite is inline substitution: the where AST is an ordinary scalar tree
  const q = parse("select adult: age >= 18 from people where adult && name == \"x\"");
  assert.deepEqual(q.where, {
    kind: "and",
    parts: [
      { kind: "scalar", expr: { kind: "binary", op: ">=", left: { kind: "ident", name: "age" }, right: { kind: "lit", value: 18 } } },
      { kind: "scalar", expr: { kind: "binary", op: "==", left: { kind: "ident", name: "name" }, right: { kind: "lit", value: "x" } } },
    ],
  });
  // an alias chain resolves through (b → a's expression)
  assert.deepEqual(oqx`select senior: age > 50, s: senior from ${people} where s`, [{ senior: true, s: undefined }]);
  // an unaliased dotted item is an alias for its key
  const data = [{ meta: { slug: "a" } }, { meta: { slug: "b" } }];
  assert.deepEqual(oqx`select meta.slug from ${data} where slug == "b"`, [{ slug: "b" }]);
  // inside a block, the rewrite is against THAT block's select only
  assert.deepEqual(
    oqx`name, cur: jobs collect { e: employer, open: !end_date where open } from ${people} where name == "Bob"`,
    [{ name: "Bob", cur: [{ e: "Globocorp", open: true }] }],
  );
  // a collect alias in predicate position means non-empty
  assert.deepEqual(
    oqx`name, current: jobs collect { employer where !end_date } from ${people} where current` as Array<{ name: string }>,
    [{ name: "Bob", current: [{ employer: "Globocorp" }] }, { name: "Carol", current: [{ employer: "Globocorp" }] }],
  );
  assert.throws(
    () => parse("select n: jobs collect { employer } from people where n.size() > 1"),
    (e: unknown) => e instanceof OqxError && /alias 'n' is a collect/.test(e.message),
  );
});

test("an alias shadows a same-named field inside `where`; its own expression reads the field", () => {
  // every person has `active`; the alias `active` redefines it for the where
  assert.deepEqual(oqx`select name, active: age > 50 from ${people} where active`, [{ name: "Alice", active: true }]);
  // `^name` is never an alias — it reads the enclosing ROW
  assert.deepEqual(
    oqx`name, peers: ${people} collect { name values where age > ^age } from ${people} where name == "Bob"`,
    [{ name: "Bob", peers: ["Alice"] }],
  );
  // inside its own expression an alias's name is the row field (not recursion)
  assert.deepEqual(oqx`select name: name.upper() from ${people} where name == "BOB"`, [{ name: "BOB" }]);
  assert.deepEqual(oqx`select name from ${people} where name == "Bob"`, [{ name: "Bob" }]);
});

test("a cycle among aliases referenced from `where` is a parse error", () => {
  assert.throws(
    () => parse("select a: b, b: a from people where a"),
    (e: unknown) => e instanceof OqxError && /select aliases form a cycle: a → b → a/.test(e.message),
  );
  assert.throws(
    () => parse("select a: b + 1, b: c, c: a from people where c > 1"),
    (e: unknown) => e instanceof OqxError && /cycle: c → a → b → c/.test(e.message),
  );
  // unreferenced, the same select is fine (it swaps two fields)
  assert.deepEqual(oqx`select a: b, b: a from ${[{ a: 1, b: 2 }]}`, [{ a: 2, b: 1 }]);
});

test("`order by` resolves against the row, not the select aliases (unchanged)", () => {
  // `decade` is not a field: every key is absent, so the order is the input order
  const out = oqx`select name, decade: age / 10 from ${people} order by decade` as Array<{ name: string }>;
  assert.deepEqual(out.map((r) => r.name), ["Bob", "Alice", "Carol"]);
  // …and a field named like an alias sorts by the FIELD
  assert.deepEqual(
    (oqx`select name, age: 0 from ${people} order by age desc` as Array<{ name: string }>).map((r) => r.name),
    ["Alice", "Bob", "Carol"],
  );
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
  assert.deepEqual(owners(oqx`owner from ${accounts} where orders exists { where amount > ^budget }`), ["x", "y"]);
});

test("a bare identifier resolves against the current row only: an absent local name stays absent", () => {
  // `budget` is not a property of an order. It must NOT resolve to the enclosing
  // account's budget — it is absent, so `>` is false and nothing matches.
  assert.deepEqual(owners(oqx`owner from ${accounts} where orders exists { where amount > budget }`), []);
  assert.equal(oqx`${accounts} exists { where orders exists { where has(budget) } }`, false);
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
  const outer = (rows: unknown) => owners(oqx`owner from ${rows} where orders exists { where amount > ^budget }`);
  assert.deepEqual(outer(accounts), ["x", "y"]);
  assert.deepEqual(outer(shadowed), ["x", "y"]); // unchanged: `^budget` is the account's, always
  // The bare name is, and always was, the ORDER's own property.
  const local = (rows: unknown) => owners(oqx`owner from ${rows} where orders exists { where amount > budget }`);
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
  assert.equal(oqx`${rows} exists { where items count { where label == null } == 2 }`, true);
  assert.equal(oqx`${rows} exists { where items count { where label == ^label } == 0 }`, true);
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
  assert.deepEqual(execute("name from people where people exists { where name == ^name }", { people: folks }), []);
  assert.deepEqual(
    execute("name from people where ^people exists { where city == ^city && name != ^name }", { people: folks }),
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
  assert.equal(oqx`${people} exists { where jobs exists { where employer == ${company} } }`, true);
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
  const rows = oqx`select distinct id from ${dupes}` as { id: number }[];
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
});

test("collect distinct dedups a nested relation's projected rows", () => {
  const bob = people[0]!; // two jobs, both at Globocorp
  const employers = oqx`select distinct employer from ${bob.jobs}` as { employer: string }[];
  assert.deepEqual(employers.map((r) => r.employer), ["Globocorp"]); // 2 rows → 1 distinct

  const collected = oqx`select n: jobs collect distinct { select employer } from ${[bob]}` as Array<{ n: unknown[] }>;
  assert.equal(collected[0]!.n.length, 1);
});

test("count distinct { … } counts distinct projections (meaningful counts)", () => {
  const bob = people[0]!; // 2 job rows, both Globocorp → 1 distinct employer
  assert.equal(oqx`${[bob]} exists { where jobs count distinct { select employer } == 1 }` as boolean, true);
  assert.equal(oqx`${[bob]} exists { where jobs count { select employer } == 2 }` as boolean, true); // without distinct: 2 rows
});

test("distinct is also spellable inside the block via `select distinct`", () => {
  const bob = people[0]!;
  const a = oqx`select n: jobs collect distinct { select employer } from ${[bob]}` as Array<{ n: unknown[] }>;
  const b = oqx`select n: jobs collect { select distinct employer } from ${[bob]}` as Array<{ n: unknown[] }>;
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

// ---- `$value` (the current item) and `values` (scalar projection mode) -------

const scores = [10, 60, 70, 45];
const players = [
  { name: "Ann", scores: [10, 60, 70] },
  { name: "Ben", scores: [45] },
  { name: "Cid", scores: [] },
];

test("$value is the current row itself, so scalar collections are queryable", () => {
  assert.deepEqual(oqx`$value values from ${scores} where $value > 50`, [60, 70]);
  assert.deepEqual(oqx`$value values from ${["b", "a"]} order by $value`, ["a", "b"]);
  assert.deepEqual(oqx`$value values from ${scores} order by $value desc`, [70, 60, 45, 10]);
});

test("$value on an object row is that exact object (reference identity)", () => {
  const out = oqx`employee: $value from ${people} where name == "Bob"` as Array<{ employee: unknown }>;
  assert.equal(out[0]!.employee, people[0]);
  // bare `$value` keys by its own name, like any other bare projection
  assert.deepEqual(oqx`$value from ${[1, 2]}`, [{ $value: 1 }, { $value: 2 }]);
});

test("$value inside a nested block is the inner item; ^$value is the enclosing row", () => {
  assert.deepEqual(
    oqx`name, big: scores collect { $value values where $value > 50 } from ${players}`,
    [{ name: "Ann", big: [60, 70] }, { name: "Ben", big: [] }, { name: "Cid", big: [] }],
  );
  // `^$value` reads the enclosing scope's row: players with strictly more scores than me
  assert.deepEqual(
    oqx`name, richer: ${players} collect { name values where scores.size() > ^$value.scores.size() } from ${players}`,
    [{ name: "Ann", richer: [] }, { name: "Ben", richer: ["Ann"] }, { name: "Cid", richer: ["Ann", "Ben"] }],
  );
});

test("$value is absent at the root scope and is never a named root", () => {
  assert.deepEqual(execute("$value values from xs where has($value)", { xs: [1, null, 2] }), [1, 2]);
  assert.equal(execute("xs exists { where $value == ^$value }", { xs: [1] }), false); // ^$value from a top-level row is the root: absent
});

test("values: a record projection becomes the bare value", () => {
  assert.deepEqual(oqx`name values from ${people}`, ["Bob", "Alice", "Carol"]);
  assert.deepEqual(oqx`select name values from ${people} where age > 40`, ["Bob", "Alice"]);
  // an unaliased expression is legal under values (a name would be meaningless)
  assert.deepEqual(oqx`name.upper() values from ${people} where age < 30`, ["CAROL"]);
  assert.deepEqual(oqx`age * 2 values from ${people} where name == "Bob"`, [82]);
  // an alias is accepted and ignored
  assert.deepEqual(oqx`n: name values from ${people} where name == "Bob"`, ["Bob"]);
});

test("values composes with distinct, first/single, and nested consumers", () => {
  const jobs = people.flatMap((p) => p.jobs);
  assert.deepEqual(oqx`select distinct employer values from ${jobs}`, ["Globocorp", "Initech"]);
  assert.deepEqual(oqx`employer values from ${jobs} where employer != "Globocorp"`, ["Initech"]);
  assert.equal(oqx`${people} first { name values where age > 50 }`, "Alice");
  assert.equal(oqx`${people} single { name values where name == "Carol" }`, "Carol");
  assert.equal(oqx`${people} first { name values where age > 90 }`, null);
  assert.deepEqual(
    oqx`name, employers: jobs collect distinct { employer values } from ${people}`,
    [{ name: "Bob", employers: ["Globocorp"] }, { name: "Alice", employers: ["Initech", "Globocorp"] }, { name: "Carol", employers: ["Globocorp"] }],
  );
  assert.deepEqual(
    oqx`name, latest: jobs first { start_date values order by start_date desc } from ${people} where name == "Bob"`,
    [{ name: "Bob", latest: "2001/03/01" }],
  );
  // a nested collect can itself be the value
  assert.deepEqual(
    oqx`e: jobs collect { employer values } values from ${people} where name == "Alice"`,
    [["Initech", "Globocorp"]],
  );
});

test("values takes exactly one item, and rejects lifts", () => {
  assert.throws(() => parse("name, id values from people"), (e: unknown) => e instanceof OqxError && /exactly one/.test(e.message));
  assert.throws(() => parse("from people where jobs collect { ^x: employer values }"), (e: unknown) => e instanceof OqxError && /lift/.test(e.message));
});

test("an unaliased non-navigation projection item is an error unless followed by values", () => {
  assert.throws(() => parse("size(jobs) from people"), (e: unknown) => e instanceof OqxError && /needs an alias/.test(e.message));
  assert.throws(() => parse("select age > 40 from people"), (e: unknown) => e instanceof OqxError && /needs an alias/.test(e.message));
  // a call-shaped leading expression is a projection, not an implicit where —
  // say `where` to filter by it
  assert.throws(() => parse("people exists { has(budget) }"), (e: unknown) => e instanceof OqxError && /needs an alias/.test(e.message));
  assert.deepEqual(oqx`n: size(jobs) from ${people}`, [{ n: 2 }, { n: 2 }, { n: 1 }]);
});

// ---- `none` — the zero-cardinality consumer ---------------------------------

test("none { … } is true iff the block yields no rows — the complement of exists", () => {
  assert.deepEqual(owners(oqx`owner from ${accounts} where orders none { where amount > 200 }`), ["x"]);
  assert.deepEqual(
    oqx`owner from ${accounts} where orders none { where amount > 200 }`,
    oqx`owner from ${accounts} where !orders exists { where amount > 200 }`,
  );
  // universal quantification is `none` over the complement: every job at Globocorp
  assert.deepEqual(oqx`name values from ${people} where jobs none { where employer != "Globocorp" }`, ["Bob", "Carol"]);
  // an empty relation has no rows, so none {} is true
  assert.deepEqual(oqx`name values from ${players} where scores none { }`, ["Cid"]);
});

test("none as the whole-query consumer returns a boolean", () => {
  assert.equal(oqx`${people} none { where age > 90 }`, true);
  assert.equal(oqx`${people} none { where age > 50 }`, false);
  const r = run(parse("xs none { where $value > 2 }"), { roots: { xs: [1, 2] } });
  assert.deepEqual(r, { consumer: "none", none: true });
});

test("none is a where-position test: not comparable, not a projection", () => {
  assert.throws(() => parse("from people where jobs none { } > 0"), (e: unknown) => e instanceof OqxError && /only count/.test(e.message));
  assert.throws(() => parse("n: jobs none { } from people"), (e: unknown) => e instanceof OqxError && /collect\/first\/single/.test(e.message));
});

// ---- `limit` / `offset` — bounding the row set -------------------------------

test("limit/offset bound the ordered top-level result", () => {
  assert.deepEqual(oqx`name values from ${people} order by age desc limit 2`, ["Alice", "Bob"]);
  assert.deepEqual(oqx`name values from ${people} order by age desc limit 1 offset 1`, ["Bob"]);
  assert.deepEqual(oqx`name values from ${people} order by age desc offset 1`, ["Bob", "Carol"]);
  assert.deepEqual(oqx`name values from ${people} offset 5`, []);
  assert.deepEqual(oqx`name values from ${people} limit 0`, []);
  // the bound may be a binding
  const n = 1;
  assert.deepEqual(oqx`name values from ${people} where age > 30 order by name limit ${n}`, ["Alice"]);
});

test("the bound applies after where/order/distinct and before the consumer reduces", () => {
  assert.equal(oqx`${people} count { limit 2 }`, 2);
  assert.equal(oqx`${people} count { where age > 30 offset 1 }`, 1);
  assert.equal(oqx`${people} exists { offset 2 }`, true);
  assert.equal(oqx`${people} exists { offset 3 }`, false);
  assert.equal(oqx`${people} none { limit 0 }`, true);
  assert.equal(oqx`${people} first { name values order by age offset 1 }`, "Bob"); // the second-youngest
  assert.equal(oqx`${people} single { name values order by age desc limit 1 }`, "Alice"); // limit 1 makes single safe
  const jobs = people.flatMap((p) => p.jobs);
  assert.deepEqual(oqx`select distinct employer values from ${jobs} limit 1`, ["Globocorp"]);
  assert.deepEqual(oqx`select distinct employer values from ${jobs} offset 1`, ["Initech"]);
});

test("limit/offset inside nested blocks, evaluated in the enclosing scope", () => {
  assert.deepEqual(
    oqx`name, latest: jobs collect { employer values order by start_date desc limit 1 } from ${people}`,
    [{ name: "Bob", latest: ["Globocorp"] }, { name: "Alice", latest: ["Globocorp"] }, { name: "Carol", latest: ["Globocorp"] }],
  );
  assert.deepEqual(oqx`name values from ${people} where jobs count { limit 1 } == 1`, ["Bob", "Alice", "Carol"]);
  assert.deepEqual(oqx`name values from ${people} where jobs exists { offset 1 }`, ["Bob", "Alice"]); // ≥ 2 jobs
  assert.deepEqual(oqx`name values from ${people} where jobs none { offset 1 }`, ["Carol"]);
  // `^n` reads the enclosing row: each player's top-n scores where n is their own field
  const ranked = [{ name: "A", n: 2, scores: [5, 9, 1] }, { name: "B", n: 1, scores: [7, 3] }];
  assert.deepEqual(
    oqx`name, top: scores collect { $value values order by $value desc limit ^n } from ${ranked}`,
    [{ name: "A", top: [9, 5] }, { name: "B", top: [7] }],
  );
});

test("limit/offset compose with follow (bounding the walk's ordered occurrences)", () => {
  const tree = [{ id: "root", children: [{ id: "a", children: [{ id: "a1", children: [] }] }, { id: "b", children: [] }] }];
  assert.deepEqual(oqx`id values from ${tree} follow children order by $depth, id limit 2`, ["root", "a"]);
  assert.deepEqual(oqx`id values from ${tree} follow children order by $depth, id offset 3`, ["a1"]);
});

test("limit/offset must be non-negative integers; a field named limit is still a field", () => {
  assert.throws(() => oqx`name from ${people} limit ${-1}`, (e: unknown) => e instanceof OqxError && /non-negative integer/.test(e.message));
  assert.throws(() => oqx`name from ${people} offset ${"2"}`, (e: unknown) => e instanceof OqxError && /non-negative integer/.test(e.message));
  assert.throws(() => oqx`name from ${people} limit ${1.5}`, (e: unknown) => e instanceof OqxError);
  assert.throws(() => parse("name from people limit 1 limit 2"), (e: unknown) => e instanceof OqxError && /duplicate `limit`/.test(e.message));
  assert.deepEqual(oqx`limit from ${[{ limit: 3 }]}`, [{ limit: 3 }]);
  assert.deepEqual(oqx`from ${[{ limit: 3 }, { limit: 1 }]} where limit > 2`, [{ limit: 3 }]);
});

// ---- `entries()` + `$key` — the explicit record → collection bridge -----------

const settings = { theme: "dark", fontSize: 14, autosave: true };

test("entries(object) yields entry scopes exposing $key and $value", () => {
  assert.deepEqual(
    oqx`key: $key, value: $value from entries(${settings})`,
    [{ key: "theme", value: "dark" }, { key: "fontSize", value: 14 }, { key: "autosave", value: true }],
  );
  assert.deepEqual(oqx`$key values from entries(${settings})`, ["theme", "fontSize", "autosave"]);
  assert.deepEqual(oqx`$value values from entries(${settings}) where $key != "theme"`, [14, true]);
  // the scope's row IS the value: a bare projection returns the values
  assert.deepEqual(oqx`from entries(${settings})`, ["dark", 14, true]);
});

test("bare names inside an entry scope navigate the property's VALUE", () => {
  const flags = { beta: { on: true, since: 2 }, legacy: { on: false, since: 1 } };
  assert.deepEqual(oqx`$key values from entries(${flags}) where on`, ["beta"]);
  assert.deepEqual(oqx`name: $key, since from entries(${flags}) order by since`, [{ name: "legacy", since: 1 }, { name: "beta", since: 2 }]);
});

test("plain objects still do not auto-iterate; entries() is the explicit opt-in", () => {
  assert.deepEqual(oqx`from ${settings}`, [settings]); // one row: the object itself
  assert.equal(oqx`${settings} count { }`, 1);
  assert.equal(oqx`entries(${settings}) count { }`, 3);
});

test("entries of arrays give numeric index keys; Map, null, and scalars", () => {
  assert.deepEqual(oqx`k: $key, v: $value from entries(${["x", "y"]})`, [{ k: 0, v: "x" }, { k: 1, v: "y" }]);
  assert.deepEqual(oqx`$key values from entries(${new Map([["a", 1], ["b", 2]])})`, ["a", "b"]);
  assert.deepEqual(oqx`from entries(${null})`, []);
  assert.deepEqual(oqx`from entries(${42})`, []);
  assert.deepEqual(oqx`from entries(${"str"})`, []);
});

test("$key is entry-scope-only: absent on ordinary rows and array elements", () => {
  assert.deepEqual(oqx`k: $key from ${[10, 20]}`, [{ k: undefined }, { k: undefined }]);
  assert.deepEqual(oqx`k: $key from ${people} where name == "Bob"`, [{ k: undefined }]);
});

test("entries() as a nested receiver, and ^$key / ^$value from inside an entry scope", () => {
  const users = [
    { name: "Ann", prefs: { dark: true, compact: false } },
    { name: "Ben", prefs: { dark: false } },
    { name: "Cid", prefs: {} },
  ];
  assert.deepEqual(oqx`name, on: entries(prefs) collect { $key values where $value } from ${users}`,
    [{ name: "Ann", on: ["dark"] }, { name: "Ben", on: [] }, { name: "Cid", on: [] }]);
  assert.deepEqual(oqx`name values from ${users} where entries(prefs) exists { where $key == "dark" && $value }`, ["Ann"]);
  assert.deepEqual(oqx`name values from ${users} where entries(prefs) none { }`, ["Cid"]);
  assert.equal(oqx`${users} count { where entries(prefs) count { } >= 2 }`, 1);
  // inside an entry scope, `^$key` / `^$value` reach the enclosing entry
  const groups = { a: [1, 2, 3], b: [5] };
  assert.deepEqual(
    oqx`g: $key, big: $value collect { $value values where $value > 1 } from entries(${groups})`,
    [{ g: "a", big: [2, 3] }, { g: "b", big: [5] }],
  );
  assert.deepEqual(
    oqx`$key values from entries(${groups}) where $value exists { where $value > 4 && ^$key == "b" }`,
    ["b"],
  );
});

test("entries() as a plain value is an array of { key, value } records", () => {
  assert.deepEqual(oqx`e: entries(prefs) from ${[{ prefs: { x: 1 } }]}`, [{ e: [{ key: "x", value: 1 }] }]);
  assert.deepEqual(execute("e: entries(s) values from xs", { xs: [{ s: { a: 1, b: 2 } }] }), [[{ key: "a", value: 1 }, { key: "b", value: 2 }]]);
});

test("entries compose with order/limit/distinct and a follow seed keeps its $key", () => {
  assert.deepEqual(oqx`$key values from entries(${settings}) order by $key limit 2`, ["autosave", "fontSize"]);
  assert.deepEqual(oqx`select distinct $value values from entries(${{ a: 1, b: 1, c: 2 }})`, [1, 2]);
  const forest = { left: { id: "L", children: [{ id: "L1", children: [] }] }, right: { id: "R", children: [] } };
  assert.deepEqual(
    oqx`id, root: $key from entries(${forest}) follow children order by $ordinal`,
    [{ id: "L", root: "left" }, { id: "R", root: "right" }, { id: "L1", root: undefined }],
  );
});

