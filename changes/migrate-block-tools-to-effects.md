---
npm:
  "@omgbase/core": minor
  omgbase: patch
crates:
  omgbase-store: patch
  omgbase-surface: minor
  omgbase: patch
---
Migration batch 1 (ADR-021; `spec/surface` 3.2 "Sugar over effects"): `blocks_insert`, `blocks_update`, `blocks_move`, `blocks_remove`, `blocks_split`, `blocks_merge`, `blocks_check`, `nodes_set`, `blocks_append`, `docs_append`, `links_retarget` and `links_repair` are now sugar over the Effect layer — each handler builds the equivalent effects and runs plan + execute in one transaction, with an adapter that returns exactly today's result shapes, the same error data, the same `reason`, and (on a dry run) the same consumed ids, so no existing fixture moved (proven by a legacy-versus-new equivalence sweep over the alchemy corpus in both engines). Their commits now carry ADR-003's intent record in `commits.ops`. Two behaviour fixes, pinned: `blocks_update` with an empty `expect` succeeds with a planner-pinned CAS instead of failing "expect.content_hash required", and `blocks_check` with a repeated id dedupes instead of failing the second op. Empty `blocks`/`ids` lists are an argument error (`filter_invalid`) rather than a malformed kernel op. `blocks_update` keeps the legacy kernel path when `attrs` carries keys other than `checked` (until 4.0). `docs_create`/`docs_delete`/`docs_move`/`docs_set_meta` follow in the next batch; `docs_update` stays on its planner until 3.0.
