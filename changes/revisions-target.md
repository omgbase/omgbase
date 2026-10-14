---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase: minor
---
History is queryable (spec/surface 4.7). A `revisions` target in OQX — one row
per stored revision of every document of the repository, deleted documents
included: `id`/`rev`, `path` (as of the revision), `seq`, `doc_id`, `commit`,
`ts`, `origin`, `actor`, `reason`, `hash`, `is_current`, with `doc` reaching the
document's current row (absent for a deleted one) and `revisions` a relation of
every document (`from docs where revisions count { where origin == "api" } > 0`);
`^revisions` from a row, `entries(^$it)` names five collections. `docs_read`
takes `at: <rev>` — the document as of that revision (`raw` reconstructed,
`path` as of the revision, `renderedHashMatch`; no `properties`, `include_ids`
refused) — and `docs_read_at` is now its sugar with the identical result (the
current property bag flagged `propertiesAreCurrent` is gone from it). The
minimal tools profile reaches history through `query` and `docs_read` alone;
`docs_history`/`docs_read_at`/`docs_diff_unified` stay as sugar.
