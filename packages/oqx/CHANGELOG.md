# Changelog

All notable changes to `@omgbase/oqx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.12.0] - 2026-09-25

**OQX is now a language with a specification and two implementations.** The
spec lives at `spec/oqx` in the monorepo: `GRAMMAR.md`, `SEMANTICS.md`, and
737 executable fixtures in 27 files that this package and the Rust
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
