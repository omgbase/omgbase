# Changelog

All notable changes to `oqx` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

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
