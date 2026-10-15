# The OQX AST

The abstract syntax tree of an OQX query is part of the language (since 0.16):
both implementations produce the same tree from the same source, serialize it
to the same JSON, print it back to the same canonical text, and walk it with
the same traversal contract. A tool — an editor, a graph UI choosing which
relationships a query mentions, a linter — reflects on a query through this
tree instead of re-parsing it. The fixtures under `cases/ast.json` and
`cases/ast-spans.json` are the executable form of this document; where prose
and fixture disagree, the fixture wins.

The reference types are `packages/oqx/src/ast.ts` (TypeScript: the in-memory
objects *are* the JSON shape — plain data, no parent pointers, no methods) and
`crates/oqx/src/ast.rs` (Rust: the same shape through serde, under the `json`
feature).

## 1. Nodes

Every node is a JSON object with a `kind` (the closed set below), a `span`
(§3) and its fields (§2). Optional fields are always present: an absent
clause is `null`, an unset flag is `false`. There is no field a tool must
guess the default of.

| `kind` | Node | Where it appears |
| --- | --- | --- |
| `query` | the top-level query | the root |
| `subquery` | a block body, the `{ … }` of a directive | `op.sub` |
| `op` | a consumer directive `<receiver> <consumer> [distinct] { … } [<relop> N]` | a `where` leaf (a consumer test), a `collect` item's value, a `follow` destination block (whose `sub` may carry `frontier`/`depth`, since 0.20), and — since 0.17 — an expression (a value-position `collect`/`first`/`single`, which is what a bracket lookup `x[…]` and, since 0.20, any `x { … }` / `x distinct { … }` desugar to: `jobs[0].pay` is a `member` over an `op`) |
| `follow` | the `follow` clause — its destinations and the `distinct` flag (since 0.20 nothing else: a destination's `where`/`frontier`/`depth` are clauses of its block) | `query.follow`, `subquery.follow` |
| `groupBy` | the `group by` clause — its keys (since 0.24) | `query.groupBy`, `subquery.groupBy` |
| `key` | one `group by` key, `name: expr` (shaped like a `field` item without a lift; since 0.24) | `groupBy.keys[]` |
| `order` | one `order by` term | `orderBy[]` |
| `field` | a projection item `[^…]name: expr` / `name` | `select[]` |
| `collect` | a projection item whose value is a block, `name: <op>` | `select[]` |
| `and`, `or` | the `where` tree's n-ary conjunction / disjunction | `where` |
| `not` | `!` over a `where` operand | `where` |
| `scalar` | a `where` leaf that is a value expression | `where` |
| `lit` | a literal: string, number, boolean, `null` | expressions |
| `ident` | a bare name — a property of the current row/scope | expressions |
| `outer` | `^name`, `^^name` — a read exactly `levels` scopes out; also what the absolute `N^name` parses to (since 0.18) | expressions |
| `binding` | a `${n}` bound value of a template | expressions |
| `member` | `.name` navigation on `recv` | expressions |
| `call` | `name(args)` (`recv: null`) or `recv.name(args)` | expressions |
| `unary` | `!x`, `-x` (also what `is x` ≡ `!!x` and `not x` ≡ `!x` parse to) | expressions |
| `required` | `x!` — the value, or an eval error when absent (since 0.17) | expressions |
| `binary` | arithmetic, comparison, identity (`is`, `is not`), or a regex match (`~`, `~*`, `!~`, `!~*` — since 0.22), `op` the source operator | expressions |
| `logical` | `&&`, `||` in value position | expressions |
| `in` | membership | expressions |
| `range` | `lo..hi`, `lo...hi`, `..hi`, `lo..` | expressions |
| `tuple` | `(e1, e2, …)` — two or more expressions, a value and a receiver (since 0.20) | expressions |
| `template` | `` `text ${expr} text` `` — a template literal: text parts and interpolated expressions, a string value (since 0.21) | expressions |
| `aggregate` | `count()`, `sum(e)`, `collect(distinct e)` — an aggregate call over the group's rows (since 0.24); never a `call` | expressions (a select item, `having`, `order by` of a grouped body) |

The `where` tree and value expressions are distinct families: `and`/`or`/`not`
own the boolean structure of a predicate so consumer tests compose with scalar
leaves, while `logical` is `&&`/`||` *as a value* (`(a || b) == 5`). A
where-position consumer test is the `op` node itself; discriminate a `where`
node on `kind`.

A `template` node (since 0.21) holds the only child slot with non-node values:
its `parts` list alternates plain JSON strings (the decoded text) with
expressions, text first and last. The text is data, not a node — it has no
`kind` and no span — so the traversal (§5) visits only the interpolations.

There is no `index` node and no node for any other sugar: a bracket lookup
`x[n]` / `x[p]` is parsed straight to the `op` (`first { offset n }`,
`first { where p }`; `single` under `!`), `x { … }` and `x distinct { … }` to a
`collect` op, `is x` and `not x` to `unary` nodes (GRAMMAR §4). The only shapes
0.17 adds are `required` and the `is`/`is not` operators of `binary`; 0.20 adds
`tuple` (a single parenthesized expression is still grouping and leaves no node),
the `frontier`/`depth` fields of `subquery` and the `frontier` field of `query`
(a body's seed frontier). Nor is there a node
for an **absolute scope reference** (since 0.18): `N^name` is the `outer` node
with `levels = depth − N` — the parser knows the depth of every position
(the `depth` of §5) — and `N^name:` at a select item's head is a `field` with
that `lift`; the tree does not record which spelling was written. The
`Expr.index` variant the pre-0.16 types declared was never produced and was
removed in 0.16.

`isExpr` (TypeScript) is true for the scalar expression kinds listed above; an
`op` is an expression only by position (its `kind` stays `"op"`), so
`transform` maps the expressions *inside* an `op` and rebuilds the `op` itself
rather than handing it to the mapping function.

## 2. Fields

Field names are the TypeScript spelling (camelCase); the Rust struct fields are
the same words snake_cased (`orderBy` ↔ `order_by`, `exclusiveEnd` ↔
`exclusive_end`, `countCmp` ↔ `count_cmp`, `where` ↔ `r#where`) and serialize
to the TypeScript names. Operators, consumers and relation operators serialize
as their source words (`"=="`, `"&&"`, `"collect"`).

| Node | Fields |
| --- | --- |
| `query` | `source: Expr` — the root collection (`from <source>` or the directive receiver); `from: Expr[]` — further `from E` re-projections (only a directive form's block can hold them); `where: Where \| null`; `select: SelectItem[]`; `orderBy: Order[] \| null`; `consumer: "collect" \| "exists" \| "none" \| "count" \| "first" \| "single"`; `follow: Follow \| null`; `frontier: Expr \| null` — the body's seed frontier (since 0.20; set only together with `follow`); `groupBy: GroupBy \| null` and `having: Where \| null` (since 0.24; `having` is set only together with `groupBy`); `distinct: boolean`; `values: boolean`; `limit: Expr \| null`; `offset: Expr \| null` |
| `subquery` | `from`, `where`, `select`, `orderBy`, `follow`, `frontier`, `groupBy`, `having`, `values`, `limit`, `offset` as above (no `source`, `consumer`, `distinct` — those belong to the enclosing `op`); `depth: number \| null` (1..8) — set only on a `follow` destination block's body (since 0.20), `null` on every other block; `frontier` on a destination block's body marks the occurrences reached through it, on any other block's body (with a `follow`) its seeds |
| `op` | `receiver: Expr`; `op: Consumer`; `sub: Subquery`; `countCmp: { op: RelOp, value: number } \| null` — the `count { … } <relop> N` test, an attribute rather than a node; `distinct: boolean` — `<op> distinct { … }` and `{ select distinct … }` are one flag |
| `follow` | `destinations: (Expr \| Op)[]` — ≥ 1, in source order (a tuple destination is one `tuple` expression); `distinct: boolean` |
| `groupBy` | `keys: Key[]` — ≥ 1, in source order (since 0.24) |
| `key` | `name: string` — the alias, or the last segment of an unaliased navigation; `expr: Expr` (since 0.24) |
| `order` | `expr: Expr`; `desc: boolean` |
| `field` | `name: string` — the alias, or the last segment of an unaliased navigation, or `""` for an unaliased expression under `values`; `expr: Expr`; `lift: number` — the count of leading `^` (0 = an ordinary item) |
| `collect` | `name: string`; `op: Op` |
| `and`, `or` | `parts: Where[]` (≥ 2; the parser flattens `a && b && c` to one node) |
| `not` | `expr: Where` |
| `scalar` | `expr: Expr` |
| `lit` | `value: string \| number \| boolean \| null` |
| `ident` | `name: string` |
| `outer` | `levels: number` (≥ 1); `name: string` |
| `binding` | `index: number` (0-based, in template order) |
| `member` | `recv: Expr`; `name: string` |
| `call` | `recv: Expr \| null`; `name: string`; `args: Expr[]` |
| `unary` | `op: "!" \| "-"`; `expr: Expr` |
| `required` | `expr: Expr` |
| `binary` | `op: "==" \| "!=" \| "<" \| "<=" \| ">" \| ">=" \| "is" \| "is not" \| "~" \| "~*" \| "!~" \| "!~*" \| "+" \| "-" \| "*" \| "/" \| "%"`; `left: Expr`; `right: Expr`. The four regex operators (since 0.22) are sugar over `matches` (SEMANTICS §11) but are **not desugared in the tree**: the node carries the operator as written, so `print` writes `a ~ b` back and a tool sees what the user wrote; evaluation is `a.matches(b)` / `a.matches(b, "i")` and the negations |
| `logical` | `op: "&&" \| "\|\|"`; `left: Expr`; `right: Expr` |
| `in` | `left: Expr`; `right: Expr` |
| `range` | `lo: Expr \| null`; `hi: Expr \| null`; `exclusiveEnd: boolean` |
| `tuple` | `items: Expr[]` (≥ 2) |
| `template` | `parts: (string \| Expr)[]` — **strictly alternating**: a text part, an interpolation, a text part, … — so the list has odd length (≥ 1) and begins and ends with a text part, which may be `""` (`` `${a}` `` is `["", a, ""]`, `` `${a}${b}` `` is `["", a, "", b, ""]`, `` `hi` `` is `["hi"]`, `` `` `` is `[""]`). A text part is a **plain JSON string**, not a node (no `kind`, no span), holding the **decoded** text (GRAMMAR §1 escapes resolved, newlines verbatim); an interpolation is any `Expr` (a nested `template` or a value-position `op` included) |
| `aggregate` | `name: "count" \| "sum" \| "min" \| "max" \| "avg" \| "collect" \| "first" \| "last" \| "any" \| "all"`; `arg: Expr \| null` — `null` only for the bare `count()`; `distinct: boolean` — the `(distinct e)` modifier (since 0.24) |

Shape rules the parser guarantees (and `cases/ast.json`, `cases/group-by.json` pin):

- The two spellings of one construct are one tree: `name from x` ≡ `select name
  from x`; `x collect { … }` ≡ `select … from x …`; `jobs collect distinct { e }`
  ≡ `jobs collect { select distinct e }`; parentheses leave no node. **Sugar
  desugars in the parser** (since 0.17): `x { … }` is the `collect` op;
  `people exists { age > 50 }` is `where age > 50`; `x[p]` is the op
  `first { where p }`, `x[n]` the op `first { offset n }`, `x[p]!` a `required`
  over `single { where p }`, `x[n]!` a `required` over `first { offset n }`;
  `is x` is `!!x` (two `unary` nodes), `not x` is `!x`; `x distinct { … }` is
  the `collect` op with `distinct: true` (0.20); `follow children { depth 2 }` is
  a `follow` whose one destination is the `collect` op over `children` with
  `sub.depth = 2` (0.20). A `select` item whose
  value is exactly a directive is the `collect` item kind whatever spelling
  produced it (`boss: ^people[id == ^manager]`); one that navigates or operates
  on a directive (`jobs[0].pay`) is a `field` whose expression contains the
  `op`. An unaliased `field` keys by the last segment of the navigation under
  any `required` (`name!` → `name`, `jobs[0].pay` → `pay`). Parentheses around
  one expression leave no node; around two or more they are a `tuple`.
- Grouping (0.24): a free call by an aggregate name is an `aggregate` node
  wherever it is written (`count()` is `{ kind: "aggregate", name: "count", arg:
  null, distinct: false }`; `collect(distinct name)` carries the modifier) —
  never a `call`. A `group by` key is a `key` node named like a select item
  (`group by meta.region` → `key` named `region`). A grouped body with **no
  `select`** carries the **synthesized** projection — one `field` per key (`name`
  = the key's, `expr` the bare `ident`) and `count: count()` — so the tree shows
  what the body projects; the synthesized nodes carry the empty span. A
  `count { … }` directive in value position (0.24) is a `collect` select item
  (or an `op` operand) like the other directives.
- `where` keeps its **surface form**: a `select` alias referenced in `where` is
  an `ident` in the tree. The substitution (SEMANTICS §14) is the pure function
  `resolveAliases` / `resolve_aliases`, applied by the run entry points exactly
  once before evaluation; the parser only validates the references (a cycle or
  a block alias inside an expression is still a parse error). A tool that wants
  the evaluated predicate calls it; a tool that wants what the user wrote reads
  the tree as parsed.
- Numbers are doubles (`1e3` is `1000`); string literals are decoded (`"a\nb"`
  holds a newline), and so are a template literal's text parts (`` `a\`b` `` is
  `["a`b"]`; `` `\${x}` `` is `["${x}"]`, one text part and no interpolation).

## 3. Spans

Every node carries `span: [start, end)` — two integers, offsets in **Unicode
code points** over the raw source: the query string, or for a template
`rawSource(strings)` (`raw_source`), where the n-th binding occupies its
`${n}` marker (`"${0}"` is four code points). Both lexers count code points,
and the `(at offset N)` suffix of a lex/parse error is the same unit. Offsets
are never UTF-16 code units or bytes; the TypeScript package ships
`toUtf16(span, source)` for an editor that counts in UTF-16.

A node's span runs from the first token that produced it to the end of the
last:

- `query`: the first token to the last (leading and trailing whitespace are
  outside it);
- `subquery`: the braces inclusive, `{ … }`;
- `op`: the receiver through the closing brace, and through `<relop> N` when
  a count comparison follows;
- `follow`: the `follow` word through the last destination (a destination
  block's closing brace included);
- `groupBy`: the `group` word through the last key; `key`: the alias (or the
  expression) through the expression; `aggregate`: the name through the
  closing parenthesis (`count()` at 13 spans `[13, 20]`);
- `field`/`collect`: the leading carets or the name through the value;
  `order`: the expression through `asc`/`desc`;
- `and`/`or`: the first part to the last; `not`: the `!` through its operand;
  `scalar`: its expression; `required`: its operand through the `!`;
- a **desugared node spans the sugar as written**: the `op` of `x[p]` runs from
  `x` through `]` (through the `!` for `x[p]!`'s `single`, with the `required`
  spanning the same range), its `subquery` is the brackets inclusive; both
  `unary` nodes of `is x` span `is x`; the `collect` op of `x { … }` spans `x`
  through `}` as a written directive would;
- `outer`: the carets (or the `N^`) through the name; `lit`: a string's quotes
  inclusive; `binding`: its `${n}` marker; `tuple`: its parentheses inclusive;
  `template`: its backticks inclusive, while each interpolated expression spans
  itself (not its `${` `}`), and a text part has no span;
- a **parenthesized operand** takes the span of its parentheses (`(a + 1) > 2`:
  the `+` node spans `(a + 1)`), so an editor can select exactly what the user
  grouped.

A node that did not come from source — built by a tool, or by `transform` —
carries the empty span `[0, 0]`. `stripSpans` / `strip_spans` removes (sets
to empty) every span for shape comparisons; the fixtures compare stripped
trees unless a case says `"spans": true`.

## 4. JSON

`toJSON(query)` (TypeScript) and `ast_to_json(&query)` (Rust, feature `json`)
produce the document both implementations exchange: the tree as above with
the language version it was produced under at the root —

```json
{ "oqx": "0.16", "kind": "query", "span": [0, 16], "source": { "kind": "ident", "span": [10, 16], "name": "people" }, "from": [], "where": null, "select": [ … ], "orderBy": null, "consumer": "collect", "follow": null, "distinct": false, "values": false, "limit": null, "offset": null }
```

Rules: `kind` on every node; camelCase fields; every optional field present
(`null`, never omitted); operators and consumers as their source words; a
`follow` destination is the bare node (an expression, or an `op`); a
where-position consumer test is the bare `op`. Object key order is not
significant; the fixtures compare after canonicalization (README). The Rust
crate reads the document back with `query_from_json`.

## 5. Traversal

Both implementations ship one generic walk driven by a single child-key table
per `kind` (TypeScript `CHILDREN`, Rust `walk::children`), so a future field
is added in one place and every tool sees it. Children are visited in
canonical source order: for `query` — `select`, `source`, `from`, `where`,
`frontier`, `follow`, `groupBy`, `having`, `orderBy`, `limit`, `offset`; for
`subquery` — `select`, `from`, `where`, `frontier`, `follow`, `groupBy`,
`having`, `orderBy`, `limit`, `offset` (`depth` is
a number, not a node); for `op` — `receiver`, `sub`; for `follow` —
`destinations`; for `groupBy` — `keys`; for `key` — `expr`; then the obvious
slots of the smaller nodes (`expr`, `parts`,
`recv`, `args`, `left`/`right`, `lo`/`hi`, `items`; `required` — `expr`;
`template` — `parts`, visiting the interpolated expressions in order and
skipping the text strings, which are not nodes; `aggregate` — `arg`).

- **`visit(root, { enter?(node, ctx), leave?(node, ctx) })`** — depth-first.
  `enter` may return `false` to skip the node's children (`leave` is still
  called). `ctx` is `{ path, clause, depth }`:
  - `path` — the ancestors, root first;
  - `clause` — where the node sits: `source` (the root collection), `from`
    (a re-projection), `where`, `select`, `orderBy`, `limit`, `offset`,
    `follow` (the `follow` node itself), `follow.destination` (a destination,
    and everything inside a destination block that opens no clause of its own —
    its receiver and `subquery`), `follow.frontier` (a `frontier` expression —
    a destination block's, or a body's own seed frontier), `groupBy` (the
    `groupBy` node and its keys) and `having` (since 0.24); the root has none (`null`); a node inherits its
    parent's clause unless it opens one (a destination block's `where` is
    `where`, as in any block);
  - `depth` — the **scope depth** at which the node is evaluated (SEMANTICS
    §2): 0 is the root scope — a top-level `source`, `limit` and `offset`;
    1 is a top-level row — the top-level `where`, `select`, `orderBy`, `from`
    re-projections, `follow`, `groupBy` and `having` (a group scope sits at
    the row depth, SEMANTICS §24); a block's receiver is read at its enclosing
    depth and its body one deeper — so a destination block's `where` tests a
    successor one deeper than the frontier row; a destination block's
    `frontier` is read one level **out** of the block's rows, under the walk's
    enclosing scope, while a body's own `frontier` (its seeds') is read at the
    body's row depth like its `where` — the walk tells the two apart by
    position: a block is a destination block when its `op` is a direct
    destination of a `follow` node (SEMANTICS §20).
- **`transform(root, f)`** — rebuilds a `query`/`subquery` with every
  expression mapped through `f(expr, ctx)`, children first (so `f` sees an
  expression whose operands are already mapped). Nodes `f` returns unchanged
  keep their span (and, in TypeScript, their identity).

Rust: `walk::visit(Node::Query(&q), &mut visitor)` with a `Visitor` trait
(`enter` / `leave`), `walk::transform(&q, &mut f)`; `Node` is a borrowed
enum over the node kinds, `Clause` the enum above.

## 5b. References (since 0.23)

**`references(root)`** — the static pass over a `query` or `subquery` that
lists every **name the query reads from a row**, in canonical source order
(the `visit` order), each with the clause it stands in and the **scope** whose
rows it is read from. The pass knows no data: it is the host (which knows
what rows an expression yields) that maps a scope to a row type and judges the
name against it — omgbase's "`target` is not a field of links" is built on it.
Both implementations produce the same list for the same query; the fixtures
`cases/references.json` pin it (`expect.references`, README).

A reference is `{ name, clause, scope: { depth, steps }, span }`:

- `name` — the name **as written**: a bare identifier's name, or for a
  navigation headed by one the whole dotted path (`doc.layer`, `meta.owner`).
  A `$it` head is the row itself and is dropped (`$it.title` → `title`,
  `^$it.layer` → `layer`).
- `clause` — the `visit` clause the reference sits in (`select`, `source`,
  `from`, `where`, `orderBy`, `limit`, `offset`, `follow.destination`,
  `follow.frontier`, `groupBy`, `having`).
- `scope.depth` — the scope depth the name is evaluated at (§5 `depth`); for an
  outer reference, the depth of the position minus its `levels`.
- `scope.steps` — the expressions that produce the scope's rows, root first,
  each with the depth of the rows it produces: the query's `source` (depth 1);
  a body's `from` re-projection (the same depth — a `from` replaces the rows); a
  block's receiver (one deeper than the scope it is read in), then the block's
  own `from`; a **`follow` node** (the walk's frontier rows, at the body's
  depth — the destinations are read on them, a destination block's receiver
  producing rows one deeper); since 0.24 a **`groupBy` node** — the body's
  groups, at the same depth (the rows replaced by one key record per group) —
  for a name read at the **group scope**: in a select item, `having` or `order
  by` of a grouped body and not inside an aggregate's argument (an argument is
  read on the group's rows, so its steps stop before the `groupBy` step).
  `rows` as a receiver there is a step like any receiver (`{ expr: "rows",
  depth: d + 1 }`). A name inside a `from` expression sees only the
  steps before it. For an outer reference the steps are cut after the last
  step producing rows at its depth. The empty list is the root scope.
- `span` — the span of the whole reference (the chain, for a navigation).

What is a reference:

- a bare `ident`; a `member` chain headed by an `ident` or an `outer` (one
  reference, the full path); an `outer` (`^name`, `N^name`), read in the scope
  its carets name;
- a `follow` destination that is a plain expression (read on the frontier row,
  clause `follow.destination`), like a `from`;
- a method's **receiver** and a function's **arguments** (`target.contains("x")`
  references `target`; `has(stage)`, `size(jobs)` reference `stage`, `jobs`);
  the operands of every operator, `in`, a range, a tuple's elements, a
  template's interpolations;
- a name read at the **root scope** — the head of the top-level `source`
  (`from people`, clause `source`), an outer reference with as many carets as
  there are enclosing scopes (`^docs` from a top-level row) — reported with
  `depth` 0 and no steps: it names one of the host's roots.

What is not:

- `$`-names (`$key`, `$depth`, `$stop`, …) — the language's values; `$it` alone;
  a `binding`; a function, method or **aggregate name**; the keys of a
  projection (an item's alias, a lift's name, a group key's name);
- a `select` alias where the language substitutes it (§14 of SEMANTICS): a
  bare identifier naming an alias — or a chain headed by it — in the same
  body's `where` or `having`, or in a `select` item to the alias's right. An alias's own
  name inside its own item is the row field and **is** a reference. `order
  by`, `frontier`, `limit`/`offset`, `from` and `follow` are not rewritten
  against aliases, so a name there is a reference whatever the `select` says
  (`select n: name from people order by n` references `n` — the row's);
- at a **group scope** (since 0.24; SEMANTICS §24): a bare **key name** — or a
  chain headed by it, or an outer reference to it from a nested block (`^lo`
  inside `rows collect { … }`) — is the key, an alias of the expression
  reported in clause `groupBy`; and `rows` is the language's value. Inside an
  aggregate's argument both are row reads again (`collect(city)` references
  `city` on the rows; `sum(rows)` references a property `rows`);
- the trailing `.name`s of a navigation whose head is **not** a name — a call
  (`refs(before).title`), a block (`blocks[type == "task"].text`), a tuple, a
  literal: the head's value is not a row of any scope, so only the names inside
  the head are references (`before`; `blocks` and `type`).

TypeScript: `references(root): Reference[]` with `Reference`, `ReferenceScope`,
`ReferenceStep` (`expr: Expr | Follow | GroupBy`). Rust: `references::references(&q)`
returning `Vec<Reference>` over borrowed nodes, the same fields. In a fixture a
`groupBy` step prints as the clause (`"group by city: city, lo: age"`).

## 6. Printing

`print(node)` renders a tree as canonical source: single spaces; `select`
written at the top level (the keyword-less projection is sugar); every item
aliased (`name: name` — the alias is what the record key is, and a name
that differs from the navigation's last segment must be written anyway);
double-quoted strings with the GRAMMAR §1 escapes; the minimal parentheses
the precedence table (GRAMMAR §4) requires, and the predicate/scalar group
rule of GRAMMAR §3 for `where`; `distinct` on a directive spelled
`<op> distinct { … }` (so `x distinct { … }` prints as `x collect distinct { …
}`); a body's clauses in the fixed order — `where`, `frontier`, `depth` (a
destination block's), then `follow`, `order by`, the bounds — so a body's seed
frontier prints between `where` and `follow` (`select id: id from t frontier
!active follow kids collect { depth 2 }`), and `follow x { depth 2 }` as
`follow x collect { depth 2 }`; `group by` after `follow` with **every key
aliased** as select items are (`group by city: city, lo: age`), then `having`
(since 0.24); an aggregate as the call it is (`count()`, `sum(distinct pay)`),
a value-position `count` directive as `rows count { where checked }`; a tuple with its parentheses `(a, b)`; an empty
block as `{ }`; the logical connectives as the **words**
`and` / `or` (since 0.18; `&&` / `||` parse to the same nodes and the JSON
`op` stays `"&&"` / `"||"`), the prefix negation as `!`; a **template literal
as a template literal** (since 0.21): backticks around its parts, each text part
escaped so it re-lexes to itself — `\\` for a backslash, `` \` `` for a backtick,
`\$` for a `$` that a `{` follows, and `\n` `\t` `\r` `\0` for those characters,
every other character verbatim — and each interpolation as `${…}` around the
expression's canonical text (`` `a ${ `b ${n}` } c` `` prints as `` `a ${`b
${n}`} c` ``). **Sugar prints as the
explicit form** it parsed to (since 0.17): `x { p }` as `x collect { where p }`,
`jobs[0].pay` as `jobs first { offset 0 }.pay`, `x[p]!` as `x single { where
p }!`, `is x` as `!!x`, `not x` as `!x`, an absolute `N^name` as the caret
form `^…name` (since 0.18); `x!` prints as written, with its operand
parenthesized below postfix level (`(a + 1)!`); `x is y` / `x is not y` print
as written, and so do the regex operators `x ~ y` / `x ~* y` / `x !~ y` /
`x !~* y` (since 0.22) — they are sugar over `matches` in evaluation only, not
in the tree, and sit at comparison level (a nested comparison on either side is
parenthesized: `(a ~ b) == true`).

Form: a `collect` query prints in body form (`select … from S …`) — unless it
carries body-level `from` re-projections, which only a block can hold, in
which case it prints as the directive `S collect { … from E … }`; every other
consumer prints as the directive form. Inside a block the projection leads
without its keyword (the block's first clause is always the projection).

The law both spec runners enforce over **every** fixture query that parses:

```
strip(parse(print(parse(q)))) ≡ strip(parse(q))
```

`print(parse(q)) == q` is **not** a law: the printer normalizes spelling. A
binding is a value, never source text, so `print` fails on one (`OqxError`,
stage `print`); `printTemplate(node)` returns `{ strings, count, indices }` —
the fragments around each binding, how many there are, and the binding index
each gap stands for (the canonical clause order can move a binding past
another: `${0} collect { x: ${1} }` prints as `select x: ${1} from ${0}`,
`indices = [1, 0]`). Re-run it as `parseTemplate(strings, count)` with the
values permuted by `indices`.

## 7. Building

A tool that constructs a tree uses the builders (TypeScript `build.*`, Rust
`oqx::build::*`): every node they make carries the empty span and the
materialized defaults, so a built tree has the shape of a parsed one and
prints with `print`. omgbase's `graph` macro builds its `follow` walk this way
and prints it — the seed ids are literals in the tree, never spliced text.

## 8. Versioning

The AST is versioned with the language (`VERSION`): the `oqx` stamp of a JSON
document says which `major.minor` produced it.

- Adding a node kind or a field is a **minor** change (a reader of an older
  minor may meet an unknown `kind`/field; one of a newer minor will not).
- Renaming or removing a node kind or a field is a **breaking** change: it
  bumps the major (post-1.0) and is listed here under *Deprecated and
  removed*, with the version and the replacement.

### Deprecated and removed

| Version | Change |
| --- | --- |
| 0.14 | `follow.receiver` → `follow.destinations` (a list). |
| 0.16 | `index` expression node removed (never produced). `limit`/`offset`/`countCmp` materialized as `null`, `distinct`/`values` as `false` (they were optional). `kind` added to `query`, `subquery`, `follow`, `order`; `span` added to every node. `where` is no longer alias-inlined at parse time (see §2). |
| 0.17 | Added (minor): the `required` expression node; `"is"` / `"is not"` as `binary` operators; an `op` may appear in expression position (`member.recv`, operands, `required.expr`, a `field`'s value). Nothing renamed or removed. |
| 0.18 | No node or field added, renamed or removed: `N^name` parses to the existing `outer` (`levels = depth − N`). The canonical print of `and`/`or` and `logical` nodes changed from the symbols to the words; the JSON `logical.op` is still `"&&"` / `"||"`. |
| 0.20 | Added (minor): the `tuple` expression node; `subquery.frontier` and `subquery.depth`; `query.frontier` (the body's seed frontier, legal only with `follow`). **Removed** (pre-1.0, so a minor): `follow.where`, `follow.frontier`, `follow.depth`, `follow.by` — a destination's `where` is its block's `where`, `frontier`/`depth` are its block's new fields, `by` has no replacement (identity is `$key`, SEMANTICS §16, projectable as a `$key:` item). The `follow.where` and `follow.by` traversal clauses are gone; `follow.frontier` now marks a destination block's `frontier` (visited at depth − 1). |
| 0.21 | Added (minor): the `template` expression node (`parts: (string \| Expr)[]`, strictly alternating text and interpolation). Its text parts are the first non-node values a child slot holds: a walk over `parts` skips them. Nothing renamed or removed. |
| 0.22 | Added (minor): `"~"`, `"~*"`, `"!~"`, `"!~*"` as `binary` operators (the infix regex operators, sugar over `matches`). No node or field added, renamed or removed; a reader of an older minor may meet an unknown `binary.op`. The canonical print writes the operator as written (`a ~ b`), at comparison precedence. |
| 0.23 | Added (minor): the `references` static pass (§5b) and the fixture kind `expect.references` (README). No node or field added, renamed or removed; the grammar and the semantics are unchanged. |
| 0.24 | Added (minor): the `groupBy` and `key` nodes; `query.groupBy`, `query.having`, `subquery.groupBy`, `subquery.having` (materialized as `null`); the `aggregate` expression node (a free call by an aggregate name parses to it, never to a `call`); the traversal clauses `groupBy` and `having`; a `groupBy` node as a `references` step; `count` as a value-position directive (an `op` with `op: "count"` in a `collect` item or an operand). Nothing renamed or removed. A reader of an older minor meets the two new fields on every body and the new kinds. |
