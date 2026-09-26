# omgbase-surface

The omgbase **surface**, Rust implementation of [`spec/surface`](../../spec/surface/README.md):
what a client sees of an omgbase repository.

- **The query binding** (`context`, `query`): an `oqx` `DataContext` over
  `omgbase_store::Store` — the `docs` / `blocks` / `nodes` / `edges` roots,
  `$repo`, the per-target intrinsics, reach-through and relations, the
  property rule (`spec/properties`), the row functions (`text`, `under`,
  `within`, `has_edge`, `semantic`, …) — and the §1.4 runner: `{ id, path }`
  injection, `distinct` by projection, top-level `limit`/`offset`, keyset
  paging with the base64url cursor, `values`, the consumer scalars, error
  normalization to `filter_invalid`.
- **The pushdown planner** (`planner`, `translate`): the tier-3 seam of
  `oqx` (`QueryPlanner` / `Plan` / `ROWS_ROOT`) over the store — a simple
  top-level scan's pushable `where` conjuncts (`$path` and the mapped
  intrinsics, doc columns and scalar properties, `attrs.<k>` and flattened
  attrs via `json_extract`, `==`/`!=` as null-safe `IS`/`IS NOT`, the
  relational ops, case-sensitive `startsWith`/`endsWith`/`contains`) become
  one SQL statement; the residual finishes in memory over the produced rows.
  Invisible by construction: `tests/spec.rs` runs every corpus-backed query
  case planned AND in memory and fails on any difference, and
  `tests/conformance.rs` does the same over the reference's conformance list.
  `QueryOptions::in_memory` forces the pure in-memory engine.
- **Reads** (`read`): `resolve_ref`, `docs_read(_many)`, `docs_read_at`,
  `nodes_get(_many)` at the five resolutions, the `docs_outline` wire format,
  `docs_list` / `docs_tree` paging.
- **History** (`history`): `history_node`, block-grain `diff`, the positional
  `diff_unified`, `docs_history`; `changes_since` is the store's.
- **The tool catalog** (`catalog`): `Surface` — every tool of the §4 table
  with its JSON-schema input, repo scoping by slug, server-side ref and
  heading resolution, CAS pinning, the `{ error, message, data?, retriable }`
  envelope, `origin.actor = "agent:mcp"`, a post-mutation hook that dry runs
  never fire. Transport-agnostic: the `omgbase` binary serves it over MCP
  stdio.

```rust
use omgbase_store::Store;
use omgbase_surface::Surface;
use serde_json::json;

let mut store = Store::open_in_memory()?;
let repo = store.create_repo("notes")?;
let mut surface = Surface::new(store, &repo, None);
surface.call("observe", json!({ "path": "a.md", "content": "# Title\n\nFirst.\n" }));
let res = surface.call("query", json!({ "query": "select $title from docs" }));
assert_eq!(res.body["hits"][0]["$title"], "Title");
# Ok::<(), omgbase_store::Error>(())
```

## Conformance

`tests/spec.rs` runs every fixture under `spec/surface/cases`: the
corpus-backed query suites (the reference's alchemy repository observed with
the fixture minter; each query planned and in memory, which must agree),
`reads.json` (observation scripts whose `read` steps call the catalog
in-process) and `cursor.json`; `interop.json` (§7, run by the `omgbase`
binary's `tests/interop.rs`) is shape-checked and skipped. While the port runs behind
the fixtures, `tests/spec-passing.txt` names the cases that must pass;
`SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec` rewrites
it. `SPEC_VERSION` tracks `spec/surface/VERSION`.

## License

MIT.
