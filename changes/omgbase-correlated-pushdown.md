---
npm:
  "@omgbase/core": patch
crates:
  omgbase-surface: patch
---
Nested blocks over a root scan are answered from SQLite indexes instead of
materializing the target. `$repo.docs` / `$repo.edges` / … (and a bare target
at the root scope) are handed to the OQX engine as a lazy handle — one per
target per run — and `makeStoreContext().indexFor` (TypeScript) /
`StoreContext::index_for` (Rust, `store_index`) answers a block's correlated
or constant equality (`$repo.docs collect { where customer == ^$path }`,
`$repo.edges exists { where $dst == ^$id }`, `$repo.docs single { where type
== "x" }`) with one prepared, index-driven statement per probe under the
planner's live-row and repo guards, yielding rows built exactly as the scan
builds them: docs `$id`, `$path`, `$title` and any property key (typed — a
string probe matches only a string row, a number only a number row, a boolean
only a bool row, under the scalar-in-scope rule); blocks `$id`, `$doc`, `type`,
`$path`; nodes `$id`, `$doc_id`, `kind`, `name`, `$path`; edges `$id`, `$src`,
`$dst`, `$path`, `$dst_path`. An absent probe (`key == null`) or an unindexed
path (`format`, `predicate`, `$tags`, `meta.id`) reads the handle once per run
and falls back to the scan's own answer. Results are unchanged (the
conformance suites gained the correlated shapes); 500 raw probes over 5,000
documents take ≈ 9 ms of SQLite time and the whole planned query ≈ 160–180 ms
wall time (TypeScript); a 2,000-document / 200-probe run takes ≈ 60 ms end to
end (Rust). The planner's scan SQL now lives in
`oqx-js/sql/scan.ts` (shared with the indexes).
