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
| `op` | a consumer directive `<receiver> <consumer> [distinct] { … } [<relop> N]` | a `where` leaf (a consumer test), a `collect` item's value, a `follow` destination block, and — since 0.17 — an expression (a value-position `collect`/`first`/`single`, which is what a bracket lookup `x[…]` desugars to: `jobs[0].pay` is a `member` over an `op`) |
| `follow` | the `follow` clause | `query.follow`, `subquery.follow` |
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
| `binary` | arithmetic, comparison, or identity (`is`, `is not`), `op` the source operator | expressions |
| `logical` | `&&`, `||` in value position | expressions |
| `in` | membership | expressions |
| `range` | `lo..hi`, `lo...hi`, `..hi`, `lo..` | expressions |

The `where` tree and value expressions are distinct families: `and`/`or`/`not`
own the boolean structure of a predicate so consumer tests compose with scalar
leaves, while `logical` is `&&`/`||` *as a value* (`(a || b) == 5`). A
where-position consumer test is the `op` node itself; discriminate a `where`
node on `kind`.

There is no `index` node and no node for any other sugar: a bracket lookup
`x[n]` / `x[p]` is parsed straight to the `op` (`first { offset n }`,
`first { where p }`; `single` under `!`), `x { … }` to a `collect` op, `is x`
and `not x` to `unary` nodes (GRAMMAR §4). The only shapes 0.17 adds are
`required` and the `is`/`is not` operators of `binary`. Nor is there a node
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
| `query` | `source: Expr` — the root collection (`from <source>` or the directive receiver); `from: Expr[]` — further `from E` re-projections (only a directive form's block can hold them); `where: Where \| null`; `select: SelectItem[]`; `orderBy: Order[] \| null`; `consumer: "collect" \| "exists" \| "none" \| "count" \| "first" \| "single"`; `follow: Follow \| null`; `distinct: boolean`; `values: boolean`; `limit: Expr \| null`; `offset: Expr \| null` |
| `subquery` | `from`, `where`, `select`, `orderBy`, `follow`, `values`, `limit`, `offset` as above (no `source`, `consumer`, `distinct` — those belong to the enclosing `op`) |
| `op` | `receiver: Expr`; `op: Consumer`; `sub: Subquery`; `countCmp: { op: RelOp, value: number } \| null` — the `count { … } <relop> N` test, an attribute rather than a node; `distinct: boolean` — `<op> distinct { … }` and `{ select distinct … }` are one flag |
| `follow` | `destinations: (Expr \| Op)[]` — ≥ 1, in source order; `distinct: boolean`; `where: Expr \| null`; `frontier: Expr \| null`; `depth: number \| null` (1..8); `by: Expr \| null` |
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
| `binary` | `op: "==" \| "!=" \| "<" \| "<=" \| ">" \| ">=" \| "is" \| "is not" \| "+" \| "-" \| "*" \| "/" \| "%"`; `left: Expr`; `right: Expr` |
| `logical` | `op: "&&" \| "\|\|"`; `left: Expr`; `right: Expr` |
| `in` | `left: Expr`; `right: Expr` |
| `range` | `lo: Expr \| null`; `hi: Expr \| null`; `exclusiveEnd: boolean` |

Shape rules the parser guarantees (and `cases/ast.json` pins):

- The two spellings of one construct are one tree: `name from x` ≡ `select name
  from x`; `x collect { … }` ≡ `select … from x …`; `jobs collect distinct { e }`
  ≡ `jobs collect { select distinct e }`; parentheses leave no node. **Sugar
  desugars in the parser** (since 0.17): `x { … }` is the `collect` op;
  `people exists { age > 50 }` is `where age > 50`; `x[p]` is the op
  `first { where p }`, `x[n]` the op `first { offset n }`, `x[p]!` a `required`
  over `single { where p }`, `x[n]!` a `required` over `first { offset n }`;
  `is x` is `!!x` (two `unary` nodes), `not x` is `!x`. A `select` item whose
  value is exactly a directive is the `collect` item kind whatever spelling
  produced it (`boss: ^people[id == ^manager]`); one that navigates or operates
  on a directive (`jobs[0].pay`) is a `field` whose expression contains the
  `op`. An unaliased `field` keys by the last segment of the navigation under
  any `required` (`name!` → `name`, `jobs[0].pay` → `pay`).
- `where` keeps its **surface form**: a `select` alias referenced in `where` is
  an `ident` in the tree. The substitution (SEMANTICS §14) is the pure function
  `resolveAliases` / `resolve_aliases`, applied by the run entry points exactly
  once before evaluation; the parser only validates the references (a cycle or
  a block alias inside an expression is still a parse error). A tool that wants
  the evaluated predicate calls it; a tool that wants what the user wrote reads
  the tree as parsed.
- Numbers are doubles (`1e3` is `1000`); string literals are decoded (`"a\nb"`
  holds a newline).

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
- `follow`: the `follow` word through the last destination or the options'
  closing brace;
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
  inclusive; `binding`: its `${n}` marker;
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
`follow`, `orderBy`, `limit`, `offset`; for `subquery` the same without
`source`; for `op` — `receiver`, `sub`; for `follow` — `destinations`,
`where`, `frontier`, `by`; then the obvious slots of the smaller nodes
(`expr`, `parts`, `recv`, `args`, `left`/`right`, `lo`/`hi`; `required` — `expr`).

- **`visit(root, { enter?(node, ctx), leave?(node, ctx) })`** — depth-first.
  `enter` may return `false` to skip the node's children (`leave` is still
  called). `ctx` is `{ path, clause, depth }`:
  - `path` — the ancestors, root first;
  - `clause` — where the node sits: `source` (the root collection), `from`
    (a re-projection), `where`, `select`, `orderBy`, `limit`, `offset`,
    `follow` (the `follow` node itself), `follow.destination`,
    `follow.where`, `follow.frontier`, `follow.by`; the root has none
    (`null`); a node inherits its parent's clause unless it opens one;
  - `depth` — the **scope depth** at which the node is evaluated (SEMANTICS
    §2): 0 is the root scope — a top-level `source`, `limit` and `offset`;
    1 is a top-level row — the top-level `where`, `select`, `orderBy`, `from`
    re-projections and `follow`; a block's receiver is read at its enclosing
    depth and its body one deeper; a follow `where` is one deeper than the
    frontier row it tests successors of.
- **`transform(root, f)`** — rebuilds a `query`/`subquery` with every
  expression mapped through `f(expr, ctx)`, children first (so `f` sees an
  expression whose operands are already mapped). Nodes `f` returns unchanged
  keep their span (and, in TypeScript, their identity).

Rust: `walk::visit(Node::Query(&q), &mut visitor)` with a `Visitor` trait
(`enter` / `leave`), `walk::transform(&q, &mut f)`; `Node` is a borrowed
enum over the node kinds, `Clause` the enum above.

## 6. Printing

`print(node)` renders a tree as canonical source: single spaces; `select`
written at the top level (the keyword-less projection is sugar); every item
aliased (`name: name` — the alias is what the record key is, and a name
that differs from the navigation's last segment must be written anyway);
double-quoted strings with the GRAMMAR §1 escapes; the minimal parentheses
the precedence table (GRAMMAR §4) requires, and the predicate/scalar group
rule of GRAMMAR §3 for `where`; `distinct` on a directive spelled
`<op> distinct { … }`; follow options in the order `where`, `frontier`,
`depth`, `by`; an empty block as `{ }`; the logical connectives as the **words**
`and` / `or` (since 0.18; `&&` / `||` parse to the same nodes and the JSON
`op` stays `"&&"` / `"||"`), the prefix negation as `!`. **Sugar prints as the
explicit form** it parsed to (since 0.17): `x { p }` as `x collect { where p }`,
`jobs[0].pay` as `jobs first { offset 0 }.pay`, `x[p]!` as `x single { where
p }!`, `is x` as `!!x`, `not x` as `!x`, an absolute `N^name` as the caret
form `^…name` (since 0.18); `x!` prints as written, with its operand
parenthesized below postfix level (`(a + 1)!`); `x is y` / `x is not y` print
as written.

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
