# @omgbase/oqx

**Generic Object Query eXpression engine for JavaScript.**

OQX is a small query language for querying ordinary in-memory JavaScript objects
and collections — arrays of records, nested relations, recursive trees — with a
readable, declarative syntax. This package is the **generic collection kernel**:
the OQX language semantics separated from any particular data model, exposed as a
JavaScript tagged template.

```js
import { oqx } from "@omgbase/oqx";

const people = [
  { name: "Bob", id: 124, title: "Engineer",
    jobs: [{ employer: "Globocorp", start_date: "1984/05/01", end_date: "1990/01/01" },
           { employer: "Globocorp", start_date: "2001/03/01" }] },
  // …
];
const company = "Globocorp";

const employees = oqx`
  name, id, title
  from ${people}
  where jobs exists { employer == ${company} && !end_date }
`;
// → [{ name: "Bob", id: 124, title: "Engineer" }, …]  (current Globocorp employees)
```

## Why a tagged template

Interpolations cross the host/OQX boundary as **typed value bindings, never as
source text** — prepared-statement semantics. A `${…}` in `from` position is the
collection being queried; a `${…}` in a predicate is an ordinary host value.
Because values are never spliced into the query text, they cannot alter the
grammar and there is no injection surface. The compiled query is cached by the
template's identity and re-runs with fresh bindings each call.

## Language tutorial

A query has, in spirit, the shape below — but at the top level the clauses are
**order-flexible**, so you can lead with the projection (SQL-style) or with
`from`, whichever reads better:

```
[ [select] projection ]    name, id, title: label
from <collection>          from ${people}
[ where <predicate> ]      where age >= 18 && jobs exists { !end }
[ order by <expr> … ]      order by age desc, name
[ follow <relation> … ]    follow children { depth 4 }
```

The examples below all use this dataset:

```js
const people = [
  { name: "Bob",   id: 124, title: "Engineer", active: true,  age: 41, city: "NYC",
    jobs: [{ employer: "Globocorp", start: "1984", end: "1990" },
           { employer: "Globocorp", start: "2001" }] },
  { name: "Alice", id: 7,   title: "Director", active: true,  age: 52, city: "SF",
    jobs: [{ employer: "Initech",   start: "1999", end: "2005" },
           { employer: "Globocorp", start: "2010", end: "2015" }] },
  { name: "Carol", id: 55,  title: "Analyst",  active: false, age: 29, city: "NYC",
    jobs: [{ employer: "Globocorp", start: "2020" }] },
];
```

### 1. Source: `from`

Every query reads from a source collection. In the tagged template the source is
normally an interpolated value; it may also be a named root or a navigation (see
[data context](#data-context-string-queries-and-named-roots)).

```js
oqx`name from ${people}`;
// [{ name: "Bob" }, { name: "Alice" }, { name: "Carol" }]
```

### 2. Projection (select)

List the fields to keep. With **no** projection you get the raw rows unchanged.

```js
oqx`name, id from ${people}`;
// [{ name: "Bob", id: 124 }, { name: "Alice", id: 7 }, { name: "Carol", id: 55 }]

oqx`from ${people} where active`;                 // no projection → whole objects
// [ <Bob>, <Alice> ]
```

A projection item can be:

- a **bare field** — `name`;
- a **dotted navigation**, keyed by its last segment — `meta.slug` produces
  `{ slug: … }`;
- an **alias / value expression** — `label: name`, `decade: age / 10`;
- a **nested collection** — `current: jobs collect { … }` (see §6).

```js
oqx`label: name, decade: age / 10 from ${people} where name == "Bob"`;
// [{ label: "Bob", decade: 4.1 }]
```

The `select` keyword is optional and works in any position — `select name from …`
is identical to `name from …`. (It's the hook for a future `select distinct`.)

### 3. Predicates (where)

`where` filters rows. The predicate language has comparisons (`== != < <= > >=`),
boolean operators (`&& || !`) with grouping `( )`, membership (`in`), arithmetic
(`+ - * / %`), and bare truthiness. The `where` keyword is optional when the
leading expression is clearly a predicate.

```js
const min = 40;
oqx`name from ${people} where age >= ${min}`;      // → Bob, Alice
oqx`name from ${people} where city in ${["SF", "LA"]}`;   // → Alice
oqx`name from ${people} where !active`;            // → Carol
```

Equality is **typed and strict** (`5 == "5"` is false); a comparison against an
absent (`null`/`undefined`) field is simply false rather than an error.

**Ranges.** A Ruby-style range `lo..hi` (inclusive) or `lo...hi` (exclusive high
end) is a value, used most often as the right side of `in`. Either bound may be
omitted for an open-ended range (`..hi`, `lo..`). Bounds compare with the same
ordering rules as `<`/`<=`, so ranges work over numbers and over ISO-8601
date/time strings alike:

```js
oqx`name from ${people} where age in 40..50`;   // 40 ≤ age ≤ 50
oqx`name from ${people} where age in 40...50`;  // 40 ≤ age < 50 (excludes 50)
oqx`name from ${people} where age in 40..`;     // 40 and up
oqx`name from ${people} where age in ..29`;     // up to and including 29
oqx`label from ${events} where on in "2026-01-01".."2026-03-31"`;   // dates in Q1
```

Bounds may be interpolated (`where age in ${lo}..${hi}`). A range membership is
not pushed into a storage backend — it is finished in-memory over the rows the
backend returns — so it always evaluates by the rules above.

**Interpolations are always values, never syntax.** `where name == ${x}` compares
against the value of `x`; a string in `x` can't inject operators or identifiers.

**Bindings & scoping.** A bare identifier resolves against the current row, and if
absent it **climbs to enclosing rows** — lexical outer references, for free:

```js
const accounts = [
  { owner: "x", budget: 100, orders: [{ amount: 50 }, { amount: 150 }] },
  { owner: "y", budget: 200, orders: [{ amount: 250 }] },
];
oqx`owner from ${accounts} where orders exists { amount > budget }`;
// [{ owner: "x" }, { owner: "y" }]   — `budget` climbs from the order to the account
```

A `.member` access does **not** climb — it always navigates the value on its left.

**Explicit outer references (`^`).** Implicit climbing only reaches an outer field
when the inner row *doesn't* have that name. When both scopes share a name, the
inner one shadows the outer, and you reach past it with `^name` ("one scope out",
`^^name` for two). This is what makes correlated subqueries work — e.g. each
person's siblings, where both the person and the candidates have a `parent`:

```js
const family = [
  { name: "Ada", parent: "Pat" },
  { name: "Ben", parent: "Pat" },
  { name: "Cy",  parent: "Sam" },
];
oqx`
  name,
  siblings: ${family} collect { name where parent == ^parent && name != ^name }
  from ${family}
`;
// [{ name: "Ada", siblings: [{ name: "Ben" }] },
//  { name: "Ben", siblings: [{ name: "Ada" }] },
//  { name: "Cy",  siblings: [] }]
```

Here `parent` is the inner candidate's parent while `^parent` is the outer
person's. (`^` in an expression *reads* one scope out; the same `^` as a
select-item prefix — `^name: …` in §7 — *binds* one scope out. Both mean "one
scope out.")

### 4. Built-in functions

Methods on a value: `contains`, `startsWith`, `endsWith`, `matches` (regex),
`size`, `lower`, `upper`. Free functions: `list(x)` (coerce to an array), `size(x)`,
`has(x)`.

```js
oqx`name from ${people} where title.startsWith("Eng")`;      // → Bob
oqx`name from ${people} where title.lower() == "director"`;  // → Alice
```

### 5. Consumers

A consumer shapes a result set. There are five:

| Consumer  | Returns                        |
| --------- | ------------------------------ |
| `collect` | an array (the default)         |
| `exists`  | a boolean                      |
| `count`   | a number                       |
| `first`   | one record, or `null`          |
| `single`  | one record, or `null`; throws if more than one matches |

The bare `from … ` form is always `collect`. To reduce the **whole** query with a
different consumer, use the directive form `<source> <consumer> { <body> }` — note
this is *not* SQL: `count from people` would project a field called `count`, whereas
a real reduction is a directive:

```js
oqx`${people} exists { where active }`;            // true
oqx`${people} count { where active }`;             // 2
oqx`${people} first { name where age > 50 }`;      // { name: "Alice" }
```

(Inside a consumer block a bare identifier **projects** — `count { active }` selects
a field named `active`; write `count { where active }` to filter.)

### 6. Nested collections and relations

The same consumers work as **postfix directives** over a relation of the current
row — `<relation> <consumer> { <body> }` — both in `where` and in a projection.

In `where`, an `exists { … }` tests non-emptiness and `count { … } <op> N` compares
cardinality:

```js
oqx`name from ${people} where jobs exists { !end }`;   // has a current job → Bob, Carol
oqx`name from ${people} where jobs count {} >= 2`;     // ≥2 jobs → Bob, Alice
```

In a projection, `collect` yields a nested array; `first` / `single` yield one
nested record:

```js
oqx`name, current: jobs collect { employer where !end } from ${people} where name == "Bob"`;
// [{ name: "Bob", current: [{ employer: "Globocorp" }] }]

oqx`name, firstJob: jobs first { employer } from ${people} where name == "Alice"`;
// [{ name: "Alice", firstJob: { employer: "Initech" } }]
```

A relation is just an expression evaluated on the row and coerced to a collection,
so nested blocks compose to any depth and can navigate dotted paths
(`author.books collect { … }`).

**`distinct`** dedups the rows a consumer sees by their **projected value**, so
counts and collections are over distinct projections rather than raw rows. Spell
it after the consumer (`count distinct { … }`) or inside via `select distinct`:

```js
oqx`from ${jobs} select distinct employer`;            // distinct employers
oqx`n: jobs collect distinct { select employer } from ${people}`; // per person, unique employers
oqx`name from ${people} where jobs count distinct { select employer } == 1`; // worked at exactly one employer
```

An empty projection dedups by row identity (`count distinct { }` = distinct rows).

### 7. Lifts (`^`)

Sometimes you want to filter by a nested collection *and* keep a value from it.
A `^name:` item inside a `collect { … }` that sits directly in the top-level
`where` does both: it filters (non-empty) and binds `name` into the outer
projection as a per-row array.

```js
oqx`
  name, currentEmployers
  from ${people}
  where jobs collect { ^currentEmployers: employer where !end }
`;
// [{ name: "Bob", currentEmployers: ["Globocorp"] },
//  { name: "Carol", currentEmployers: ["Globocorp"] }]
```

**Multi-level lifts (`^^`, `^^^`).** The caret count is how many scopes the value
binds *out* — `^` to the immediate enclosing projection, `^^` two out, and so on
(the mirror image of the `^`-read in §3). When a deeper lift fires repeatedly as
an intermediate collection fans out, its values **flatten-append** into one flat
list at the target scope — "every matching value from the subtree, N scopes out":

```js
const departments = [
  { name: "Eng",   teams: [{ id: "t1", members: [{ name: "Ada" }, { name: "Ben" }] },
                           { id: "t2", members: [{ name: "Cy" }] }] },
  { name: "Sales", teams: [{ id: "t3", members: [{ name: "Dee" }] }] },
];
oqx`
  name, teamIds, allMembers
  from ${departments}
  where teams collect { ^teamIds: id where members collect { ^^allMembers: name } }
`;
// [{ name: "Eng",   teamIds: ["t1", "t2"], allMembers: ["Ada", "Ben", "Cy"] },
//  { name: "Sales", teamIds: ["t3"],       allMembers: ["Dee"] }]
```

`^teamIds` (one out) and `^^allMembers` (two out) bind to the same department row
at once. Because accumulation happens as each intermediate collection is
iterated, the intermediate scopes must be `collect`/`count` bodies (which iterate
fully), not a short-circuiting `exists`.

### 8. Ordering

`order by <expr> [asc|desc]`, comma-separated for tie-breaks. Absent values sort
last.

```js
oqx`name from ${people} where city == "NYC" order by age desc`;
// [{ name: "Bob" }, { name: "Carol" }]
```

### 9. Recursion: `follow`

`follow <relation>` turns a query into a bounded recursive traversal: the `where`
selects the seed rows, and `follow` walks a relation from each reached row. It's
fully duck-typed — the relation is any expression yielding successors; a row that
lacks it is simply a leaf.

```js
const tree = [{ id: "root", children: [
  { id: "a", children: [{ id: "a1", children: [] }] },
  { id: "b", children: [] },
]}];

oqx`id, depth: $depth from ${tree} follow children order by $depth, id`;
// [{ id: "root", depth: 1 }, { id: "a", depth: 2 }, { id: "b", depth: 2 }, { id: "a1", depth: 3 }]
```

Reached rows expose recursion **intrinsics** in `select` / `order by`:
`$depth` (1-based), `$leaf` (no successors), `$frontier` (there is unfollowed
graph beyond — a boundary or the depth cap), `$ordinal` (a deterministic 1..N
rank over the walk, ordered by depth then path), and `$stop`
(`"interior"` / `"leaf"` / `"frontier"` / `"depth"` / `"cycle"`, precedence
cycle > frontier > depth > leaf > interior — only `interior` rows expand). Options
go in a trailing block:

```js
oqx`id, stop: $stop from ${tree} follow children { depth 2 } order by $ordinal`;
// a1 is never reached; a and b report stop:"depth"
```

The walk is **per-path**: a node reached by N distinct paths yields N
occurrences, and revisiting an identity already on the current path is admitted
**once** as `$stop == "cycle"` and never re-expanded, so cycles terminate without
runaway. `follow distinct` collapses occurrences to reached nodes (the minimal
`(depth, path)` per identity).

The block accepts: `where <succ>` (which successors keep participating),
`frontier <pred>` (cut a relation that could continue), `depth <n>` (1–8), and
`by <expr>` (the identity used for cycle detection + `distinct` — default `.id`
or the object reference). Give `follow` a stable identity (`.id` or `by`) when
your relation returns fresh objects rather than shared references.

### Cheat-sheet

```
name, alias: expr, nested: rel collect { … }   projection (select optional)
from ${source}                                  source collection
where a == b && rel exists { … } || !c          predicate tree + nested ops
where x in lo..hi / lo...hi / ..hi / lo..        range membership (incl. / excl. / open-ended)
^name / ^^name                                   read an outer row's field (N scopes out)
^name: expr  /  ^^name: expr                     lift/export a value N scopes out (flatten-append)
order by expr desc, expr2                        ordering
follow rel { where … frontier … depth n by … }  recursion ($depth/$stop/$leaf/$frontier)
${source} <collect|exists|count|first|single> { … }   whole-query consumer
```

## Data context: string queries and named roots

When you don't need interpolation, `execute` runs a plain string query against a
**data context** of named roots:

```js
import { execute } from "@omgbase/oqx";

execute("name from people where age >= 18", { people });
// `from people` resolves the `people` root
```

`parse(source)` returns a reusable AST and `run(query, { values, roots })` returns
the full discriminated result (`{ consumer, … }`).

## Architecture: adapting to other storage & query systems

OQX is layered so it can be the front-end for query systems far beyond in-memory
objects. The parsed `Query` AST is the host-agnostic IR; execution is pluggable.

```
Query AST  ─┬─ InMemoryEngine(DataContext)     tier 1/2 — drive any data model
            └─ PlannedEngine(QueryPlanner)      tier 3   — push work into a store
                   └─ finishes the residual on the in-memory engine
```

**Everything obeys one scalar-semantics contract** (`oqx.semantics`): typed/strict
equality (`5 == "5"` is false), absent operands make ordering comparisons false,
CEL-style `in`, absent-last sort order. Any backend that can't reproduce a rule
in its native language must leave that fragment as an in-memory *residual* rather
than approximate it. The conformance suite verifies this.

### Tier 2 — a custom `DataContext` (bind any data model)

The engine never touches host objects directly; it asks a `DataContext` to
resolve named roots, read properties/relations, coerce results to rows, and
compute identity. Implement it to query an ORM graph, a remote API, or lazily
loaded relations — the query *semantics* stay in OQX:

```js
import { parse, run } from "@omgbase/oqx";

const graph = {
  root: (name) => name === "tree" ? [nodes.get(1)] : undefined,
  get:  (row, key) => key === "children" ? row.childIds.map(id => nodes.get(id)) : row[key],
  has:  (row, key) => key === "children" || key in row,   // declare computed relations
  toRows: (v) => v == null ? [] : Array.isArray(v) ? v : [v],
  identity: (row) => row.id,                                // for follow dedup
};
run(parse("id, depth: $depth from tree follow children"), { context: graph });
```

### Tier 3 — a `QueryPlanner` (pushdown + planning)

A planner translates as much of a query as it can into its store's native query
and returns the produced rows plus a **residual** `Query` for the rest. The
in-memory engine finishes the residual, so a planner can be as partial as it
likes and stay correct. Two adapters ship:

- `IndexedCollection` — hash-indexes a collection and answers equality predicates
  from the index instead of scanning, leaving other predicates as residual.
- `@omgbase/oqx/sqlite` — real pushdown to a `node:sqlite` database: the flat query core
  (scan + translatable conjunctive predicates, `LIMIT` for unordered
  `first`/`single`) becomes SQL; `matches()`, nested consumer ops, `follow`, etc.
  fall back to the in-memory residual.

```js
import { parse, PlannedEngine } from "@omgbase/oqx";
import { SqliteTable } from "@omgbase/oqx/sqlite";

const planner = new SqliteTable(db, "emp", { columns: ["id", "name", "dept", "level"] });
new PlannedEngine(planner).run(parse('name from emp where dept == "eng" && level >= 5'), []);
// → `dept`/`level` pushed to SQL; anything untranslatable finishes in-memory
```

This is the seam an omgbase adapter uses: its existing OQX→SQL compiler (docs/
blocks/nodes, the relations table, `$` intrinsics, `WITH RECURSIVE` for `follow`)
becomes a `QueryPlanner`, while oqx-js contributes the parser, IR, semantics
contract, and residual executor.

## Requirements

Node 22.6+ (the sources are TypeScript, run natively via type-stripping — the
package has **no runtime dependencies**). `npm test` runs the suite; `npm run
typecheck` typechecks.

## Relationship to omgbase

This is tier 1 (the in-memory object/collection interpreter) of the OQX
implementation tiers. The language kernel here is host-agnostic; richer hosts
(e.g. omgbase's docs/blocks/nodes with index pushdown) layer data-model
vocabulary and execution capabilities on top of the same surface syntax.
