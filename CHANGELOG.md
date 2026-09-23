# Changelog

All notable changes to `@omgbase/oqx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

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
