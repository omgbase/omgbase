---
npm:
  "@omgbase/oqx": minor
  "@omgbase/oqx-syntax": patch
  "@omgbase/core": minor
  omgbase: minor
crates:
  oqx: minor
  omgbase-surface: patch
  omgbase: minor
---
OQX language **0.14** (`spec/oqx/VERSION`): `follow` gains correlated successor
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
