---
npm:
  "@omgbase/core": minor
  omgbase: minor
  "@omgbase/sync": patch
crates:
  omgbase-store: major
  omgbase-surface: minor
  omgbase-mutate: patch
  omgbase-sync: patch
  omgbase: minor
---
History retention (spec/store 14.2 → 15.0, spec/surface 4.8 → 4.9, spec/cli 4.5 → 4.6): `omg history plan | export [--prune] | attach | detach | list`. A retention policy (`history.retention` settings: `keep_days`, a `ladder` of `one per day|week|month|year` rungs, `per_doc_max`, `keep_origins`, per-glob `overrides`) selects the revisions whose bodies move to an **archive segment** — one new SQLite file per export under `.omgbase/archives/` (`spec/store/archive.sql`, with a manifest) — and `--prune` squashes the store in one transaction: an archived revision keeps its `revisions`/`commits` rows (the `revisions` target, `docs_history` and `changes_since` keep listing it) and loses `root_tree`/`frontmatter_blob`, gaining `archive`; wholly archived commits' dispositions go, their block changes go except each block's earliest row (the mint oracle's); GC sweeps the bodies; the segment is recorded in the new `archives` table. Reads at an archived revision (`docs_read { at }`, `docs_read_at`, `docs_diff`, `docs_diff_unified`, `omg diff`) go through the attached segment byte for byte, or fail with the new `revision_archived { rev, archive, path? }`; the `revisions` target and `docs_history` gain `archived`. Schema v15 migration rebuilds `revisions` (nullable body columns, `archive`) and creates `archives`; `doctor --size` gains `archived` and the retention advice. Fixtures: new `spec/store/cases/retention.json`, `reads::archived`, `spec/cli` `history.json` 42 → 70; every store/mutate/sync projection gained `archive: null` / `archives: []`.
