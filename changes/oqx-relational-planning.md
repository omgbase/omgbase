---
npm:
  "@omgbase/oqx": patch
crates:
  oqx: patch
---
Relational patterns in nested blocks stop being quadratic. The in-memory engine
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
