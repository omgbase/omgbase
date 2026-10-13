# Changelog

All notable changes to `oqx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.22.0] - 2026-10-13

### Minor
- OQX 0.22 (`spec/oqx` 0.21 → 0.22): **infix regex operators**. `a ~ b` ≡ `a.matches(b)`, `a ~* b` ≡ `a.matches(b, "i")`, `a !~ b` ≡ `!a.matches(b)`, `a !~* b` ≡ `!a.matches(b, "i")` — pure sugar over `matches` at comparison precedence, non-associative, with every `matches` rule intact (unanchored search, the OQX regex baseline, string forms, an absent receiver false — so `absent !~ "x"` is **true**, unlike SQL's NULL). New suite `regex-operators` (40 cases; 1350 fixtures, every one round-tripping through `print`).
  - Lexer: `!~*`, `!~`, `~*`, `~` are `Op` tokens scanned longest first (`TRIPLE_OPS` before `MULTI_OPS` before `SINGLE_OPS`), so `!~` wins over `!` and `~*` over `~`/`*`.
  - AST: `BinaryOp::Match` (`~`), `MatchI` (`~*`), `NotMatch` (`!~`), `NotMatchI` (`!~*`) — the node keeps the operator as written (serde word, `as_str`, `from_word`); `BinaryOp::regex()` yields the `(negated, flags)` of the `matches` call it stands for, `is_regex()` tests for one. `print` writes the operator back at comparison level.
  - Engine: evaluated through `DataContext::call_method("matches", …)`, the same dispatch as the call, so a host's `matches` and `regex_dialect` apply.
  - Planners: never translated to SQL (`SqliteTable` leaves a regex operator residual, like the call) and never raise-free in the optimizer.

## [0.21.0] - 2026-10-13

### Minor
- OQX 0.21 (`spec/oqx` 0.20 → 0.21): **template literals**. A backtick string `` `${title} (${era})` `` is a primary value usable wherever an expression is (`select`, `where`, a call argument, `order by`, a tuple element, a where-first block, a method receiver). Each `${…}` holds one full expression — arithmetic, calls, a `{ … }` block, another template literal — read at the current scope depth; the lexer balances braces, so a block's `}` inside an interpolation stays a brace. Semantics (SEMANTICS §7b) follow the `+` string rule: the text parts and each interpolated value's `string_form` concatenated (a number without a trailing `.0`, `-0` as `0`, booleans as the words); an absent (`undefined`/`null`) interpolation makes the whole literal absent; a list, a record or a range is the eval error `` cannot interpolate `${xs}` in a template literal: it is a list — only a string, a number, a boolean or an absent value has a string form ``. Every interpolation is evaluated, in order. Text decodes with the string literal's escape rule (`\<c>` → `c`, so `` \` ``, `\$`, `\\`, and `\n`/`\t`/`\r`/`\0`); newlines stand verbatim; quotes are text; `${x}` inside a quoted string is still text. Errors: `empty interpolation `${}` in a template literal — an interpolation holds an expression (`${name}`) (at offset N)` (N = the `${`), `expected '}' to close the `${…}` interpolation of a template literal`, the lex errors `unterminated template literal at N` (the open literal's backtick) and `unterminated ${…} interpolation in a template literal at N — expected '}'`; a tagged-template fragment that ends inside a backtick literal is that lex error with ` — a template literal must be complete within one fragment: a ${…} binding cannot stand inside a backtick literal (…)` appended — a bound value is never source text.
  - Lexer: `TokType::TmplStart` / `TmplText` (decoded run) / `TmplInterpStart` / `TmplInterpEnd` / `TmplEnd` (`tmpl_start`, … in `as_str`), a mode stack inside `lex_fragment`.
  - AST: `Expr::Template { parts, span }` with `TemplatePart::Text(String) | Expr(Expr)`; `parts` alternates strictly text, expression, text, … (odd length, a possibly empty text first and last) — the JSON form is `{ "kind": "template", "parts": ["", {…}, " ("], "span": […] }`, a text part the bare string. `Expr::kind()` is `"template"`. `walk::template_exprs(parts)` iterates the interpolations; `visit`/`transform`/`strip_spans`, `resolve_aliases` (an alias referenced inside an interpolation is inlined) and the optimizer's scope analysis see them; a template is raise-free only with no interpolation. `build::template(parts)` normalizes loose parts to the strict alternation; `build::text` / `build::interp`.
  - `print` writes the literal back with the backtick form: `` \` ``, `\\`, `\$` before a `{`, the control characters as in a string; interpolations as `${…}` around the full expression. Primary precedence (no parentheses as an operand or a receiver). The round-trip law holds.
  - Planner: a template is never pushed down (the SQLite adapter leaves it residual); a template receiver of a bracket or a block is "`` ` ``…`` ` `` is a literal, not a collection" like any literal.
  - `LANGUAGE_VERSION` 0.21.

## [0.20.0] - 2026-10-11

### Minor
- OQX 0.20 (`spec/oqx` 0.19 → 0.20; 1188 → 1258 fixtures, three new suites `tuples`, `identity`, `cardinality`):

  - **`follow` loses its options block.** A brace after *any* destination opens that destination's block (`follow children { depth 2 }`, `follow a, children { id != "root" }`, `follow entries(kids) { where … }`), with the 0.17 body rules. Two clauses belong to a destination block alone, after `where` in the fixed order: `depth <1..8>` (this destination expands a frontier row only while its `$depth < n`) and `frontier <expr>` (an occurrence reached through this destination for which it holds is a frontier; read with `^` the walk's enclosing scope; seeds are never frontiers). The former `where` option is the block's `where`; `by` is gone. When several destinations reach a row in one step the first governs the occurrence. **The body that carries the `follow` may carry `frontier <expr>` too** (Brendan, 2026-10-11): it applies to the SEEDS — a seed for which it holds (read in the seed's own scope, `^` the enclosing scope, like `where`) is `$stop == "frontier"` and is not expanded, while it stays in the result — so every block that feeds rows into the walk says which of its rows are frontiers, and the frontier relevant to the current `$it` is defined separately from each destination's. The clause order of every body is `select from where frontier follow order by limit offset` (a destination block's adds `depth` after `frontier`); a body-level `frontier` without a `follow` is the parse error `` `frontier` needs a `follow` ``, a body-level `depth` an error naming the destination block; inside a destination block `frontier` is always the destination's. AST: `follow` keeps only `destinations`/`distinct`; `subquery` gains `frontier`/`depth`, `query` gains `frontier`; `print` writes `follow x collect { where … depth 2 }` and a body's `frontier` between `where` and `follow`.
  - **Tuples.** `(e1, e2, …)` with two or more elements is a value and a receiver: the elements concatenated with one level of flattening (a collection contributes its items, a row itself; an absent element nothing, a `null` is kept; duplicates kept). `size((a, b))`, `"x" in (tags, aliases)`, `(mom, dad, siblings) { name values }`, `follow (before, after) { depth 2 }` (one destination over the union). New AST node `tuple { items }`.
  - **Identity is `$key`.** One meaning — the key a row is known by — for `follow` cycle detection, the per-step union, `follow distinct`, `distinct` over unprojected rows, `is`, and reading `$key` on any row. The default is the host's identity through a new `DataContext` seam (TS: optional `identityOf(row)`, replacing the required `identity`, which stays as a deprecated alias for one minor; Rust: `identity` now has a structural default), else the row's structural value; an entry's identity is its key. The language never names an `id` property: the "`id` if present" rule is removed, and the in-memory `DefaultContext` names no identity. A block may project `$key: <expr>` to give the rows it yields that identity (`select name, $key: email from people follow next { $key: email }`); in a destination block `$key:` is not a column. Caveat: identities compare as values across the whole walk, so destinations that can reach the same rows should project the same `$key`.
  - **Result shape by receiver cardinality.** In row position an array is a collection and a non-array object is one row: a `collect` over it — `doc { title }`, `title from doc`, a nested `d: dst { title }` — yields the one record (or absent when filtered out; `doc { status == "active" }` is a conditional reach-through), not a one-element list; `values` the one value; `first`/`single` that object. A scalar in row position is an eval error (`` `s` is a string ("abc"), not a collection or an object ``) instead of a one-row collection — `list(s)` says it explicitly. A `from` re-projection or a `follow` makes the result plural. Hosts say which of their objects are collections through the new optional `DataContext.isSingle` (TS; default: a non-iterable object is one row) / `is_single` (Rust; default `true`). TS `OqxResult` for `collect` gains `single: boolean` (`unwrap` yields the record or `null`); Rust gains `OqxResult::Record(Option<Value>)`.
  - **Sugar closures.** `x { … }` ≡ `x collect { … }` wherever a value is accepted, function arguments included (`size(children { is checked })`); `x distinct { … }` ≡ `x collect distinct { … }`.

  omgbase binding (surface stays 3.0; the dialect follows the language):

  - `DataContext.identityOf` (TS) / `identity` (Rust) answers a store row's id for every kind (`doc_id`, `block_id`, `node_id`, `edge_id`), so `$key` on any hit is its id and walks dedup by it as before; the binding no longer relies on the removed `id`-property rule.
  - The statically single relations `doc`, `block` and `dst` hand out an absent-single marker when they have no row, so `dst { title }` on a link row is one record and, on an external or dangling link, absent — not `[]`; as a value the marker is absent (`dst == null`, `has(dst)`, `dst.title` unchanged). The Rust context's `is_single` marks the lazy root scans as collections.
  - The `graph` tool compiles to `follow distinct <dir>_links collect { from <dst|doc> depth <n> }`; `query_syntax`, the `query` tool description, both help cards, `docs/query-language.md`, `docs/graph-and-query.md`, `docs/mcp-api.md` and the OQX tutorial describe the 0.20 forms (body-level `frontier` included); the planners treat a destination block's `frontier`/`depth` as its own, never push a tuple down, and a body with `frontier` plans like one with a `follow` — in memory (pinned on both sides). `spec/surface` `query-follow::body-frontier-keeps-seeds-unexpanded` walks the processes with the unverified one kept but not expanded.
  - `spec/surface` fixtures using the old options block are rewritten to the destination-block forms (`… collect { from dst depth 2 }`; `by type` → `{ $key: type from dst }`) and regenerated; `spec/cli` and `interop.json` regenerated with them.
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.20; `FOLLOW_OPTIONS` → `DESTINATION_CLAUSES` (`frontier`, `depth`; `by` is no longer a word of the language), assets regenerated.

## [0.19.0] - 2026-10-10

### Minor
- OQX language 0.19 — outer-reference `follow` destinations take the implicit `collect`. A `follow` destination whose receiver is headed by an outer reference (`^docs`, `^^root.rel`, `0^docs`, `^$it.docs`, with any member chain) can never be a plain destination (plain destinations are relations of the current row), so a `{` right after it now opens a **destination block** with the implicit `collect`: `follow refs(before), ^docs { where ^$path in list(after) }` walks `before` references forward and, backward, every document whose `after` names the frontier row — exactly `^docs collect { … }` with the 0.17 body rules (where-first, projections). Until 0.18 that query failed with the outer-reference error, because the 0.17 carve-out reserved a brace after the last destination for the options block. Any other receiver (a bare relation, a call like `refs(before)` or `entries(kids)`, a binding) keeps that reading: a brace after it is the options block when it is the last destination (`follow children { depth 2 }`, `follow a, children { depth 2 }`) and the "a destination block needs its consumer" error when the brace holds a predicate. An options block may still follow a trailing destination block (`follow ^docs { where … } { depth 2 }`). A plain `follow ^children` (no brace, no consumer) is still an error; its message now names both block spellings: `` `follow` takes a relation of the current row (`follow <relation>`); an outer reference walks a root collection only as a destination block — `follow ^docs { where … }` or `follow ^docs collect { … }` ``. Fixtures: 25 new cases across `follow`, `sugar`, `errors-parse` and `ast` (1188 total); the 0.17 sugar case "an outer-reference destination with a brace is the outer-reference error" is replaced by its positive form. `LANGUAGE_VERSION` is 0.19 in both engines and in `@omgbase/oqx-syntax`; the `query_syntax` reference (`@omgbase/core`, `omgbase-surface`) describes the new rule.

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

## [0.13.1] - 2026-09-27

### Patch
- `version` tool (`spec/surface` §4, 1.4) in the Rust catalog and `omgbase version [--json]` (`spec/cli` §6, 1.1): which engine and which versions — `engine: "rust"`, the binary's own version, `components` (the `omgbase` crate, every `omgbase-*` crate it is built from and `oqx`, keys sorted bytewise), `specs` (each crate's `SPEC_VERSION`, `oqx`'s `LANGUAGE_VERSION`, the binary's new `cli::SPEC_VERSION` pinned to `spec/cli/VERSION`), `schema` (`PRAGMA user_version`, `null` without a database), `mcp: { protocol }` (no SDK), `runtime` (`rustc <version>`), `commit` and `built`. The verb needs no repo, opens the workspace only for `schema`, and with `--server` returns the remote engine's answer — how a user learns whether a remote is the TypeScript or the Rust engine. `--version` is unchanged.
- `omgbase-surface`: `BuildInfo` + `Surface::with_build_info` + `version_info(store, build)`; `MCP_PROTOCOL_VERSION` (`2025-11-25`, what the reference's SDK serves) is now the transport's default at `initialize` (a client's own revision is still echoed).
- `crates/omgbase/build.rs` records `OMGBASE_COMMIT` (`git rev-parse --short HEAD` from a checkout, else the `sha1` of the packaged `.cargo_vcs_info.json`, else unset → `null`), `OMGBASE_BUILT` (RFC 3339, `SOURCE_DATE_EPOCH` honored) and `OMGBASE_RUSTC`.
- Every spec crate and `oqx` gain a `pub const VERSION` (their `CARGO_PKG_VERSION`) so the surface can report component versions.
- Runners: `spec/surface` §6 records a `version` read by shape (leaves → type names, `components` → `"<object>"`, `mcp.sdk` dropped); `spec/cli` §8 applies the same to the `version` verb's stdout (JSON leaves; human value cells; the component lines collapse to `  <object>`).
