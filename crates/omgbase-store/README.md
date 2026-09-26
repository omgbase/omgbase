# omgbase-store

The omgbase store, Rust implementation: the embedded SQLite database that owns
block **identity**, **history** and the **current state** of a repository of
authored files. It opens the same databases as the TypeScript reference
(`@omgbase/core`) and passes the same fixtures. The contract is
`spec/store/README.md` in the omgbase repository; `schema.sql` (embedded here
verbatim) is the DDL, and `spec/store/cases/*.json` are the executable
fixtures the conformance runner (`tests/spec.rs`) executes.

```rust
use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, Store};

let mut store = Store::open_in_memory()?;
let repo = store.create_repo("notes")?;
let items = [BatchItem::observed("a.md", "# Title\n\nFirst.\n")];
let outcomes = store.observe_batch(&repo, &items, "2026-09-26T10:00:00.000Z", &Config::default())?;
assert!(outcomes[0].as_observed().unwrap().converged);
# Ok::<(), omgbase_store::Error>(())
```

The crate version tracks the spec: the major is the schema `user_version`
(`13`), the minor counts semantic changes without DDL.
