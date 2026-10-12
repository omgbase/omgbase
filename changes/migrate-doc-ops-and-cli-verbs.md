---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-mutate: patch
  omgbase-store: patch
  omgbase-surface: minor
  omgbase: minor
---
Migration batch 2 (ADR-021; `spec/surface` 3.3, `spec/cli` 3.2): `docs_create`, `docs_delete`, `docs_move` and `docs_set_meta` are sugar over the Effect layer — same results, same errors, same `reason`, same consumed ids (a `docs_move` dry run still consumes the ids its retarget re-parse minted), with their commits carrying the intent record. One pinned identity change: `docs_set_meta` now writes through the known-id path, so its revision records every block as `edited`/`api` instead of the reconciling matcher's `same`/`exact_hash` — bytes, rows, revision and mint sequence are unchanged, and N sequential frontmatter patches compose to the same YAML as one merged patch. An empty `docs_set_meta` (no `set`, no `unset`) is now an argument error. CLI: `omg apply -f` accepts a changeset with `effects` (exclusive with `ops`; `--dry-run --json` prints the frozen plan, `--json` the receipt) and the new `omg execute (-f plan.json | -)` commits a frozen plan (`stale_plan` / `plan_mismatch` / `unsupported_plan_version` rendered as `error[<code>]`); both work over `--server`. `@omgbase/core` exports the plan module (`planEffects`, `executePlan`, `applyEffects`, `applyEffectsDetailed`, `canonicalJson`, `planDigest`, …). `docs_update` stays on its whole-document planner until mutate 3.0. Rust fix found by the equivalence sweep: an `unset` of a middle frontmatter key reordered the remaining keys (`Map::remove` swap-removes); it now preserves order like the reference.
