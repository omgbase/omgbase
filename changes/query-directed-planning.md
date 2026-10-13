---
npm:
  "@omgbase/core": minor
  omgbase: patch
crates:
  omgbase-mutate: minor
  omgbase-store: patch
  omgbase-surface: minor
  omgbase: patch
---
Query-directed planning (`spec/mutate` 3.1 §11.8 "Selectors", `spec/surface` 4.1): `plan`, `execute` and `apply` accept a `select` — an OQX query over `docs`, `blocks` or `nodes` — together with effect templates; the planner derives one concrete effect per hit per template and freezes the result as an ordinary plan. A template without a target writes to the hit; a target or value may be `{ "oqx": "<expr>" }`, evaluated in the hit's row scope, so a row can direct an effect at another document (a completed workstream appending a line to its project hub via `path: { oqx: "project" }`). The plan gains a digested `selection { query, expect, templates, cardinality, identities }` recorded as given, so `execute` never re-runs the query and a hit that appears or vanishes between plan and execute is a `plan_mismatch`; `planner_v` is `p3` (every plan digest changes). Cross-hit collisions follow the existing rules: inserts into one shared target sequence in hit order, two different values for one scalar are `conflicting_effects`. `expect.max` bounds the selection and is required on a one-shot `apply`; a selection over the bound or the 1000-row ceiling is `selection_too_large` and nothing is planned; zero hits is an empty plan and no commit. A target expression that resolves to nothing is `target_missing`, to several `ambiguous_target`. Selectors may use `limit` and `order by`; `offset`, `distinct`, `values`, `links`, `follow`, nested `from` and the counting consumers are refused up front. Compiled in omgbase by rewriting the query's AST; the OQX language is unchanged.
