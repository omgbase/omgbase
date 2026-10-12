---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-mutate: major
  omgbase-store: patch
  omgbase-surface: major
  omgbase: minor
---
Retirement release, part A (ADR-021; `spec/mutate` 3.0, `spec/surface` 4.0, `spec/cli` 4.0). Effects on a just-created document: a `create` is now a parsed tree the plan can address, so `insert into { kind: "document", id: "$new.0" }`, a section of it, `set markdown` / `remove` / `move` on its blocks and cross-document moves into it all work in the same plan; the plan's `opset.creates[]` records `{ symbol, path, source, before_op }`, a created document's blocks are `$new.k` symbols (zipped per kind at execute), its ingest commits under an absent-path guard with the api rule's dispositions, and the kernel `move` op gains a `doc` for a cross-document destination; `planner_v` is `p2` (every plan digest changes). `plan`'s `preview` gains `identity` (the whole-document planner's per-op dispositions, summary and diagnostics for a `set content`) and `retarget` (hits and pairs for a `retarget`). `docs_update` is now sugar for `set { document, field: "content" }` and returns the receipt — the `{ opset, plan, result }` shape is gone (preview it with `plan`), a no-change content is zero effects and no commit. `omg update` loses `--plan` (the global `--dry-run` prints the identity plan) and prints the receipt confirmation on commit. The kernel `Request` of `spec/mutate` §4 remains the library/fixture contract. Part B retires `ops` and `dry_run` on the surface; until it lands a `docs_update { dry_run }` is accepted and commits.
