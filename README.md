# oqx

**Generic Object Query eXpression engine for JavaScript.**

OQX is a small query language for querying ordinary in-memory JavaScript objects
and collections — arrays of records, nested relations, recursive trees — with a
readable, declarative syntax. This package is the **generic collection kernel**:
the OQX language semantics separated from any particular data model, exposed as a
JavaScript tagged template.

```js
import { oqx } from "oqx";

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

## Language at a glance

```
[ projection ]           name, id, title: label, employers: jobs collect { employer }
from <collection>        from ${people}
[ where <predicate> ]    where age >= 18 && jobs exists { !end_date }
[ order by <expr> …]     order by age desc, name
[ follow <relation> ]    follow children { depth 4 }
```

- **Projection** — bare fields (`name`), dotted navigation (`meta.slug`, keyed by
  the last segment), aliases (`label: name`), and nested collections
  (`current: jobs collect { employer where !end_date }`).
- **Predicates** — `== != < <= > >=`, `&&` `||` `!`, `in`, arithmetic, and the
  builtins `contains / startsWith / endsWith / matches / size / lower / upper`
  and `list(…)`. Bare identifiers resolve against the current row and **climb to
  enclosing rows** when absent (lexical outer references).
- **Consumers** — `collect` (default), `exists`, `count`, `first`, `single`.
  Used as postfix directives over a collection: `<relation> <consumer> { … }`.
  In `where`, `count { … } >= 2` compares cardinality.
- **`follow`** — recursive traversal of a same-typed relation, with `depth`,
  `frontier`, `by` (identity) and `distinct`; reached rows expose the recursion
  intrinsics `$depth`, `$stop`, `$leaf`, `$frontier` in `select` / `order by`.
  Reached rows are deduplicated by identity, so cycles terminate.

The default `collect` consumer returns an array; `exists` returns a boolean,
`count` a number, and `first` / `single` a single record (or `null`).

## String queries with named roots

When you don't need interpolation, `execute` runs a plain string query against a
**data context** of named roots:

```js
import { execute } from "oqx";

execute("name from people where age >= 18", { people });
// `from people` resolves the `people` root
```

`parse(source)` returns a reusable AST and `run(query, { values, roots })` returns
the full discriminated result (`{ consumer, … }`).

## Requirements

Node 22.6+ (the sources are TypeScript, run natively via type-stripping — the
package has **no runtime dependencies**). `npm test` runs the suite; `npm run
typecheck` typechecks.

## Relationship to omgbase

This is tier 1 (the in-memory object/collection interpreter) of the OQX
implementation tiers. The language kernel here is host-agnostic; richer hosts
(e.g. omgbase's docs/blocks/nodes with index pushdown) layer data-model
vocabulary and execution capabilities on top of the same surface syntax.
