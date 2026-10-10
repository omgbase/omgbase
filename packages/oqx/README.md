# @omgbase/oqx

**Generic Object Query eXpression engine for JavaScript.**

OQX is a small query language for querying ordinary in-memory JavaScript objects
and collections — arrays of records, nested relations, recursive trees — with a
readable, declarative syntax. This package is the **generic collection kernel**:
the OQX language semantics separated from any particular data model, exposed as a
JavaScript tagged template.

> **Where this lives.** `@omgbase/oqx` is part of the
> [omgbase monorepo](https://github.com/omgbase/omgbase) at `packages/oqx`, but it
> is published independently under its own version line and has **zero runtime
> dependencies** — it is usable without omgbase, and omgbase code is never
> imported here (omgbase binds it from the outside via the `DataContext` seam).
> OQX is a language with more than one implementation; the specification is
> [`spec/oqx`](https://github.com/omgbase/omgbase/tree/main/spec/oqx). The
> language version is the package version's `major.minor` (`LANGUAGE_VERSION`,
> `"0.17"`); the patch digit is this implementation's own.
> Requirements: Node ≥ 22.13 for `@omgbase/oqx/sqlite`; Node ≥ 22.18 to run the
> test suite (see [Requirements](#requirements)).

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
  where jobs exists { where employer == ${company} && !end_date }
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

A query is a list of clauses in a **fixed order**. Each clause appears at most
once, and every one is optional except `from` at the top level:

```
[ [select] projection ]    name, id, title: label        (or: select distinct …, … values)
from <collection>          from ${people}
[ where <predicate> ]      where age >= 18 && jobs exists { where !end }
[ follow <dest>, … ]       follow children { depth 4 }     (or: follow before, after; follow ^people collect { … })
[ order by <expr> … ]      order by age desc, name
[ limit N ]                limit 10
[ offset N ]               offset 20
```

**`select` is the only keyword you may drop, and only when the projection comes
first** (`name, id from ${people}`). Every other clause always carries its
keyword — with one piece of sugar (0.17): a **block** whose leading expression
is syntactically a predicate is a `where`-first body (`jobs exists { !end }` ≡
`jobs exists { where !end }`; a bare name still projects, so `jobs { employer }`
projects and `jobs { is current }` filters — see §10). At the top level a
predicate always needs `where`, and `from ${people} count` is an error rather
than a projection of a field called `count`. Writing a clause out of
order is a parse error that names the order (`` `select` must come before
`from` — OQX clause order is select, from, where, follow, order by, limit,
offset ``). The same body grammar applies inside every consumer block
(`collect { … }`, `exists { … }`, …), where `from` is optional because the
receiver supplies the rows.

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

An item that is not a plain navigation — a call, arithmetic, a comparison — has
no natural key, so it must be aliased (`n: size(jobs)`), unless the projection is
in `values` mode (next).

The `select` keyword may be dropped when the projection is the first clause —
`select name from …` is identical to `name from …`. The keyword form hosts
`select distinct` (§6), and is the only way to write a projection whose first
item would otherwise be misread (there is no other keyword-less clause). The
projection always comes *before* `from`: `from ${people} select name` is an
ordering error.

**`values` — scalar projection.** Ordinarily every row projects to a record. Add
`values` after a projection of exactly **one** item to get the value itself:

```js
oqx`name values from ${people}`;                       // ["Bob", "Alice", "Carol"]
oqx`name.upper() values from ${people} where age < 30`; // ["CAROL"]  (no alias needed)
oqx`${people} first { name values where age > 50 }`;    // "Alice"
```

`values` is a result-shape mode, not a consumer: it works in the top-level
projection and inside any `collect` / `first` / `single` block, and composes with
`distinct` (`select distinct employer values from ${jobs}` is the distinct set of
employers as strings, not `{ employer }` records). An alias, if present, is
ignored; a lift (`^name:`) cannot be combined with it.

**`$it` — the current item.** Every scope has a current value; `$it` is
that exact value, whatever its type (an object row or a plain scalar). Bare names
still navigate it (`name` ≡ `$it.name`), so `$it` matters exactly where
there is nothing to navigate: collections of numbers or strings, or handing the
whole row somewhere. Together with `values` this makes scalar collections
first-class:

```js
const scores = [10, 60, 70, 45];
oqx`$it values from ${scores} where $it > 50`;              // [60, 70]
oqx`$it values from ${scores} order by $it desc`;           // [70, 60, 45, 10]

const players = [{ name: "Ann", scores: [10, 60, 70] }, { name: "Ben", scores: [45] }];
oqx`name, big: scores collect { $it values where $it > 50 } from ${players}`;
// [{ name: "Ann", big: [60, 70] }, { name: "Ben", big: [] }]

oqx`employee: $it from ${people} where name == "Bob"`;         // [{ employee: <Bob> }]
```

Inside a nested block `$it` is the inner item; the enclosing row is `^$it`
(§3). At the root scope (before any row) it is absent. `$it` is the only name
for the current item (language 0.15; through 0.14 it was spelled `$value`, and
there is no synonym): `$value` is now an ordinary property read, like any other
non-metadata `$name` — a row `{ "$value": 3 }` projects `3`, a row without one
reads absent. A row that itself owns a `$it` property is shadowed by the
intrinsic; reach it with `^` from a nested scope or rename it upstream.

**`entries(x)` and `$key` — records to collections, explicitly.** A plain object
is **not** iterable: `from ${obj}` is one row (the object). `entries(obj)`
converts it into a collection of entries, and inside such a scope the current
item is the property's **value** — `$it` and bare names read it — while
**`$key`** is the property's key:

```js
const settings = { theme: "dark", fontSize: 14, autosave: true };
oqx`key: $key, value: $it from entries(${settings})`;
// [{ key: "theme", value: "dark" }, { key: "fontSize", value: 14 }, { key: "autosave", value: true }]
oqx`$key values from entries(${settings}) where $it != "dark"`;   // ["fontSize", "autosave"]

const flags = { beta: { on: true }, legacy: { on: false } };
oqx`$key values from entries(${flags}) where on`;                    // ["beta"]  (bare `on` reads the value)

oqx`name, on: entries(prefs) collect { $key values where $it } from ${users}`;   // as a nested receiver
oqx`name from ${users} where entries(prefs) exists { where $key == "dark" && $it }`;
```

`entries(array)` yields numeric index keys, a `Map` yields its entries, and
absence/scalars yield nothing. `$key` exists **only** in an entry scope — an
ordinary row or array element has no implicit index; `entries(arr)` is how you
ask for one. As a plain value (not a source) `entries(x)` is an array of
`{ key, value }` records.

### 3. Predicates (where)

`where` filters rows. The predicate language has comparisons (`== != < <= > >=`),
boolean operators (`&& || !`) with grouping `( )`, membership (`in`), arithmetic
(`+ - * / %`), and bare truthiness. The `where` keyword is always written — a
leading expression without it is a projection, and a bare comparison in that
position is an error that points you at `where`.

```js
const min = 40;
oqx`name from ${people} where age >= ${min}`;      // → Bob, Alice
oqx`name from ${people} where city in ${["SF", "LA"]}`;   // → Alice
oqx`name from ${people} where !active`;            // → Carol
```

Equality is **typed and strict** (`5 == "5"` is false); a comparison against an
absent (`null`/`undefined`) field is simply false rather than an error.

**String literals** may be double- or single-quoted (`"NYC"` / `'NYC'`) and
support backslash escapes: `\n`, `\t`, `\r`, `\0`, and `\<any other char>`
for that character itself (`\"`, `\'`, `\\`). An unterminated string is a lex
error. Note that inside the `oqx` tagged template JavaScript resolves its own
escapes first (the template's cooked strings are what OQX lexes), so `\\n` in
your source reaches OQX as `\n`. Usually you don't need any of this —
interpolate the host value instead (`where name == ${name}`).

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

When a range arrives as string **data** rather than as a literal, `range(s)`
coerces it: `where "2026-02-14" in range(window)` reads `window`'s string
(`"2026-01-01..2026-01-31"`) as a range and tests coverage. A bare field stays a
plain string (`window == "…"` compares text) — `range(...)` is the explicit
opt-in, so a value that merely looks rangey is never silently reinterpreted. A
non-range string yields an absent range, so `x in range(bad)` is just false.

**Interpolations are always values, never syntax.** `where name == ${x}` compares
against the value of `x`; a string in `x` can't inject operators or identifiers.

**`where` sees the `select` aliases.** A name defined in the same body's
projection may be used in its `where`; an alias shadows a same-named field
there. The alias's expression is substituted inline before evaluation
(`resolveAliases`, applied once by the run entry points — the parsed tree keeps
what you wrote), so it costs nothing at run time and a storage planner still
sees an ordinary predicate:

```js
oqx`select name, adult: age >= 18 from ${people} where adult`;        // ≡ where age >= 18
oqx`select name, active: age > 50 from ${people} where active`;       // the ALIAS, not the field → Alice
oqx`select name, current: jobs collect { employer where !end } from ${people} where current`;
// a collect alias in predicate position means "non-empty" → Bob, Carol
```

Inside an alias's own expression its name is still the field
(`name: name.upper()` is not recursive); a chain of aliases that comes back to
itself (`a: b, b: a … where a`) is a parse error. Each block rewrites only
against its *own* `select`; `^name` always reads an enclosing row's field, never
an alias. `order by` is not rewritten — it reads row fields (§8).

**Scoping: bare names are local, `^` reaches out.** A bare identifier resolves
against the **current row only**. If the row lacks that property the value is
absent — it never falls through to an enclosing row. To correlate with an
enclosing scope you say so explicitly with `^name` ("exactly one scope out";
`^^name` for two, and so on):

```js
const accounts = [
  { owner: "x", budget: 100, orders: [{ amount: 50 }, { amount: 150 }] },
  { owner: "y", budget: 200, orders: [{ amount: 250 }] },
];
oqx`owner from ${accounts} where orders exists { where amount > ^budget }`;
// [{ owner: "x" }, { owner: "y" }]   — `^budget` is the enclosing account's budget

oqx`owner from ${accounts} where orders exists { where amount > budget }`;
// []   — a bare `budget` is the ORDER's own budget: absent, so `>` is false
```

Every reference is therefore decidable from the query text alone. Adding a
`budget` field to the order rows later cannot change what `^budget` means, and a
typo can't silently capture an outer field. Present-but-falsy values (`null`,
`false`, `0`, `""`) are read like any other local value — there is no "absent, so
look outward" rule to trip over — and `^` always reads *exactly* N scopes out
(one past the root is absent, not the nearest match).

A `.member` access always navigates the value on its left. Named roots (see
[data context](#data-context-string-queries-and-named-roots)) live on the
*root* scope, one out from a top-level row: `^people` from a person row, `^^people`
from a row nested one level deeper. A receiver may start with `^` too, which is
how a nested consumer runs over a named root or an enclosing row's relation:

```js
execute("name, peers: ^people collect { name where city == ^city && name != ^name } from people", { people });
```

**Correlated subqueries.** Because inner and outer rows often share names, the
explicit `^` is what makes correlation unambiguous — e.g. each person's
siblings, where both the person and the candidates have a `parent`:

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
scope out.") A value bound into a scope by a lift is read there as a bare name,
like a row property.

### 4. Built-in functions

Methods on a value: `contains`, `startsWith`, `endsWith`, `matches` (regex),
`size`, `lower`, `upper`. Free functions: `list(x)` (coerce to an array), `size(x)`,
`has(x)`, `range(s)` (§3), `entries(x)` (§2).

```js
oqx`name from ${people} where title.startsWith("Eng")`;      // → Bob
oqx`name from ${people} where title.lower() == "director"`;  // → Alice
oqx`name from ${people} where has(age) && !has(nickname)`;   // present vs absent
oqx`name from ${people} where tags.contains("admin")`;       // array membership
```

- `has(x)` is true when `x` is **present** — anything other than `null` /
  `undefined`. `has(0)`, `has("")`, and `has(false)` are all true; use bare
  truthiness (`where active`) when you mean truthy.
- `.contains(v)` works on strings (substring) **and arrays** (an element equal
  to `v` under OQX's strict equality); on anything else it is false.
- `.size()` / `size(x)` is the length of a string or array, the key count of
  an object, and 0 for absent.
- `.matches(re, flags?)` searches the receiver's text for a regular expression
  written in the **OQX regex baseline** (below), unanchored unless the pattern
  anchors. `flags` is an optional string of `i` (case-insensitive), `m` (`^`/`$`
  also at newlines), `s` (`.` also matches `\n`); an absent receiver is `false`.

Anything not in these tables is an **eval error** (`unknown function 'f(…)'` /
`unknown method '.m(…)'`) — see [custom functions](#custom-functions-and-methods)
for adding your own.

#### The regex baseline

OQX is a language with more than one implementation, so `matches()` does not
expose the host's `RegExp`. It compiles a fixed, portable dialect whose every
construct has one spec-defined meaning (`spec/oqx/SEMANTICS.md` §11):

- literals; escaped metacharacters `\. \* \+ \? \( \) \[ \] \{ \} \| \^ \$ \\ \/ \-`;
  `\n \t \r \f \v`; `\uXXXX` (four hex digits) and `\u{X…}` (any code point);
- `\d` = `[0-9]`, `\w` = `[A-Za-z0-9_]`, `\s` = JavaScript's white space (one
  listed set), `\D \W \S` their complements, `\b \B` word boundaries over that
  `\w`; bracket classes `[…]` / `[^…]` with ranges;
- `.` = any code point except `\n` (the line terminator is `\n` alone — `\r`
  is an ordinary character); anchors `^ $`; quantifiers `* + ? {n} {n,} {n,m}`
  and their lazy `?` forms; alternation `|`; groups `(…)`, `(?:…)`, `(?<name>…)`.

Everything else — lookaround, backreferences, inline flags `(?i)`, `\p{…}`,
`\x..`, octal, possessive quantifiers, POSIX classes, `\A \z` … — is an
`OqxError` (stage `eval`) naming the construct: `an inline flag (?i) is not
supported in OQX regular expressions`. A pattern that is malformed within the
baseline is `invalid regular expression …`; a bad flag is `unknown regex flag`
/ `duplicate regex flag`. The pattern is validated and rewritten before
`RegExp` sees it (`src/regex.ts`), so JavaScript-only behavior never leaks.

```js
oqx`name from ${people} where title.matches("^(eng|dir)", "i")`;   // Bob, Alice
oqx`x: "a\nb".matches("a.b") from ${one}`;                         // false: . stops at \n
oqx`x: "a\nb".matches("a.b", "s") from ${one}`;                    // true
oqx`x: "٣".matches(${"\\d"}) from ${one}`;                         // false: \d is ASCII
oqx`x: "é".matches(${"^\\u{e9}$"}) from ${one}`;                   // true
```

A pattern with backslashes is easiest to pass as a binding (`${"\\d"}`): the
template's own escaping and the OQX string literal's `\<c>` escape would each
consume one level otherwise (`"\\\\d"` in the template is `\d` to the regex).

A host that wants JavaScript's own dialect can opt in per context:
`new DefaultContext(roots, { regexDialect: "native" })` hands patterns to
`RegExp` unvalidated (with the `u` flag plus the given flags). That is
implementation-defined and not portable to the Rust implementation.

### 5. Consumers

A consumer shapes a result set. There are six:

| Consumer  | Returns                        |
| --------- | ------------------------------ |
| `collect` | an array (the default)         |
| `exists`  | a boolean — one or more rows   |
| `none`    | a boolean — zero rows (the complement of `exists`) |
| `count`   | a number                       |
| `first`   | one record, or `null`          |
| `single`  | one record, or `null`; throws if more than one matches |

The bare `from … ` form is always `collect`. To reduce the **whole** query with a
different consumer, use the directive form `<source> <consumer> { <body> }` — note
this is *not* SQL: `count from people` projects a field called `count`, and
`from people count` is a parse error that points at the directive form. A real
reduction is a directive:

```js
oqx`${people} exists { where active }`;            // true
oqx`${people} count { where active }`;             // 2
oqx`${people} first { name where age > 50 }`;      // { name: "Alice" }
```

(A consumer block follows the same clause grammar as the top level, with `from`
optional. A leading bare identifier **projects** — `count { active }` selects a
field named `active`; write `count { where active }` to filter, and always write
`where` before a predicate: `exists { !end }` is an error, `exists { where !end }`
is the test.)

### 6. Nested collections and relations

The same consumers work as **postfix directives** over a relation of the current
row — `<relation> <consumer> { <body> }` — both in `where` and in a projection.

In `where`, an `exists { … }` tests non-emptiness and `count { … } <op> N` compares
cardinality:

```js
oqx`name from ${people} where jobs exists { where !end }`;   // has a current job → Bob, Carol
oqx`name from ${people} where jobs count {} >= 2`;     // ≥2 jobs → Bob, Alice
oqx`name from ${people} where jobs none { where end }`; // no past job → Carol
```

`none { … }` is exactly `!… exists { … }`, kept as its own word because the
cardinality is the point. It is also how you say "every": *all* members active is
`members none { where !active }` — there is deliberately no `all { … }`, whose
block would have to mean something different from every other consumer's.

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
oqx`select distinct employer from ${jobs}`;            // distinct employers
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
last. The sort expression reads the row (fields, `$it`, recursion
intrinsics) — it is not rewritten against the `select` aliases, so
`order by decade` sorts by a field called `decade`, not by `decade: age / 10`.

```js
oqx`name from ${people} where city == "NYC" order by age desc`;
// [{ name: "Bob" }, { name: "Carol" }]
```

### 8b. Bounding: `limit` / `offset`

`limit N` and `offset N` bound the row set **after** `where`, `order by`, and
`distinct`, and **before** the consumer reduces it — so they mean the same thing
under every consumer: `count { … limit 5 }` is at most 5, `first { … offset 1 }`
is the second row, `exists { offset 2 }` asks for a third. They work at the top
level and inside any block, and `N` may be a literal, a `${…}` binding, or an
outer reference — `limit ^n` reads the enclosing row's `n`, as `^` does everywhere
inside `{ … }`; it must be a non-negative integer.

```js
oqx`name values from ${people} order by age desc limit 2`;                 // ["Alice", "Bob"]
oqx`name values from ${people} order by age desc limit 1 offset 1`;        // ["Bob"]
oqx`name, latest: jobs collect { employer values order by start desc limit 1 } from ${people}`;
oqx`name from ${people} where jobs exists { offset 1 }`;                   // has a second job
```

A storage adapter that pushes the whole query may translate them to SQL
`LIMIT`/`OFFSET`; the shipped `SqliteTable` leaves them to the residual.

### 9. Recursion: `follow`

`follow <destination>, …` turns a query into a bounded recursive traversal: the
`where` selects the seed rows, and `follow` walks one or more **destinations**
from each reached row. It's fully duck-typed — a relation is any expression
yielding successors; a row that lacks it is simply a leaf.

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

The intrinsics belong to the reached row's own scope like any other name: inside
a nested block (`kids: children collect { … }`) a bare `$depth` is the nested
row's own `$depth` property (absent unless the data carries one), and the
occurrence's depth is `^$depth`. The same holds everywhere the metadata is not
present — outside a `follow`, `$depth`/`$ordinal`/`$stop`/`$leaf`/`$frontier`
are ordinary property reads (a row `{ "$depth": 3 }` projects `3`), and `$key`
is likewise an ordinary property read outside an `entries()` scope. Where the
metadata exists it wins over a same-named property (language 0.13; before, the
six names read absent everywhere they were not metadata).

The walk is **per-path**: a node reached by N distinct paths yields N
occurrences, and revisiting an identity already on the current path is admitted
**once** as `$stop == "cycle"` and never re-expanded, so cycles terminate without
runaway. `follow distinct` collapses occurrences to reached nodes (the minimal
`(depth, path)` per identity).

**Destinations** (language 0.14) are comma-separated; the walk is their union.
A **plain destination** is a relation of the current row (`children`, `doc.out`
— an outer reference `^rel` or a literal is a parse error). A **destination
block** is a receiver followed by `collect`, `first` or `single` (optionally
`distinct`) and a block — the same directive you would write in `select`,
re-evaluated per frontier row with `^` bound to that row. Its receiver *may* be
an outer reference, so a walk can compute successors from a named root:

```js
const people = [{ id: 1, manager: null }, { id: 2, manager: 1 }, { id: 3, manager: 1 }, { id: 4, manager: 2 }];
oqx`id values from ${people} where id == 1 follow ^people collect { where manager == ^id } order by $ordinal`;
// [1, 2, 3, 4] — the reporting tree under person 1 (`^people` names the root from a top-level walk)

const chain = [{ id: "a" }, { id: "b", prev: "a" }, { id: "c", prev: "b" }];
oqx`id values from ${chain} where id == "b" follow distinct ^chain collect { where id == ^prev }, ^chain collect { where prev == ^id } order by $ordinal`;
// ["b", "a", "c"] — both directions of a chain; a block may order, bound and `distinct` its rows
```

A row's successors are, per destination in order, that destination's rows,
filtered by the follow `where`, then **unioned by identity within the step**: a
node reached by two destinations (or twice by one relation) in the same step is
a single successor. `exists`/`none`/`count` are not destinations (they are
where-position tests).

The block accepts: `where <succ>` (which successors keep participating),
`frontier <pred>` (cut a relation that could continue, whichever destination
reached it), `depth <n>` (1–8), and `by <expr>` (the identity used for cycle
detection + `distinct` — default `.id` or the object reference). The follow
`where` is **correlated**: it reads the candidate successor's scope whose parent
is the frontier row's — a bare name is the candidate's own property, `^name` is
the row being expanded, `^^name` the walk's enclosing scope (language 0.14;
before, `^` skipped the frontier row). So `follow doc.in { where
before.contains(^$path) }` steps only into rows that name the row they were
reached from. `frontier` and `by` are not correlated: they read the occurrence
with `^` the enclosing scope, as the body does. Give `follow` a stable identity
(`.id` or `by`) when your relation returns fresh objects rather than shared
references.

### 10. Sugar (0.17)

Every form below is shorthand for an explicit directive — it **desugars in the
parser** to the nodes you already know (`print` writes the explicit form, the
optimizer and any pushdown planner see it), so nothing here has semantics of its
own except the postfix `!` and the infix `is`:

```js
// A receiver block without a consumer is `collect`; a block whose LEADING
// expression is syntactically a predicate drops `where`.
oqx`name, current: jobs { !end_date } from ${people}`
//   ≡ name, current: jobs collect { where !end_date } from ${people}
oqx`${people} { age > 40 }`                  // ≡ ${people} collect { where age > 40 }
oqx`${people} count { jobs exists { } }`     // a consumer test is predicate-shaped too
oqx`${people} first { name }`                // a bare name still projects — unchanged
oqx`${people} first { is active }`           // the bare-field filter: `is x` ≡ `!!x`, `not x` ≡ `!x`

// Brackets: `[p]` is `first { where p }`, `[n]` is `first { offset n }`;
// a trailing `!` requires the result (and makes the predicate form `single`).
oqx`name, boss: ^people[id == ^manager].name from ${people}`   // the first match, navigated
oqx`name, first_job: jobs[0], primary: jobs[pay > 2]! from ${people}`
//   jobs[0]          ≡ jobs first { offset 0 }        (out of range ⇒ absent)
//   jobs[pay > 2]!   ≡ jobs single { where pay > 2 }!  (zero or many matches ⇒ an eval error)

// Postfix `!` — required: the value, or an eval error naming the expression
// (and the row's id). Never a filter, never a coercion: 0! and ""! are values.
oqx`select id!, title from ${docs}`           // insist on an identity before a write
// Tightest precedence: `refs(c)[0]!.name` requires the lookup, `refs(c)[0].name!` the name.

// `is` / `is not` compare IDENTITY (a row's id when present, else structurally):
oqx`name from ${people} where manager is null`            // absent (same as == null)
oqx`${people} count { ^people exists { $it is ^$it } }`   // rows compare; `==` leaves that unspecified
// `and` / `or` are exact synonyms of `&&` / `||`: `title or path` coalesces.

// A select item may use the items to its left (inlined like a `where` alias):
oqx`boss: ^people[id == ^manager], bossName: boss.name from ${people}`
```

Reserved words, never a bare field name: `from where select is not and or` and
the literal words `true false null`. The top level is unchanged — `age > 15
from ${people}` stays an error, because `where` would precede `from`.

### Cheat-sheet

```
select … from … where … follow … order by … limit N offset N   the fixed clause order (each at most once)
name, alias: expr, nested: rel collect { … }   projection (`select` may be dropped only here, in first position)
from ${source}                                  source collection (required at the top level)
where a == b && rel exists { where … } || !c    predicate tree + nested ops (`and`/`or` ≡ `&&`/`||`)
rel { pay > 2 }  /  rel { employer }            a block without a consumer is collect; a leading predicate is where-first, a bare name projects
rel[p]  /  rel[p]!  /  rel[0]  /  rel[0]!       first match / exactly one (required) / positional / required positional
x!                                               required: the value, or an error when absent (tightest; `a!.b` vs `a.b!`)
is x / not x  /  x is y / x is not y             truthiness (≡ !!x / !x) / identity (a row's id, else structural; absent ≡ null)
where alias  /  a: expr, b: a                    `where` and later items may use this body's select aliases (resolved before evaluation; an alias shadows a field)
where rel none { … }                             zero rows (≡ !rel exists { … }; "all" = none over the complement)
where x in lo..hi / lo...hi / ..hi / lo..        range membership (incl. / excl. / open-ended)
where x in range(field)                          coerce a string field to a range, then test coverage
name                                             the CURRENT row's field only (never climbs)
$it                                              the current item itself (a scalar row, or the whole object)
from entries(obj) … $key / $it                   a record's properties as a collection (key + value; bare names read the value)
<expr> values                                    scalar projection: the value, not a { name: value } record
^name / ^^name                                   read an enclosing row's field (exactly N scopes out); ^$it = the enclosing row
^name: expr  /  ^^name: expr                     lift/export a value N scopes out (flatten-append)
^rel collect { … }  /  ^^root exists { … }       nested consumer over an enclosing row's relation / a named root
entries(rel) exists { … }                        a free-function call may be a receiver
order by expr desc, expr2                        ordering
limit n / offset n                               bound the row set (after where/order/distinct, before the consumer)
follow rel { where … frontier … depth n by … }  recursion ($depth/$stop/$leaf/$frontier); `^name` in the where is the frontier row
follow before, after                             several destinations: the union of their rows (per step, by identity)
follow ^people collect { where manager == ^id } a destination block: successors computed per frontier row (`^` = that row)
${source} <collect|exists|none|count|first|single> { … }   whole-query consumer
```

## The AST: reflecting on a query

`parse(source)` returns the query's abstract syntax tree, and since language
0.16 that tree is a **public contract** shared by both implementations
([`spec/oqx/AST.md`](https://github.com/omgbase/omgbase/tree/main/spec/oqx/AST.md)):
a tool reflects on a query — which relations it names, which clauses it has,
where in the text each piece sits — without re-parsing. The objects are plain
data (no parent pointers, no methods) and *are* the JSON shape.

- **Every node has `kind` and `span`.** `span` is `[start, end)` in Unicode
  **code points** over the raw source (for a template, `rawSource(strings)`,
  where a binding occupies its `${n}` marker); `toUtf16(span, source)` converts
  for an editor that counts UTF-16 units. A parenthesized operand spans its
  parentheses; a block (`subquery`) spans its braces.
- **Optionals are materialized** — `where: null`, `limit: null`, `countCmp: null`,
  `distinct: false`, `values: false` — so nothing has to be defaulted.
- **`where` keeps its surface form.** A `select` alias used in `where` stays an
  `ident` in the tree; `resolveAliases(query)` is the pure substitution the run
  entry points (`oqx`, `run`, `execute`, `runQuery`) apply exactly once before
  evaluation. An `Engine.run` evaluates the query it is given — if you drive an
  engine yourself, resolve first.

```js
import { parse, visit, transform, print, printTemplate, toJSON, stripSpans, build } from "@omgbase/oqx";

const q = parse('select name, n: jobs collect { employer } from people where jobs exists { where !end }');

// visit: every node, with its ancestors, the clause it sits in, and the scope depth
const relations = [];
visit(q, {
  enter(node, { clause, depth }) {
    if (node.kind === "op") relations.push({ relation: print(node.receiver), clause, depth });
  },
});
// → [{ relation: "jobs", clause: "select", depth: 1 }, { relation: "jobs", clause: "where", depth: 1 }]

// transform: rebuild with every expression mapped (children first; untouched nodes keep identity + spans)
const rewritten = transform(q, (e) => (e.kind === "ident" && e.name === "name" ? build.member(build.ident("person"), "name") : e));

// print: the canonical source — single spaces, `select` written, minimal parentheses
print(rewritten);
// 'select name: person.name, n: jobs collect { employer: employer } from people where jobs exists { where !end }'

toJSON(q);        // { oqx: "0.17", kind: "query", span: [0, 93], … } — the shared JSON document
stripSpans(q);    // the same tree without spans, for shape comparisons
```

`visit(root, { enter?, leave? })` walks depth-first in canonical source order;
`enter` may return `false` to skip a subtree. Its context is `{ path, clause,
depth }` — the ancestors, the clause (`source` · `from` · `where` · `select` ·
`orderBy` · `limit` · `offset` · `follow` · `follow.destination` · `follow.where`
· `follow.frontier` · `follow.by`; `null` at the root) and the **scope depth**
the node is evaluated at (0 = the root scope: a top-level source or bound; 1 =
a top-level row; a block's body is one deeper than its receiver). Both walks
are driven by one child-key table, `CHILDREN`, so a future field is added in one
place.

`print(node)` is canonical, and the law `stripSpans(parse(print(parse(q))))`
≡ `stripSpans(parse(q))` holds for every spec fixture (both runners check it);
`print(parse(q)) === q` is *not* a law — spelling is normalized. A binding is a
value, never source text: `print` throws (`OqxError`, stage `"print"`) on one,
and `printTemplate(node)` returns `{ strings, count, indices }` — the fragments
around each binding and the binding each gap stands for (the canonical clause
order can move one past another), to re-run with `parseTemplate(strings,
count)` and the values permuted by `indices`.

`build.*` constructs nodes with the empty span `[0, 0]` and the materialized
defaults (`build.query(source, { select, where, … })`, `build.op(receiver,
"collect", build.subquery({ … }))`, `build.field`, `build.collect`,
`build.follow`, `build.ident`, `build.lit`, `build.binary`, `build.and`, …), so
a tree you assemble prints with `print` and has the shape of a parsed one.

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
objects. The parsed `Query` AST is the host-agnostic contract (above); execution
is pluggable.

```
Query AST  ─┬─ InMemoryEngine(DataContext)     tier 1/2 — drive any data model
            └─ PlannedEngine(QueryPlanner)      tier 3   — push work into a store
                   └─ finishes the residual on the in-memory engine
```

**Everything obeys one scalar-semantics contract** (the `semantics` export): typed/strict
equality (`5 == "5"` is false), absent operands make ordering comparisons false,
CEL-style `in`, absent-last sort order. Any backend that can't reproduce a rule
in its native language must leave that fragment as an in-memory *residual* rather
than approximate it. The conformance suite verifies this.

### Tier 2 — a custom `DataContext` (bind any data model)

The engine never touches host objects directly; it asks a `DataContext` to
resolve named roots, read properties/relations, coerce results to rows, and
compute identity. Implement it to query an ORM graph, a remote API, or lazily
loaded relations — the query *semantics* stay in OQX. Name resolution is simple
for a context: a bare `field`, a `.field` segment, and a `^field` outer
reference each become one `get(row, key)` against exactly the row of the scope
they name, so a computed relation only needs `get` to know about it:

```js
import { parse, run } from "@omgbase/oqx";

const graph = {
  root: (name) => name === "tree" ? [nodes.get(1)] : undefined,
  get:  (row, key) => key === "children" ? row.childIds.map(id => nodes.get(id)) : row[key],
  toRows: (v) => v == null ? [] : Array.isArray(v) ? v : [v],
  identity: (row) => row.id,                                // for follow dedup
};
run(parse("id, depth: $depth from tree follow children"), { context: graph });
```

#### Custom functions and methods

`DataContext` has two optional hooks, `callFunction(name, args)` for free
functions (`f(x)`) and `callMethod(name, recv, args)` for methods (`x.m()`).
Each returns a `CallResult`: `{ handled: true, value }` to answer, or
`{ handled: false }` to decline. **The engine does not consult the builtin
table itself** — `DefaultContext` is what does that. So a context that omits
these hooks, or handles only its own names without deferring, loses
`entries()`, `size()`, `has()`, `range()`, `.contains()`, and the rest: the
engine throws `OqxError("unknown function 'size(…)'", "eval")`. (The `graph`
context above has exactly this limitation.) Delegate whatever you don't
recognize:

```js
import { DefaultContext, parse, run } from "@omgbase/oqx";

const builtins = new DefaultContext();          // or: semantics.BUILTIN_FUNCTIONS[name]
const ctx = {
  ...graph,
  callFunction(name, args) {
    if (name === "age") return { handled: true, value: yearsSince(args[0]) };
    return builtins.callFunction(name, args);   // entries/size/has/range keep working
  },
  callMethod(name, recv, args) {
    if (name === "slug") return { handled: true, value: slugify(recv) };
    return builtins.callMethod(name, recv, args);
  },
};
run(parse("id from tree where age(born) > 18 && title.slug() == 'x'"), { context: ctx });
```

The simplest route is to `extends DefaultContext` and `super.callFunction(...)`
in the fallthrough. Custom calls are never pushed down by the shipped planners;
they always run in the residual.

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
becomes a `QueryPlanner`, while oqx contributes the parser, IR, semantics
contract, and residual executor.

## Performance: relational patterns

A nested block runs once per enclosing row, so the natural way to join two
collections —

```js
oqx`select id, total, customer: ${customers} first { where id == ^customer_id } from ${orders}`;
oqx`select name, orders: ${orders} collect { id, total where customer_id == ^id } from ${customers}`;
oqx`select id from ${orders} where ${customers} exists { where id == ^customer_id }`;
```

— would be quadratic if the block scanned its receiver each time. It does not:
the in-memory engine runs every nested block through an **optimizer**
(`src/optimize/`), a small logical plan per block plus rules that rewrite it,
each with a proof that the rewrite is unobservable — same rows in the same
order, same lifts, same error (same message) at the same point. The planned
engine and the naive engine (`new InMemoryEngine(ctx, { rules: [] })`) are run
over every `spec/oqx` fixture by `test/conformance.test.ts` and must agree on
results and on errors.

**What is optimized**

- **Correlated equality → hash probe.** A top-level `&&` conjunct of the block's
  `where` of the form `local == outer` (either side) — `local` a bare identifier
  or member chain on the block's row (`customer_id`, `meta.id`, `$it`),
  `outer` anything that reads nothing from that row (`^customer_id`, `^^x.id`,
  a `${…}` binding, a literal, arithmetic over them) — is answered from a hash
  index on the receiver built **once per run** per collection and path. The
  remaining conjuncts run over the bucket only, in receiver order; several
  equalities intersect their buckets smallest first. The index keys are exactly
  `==` (SEMANTICS §5): absent ≡ `null`, `-0` ≡ `0`, `NaN` matches nothing,
  objects and arrays by reference. 5 000 orders × 5 000 customers zip in a few
  milliseconds; the scan takes seconds.
- **Invariant blocks run once.** A block that reads nothing from any enclosing
  row (`^customers collect { name values }` from a top-level row) and lifts
  nothing is evaluated the first time it is reached and its value reused for
  every other row (the same array/record by reference).
- **Semi/anti-join short-circuit.** `exists` and `none` stop at the first bucket
  row that passes the residual, as they stop at the first matching row of a scan.
- **Cardinality only.** `exists` / `none` / `count` with nothing left to check
  per row (no `where`, or every conjunct correlated; no `distinct`, no `order
  by`) are answered from the bucket's size after the bound without entering a
  row.

**The sound rule.** `&&` is strictly left to right and short-circuiting (§13),
so a probe may skip a row only if everything the scan would have evaluated for
it could neither raise nor bind: an equality is hoisted only when **every
conjunct to its left is raise-free** — no function or method call, no `single`,
no lift, no `limit`/`offset`, no out-of-range `${…}`, only `exists`/`none`/
`count` blocks that are themselves raise-free — and its outer side is raise-free
too. A conjunct that could raise *right* of the equality is simply evaluated
over the bucket, where the scan would have evaluated it on the same rows. A
block whose `where` lifts anywhere is never probed (a lift could change what
the outer side reads between rows). Otherwise the block scans as before, so
`where nope(x) && id == ^id` still raises `unknown function`.

Property reads are treated as total (§23: evaluation is otherwise total). A
`DataContext.get` that throws is caught where the engine relies on reads it
would not otherwise perform — building an index, evaluating the probe value —
and the block falls back to the scan, which raises or not in its own order.

**Which receivers are indexed.** A receiver that reads only the root scope and
bindings (`^customers`, `${customers}`, `^^config.items`) is evaluated once per
run — its rows are read once and reused across the enclosing rows, with or
without a correlation — and indexed once per path even if the context hands out
a fresh array per read. Any other receiver is indexed the second time the
**same object** is probed, so a per-row relation (`lines collect { … where cid
== ^id }` with a different `lines` array per row) is scanned, not indexed. A
scalar receiver is one row.

**Pre-built indexes.** `DataContext.indexFor(collection, path)` is an optional
seam: return a `RowIndex` (`lookup(value) → ascending positions into
toRows(collection)`) for a collection you have already indexed, or `undefined`
to let the engine build one. A `RowIndex` may also implement
`lookupRows(value) → the matching rows, in receiver order`: for a stable
receiver the engine then probes it **before** reading the collection, so a
context backed by a store (a lazy handle for a table, an index on a column)
answers the probe with one indexed lookup and the table is never materialized.
One correlation is probed this way — the first whose outer side is a `^`
reference rather than a literal — and the other conjuncts, remaining
equalities included, are evaluated per selected row in their original order.

**Lazy handles.** A context that hands out a stand-in for a collection it has
not read yet may also implement `materialize(value)`: the engine calls it on
every value it is about to observe *as a value* (an operand of `==`/`in`/
arithmetic, a function or method argument, a projected item, an `order by` or
`distinct` key, a `where` scalar, a lift) and never on a value in *row
position* (the source, a block receiver, a body-level `from`, a `follow`
destination), which reaches `toRows` / `indexFor` as handed out. So the probe
above never reads the table, and the language never sees the stand-in. A
handle that already behaves as the collection (a `Proxy` over an array, as
omgbase's does) needs no `materialize`; the Rust crate's `DataContext::
materialize` is the same seam for a `Value` that cannot be lazy on its own.
`IndexedCollection` does the positional form for its fields:

```js
import { parse, run, IndexedCollection } from "@omgbase/oqx";
const orders = new IndexedCollection("orders", orderRows, ["customer_id"]);
run(parse("select name, o: ^orders collect { id values where customer_id == ^id } from customers"),
    { context: orders.context({ customers }) });   // probes the pre-built index
```

**Still a scan.** A block with a `from` re-projection or a `follow`; a `where`
whose equality sits right of a conjunct that could raise; inequalities,
`in`, `contains()` and other non-equality correlations; `order by … limit N`
(sorted in full, then bounded); `distinct` (hashes projections, not an index);
top-level queries (a `QueryPlanner` is the seam for those). `trace` in
`InMemoryEngine`'s options receives one event per index built, probe, direct
lookup, memo hit, cardinality answer or fallback, if you want to see what a
query did.

## Exports

Everything below is exported from `@omgbase/oqx` (`src/index.ts`); the SQLite
adapter lives on the `@omgbase/oqx/sqlite` subpath.

**Running queries**

- `oqx` (default export **and** named) — the tagged template. Returns the
  consumer-shaped value: an array for `collect`, a boolean for `exists` / `none`,
  a number for `count`, a record or `null` for `first` / `single`.
- `parse(source)` — a query string → reusable `Query` AST (an `OqxError` with
  `stage: "lex" | "parse"` on bad input); `parseTemplate(strings, count)` the
  tagged-template form, with `binding` nodes for the `${…}` slots.
- `execute(source, roots?)` — parse and run a string against named roots
  (`{ people }`), returning the consumer-shaped value.
- `run(query, opts?)` — run a parsed `Query`, returning the full `OqxResult`.
  `opts.values` are the positional `${…}` bindings; then exactly one of
  `opts.engine` (any `Engine`, e.g. a `PlannedEngine`), `opts.context` (a
  `DataContext`, run on the in-memory engine), or `opts.roots` (plain-object
  named roots → `DefaultContext`). Default: an empty `DefaultContext`.
- `runQuery(query, values, roots)` — the lower-level call `oqx` / `execute` use:
  in-memory over a `DefaultContext(roots)` (`roots` may be `undefined`).
- `OqxResult` — the discriminated result `run` returns:

  ```ts
  type OqxResult =
    | { consumer: "collect"; rows: unknown[] }
    | { consumer: "exists";  exists: boolean }
    | { consumer: "none";    none: boolean }
    | { consumer: "count";   count: number }
    | { consumer: "first";   row: unknown | null }
    | { consumer: "single";  row: unknown | null };
  ```

**Errors**

- `OqxError` — the one error class for every failure. `error.stage` is
  `"lex" | "parse" | "eval"` so you can branch without matching messages;
  `error.message` carries the detail (position for lex/parse errors, the
  offending name or count for eval errors). Eval errors include: unknown
  function/method, a non-integer or negative `limit` / `offset`, and
  `single { … }` matching **more than one** row (zero rows is `null`, not an
  error — use `first` when zero-or-one is expected and you don't care to assert).

**Engines and contexts**

- `Engine` — `{ run(query, bindings): OqxResult }`; what `run({ engine })` accepts.
- `InMemoryEngine` — `new InMemoryEngine(context?, options?)`; the reference
  engine over a `DataContext` (tier 1/2). `InMemoryEngineOptions`: `rules`
  (the optimizer rules for nested blocks, default `DEFAULT_RULES`; `[]` is the
  naive scan) and `trace` (a `(event: TraceEvent) => void` sink for index /
  probe / memo / cardinality / fallback events). See [Performance](#performance-relational-patterns).
- `DataContext` — the tier-2 interface: `root`, `get`, `toRows`, `identity`,
  plus optional `callFunction` / `callMethod` (above), an optional
  `indexFor(collection, path)` returning a `RowIndex` for a pre-built equality
  index (`lookup` → positions; optionally `lookupRows` → rows, probed without
  materializing the collection), an optional `materialize(value)` resolving a
  lazy handle the engine is about to observe as a value (see
  [Performance](#performance-relational-patterns)), and an optional
  `regexDialect` (`"oqx"` default | `"native"`). The engine dispatches
  `matches` through `callMethod`, so a custom context that wants the native
  dialect answers `matches` itself with `semantics.regexMatches(recv, args,
  "native")`; `BUILTIN_METHODS.matches` is always the baseline.
- `CallResult` — `{ handled: boolean; value?: unknown }`, returned by those hooks.
- `DefaultContext` — `new DefaultContext(roots?, options?)`; plain-object
  access, `.id` identity, and the builtin function/method tables. `options`:
  `{ regexDialect?: RegexDialect }` (see the regex baseline, §4).
- `compileRegex(pattern, flags?, dialect?)` — the `matches()` compiler: a
  `RegExp`, or an `OqxError` for a bad pattern/flag. `RegexDialect` /
  `RegexFlags` are the types.
- `semantics` — the scalar-contract module (`equals`, `relate`, `arith`,
  `membership`, `truthy`, `compareForSort`, `sizeOf`, `toList`,
  `coerceCollection`, ranges: `makeRange` / `isRange` / `rangeCovers` /
  `parseRangeString`, entries: `makeEntry` / `isEntry` / `entriesOf`, regex:
  `compileRegex` / `regexMatches` / `parseRegexFlags`, and the
  `BUILTIN_FUNCTIONS` / `BUILTIN_METHODS` tables). A backend reproducing a rule
  natively must match these.

**Planning (tier 3)**

- `QueryPlanner` — `{ plan(query, params): Plan | null }`. Return `null` to
  decline a query entirely (full in-memory fallback).
- `Plan` — `{ rows(): Iterable; residual: Query; context?: DataContext }`: the
  rows the store produced, the query to finish over them, and optionally a
  context for navigating those rows' relations.
- `PlannedEngine` — `new PlannedEngine(planner, fallbackContext?)`; an `Engine`
  that runs the planner and finishes `plan.residual` on the in-memory engine
  over `plan.rows()` (exposed as the `ROWS_ROOT` root).
- Planner helpers, used together inside `plan()`: `partitionPushable(where,
  canPush)` splits the top-level `where` conjunction into `pushed` expressions
  (those your `canPush` accepts) and a `residual` where-tree; `asEquality(expr)`
  recognizes `field == const` (either order) as `{ field, value }`;
  `isConst(expr)` / `constValue(expr, params)` tell a literal-or-binding from a
  row-dependent expression and evaluate it against the query bindings; and
  `residualQuery(query, residualWhere)` rebuilds the query to scan `ROWS_ROOT`
  with the pushed predicates dropped and projection / order / consumer / bounds
  intact. A planner typically: checks `query.source` names its table (and
  declines `from` / `follow`), partitions the `where`, translates `pushed` into
  its native query using `constValue` for parameters, then returns
  `{ rows, residual: residualQuery(query, residual) }`.
- `IndexedCollection` — `new IndexedCollection(rootName, rows, indexFields)`; a
  `QueryPlanner` that hash-indexes `rows` on `indexFields` (under `==`: absent ≡
  null, `NaN` matches nothing) and answers `field == value` predicates on them
  from the index, leaving the rest residual. `indexFor(collection, path)` serves
  the same indexes to the engine's correlated probes and `context(extraRoots?)`
  is a `DataContext` that resolves the root and wires `indexFor` up; the plans
  it returns carry that context, so a residual's nested blocks see the root.

  ```js
  import { parse, run, IndexedCollection, PlannedEngine } from "@omgbase/oqx";
  const planner = new IndexedCollection("people", people, ["city", "title"]);
  const engine = new PlannedEngine(planner, planner.context());
  run(parse('name from people where city == "NYC" && age > 30'), { engine });
  // city probe from the index; `age > 30` finished in-memory over the candidates
  ```

**Optimizer (nested blocks)**

- `DEFAULT_RULES`, `correlatedEqualityProbe`, `stableReceiver`, `invariantBlock`,
  `cardinalityOnly` — the shipped `Rule`s (`(plan: BlockPlan, ctx: RuleContext)
  => BlockPlan | null`); `logicalBlock(op, depth)` is the unoptimized plan of a
  block and `optimizeBlock(op, depth, ctx, rules)` runs rules to a fixpoint.
  `BlockPlan` / `Correlation` / `RuleContext` are the types; `HashIndex` is the
  engine's `RowIndex` implementation (`add(value, position)`, `lookup(value)`),
  reusable by a context implementing `indexFor`.

- `SqliteTable` (from `@omgbase/oqx/sqlite`) —
  `new SqliteTable(db, tableName, options)` over a `node:sqlite` `DatabaseSync`.
  `SqliteTableOptions`:
  - `columns: string[]` — the columns that map to bare OQX fields; only these
    are pushable (any other identifier stays residual).
  - `jsonColumns?: string[]` — columns whose stored text is `JSON.parse`d back
    into the row (for nested relations kept as JSON).
  - `map?: (raw) => row` — a custom raw-SQL-row → query-row mapper (overrides
    `jsonColumns`).

**The AST** (see [above](#the-ast-reflecting-on-a-query); `spec/oqx/AST.md` is normative)

- `visit(root, { enter?, leave? })` / `transform(root, f)` — the generic walks
  (`Visitor`, `VisitContext`, `Clause` are the types); `CHILDREN` — the
  child-key table per node kind that drives them.
- `print(node)` / `printTemplate(node)` — the canonical printer (`Template` is
  `{ strings, count, indices }`).
- `resolveAliases(query)` — the `select`-alias substitution the entry points
  apply before evaluation (SEMANTICS §14).
- `toJSON(query)` — the tree stamped with `oqx: LANGUAGE_VERSION`; `stripSpans(node)`
  — the tree without spans (`Stripped<T>`); `toUtf16(span, source)` and
  `codePointLength(s)` — code-point ↔ UTF-16 offsets; `rawSource(strings)` —
  the display source of a template.
- `build` — the node builders (`build.query`, `build.op`, `build.subquery`,
  `build.field`, `build.ident`, …).
- `LANGUAGE_VERSION` — the `spec/oqx/VERSION` this implementation conforms to (`"0.17"`).

**Types**

- Every AST node type from `src/ast.ts` is re-exported (`Query`, `Subquery`,
  `Where`, `Expr`, `OpNode`, `SelectItem`, `OrderSpec`, `Follow`,
  `AstNode`, `AstKind`, `Span`, …) for tools that reflect on queries and
  planners that walk the tree; `isExpr(node)` tells an expression from the
  structural nodes.

## Requirements

No runtime dependencies. The package is **ESM-only** (there is no `require`
condition in `exports`; Node 22.12+ can `require()` an ES module natively).

- **Main entry** (`@omgbase/oqx`): compiled ES2022 ESM. `engines.node` says
  `>=22.13.0`, but nothing in the main entry needs it — Node 18+ works in
  practice.
- **`@omgbase/oqx/sqlite`**: imports `node:sqlite`, which is available without
  a flag from Node 22.13 (behind `--experimental-sqlite` in 22.5–22.12). This is
  the reason for the `engines` floor.
- **Developing the package** (in the omgbase monorepo, `packages/oqx`): `pnpm
  test` runs the `.ts` suite directly through Node's type stripping, unflagged
  from Node 22.18 (and all of 24). `pnpm typecheck` typechecks; `pnpm build`
  emits `dist/`; `pnpm lint` runs the workspace eslint baseline.

## Relationship to omgbase

This is tier 1 (the in-memory object/collection interpreter) of the OQX
implementation tiers. The language kernel here is host-agnostic; richer hosts
(e.g. omgbase's docs/blocks/nodes with index pushdown) layer data-model
vocabulary and execution capabilities on top of the same surface syntax.

## License

[MIT](./LICENSE). Release history is in the [CHANGELOG](./CHANGELOG.md).
