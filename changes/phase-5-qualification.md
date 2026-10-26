---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-store: minor
  omgbase-surface: minor
  omgbase-sync: minor
  omgbase-mutate: minor
---
Modular core Phase 5a — the qualification tooling (spec/store 17.3, surface 6.3, sync 4.3, cli 5.3, mutate 4.1). **D2 step two:** a tombstone DELETES the document's `blocks` rows in both tombstone paths (the observed deletion and `docs_delete`) — the recorder's last captured revision holds the deleted content, the pool and the claims carry revival and identity; a 17.0–17.2 database's tombstoned rows leave on its first open (a 17.x finish step after the claims backfill). **The four compositions:** `OMGBASE_CAPABILITIES` accepts `core | history | semantic | full` (`historyCapabilities`, `semanticCapabilities`, `envComposition`), every fixture runner (store, mutate, surface, graph, sync, search, cli, interop) runs under all four with per-composition compare/map/skip rules and one ledger line, and `pnpm conformance` (`scripts/conformance.mjs`) prints the suite × composition matrix. **Fault injection:** `OMGBASE_FAULT=<site>[:<nth>]` at `recorder.capture`, `feed.append`, `commit.after-commit`, `materialize.before-write`, `materialize.after-write` (`InjectedFault`; `fault-injection.test.ts` pins the acceptance-matrix outcomes). **The qualification script** `scripts/qualify/migrate-copy.mjs` copies a workspace (the original never opened), snapshots BEFORE/AFTER, migrates, diffs the §7 step-4 invariants, runs CAS and recovery, checks compatible-open with the Rust binary and an older `--before-bin`, and sizes the four compositions (`docs/modular-core/migration-runbook.md`). The Rust crates are named for the spec minors; their twin mirrors the tombstone DELETE, the finish step, the compositions and the fault sites.
