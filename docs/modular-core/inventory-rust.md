# Modular core — Phase 0 inventory, Rust engine

Phase 0 of the modular-core plan: a no-behaviour-change ownership map of every reader and writer of the HISTORY records (revisions, tree_nodes, blobs, commits, dispositions, block_changes, edge intervals, tombstones, checkpoints, recovery rows, archives) and the SEMANTIC records (embeddings, doc_embeddings) in the Rust engine, each classed by whether an ordinary current-state path needs it today and assigned the plan phase that must change it. The TypeScript reference is inventoried by a sibling document with the same template (`inventory-ts.md`); §5 records where the two engines differ.

## 1. Scope and method

- **Commit inspected:** `a25a1d501b5a1fb8ced963a68258b8c38248dfa8` (main, 2026-10-24; working tree clean). Every `path:line` below is against this commit.
- **Store schema version the Rust crate implements:** 16 — `crates/omgbase-store/src/schema.rs:17` (`SCHEMA_VERSION: i64 = 16`), `crates/omgbase-store/src/lib.rs:176` (`SPEC_VERSION = "16.0"`), matching `spec/store/VERSION` (`16.0`) and the TS reference (`packages/core/src/core/store/schema.ts:5`). The 16.0 delta encoding (frontmatter and tree deltas against revision `seq − 1`, checkpoints every 16) is fully implemented (`delta.rs`, `writers.rs:187-264`, `observe.rs:646-678`). There is **no schema-version lag** between the engines.
- **Spec read first:** `spec/store/schema.sql` (every table), `spec/store/README.md` §3 (tables), §5.4 (the observe commit), §5.6–5.7 (tombstone, materialization), §6 (reads, delta resolution), §7–7.1 (GC, retention, archive), §8 (invariants I1–I10).
- **Method:** every non-test `.rs` file of the ten crates (`omgbase-store`, `omgbase-reconcile`, `omgbase-mutate`, `omgbase-graph`, `omgbase-properties`, `omgbase-search`, `omgbase-sync`, `omgbase-surface`, `omgbase-fs-adapter`, `omgbase`) was swept with a function-aware grep for the table names and the coupling columns (`to_commit`, `from_commit`, `created_commit`, `deleted_commit`, `current_rev`, `root_tree`, `frontmatter_blob`, `rendered_hash`, `checkpoint_id`, `file_hash`), then every hit was read in context (whole modules for `omgbase-store`'s `lib`, `schema`, `writers`, `mint`, `ids`, `observe`, `read`, `delta`, `history`, `materialize`, `derived`, `effects`, `graph`, `mutate`, `properties`; the touching regions of `effects_plan`, `docs_ops`, `plan`, `links`, `macros`, `search`, `size`, `retention`, `archive`; the surface's `context`, `read`, `history`, `translate`, `planner`, `names`, `links`, `catalog`; the sync crate's `admin`, `recovery`, `freshness`, `checkpoint`, `coordinator`, `engine`, `driver`; the binary's `cli/cmd/*`, `watch`, `drain`). The pure crates (`reconcile`, `mutate`, `graph`, `properties`, `search`, `fs-adapter`) open no connection; they appear as *producers* of record kinds.
- **Classes** (exactly one per row): **current-state** — an ordinary read/query/mutate/CAS/reconcile/recovery path needs it today; **archival** — only history features (`docs_read { at }`, `docs_diff*`, the `revisions` target, `blocks_history`, `docs_history`, retention/archive/GC); **semantic** — only embeddings; **both** — one site serving both and needing a split; **test-only**. **Phases:** 3 = current-state independence from history, 4 = extract capture (the recorder), 2 = extract semantic, none = archival-only code that moves behind the recorder interface unchanged.
- **Not covered:** `crates/oqx` (the query language, no store access); `crates/omgbase-format` (parsing, pure); test modules (listed in §4, not in the matrix); `examples/`; the TypeScript reference beyond the spot comparisons of §5; the `spec/*/cases` JSON contents beyond which suite each runner reads; the `docs/modular-core/baseline/` measurements another agent is producing.

## 2. The matrix

One row per (source location, table or record kind, access). `touches` names tables; the coupling columns of current-state tables (`docs.current_rev`, `docs.file_hash`, `docs.deleted_commit`, `blocks.created_commit`, `blocks.deleted_commit`, `properties.created_commit`, `edges.from_commit/to_commit`) are listed as such. Sections group by crate; the §2.12 tally is over every row.

### 2.1 omgbase-store — opener, ids, writers

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/schema.rs:144-175 migrate` | every table (`SCHEMA_SQL`) | schema | fresh DB runs `schema.sql` whole (`:148`); older DBs step through §3.4 one version per transaction | both | 3 (split the DDL into core / history / semantic bundles; the opener stays) |
| `omgbase-store/schema.rs:226 migrate_step(12)` | doc_embeddings | schema | create the document-vector table | semantic | 2 |
| `omgbase-store/schema.rs:228 migrate_step(14)` | pending_materializations | schema | create the recovery table | current-state | 3 (table stays core; its `rev_id` FK does not — see §3.4) |
| `omgbase-store/schema.rs:253-293 migrate_v15` | revisions (rebuild: nullable `root_tree`/`frontmatter_blob`, `archive`), archives | schema | §3.4 step 15, FKs off for the rebuild (`:255`), `foreign_key_check` (`:277`) | archival | none |
| `omgbase-store/schema.rs:235 migrate_step(16)` | — | schema | 16.0 is a no-op migration (checkpoint forms are valid deltas) | archival | none |
| `omgbase-store/mint.rs:28-46 ID_TABLES`, `:61-71 id_in_use` | blocks, **block_changes**, **resurrection_pool** (prefix `b`); **commits** (`c`); **revisions** (`r`); **checkpoints** (`cp`); **archives** (`s`); docs, edges, external_nodes, repos, sources | read | §2.1 uniqueness-at-mint: every candidate id is probed against its prefix's tables; a block id "lives on in history after its `blocks` row is gone" (`:25-27`) | current-state | 3 → identity claims (§3.5) |
| `omgbase-store/mint.rs:153-179 Mint::mint` | (via `id_in_use`) | read | the redraw loop every writer mints through; `Capture` modes for the planner (`:88-95`) | current-state | 3 |
| `omgbase-store/writers.rs:87-95 put_blob` | blobs | write | content-address a raw / trivia / frontmatter (raw or delta) text, `INSERT OR IGNORE` | both | 3 (current content store vs. archive bodies — §3.11) |
| `omgbase-store/writers.rs:99-112 put_node_text / put_tree_node` | tree_nodes | write | content-address a `[`-form or `{"d":…}` node | both | 4 (tree nodes are capture; the current state never reads one — §3.11) |
| `omgbase-store/writers.rs:148-164 previous_revision` | revisions | read | the document's greatest-`seq` row (`root_tree`, `frontmatter_blob`, `archive`) — the base of §5.4 step 0 | current-state | 3 → current head/content (§3.1) |
| `omgbase-store/writers.rs:169-171 is_checkpoint_revision` | revisions (via previous) | read | §4.4 rules 1–2 | current-state | 3 |
| `omgbase-store/writers.rs:187-247 write_block_tree_in / write_list` | tree_nodes (write), blobs (write), base `ResolvedList` (tree_nodes/revisions read through `TreeResolver`) | write | §5.4 step 4: reuse / full / smaller-of-delta per sibling list | both | 4 |
| `omgbase-store/writers.rs:253-264 write_frontmatter_blob` | blobs | write | §5.4 step 1: raw at a checkpoint, else smaller of line-delta and raw | both | 3 (the current raw must be a head value — §3.2) |
| `omgbase-store/writers.rs:317-344 new_commit` | commits | read+write | mint `c`; `seq = 1 + MAX(seq)` per repo (`:323-327`); insert `(ts, origin, actor, reason, checkpoint_id, ops)` | current-state | 3 → feed sequence separate from archive retention (§3.6) |
| `omgbase-store/writers.rs:362-393 write_revision` | revisions | read+write | mint `r`; `seq` per doc (`:368-375`); insert the revision row | both | 4 (capture) and 3 (the row is also the current head: `docs.current_rev` points at it) |

### 2.2 omgbase-store — the observe commit (`observe.rs`), tombstone, reads

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/observe.rs:247-303 prepare_reconcile` | docs (`:257-263`), blocks via `load_old_match_blocks`, resurrection_pool via the `pool` argument | read | §5.1 step 4: old tree + offered pool → `reconcile_document` (mints `b`) | current-state | 3 (pool = identity claims, §3.5) |
| `omgbase-store/observe.rs:306-398 cross_doc_phase` | in-memory `ReconcileResult`s only | — | §5.3 cross-document matching; `carried_id`s become `cross_doc_ids` | current-state | 3 |
| `omgbase-store/observe.rs:457-495 evict_foreign_block_rows` | blocks (read `deleted_commit IS NULL`, delete), resurrection_pool (delete) | read+delete | §5.4 step 8 | current-state | 3 |
| `omgbase-store/observe.rs:604-637 ingest_in` (step 2) | docs (`deleted_commit` read; `UPDATE … deleted_commit = NULL` `:614`; insert `:628`) | read+write | the doc row, revived on re-creation; phantom adoption (`:621`, `:634`) | current-state | 3 → explicit tombstone metadata (§3.8) |
| `omgbase-store/observe.rs:646-657 ingest_in` (step 0) | revisions (`previous_revision`), tree_nodes + revisions (`TreeResolver::tree` walk-back) | read | checkpoint decision and the base tree for the delta writer | current-state | 3 (§3.1) |
| `omgbase-store/observe.rs:661-678 ingest_in` (step 1) | blobs + revisions (`TreeResolver::frontmatter` resolves the previous raw, `:665`), blobs (write) | read+write | the frontmatter blob, raw or delta | both | 3 (§3.2) |
| `omgbase-store/observe.rs:682 ingest_in` (step 4) | tree_nodes, blobs | write | `write_block_tree_in` | both | 4 |
| `omgbase-store/observe.rs:685-698 ingest_in` (step 6) | revisions | write | `write_revision` with `rendered_hash = sha256(source)`, `seq` from step 0 | both | 4 / 3 |
| `omgbase-store/observe.rs:701-709 ingest_in` (step 7) | resurrection_pool (write from blocks; `deleted_commit = commit`, `expires_ts`) | write | pool the deleted ids for 30 days | current-state | 3 (§3.10) |
| `omgbase-store/observe.rs:723-755 ingest_in` (step 9) | blocks (delete all rows of the doc; insert with `created_commit = commit`, `deleted_commit NULL`), blocks_fts, sections | write | rebuild the hot table | current-state | 3 → explicit creation metadata (§3.8) |
| `omgbase-store/observe.rs:763-777 ingest_in` (9a, 9b) | nodes, nodes_fts, properties (`created_commit`) | write | `write_doc_nodes`, `write_doc_properties` | current-state | 3 (§3.8) |
| `omgbase-store/observe.rs:786-797 ingest_in` (9c) | edges (`from_commit`/`to_commit`), external_nodes, doc_edges | write | `resolve_edges` + `maintain_edges` | current-state | 3 (§3.7) |
| `omgbase-store/observe.rs:807-831 ingest_in` (step 10) | dispositions, block_changes | write | every verdict but `same` (`persists_disposition` `:546`), `INSERT OR IGNORE` | both | 4 (capture) — the current state reads `block_changes` for the mint oracle and `_updated_at` (§3.5, §3.8) |
| `omgbase-store/observe.rs:834-839 ingest_in` (step 11) | resurrection_pool | delete | consume the pool | current-state | 3 |
| `omgbase-store/observe.rs:844-853 ingest_in` (step 12) | docs (`current_rev`, `file_hash`, `conflicted`) | write | the pointers | current-state | 3 → current head (`current_rev` is a revision id, §3.3) |
| `omgbase-store/observe.rs:857 ingest_in` (step 13) | docs, revisions, blobs, blocks via `reconstruct` | read | `converged` | current-state | 3 (§3.2) |
| `omgbase-store/observe.rs:871-895 tombstone_in` | resurrection_pool (write from live blocks, optional), blocks_fts, blocks (`deleted_commit = commit`), docs (`deleted_commit = commit`) | write | §5.6 and `docs_delete` | current-state | 3 (§3.8, §3.10) |
| `omgbase-store/observe.rs:915-922 observe_batch` (echo gate) | docs (`file_hash`, `deleted_commit`) | read | §5.1 step 3 | current-state | none (already a head read) |
| `omgbase-store/observe.rs:925-1003 observe_batch` (gate rule) | pending_materializations (`pending_at`, `delete_pending` `:940`, `:978`, `:993`) | read+delete | §5.7 gate: echo / gone-under-intent / foreign bytes / DB already agrees | current-state | 3 (§3.4) |
| `omgbase-store/observe.rs:1246-1279 commit_ingest` | commits (`new_commit`), everything `ingest_in` touches, pending_materializations (`delete_pending` `:1273`) | write | one transaction, one commit row per member | current-state | 3 |
| `omgbase-store/observe.rs:1284-1307 tombstone_observed_deletion` | commits, + `tombstone_in` | write | `reason = 'observed deletion'` | current-state | 3 |
| `omgbase-store/observe.rs:1334-1369 observe_delete` | pending_materializations, docs, resurrection_pool (`sweep_pool` `:1363`) | read+delete | §5.6 entry with the gate rule and the sweep | current-state | 3 |
| `omgbase-store/observe.rs:1211-1238 fresh_ingest` | commits, revisions, blobs, tree_nodes, blocks… (no dispositions) | write | the re-mint path (`attach_source` of a borne source) | current-state | 3 |
| `omgbase-store/read.rs:20-33 blob_text / blob_text_at` | blobs (store or `<alias>.blobs`) | read | a blob's bytes, `""` when missing | both | 3 (§3.11) |
| `omgbase-store/read.rs:39-55 current_frontmatter_raw` | revisions (`doc_id, seq, frontmatter_blob` by `rev_id`), blobs + revisions (`TreeResolver::frontmatter` walk-back ≤ 15 steps) | read | §6.1 "Resolving" — the CURRENT document's frontmatter | current-state | 3 (§3.2) |
| `omgbase-store/read.rs:62-97 reconstruct` | docs (`current_rev`, trivia), revisions+blobs (frontmatter), blocks (live roots), blobs (raw, trivia) | read | §6.1 current bytes — the hot read behind `docs_read._raw`, `converged`, the sync engine, the doc-embedding tasks | current-state | 3 (§3.2, §3.11) |
| `omgbase-store/read.rs:118-156 read_at_revision` | docs (trivia), revisions + archives (`revision_body`), tree_nodes + blobs + revisions (`TreeResolver`, possibly `<alias>.`) | read | §6.2 bytes at a revision | both | 3 for its recovery caller (`materialize::bytes_for`, §3.4); none for the archival callers |
| `omgbase-store/read.rs:170-268 load_old_match_blocks` | blocks (live), blobs (raw per row `:209-212`) | read | §5.2 the matcher's old side | current-state | 3 (§3.11) |
| `omgbase-store/read.rs:271-285 load_pool` | resurrection_pool (`expires_ts > ts`) | read | §5.1 the offered pool | current-state | 3 (§3.10) |
| `omgbase-store/delta.rs:450-470 TreeResolver::revision` | revisions (`root_tree, frontmatter_blob, archive` by `(doc_id, seq)`; `<prefix>revisions` with `NULL AS archive` in a segment) | read | the base lookup for a delta | both | 3 |
| `omgbase-store/delta.rs:474-493 TreeResolver::base` | revisions (`seq − 1`) | read | base-liveness: missing / archived / in-segment → `Error::Delta` | both | 3 |
| `omgbase-store/delta.rs:495-504 node_text` | tree_nodes (`<prefix>`) | read | node bodies | both | 3 / 4 |
| `omgbase-store/delta.rs:510-600 list`, `:601-614 child_list`, `:616-639 tree` | tree_nodes, revisions (recursive walk-back) | read | resolve a list / a whole tree in revision context, memoized | both | 3 (the ingest base) / none (archival reads) |
| `omgbase-store/delta.rs:641-685 frontmatter` | blobs (`<prefix>blobs`), revisions (walk-back) | read | resolve a frontmatter raw through its delta chain | current-state | 3 (§3.2) |
| `omgbase-store/delta.rs:687 checkpoint_form` | — (pure over a `ResolvedTree`) | — | the self-contained form a segment holds | archival | none |

### 2.3 omgbase-store — feed, recovery, derived/GC

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/history.rs:143-249 changes_since` | commits (`MAX(seq)` `:150`; page `seq > cursor` `:160`, `:177`), revisions (`doc_id, path, rendered_hash` by commit `:197`), dispositions (`GROUP BY kind` `:200`), docs (`deleted_commit = ?` `:205`) | read | `spec/sync` §6 change feed with the human summary | both | 3 → feed sequence separate from retention (§3.6); the disposition counts in the summary are capture (4) |
| `omgbase-store/materialize.rs:102-125 pending_rows / pending_at` | pending_materializations | read | the repo's rows in insertion order / the row at a path | current-state | 3 (§3.4) |
| `omgbase-store/materialize.rs:130-157 insert_pending / delete_pending` | pending_materializations (`rev_id` FK → revisions) | write+delete | record / retire intent | current-state | 3 (§3.4) |
| `omgbase-store/materialize.rs:161-175 previous_rendered_hash` | revisions (`seq < (SELECT seq … rev_id)`) | read | the "prior bytes" a `write`/`rename` may overwrite | current-state | 3 → self-contained recovery payload (§3.4) |
| `omgbase-store/materialize.rs:183-189 bytes_for` | revisions, tree_nodes, blobs, archives (via `read_at_revision`) or docs/blocks/blobs (`reconstruct`) | read | the bytes a row must land, verified against `rendered_hash` | current-state | 3 (§3.4) |
| `omgbase-store/materialize.rs:197-208 replaceable`, `:215-292 materialize_row`, `:296-311 remove_if_replaceable` | (the two above) | read | the §5.7 table | current-state | 3 |
| `omgbase-store/materialize.rs:325-338 materialize_pending`, `:345-362 materialize_paths` | pending_materializations | read+delete | step 0 of the sweep and recovery; phase (a)/B' of a request | current-state | 3 |
| `omgbase-store/derived.rs:17-54 rebuild_sections` | blocks (`deleted_commit IS NULL`), sections | read+write | §4.6 | current-state | none |
| `omgbase-store/derived.rs:62 LIVE_LEAF_SQL`, `:76-108 fts_*`, `:127-176 fts_before_evict_rows` | blocks (`deleted_commit`), blocks_fts | read+write | `spec/search` §1.1 external-content index | current-state | none |
| `omgbase-store/derived.rs:195-229 rebuild_index` | sections, doc_edges, blocks_fts, block_changes (delete `NOT IN ARCHIVED_COMMITS_SQL` `:222`, insert from dispositions `:223`) | write | §7 rebuild | both | 4 (`block_changes` is a projection of capture; the mint oracle and `_updated_at` read it) |
| `omgbase-store/derived.rs:233 ARCHIVED_COMMITS_SQL` | commits, revisions (`archive IS NULL`) | read | commits every revision of which is archived | archival | none |
| `omgbase-store/derived.rs:249-256 count_same_dispositions` | dispositions | read | the 14.2 `same` rows | archival | none |
| `omgbase-store/derived.rs:265-298 walk_explicit`, `:307-326 mark_reachable` | tree_nodes, revisions (`DISTINCT frontmatter_blob` `:312`; `DISTINCT root_tree` `:320`) | read | the explicit GC mark from **every live revision** (§3.11) | both | 3 (the mark must gain current-state roots once revisions are optional) |
| `omgbase-store/derived.rs:331-353 unreachable_rows`, `:357-364 gc_dry_run`, `:370-379 sweep_unreachable` | tree_nodes, blobs | read+delete | the sweep (also run inside the retention squash) | both | 3 |
| `omgbase-store/derived.rs:392-409 run_gc` | tree_nodes, blobs, block_changes + dispositions (`kind = 'same'` `:400-401`) | delete | flag-gated GC and the `same` sweep | both | 3 / 4 |
| `omgbase-store/derived.rs:412-417 sweep_pool` | resurrection_pool (`expires_ts <= ts`) | delete | §5.5 | current-state | 3 |

### 2.4 omgbase-store — graph intervals, properties, the api commit

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/graph.rs:23-41 project_section_nodes` | sections, blocks (`deleted_commit IS NULL`) | read | `md:section` nodes | current-state | none |
| `omgbase-store/graph.rs:179-189 resolve_doc_path` | docs (`deleted_commit IS NULL`) | read | live doc or `phantom:<path>` | current-state | none |
| `omgbase-store/graph.rs:239-314 maintain_edges` | edges (read open rows `to_commit IS NULL` `:249`; insert `from_commit = commit, to_commit NULL` `:276`; close `UPDATE … to_commit = commit` `:304`), doc_edges | read+write | §3.3 intervals: close rather than delete | current-state | 3 → current edges separate from transitions (§3.7) |
| `omgbase-store/graph.rs:319-360 rebuild_doc_edges` | edges (`to_commit IS NULL`), doc_edges (delete+insert) | read+write | §3.4 rollup | current-state | 3 (§3.7) |
| `omgbase-store/graph.rs:367-387 adopt_phantoms` | edges (read/update open rows), doc_edges | read+write | §3.5 phantom adoption in place | current-state | 3 (§3.7) |
| `omgbase-store/properties.rs:38-71 write_doc_properties` | properties (delete by doc; insert with `created_commit`, `deleted_commit` NULL) | write | `spec/properties` §6 | current-state | 3 (§3.8) |
| `omgbase-store/properties.rs:74-120 read_doc_properties` | properties (`deleted_commit IS NULL`) | read | the live rows | current-state | none (`properties.deleted_commit` is never written non-NULL by either engine — §6) |
| `omgbase-store/effects.rs:83-98 doc_base` | docs (`path, current_rev, file_hash` where `deleted_commit IS NULL`) | read | the CAS triple | current-state | 3 (`current_rev` is a revision id — §3.3) |
| `omgbase-store/effects.rs:273-332 commit_effects_with_id` | commits (`new_commit` with `ops` `:296-308`), pending_materializations (`record_intent`, `delete_pending` `:320-324`), + every effect | write | the one-transaction api commit, `BEGIN IMMEDIATE` | current-state | 3 (`commits.ops` is the intent record: capture, 4) |
| `omgbase-store/effects.rs:370-392 current_bytes_hash` | docs LEFT JOIN revisions (`rendered_hash` by `current_rev`), `file_hash`, `reconstruct` fallback | read | a moved / deleted document's bytes hash for its pending row | current-state | 3 (§3.4; `docs.file_hash` already holds this) |
| `omgbase-store/effects.rs:401-485 record_intent` | revisions (`rendered_hash` by `rev_id` `:423-427`), pending_materializations (insert `:482`) | read+write | one `write` / `rename` / `remove` row per path | current-state | 3 (§3.4) |
| `omgbase-store/effects.rs:525-534 live_doc_at` | docs (`deleted_commit IS NULL`) | read | `path_taken` | current-state | none |
| `omgbase-store/effects.rs:540-560 check_doc`, `:585-642 validate` | docs (via `doc_base`: `current_rev`, `file_hash`) | read | `stale_plan` / `doc_missing` / `path_taken` / disk conflict inside the transaction | current-state | 3 (§3.3) |
| `omgbase-store/effects.rs:716-769 move_path_in` | docs (`path`), **revisions** (`UPDATE … path` on the current revision `:728-731`), edges (read/update open rows `:735-764`), doc_edges | write | `docs_move`'s row changes | both | 3 (edges, §3.7) and 4 (the revision re-path is a history write from a current-state op) |
| `omgbase-store/effects.rs:706-708 run_effect Tombstone` | (via `tombstone_in`) | write | `docs_delete` (no pool) / observed deletion (pool) | current-state | 3 |
| `omgbase-store/mutate.rs:59-83 find_doc_by_ref` | docs (`current_rev`) | read | id-or-path lookup | current-state | none |
| `omgbase-store/mutate.rs:101-202 load_mut_doc` | docs (`current_rev`), blocks (live), blobs (raw, trivia `:135-139`), revisions + blobs (`current_frontmatter_raw` `:188-193`) | read | §1 the working tree every `apply`/`plan` loads | current-state | 3 (§3.2, §3.11) |
| `omgbase-store/mutate.rs:345-354 doc_id_for_block` | blocks (`deleted_commit IS NULL`) | read | — | current-state | none |
| `omgbase-store/mutate.rs:545-570 OpsRunner::ensure_doc` | docs (`doc_base`), blocks (`prior_ids`) | read | load at first touch, capture the CAS triple | current-state | 3 (§3.3) |
| `omgbase-store/mutate.rs:398-462 Store::apply` | pending_materializations (`materialize_paths` `:436`, `:455`), + `commit_effects` | write | the §4 commit protocol | current-state | 3 |
| `omgbase-store/mutate.rs:469-503 disk_conflict` | (`reconciling_commit` with `clear_pending: true`) | write | the file won: observed ingest, pending row cleared | current-state | 3 |
| `omgbase-store/mutate.rs:873-889 prior_rows`, `:897-937 classify_carries`, `:951-1007 known_plan` | blocks (live), in-memory `DispositionRow`s (`matcher_v NULL`, `reason "api"`) | read | the known-id ingest's dispositions | both | 4 |
| `omgbase-store/links.rs:288-340 inbound_links_to` | edges (`to_commit IS NULL` `:299`), docs, blocks, blobs (`blob_text` `:331`) | read | the inbound links of a move / retarget | current-state | 3 (§3.7, §3.11) |
| `omgbase-store/macros.rs:20-40 raw_hash_of_block / raw_of_block` | blocks, blobs | read | a block's raw for the macros | current-state | 3 (§3.11) |
| `omgbase-store/macros.rs:225-240 sections_move` | blocks (live tops) | read | — | current-state | none |
| `omgbase-store/macros.rs:474-480 links_repair` | blocks JOIN **blobs** JOIN docs (`instr(b.bytes, ?)`) | read | candidate blocks whose raw mentions the old path | current-state | 3 (§3.11) |
| `omgbase-store/docs_ops.rs:233-243 live_doc_at`, `:380-425 plan_inbound_retarget` | docs, blocks, blobs | read | retarget planning | current-state | 3 (blobs) |
| `omgbase-store/plan.rs:172-178 plan_update` | docs (`info.current_rev` → `OpsetPrecondition.base_revision`) | read | the opset precondition | current-state | 3 (§3.3) |
| `omgbase-store/effects_plan.rs:272`, `:566`, `:603`, `:619`, `:639` (`live_block`, `block_info`, `descendants_of`, `all_blocks_of`, `target_doc`) | blocks (`deleted_commit IS NULL`) | read | planner lookups | current-state | none |
| `omgbase-store/effects_plan.rs:704-731 check_revision` | docs (`current_rev`, `file_hash` via `doc_base`) | read | `expect.revision` → `stale_plan` | current-state | 3 (§3.3) |
| `omgbase-store/effects_plan.rs:1916-1931 plan_pipeline` | docs (`DocBase` → `DocPrecondition { base_revision, hash }`) | read | the plan's frozen preconditions | current-state | 3 (§3.3) |
| `omgbase-store/effects_plan.rs:2029-2048 execute_admitted` | docs (`path`, `current_rev`, `file_hash`) | read | re-check before replay | current-state | 3 (§3.3) |
| `omgbase-store/effects_plan.rs:2208-2250 replay` | docs (`current_rev` for moves/tombstones `:2209`, `:2228`), edges (`inbound_links_to` `:2216`), commits (`ops: Some(&record)` `:2247` — the ADR-003 intent record) | read+write | the admitted plan's commit | current-state | 3; `commits.ops` is capture (4) |

### 2.5 omgbase-store — semantic (`search.rs`)

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/search.rs:55-85 text_search` | blocks_fts, blocks (`deleted_commit IS NULL`), docs | read | `spec/search` §1.3 | current-state | none |
| `omgbase-store/search.rs:113-140 BlockContexts::load` | properties (`deleted_commit IS NULL`), sections | read | §2.2 embedding context | semantic | 2 |
| `omgbase-store/search.rs:213 build_embed_tasks` | blocks, docs, sections, properties | read | §2.2 the block tasks (also the candidate set of `vector_search`) | semantic | 2 |
| `omgbase-store/search.rs:270-330 build_doc_embed_tasks` | blocks, docs, `reconstruct` (docs/revisions/blobs/blocks), properties | read | §2.4 the document tasks | semantic | 2 (note the `reconstruct` call, §6) |
| `omgbase-store/search.rs:337-352 get_cached` | embeddings | read | the block cache | semantic | 2 |
| `omgbase-store/search.rs:362-383 get_cached_doc` | doc_embeddings | read | the document cache, stale when `input_hash` differs | semantic | 2 |
| `omgbase-store/search.rs:412-453 embed_process` | embeddings (`INSERT OR REPLACE`) | write | §2.3 the block pass | semantic | 2 |
| `omgbase-store/search.rs:459-520 embed_process_docs` | doc_embeddings (`INSERT OR REPLACE`) | write | §2.4–2.5 the document pass | semantic | 2 |
| `omgbase-store/search.rs:576-591 foreign_vector_count`, `:594-603 prune_foreign_vectors` | embeddings, doc_embeddings | read / delete | §2.6 model switch | semantic | 2 |
| `omgbase-store/search.rs:628-650 block_vector`, `:653-666 current_vector` | blocks, docs, embeddings | read | §3 the block's CURRENT vector (keyed by live `raw_hash` + ctx) | semantic | 2 |
| `omgbase-store/search.rs:671-706 vector_search`, `:712-738 doc_vector_search` | embeddings / doc_embeddings, blocks, docs | read | §3 | semantic | 2 |
| `omgbase-store/search.rs:793 hybrid_search`, `:863 resolve` | (the above) | read | §4 | semantic | 2 |

### 2.6 omgbase-store — size, retention, archive

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-store/size.rs:24-57 TABLE_CATEGORY` | (names) blobs, tree_nodes, revisions, commits, dispositions, block_changes, resurrection_pool, pending_materializations, archives → `history`; embeddings, doc_embeddings → `search`; checkpoints → `sync`; edges, doc_edges → `content` | — | §7.2 the report's categories | both | none (the categories will follow the split: `resurrection_pool` and `pending_materializations` are current-state under this plan but reported as `history`) |
| `omgbase-store/size.rs:373-560 size_report_at` | `dbstat` per table, dispositions (`kind = 'same'` `:522`), revisions + archives (`archived_summary`), per-repo `evaluate_retention` (`:535-552`) | read | the size report and advice | archival | none |
| `omgbase-store/retention.rs:589-680 ReachMarker` | tree_nodes (`entries`), blobs (`size`) | read | cost a plan with the explicit mark | archival | none |
| `omgbase-store/retention.rs:704-920 evaluate_retention` | docs (`current_rev` `:715`), pending_materializations (`rev_id` pins `:722`), revisions JOIN commits (`:728-730`), revisions (`archive IS NULL` `:851`) | read | §7.1 the plan | archival | none (reads two current-state tables; harmless) |
| `omgbase-store/archive.rs:172-181 segment_revision_ids` | segment file `revisions` | read | — | archival | none |
| `omgbase-store/archive.rs:197-233 archive_row / record_archive` | archives | read / write | the registry | archival | none |
| `omgbase-store/archive.rs:263-329 attach_archive`, `:336-358 detach_archive` | archives | write / delete | `history attach` / `detach` | archival | none |
| `omgbase-store/archive.rs:496-540 unrecorded_segments` | archives, revisions (`archive` by `rev_id` `:525`) | read | the crash rule's classification | archival | none |
| `omgbase-store/archive.rs:663-752 revision_body` | revisions (store `:695`, `:702`; `<prefix>revisions` `:729`), archives (`archive_row` on error), `ATTACH` of the segment | read | a revision's bodies, through its segment when archived | both | 3 for the recovery caller (via `read_at_revision`, §3.4); none otherwise |
| `omgbase-store/archive.rs:772-800 checkpoint_bodies` | tree_nodes, blobs, revisions (via `TreeResolver`) | read | checkpoint forms for a segment / a re-checkpoint | archival | none |
| `omgbase-store/archive.rs:882-910 wholly_archived_commits` | revisions | read | — | archival | none |
| `omgbase-store/archive.rs:960-1210 write_segment` | revisions, commits, tree_nodes, blobs, dispositions, block_changes (read `:966`, `:1008`, `:1118`, `:1136`, `:1139`); segment `revisions`, `commits`, `tree_nodes`, `blobs`, `dispositions`, `block_changes`, `manifest` (write `:1102-1145`) | read+write | phase 1 of `history export` | archival | none |
| `omgbase-store/archive.rs:1222-1292 squash` | revisions (`UPDATE … root_tree = NULL, frontmatter_blob = NULL, archive = ?` `:1240`), dispositions (delete per commit `:1249`), block_changes (delete all but each block's EARLIEST row `:1254-1256` — "the mint oracle reads this table"), tree_nodes + blobs (`sweep_unreachable` `:1263`), archives (`record_archive`), repos.settings | write | phase 2 of `history export --prune` | both | 3 → identity claims replace the earliest-row rule (§3.5) |
| `omgbase-store/archive.rs:1296-1356 checkpoint_dependents` | revisions (read `seq + 1`, `UPDATE root_tree/frontmatter_blob` `:1305`), tree_nodes + blobs (write `:1342-1346`) | read+write | §4.4 base liveness before a squash | archival | none |
| `omgbase-store/archive.rs:1364-1450 export_history` | (the above), revisions (`archive` by `rev_id` `:1381`) | read+write | plan → segment → squash | archival | none |
| `omgbase-store/archive.rs:1461-1480 archived_summary` | revisions (`archive IS NOT NULL`), archives | read | size figures | archival | none |

### 2.7 omgbase-surface

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-surface/context.rs:243-245 REVISION_COLS / REVISION_FROM`, `:806-812 root_scan(Revisions)`, `:820-828 doc_revisions`, `:1265-1272 revision_doc`, `:1517-1530 attribute(Revisions, …)` | revisions JOIN docs JOIN commits (`is_current = (d.current_rev = r.rev_id)`, `archived`) | read | the `revisions` query target and the `_revisions` relation (4.7) | archival | none |
| `omgbase-surface/context.rs:1413 attribute(Docs, "_hash")` | docs (`file_hash`) | read | — | current-state | none |
| `omgbase-surface/context.rs:1414-1417 attribute(Docs, "_updated_at")` | revisions JOIN commits (`c.ts` by `current_rev`) | read | the document's last change time — on every `_updated_at` read of an in-memory query | current-state | 3 → explicit change metadata (§3.8) |
| `omgbase-surface/context.rs:1424-1427 attribute(Docs, "_created_at")` | revisions JOIN commits (`seq = 1`) | read | first observed | current-state | 3 (§3.8) |
| `omgbase-surface/context.rs:1429-1435 attribute(Docs, "_raw")` | (`reconstruct`: docs, revisions, blobs, blocks) | read | the exact bytes | current-state | 3 (§3.2) |
| `omgbase-surface/context.rs:1445-1465 attribute(Blocks, "_raw")` | blobs (`bytes` by `raw_hash`) | read | — | current-state | 3 (§3.11) |
| `omgbase-surface/context.rs:1467-1470 attribute(Blocks, "_updated_at")` | block_changes JOIN commits (`MAX(c.ts)`) | read | the block's own last change | current-state | 3 (§3.8) |
| `omgbase-surface/context.rs:1479-1482 attribute(Blocks, "_created_at")` | block_changes JOIN commits (`MIN(c.ts)`) | read | first commit that wrote the id | current-state | 3 (§3.8) |
| `omgbase-surface/context.rs:1565-1568 row_method has_anchor` | edges (`src_block = ? AND anchor IS NOT NULL` — **no `to_commit IS NULL`**, so closed intervals count; same in TS, §5) | read | — | current-state | 3 (§3.7) |
| `omgbase-surface/context.rs:1593-1600 row_method has_edge` | edges (`to_commit IS NULL`) | read | — | current-state | 3 (§3.7) |
| `omgbase-surface/context.rs:1709-1714 text_match` | — | — | refuses `text()` on links/revisions | archival | none |
| `omgbase-surface/context.rs:1783-1800 semantic_score` | doc_embeddings, embeddings (`block_vector`) | read | `semantic(…)` | semantic | 2 |
| `omgbase-surface/translate.rs:282-288 attribute_sql` (`_updated_at`, `_created_at`); `:637-643 operand` (`_doc._updated_at`…); `:682-688` (`_dst._updated_at`…) | revisions JOIN commits as correlated subqueries pushed into the planned scan | read | the pushed-down form of the same two attributes | current-state | 3 (§3.8) |
| `omgbase-surface/planner.rs:55`, `:92`, `:107`, `:123` (Links arms of `from_clause`, `guards`, `from_by_doc`, `guards_by_doc`) | edges (`to_commit IS NULL`) | read | the `links` scan | current-state | 3 (§3.7) |
| `omgbase-surface/planner.rs:58`, `:98`, `:101`, `:129-139` (Revisions arms; `compile` never plans it) | revisions × docs × commits | read | the `revisions` scan (in-memory only) | archival | none |
| `omgbase-surface/names.rs:168-174 head_seq` | commits (`MAX(seq)`) | read | the vocabulary cache key — "the one thing every property or attrs change moves" (`:33-35`) | current-state | 3 (§3.6) |
| `omgbase-surface/read.rs:62-75 find_doc_by_id / find_doc_by_path` | docs (`current_rev`) | read | the locator | current-state | none |
| `omgbase-surface/read.rs:330 docs_read` | docs (`rev: current_rev`) | read | exposes the revision id as the document's version on the wire | current-state | 3 (§3.3) |
| `omgbase-surface/read.rs:416-429 docs_read_at` | (`read_at_revision`) | read | `docs_read { at }` | archival | none |
| `omgbase-surface/read.rs:731-760 live_doc_rows` (callers `docs_list` `:809`, `docs_tree` `:872`) | revisions JOIN commits (`c.ts` by `current_rev`) per listed document, blocks (count) | read | `_updated_at` in every list/tree row | current-state | 3 (§3.8) |
| `omgbase-surface/history.rs:21-47 blocks_history` | block_changes JOIN commits LEFT JOIN dispositions | read | §3 | archival | none |
| `omgbase-surface/history.rs:81-120 blocks_at_known_revision`, `:123-155 diff_blocks` | revisions + archives (`revision_body`), tree_nodes + blobs (`TreeResolver`, `blob_text_at`) | read | `docs_diff` | archival | none |
| `omgbase-surface/history.rs:160-171 diff_unified_text` | (`read_at_revision`) | read | `docs_diff_unified` | archival | none |
| `omgbase-surface/history.rs:275-280 recent_revs` | revisions | read | default revision pair | archival | none |
| `omgbase-surface/history.rs:288-318 resolve_doc_row`, `:325-410 docs_history` | docs (`current_rev`, `deleted_commit`), revisions JOIN commits (`archive`) | read | `docs_history` | archival | none |
| `omgbase-surface/catalog.rs:1311-1333 require_rankable` | doc_embeddings, embeddings | read | `provider_unavailable` guard | semantic | 2 |
| `omgbase-surface/catalog.rs:1747-1763 call_result_inner("docs_read")` | (`docs_read_at` when `at` is given) | read | the `at` dispatch | archival | none |
| `omgbase-surface/catalog.rs:2602`, `:2624 call_result_inner("observe_file" / "observe_many")` | resurrection_pool (`sweep_pool`) | delete | the convenience sweep after a batch | current-state | 3 |
| `omgbase-surface/catalog.rs:2650-2762 call_result_inner` (`blocks_history`, `docs_diff`, `docs_diff_unified`, `docs_read_at`, `docs_history`) | (history.rs) | read | the history tools | archival | none |
| `omgbase-surface/catalog.rs:2764-2772 call_result_inner("changes_since")`, `:2927-2944 root_changes_page` | (`changes_since`) | read | the feed on the wire, paths rooted | both | 3 (§3.6) |
| `omgbase-surface/links.rs:34-37 totals`, `:117-120 links_stale`, `:204-205 links_stale_summary` | edges (`to_commit IS NULL`) JOIN docs | read | `links_stale*` | current-state | 3 (§3.7) |
| `omgbase-surface/store_index.rs:273-274 property` | properties (`deleted_commit IS NULL`) | read | index probes | current-state | none |
| `omgbase-surface/select.rs:158 parent_lookup` | blocks (`deleted_commit IS NULL`) | read | selector resolution | current-state | none |
| `omgbase-surface/select.rs:1462 admit_selector` | — (refuses `revisions` rows as an effect target) | — | the static pass | archival | none |

### 2.8 omgbase-sync

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-sync/admin.rs:88-109 repos_status` | docs JOIN revisions (`file_hash IS NOT rendered_hash` → `unconverged` `:89-90`), commits (count `:108`), edges (`to_commit IS NULL` `:109`) | read | `repos_status` | current-state | 3 (§3.3, §3.6, §3.7) |
| `omgbase-sync/admin.rs:146-155 sync_status` | commits (`MAX(seq)`), checkpoints (latest by `ts`) | read | `sync_status` | both | 3 (feed seq) / 4 (checkpoints are capture of batches) |
| `omgbase-sync/checkpoint.rs:66-107 finish_checkpoint` | checkpoints (insert; mints `cp` `:74`), resurrection_pool (`sweep_pool` `:105`, same transaction) | write+delete | §4.1 one row per batch | both | 4 (the row) / 3 (the sweep) |
| `omgbase-sync/recovery.rs:40-95 recover_repo` | pending_materializations (`materialize_pending`), docs LEFT JOIN revisions (`rendered_hash` by `current_rev` `:53-55`), + `reconciling_ingest` | read+write | `spec/sync` §4.3 recovery | current-state | 3 (§3.3, §3.4) |
| `omgbase-sync/freshness.rs:203-260 freshness_sweep` | (`materialize_pending` `:212`, `process_checkpoint` `:230`) | write | the priming / periodic sweep | current-state | 3 |
| `omgbase-sync/freshness.rs:264-273 materialize_pending` | pending_materializations | read+delete | step 0 | current-state | 3 (§3.4) |
| `omgbase-sync/freshness.rs:296-337 detect_disk_drift`, `:345-374 rebuild_file_stats` | docs (`file_hash`, `deleted_commit`), file_stats | read | drift counters, the stat cache | current-state | none |
| `omgbase-sync/coordinator.rs:130-166 sync_out` | (`changes_since`: commits, revisions, dispositions, docs) | read | engine → source export driven by the feed (origin filter, revisions' paths) | current-state | 3 (§3.6) |
| `omgbase-sync/engine.rs:155-167 changes_since`, `:169-189 read_doc` | (`changes_since`), docs (`file_hash`), `reconstruct` | read | the in-process engine the coordinator drives | current-state | 3 |
| `omgbase-sync/driver.rs:16-35 reconcile_changes`, `:59-108 attach_source` | (`observe_batch`, `finish_checkpoint`; `reconciling_ingest` / `fresh_ingest`) | write | the adapter-driven paths | current-state | 3 |
| `omgbase-sync/source.rs:267-312 ExternalSource.revisions` | (an in-memory per-path counter of the SOURCE's revisions — not the store table) | — | adapter protocol | current-state | none |

### 2.9 omgbase (the binary)

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase/cli/cmd/admin.rs:27-53 rebuild_index` | (`rebuild_index`: sections, doc_edges, blocks_fts, block_changes ← dispositions) | write | `omg rebuild-index [--block-changes]` | both | 4 |
| `omgbase/cli/cmd/admin.rs:90-140 gc` | (`gc_dry_run` / `gc` / `vacuum`: tree_nodes, blobs, dispositions, block_changes) | delete | `omg gc [--dry-run] [--vacuum]` | both | 3 |
| `omgbase/cli/cmd/admin.rs:202-210 doctor` | docs × revisions (`current_rev` with no `revisions` row = dangling) | read | the "no dangling current_rev" check | current-state | 3 (§3.3) |
| `omgbase/cli/cmd/admin.rs:330-370 size_lines` | (`size_report`) | read | `omg size` | archival | none |
| `omgbase/cli/cmd/log.rs:63-73`, `:86 log` | commits (`MAX(seq) … ts < ?` for `--since`), `changes_since` | read | `omg log` | both | 3 (§3.6) |
| `omgbase/cli/cmd/diff.rs:14-80 diff` | (`docs_diff_unified`, `docs_diff`) | read | `omg diff` | archival | none |
| `omgbase/cli/cmd/hist.rs:13-50 hist` | (`blocks_history`) | read | `omg hist` | archival | none |
| `omgbase/cli/cmd/history.rs:205-215 plan`, `:280-330 export`, `:335-350 attach`, `:415-430 detach`, `:445-470 list` | (`retention_plan`, `export_history`, `attach_archive`, `detach_archive`, `list_archives`) | read+write | `omg history *` | archival | none |
| `omgbase/cli/cmd/status.rs:27-46 embed_queue` | embeddings (exists by `content_hash, ctx_hash[, model]`), + `build_embed_tasks` | read | the queued-embedding count in `omg status` | semantic | 2 |
| `omgbase/cli/cmd/status.rs:49-60 status` | (`repos_status`, `sync_status`) | read | — | current-state | 3 |
| `omgbase/cli/cmd/links.rs:58-140 doc_links` | edges (`to_commit IS NULL` `:61`, `:112`, `:133`), doc_edges (`:82`) | read | `omg links` | current-state | 3 (§3.7) |
| `omgbase/cli/cmd/mutate.rs:1101 task_block` | blocks (`deleted_commit IS NULL`) | read | — | current-state | none |
| `omgbase/cli/cmd/sync.rs:101`, `cli/cmd/source.rs:122`, `:132` | (`freshness_sweep`, `rebuild_file_stats`) | write | `omg sync`, `omg source add` | current-state | 3 |
| `omgbase/watch.rs:187`, `:335` | (`freshness_sweep`, `reconcile_changes` → checkpoints) | write | the watcher | both | 3 / 4 |
| `omgbase/drain.rs:85-166` | (`embed_process` / `embed_process_docs`: embeddings, doc_embeddings) | write | the MCP embed drain thread | semantic | 2 |

### 2.10 Pure crates — producers of record kinds (no connection)

| crate/file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `omgbase-reconcile/types.rs:197 Disposition`, `:278-288 ReconcileResult { assignment, dispositions, deleted, consumed_pool }` | the disposition record kind; the pool consumption list | — | the matcher's output the store persists (step 10) and acts on (steps 7, 8, 11) | both | 4 (dispositions) / 3 (assignment, deleted, consumed_pool are identity decisions) |
| `omgbase-reconcile/types.rs:266 PoolEntry`, `reconcile.rs:45 phase6b_resurrection` | the tombstone pool as input | — | phase 6b resurrection | current-state | 3 (§3.10) |
| `omgbase-reconcile/crossdoc.rs:52 cross_doc_match`, `:122 apply_cross_doc_matches` | cross-document dispositions (`copied_from`, …) | — | §7 | both | 4 / 3 |
| `omgbase-mutate/effects.rs:2846-2866 intent_record` | the `commits.ops` payload (`canonical({ v, plan_id, effects, selection?, templates? })`) | — | ADR-003 intent | both | 4 |
| `omgbase-mutate/effects.rs:1882-1885 DocPrecondition { base_revision, hash }`, `opset.rs:155 base_revision`, `effects.rs:2030 PlanRevision` | the wire shapes that carry a revision id as the CAS version | — | `plan` / `execute` preconditions | current-state | 3 (§3.3) |
| `omgbase-graph/edges.rs:215 extract_block_edges`, `:314 extract_frontmatter_edges` | `EdgeDescriptor` (no commit columns) | — | the wanted edge set | current-state | none |
| `omgbase-search/vec.rs:8-51`, `embed.rs:20-197` | vector blobs, cache keys, pooling | — | pure helpers of the semantic layer | semantic | 2 |
| `omgbase-properties` (whole crate), `omgbase-fs-adapter` (whole crate) | — | — | no store tables | current-state | none |

### 2.11 Record kinds with no reader at all

- `commits.checkpoint_id` — written `None` by every Rust writer (`writers.rs:302-311`, `observe.rs:1267`, `effects.rs:305`); `checkpoints` rows carry their own `repo_id`/`ts`/`files` and nothing joins the two. Dead column (both engines; spec §5.4 step 5 says `checkpoint_id = NULL`).
- `properties.deleted_commit` — only ever filtered (`properties.rs:77`, `search.rs:129`, `store_index.rs:273`, `names.rs:182`, `context.rs:850-911`); no `UPDATE properties` exists in either engine (§5). Dead column.
- `checkpoints.files` / `git_head` — written by `finish_checkpoint`, read by no production path (only `sync_status`'s `id ORDER BY ts` and tests).
- `inferred_edges`, `collections` — created by the schema, touched by nothing in Rust.

### 2.12 Tally

Rows: **195** — §2.1 store opener/ids/writers 15, §2.2 observe/tombstone/reads 35, §2.3 feed/recovery/derived 16, §2.4 graph/properties/api commit 33, §2.5 semantic 12, §2.6 size/retention/archive 16, §2.7 surface 34, §2.8 sync 11, §2.9 binary 15, §2.10 pure crates 8 — plus the four dead record kinds of §2.11 (not rows). Counted from the tables by their `class` and `phase` columns.

| class | rows |
| --- | --- |
| current-state | 108 |
| archival | 34 |
| both | 36 |
| semantic | 17 |
| test-only | 0 (tests are listed in §4, not in the matrix) |

| phase (first assignment of the cell) | rows |
| --- | --- |
| 3 (current-state independence) | 109 — about 20 of them also name a 4 for the capture half of the same site (`write_revision`, step 10, `commits.ops`, `move_path_in`, the checkpoint row, …) |
| 4 (extract capture) | 13 |
| 2 (extract semantic) | 17 |
| none (archival-only, moves behind the recorder) | 56 |

## 3. Current-state dependencies on history

Each paragraph: what is read, why, what breaks without it, and the assigned replacement from the plan's §3 vocabulary — *current heads/content*, *explicit creation/change metadata*, *identity claims*, *self-contained recovery payloads*, *feed sequence separate from archive retention*, *current edges separate from transitions* — or "needs a design decision".

### 3.1 The ingest reads the previous revision before it can write (`writers.rs:148`, `observe.rs:646-657`)

Every `ingest_in` — observed, api, fresh — begins with `previous_revision(tx, doc_id)` (greatest `seq`, with `root_tree`, `frontmatter_blob`, `archive`) to compute `seq`, the checkpoint decision (`is_checkpoint_revision`), and — when not a checkpoint — the base tree through `TreeResolver::tree(doc_id, p.seq, root)` (`tree_nodes` + recursive `revisions` walk-back). Without the `revisions` row the ingest cannot number the revision or write a delta; the current-state half (the `blocks` refresh, pointers, properties, edges) does not need any of it. **Replacement:** *current heads/content* — the head row carries its own version counter and content hash; the delta base becomes the recorder's concern (the recorder keeps its own previous captured state, or always writes checkpoint forms when history is on and nothing when off). Confirmed identical to the TS coupling the plan verified.

### 3.2 The CURRENT frontmatter is not stored as a value; it is resolved through up to 15 earlier revisions (`read.rs:39-55`, `delta.rs:641-685`, callers `read.rs:76`, `mutate.rs:188-193`, `search.rs:build_doc_embed_tasks`, `context.rs:1429`)

`reconstruct` (the hot read behind `docs_read._raw`, `converged`, the sync engine's `read_doc`, the doc-embedding input) and `load_mut_doc` (every `apply`/`plan`) call `current_frontmatter_raw(conn, current_rev)`: `SELECT doc_id, seq, frontmatter_blob FROM revisions WHERE rev_id = ?`, then `TreeResolver::frontmatter`, which reads the blob and, when it is a `{"f":…}` delta, reads revision `seq − 1`'s `frontmatter_blob` recursively (≤ 15 steps, `CHECKPOINT_EVERY = 16`). Since 16.0 the current document's frontmatter raw may not exist as a blob at all. Without `revisions`/`blobs` history the body still reconstructs (from `blocks`) but the frontmatter is lost — every document with frontmatter reads back wrong. **Replacement:** *current heads/content* — the head stores the frontmatter raw (or the hash of a raw blob that the current-state GC root set keeps); deltas live only in the recorder. This is the single most consequential coupling in the Rust engine because it sits on the read path, not just the write path.

### 3.3 `docs.current_rev` is the CAS version vector and the wire `rev` (`effects.rs:74-98, 540-642`, `effects_plan.rs:704-731, 1916-1931, 2029-2048`, `plan.rs:175-178`, `read.rs:330`, `recovery.rs:53-55`, `admin.rs:89-90, 202-210`, `mutate/effects.rs:1882`)

The triple `(path, current_rev, file_hash)` is captured at load and re-read inside `BEGIN IMMEDIATE`; `expect.revision`, `DocPrecondition.base_revision`, `OpsetPrecondition.base_revision`, `docs_read.rev` and the `stale_plan` error payload all name a `revisions.rev_id`. `repos_status`' `unconverged` and `recover_repo` compare `docs.file_hash` with `revisions.rendered_hash` through `current_rev`; `omg doctor` checks `current_rev` resolves. Without the `revisions` row, `current_rev` dangles, `doctor` fails, and the two hash comparisons degrade to `file_hash` alone (which they already fall back to when `rendered_hash` is NULL — `recovery.rs:70`, `effects.rs:384`). **Replacement:** *current heads/content* — a head version id/counter owned by the core; `file_hash` already is the rendered hash of the head (§5.4 step 12). **Needs a design decision:** whether `rev`/`base_revision`/`expected_revision` on the wire remain revision ids when history is on (so `docs_read { at: rev }` keeps working) and become head versions when it is off — i.e. is the head version *the* revision id when the recorder is present? (Spec/surface and spec/mutate fixtures pin `r_<n>` values in these fields.)

### 3.4 Pending materializations are not self-contained (`materialize.rs:161-189`, `effects.rs:370-392, 423-427`, `retention.rs:722`)

A `write`/`rename` row carries `rev_id REFERENCES revisions` and `rendered_hash`. The materializer renders bytes with `read_at_revision(doc_id, rev_id)` (revisions → `revision_body` → tree_nodes/blobs, possibly through an archive segment) and verifies them against `rendered_hash`; its "prior bytes" rule reads `previous_rendered_hash` — `revisions WHERE seq < (seq of rev_id) ORDER BY seq DESC LIMIT 1`. `record_intent` reads `revisions.rendered_hash` for the row it just wrote, and `current_bytes_hash` LEFT JOINs revisions for a move/remove. `evaluate_retention` pins any revision a pending row names. Without history: rows cannot render (the row is "kept for a later materializer", forever), and the prior-bytes rule has no answer, so a crash-recovery write over the engine's own stale file is refused as "foreign". **Replacement:** *self-contained recovery payloads* — the row stores `prior_hash` at insert time (the hash the commit validated the file against — the TS comment at `mutate/materialize.ts:21-23` already says the commit phase "passes the hash"), and renders bytes from the current head (a row always names its document's current revision, §5.7 — so `reconstruct` is sufficient today; `bytes_for` already does that when `rev_id` is NULL). The `rev_id` FK goes.

### 3.5 Identity: the mint oracle and the squash's "earliest row" rule (`mint.rs:28-71`, `archive.rs:1250-1256`, `derived.rs:215-225`)

`id_in_use` probes `block_changes` and `resurrection_pool` for `b`, `commits` for `c`, `revisions` for `r`, `checkpoints` for `cp`, `archives` for `s` — "a block id lives on in history after its `blocks` row is gone". The retention squash deliberately keeps each block's earliest `block_changes` row so a minted id stays known; `rebuild_index` deliberately does not re-derive `block_changes` for wholly-archived commits for the same reason. Without `block_changes` a re-minted `b` id could collide with an id in a detached segment or in another store's history; the `c`/`r` probes become moot once those tables are the recorder's. **Replacement:** *identity claims* — a core table of every id ever issued per prefix (or per block id with its first-seen commit/ts), written at mint, consulted by `id_in_use`, never swept; `block_changes` then returns to being a pure projection the squash may empty.

### 3.6 `commits.seq` is the change feed, the vocabulary cache key and the sync cursor (`writers.rs:323`, `history.rs:143-249`, `names.rs:168-174`, `admin.rs:108, 147`, `coordinator.rs:130-166`, `log.rs:63-73`, `catalog.rs:2764`)

`new_commit` computes `1 + MAX(seq)` per repo; `changes_since` pages `commits … seq > cursor` and joins `revisions` (paths, `rendered_hash`), `dispositions` (summary counts) and `docs.deleted_commit` (deleted paths). The sync coordinator's `sync_out` exports by walking the feed; the surface's unknown-names vocabulary cache is keyed on `MAX(commits.seq)`; `omg log --since` maps a timestamp to a `seq` through `commits.ts`. The retention squash keeps every `commits` row precisely so the feed never loses a cursor (`archive.rs:11-13`). Without `commits`: no feed, no sync-out, no cache invalidation, no `log`. **Replacement:** *feed sequence separate from archive retention* — a core change log (`seq`, `ts`, `origin`, `actor`, `reason`, the touched `(doc, path, hash)` triples and deleted paths as the row's own columns) that the recorder may mirror but whose rows retention never touches; the disposition counts in the summary are capture (optional).

### 3.7 Edge intervals are the current graph (`graph.rs:239-387`, `effects.rs:735-764`, `planner.rs:55-123`, `context.rs:1565-1600`, `links.rs`, `cli/cmd/links.rs`, `admin.rs:109`)

`maintain_edges` opens rows with `from_commit = commit` and closes with `UPDATE … to_commit = commit` rather than deleting; every current-graph reader — the `links` target, `_doc_edges` rollups, `has_edge`, `links_stale*`, `inbound_links_to`, `adopt_phantoms`, `move_path_in`, `repos_status.open_edges`, `omg links` — filters `to_commit IS NULL`. The closed rows are pure history (nothing reads them: no tool exposes closed edges; `has_anchor` at `context.rs:1565` is the one probe that forgets the filter). **Replacement:** *current edges separate from transitions* — a core `edges` table of open edges (delete on close) plus an optional recorder table of transitions `(edge, opened_commit, closed_commit)`. The spec/graph fixtures pin `from_commit`/`to_commit` (`crates/omgbase-graph/tests/spec.rs:705-768`), so this is a spec change.

### 3.8 Creation and change times are derived from history; tombstones name commits (`blocks.created_commit`, `properties.created_commit`, `blocks.deleted_commit`, `docs.deleted_commit`; `context.rs:1414-1427, 1467-1482`, `translate.rs:282-288, 637-643, 682-688`, `read.rs:741`)

`_updated_at` on a doc is `commits.ts` of `current_rev`'s revision; `_created_at` is the `ts` of revision `seq = 1`; on a block they are `MAX`/`MIN(commits.ts)` over its `block_changes`. The pushed-down form is a correlated subquery in every planned docs scan that mentions them; `docs_list`/`docs_tree` compute `_updated_at` per row. `blocks.created_commit`/`deleted_commit`, `properties.created_commit` and `docs.deleted_commit` store commit ids (and `changes_since` reads `docs.deleted_commit = commit` to say "deleted a.md"). Without history these attributes are NULL and the tombstone columns are opaque. **Replacement:** *explicit creation/change metadata* — `created_at`/`updated_at` (ts) on docs and blocks written by the ingest (the block's own change, not its siblings' — the 14.2 rule carries over: a `same` carry does not touch `updated_at`); tombstones carry `deleted_at` (and the feed row carries the deleted path). Note the 16.0 comment at `context.rs:1472-1477` relies on the squash keeping the earliest `block_changes` row for `_created_at` to "survive archiving" — explicit metadata removes that dependency too.

### 3.9 Dispositions and block_changes are written on every ingest (`observe.rs:807-831`, `mutate.rs:951-1007`)

The observe path persists every non-`same` matcher verdict; the api path synthesizes `inserted`/`moved`/`edited`/`edited_moved` rows (`reason "api"`, `matcher_v NULL`) from `classify_carries`. Nothing current-state reads `dispositions`; `block_changes` is read by §3.5 and §3.8 only. **Replacement:** capture (phase 4) — the recorder receives the verdict list; the core keeps the identity decisions (`assignment`, `deleted`, `consumed_pool`, `cross_doc_ids`) which drive steps 7, 8 and 11.

### 3.10 The tombstone pool is current-state but shaped by history (`observe.rs:701-709, 871-895`, `read.rs:271-285`, `derived.rs:412`, `checkpoint.rs:105`)

`resurrection_pool` feeds reconcile phase 6b and the cross-document phase; it is current-state (an ordinary ingest of a moved paragraph depends on it). Its rows carry `deleted_commit` (a commit id) and `expires_ts`; the mint oracle probes it. Invariant I6 ties `expires_ts` to the commit's `ts`. **Replacement:** *identity claims* — the pool stays core, keyed by block id with `deleted_at` instead of `deleted_commit`; expiry anchored on the row's own timestamp. **Needs a design decision:** whether the 30-day pool and the identity-claims table (§3.5) are one table (a claim with an optional pooled payload) or two.

### 3.11 How the GC mark computes blob reachability, and what current state alone reaches (`derived.rs:265-326`, `retention.rs:589-680`)

`mark_reachable` seeds `blobs` with every non-NULL `revisions.frontmatter_blob` and walks every non-NULL `revisions.root_tree` through `walk_explicit`: a `[`-node contributes every entry's `raw_hash_hex`/`trivia_hash_hex` and recurses into `child_tree_hash_hex`; a `{`-node contributes only its `+`/`~` entries (never resolving the delta — the base revision is live by the base-liveness rule and marks the rest). Everything in `blobs`/`tree_nodes` not marked is swept (`sweep_unreachable`; also inside the retention squash). The mark is therefore defined over **live revisions**, not over the current state. From the current state alone the reachable set is: every `blocks.raw_hash` and non-NULL `blocks.trivia_hash` (live and tombstoned rows — a tombstoned doc keeps its rows), plus the current revision's frontmatter **chain** (the `frontmatter_blob` of `current_rev` and, when it is a delta, the blobs of revisions `seq − 1 … checkpoint`). No `tree_nodes` row is reachable from current state: `reconstruct` and `load_mut_doc` never read one; only the writer's base-reuse (`writers.rs:224-233`) and the archival reads do. **Replacement / design decision:** when history is off, the core GC root set is `blocks.raw_hash ∪ blocks.trivia_hash ∪ heads.frontmatter_blob` (a raw, by §3.2), and `tree_nodes` is entirely the recorder's. The spec's I5 ("the explicit mark set equals all of blobs and tree_nodes") must be restated per capability.

### 3.12 History writes from current-state operations (`effects.rs:728-731`, `observe.rs:614-621`)

`move_path_in` updates `revisions.path` of the current revision (so the revision's path is the one it is "committed under", 4.7); re-creation clears `docs.deleted_commit`. Both are current-state ops reaching into history tables. **Replacement:** capture (phase 4) — the recorder records the move; the head's path is the core's.

### 3.13 `revision_body`/`read_at_revision` through archive segments on a recovery path (`materialize.rs:183-189`, `archive.rs:663-752`)

Because `bytes_for` goes through `read_at_revision`, a pending row could in principle `ATTACH` an archive segment during recovery. Today this cannot happen (a row names the current revision and retention rule 1 never archives the current one), but the code path exists. Resolved by §3.4.

## 4. Tests and runners that pin the coupled behaviour

Spec runners (each skips when built outside the monorepo):

- `crates/omgbase-store/tests/spec.rs` (2,597 lines) — reads `spec/store/cases/*.json` (12 files: `batch` 9, `deletion` 6, `delta` 5, `frontmatter` 7, `garbage` 1, `identity` 11, `migrations` 25, `observe` 9, `pool` 8, `retention` 12, `schema` 214 fingerprint rows, `structure` 9). Projects `revisions`, `blobs`, `tree_nodes`, `dispositions`, `block_changes`, `resurrection_pool`, `pending_materializations`, `archives` row for row (`:1180-1331`), runs `gc` and `history` steps (`:883`, `:1019`), and checks invariants I1–I10 after every observe step (`check_invariants` `:1371-2151`: I2 hash integrity over blobs/tree_nodes incl. delta parsing, I3 blocks mirror the resolved tree, I4 dense `commits.seq`/`revisions.seq`, I5 the explicit mark equals all blobs/tree_nodes and the implementation's GC would sweep zero, I6 pool rows, I7 dispositions vs live rows and "no persisted `same`", I8 rebuild equivalence of `block_changes`, I9 archived revisions, I10 deltas resolve and are strictly smaller). Expectation kind: exact table projection + invariants.
- `crates/omgbase-mutate/tests/spec.rs` (3,095 lines) — `spec/mutate/cases/*.json` (`changesets`, `commit`, `docs`, `effects`, `macros`, `materialize`, `ops`, `plan`, `render`); projects `commits` (incl. `ops`, `checkpoint_id`), `revisions`, `dispositions`, `resurrection_pool`, `pending_materializations` (`:1806-1872`); runs `gc` (`:1646`). Pins the api-path dispositions, the one-commit-per-request rule, `stale_plan` on `current_rev`, and the materializer table (`materialize.json`).
- `crates/omgbase-sync/tests/spec.rs` (3,365 lines) — `spec/sync/cases/*.json` (`checkpoint`, `protocol`, `pure`, `registry`); projection keys include `commits`, `revisions`, `blobs`, `tree_nodes`, `dispositions`, `block_changes`, `resurrection_pool`, `pending_materializations`, `archives`, `checkpoints` (`:110-121`); coordinator cases project `commits` (`:1930-1939`) and the change feed digests.
- `crates/omgbase-graph/tests/spec.rs` (1,228 lines) — `spec/graph/cases/*.json` (`intervals`, `links`, `nodes`, `resolve`, `uri`); pins `edges.from_commit`/`to_commit` against the repo's `commits` (`:647`, `:705-768`) — the interval model of §3.7.
- `crates/omgbase-search/tests/spec.rs` (1,397 lines) — `spec/search/cases/*.json` (`cosine`, `embed`, `fts`, `rank`, `sanitize`); projects `embeddings`/`doc_embeddings` (`:872-894`) with dim/length checks (`:925-949`).
- `crates/omgbase-reconcile/tests/spec.rs` (1,416 lines) — `spec/reconcile/cases`; pins the in-memory `dispositions`/`assignment`/`deleted`/`consumed_pool` result shape (`:80`), one disposition per minted id (`:824-862`).
- `crates/omgbase-surface/tests/spec.rs` (1,647 lines) — `spec/surface/cases/*.json` (17 files incl. `query-revisions.json` — the `revisions` target, `_updated_at`/`_created_at`; `reads.json` — `docs_read { at }`, `docs_history`, `blocks_history`, `docs_diff*`; `cursor.json`; `interop.json` validation); runs `gc` and `history` steps (`:848`, `:950`), with a temp archives directory (`:793-882`). `tests/conformance.rs` (planned vs in-memory agreement over the alchemy corpus) and `tests/store_index.rs` (index probes; `_updated_at` pushdown appears in `translate.rs` unit tests `:1218-1240`).
- `crates/omgbase/tests/cli_spec.rs` (1,162 lines) — `spec/cli/cases/*.json` (`admin` — `gc`, `rebuild-index`, `doctor`, `size`; `history` — `plan`/`export`/`attach`/`detach`/`list`; `read` — `cat`/`diff`/`hist`/`log`; `docs`, `mutate`, `query`, `shell`, `sync`, `invoke`); `cli-spec-passing.txt` is the allowlist (558 entries per the release notes). Byte-level stdout/stderr/exit expectations.
- `crates/omgbase/tests/interop.rs` (1,150 lines) — `spec/surface/cases/interop.json`; four writer/reader pairings over the MCP wire (`:1039-1057`); compares tool results across engines (including `changes_since` digests, `docs_read { at }`, the receipts' `revisions` and the `revisions` target) — the cross-engine gate that any schema or encoding change must keep green.
- `crates/omgbase/tests/mcp_watch.rs` (embeddings/doc_embeddings counts `:493-530`, checkpoints), `remote.rs` (`revisions` in receipts `:1041`, checkpoints `:1350`), `writer_lock.rs`.
- `crates/omgbase-sync/tests/ingest_corpus.rs` — ignored by default; the proof behind the mint oracle (`spec/store` §2.1): a 3,000-document corpus under the random minter.

Unit tests inside the crates that pin the coupling directly (`#[cfg(test)]`):

- `crates/omgbase-store/src/tests.rs` (5,482 lines, 132 tests) — among them `migrates_v14_to_v15_rebuilding_revisions` (`:342`), `dedups_identical_blobs_and_tree_nodes` (`:683`), `structural_sharing_editing_one_of_500_blocks_adds_one_node_and_one_blob` (`:722`), `rewriting_an_unchanged_tree_adds_zero_rows` (`:753`), `assigns_per_repo_commit_seq_and_per_doc_revision_seq` (`:770`), `first_observation_mints_in_the_specified_order` (`:806`), `echo_writes_nothing_and_mints_nothing` (`:873`), `deletion_pools_blocks_for_thirty_days_and_sweep_expires_them` (`:948`), `a_pooled_block_resurrects_with_its_id` (`:1003`), `frontmatter_is_a_blob_on_the_revision_not_a_block` (`:1243`), `read_at_an_older_revision_reports_the_hash_honestly` (`:1288`), `rebuild_reproduces_sections_block_changes_and_fts` (`:1387`), `gc_is_off_by_default_and_finds_nothing_unreachable_when_on` (`:1474`), `gc_sweeps_a_pre_14_2_stores_same_rows` (`:1533`), `a_changeset_is_one_commit_with_n_revisions` (`:2485`), `docs_delete_is_one_commit_without_pooling` (`:2862`), `a_concurrent_revision_between_plan_and_commit_is_stale_plan` (`:2993`), `the_in_tx_disk_check_returns_a_conflict_without_minting` (`:3131`), `a_crash_after_commit_leaves_rows_the_materializer_replays` (`:3461`), `the_materializer_leaves_a_foreign_file_and_keeps_the_row` (`:3654`), `docs_set_meta_materializes_after_the_commit` (`:3887`), `a_later_request_materializes_the_pending_row_before_reading` (`:3943`).
- `crates/omgbase-store/src/mint.rs:244-412` — `a_block_id_in_history_stays_in_use_after_its_row_is_gone` (`:294`: plants `block_changes` and `resurrection_pool` rows and expects the redraw) and the capture modes.
- `crates/omgbase-store/src/history.rs:251-383` — paging, `head`, origin filter, the summary shapes.
- `crates/omgbase-store/src/graph.rs:389-782` — `edges_open_close_and_roll_up` (`:519`: `from_commit`/`to_commit` values), `deletion_leaves_the_graph_rows` (`:690`: edges stay open across a tombstone).
- `crates/omgbase-store/src/delta.rs:720-804`, `edit_script.rs`, `archive.rs`, `retention.rs`, `size.rs:600-1000` (the `history` category and advice lines), `schema.rs:300-414` (DDL targets, `archive.sql`).
- `crates/omgbase-surface/src/history.rs:412-634` (unified-diff bytes copied from `history.test.ts`), `catalog.rs:3080-4260` (`blocks_history`, receipts' `revisions`, `commits.ops` round trip `:3237`, `:3506`, `change_summaries_are_rooted_like_the_reference_renders_them` `:4173`), `translate.rs:1218-1240, 2338-2345` (`_updated_at` pushdown; `$from_commit` declines), `names.rs:1129`, `select.rs:2731`, `query.rs:1848-1855`.
- `crates/omgbase-sync/src/checkpoint.rs:120-355` (`checkpoint_row_and_sweep_share_one_transaction` `:289`), `driver.rs:111-230` (disposition and commit counts after attach), `recovery.rs:108-240`, `freshness.rs:480-720` (pending rows over a real fs), `engine.rs:200-260`, `coordinator.rs:230-300`, `admin.rs:170-250`, `mcp_client.rs:890-910`.
- `crates/omgbase/src/watch.rs:400-560` (checkpoint counts), `cli/cmd/admin.rs:800-860` (size lines), `cli/cmd/history.rs:500-510`.

## 5. TS/Rust divergence

Spot comparisons against `packages/core/src` at the same commit (the sibling inventories the TS side in full):

- **Schema version:** both at 16 (`crates/omgbase-store/src/schema.rs:17`; `packages/core/src/core/store/schema.ts:5`). No lag; both engines open the same database and the Rust opener refuses a newer `user_version` (`schema.rs:156-160`).
- **Mint oracle tables:** identical lists (`mint.rs:28-46` vs `core/store/store.ts:23-32`: `b` → blocks, block_changes, resurrection_pool; `c` → commits; `r` → revisions; `cp` → checkpoints; `s` → archives).
- **`_updated_at` / `_created_at` SQL:** identical strings (`context.rs:1414-1482` vs `oqx-js/context.ts:520, 548, 555`; `translate.rs:282-288` vs `oqx-js/sql/translate.ts:160, 354, 378`; `read.rs:741` vs `core/read/reader.ts:66`).
- **GC mark, rebuild and squash rules:** identical (`derived.rs:307-326` vs `core/store/gc.ts:32-37`; `derived.rs:222-224` vs `core/store/rebuild.ts:46-48`; `archive.rs:1254-1256` vs `core/store/archive.ts:707-709`).
- **Materializer prior-bytes rule, remove fallback, observe gate:** same semantics (`materialize.rs:161-208` vs `mutate/materialize.ts:85-125`; `effects.rs:468-469` `sha256(b"")` vs `mutate/commit.ts:294`; `observe.rs:990-996` vs `sync/observe.ts:164-165`).
- **`has_anchor` omits the open-interval filter in both** (`context.rs:1565-1568`; `oqx-js/context.ts:704`) — a shared quirk, not a divergence; it means a block whose anchor edge was closed still reports `has_anchor() == true`. Worth a fixture when §3.7 lands.
- **`properties.deleted_commit` and `commits.checkpoint_id` are write-never in both engines** (no `UPDATE properties` anywhere; `checkpoint_id` always NULL).
- **TS-only surface:** `packages/core/src/search/cel/compile.ts:247, 273, 620` (the legacy CEL compiler) has its own `updated_at`/`has_anchor` SQL with no Rust twin; the sibling inventory should class it. The Rust surface has no `cel` module.
- **Rust-only structure (no behavioural difference):** `TreeResolver::revision` spells a segment's `archive` column as `NULL AS archive` (`delta.rs:451-455`); `revision_body` reads live rows with `root_tree.unwrap_or_default()` (`archive.rs:720`); the Rust `effects` module validates every guard before `new_commit` so a conflict burns no id (`effects.rs:290-293`) — the TS `commit.ts` is documented to do the same.
- **Size categories:** both place `resurrection_pool` and `pending_materializations` under `history` and `checkpoints` under `sync` (`size.rs:41-52`; `core/store/size.ts:38-49`) — consistent with each other, inconsistent with this plan's classification (§6).

No behavioural divergence was found in any inspected current-state-on-history path; both engines must therefore be changed in lock-step and the `interop.rs` gate (§4) is the right place to prove each phase.

## 6. Observations

1. **A history read on the hottest read path.** `reconstruct` (`read.rs:76`) and `load_mut_doc` (`mutate.rs:188`) resolve the current frontmatter through `revisions` and a delta chain of up to 15 earlier blobs (`delta.rs:641-685`). Since 16.0 the current frontmatter raw is frequently *not a stored value*. Every `docs_read`, every `apply`/`plan`, the sync engine's `read_doc`, `converged` in every ingest, and `build_doc_embed_tasks` pay for it. This is the Phase 3 item with the widest blast radius and the plan should treat "head stores its frontmatter raw" as the first cut.
2. **Three timestamps are derived, none stored.** `_updated_at`/`_created_at` for docs and blocks (and `docs_list`/`docs_tree`'s `_updated_at`) are joins into `revisions`×`commits` and `block_changes`×`commits`, on the in-memory path per row and on the pushed-down path per scan (`context.rs:1414-1482`, `translate.rs:282-288`, `read.rs:741`). The spec's own rationale (`context.rs:1472-1477`) leans on the retention squash keeping each block's earliest `block_changes` row — a history-retention rule holding up a current-state attribute.
3. **`pending_materializations` is the one recovery record, and it is not self-contained.** It needs `revisions` three times (its `rev_id` FK, `read_at_revision` to render, `previous_rendered_hash` for the prior-bytes rule — `materialize.rs:161-189`) although every row names the current revision and `reconstruct` would do. Making the row carry `prior_hash` removes the last history read from crash recovery.
4. **A dead write:** `commits.checkpoint_id` is always `NULL` (`writers.rs:302-311`, `observe.rs:1267`, `effects.rs:305`) and nothing joins `checkpoints` to `commits`; `checkpoints.files`/`git_head` are written by every sweep (`checkpoint.rs:97-104`) and read only by `sync_status`'s `ORDER BY ts LIMIT 1` and tests. `properties.deleted_commit` is a dead column in both engines. `inferred_edges` and `collections` are created and never touched.
5. **A dependency the plan's TS list did not name:** the surface's unknown-names vocabulary cache is keyed on `MAX(commits.seq)` (`names.rs:168-174`), and `omg log --since` resolves a wall-clock instant through `commits.ts` (`log.rs:63-73`). Both are current-state uses of the feed sequence beyond `changes_since` itself.
6. **The squash writes current-state-motivated rows into history tables.** `archive.rs:1250-1256` keeps each block's earliest `block_changes` row only because `mint.rs:35` probes it; `derived.rs:215-225` mirrors the exception. An identity-claims table (§3.5) lets both become plain archival code.
7. **`move_path_in` is a current-state op that mutates history** (`effects.rs:728-731` re-paths the current `revisions` row) and the 4.7 `revisions` target documents the resulting semantics ("the path it was committed under"). The recorder must own that update.
8. **Edge intervals are history stored in a current-state table.** No production reader ever selects a closed edge (`to_commit IS NOT NULL`); the `idx_edges_temporal` index serves nothing today. The one reader that reaches closed rows does so by omission (`has_anchor`, §5).
9. **The size report's categories disagree with this plan.** `size.rs:41-43` files `resurrection_pool` and `pending_materializations` under `history`; under the plan they are core (identity claims / recovery). The advice line "history dominates … enable gc" (`size.rs:275`) will need re-wording when the split lands.
10. **Blob reachability is defined over live revisions, not current state** (§3.11). `tree_nodes` has no current-state reader at all (the writer's base reuse at `writers.rs:224-233` is the only non-archival touch), which makes the tree encoding a clean Phase 4 extraction; `blobs` is shared between the current content store (`blocks.raw_hash`/`trivia_hash` → `blob_text` in `reconstruct`, `load_mut_doc`, `load_old_match_blocks`, `links_repair`, `inbound_links_to`, `_raw`) and the archive bodies, so Phase 3 must decide whether the core keeps a content-addressed blob table of its own (reachable from blocks + heads) or inlines raws into `blocks`.
11. **`observe_batch`'s gate rule and `observe_delete` already treat the pending row as current state** (`observe.rs:925-1003, 1336-1345`) — the recovery record is woven into the ingest's control flow, so Phase 3's payload change touches the observe path too, not only `materialize.rs`.
12. **Every semantic touch is already isolated** in `search.rs:213-738`, `catalog.rs:1311-1333`, `context.rs:1783-1800`, `status.rs:27-46`, `drain.rs` and the pure `omgbase-search` crate; the only cross-dependency is `build_doc_embed_tasks` calling `reconstruct` (`search.rs:270-330`), i.e. the semantic layer reads the current head, never history. Phase 2 is a clean extraction.
