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

## Derived layers written in the commit

Besides the durable tables, the commit transaction writes the `properties`
rows (`omgbase-properties`, store 13.1; `spec/properties`) and, since store
13.2, the graph tables of `spec/graph`: `nodes` (+ `nodes_fts`) from
`omgbase-graph`'s projection plus the `md:section` nodes, `external_nodes`
(minting `x` per new URI), the `edges` validity intervals (minting `e` per
new edge), the `doc_edges` rollup, and phantom adoption when a document row
is created. The graph conformance runner lives in
`crates/omgbase-graph/tests/spec.rs` and drives this crate. Since store 13.3
the store also runs `spec/search`: `text_search` over `blocks_fts`, the
embedding drain (`build_embed_tasks`/`embed_process`,
`build_doc_embed_tasks`/`embed_process_docs`) over the `embeddings` and
`doc_embeddings` caches with any `omgbase_search::EmbeddingProvider`,
`vector_search`/`doc_vector_search`, `hybrid_search` and `resolve`; the
search conformance runner is `crates/omgbase-search/tests/spec.rs`. Since
store 13.4 the store applies `spec/mutate` changesets with `omgbase-mutate`:
`load_mut_doc`, `apply` (file-CAS against a `DocStore` — `FsDocStore`,
`MemDocStore`, `NullDocStore` — then the `api` ingest with the ops' known
ids), the macros (`tasks_complete` … `links_repair`), the document
operations (`docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`, with a
YAML emitter matching the reference's `stringify`) and the whole-document
planner (`plan_update`/`apply_opset`/`docs_update`); the mutation
conformance runner is `crates/omgbase-mutate/tests/spec.rs`.
