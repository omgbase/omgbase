---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase: minor
---
`created_at` is an engine attribute (spec/surface 4.10, §1.2): on **docs** the commit `ts` of the document's first revision (`seq = 1` — exactly `revisions first { ts values }`), on **blocks** the earliest commit `ts` among the block's `block_changes` (`updated_at`'s join under `MIN`), an ISO string in `updated_at`'s form. It is the instant omgbase first observed the thing, not a filesystem time, and it survives the store 15.0 retention squash (every revision/commit row and each block's earliest `block_changes` row stay). Bare, winning on collision: an authored `created_at:` key is `data.created_at` (`attrs.created_at` on a block). The docs form plans exactly as `updated_at` does (`where created_at < date("2026-01-01")` pushed to SQL, `order by created_at` over the pushed rows, `doc.created_at` and `dst.created_at` as the joined document's subquery); the block form is residual like the block's `updated_at`. Fixtures: `query-docs` +7, `query-blocks` +5, `reads::created-at` (three days of one document around `history_export { prune }`); `query_syntax`'s reserved-names table lists it (the Rust twin `reference.rs` updated byte for byte). The Rust engine's attribute arms follow in a separate change.
