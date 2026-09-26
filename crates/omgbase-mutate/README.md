# omgbase-mutate

The omgbase mutation kernel, Rust implementation of `spec/mutate`: the
mutable working tree loaded from a store, the six kernel operations
(`insert`, `update`, `move`, `remove`, `split`, `merge`) with placement
addressing and compare-and-swap expectations, the splice renderer with its
dirty rules, changeset placeholder resolution, the whole-document lowering
(reconcile output → kernel ops) and the inspectable opset.

The crate is **pure**: it never touches a database or a file. `omgbase-store`
loads documents into a `MutDoc`, runs `apply`, commits the rendered bytes as
an `api` revision with the ops' known ids, and hosts the macros and document
operations.

Conformance: `tests/spec.rs` runs every case under `spec/mutate/cases`
(through `omgbase-store`), gated by `tests/spec-passing.txt` while the port
runs behind the fixtures.
