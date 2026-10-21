---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase: minor
---
Surface 5.1 — the payload diet, decided from the 2026-10-21 agent-bench run (348-document repository; three payloads replayed as cached prefix on every turn):

- `docs_tree` rolls up to directories by default: one row per directory within `depth` segments — `{ _path, docs, blocks }` — plus `files_here` (the documents at the prefix itself, counted, not listed) and `total`; `files: true` lists the documents within `depth` as lean `{ _id, _path, blocks }` rows, `updated: true` adds `_updated_at`. No `kind`, no `docs: 1`. On the timeline corpus `docs_tree { depth: 2 }` went from 26.9 kB (200 rows, a second page) to 0.9 kB (15 directory rows). The 5.0 page is not reproducible exactly (a result-shape change kept a minor: payload wins).
- `execute { plan_id }` alone: the MCP server remembers the plans it produced in this process (the last 64 `plan` results, by id) and runs the remembered Plan through the full plan form — `stale_plan` vs `plan_mismatch` exactly as if the Plan had been echoed, a selector plan replayed without OQX — so a client sends 64 hex instead of echoing 5–19 kB. An id the server does not remember is the new `plan_unknown { plan_id }` (retriable). The plan and digest forms are unchanged; the `plan` ladder now ends "Commit: execute { plan_id }."
- `query_syntax {}` serves a ~3.5 kB hand-written card `{ syntax, sections }`; `{ section: "<name>" }` one chapter of the manual (`sugar`, `paths`, `targets`, `scoping`, `scalars`, `predicates`, `nested`, `select`, `flatten`, `order`, `follow`, `semantic`, `examples`); `{ section: "all" }` the whole 38 kB manual 5.0 returned by default; an unknown name is `filter_invalid` with the names and a `fix`. Both engines serve every text byte for byte.
