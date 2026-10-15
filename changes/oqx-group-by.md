---
npm:
  "@omgbase/oqx": none
  "@omgbase/oqx-syntax": minor
  "@omgbase/core": minor
  omgbase: minor
crates:
  oqx: none
  omgbase-surface: patch
  omgbase: minor
---
OQX 0.24 (`spec/oqx` 0.23 → 0.24): **`group by` with aggregates** — the one
language gap for Dataview parity, and the end of "a census needs a full-repo row
dump". `group by <key>, …` and `having <pred>` sit after `follow` and before
`order by` in the fixed clause order; the rows a body yields become one row per
distinct key tuple (identities: absent ≡ null; first-appearance order); the
body's select, `having` and `order by` then read the **group** — a key, an
aggregate (`count()`, `count(e)`, `sum`, `avg`, `min`, `max`, `collect`,
`first`, `last`, `any`, `all`, with `count(distinct e)` / `collect(distinct
e)`), or `rows` (the group's rows, a value and a receiver: `rows count { where
checked }`, `rows collect { select title }`) — and any other bare name is a
parse error naming it. Value aggregates see present values only (`sum` of none
is `0`, `avg`/`min`/`max`/`first`/`last` of none absent); `any`/`all` test
truthiness. Without a `select` the projection is the keys plus `count`.
`count { … }` is a value wherever a value stands. New suite
`spec/oqx/cases/group-by.json` (94 cases; 1473 fixtures); every `expect.ast`
fixture gains `groupBy: null` / `having: null` on its bodies.

- `@omgbase/oqx` 0.24.0 is bumped by hand with its CHANGELOG, per the
  standalone convention (`none` here so the release does not bump it again);
  the `oqx` crate follows by the Rust twin (`none` here), after which
  `omgbase-surface` and `omgbase` move their pin to `oqx = "0.24.0"`.
- `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.24; `group by`/`having` as
  clauses, the aggregates as builtin functions before `(`, `rows` as an
  intrinsic; `group`/`having` contextual; assets regenerated.
- `@omgbase/core`: a grouped query yields groups, not store rows — the runner
  injects no `id`/`path` envelope (a hit is the projection as written, as
  `bare` yields; `bare` is accepted and changes nothing), pages by position
  with a null cursor, keeps `values`; the tier-3 planner declines a grouped
  query whole (decline (c) extended to the post-group clauses; SQL `GROUP BY`
  pushdown is a later round); the unknown-names pass judges keys and aggregate
  arguments on the rows and a `rows … { }` block's names on the grouped rows'
  kind (a `groupBy` step of `references`); the `query_syntax` reference states
  the new clause order and shows a grouped example; `spec-versions` oqx 0.24;
  the alchemy corpus gains a documents-per-layer census and a tasks-per-document
  checked/unchecked grouping; the conformance suite runs six grouped queries.
- `omgbase` (npm): the `omg query` surface inherits the grouped result shape.
- `omgbase-surface`: `reference.rs` twin updated byte for byte;
  `spec/surface/cases/examples.json` regenerated (the `query_syntax` text).
- `omgbase` (crate): the Rust twin implements the language round from the
  report and the spec (open until it lands).
