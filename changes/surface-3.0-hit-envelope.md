---
npm:
  "@omgbase/oqx-syntax": none
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: major
  omgbase: minor
---
**Surface 3.0 / CLI 3.0 — the query hit envelope renders identity as `$id`/`$path`.** A lean hit was `{ id, path, ...projection }`; the expression language has no bare `id` or `path` (a reserved basename is rejected with "did you mean `$id`?"), so the envelope taught agents a key the next `where` clause refused — copy a key from a result into a query and walk into the rejection. Projections already kept their `$` (`$title`); only the envelope stripped it. Now every `query` hit is **`{ $id, $path, ...projection }`** and a row surfacing as a value (an empty `collect { }` / `first { }` / `single { }`, a `values` item that is a row) is **`{ $id, $path }`** — result keys live in the same `$`-prefixed intrinsic namespace as the language, and the round trip holds with no translation: `select $id from docs where $id == "<a hit's $id>"`. A `$id`/`$path` projection collapses onto the envelope key (before, `select $path` produced `path` *and* `$path`); `id`/`path` are ordinary projected names (a column aliased `id:` used to overwrite the envelope — `spec/surface` §9); `values` mode is untouched (no hits). The keyset cursor encodes the two values, not key names: stored cursors stay valid. Both engines render the envelope byte-identically; `spec/surface` §7 `read-query` pins the round trip across them, `query-docs`/`reads` gain the round-trip, collapse, rows-as-values and `values` cases. The `omg query`/`run` table reads `$id`, `$path`; `--json`/`--jsonl` carry the envelope verbatim, `--ids` the `$id`s; the shell's row ref for a hit is its `$id` (label `$path`) and `.field` admits a `$`-prefixed name (`@1.$id`, `@t[1].$path`). The `query_syntax` reference, the `query` tool description, both CLI help cards and the docs describe the new shape; `graph` reads its walk's hits by `$id`/`$path`.

**Not in scope / unchanged:** every other tool's envelope is a tool result, not a hit, and keeps its names — `docs_list` items `{ path }`, `docs_read.path`, `graph` `documents[].id`/`.path`, `text_search` hits, `resolve` `{ id, locator }`, `changes_since`, `nodes_get.id`, …; `@omgbase/sync` consumes no query hits.

**Migration:** `hit.id → hit.$id`, `hit.path → hit.$path` in every hit parser (`omg query --json`/`--jsonl`, MCP `query` results, nested rows-as-values); a `select $path, …` consumer that read `path` reads `$path`; a projection aliased `id:`/`path:` to dodge the collision keeps working as a column; tool envelopes and stored cursors need nothing. The graph-ui example accepts both shapes by server surface version (`hit.$id ?? hit.id`).
