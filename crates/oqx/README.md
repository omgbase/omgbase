# oqx

**OQX (omgbase Query eXpressions) — Rust implementation.**

OQX is a small query language for querying JSON-shaped collections — arrays of
records, nested relations, recursive trees — with a readable, declarative
syntax:

```text
select name, id, title
from people
where jobs exists { where employer == "Globocorp" && !end_date }
```

This crate is the second implementation of the language. The reference
implementation is the TypeScript package
[`@omgbase/oqx`](https://github.com/omgbase/omgbase/tree/main/packages/oqx).
Both conform to the language-neutral specification and fixtures at
[`spec/oqx`](https://github.com/omgbase/omgbase/tree/main/spec/oqx) in the same
repository, and each reports the spec version it conforms to.

## Status

Conformance-first, and conformant: `tests/spec.rs` runs every fixture in
`spec/oqx/cases` (877 cases in 29 files at language version 0.14) and all of them
pass, so `cargo test -p oqx` requires every case to pass. Published on crates.io
as `oqx`.

The runner keeps an allowlist mechanism for the periods when the spec runs
ahead of the port (from `spec/oqx/README.md`): if `tests/spec-passing.txt`
exists, it names the case ids (`<file-stem>::<name>`, one per line) that must
pass; a listed case that fails fails the build, an unlisted case that passes
fails the build with a message asking for it to be added, and a listed id that
no longer exists is an error too. When the file is absent — the current state —
every case must pass. `cargo test -p oqx` prints `spec: N passed, M failed, K
listed` on stderr and, on failure, the offending case ids grouped by fixture
file with a one-line reason each.

To (re)generate the allowlist from the currently passing set — for example
after new fixtures land in `spec/oqx/cases` before the port catches up — run:

```sh
OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec
```

This writes the list (and prints any listed case that now fails, so nothing is
blessed silently), or deletes the file once every case passes.

## Layering

Mirrors the reference so the two can be read side by side:

- `lexer` / `parser` → `ast` — the fixed clause order (`select, from, where,
  follow, order by, limit, offset`; only a leading `select` may drop its
  keyword) and the expression grammar. `follow` takes a comma-separated list
  of destinations (`Follow.destinations`, since 0.14): a relation of the
  current row, or a destination block — `^people collect { where manager ==
  ^id }`, a select-position directive re-read per frontier row with `^` bound
  to that row; the walk is their union, successors unioned by identity within a
  step, and the follow `where` reads the frontier row through `^`.
- `semantics` — the scalar contract every backend obeys: typed equality with no
  coercion, absent-aware ordering (absent sorts last both ways), membership,
  ranges, arithmetic, builtins.
- `regex_dialect` — `matches()`: the spec's regex baseline parsed and rewritten
  for the `regex` crate (`\d`→`[0-9]`, `\b`→`(?-u:\b)`, `\s`→one listed set,
  flags→`(?ims)`), so a pattern means the same here as in the reference;
  `DataContext::regex_dialect()` / `DefaultContext::with_regex_dialect` opt a
  host into the crate's native syntax instead (not portable).
- `engine` — the in-memory engine over a `DataContext` (the seam that binds the
  language to a data model; the default context is plain `Value`s).
- `optimize` — the nested-block optimizer (below).
- `planner` — the seam for pushing work into a store and finishing the residual
  in memory.

## Performance: relational patterns

A nested block runs once per enclosing row, so `^customers first { where id ==
^customer_id }`, `^orders collect { … where customer_id == ^id }` and
`^customers exists { where id == ^customer_id }` would be quadratic if the block
scanned its receiver each time. `optimize` gives every block a `BlockPlan` and
applies `Rule`s (`fn(&BlockPlan, &RuleContext) -> Option<BlockPlan>`, a fixpoint
over `DEFAULT_RULES`), each proven unobservable — same rows, lifts and errors as
the scan:

- **Correlated equality → hash probe.** A top-level `&&` conjunct `local ==
  outer` (`local` an identifier/member chain on the block's row, `outer`
  reading nothing from it and raise-free) is answered from a `HashIndex` on the
  receiver built once per run (keys reproduce `==`: absent ≡ null, `-0` ≡ `0`,
  `NaN` matches nothing, arrays/objects structurally as this crate's `equals`
  is); the residual conjuncts run over the bucket in receiver order; several
  equalities intersect smallest first.
- **Invariant blocks run once** (nothing read from any enclosing row, no lifts).
- **`exists`/`none` stop at the first bucket row** that passes the residual.
- **`exists`/`none`/`count` with no residual** are answered from the bucket's
  size after the bound.

The sound rule: an equality is hoisted only when every conjunct to its left is
raise-free (no call, no `single`, no lift, no bound, no out-of-range binding)
and its outer side is; a `where` with a lift anywhere is never probed. Property
reads are treated as total (SEMANTICS §23); an `Err` from `DataContext::get`
while an index is built or a probe value evaluated falls back to the scan.

Unlike the reference, a `Value` has no identity, so a receiver is indexed only
when it is *statically* stable — it reads only the root scope and bindings
(`^customers` from a top-level block, a `${…}` binding). A per-row relation is
scanned. `DataContext::index_for(collection, path)` lets a context hand the
engine a pre-built `RowIndex`; `IndexedCollection::context(extra_roots)` does so
for its fields. `InMemoryEngine::with_rules(&[])` is the naive engine;
`tests/spec.rs` proves optimized ≡ naive (result, or error stage and message)
over every spec fixture, and `tests/optimize.rs` covers the rules.

## Features

- `json` — `From`/`Into` between `oqx::Value` and `serde_json::Value`.
- `sqlite` — `adapters::sqlite::SqliteTable`, a `QueryPlanner` that pushes the
  flat query core (scan + translatable conjunctive predicates, `LIMIT` for
  unordered `first`/`single`) into SQL over a bundled SQLite via `rusqlite`,
  leaving the rest to the in-memory residual. Implies `json`.

## License

MIT
