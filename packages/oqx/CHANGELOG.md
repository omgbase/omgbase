# Changelog

All notable changes to `@omgbase/oqx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.18.0] - 2026-10-10

### Minor
- **OQX 0.17 — join syntax sugar** (`spec/oqx` 0.16 → 0.17; `cases/sugar.json`, 134 new cases, 1131 in all; GRAMMAR §2/§4, SEMANTICS §5b/§14, AST.md). Everything that is pure sugar desugars **in the parser** to existing nodes, so the optimizer, the pushdown planners and `print` see the explicit form; two shapes are new.

  - **A receiver block without a consumer is `collect`**: `x { … }` ≡ `x collect { … }` in select position, where position and as a whole query (`docs { age > 15 }`). Carve-out: after the last `follow` destination a brace is still the options block (`follow children { depth 2 }`); a destination block keeps its consumer.
  - **Where-first bodies**: a block whose leading expression is *syntactically* a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a postfix `!` or bracket chain, a consumer test — anything that is not a bare name, a dotted navigation or a lift) drops `where`: `people exists { age > 50 }`, `jobs collect { pay > 2 }`. Bare names stay projections (`docs { is active }` is the bare-field filter); `{ name where age >= 18 }` keeps the keyword; `{ age >= 18, name }` is an error suggesting that form. The top level is unchanged: `age > 15 from people` is still the parse error (where would precede from).
  - **Brackets**: `x[p]` → `x first { where p }`; `x[p]!` → `x single { where p }` under a `required` (zero matches is the required error, many the `single` error); `x[n]` / `x[${i}]` → `x first { offset n }` (out of range is absent; a non-integer binding is the `offset` eval error); `x[n]!` → required positional. Chains compose (`refs(company)[0].name`, `jobs[pay > 2][0]`); a negative or fractional literal index is a parse error; `[`/`]` are tokens.
  - **Postfix `!` = required** — new node `{ kind: "required", expr }` / `Expr::Required`: the value, or the eval error `` `<expr>!` is absent `` (`on <id>` when the row has a scalar identity). Never a filter or a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!.name` vs `refs(c)[0].name!`); a `!` right after a complete operand is postfix, a `!` at operand start is the negation (`!=` stays one token: write `a! == b` with the space).
  - **`is` / `not` / `and` / `or`** become keywords (reserved: `from where select is not and or` + the literal words). Prefix `is x` ≡ `!!x`, `not x` ≡ `!x`. Infix `x is y` / `x is not y` — new `binary` ops `"is"` / `"is not"` (`BinaryOp::Is` / `IsNot`) — compare **identity** per SEMANTICS §16 (a row's `id` when present, else structural), so `$it is ^$it` compares rows and for scalars `is` ≡ `==`; comparison precedence, non-chainable. `and` / `or` are exact synonyms of `&&` / `||` (same nodes, precedence, short-circuit and value semantics; `print` still writes the symbols). `in` over rows is unchanged (deferred).
  - **Alias reuse in `select`**: an item may reference the items to its left (`boss: ^people[id == ^manager], bossName: boss.name`), inlined by `resolveAliases` / `resolve_aliases` like a `where` alias; a reference to an item to the right is a parse error (a cycle when it refers back). **Behavior change:** `a: b, b: a` is now the cycle error (it was a field swap), and `senior: age > 50, s: senior` projects the alias (it was the row field `senior`).
  - **A directive may stand in value position** (`jobs first { }.pay`): this is how `print` writes a bracket chain back; `op` joins the `Expr` family by position (`isExpr` stays false for it; `transform` rebuilds it without handing it to the mapping). AST.md §8 records the additions (minor; nothing renamed or removed).
  - Existing fixtures that turned from error into meaning: `people exists { age > 50 }`-style blocks (`where` ×4, `errors-parse` consumer-after-projection re-queried as `{ name, jobs exists { } }`, `projection` call-in-block re-queried as `{ name, has(budget) }`), the `[` lex-error case (now a token).
  - **omgbase binding**: the pushdown planners decline `is` / `is not` (identity is the engine's structural notion, not SQL's `IS`), `required` and value-position directives (they may raise), so they stay residual; `query_syntax` gains a "Sugar" block; `docs/query-language.md` §3.6. The surface fixture `implicit-where-in-block` re-queried as `{ kind == "md:task", name }` (still the loud error pointing at `where`).
  - `@omgbase/oqx-syntax`: `[`/`]` are bracket punctuation (no longer lex errors), `is`/`not`/`and`/`or` are keywords highlighted as word operators, `LANGUAGE_VERSION` 0.17; assets regenerated.
- **OQX 0.18 — the root scope is a row, absolute scope references, canonical `and`/`or`** (`spec/oqx` 0.17 → 0.18; `cases/absolute-refs.json` new (24), `outer-refs` +6 (the `$it is absent at the root scope` case re-queried as the root-object cases), `limit-offset` +2: 1163 cases in all; GRAMMAR §1/§3/§4/§5/§6, SEMANTICS §2/§8/§18/§19, AST.md §1/§3/§6/§8, README).

  - **The root scope is a row: the host's root object.** SEMANTICS §2 step 1 no longer reads "absent at the root": `$it` at the root scope is the host's root object, so from a top-level row `^$it` is that object, `entries(^$it)` enumerates the named roots in insertion order, `^$it.people` ≡ `^people` (and works as a receiver), `^^$it` from depth two is the same object, and `$it values from $it` is the object as one row. The seam gained **`DataContext.rootObject?(): unknown`** (TypeScript, optional — absent keeps the root row absent) / **`fn root_object(&self) -> Value`** (Rust, provided method defaulting to `Value::Undefined`); `DefaultContext` returns the roots record it was constructed with. Step 5 at the root still reads `ctx.root(name)` — a bare name is never a property of the root object — so hosts with lazy roots are unaffected, and a host-provided root-level name (omgbase will expose the repository id as `$id`, cashing in `$repo.$id` → `^$id` from depth one, `^^$id` from depth two) is readable through `root(name)`. A top-level `limit`/`offset` is evaluated in the root scope *without* its row (SEMANTICS §18): `^$it` reached through a bracket inside the bound is absent, pinned.
  - **`N^name` — absolute scope references.** An unsigned integer literal immediately followed by `^` (no whitespace) names a scope by its syntactic depth (root 0, top-level rows 1, +1 per block body, a destination block's rows one below the frontier row, a follow `where` one deeper than the frontier row — the `visit` depth): `0^docs`, `0^$it`, `1^$path`, `0^$id`, and as a lift target `1^tasks: text`. It **desugars in the parser** to the existing `outer` node (or lift) with `levels = currentDepth − N`; no new AST shape, `print` writes the carets. `N ≥ currentDepth` is the parse error `scope N does not enclose this block (the current scope is depth D)`; `1 ^x` (a space) and `1.0^x` stay the stray-`^` error. Composes with brackets, calls and receivers (`0^docs[0]`, `x[p == 0^flag]`, `entries(0^$it)`, `0^$it.docs collect { … }`, `follow 0^people collect { where manager == 1^id }`, `follow next { where prev == 1^id && 0^k == 2 }`, `limit 1^n`). Both parsers now track the scope depth of every position.
  - **Canonical `print` writes `and` / `or`** for the `where` tree's `and`/`or` nodes and for `logical` expressions (both engines); `!` stays `!`, `is`/`is not` were already words, the JSON `logical.op` stays `"&&"`/`"||"`. Consequence: every query text omgbase's `graph` macro prints flips from `||` to `or` — the pinned `graph` query strings in `spec/surface` (`reads.json`, and the `omgbase-surface` unit test for the multi-root seed) are regenerated; nothing else in the surface fixtures changes.
  - **omgbase binding** (`@omgbase/core` `oqx-js/context.ts`, `omgbase-surface` `context.rs`): the root object is the repository root (`$repo`), so `^$it` from a top-level row is `$repo` and `^$it.docs` the docs scan. The `^docs`/`$repo` redesign and the `$id` root name are a separate change.
  - `@omgbase/oqx-syntax`: the `N^` lexeme highlights as one outer-reference token (`lift`), `LANGUAGE_VERSION` 0.18; assets regenerated.

## [0.16.0] - 2026-10-09

### Minor
- **OQX 0.16 — the AST is a first-class contract** (`spec/oqx/AST.md`, fixtures `cases/ast.json` + `cases/ast-spans.json`, 70 new cases; 959 in all). Both engines now produce one normalized tree a tool can reflect on without re-parsing:

  - **Spans on every node**: `span: [start, end)` in Unicode code points over the raw source (a template's `rawSource`, where a binding occupies its `${n}` marker). The TypeScript lexer counted UTF-16 units; it now counts code points like the Rust one, so the `(at offset N)` of a lex/parse error is the same number in both engines. `toUtf16(span, source)` converts for editors.
  - **Normalized shape**: `kind` on every node (`query`, `subquery`, `follow`, `order` added), optionals materialized (`where`/`limit`/`offset`/`countCmp: null`, `distinct`/`values: false`), operators and consumers serialized as their source words, the never-produced `Expr.index` variant removed. `toJSON(query)` / `ast_to_json(&query)` emit `{ "oqx": "0.16", "kind": "query", … }`; the Rust crate derives serde under the `json` feature (`query_from_json` reads it back).
  - **`where` keeps its surface form**: the parser no longer inlines `select` aliases into `where` (it only validates them — every `errors-parse` fixture is unchanged); the substitution is the exported pure `resolveAliases` / `resolve_aliases`, applied exactly once by the run entry points (`oqx`, `run`, `execute`, `runQuery`; `run_query`, `execute`). **An `Engine.run` now evaluates the query it is given** — code that drives `InMemoryEngine`/`PlannedEngine` directly with a query whose `where` uses aliases must resolve first (resolution is not idempotent: `name: name.upper() … where name`).
  - **Traversal**: `visit(root, { enter, leave })` with `{ path, clause, depth }` (scope depth, 0 = root) and `transform(root, f)`, both driven by one child-key table (`CHILDREN`; Rust `walk::visit`/`transform` with a `Visitor` trait, `Node`, `Clause`); `stripSpans` / `strip_spans`; builders `build.*` / `oqx::build::*` for hand-made nodes (empty span `[0, 0]`).
  - **Canonical printer**: `print(node)` / `print_query` — single spaces, `select` written at the top level, every item aliased, double-quoted strings, minimal parentheses from the precedence table; `printTemplate` → `{ strings, count, indices }` for a tree with bindings (`print` throws, new error stage `print`). Law, enforced by both spec runners over every fixture query: `strip(parse(print(parse(q)))) ≡ strip(parse(q))`.
  - **Migration** for anyone constructing AST literals (after 0.14's `receiver` → `destinations`): add `kind` to `Query`/`Subquery`/`Follow`/`OrderSpec`, `span` to every node, write the materialized fields (`limit: null`, `countCmp: null`, `distinct: false`, `values: false`), drop `index`; or use `build.*`. Rust: struct variants gained `span` (match with `..`), `Expr::Lit(v)` is `Expr::Lit { value, span }`, `Token` gained `end`.
  - **omgbase** (`@omgbase/core`, `omgbase-surface`): the runner's `$self` row-function rewrite is a `transform`, the `semantic("…")` scan a `visit`, aliases are resolved once before the runner's own rewrites; the `graph` macro builds its `follow` walk with the builders and `print`s it instead of splicing strings — the generated query text and every `spec/surface` result are unchanged. `@omgbase/oqx-syntax`'s `LANGUAGE_VERSION` moves to `0.16` (assets regenerated).

## [0.15.0] - 2026-10-09

### Minor
- OQX language **0.15**: the intrinsic naming the current item is **`$it`**; `$value` is no longer an intrinsic and has no synonym. `$it` is the scope's row itself — the top-level row, a nested block's inner item, each element of a scalar collection, the entry's value inside `entries(x)` — absent at the root, with `^$it` the enclosing row, `$it.field` navigation, `$it values`, `$it` as a `follow … { by $it }` identity. A row property literally named `$it` is shadowed by the intrinsic. `$value` is now an ordinary property name under SEMANTICS §2 step 5, exactly like the non-metadata `$` names since 0.13: `{ "$value": 3 }` projects `3`, a row without one reads absent, over scalars it is absent, and inside an `entries()` scope it is a property of the entry's *value*. Why: "self" implies a fixed referent while the row changes per scope; "it" is the pronoun for whatever is being handled; keeping `$value` as a synonym would spell one concept two ways. `$key` is unchanged, and the `{ key, value }` record of `entries(x)` used as a plain value is unchanged (that is a value shape, not the intrinsic). **Migration:** replace `$value` with `$it` in every query (`s/\$value/\$it/g`); nothing else moves. New `intrinsics` fixtures pin the rule; every other fixture query was rewritten with its expectation untouched. omgbase's query surface (`query`, `query_syntax`, the CLI help, `docs/query-language.md`, the tutorial, `spec/surface` fixture queries) follows: a `$value` in an omgbase query now reads a frontmatter/attrs key so named.

## [0.14.1] - 2026-10-09

### Patch
- Relational patterns in nested blocks stop being quadratic. The in-memory engine
  now runs every nested block through an optimizer (`optimize/`: a logical
  `BlockPlan` per block, a `Rule` interface, a fixpoint driver) with four rules,
  each proven unobservable — same rows, lifts and errors as the scan:

  - **Correlated equality → hash probe.** `^customers first { where id ==
    ^customer_id }`, `^orders collect { … where customer_id == ^id }`,
    `^customers exists { where id == ^customer_id }`, `${customers} first { … }`:
    a top-level `&&` conjunct `local == outer` (either side) is answered from a
    hash index on the receiver built once per run (per collection and path),
    with the residual conjuncts evaluated over the bucket in receiver order.
    Multiple equalities intersect smallest-first. The index reproduces §5
    equality exactly (absent ≡ null, `-0` ≡ `0`, `NaN` matches nothing, objects
    by reference). The sound rule: every conjunct left of the equality must be
    raise-free (no call, no `single`, no lift, no bound, no out-of-range binding)
    and the outer side must be raise-free and read nothing from the block's row;
    otherwise the scan runs. A receiver is indexed when it is statically stable
    (reads only the root/bindings) or when the same collection object is probed
    twice; a receiver that yields a fresh value per enclosing row is scanned.
    5k × 5k zip: ~9 ms (the scan: seconds).
  - **Invariant block hoisting.** A block that reads nothing from any enclosing
    row and lifts nothing is evaluated once per run and its value reused.
  - **Semi/anti-join short-circuit** is kept over the probe's bucket (`exists`
    stops at the first bucket row that passes).
  - **Cardinality.** `exists`/`none`/`count` with no residual predicate are
    answered from the bucket (or receiver) size without entering a row.

  `DataContext.indexFor(collection, path)` (TypeScript) / `index_for` (Rust) is
  a new optional seam for pre-built indexes; `IndexedCollection` keys under §5
  equality (it kept `null` and `undefined` apart and matched `NaN` to itself)
  and exposes `context()` (TypeScript) so a residual's nested blocks see the
  root and reuse its indexes. `InMemoryEngine` takes `{ rules, trace }`
  (TypeScript) / `with_rules` (Rust); `rules: []` is the naive scan, and the
  conformance suites prove optimized ≡ naive — result or error, stage and
  message — over every `spec/oqx` fixture. No language change.

  A `RowIndex` may also implement `lookupRows(value)` (TypeScript) /
  `lookup_rows` (Rust): the matching rows themselves, in receiver order. For a
  statically stable receiver the engine asks the context's index **before**
  reading the collection and, when it answers rows, never materializes the
  receiver (one correlation is probed — the first whose outer side is a `^`
  reference rather than a literal — and the other conjuncts, remaining equalities
  included, stay residual in their original order; a `TraceEvent` of kind
  `lookup` reports it). A statically stable receiver is now also read once per
  run when nothing is correlated, instead of once per enclosing row. Rust:
  `index_for` returns `Option<Rc<dyn RowIndex>>` and `lookup` returns
  `Vec<usize>`, so a context can create indexes on demand.

  `DataContext::materialize(value)` (Rust) / `materialize?(value)` (TypeScript)
  is a new optional seam, default identity: a context that hands out a stand-in
  for a collection it has not read yet (a lazy table handle) resolves it here.
  The engine calls it on every value it is about to observe as a value — an
  operand, an argument, a projected item, an `order by`/`distinct` key, a
  `where` scalar, a lift — and never in row position (the source, a receiver, a
  `from`, a `follow` destination), where the value reaches `to_rows`/`index_for`
  as handed out. The Rust engine's execution path was folded to mirror the
  TypeScript one: one `access` for every consumer (the `follow` seeds included),
  `scan`/`materialize`, a `memoized` helper for invariant plans, `outer_value`,
  and `lookup_order`/`residual_without` in `optimize`; optimized ≡ naive over
  every fixture, same perf.

## [0.14.0] - 2026-10-06

### Minor
- OQX language **0.14** (`spec/oqx/VERSION`): `follow` gains correlated successor
  predicates and destination lists.

  - **`^` in the follow `where` is the frontier row.** `follow R { where P }` now
    reads `P` in the candidate's scope whose parent is the row being expanded, so
    `follow doc.in { where before.contains(^$path) }` steps only into rows that
    name the row they were reached from; `^^name` is the walk's enclosing scope.
    Before, `^` skipped the frontier row and read the enclosing scope (the root
    for a top-level walk), so a correlated predicate silently never held.
    `frontier` and `by` are unchanged (`^` there is the enclosing scope).
  - **Destination lists.** `follow a, b, …` walks the union of several
    destinations; each is a relation of the current row or a **destination
    block** — a select-position `collect`/`first`/`single` block re-evaluated per
    frontier row with `^` bound to it (`follow ^people collect { where manager ==
    ^id }`, `follow before, ^docs collect { where after.contains(^$path) }`).
    Within one expansion step the successors are unioned by identity — the
    walk's identity, so `by E` governs it: a relation holding a node twice now
    yields one successor, and under `by type` same-type siblings reached in one
    step are one node (the surface case `query-follow::by-rekeys-identity` goes
    from 8 to 5 hits). `frontier`, `depth`, `where`
    and `by` apply to the whole walk; `$ordinal` stays `(depth, path)`.
  - AST: `Follow.receiver` becomes `Follow.destinations` (TypeScript
    `(Expr | OpNode)[]`; Rust `Vec<FollowDestination>` with `Relation(Expr)` /
    `Block(OpNode)`). omgbase's query rewriters and planners read the new shape;
    `@omgbase/oqx-syntax` pins `LANGUAGE_VERSION` to `0.14`.
  - 27 new fixtures in `spec/oqx/cases/follow.json` (877 cases in 29 files).

## [0.13.0] - 2026-09-26

Language `0.13` (`spec/oqx/VERSION`; `LANGUAGE_VERSION` is `"0.13"`). One
scoping rule changed; the spec now has 850 fixtures in 29 files (15 new, in
`cases/intrinsics.json`; no existing expectation moved).

### Changed (breaking) — semantics
- **Intrinsic names fall through to the row where the scope carries no such
  metadata** (SEMANTICS §2 steps 2–3, §20, §21). `$key` is metadata only in an
  `entries()` scope; `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` only
  on a `follow` occurrence. Anywhere else the six names are ordinary property
  reads of the row (step 5): a plain row `{ "$depth": 3, "$ordinal": 7 }`
  projects `3`/`7` at the top level and inside a nested `collect`; a `where`
  on `$depth` without a `follow` is an ordinary predicate (no seed/post-walk
  split); `order by $ordinal` over rows without the property is unchanged
  (absent sorts last). Inside a nested block within a `follow`, a bare `$depth`
  is now the nested row's own `$depth` property (absent unless the data carries
  one) and `^$depth` is still the occurrence's. Where the metadata exists it
  wins over a same-named row property, so nothing inside a `follow` changes.
  Before, the six names read absent everywhere they were not metadata.
  **Why:** omgbase's blocks carry a `$depth` and `$ordinal` of their own that
  the recursion intrinsics shadowed outside a `follow`; `spec/surface` §9 had
  pinned this as a candidate minor.

### Added
- `DataContext.get` is documented as the host's error channel: a throw (an
  `OqxError` with stage `"eval"`, or any error) rejects the read and is the
  query's error. The behavior is unchanged; the Rust crate's `DataContext::get`
  now returns `Result<Value>` to match.

## [0.12.0] - 2026-09-25

**OQX is now a language with a specification and two implementations.** The
spec lives at `spec/oqx` in the monorepo: `GRAMMAR.md`, `SEMANTICS.md`, and
835 executable fixtures in 28 files that this package and the Rust
crate `oqx` both run. **Versioning changed accordingly:** the language version
is `spec/oqx/VERSION` (`0.12`) and every implementation's version is
`<language>.<patch>`, so `@omgbase/oqx 0.12.x` and the `oqx` crate `0.12.x`
both mean "the 0.12 language"; the patch digit is per implementation. The
package exports `LANGUAGE_VERSION`.

Everything below follows one principle, applied without exception: **least
surprise.** Where the reference behaved by JavaScript accident, it now does
what a careful user would predict.

### Changed (breaking) — semantics
- **Identity is structural.** `distinct` over unprojected rows and `follow`
  cycle detection/dedup use the `id` property when present, else the row's
  structural value (deep equality, key order ignored). Previously identities
  were stringified, so every id-less object collided as `[object Object]`
  (`count distinct { }` over two different objects gave 1; `follow` over
  id-less nodes marked every successor a cycle) and `1` equalled `"1"`.
- **No cross-type ordering.** `<  <=  >  >=` and range coverage order only
  number/number and string/string; every other pair, including booleans and
  anything absent, is false. `1 < "2"` and `"3" in 1..5` were true.
- **Strings order and measure by Unicode code point**, not UTF-16 code unit:
  `"😀".size()` is 1 and astral characters sort after the BMP.
- **Own enumerable properties only.** Property reads (`name`, `.name`,
  `^name`), `has()`, `in` over an object, and `entries()` never see inherited
  members (`has(toString)` is false). Arrays expose only their integer
  indices — `.length` is absent; use `size()`. Primitives have no properties.
- **Absent propagates.** Any arithmetic with an absent operand is absent,
  including `"a" + missing` (was `"aundefined"`) and `null + 1` (was `1`).
  `.lower()` / `.upper()` on absent are absent (were `"undefined"` /
  `"NULL"`).
- **Regex is an OQX concern.** An invalid `matches()` pattern raises
  `OqxError` (`eval`, `invalid regular expression`) instead of a raw
  `SyntaxError`. Lookaround and backreferences are rejected (`not supported in
  OQX`) so the dialect is the portable intersection.
- **Ranges never appear in results.** Projecting a range value is an error
  (`a range … cannot appear in a result`); no range covers an absent value,
  however open.
- **`&&` and `||` evaluate strictly left to right** with short-circuit; the
  engine no longer reorders conjuncts by cost, so `false && bogus()` never
  errors and `true && bogus()` always does.
- **`single` reports the true row count** in its error.
- **`$ordinal` path components compare as values** (numbers numerically,
  before strings), not as text: `[1, 9, 10]`, not `[1, 10, 9]`.
- **Bindings out of range** (`run(query, { values })` with fewer values than
  the query references) raise `OqxError` instead of reading `undefined`.

### Changed (breaking) — grammar
- **`!` has one precedence everywhere:** a prefix operator binding tighter
  than comparison, applied to the operand right after it. `where !a == b` is
  `(!a) == b` (it negated the whole comparison before); `!jobs exists { … }`
  and `!(a == b)` work as written.
- **Parenthesized scalars work in `where`:** `where (a + 1) > 2` was a parse
  error; a group followed by an operator is a scalar.
- **`follow distinct` requires a relation** (`follow distinct { depth 2 }` no
  longer treats `distinct` as the relation name); `follow ^rel` is a clear
  error.
- **Open-ended ranges stop at clause words** (`in ..5 order by a`); a range
  with no bound at all is an error.
- **Duplicate projection names are an error** (`a: 1, a: 2` last-wins is
  gone), including a dotted default key colliding with an alias.
- **Malformed numerals are lex errors:** `1e`, `1e+`, `1.`, `.5`, `xs.0`.
  `1..5`, `1...5`, `..5`, `1..`, `1.5..2.5` are unchanged.
- **Top-level `limit ^n` / `offset ^n`** are parse errors (`no enclosing
  scope`); they were always absent and failed at run time.
- **`true` / `false` / `null` are literals in every position;** as a receiver
  or follow relation they error instead of resolving a root by that name.
- **Lifts (`^name:`) outside a where-position `collect`** are parse errors
  instead of silently doing nothing.
- **Chained comparisons** (`a == b == c`) error clearly; **stray tokens** after
  a query or in a block get a located message; clause words without their
  clause (`order age`, bare `follow`, `limit x`) say what they need.

### Changed (breaking) — regular expressions
- **`matches()` compiles the OQX regex baseline, not a JavaScript `RegExp`.**
  The baseline (SEMANTICS §11) is a fixed grammar — literals and escaped
  metacharacters, `\n \t \r \f \v`, `\uXXXX` / `\u{…}`, the classes
  `\d \D \w \W \s \S` with spec-fixed sets (`\d` = `[0-9]`, `\w` =
  `[A-Za-z0-9_]`, `\s` = one listed set), `\b \B` over that `\w`, bracket
  classes, `.`, `^ $`, the quantifiers and their lazy forms, `|`, `(…)`,
  `(?:…)`, `(?<name>…)` — and the pattern is validated and rewritten before
  `RegExp` sees it (`src/regex.ts`). **The line terminator is `\n` alone**
  for `.` and for `m`-mode anchors (`\r`, U+2028, U+2029 are ordinary
  characters), and `.` consumes a code point. Every construct outside the
  grammar is an eval error naming it (`an inline flag (?i) is not supported in
  OQX regular expressions`): lookaround and backreferences (already rejected),
  now also inline flags `(?i)` / `(?i:…)`, `\p{…}`, `\x..`, `\c.`, octal
  escapes, identity escapes of non-metacharacters, possessive quantifiers,
  atomic and comment groups, `(?P<…>)`, `\A \z \Z \G \K \Q \E`, POSIX and
  nested classes, class set operations, `[\b]`. Malformed patterns that
  `RegExp` tolerated (`a{`, a lone `]`, `a**`, `[]`, `[^]`, `(?<n>…)` twice)
  are `invalid regular expression`.
- **Flags are an explicit second argument**: `matches(pattern, flags)` with
  `flags` a string of distinct letters from `i` (simple case folding, so `é`
  matches `É`), `m`, `s`. Anything else is an eval error: `unknown regex
  flag` (`"g"`, `"I"`, a non-string) or `duplicate regex flag`. There is no
  inline flag syntax.
- **Engine-native dialects are a host opt-in, not query syntax.**
  `DataContext` gains an optional `regexDialect: "oqx" | "native"` (default
  `"oqx"`); `new DefaultContext(roots, { regexDialect: "native" })` hands
  patterns to `RegExp` unvalidated with the `u` flag plus the given flags —
  implementation-defined, not portable, untested by the spec. `DefaultContext`
  answers `matches` itself so it can read the dialect; `BUILTIN_METHODS.matches`
  stays the baseline, and `semantics.regexMatches(recv, args, dialect)` is the
  helper for custom contexts. `compileRegex(pattern, flags?, dialect?)` and the
  `RegexDialect` / `RegexFlags` types are exported.
- Fixtures: the `matches` cases moved from `strings.json` to a new
  `regex.json` (21 moved, 98 added), pinning each baseline construct, the
  `\n`-only line terminator, ASCII `\d \w \b`, the `\s` set, code-point `.`,
  flags, and one rejection per construct.

### Documentation
- Integer-like object keys enumerate first in JavaScript before OQX sees the
  object; this is a host fact the reference cannot undo, and fixtures must not
  depend on the relative order of integer-like and other keys.

## [0.11.0] - 2026-09-24

### Changed (breaking)
- **Clause order is fixed** (omgbase ADR-020). Within one clause body — the
  top level or any consumer block — clauses appear at most once each, in
  exactly this order: `select … from … where … follow … order by … limit N
  offset N`. Every clause is optional except a top-level `from` (the
  `<receiver> <consumer> { … }` form supplies its own source). A clause out
  of order is a parse error that names the order (`` `select` must come
  before `from` — OQX clause order is select, from, where, follow, order by,
  limit, offset ``); a second `from` in one body is a duplicate. The
  order-flexible grammar (`from ${people} select name where …`, `limit 1 name
  from …`, `offset 1 limit 1`) no longer parses.
- **Only `select` may drop its keyword, and only when it is the first clause
  written** (`name, age from people`). Every other clause always carries its
  keyword, so a predicate is never implicit: the `looksLikePredicate` shape
  heuristic is gone. **A block now needs `where`** — `jobs exists { where
  !end }` — and a bare comparison in leading position (`exists { age > 50 }`,
  `age > 50 from people`) is a parse error that points at `where`. A bare name
  in leading position projects, as before (`count { active }` selects
  `active`).
- **The `from docs count` footgun is closed.** A bare run after `from` is an
  error; `from people count` fails at `count` with a hint — write
  `people count { … }` for the whole-query consumer, or `select count from …`
  to project a field named `count`. (Previously it silently projected the
  field.)

### Added
- **`where` may reference the same body's `select` aliases.** Implemented as a
  compile-time inline rewrite (not a second execution pass): after a body is
  parsed, each bare identifier in its `where` that names an alias is replaced
  by the alias's expression, so the engine and any pushdown planner see an
  ordinary predicate. An alias shadows a same-named row field inside `where`;
  an alias's own name inside its own expression is still the field
  (`name: name.upper()` is not recursive); a chain of aliases that returns to
  one being resolved (`a: b, b: a … where a`) is a parse error; an alias whose
  value is a `collect`/`first`/`single { … }` block may stand alone as a
  where leaf (non-empty test) but not inside an expression. Each body rewrites
  only against its own `select` (nested blocks and `follow` blocks are their
  own scopes); `^name` is never an alias. `order by` is unchanged — it reads
  row fields, not aliases.

## [0.10.2] - 2026-09-23

Moved into the omgbase monorepo (`packages/oqx`, via `git subtree` — full
history preserved); package name, API, and zero-dependency boundary unchanged.
`repository`/`homepage`/`bugs` metadata now point at the monorepo. No code
changes beyond dropping one unused import.

## [0.10.1] - 2026-09-23

Metadata and documentation only; no code changes.

### Added
- `LICENSE` file (MIT) — `package.json` previously said ISC with no license text.
- Package metadata: `author`, `repository`, `homepage`, `bugs`, `keywords`,
  `sideEffects: false`, and a single consistent `description`.
- This changelog, shipped in the package.
- GitHub Actions CI (typecheck, test, build on Node 22 and 24).
- README: an "Exports" reference for every public export, the
  `DataContext.callFunction` / `callMethod` extension seam (and the
  "unknown function" pitfall of a context that does not delegate to the
  builtins), `OqxError` and its `stage` discriminator, an `IndexedCollection`
  example, `SqliteTableOptions` fields, string-literal escapes, `has(x)` and
  array `contains`, and a License section.

### Changed
- `engines.node` is now `>=22.13.0` — the floor at which `node:sqlite` (used
  only by the `./sqlite` subpath) is available without a flag. The main entry is
  plain ES2022 ESM and runs on older Node in practice.
- README "Requirements" states the real floors (see above) and that the package
  is ESM-only.

### Fixed
- README referred to `oqx.semantics`; the scalar contract is the named export
  `semantics`.

## [0.10.0] - 2026-09-22

### Added
- `entries(x)` builtin: the explicit bridge from a record to a collection of
  `{ key, value }` entries. Objects yield own enumerable pairs in insertion
  order, arrays yield `(index, element)`, `Map`s yield their entries; absence,
  scalars, and ranges yield nothing. A plain object is still **not** iterable —
  `from ${obj}` is one row.
- `$key` intrinsic: inside an entry scope, the entry's key. The scope's row is
  the property's *value*, so `$value` and bare names read the value.
  `$key` exists only in entry scopes — an array element has no implicit index.
- A free-function call may be a consumer receiver
  (`entries(prefs) exists { … }`) and may be navigated further.
- `semantics`: `makeEntry`, `isEntry`, `entriesOf` (the entry tag is a
  non-enumerable symbol, so `entries(x)` as a plain value reads as an array of
  `{ key, value }` records).

### Changed
- Engine: one `enter(row, parent, extra)` now creates every scope (top level,
  nested blocks, `from` re-projections, follow seeds/occurrences, fast paths).

## [0.9.0] - 2026-09-21

### Added
- `none { … }` consumer — true iff the block yields zero rows; the explicit
  complement of `exists`, and how universal quantification is spelled
  (`members none { where !active }`). Works in `where` position and as a
  whole-query directive (`{ consumer: "none", none }`). Not comparable and not a
  projection.
- `limit N` / `offset N` — bound the row set **after** `where` / `order by` /
  `distinct` and **before** the consumer reduces it, at the top level and in any
  block. `N` is a literal, a `${…}` binding, or an outer reference (`limit ^n`);
  it must be a non-negative integer (eval error otherwise). `limit`/`offset` are
  clause words only when followed by a number, binding, or `^`, so a field with
  that name still reads as a field.

### Changed
- Engine: `exists` / `none` / `count` fast paths stop at the (offset+1)th match;
  `first` / `single` caps grow by the offset; consumer ops share one `opRows`
  pipeline (matched → ordered → distinct → bounded), which also makes
  `collect distinct { ^x: … }` lifts dedup as documented.
- SQLite adapter: no SQL `LIMIT` under `first` / `single` when the query carries
  its own `limit` / `offset` (the residual applies them).

## [0.8.0] - 2026-09-21

### Added
- `$value` intrinsic — the current scope's own row, whatever its type. Absent at
  the root scope. Inside a nested block `$value` is the inner item and `^$value`
  the enclosing row. Never resolved through the `DataContext`.
- `values` projection mode — after a projection of exactly one item, the row's
  result is that value rather than a `{ name: value }` record. Works at the top
  level and inside any `collect` / `first` / `single` block; composes with
  `distinct` (dedup by the bare value). Cannot be combined with a lift.
- An unaliased projection item may be any value expression: a bare or dotted
  navigation keys by its last segment; a call / arithmetic / comparison is legal
  only under `values`, otherwise a clear "needs an alias" parse error.

### Fixed
- `{ has(x) }` used to misparse as select `has` + where `(x)`; it is now the
  alias error above (write `where has(x)`).

## [0.7.0] - 2026-09-19

### Changed
- **BREAKING:** bare names resolve **locally only**. A bare identifier reads the
  current row/scope; an absent local name stays absent and never falls through
  to an enclosing scope. Outer correlation is always the explicit `^name`
  (exactly one scope out per caret; past the root is absent).
- **BREAKING:** `DataContext.has` removed — it existed only to stop the scope
  climb; a computed relation now needs only `get`.
- A consumer receiver may start with `^` (`^people collect { … }`), since a
  named root is reachable from inside a row only as `^root`.
- Planner helpers / SQLite adapter: a bare identifier in a top-level `where` is
  now unambiguously a column of the scanned rows and is safe to push.

## [0.6.0] - 2026-09-17

### Added
- `range(s)` builtin: parse a string (`"1..5"`, `"1...5"`, `"..5"`,
  `"2026-01-01..2026-01-31"`, …) into the range value a `lo..hi` literal
  produces; a range passes through unchanged; anything else yields an absent
  range, so `x in range(bad)` is simply false. Bounds must share a scalar domain
  (numeric or ISO-8601).
- `semantics.parseRangeString`.

## [0.5.0] - 2026-09-16

### Added
- Ruby-style range literals: `lo..hi` (inclusive), `lo...hi` (exclusive high
  end), and open-ended `..hi` / `lo..`. Used mainly as the right side of `in`
  for interval membership; a range is a general value expression. Bounds
  compare via the ordering rules, so ranges work over numbers and ISO-8601
  date/time strings; an absent value is never covered.
- `semantics`: `makeRange`, `isRange`, `rangeCovers`; a `membership` branch for
  ranges.

### Fixed
- Lexer: a decimal point now binds only when a digit follows, so `1..5` no
  longer mis-lexes as `1.` + `.5`.

## [0.4.0] - 2026-09-16

### Added
- `distinct` modifier on consumers (top-level and nested): dedup the rows a
  consumer reduces by their **projected** value, keeping the first per distinct
  projection in order; an empty projection dedups by row identity. Spelled
  `<op> distinct { … }` or `select distinct …` inside the block.

### Fixed
- Parser: `looksLikePredicate` skips nested `{ … }` blocks when scanning for a
  top-level operator and recognizes a consumer directive
  (`… exists { }`, `… count distinct { } == N`) as a where-position predicate.

## [0.3.0] - 2026-09-16

### Changed
- `follow` is now a **per-path** walk: a node reached by N distinct paths yields
  N occurrences (previously collapsed by global identity dedup).
- Cycles are admitted **once** as `$stop == "cycle"` and never re-expanded
  (previously a revisit produced no occurrence).
- `$stop` categories are `interior | leaf | frontier | depth | cycle`
  (precedence cycle > frontier > depth > leaf > interior); only `interior` rows
  expand. The old `"continue"` is renamed `"interior"`.
- `$frontier` covers both frontier and depth cutoffs; `$leaf` stays "no
  successors".

### Added
- `$ordinal` intrinsic: a deterministic 1..N rank over `(depth, path)`.

### Fixed
- `follow distinct` now works: collapse occurrences to the minimal
  `(depth, path)` per identity (`by` key, else `ctx.identity`).

## [0.2.0] - 2026-09-16

### Changed
- Ship a compiled `dist/` (JS + `.d.ts` + source maps) instead of raw `.ts`.
  0.1.0 pointed `main` / `types` / `exports` at `src/*.ts`, which `tsc` rejects
  under `module: NodeNext` and Node refuses to type-strip under `node_modules`.
- Added `tsconfig.build.json` (`rewriteRelativeImportExtensions`) and
  `scripts/fix-dts-extensions.mjs` to rewrite `.ts` specifiers left in emitted
  declarations; `build`, `clean`, and `prepublishOnly` scripts.

### Fixed
- `order by <expr> desc` hoisted rows missing the sort key to the top. Absent
  now sorts last regardless of direction.

## [0.1.0] - 2026-09-14

First public release as `@omgbase/oqx`.

### Added
- The OQX language kernel: lexer, parser, AST; the `oqx` tagged template with
  typed value bindings (prepared-statement semantics); `parse`, `execute`, `run`.
- Projection (optional `select`, aliases, dotted navigation), `where` predicates,
  `order by`, consumers `collect` / `exists` / `count` / `first` / `single`,
  nested consumer directives over relations, lifts (`^name:`) including
  multi-level `^^` / `^^^` with flatten-append accumulation, `^name` outer
  references, and bounded recursion with `follow` and its intrinsics.
- `semantics.ts` — the normative scalar contract every backend must obey
  (typed/strict equality, absent-operand comparisons false, CEL-style `in`,
  absent-last sort), backed by a conformance suite.
- `DataContext` / `DefaultContext` (tier 2), `Engine` / `InMemoryEngine`,
  `QueryPlanner` / `Plan` / `PlannedEngine` (tier 3) with the pushdown helpers
  in `plan.ts`, and two adapters: `IndexedCollection` (hash-index probe) and
  `@omgbase/oqx/sqlite` (`SqliteTable`, real OQX→SQL pushdown over
  `node:sqlite`).

[0.10.2]: https://github.com/omgbase/omgbase/tree/main/packages/oqx
[0.10.1]: https://github.com/omgbase/oqx/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/omgbase/oqx/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/omgbase/oqx/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/omgbase/oqx/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/omgbase/oqx/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/omgbase/oqx/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/omgbase/oqx/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/omgbase/oqx/commits/v0.4.0
[0.3.0]: https://github.com/omgbase/oqx/commit/aca739b
[0.2.0]: https://github.com/omgbase/oqx/commit/82fb99e
[0.1.0]: https://github.com/omgbase/oqx/commit/4552bb5
