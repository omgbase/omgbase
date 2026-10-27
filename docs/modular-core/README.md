# Modular core — Phase 0 gate: the dependency matrix

The Phase 0 gate of the modular-core plan: "a reproducible baseline and a
complete ownership map where each current-state dependency has an assigned
replacement". It merges `inventory-ts.md` (170 rows) and `inventory-rust.md`
(195 rows), both at `a25a1d501b5a1fb8ced963a68258b8c38248dfa8`, with
`baseline.md`. Every `path:line` is a citation into the two inventories (TS
under `packages/core/src/`, Rust under `crates/`); nothing is re-derived.
Phases 1–4 are implemented from §2–§5.

## 1. What Phase 0 established

On the real corpus (853 documents, 1.86 MB of Markdown) the database is 73.1
MB — **39× the source** — of which history is 36.4 MB (**49.8 %**), search
22.6 MB (30.9 %) and live content 12.9 MB; the synthetic workload puts the
import at 23.8× and shows that **every small edit pays a per-commit constant
of ≈ 1.2 KB** (`commits` ≈ 660 B + `revisions` ≈ 500 B) that exceeds the
content delta of every edit measured, that an edit inside a container costs
**twice** a top-level one (the container's raw and sibling list are
re-encoded), and that the default `gc` **reclaims nothing** because with
retention off every history row is reachable (`baseline.md` §1–§3). Both
engines implement store schema 16 with the delta encoding complete
(`schema.ts:5`, `schema.rs:17`), produce the same database to within a few KB
on the workload, and show **no behavioural divergence on any inspected
current-state-on-history path** — mint tables, timestamp SQL, GC/rebuild/
squash rules, the materializer's prior-bytes rule and the observe gate are
identical (`inventory-rust.md` §5). The TS inventory has 170 rows (current-
state 85, both 34, archival 40, semantic 9, test-only 2; phase 3 = 101, 4 =
10, 2 = 9, none = 50); the Rust inventory 195 (current-state 108, both 36,
archival 34, semantic 17; phase 3 = 109, 4 = 13, 2 = 17, none = 56) — merged,
365 rows, of which **210 are Phase 3 sites** where an ordinary read, query,
CAS, reconcile or recovery path reaches a history table. The shape of the
problem: current state is **read through history at 210 sites** across the
two engines — the current frontmatter exists only as a (possibly delta)
blob on the current revision, the CAS token is a revision id, every
timestamp is a `commits.ts` join, the id oracle probes `block_changes`,
recovery renders from the Merkle tree, GC roots on `revisions` — while
history is **written unconditionally on every one of the eight write entry
points** (TS `ingestFile`, `runPhases`, `tombstoneObservedDeletion`, the
conflict re-ingest; Rust `commit_ingest`, `commit_effects_with_id`,
`tombstone_observed_deletion`, `fresh_ingest`), each minting a `commits` row
before any current-state row and then writing `revisions`, `tree_nodes`,
`blobs`, `dispositions` and `block_changes`. The **semantic layer is already
isolated**: its only cross-dependency is the doc-embedding task's read of the
current head (`search.rs:270-330`, `search/tasks.ts:219`), never history.

## 2. The merged matrix by record kind

Columns: `access`, `TS sites`, `Rust sites`, `class` (current-state / both /
archival / semantic / test-only), `phase` (3 = current-state independence, 4 =
extract capture, 2 = extract semantic, none = archival code that moves behind
the recorder unchanged), `replacement` (a §3 mechanism M1–M7 or a §4 decision
D*n*). Where the inventories differ, a `note` follows the table. **Gate
rule:** every row classed current-state or both ends in an M or a D.

### 2.1 `docs.current_rev` and the `_rev` / `rev` / `base_revision` tokens

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written as the head pointer (a `revisions.rev_id` by convention, no FK) with `file_hash`/`conflicted` at ingest step 12 | `core/ingest.ts:ingestInto` 497–502 | `observe.rs:844-853` | both | 3 | M1 |
| read as the CAS triple `(path, current_rev, file_hash)`: freeze at plan, re-validate at commit → `stale_plan` | `mutate/commit.ts:readDocBase` 75–80, `validate`/`checkRow` 395–442; `mutate/plan.ts:planEffects` 224–228, `executeAdmitted` 491–507, 560–578; `mutate/effects.ts:checkRevision` 859–871, 1316–1359, 1441; `mutate/plan-update.ts:planDocUpdate` 56–114; `mutate/apply.ts:ensureDoc` 165–179 | `effects.rs:83-98 doc_base`, `:540-642`; `effects_plan.rs:704-731`, `:1916-1931`, `:2029-2048`, `:2208-2250`; `plan.rs:172-178`; `mutate.rs:545-570`; `omgbase-mutate/effects.rs:1882-1885`, `opset.rs:155` | current-state | 3 | M1, D1 |
| surfaced on the wire as `rev` / `_rev` (`docs_read`, `find_doc`) | `core/read/document.ts:docsRead` 154–187, `docsReadMany` 225–269; `core/read/reader.ts:findDoc` 339–374 | `read.rs:330`, `read.rs:62-75` | current-state | 3 | D1 |
| `movePath` rewrites the CURRENT revision's `path` in place (a current-state op writing history) | `mutate/commit.ts:movePath` 453–471 | `effects.rs:716-769 move_path_in` (`:728-731`) | both | 3 / 4 | M1 (path on the head), M5 (the recorder records the move), D11 |
| `omg doctor`: a `current_rev` with no `revisions` row is "dangling" | — (CLI out of TS scope) | `cli/cmd/admin.rs:202-210` | current-state | 3 | M1 (the check becomes "head present") |

note: identical semantics in both engines (`inventory-rust.md` §5). The Rust
inventory lists the `doctor` check; the TS inventory excludes the CLI package.

### 2.2 Frontmatter — `revisions.frontmatter_blob` + `TreeResolver`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written: the frontmatter raw, or since 16.0 a `{"f":…}` line delta over revision `seq − 1`, as a blob named only by the revision row — there is no `blocks` row for frontmatter | `core/ingest.ts:ingestInto` 329–332; `core/store/writers.ts:writeFrontmatterBlob` 121–125 | `observe.rs:661-678`; `writers.rs:253-264` | both | 3 | M1 |
| read: the CURRENT frontmatter via `current_rev` → `revisions` → `blobs` → walk-back ≤ 15 earlier revisions — on every `docs_read`, `_raw`, `apply`/`plan`/`execute`, ingest convergence check, sync read and doc-embedding task | `core/read/document.ts:currentFrontmatterRaw` 91–97; `core/store/delta.ts:TreeResolver` 325–446; callers `reconstructContent` 104–136, `mutate/load.ts:loadMutDoc` 19–86, `core/ingest.ts` 511–515, `oqx-js/context.ts` 528, `search/tasks.ts` 219 | `read.rs:39-55 current_frontmatter_raw`; `delta.rs:641-685`, `:450-493`; callers `read.rs:62-97 reconstruct`, `mutate.rs:101-202 load_mut_doc`, `observe.rs:857`, `context.rs:1429-1435`, `search.rs:270-330` | current-state | 3 | M1 |
| read: the previous revision's raw as the delta base at ingest step 1 | `core/ingest.ts` 329–332 (via `TreeResolver.frontmatter`) | `observe.rs:665` | both | 4 | M1 for the current raw; the delta base becomes the recorder's own |

note: both inventories rank this the widest blast radius (TS §5.1, Rust §6.1).
The TS row for `buildDocEmbedTasks` (`search/tasks.ts` 127–215) does not name
the `reconstructContent` call; `search/tasks.ts:219` confirms it, matching
the Rust `build_doc_embed_tasks` row.

### 2.3 Block bytes — `blobs` through `blocks.raw_hash` / `trivia_hash`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written as a side effect of the TREE writer (`putBlob` inside `writeList`) | `core/store/writers.ts:writeList` 92–107 → `putBlob` 40–49 | `writers.rs:187-247 write_list` → `:87-95 put_blob` | both | 3 | M1 (the current-state ingest puts raw/trivia blobs itself) |
| read by a live row's `raw_hash`/`trivia_hash`: reconstruct, `blocks_read` raw/full, `_raw`, the mutation tree, the matcher's old side, inbound-link rescans, macros | `core/read/document.ts:reconstructContent` 104–136; `core/read/reader.ts:blockRaw` 322–327; `core/read/nodes.ts:project` 35–65; `mutate/load.ts:loadMutDoc` 19–86; `mutate/docs.ts:planInboundRetarget` 85–112; `mutate/macros.ts` 15–21, 239–245; `graph/inbound-links.ts:inboundLinksTo` 56–93; `sync/reconciling-ingest.ts:loadOldMatchBlocks` 33–105; `oqx-js/context.ts` 546 | `read.rs:20-33 blob_text`, `:62-97`, `:170-268`; `mutate.rs:135-139`; `links.rs:288-340`; `macros.rs:20-40`, `:474-480`; `docs_ops.rs:380-425`; `context.rs:1445-1465` | current-state | 3 | M1 (the read is unchanged; its GC root moves — M7) |
| reachability: the mark roots on `revisions` only; current blobs survive by I3, not by their own reference | `core/store/gc.ts:markReachable` 28–40, `sweepUnreachable` 74–89 | `derived.rs:307-326`, `:370-379` | both | 3 | M7, D10 |

### 2.4 `tree_nodes`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written per ingest: Merkle root, full `[`-form or `{"d":…}` delta per sibling list | `core/ingest.ts` 323 → `writers.writeBlockTree`; `writers.ts:putNodeText`/`putTreeNode` 52–61; `core/hash.ts:serializeTreeEntries`/`treeHash` 216–231 | `observe.rs:682`; `writers.rs:99-112`, `:187-247` | archival (TS) / both (Rust) | 4 | M5 (capture half) |
| read as the delta base at ingest step 0 (`previousRevision` + `TreeResolver.tree`, checkpoint rule) | `core/ingest.ts:ingestInto` 315–322; `writers.ts:previousRevision` 172–176, `isCheckpointRevision` 75–77 | `observe.rs:646-657`; `writers.rs:148-164`, `:169-171`; `delta.rs:510-639` | archival / 4 (TS) vs current-state / 3 (Rust) | 3 | M1 (the head is numbered and hashed without a base; the recorder keeps its own previous captured state) |
| read by the materializer through `readDocumentAtRevision` | `mutate/materialize.ts:renderedBytes` 98–103 | `materialize.rs:183-189 bytes_for` | current-state | 3 | M4 |
| read by archival features: `docs_read { at }`, `docs_diff*`, the explicit mark, segment export, re-checkpoint | `core/read/document.ts:readDocumentAtRevision` 318–368; `graph/history.ts` 59–102; `gc.ts:explicitWalker` 50–67; `archive.ts` 466–482, 593–677, 735–760; `retention.ts:ReachMarker` 292–335 | `read.rs:118-156`; `omgbase-surface/history.rs:81-155`; `derived.rs:265-298`; `archive.rs:772-800`, `:960-1210`, `:1296-1356`; `retention.rs:589-680` | archival | none | recorder |

note: **the one classification disagreement on a mechanism.** TS classes the
step-0 base read archival/4 (`ingest.ts:315–322`); Rust classes
`previous_revision`/`is_checkpoint_revision`/step 0 current-state/3 because
the ingest cannot number the revision or decide a checkpoint without them
(`inventory-rust.md` §3.1). Both agree no current-state READ path touches a
tree node (Rust §6.10: "`tree_nodes` has no current-state reader at all").
Resolution: Rust's phase governs (the ingest must stop needing the base in
Phase 3 — M1), TS's class governs (the node encoding is wholly the recorder's).

### 2.5 `commits` — the row, `seq`, `ts`, `ops`, `checkpoint_id`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| a row minted BEFORE any current-state row on every write path (observed, api, tombstone, conflict re-ingest, fresh ingest); `seq = 1 + MAX(seq)` per repo | `core/ingest.ts:ingestFile` 221–231; `core/store/writers.ts:newCommit` 138–158; `mutate/commit.ts:runPhases` C 239–250, `commitChangeset` 181–184; `sync/tombstone.ts:tombstoneObservedDeletion` 44–66 | `writers.rs:317-344 new_commit`; `observe.rs:1246-1279`, `:1284-1307`, `:1211-1238`; `effects.rs:273-332` | both (TS) / current-state (Rust) | 3 | M5 |
| `seq` as the feed cursor (`changes_since`, the sync base), the vocabulary-cache clock, `sync_status.lastCommitSeq`, `repos_status.commits`, `omg log --since` via `ts` | `graph/history.ts:changesSince` 251–287; `oqx-js/names.ts:headSeq` 91–102; `sync/admin.ts` 63, 96; `mcp/server.ts` 1645 | `history.rs:143-249`; `names.rs:168-174`; `admin.rs:108`, `:147`; `coordinator.rs:130-166`; `engine.rs:155-167`; `catalog.rs:2764-2772`, `:2927-2944`; `cli/cmd/log.rs:63-73` | both | 3 | M5, D7 |
| `ts` joined as the four timestamps (`_updated_at`/`_created_at` of docs and blocks) | see 2.6 and 2.8 | see 2.6 and 2.8 | current-state | 3 | M2 |
| `ops`: the ADR-003 intent record of an admitted plan | `mutate/plan.ts:executeAdmitted` 513–521 | `effects.rs:296-308`; `effects_plan.rs:2247`; `omgbase-mutate/effects.rs:2846-2866` | archival (TS) / both (Rust) | 4 | M5 (the feed row carries `origin`/`actor`/`reason`; the intent record is capture) |
| `checkpoint_id`: written NULL by every writer, joined by nothing | `writers.ts:newCommit` 138–158 (parameter) | `writers.rs:302-311`, `observe.rs:1267`, `effects.rs:305` (§2.11) | dead | — | D9 |

note: the Rust inventory (§6.5) says the plan's TS list did not name the
vocabulary-cache key and `log --since`; the TS inventory does list
`names.ts:headSeq` (§2.6, §5.12) — only `log --since` is TS-uncovered (CLI
package). Class differs on `newCommit` (TS both, Rust current-state) with the
same phase; immaterial.

### 2.6 `revisions` beyond the head — `rendered_hash`, the OQX root, `docs_read { at }`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| the row written per (doc, commit): `(rev_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id)` | `core/ingest.ts` 334–343; `writers.ts:writeRevision` 179–197 | `observe.rs:685-698`; `writers.rs:362-393` | both | 3 / 4 | M1 (head token), then the row is the recorder's |
| `rendered_hash` as the convergence oracle: `repos_status.unconverged`, `recoverRepo`, a `rename`/`remove` row's expected bytes, `record_intent`, the previous revision's hash for the prior-bytes rule | `sync/admin.ts:reposStatus` 42–66; `sync/recovery.ts:recoverRepo` 26–60; `mutate/commit.ts:runPhases` 279–295; `mutate/materialize.ts:priorRenderedHash` 85–91 | `admin.rs:88-109`; `recovery.rs:40-95`; `effects.rs:370-392`, `:401-485`; `materialize.rs:161-175` | current-state | 3 | M4 (`docs.file_hash` already holds the current value; `prior_hash` on the pending row), D9 (`unconverged` is `file_hash ≠ rendered_hash`, which I1 makes always false) |
| doc `_updated_at` = `commits.ts` of `current_rev`'s commit — every `docs_list`/`docs_tree` row (unconditionally), OQX attribute, pushed predicate | `core/read/reader.ts:liveDocRows` 51–76; `oqx-js/context.ts` 520; `oqx-js/sql/translate.ts` 160, 354, 378 | `read.rs:731-760 live_doc_rows`; `context.rs:1414-1417`; `translate.rs:282-288`, `:637-643`, `:682-688` | current-state | 3 | M2, D6 |
| doc `_created_at` = the `seq = 1` revision's commit `ts` | `oqx-js/context.ts` 526; `translate.ts` 161, 355, 379 | `context.rs:1424-1427`; `translate.rs:282-288` | current-state | 3 | M2 |
| the `revisions` OQX root and `_revisions` relation (`_rev _seq _commit _ts _origin _actor _reason _hash _is_current _archived`) | `oqx-js/context.ts` 111–112, 165, 171–172, 364, 589–602, 841, 884; `names.ts` 123, 129; `root-row.ts` 29; `planner.ts` 28–29; `run.ts` 150, 268; `mutate/select.ts` 591–592 | `context.rs:243-245`, `:806-828`, `:1265-1272`, `:1517-1530`; `planner.rs:58`, `:98-139`; `select.rs:1462` | archival | none | recorder; D3 |
| `docs_read { at }`, `docs_diff`, `docs_diff_unified`, `docs_history` on `readDocumentAtRevision`/`revisionBody` — shared with the materializer today | `core/read/document.ts:readDocumentAtRevision` 318–368; `core/store/archive.ts:revisionBody` 441–455; `graph/history.ts` 59–149, 351–414; `mcp/server.ts` 1527–1603 | `read.rs:118-156`; `archive.rs:663-752`; `omgbase-surface/history.rs:81-171`, `:275-410`; `read.rs:416-429`; `catalog.rs:1747-1763`, `:2650-2762` | both → archival | 3 then none | M4 (the materializer stops calling them), D3 |
| retention/archive bookkeeping on the row (`archive`, body NULLing, pins, migration v15) | `core/store/retention.ts:evaluateRetention` 353–466; `archive.ts` 548–800; `store.ts:migrateV15` 210–243 | `retention.rs:704-920`; `archive.rs:1222-1480`; `schema.rs:253-293` | archival | none | recorder |

### 2.7 `dispositions`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written on every ingest: every non-`same` verdict, `INSERT OR IGNORE` (step 10) | `core/ingest.ts:ingestInto` 467–488, `persistsDisposition` 38–40 | `observe.rs:807-831`, `:546` | both | 3 (TS) / 4 (Rust) | M5 (capture half); the resolver seam (next row) splits identity decisions from verdicts |
| produced in memory by the id resolvers and the matcher, in the same return value as the identity decisions (`assigned`/`deleted`/`consumedPool`/`crossDocIds`) | `mutate/known-ids.ts:makeKnownIdResolver` 80–148; `sync/reconciling-ingest.ts:makeReconcilingResolver` 160–252; `reconcile/*` (`IdResolver`, `ingest.ts` 60–74) | `mutate.rs:873-1007`; `observe.rs:247-398`; `omgbase-reconcile/types.rs:197`, `:278-288`, `crossdoc.rs:52`, `:122` | both | 4 / 3 | recorder receives the verdict list; core keeps the identity decisions (M3) |
| read: `changes_since` summary counts (`GROUP BY kind`) | `graph/history.ts:changesSince` 251–287 | `history.rs:200` | both | 3 | M5 (the counts are "unpinned by spec/surface" — optional, D7) |
| read: `blocks_history`, the 14.2 `same` sweep, rebuild, segment export, squash | `graph/history.ts:historyNode` 25–39; `gc.ts` 92–125; `rebuild.ts` 39–50; `archive.ts` 593–726 | `omgbase-surface/history.rs:21-47`; `derived.rs:249-256`, `:392-409`, `:195-229`; `archive.rs:960-1292` | archival | none | recorder |

note: the write is "both/3" in TS and "both/4" in Rust — the same site and
the same reason (a current-state path reads what the row writes, via
`block_changes`); the inventories differ only in which phase they call
"first". Both agree nothing current-state reads `dispositions` itself.

### 2.8 `block_changes` — the mint oracle, `_updated_at` / `_created_at`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written alongside `dispositions` (one row per block per change; 3.9 MB on the real corpus) | as 2.7 row 1 | as 2.7 row 1 | both | 3 / 4 | M3 (the read stops) then M5 (the write stops in Phase 4 — `baseline.md` §3) |
| the mint oracle for `b`: in use if it names a `blocks` OR `block_changes` OR `resurrection_pool` row | `core/store/store.ts:ID_TABLES`/`idInUse` 22–33, 61–72; `core/ids.ts:mintId`/`inUse` 147–172 | `mint.rs:28-46`, `:61-71`, `:153-179` | both (TS) / current-state (Rust) | 3 | M3 |
| block `_updated_at` / `_created_at` = `MAX`/`MIN(commits.ts)` over the block's rows; declared pushable in TS but with no SQL case | `oqx-js/context.ts` 548, 555; `oqx-js/sql/translate.ts` 149 vs 163–167 | `context.rs:1467-1470`, `:1479-1482` | current-state | 3 | M2, D6 |
| the squash keeps each block's EARLIEST row "for the mint oracle"; rebuild re-derives only non-archived commits for the same reason | `core/store/archive.ts:squash` 687–726 (703–709); `rebuild.ts:rebuildIndex` 39–50 | `archive.rs:1222-1292` (`:1254-1256`); `derived.rs:195-229` (`:222`) | archival / both | none | M3 retires the rule; D5 |

### 2.9 Change identifiers on current rows

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| `blocks.created_commit` = the ingesting commit, on the wholesale refresh | `core/ingest.ts:ingestInto` 366–381 | `observe.rs:723-755` | current-state | 3 | M2 |
| `docs.deleted_commit` / `blocks.deleted_commit`: set by tombstones, cleared on re-creation; read as `IS NULL` at 40+ sites, projected only by `changesSince` | `core/ingest.ts:ingestInto` 276–299; `mutate/commit.ts:tombstone` 475–487; `sync/tombstone.ts` 44–66; `graph/history.ts` 278; readers `reader.ts`, `sections.ts`, `fts.ts`, `nodes.ts`, `edges.ts` 106–125, `effects.ts` 702–1211, `mcp/server.ts:docOfBlock` 392–396 | `observe.rs:604-637`, `:871-895`; `history.rs:205`; readers `derived.rs:17-176`, `graph.rs:23-41`, `:179-189`, `effects.rs:525-534`, `mutate.rs:345-354`, `effects_plan.rs:272-639`, `select.rs:158` | current-state | 3 | M2 (`deleted_at`; the feed row carries the deleted path), D2 |
| `properties.created_commit` (written) and `properties.deleted_commit` (never written non-NULL, filtered by four partial indexes and every read) | `core/store/properties.ts:writeDocProperties` 208–229, `docPropertiesMerged` 169–203; `names.ts` 112 | `properties.rs:38-71`, `:74-120`; `search.rs:129`; `store_index.rs:273-274`; `names.rs:182`; `context.rs:850-911` | current-state | 3 / none | M2; D9 (dead column) |
| `edges.from_commit` / `to_commit`: open with `from_commit`, CLOSE with `to_commit`, never delete; every current reader filters `to_commit IS NULL`; `idx_edges_temporal` has no reader | `core/store/edges.ts:maintainEdges` 31–71, `adoptPhantoms` 76–83, `rebuildDocEdges` 86–103; `mutate/commit.ts:movePath` 453–471; readers `graph/links.ts` 36–89, `graph/link-health.ts` 114–235, `graph/inbound-links.ts` 56–93, `oqx-js/context.ts` 368–376, 718–719, `oqx-js/sql/scan.ts` 22–68, `sync/admin.ts` 42–66, `rebuild.ts` 27–30 | `graph.rs:239-314`, `:319-360`, `:367-387`; `effects.rs:735-764`; readers `planner.rs:55-123`, `context.rs:1593-1600`, `links.rs:288-340`, `omgbase-surface/links.rs:34-205`, `cli/cmd/links.rs:58-140`, `admin.rs:109` | current-state | 3 | M6 |
| `has_anchor` probes `edges` WITHOUT the `to_commit IS NULL` filter — a closed anchor edge still answers true | `oqx-js/context.ts` 704 | `context.rs:1565-1568` | current-state | 3 | M6, D8 |
| `resurrection_pool.deleted_commit` | see 2.10 | see 2.10 | current-state | 3 | M3 |

### 2.10 `resurrection_pool`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written on delete: ingest step 7 (ids in `deleted`), api tombstone with `pool: true`, observed deletion — `deleted_commit`, `expires_ts = ts + 30 d` (I6) | `core/ingest.ts:ingestInto` 347–354; `mutate/commit.ts:tombstone` 475–487; `sync/tombstone.ts` 44–66 | `observe.rs:701-709`, `:871-895` | current-state | 3 | M3 (the pool stays core; `deleted_at` on the row) |
| read for reconcile phase 6b once per batch; consumed (step 11); evicted on cross-doc resurrection (step 8) | `sync/reconciling-ingest.ts:loadPool` 112–121; `core/ingest.ts` 491–493, `evictForeignBlockRows` 534–546 | `read.rs:271-285`; `observe.rs:834-839`, `:457-495`; `omgbase-reconcile/types.rs:266`, `reconcile.rs:45` | current-state | 3 | M3 |
| swept by expiry after each batch and inside the checkpoint transaction | `core/store/gc.ts:sweepResurrectionPool` 129–132 ← `sync/observe.ts` 303, 318, 355, `sync/checkpoint.ts` 91 | `derived.rs:412-417` ← `observe.rs:1363`, `checkpoint.rs:105`, `catalog.rs:2602`, `:2624` | current-state | 3 | M3 (expiry anchored on the row's own timestamp, not `commits.ts`) |
| probed by the mint oracle | as 2.8 row 2 | as 2.8 row 2 | both | 3 | M3 |

note: `size.ts:38` and `size.rs:41-43` both file the pool under "history";
both inventories class it current-state (TS §3.6, §5.9; Rust §3.10, §6.9) —
the engines agree with each other and disagree with the plan. D2 (tombstoned
rows), D5 (pool and claims: one table or two).

### 2.11 `pending_materializations` + `archives`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| the row inserted by the commit: `(path, kind, from_path, doc_id, rev_id → revisions FK, rendered_hash, commit_id → commits FK)` — the only DECLARED FK coupling (`schema.sql:159, 161`; `migrateV15` had to turn FKs off for it) | `mutate/commit.ts:runPhases` 303 → `mutate/materialize.ts:insertPending` 60–80; `core/store/schema.ts:PENDING_MATERIALIZATIONS_DDL` 158; `store.ts` 203–214 | `effects.rs:401-485 record_intent`; `materialize.rs:130-157`; `schema.rs:228`, `:255` | current-state | 3 | M4 |
| rendered via `readDocumentAtRevision` (§6.2, the Merkle tree, segment-aware) though a row always names the current revision; prior bytes via the PREVIOUS revision's `rendered_hash` | `mutate/materialize.ts:renderedBytes` 98–103, `priorRenderedHash` 85–91, `materializeRow`/`materializePending` 120–222 | `materialize.rs:161-175`, `:183-189`, `:197-311`, `:325-362` | current-state | 3 | M4 |
| the §5.7 gate in the observe path, the phase-A replay before a request reads disk, the conflict drop, crash recovery, the freshness sweep | `sync/observe.ts:observeBatch` 131–147, 205–209, `observeDelete` 339–346; `mutate/commit.ts:runPhases` A 219–231, `commitChangeset` 181–184; `sync/recovery.ts:recoverRepo` 26–60 | `observe.rs:925-1003`, `:1273`, `:1334-1369`; `mutate.rs:398-462`, `:469-503`; `recovery.rs:40-95`; `freshness.rs:203-273`; `cli/cmd/sync.rs:101`, `source.rs:122-132` | current-state | 3 | M4 (the payload change touches the observe path, not only the materializer — Rust §6.11) |
| `evaluateRetention` pins any revision a pending row names | `core/store/retention.ts:evaluateRetention` 369 | `retention.rs:722` | archival | none | gone with the FK (M4) |
| `archives`: registry, attach/detach, segment reads, `archivePrefix`, export/list | `core/store/archive.ts` 169–420, 548–810; `schema.ts:ARCHIVES_DDL` 183 | `archive.rs:172-358`, `:496-540`, `:882-1480` | archival | none | recorder |

note: both size reports file `pending_materializations` under "history"
(`size.ts:39`, `size.rs:41-43`); both inventories class it current-state.

### 2.12 `checkpoints`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| one row per observed batch (`id`, `ts`, `files`, `git_head`), written with the pool sweep in ONE transaction | `sync/checkpoint.ts:finishCheckpoint` 63–94 | `checkpoint.rs:66-107` (`:74` mints `cp`, `:105` sweep) | current-state (TS) / both (Rust) | 3 (TS) / 4 row + 3 sweep (Rust) | D4 |
| read: `sync_status` latest by `ts` | `sync/admin.ts:syncStatus` 95–107 | `admin.rs:146-155` | current-state (TS) / both (Rust) | 3 | D4 |
| probed by the mint oracle (`cp`) | as 2.8 row 2 | as 2.8 row 2 | both | 3 | M3 |
| `files` / `git_head`: written by every sweep, read by no production path; `commits.checkpoint_id` never joins the two | — | `checkpoint.rs:97-104` (§2.11) | dead | — | D9 |

note: **the second classification disagreement.** TS §3.13: "sync
bookkeeping (`checkpoint.ts:88`, `admin.ts:97`), not history; it names no
commit" → current-state/3, keep it in the sync layer. Rust: "checkpoints are
capture of batches" → the row is phase 4. `size.ts`/`size.rs` both say "sync".
Resolved by D4.

### 2.13 `embeddings` / `doc_embeddings`

| access | TS sites | Rust sites | class | phase | replacement |
| --- | --- | --- | --- | --- | --- |
| written by the drain: block vectors keyed `(content_hash = blocks.raw_hash, ctx_hash, model)`, one doc vector per `(doc_id, model)` with `input_hash` freshness | `search/embeddings.ts:EmbeddingWorker` 125–298; `search/tasks.ts` 65–215; `search/drain.ts` | `search.rs:213-520`; `omgbase/drain.rs:85-166` | semantic | 2 | Phase 2 sidecar (§6) |
| read: `semantic(…)` scoring, brute-force cosine search, the `provider_unavailable` gate, `omg status` queue count, the `cosine` SQL function | `oqx-js/context.ts:blockVector`/`semanticScore` 746–760; `search/vector.ts` 39–90; `mcp/server.ts` 515–540; `core/store/store.ts` 50–57 | `context.rs:1783-1800`; `search.rs:628-738`, `:793`, `:863`; `catalog.rs:1311-1333`; `cli/cmd/status.rs:27-46` | semantic | 2 | Phase 2 (§6) |
| prune other models' rows; the DDL | `search/embeddings.ts` 316–332; `schema.ts:DOC_EMBEDDINGS_DDL` 135 | `search.rs:576-603`; `schema.rs:226` | semantic | 2 | Phase 2 (§6) |
| the one cross-dependency: the doc-embedding task reads the current head (`reconstruct`) — a frontmatter-through-history read today, a head read after M1 | `search/tasks.ts:buildDocEmbedTasks` 127–215 (`:219`) | `search.rs:270-330` | semantic | 2 | M1 removes the history hop; the seam is §6 |

note: TS counts 9 semantic rows, Rust 17 — granularity (Rust itemizes
`search.rs` per function and includes the pure `omgbase-search` crate), not
disagreement. TS-only: `search/cel/compile.ts` (247, 273, 620, 751–767) has
its own `updated_at`/`semantic`/edge SQL and **no production importer** (TS
§5.5); the Rust surface has no `cel` module → D9.

## 3. The replacement mechanisms

**M1 — Current heads/content** (plan §3 "Current heads and content"). The
head row owns the document's identity, path, liveness, an opaque head token,
the accepted content hash (`docs.file_hash` already is it), the frontmatter
**raw and its hash** stored as a current value (a `blocks` row of type
`frontmatter` or a `docs.frontmatter_hash` → `blobs`), and the doc-level
trivia; block bytes are referenced by the `blocks` row's own `raw_hash`/
`trivia_hash` with `putBlob` moved out of the tree writer so the current-
state ingest writes them itself. The ingest numbers and hashes the head
without reading a previous revision; the recorder keeps its own base for
deltas. Resolves 2.1 (all rows), 2.2 (all rows), 2.3 rows 1–2, 2.4 row 2,
2.6 row 1, 2.13 row 4. `spec/store` §6.1 "only the frontmatter resolves" and
I3 (body blocks only) move.

**M2 — Explicit creation/change metadata.** `docs.created_at`/`updated_at`
and `blocks.created_at`/`updated_at` columns written by the current-state
ingest — the block value set only when the block's own verdict is not `same`
(14.2's rule carried over) — with `deleted_at` on tombstones replacing
`deleted_commit` as the thing a reader filters on, and `created_commit`/
`properties.created_commit` replaced by the change token or dropped. The
recorder may derive the same values from its own tables. Resolves 2.5 row 3,
2.6 rows 3–4, 2.8 row 3, 2.9 rows 1–3. The `query-dates` fixtures and the
`liveDocRows`/`live_doc_rows` correlated subquery go with it.

**M3 — Identity claims.** A core-owned claims table (`id_claims(prefix, id)`
or per-prefix exact set) written at mint time and prunable by installation policy (D5: a claim carries holder bits; the core's hold is released by `identity.claims_retain_days`, the row stays while the recorder holds it) replaces the
`blocks ∪ block_changes ∪ resurrection_pool` oracle for `b`; `c`/`r`/`s`
become the recorder's own claims, `cp` follows D4. The squash's keep-the-
earliest-`block_changes`-row rule and `rebuild_index`'s mirror exception are
retired; `block_changes` returns to a pure projection the squash may empty.
The pool stays core (reconcile phase 6b depends on it) with `deleted_at` and
expiry anchored on its own row. Resolves 2.7 row 2 (identity half), 2.8 rows
2 and 4, 2.9 row 6, 2.10 (all rows), 2.12 row 3. Claims must be migrated
before any historical evidence is deleted (plan §3 "Identity allocation").

**M4 — Self-contained recovery payloads.** The pending row carries
`prior_hash` (the hash the commit validated the file against — the commit
phase already passes it, `mutate/commit.ts` 324–327) and the target bytes
or a hash of the whole rendered file; `renderedBytes`/`bytes_for` render
from current state (`reconstruct` is byte-exact for the current revision,
which a pending row always names, §5.7); `recoverRepo` and `repos_status`
compare against `docs.file_hash`; the `rev_id` FK and the `evaluateRetention`
pin go. Resolves 2.4 row 3, 2.6 rows 2 and 6 (which then become archival-
only), 2.11 rows 1–4.

**M5 — Feed sequence separate from archive retention** (plan §3 "Change
delivery"). A repository epoch + per-repo monotonic sequence + a compact
bounded feed (`seq`, `ts`, `origin`, `actor`, `reason`, the touched `(doc,
path, hash)` triples, deleted paths, moves) written by the current-state
transaction and never touched by retention; `changes_since` pages it, the
vocabulary cache keys on it, `sync_status` reports it; an expired cursor is
an explicit result. `commits` becomes the recorder's — written with the same
id when capture is on so fixtures that project commit ids keep their values;
the disposition counts in the summary become optional. Resolves 2.1 row 4
(the move record), 2.4 row 1 and 2.5 rows 1, 2, 4 (capture halves), 2.7
row 3.

**M6 — Current edges separate from transitions.** `edges` holds open rows
only (delete on close), with an optional recorder-owned `edge_transitions
(edge, opened, closed)`; `from_commit`/`to_commit` and `idx_edges_temporal`
leave the core table; `has_anchor` needs no filter. Resolves 2.9 rows 4–5.
`spec/graph/cases/intervals.json` moves to the recorder suite.

**M7 — GC roots from current state.** The mark roots on live and tombstoned
`blocks` rows' `raw_hash`/`trivia_hash`, the heads' frontmatter, pending rows'
payloads, the pool and active bounded snapshots; history roots (`revisions`'
`root_tree`/`frontmatter_blob`, `tree_nodes`) are attributed separately and
an unavailable recorder never lets GC reclaim its objects. Resolves 2.3 row 3
and restates `spec/store` §7 "mark-and-sweep from every live revision" and I5
per capability. Without it the first `gc` on a capture-off store deletes
every blob (TS §5.2).

## 4. Decisions required before Phase 1's spec delta

**Decided by Brendan, 2026-10-24/25** (the discussion is in his notes, workstream
`/workstreams/2026/10/2026-10-24-modular-core-implementation.md` § Decisions):

| # | decision |
| --- | --- |
| D1 | **A.** The head token is the `r_` revision id, minted by the core on every head change (content, structure, path, liveness); equal to the recorder's revision id when capture is on; the wire (`rev`, `_rev`, `expect.revision`, `base_revision`) unchanged; the manual says a token does not promise retained content. |
| D2 | **B**, in two steps. Deleted content is history: the core keeps the `docs` tombstone row (revival, the feed's deleted path), the id claims and the 30-day pool; the `blocks` rows go to the recorder. Phase 3 keeps the rows while making pool and claims independent of them; Phase 4 stops writing them in the core. |
| D3 | **A.** One additive error `capability_unavailable { capability: history \| semantic, state: disabled \| unavailable \| outside_coverage \| pruned }` (retriable only for `unavailable`, `data.fix` where one exists) for the dedicated history tools; `revision_archived` kept for the pruned-with-segment case; the `revisions` root and `_revisions` relation return the rows that exist plus a `hints` line, never an error; `version` advertises enabled capabilities and the coverage start. |
| D4 | **C.** `checkpoints` collapses to one row of sync status on the sync state; `files`, `git_head`, `commits.checkpoint_id` dropped; the `cp` prefix retired. A BATCH ID on the feed record (D7) is what a history strategy needs from batches. |
| D5 | An explicit `id_claims(prefix, id, minted_at, holders)` table written at mint for every core-minted prefix (`r` included); one probe; the squash's earliest-`block_changes` rule retired; the pool stays its own table (`deleted_commit` → `deleted_at`, expiry on its own timestamp). Claims are PRUNABLE by installation policy: pruning releases the core's hold, the row stays while the recorder holds the id; with history off a reused id can only misdirect an unguarded read by name — every guarded write fails `stale_expectation`/`target_missing`. Growth is its own size-report line. |
| D6 | **A.** `created_at` is the identity's birth and survives resurrection (the pool row carries it), cross-document moves and path revival; `updated_at` is the entity's own last change — a container's when its raw changes, a document's with the head token (renames and liveness count). |
| D7 | The commit record stays the feed entry with its `c_` id and the `changes_since` shape, slimmed to `epoch, seq, commit_id, ts, origin, actor, reason, batch_id` + one entry per touched document `{ doc_id, path, head token, hash, kind: created \| changed \| deleted \| moved, from_path }`; `ops` and the disposition `summary` leave the core (summary optional); a repository EPOCH (init / restore / rebuild-from-files), cursors `(epoch, seq)`, an explicit `expired_cursor { epoch, oldest, head }` → the consumer rescans; `changes_since` exposes `oldest` and `epoch`; a bounded bootstrap snapshot lease. Retention configurable and documented ("the feed is catch-up, a rescan is recovery, the log is history"): floors `feed.retain_days = 10`, `feed.retain_entries = 10000`, cap `feed.max_entries = 100000`, shown in `doctor --size`. |
| D8 | **Fixed now** (4bfe2cb): `has_anchor()` reads only open edges in both engines, fixture `reads::has-anchor-open-edges`. |
| D9 | **Drop them all** in the Phase 1 store major: `commits.checkpoint_id`, `properties.deleted_commit` (+ the partial-index predicates and read filters), `inferred_edges`, `collections`, `idx_edges_temporal`, `repos_status.unconverged` (or redefined as the drift count); the size report recast as content / identity / recovery / history / search / sync. TS `search/cel/compile.ts` deleted now (code only). |
| D10 | **B.** Raw and trivia bytes inline on `blocks`, the frontmatter raw on `docs`; `raw_hash` stays the CAS and dedup key; `blobs` entirely the recorder's; no byte GC in the core. |
| D11 | **A.** A move is a transition — a new revision with the same content and the new path; a delete mints no revision (tombstone `deleted_at`, CAS fails on liveness); a revival mints one. |

The questions as they were put, for the record:


- **D1 — The head token vs the `r_` revision id.** Whether `rev`/`_rev`/
  `base_revision`/`expect.revision`/`preconditions.docs[].base_revision` are
  the head token with `revisions.rev_id` **equal to it** when capture is on
  (so `docs_read { at: rev }` keeps working and interop `_rev` equality means
  "same head"), or a separate opaque token with `_rev` meaning "the revision
  or null". spec/surface `reads`/`query-revisions`/`interop` and spec/mutate
  pin `r_<n>` values today (TS §3.13, Rust §3.3). Plan guarantee 4 rules out
  a hash as the sole token (content can change away and back).
- **D2 — Tombstoned documents' `blocks` rows.** A tombstoned doc keeps its
  `docs` row and its `blocks` rows (`deleted_commit` set), and the pool /
  `crossDocIds` eviction depends on them (`ingest.ts` 356–362, `observe.rs:
  457-495`). Current state (they claim ids and their blobs must survive GC)
  or history (the recorder owns "what was there", core keeps a path
  tombstone + claims + pool bytes)?
- **D3 — History reads on a capture-off store.** `docs_read { at }`,
  `docs_diff`, `docs_diff_unified`, `docs_history`, `blocks_history` and the
  `revisions` OQX root today assume the row exists (`target_missing`,
  `revision_archived`). A distinct refusal is needed — a
  `capability_unavailable` envelope (`data: { capability: "history", state:
  disabled | unavailable | outside_coverage | pruned }`, the four states plan
  §5 names) alongside `provider_unavailable` for semantic — and the `revisions`
  root must choose between an empty scan and the same error.
- **D4 — `checkpoints` classification.** TS: sync bookkeeping, current-state
  (names no commit). Rust: capture of batches, phase 4. Proposed: keep the
  row in the sync layer (it is the freshness sweep's cursor, not history),
  drop `files`/`git_head` or make them the recorder's, and drop
  `commits.checkpoint_id`; the `cp` claim moves to the claims table.
- **D5 — The claim's shape.** Whether `block_changes`' per-block earliest row
  survives as the claim (the squash rule kept) or the claims table replaces
  it outright (the rule retired, `block_changes` droppable); and whether the
  30-day pool and the claims table are one table (a claim with an optional
  pooled payload) or two (Rust §3.10).
- **D6 — `_updated_at` under the explicit column.** The block value is the
  block's own last change (as 14.2 decided — a `same` carry does not touch
  it); the document value is its last commit. Open: `blocks.created_at` for a
  resurrected or cross-document-moved block (today the earliest
  `block_changes` row survives pool and squash, so creation is the original
  mint — TS §3.4) — carried by the eviction/resurrection path, or reset.
- **D7 — The feed record's content and limits.** Columns (`seq`, `ts`,
  `origin`, `actor`, `reason`, touched `(doc, path, hash)` triples, deleted
  paths, moves; disposition counts optional), the epoch, retention length,
  the expired-cursor result, head/oldest exposure, snapshot-lease bounds —
  the numbers from `baseline.md` (1,778 commits over two months on the real
  corpus; ≈ 660 B per `commits` row today).
- **D8 — `has_anchor` without the open-interval filter**, in both engines
  (`context.ts` 704, `context.rs:1565-1568`): fix now with a fixture, or let
  M6 make the filter moot. Either way a fixture pins the closed-edge case.
- **D9 — Dead and vestigial record kinds**, to remove in Phase 1's delta or
  hand to the recorder: `commits.checkpoint_id` (always NULL),
  `properties.deleted_commit` (never written; four partial indexes and every
  read filter on it), `inferred_edges` and `collections` (created, untouched),
  `idx_edges_temporal` (no reader), `repos_status.unconverged` (`file_hash ≠
  rendered_hash`, always 0 under I1; the drift scan is the real signal),
  TS `search/cel/compile.ts` (890 lines, no importer, no Rust twin), and the
  size report's categories (`resurrection_pool`, `pending_materializations`
  as "history").
- **D10 — Blob ownership.** Whether the core keeps a content-addressed
  `blobs` table of its own (reachable from blocks + heads + pending rows) that
  the recorder also references, or inlines raws into `blocks` (Rust §6.10);
  the plan's §3 allows shared immutable storage "provided ownership and GC
  roots are explicit" (M7).
- **D11 — `docs_move` and the revision's path.** `movePath` rewrites
  `revisions.path` of the current revision in place (TS §5.11, Rust §6.7).
  Under the split the current path is the head's; the recorder decides
  whether a move is a new captured transition or an edit of the last.

## 5. Phase 1 — the proposed spec delta, as a checklist

- [ ] **spec/store** (a store major): the head token ↔ `revisions.rev_id`
      (D1); the frontmatter encoding on the head (M1: §3.1, §6.1, I3);
      `created_at`/`updated_at`/`deleted_at` (M2); `id_claims` and §2.1
      "Uniqueness at mint" rewritten over it (M3, D5); the pool's `deleted_at`,
      I6 restated; the pending row's `prior_hash` + target payload, the
      `rev_id` FK gone, §5.7 rendering from current state (M4); the feed's
      epoch/sequence, `commits` moved to a "capture" section (M5, D7); `edges`
      open-only + `edge_transitions` (M6); GC roots and I5 per capability
      (M7); the capture lifecycle (enable = baseline + coverage start, disable
      = boundary, purge separate) and the per-repository manifest (plan §5);
      dead columns dropped (D9); `schema.sql` split into core / history /
      semantic bundles (`schema.rs:22` already names this).
- [ ] **spec/surface**: the `capability_unavailable` error envelope and its
      four states (D3); `_rev` wording in the card and manual
      (`mcp/reference.ts` 138–143, 227–258, 621–644; `descriptions.rs`) —
      "a token returned in `rev` does not guarantee retained historical
      content"; `revisions`/`_revisions`, `_updated_at`/`_created_at`
      re-sourced (M2); `changes_since` summary counts marked optional.
- [ ] **spec/mutate**: the CAS vocabulary (`expect.revision`, `base_revision`,
      `stale_plan` data) against the head token (D1); the pending row's
      columns in §4 and the commit protocol's prior-hash capture.
- [ ] **spec/sync**: the sync base lease — optional history supplies no
      unlimited common ancestor; clients keep their base or negotiate a
      bounded server-side lease, and expiry surfaces a conflict (plan "Sync
      implication"); `checkpoints` per D4; §6 feed cursor scoped to the epoch
      with the expired-cursor result.
- [ ] **spec/graph**: `intervals.json` (33 `from_commit`/`to_commit`
      projections) moves to the recorder suite; a `has_anchor` closed-edge
      fixture (D8).
- [ ] **Fixture suites that move** (inventories §4): `spec/store/cases` —
      `revisions`/`tree_nodes`/`dispositions`/`block_changes`/`commits`
      projections to the recorder suite, `docs`/`blocks`/`blobs`/pool/pending
      stay; `garbage.json` and `delta.json` recorder-only; `identity.json`
      reshaped over claims. `spec/mutate/cases/{commit,materialize}.json`
      (pending-row columns, `rendered_hash`/`revisions`/`commits`
      projections). `spec/sync/cases/checkpoint.json` (history-table
      projections). `spec/surface/cases/{reads,query-revisions,query-dates,
      query-links,interop}.json` (`_rev` tokens, timestamps, history tools
      behind a capability flag, open edges). `spec/cli/cases/{history,
      admin}.json` (`log`/`hist`/`diff`/`history *` stdout, `gc`/`doctor
      --size` categories). `spec/reconcile/cases/resurrection.json` assumes
      the pool semantics of M3 (unchanged in shape).
- [ ] **Dependency-direction check** (the Phase 1 gate: "dependency checks
      prevent new imports from core into concrete extensions"). TS: a
      `no-restricted-imports` rule or import-graph test — `core/**`,
      `mutate/**`, `sync/**`, `oqx-js/**` import nothing from
      `graph/history.ts`, `core/store/{archive,retention,delta}.ts`,
      `search/{embeddings,vector,tasks,drain}.ts`, `search/cel/**`; only the
      composition layer (`mcp/server.ts`, `index.ts`, the CLI) imports both.
      Rust: `omgbase-store` split into `core` / `history` / `semantic` modules
      (later crates) with a test that `core` names no `history::`/
      `semantic::`/`archive`/`retention`/`delta`/`search` item, and the
      surface's `context`/`translate`/`planner` reach them only through the
      capability interfaces.
- [ ] **Existing fixtures pass unchanged** at the end of Phase 1 (interfaces
      wrap current behaviour; no on-disk change until both engines carry it).

## 6. Phase 2 opener — the smallest semantic extraction

The semantic layer reads only the current head, so the first change is an
interface, not a data move. Define `SemanticProvider` in the core with
`blockVector(raw_hash, ctx_hash, model)`, `docVector(doc_id, model)`,
`available(model)` (the `provider_unavailable` gate) and the drain's
`embed`/`embedDocs`/`pruneForeign`; implement it in TS by
`search/{embeddings,vector,tasks,drain}.ts` and in Rust by
`omgbase-store/search.rs:213-738` + `omgbase/drain.rs:85-166`; inject it from
the composition layer (`mcp/server.ts`, the binary). The call sites that
switch to the interface are `oqx-js/context.ts` 746–760 and `mcp/server.ts`
515–540 (TS); `context.rs:1783-1800 semantic_score`, `catalog.rs:1311-1333
require_rankable`, `cli/cmd/status.rs:27-46` (Rust). The seam is
`build_doc_embed_tasks` → `reconstruct` (`search.rs:270-330`,
`search/tasks.ts:219`): the provider receives the head's bytes and hash from
the core's read API instead of calling into the store. Move with it the
`cosine` SQL function registration (`store.ts` 50–57) and the `embeddings`/
`doc_embeddings` DDL (`schema.ts:135`, `schema.rs:226`) into the semantic
bundle, and delete `search/cel/compile.ts`. Gate: the core boots and passes
every read/mutation fixture with the provider absent; `spec/search` passes
with it present; `interop.rs` green.

## 6a. Status (2026-10-26) — Phases 0–5 complete in both engines; Phase 6 open

**Phases 1–3 are complete in both engines** (store 17.0, released as
`a91354b`): the seams (Phase 1), the semantic bundle behind
`SemanticProvider` (Phase 2), and the on-disk slices 3a–3e-ii (heads and
inline bytes, identity claims, self-contained recovery, the slim feed,
open-only edges and the D9 drops, the manifest and the alert channel) —
every current read is off the history tables, the DDL is three bundles.

**Phase 4 makes capture optional**, in two slices (both complete in both
engines — `02d310c` is 4b's Rust twin, `fce6810` the stacked 17.2 release):

- **4a (this slice; TypeScript reference + spec, `spec/store` 17.1,
  `spec/surface` 6.1, `spec/sync` 4.1, `spec/cli` 5.1):** the composition —
  the history bundle's DDL follows the manifest (executed when a repository's
  row becomes `enabled`; a fresh database holds the core and semantic
  bundles), a commit hands the recorder its rows only while the repository's
  row is `enabled` (`captureFor`); `omg history enable|disable` (`enable`
  writes the contracts' §1.14 baseline and opens a coverage interval,
  `disable` closes it and keeps the rows), `omg source add --no-history`;
  `writer_requires` reachable (a composition without the module refuses an
  enabled repository's writes outside the transaction, `writer_refused`
  raised); capture failure rolls the member back (`capture_failed` alert and
  envelope, retried by the next sweep — resolution 18); `version.
  capabilities` carries `coverage_from`/`writer_requires`/`model`; the
  history tools raise `capability_unavailable { history, disabled |
  unavailable }` and `docs_read { at: <current head> }` is served from the
  rows (resolution 11); no SQL outside the history bundle names a history
  table (`history-writers.ts`, `history-gc.ts`; the dependency-direction
  gate); `OMGBASE_CAPABILITIES=core` is the test-only override that runs the
  engine as a core-only build (no recorder) — every fixture suite runs under
  it, comparing the core tables. **Measured** (`baseline.md` "17.1 (Phase
  4a)"): history OFF ends at **4.20 MB (19.2× the source) against 6.89 MB
  (31.5×)** with capture on — the `history` category 0 B; small edits cost
  0.6–1.2 KB instead of 1.6–3.4. The Rust twin follows as its own task; the
  fixtures of this slice are its contract.
- **4b (this slice; TypeScript reference + spec, `spec/store` 17.2,
  `spec/surface` 6.2, `spec/cli` 5.2, `spec/sync` 4.2):** the read-side
  **decision table** (`spec/surface` §3) — `outside_coverage`/`pruned`
  decided over the token's `id_claims.minted_at` and the manifest's coverage
  intervals, `disabled`/`unavailable` as 4a pinned, `target_missing` for a
  token nobody minted or another document's, `revision_archived` kept;
  `docs_history` always lists the current head with `retained` and carries
  `coverage` (resolution 11); the `_revisions` relation and `^revisions`
  carry the capability note; **`omg history purge [--before <ts>]`**
  (`spec/store` §7.6 — the rows per commit, a live head's revision protected
  while capture is on, the first retained revision re-checkpointed, open
  edge intervals re-anchored, the recorder's holds released except on the
  live set while capture is on, the bundle's tables dropped automatically
  when no repository is enabled and nothing is left; **coverage is not
  rewritten** — it is the record `pruned` rests on); **`omg embed enable
  [--provider] | disable`** own the semantic row (`spec/store` §5.10; a
  settings write re-derives the row only when the effective provider
  changed, so a `disable` is sticky; "disabled with a provider" refuses the
  explicit semantic paths with `fix: omg embed enable`); the **`feed_capped`
  alert** (raised by the write-time cap, cleared by a gc whose cap pass
  prunes nothing) and `doctor --size`'s feed-cap advice read from it; the
  TS sync runner's core-only mapping (`spec/sync` §8); and the
  **real-corpus measurement** (`scripts/baseline/real-corpus.mjs`,
  `baseline.md` §3): on this repository's `docs/` the database is **10.4×
  the Markdown with history on and 6.7× with it off** (−36 %), 16.5× / 12.8×
  with the embedder. Phase 5 inherited **D2 step two**, the migration of
  real repositories under the four compositions and fault injection.

**Phase 5 qualifies the migration** — "migrate copies of real repositories,
preserve history and identities, test restart/rollback procedures, run
mixed-engine clients and profile benchmarks; gate: four-profile conformance,
fault injection, compatible-open behaviour and measured amplification all
pass" — in two slices: 5a builds the tooling and the remaining code (this
slice; TypeScript reference + spec, `spec/store` 17.3, `spec/surface` 6.3,
`spec/sync` 4.3, `spec/cli` 5.3, `spec/mutate` 4.1; no real repository is
touched), 5b runs it on copies of Brendan's workspaces.

- **5a (this slice).** (1) **D2 step two's write side**: both tombstone paths
  — the observed deletion (`sync/tombstone.ts`) and `docs_delete`
  (`mutate/commit.ts`) — now `DELETE FROM blocks WHERE doc_id = ?` where
  17.0–17.2 tombstoned the rows in place; the recorder needed no new seam
  (the head's last captured revision IS the deleted content, and §5.6 step 4
  already hands it the `deleted` transition), the pool row already carried
  `created_at` (D6) so revival works with history off unchanged, and the only
  reader of a tombstoned row — the primary-key eviction on resurrection —
  finds nothing to evict. A 17.0–17.2 database's tombstoned rows leave on its
  first open as a 17.x finish step after the claims backfill (`spec/store`
  §3.4 step 17 (15)), not as a `gc` count. 18 fixtures moved by removal
  alone (store 8, mutate 6, sync 3, cli 1 — the size table after an `rm`);
  C7 restated. No on-disk change —
  `blocks.deleted_at` stays, always NULL. (2) **The four compositions**:
  `OMGBASE_CAPABILITIES=core | history | semantic | full`
  (`historyCapabilities`, `semanticCapabilities`, `envComposition`); every
  fixture runner — store, mutate, surface, graph, sync, search, cli, interop —
  runs under all four with compare/map/skip rules keyed on the ABSENT module
  and prints one ledger line; **`pnpm conformance`** (`scripts/conformance.mjs`)
  runs the eight suites under the four compositions sequentially and prints
  the matrix below. (3) **Fault injection outside the runners**:
  `OMGBASE_FAULT=<site>[:<nth>]` at five sites both engines spell alike —
  `recorder.capture`, `feed.append`, `commit.after-commit`,
  `materialize.before-write`, `materialize.after-write` (`core/fault.ts`,
  `spec/store` §9.7); `src/fault-injection.test.ts` drives a write through
  each and pins the acceptance-matrix outcome (rolled back / recoverable /
  alert raised / retried). (4) **The qualification script**
  `scripts/qualify/migrate-copy.mjs` — copy (the original never opened),
  BEFORE/AFTER snapshots, the migration through the current engine, the §7
  step-4 diff (bytes per document, id/parent/order maps, property and link
  rows, pending rows, claims), CAS and recovery on the copy, compatible-open
  through the Rust binary and an older `--before-bin`, the six-category size
  table, and `--compositions` for the measured amplification; its test
  (`node --test scripts/qualify/migrate-copy.test.mjs`) runs it on the spec's
  16.x pre-state and on a harness-built 17.x workspace. (5) **The runbook**
  `docs/modular-core/migration-runbook.md`: the §7 steps as an operator
  procedure, the rollback rule, the engine × schema compatibility matrix,
  the one-line invocation 5b runs. **The Rust twin** mirrors the tombstone
  DELETE and the finish step, the four compositions in its runners (the
  cells below are its contract), the five fault sites, and may be pointed at
  the same script as `--rust-bin`.

  The conformance matrix of the reference (`pnpm conformance`, Rust pairings
  skipped — compared / mapped / skipped per cell; see each spec's runner
  section for what "mapped" means there), as of Phase 6b (the fifth column
  `git` — `OMGBASE_CAPABILITIES=git`, the git history provider attached and no
  native recorder — with the `git` fixtures of 6a and the `git-remote`
  fixtures of 6b; `spec/store` §9.6):

  | suite | core | history | semantic | full | git |
  | --- | --- | --- | --- | --- | --- |
  | store | 0/66/80 | 119/9/18 | 1/65/80 | 146/0/0 | 17/66/63 |
  | mutate | 0/284/0 | 284/0/0 | 0/284/0 | 284/0/0 | 0/284/0 |
  | surface | 511/11/48 | 565/2/3 | 512/11/47 | 570/0/0 | 513/11/46 |
  | graph | 146/0/0 | 146/0/0 | 146/0/0 | 146/0/0 | 146/0/0 |
  | sync | 61/22/0 | 83/0/0 | 61/22/0 | 83/0/0 | 61/22/0 |
  | search | 32/15/36 | 32/15/36 | 83/0/0 | 83/0/0 | 32/15/36 |
  | cli | 380/0/197 | 510/0/67 | 413/0/164 | 577/0/0 | 388/0/189 |
  | interop (ts→ts; 87 Rust pairings skipped) | 14/15/87 | 28/1/87 | 15/14/87 | 29/0/87 | 14/15/87 |

  40 cells green (`conformance: 40 cells green`, 2026-10-26, ≈ 35 minutes
  wall-clock — the CLI suite is 2–5 of them per composition). The Phase 6a
  matrix (store 135 / surface 569 / cli 571 on `full`, before the 11
  `git-remote` scripts, `reads::git-remote`, the six remote CLI cases and
  the `remote` key of 6.5) and the Phase 5a matrix (32 cells) are in the git
  history of this file.

- **5a-ii (this slice; TypeScript reference + spec, `spec/store` 17.4,
  `spec/sync` 4.4, `spec/cli` 5.4).** What the first 5b run — the script on
  copies of two real 16.x workspaces, 853 and 116 documents — found, fixed
  in the reference. **(F1) Legacy bytes.** In the 116-document database
  every block had been ingested before block trivia was stored (schema v6
  added `blocks.trivia_hash`); 16.x `reconstruct` had assumed a NULL meant
  empty trailing bytes and served the documents without the newlines
  between their blocks, while the files and `docs.file_hash` were right;
  step 17 copied the rows as they were, so 115 of 116 documents came out
  with `sha256(reconstruct) != file_hash` (the 853-document database, its
  trivia stored, migrated with no diff). Decided — no column: the migration
  runs a **fidelity check** (`spec/store` §3.4 step 17 (16) — in full at the
  16 → 17 entry point, behind a cheap signature of legacy rows on every
  later open, so a healthy database never hashes its bytes on open) and
  names the documents in the **`legacy_bytes`** alert (`warning`, the count
  and the first 20 ids); `omg doctor` gains **`bytes reproducible`** and
  re-derives it in full; **`omg sync` repairs** every named document whose
  file is present and hashes to `file_hash` — the separator columns
  rewritten from the file's parse, positionally (identical texts to the same
  ids, no matcher), every block keeps its id, the head stays, no commit, no
  revision, no `updated_at`; the recorder's capture of the head stays the
  16.x capture until the next commit (legacy fidelity, `spec/store` §5.11,
  §8 C9); the sweep result gains `repaired`; a document whose file is gone
  stays listed. **(F2) FTS orphans.** The 16 → 17 step rebuilds the FTS
  index (a 16.x index held every block — 1771 rows for 1547 leaves on the
  116-document copy) and the 17.3 finish step purges the index entries of
  the tombstoned rows it deletes (only those the index holds —
  `blocks_fts_docsize` says which; a `delete` for an unindexed row corrupts
  the index). **(F3/F4) The script**: the `--before-bin` refusal recognised
  by its message whatever the exit (omgbase 0.27.3 exits 0 under `--json`);
  a database with no `docs` table reported `{ ok: false, reason }`, exit 2;
  the copy's `fs` sources re-pointed at the copied tree (`--with-files`
  copies an outside root, every `omg` runs `--stale`) so nothing reaches the
  original directory — the 5a script's recovery check had run against the
  original root; `--repair` runs the sweep on the copy and reports `repair:
  { legacy_bytes_before, repaired, remaining }`; the composition pass no
  longer counts AFTER's own `bytes_hash` as a composition difference (the
  `reads_equal_after: false` of the first run was F1's consequence, not a
  composition's). Fixtures: `migrations::v16-to-v17-legacy-trivia` new,
  `v16-to-v17-heads-inline-bytes-time` moved (its fake hash earns the
  alert row); `spec/sync` three `checkpoint::legacy-bytes-*` cases and the
  `sql`/`legacy_bytes`/`alerts` steps; `spec/cli` the nine `doctor`
  renderings and four `sync --json` shapes. After the fixes, on the copies:
  the 116-document one at v17 with `legacy_bytes` 115, FTS 1547 == 1547,
  `doctor` red on the two legacy checks alone; the 853-document one green.
  **The Rust twin must mirror**: step 17 (2)'s FTS rebuild, (15)'s
  docsize-gated purge, (16)'s check at both entry points with the signature
  gate, the alert's message/detail byte for byte, `doctor`'s line, the
  sweep's step 5 and `repaired`, the three fixture steps.
- **5b (next).** Run `node scripts/qualify/migrate-copy.mjs --workspace <dir>
  --rust-bin target/release/omgbase --with-files --repair --compositions` on
  copies of the real workspaces (with `--before-bin` where the writing `omg`
  is still installed), record the size tables (numbers only) in
  `baseline.md`, cut over per the runbook — `omg sync` right after the
  migration repairs the legacy documents — and run `OMGBASE_FAULT` drives
  against a copy under each engine.

## 6b. Phase 6 — one alternative history strategy (the Git-backed provider: 6a the engine-owned repository, 6b the remote half; TypeScript reference + spec)

**6a (this slice; TypeScript reference + spec, `spec/store` 17.5 §5.12, `spec/surface` 6.4, `spec/cli` 5.5, `spec/sync`
4.5; the design decided by Brendan 2026-10-26, followed exactly).** A repository's history may be kept by a **bare Git
repository at `<workspace>/.omgbase/git`** instead of the recorder's tables. (1) **The seam, as landed**: `HistoryReader` —
the read half of `HistoryRecorder` (`readAtRevision`, `docsHistory`, `docRevisionRows`, `revisionRows`, `hasRevision`,
`uncapturedHeads`, the diffs, `blocksHistory`, `dispositionCounts`) — extracted; `HistoryRecorder extends HistoryReader`
and keeps capture, `frontmatterAtRevision`, the lifecycle and maintenance; a new `HistoryProvider` seam (`name`,
`available`, `reader`, `enable`, `purge`, `checkpoint`) with a process-wide **registry** (`registerHistoryProvider`) the
composition layer fills before a store opens — the CLI's `installSpecSeams`, the MCP host, the fixture runners;
`Capabilities.providers` carries what was registered (`full` and the new `git` composition attach it; `core`, `history`,
`semantic` attach none). The core reaches a repository's history through `historyReaderFor(db, repoId)`, which picks by
the manifest row's `config.provider` (`native` when absent); `captureFor` is null on a provider row (its commits write
the feed alone); `anyHistoryEnabled` counts native rows only; `requireWriter` checks the module the row's provider needs.
The core imports nothing from the provider's package — `dependency-direction.test.ts` and the eslint rule pin it. (2)
**The manifest config**: `{ provider: "git", git_dir: ".omgbase/git", branch: "omgbase", cadence: "every" | {
debounce_ms }, ids_ref: "refs/omgbase/ids", remote: null }`; one provider per repository (`HistoryProviderConflict`, a
usage error in the CLI; the switch is `disable` then `enable --provider`). (3) **The worker** (`@omgbase/git-adapter`,
private): resume from the branch tip's `omgbase-seq` trailer (the `$git` row of `sync_state` is its cache), page
`changes_since`, stage each row's documents from the ROWS (`reconstruct` → `hash-object -w --stdin`; a move = remove +
add; a delete leaves the tree; a document superseded within the pending span is written by the later row), tree from the
parent's tree through a temporary index (`read-tree`, `update-index --index-info`, `write-tree`), `commit-tree` with the
trailers `omgbase-seq`/`-ts`/`-commit`/`-origin`/`-actor`/`-plan`/`-rescan`/`-doc: <doc_id> <path> <head|->`, the
`git.commit` fault site, `update-ref` by compare-and-swap. Cadence `every` (one commit per row) and `{ debounce_ms }`
(fold what is pending; no timer in 6a). `history enable --provider git` writes the baseline snapshot under the same
`import`/`history enabled` feed row native uses; an expired cursor, a tipless or foreign-epoch branch is a rescan. The
freshness sweep runs the worker (step 6) before every CLI verb; `omg history checkpoint` runs it explicitly. (4) **The
reader**: versions are the commits whose trailers name the document (`git log --grep`), under the native shape — `_rev`
the trailer's head token, `_commit` the git sha, `_hash` the blob's sha256, `_ts` the trailer's instant; `docs_read { at:
<sha> | <head> }` the blob through `cat-file --batch`; the diffs over blobs; the `revisions` root the same rows; the head
unretained until a commit names it; a sha is decided by the reader (`pruned` when git lacks the object, `outside_coverage`
by `omgbase-ts`, `target_missing` when the commit names no version of the document), a head token the commits lack by the
core's claim table; `blocks_history`/`docs_diff` are the new state **`unsupported`** (no block lineage); `unavailable`
when `git` is not on PATH or the provider is not attached — the `history_provider_unavailable` alert, reads fail, WRITES
CONTINUE. `version.capabilities.history` = `{ state, provider, coverage_from, writer_requires, completeness }` for both
providers (native: `native`/`every`). (5) **Determinism recipe** (the fixtures pin shas): every spawn with `GIT_DIR`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, no `HOME`, `LC_ALL=C`, `TZ=UTC`; committer
`omgbase <omgbase@fixture>` under the conformance seams (`omgbase@localhost` in production), author name = the row's
actor, both dates the row's `ts` as `@<seconds> +0000`; the message rendered and parsed by the engine, never by `git
interpret-trailers`; `OMGBASE_GIT_BIN` names the executable. (6) **Fixtures**: the fifth composition
`OMGBASE_CAPABILITIES=git`; `spec/store/cases/history/git.json` (7 scripts: enable-write-checkpoint, delete, the crash gap
closed by replay through the `git_fault` device, the debounce fold, purge then rescan, disable then re-enable on top, the
provider conflict — `git_checkpoint`/`git_log`/`git_tree`/`git_fault` steps, `history_enable { provider, branch, cadence
}`); `reads::git-history` (the baseline, the unretained head, the five states and `unsupported`, a `docs_move`, disable,
purge, re-enable); the seven CLI cases; every `version`/`sync_status` fixture moved by the two keys (reads 6 cases,
examples, interop 5 cases, cli 26 cases). The conformance matrix below gained its `git` column. (7) **Measured**
(`baseline.md` §3): on this repository's `docs/` the git provider keeps the import as 0.35 MB of packed objects beside a
6.38 MB database against 3.44 MB of native history rows. **The Rust twin** (a separate task) mirrors: the seam split, the
registry and `providers`, the `git` composition, the worker spawning `git` with the same argv and environment (the
message text, the raw dates, the identity), the reader's shapes and decision rows, `unsupported`, the verbs, the five
compositions in its runners; the fixtures of this slice are its contract. **6b inherits**: the `remote` half of the
config (push on checkpoint / periodic, fetch periodic / webhook — credentials still outside omgbase), the
`refs/omgbase/ids` id-map ref (identities recoverable from a clone), a timer for the debounce cadence, one `git log` per
`revisionRows` call instead of one per document, the synthetic-workload per-edit comparison, and the MCP host's
mutation hook running the worker.

**6b (this slice; TypeScript reference + spec, `spec/store` 17.6 §5.12, `spec/surface` 6.5, `spec/cli` 5.6, `spec/sync`
4.6; the design note's §8 and "Remote divergence", decided by Brendan 2026-10-26 and followed exactly).** Sync is
coordination between the engine's branch and the remote's. (1) **The remote binding**: `history.config.remote = { name,
url, branch, push: off | on-checkpoint | periodic, fetch: off | periodic | webhook }` (null until `omg history remote set
--url <url> [--name] [--branch] [--push] [--fetch]`; both policies default `off` — nothing is automatic until configured;
a URL with credentials is refused; `history remote unset` forgets it; `history remote status` → `{ remote, branch,
local_tip, remote_tip, pushed_through, state: in-sync | ahead | behind | diverged | unknown }` from local refs alone);
`version.capabilities.history.remote = { name, branch, state, pushed_through } | null` puts the third level — remotely
synchronised, beside current state and locally checkpointed — on the wire (every `version`/`sync_status` fixture moved by
the one key). The binding rewrites the manifest row's `config` in place (`updateHistoryProviderConfig`): configuration,
not a rebuild. (2) **Push** (`omg history push`; `on-checkpoint` after each checkpoint that committed, `periodic` the
sweep's step 7): the branch and the ids ref, never `--force`; a rejected push raises `git_remote_diverged` (warning, `{
remote, branch, local_tip, remote_tip }`) and exits 1 — a fetch merges, the push lands after; `pushed_through` (the seq
trailer of the last pushed tip) rides on the `$git` cursor row. (3) **Fetch** (`omg history fetch`; `periodic` the
sweep's step 8; `webhook` reserved for an external caller): the remote ahead → its tree changes enter the vault THROUGH
THE SOURCE BOUNDARY — the new `HistoryVaultSink` seam, bound by the composition layer to the repository's root and the
observe path (`fsVaultSink`: files written as external edits, `processCheckpoint` over them) and by the fixture runners
to `observeBatch` — then the branch fast-forwards; both sides moved → a three-way merge AT THE TREE LEVEL with the
ancestor git supplies: one side changed → taken, both to the same blob → nothing, both to different blobs → a CONFLICT
with both versions kept (ours at the path, the remote's as `<stem>.remote-<short>.md` beside it), the alert
`git_merge_conflict { paths }`, no merge commit until `history remote resolve <path> --ours|--theirs` settles the last
one; a clean merge is one merge commit with `omgbase-merge: <remote tip>`. The worker then finds the inbound rows' bytes
already in the tree and commits nothing for them — the **no-op rule** (a checkpoint whose tree is its parent's writes no
commit; the cursor row advances) and the **resume rule** (the row refines the tip's trailer when it names the same tip),
pinned. (4) **Divergence** (the remote rewritten — its tip no longer descends from the tip we last knew): detect, stop,
alert — `git_remote_diverged { …, old_remote_tip }`, push and fetch pause, checkpointing continues; the four explicit
remediations, each refusing without the alert: `history remote reconcile --rebase` (our unpushed checkpoints replayed
onto the new head, per file three-way with the OLD remote tip as base, messages and trailers preserved byte for byte,
the ids ref rebased alongside, the old tip on `refs/omgbase/backup/<ts>`), `--merge` (one merge commit, both histories
kept), `--adopt` (the remote's head becomes truth: its tree through the source boundary, our local edits kept beside as
`<stem>.local-<short>.md` and surfaced as conflicts, our branch reset, the old tip backed up), `--fork` (our branch
pushed as `<branch>-omgbase-<ts>`, `git_remote_forked`, the human merges with git, then `--adopt`). Never a force-push,
never an unpushed commit dropped without a backup ref, never a silent last-write-wins. (5) **`refs/omgbase/ids`**: the
worker writes, beside every checkpoint, the per-document id maps `.omgbase/ids/<doc_id>` — canonical JSON `{ blocks: [{
hash, id, ordinal, parent }], doc, head }` — as a parallel commit chain carrying the same `omgbase-seq` and
`omgbase-content: <content sha>`; push and fetch carry the ref; `git show refs/omgbase/ids:.omgbase/ids/<doc_id>` on a
clone lists a document's id map (pinned on the fixture's remote). The content branch stays a plain notes repository.
Restoration from the ref is 6c. (6) **The debounce timer and the mutation hook**: `omg mcp` hands its `onMutation` hook
to `createCheckpointScheduler` — `every` runs the worker synchronously after each successful write tool (the git history
is complete without `omg sync`), `{ debounce_ms }` re-arms one timer so a burst folds into one commit; the watcher's
checkpoints notify it too; a pending timer runs at shutdown (fake-timer unit test). (7) **Measured** (`baseline.md` §3):
the git row of `scripts/baseline/real-corpus.mjs` now also pushes to a local bare remote and reports the remote's packed
size beside the local one. (8) **Fixtures**: `spec/store/cases/history/git-remote.json` (11 scripts against a SECOND
bare repository under the case's temp dir — a local path URL, no network — through the new `git_remote*`, `git_push`,
`git_fetch`, `git_resolve`, `git_reconcile`, `git_remote_commit` (a commit on the remote as someone else, `parent: tip^`
a rewrite), `git_remote_log|tree`, `git_ids_log|show` and `alerts` steps), `reads::git-remote` (the `version` key by
shape, `sync_status` literal, the conflict alert riding on `docs_history`/`query` and absent on an error, the resolve),
the six CLI cases `history::history-git-remote-*` / `history-push-on-native` (the CLI runner's `remote` step device
creates `<workspace>/remote.git` and commits on it), the adapter's `remote.test.ts` (16). **The Rust twin** mirrors: the
seam additions (`HistoryVaultSink`, `remoteSummary`/`remoteSync`, `updateHistoryProviderConfig`, the sweep's steps 7–8
with the filesystem sink, `version…remote`), the adapter's remote module spawning `git` with the same argv (`push
--porcelain --quiet`, `fetch --quiet --no-tags`, `ls-remote`, `merge-base [--is-ancestor]`, `diff-tree -r -z
--no-renames`, `ls-tree -r -z`, `rev-list --reverse`), the ref names, the alert codes, messages and detail keys byte for
byte, the sidecar naming, the no-op and resume rules, the ids blob (canonical JSON + newline) and chain, the error
codes, the verbs and renderings, the fixture devices (the remote identity `remote <remote@fixture>`).

**Phase 5 closed on 2026-10-26.** The four compositions run every suite in both engines (`pnpm conformance`, 32/32
cells, interop live in every pairing); `OMGBASE_FAULT` injects at five sites with the acceptance outcomes pinned;
`scripts/qualify/migrate-copy.mjs` qualified copies of three real workspaces (853, 116 and 1,405 documents —
`baseline.md` §3): migration clean, the one legacy-trivia workspace repaired by the sweep, the Rust binary opening each
result with byte-identical reads, the previous binary refusing it, history off removing 37–48 %. Two production
servers were then upgraded through the engine alone (`docs/modular-core/migration-runbook.md`) and report store 17.4
with history enabled from their first commit. Phase 6 — one alternative strategy through the documented contract — opened with 6a (§6b above): the git-backed
history provider in the TypeScript reference, its Rust twin and 6b remaining.

## 7. Index

- `docs/modular-core/inventory-ts.md` — the TypeScript engine, 170 rows
  (`packages/core/src`).
- `docs/modular-core/inventory-rust.md` — the Rust engine, 195 rows (the ten
  crates), with the TS/Rust comparison in its §5.
- `docs/modular-core/migration-runbook.md` — the plan's §7 migration and
  rollback procedure as an operator runbook over
  `scripts/qualify/migrate-copy.mjs`, with the compatibility matrix.
- `docs/modular-core/baseline.md` — the measurements; the harness is
  `scripts/baseline/modular-core-baseline.mjs` (`--engine rust|ts --docs 200
  --edits 50`), the recorded runs `docs/modular-core/baseline/
  rust-2026-10-25T03-29-38.{json,md}` and `ts-2026-10-25T03-29-46.{json,md}`;
  the real-corpus harness is `scripts/baseline/real-corpus.mjs` (`--source
  <dir> [--embedder <cmd>]`, four compositions plus the git-provider row
  (Phase 6a), numbers only — `baseline.md` §3).
- The plan note, in Brendan's notes: `/projects/omgbase/modular-core-plan.md`
  (§3 names the mechanisms of §3 here; §6 the phases and gates; §10 the
  decisions to pin).
- The workstream: `/workstreams/2026/10/2026-10-24-modular-core-implementation.md`.
