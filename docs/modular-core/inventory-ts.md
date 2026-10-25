# Modular core — Phase 0 inventory, TypeScript reference engine (`packages/core`)

Phase 0 is a no-behaviour-change inventory: every reader and writer of the
HISTORY records (revisions, tree nodes, blobs, commit rows, dispositions,
block_changes, edge intervals, tombstones, checkpoints), the SEMANTIC records
(vectors) and the RECOVERY records (pending materializations, archives) in the
TypeScript engine, each classified by who needs it today and which plan phase
must change it. A sibling document (`inventory-rs.md`) covers the Rust crates
with the same template so the two can be merged.

## 1. Scope and method

**Commit inspected:** `a25a1d501b5a1fb8ced963a68258b8c38248dfa8` (`main`,
`git rev-parse HEAD` on 2026-10-24). Store schema version 16
(`packages/core/src/core/store/schema.ts:5`).

**Spec read first:** `spec/store/schema.sql` (every table), `spec/store/README.md`
§3 (table meanings, 3.1/3.2), §5.4 (the observe commit, steps 0–14 and "the api
path"), §5.6 (tombstone), §5.7 (materialization and the gate rule), §6 (reads:
reconstruct, reconstruct at a revision, through a segment), §7 (rebuild, GC mark,
the `same` sweep, §7.1 retention), §8 (invariants I1–I10).

**How the sources were searched.** Over `packages/core/src` excluding
`*.test.ts`:

1. A whole-word grep per table and per load-bearing column — `revisions`,
   `tree_nodes`, `blobs`, `commits`, `dispositions`, `block_changes`,
   `resurrection_pool`, `checkpoints`, `embeddings`, `doc_embeddings`,
   `pending_materializations`, `archives`, `doc_edges`, `edges`, `to_commit`,
   `from_commit`, `deleted_commit`, `created_commit`, `current_rev`,
   `file_hash`, `rendered_hash`, `root_tree`, `frontmatter_blob` — to get the
   file set, then every `prepare(` / `FROM` / `JOIN` / `INSERT` / `UPDATE` /
   `DELETE` in those files to get the statements.
2. A grep for the module exports that wrap the tables and a read of every
   caller: `putBlob`, `putNodeText`, `writeBlockTree`, `writeFrontmatterBlob`,
   `newCommit`, `previousRevision`, `writeRevision`, `TreeResolver`,
   `currentFrontmatterRaw`, `reconstructContent`, `readDocumentAtRevision`,
   `revisionBody`, `archivePrefix`, `blocksAtRevision`, `historyNode`,
   `changesSince`, `docHistory`, `markReachable`, `explicitWalker`,
   `sweepUnreachable`, `sweepResurrectionPool`, `maintainEdges`,
   `adoptPhantoms`, `rebuildDocEdges`, `readDocBase`, `readPending`,
   `insertPending`, `deletePending`, `priorRenderedHash`, `materializeRow`,
   `makeKnownIdResolver`, `makeReconcilingResolver`, `loadOldMatchBlocks`,
   `loadPool`, `tombstoneObservedDeletion`, `idInUse`/`registerIdOracle`,
   `EmbeddingWorker`, `vectorSearch`, `docVectorSearch`, `buildEmbedTasks`.
3. The MCP tool table (`mcp/server.ts`, every `tool("…")` registration) mapped
   to the library function each tool reaches, so §2 says which tools touch
   which records.
4. Full reads of: `core/ingest.ts`, `core/store/{store,writers,edges,gc,rebuild,
   sections,fts,nodes,properties,delta}.ts`, `core/read/{document,reader,refs,
   nodes,outline}.ts`, `core/ids.ts`, `mutate/{commit,materialize,known-ids,
   load,docs}.ts`, `graph/{history,inbound-links}.ts`, `sync/{tombstone,
   recovery}.ts`; targeted reads (the statements and the functions around them)
   of `core/store/{retention,archive,size,schema}.ts`, `mutate/{apply,plan,
   effects,plan-update,select,sugar,macros,opset}.ts`, `oqx-js/{context,names,
   planner,root-row,run,store-index,sql/translate,sql/scan}.ts`, `search/*.ts`,
   `sync/{observe,checkpoint,admin,reconciling-ingest,freshness}.ts`,
   `graph/{links,link-health}.ts`, `mcp/{server,reference}.ts`.
5. For §4, a `-l` grep of every `*.test.ts` for the same table names and for
   `_updated_at`, `_rev`, `rendered_hash`, `root_tree`, plus a key-walk of
   `spec/store/cases/*.json` and a token count over `spec/surface/cases/
   {reads,query-revisions}.json`, `spec/mutate/cases/{commit,materialize}.json`,
   `spec/sync/cases/checkpoint.json`, `spec/graph/cases/intervals.json`,
   `spec/cli/cases/{history,admin}.json`.

**Not covered.** The Rust crates (`crates/*`, the sibling document); the CLI
package (`packages/omgbase`, which only calls the library functions listed
here — `omg gc`, `omg history …`, `omg doctor --size`, `omg log`, `omg diff`,
`omg hist` reach `runGc`, `exportHistory`/`attachArchive`/`listArchives`/
`evaluateRetention`, `sizeReport`, `changesSince`, `docDiffUnified`,
`historyNode`); `@omgbase/sync` (`packages/sync`) beyond what it consumes of
this engine's feed (§3.8); `@omgbase/oqx` (the language; its `revisions` root
is only a name there); `reconcile/eval/*` (benchmark generator/metrics);
`format/*` (parsers and adapters: no store access — the `edges` they mention
are `AdapterEdge` descriptors, resolved and persisted by `core/store/edges.ts`
and the two id resolvers). `core/hash.ts` is pure (`serializeTreeEntries`,
`treeHash` encode the §4.1 tree entry and are called only from `writers.ts`
and `delta.ts`), listed once as the encoding owner.

Vocabulary used below: **current-state** = the `docs`/`blocks`/`properties`/
`nodes`/`sections`/open `edges`/`doc_edges`/FTS rows and the paths that read or
write them (query, read, mutate, CAS, observe/reconcile, materialize/recover);
**history** = `revisions`, `tree_nodes`, `blobs` beyond the current content,
`commits`, `dispositions`, `block_changes`, closed edge intervals,
`resurrection_pool`, `archives`. `class` is one of current-state / archival /
semantic / both / test-only; `phase` is 3 (current-state independence from
history), 4 (extract capture), 2 (extract semantic), or none (archival-only
code that moves behind the recorder interface unchanged). For a **both** row
the phase given is the one that has to act first (3 when a current-state path
reads what the row writes).

## 2. The matrix

### 2.1 `core/ingest.ts` — the observe/api commit (spec/store §5.4)

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `core/ingest.ts:ingestFile` (221–231) | commits | write | one `commits` row per observed member via `newCommit`, then `ingestInto` under it, one transaction | both | 3 |
| `core/ingest.ts:ingestInto` (276–299) | docs.deleted_commit | read/write | doc-row upsert; a revived tombstone clears `deleted_commit = NULL` (§5.6 re-creation); the value is a `commits` id | current-state | 3 |
| `core/ingest.ts:ingestInto` (315–322) | revisions, tree_nodes, blobs | read | `previousRevision` (greatest `seq`, incl. `archive`) + `TreeResolver.tree` resolve the base tree for delta encoding (§5.4 step 0, 16.0) | archival | 4 |
| `core/ingest.ts:ingestInto` (323) → `writers.writeBlockTree` | tree_nodes | write | Merkle root for the body (full or `{"d":…}` delta) → `revisions.root_tree` | archival | 4 |
| `core/ingest.ts:ingestInto` (323) → `writers.writeList` → `putBlob` | blobs | write | every block `raw` and non-empty `trivia` blob — the bytes `blocks.raw_hash`/`trivia_hash` point at | both | 3 |
| `core/ingest.ts:ingestInto` (329–332) | blobs, revisions.frontmatter_blob (+ `TreeResolver.frontmatter` read of the previous revision) | read/write | the frontmatter block's raw (or a `{"f":…}` line delta) as a blob; the ONLY place the current frontmatter bytes are stored — there is no `blocks` row for frontmatter | both | 3 |
| `core/ingest.ts:ingestInto` (334–343) → `writers.writeRevision` | revisions | write | `(rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id)`; `docs.current_rev` will point here | both | 3 |
| `core/ingest.ts:ingestInto` (347–354) | resurrection_pool, blocks | write/read | `INSERT OR REPLACE` the doc's `blocks` row of every id in `deleted` with `deleted_commit = this`, `expires_ts = ts + 30d` (§5.4 step 7) | current-state | 3 |
| `core/ingest.ts:evictForeignBlockRows` (534–546) | blocks, resurrection_pool, blocks_fts | read/delete | cross-doc move / resurrection: drop another doc's row for the id (FTS first) and its pool row (§5.4 step 8) | current-state | 3 |
| `core/ingest.ts:ingestInto` (366–381) | blocks.created_commit (+ blocks_fts) | write | wholesale refresh of the doc's `blocks`; every row's `created_commit = commitId` | current-state | 3 |
| `core/ingest.ts:ingestInto` (382–456) | sections, nodes, nodes_fts, properties.created_commit | write | derived tables + property rows under `commitId` (`writeDocProperties`) | current-state | 3 |
| `core/ingest.ts:ingestInto` (460–463) → `edges.maintainEdges` | edges.from_commit / to_commit, doc_edges | write | interval maintenance: open `from_commit = this`, close `to_commit = this`, never delete (§9c) | current-state | 3 |
| `core/ingest.ts:ingestInto` (467–488), `persistsDisposition` (38–40) | dispositions, block_changes | write | `INSERT OR IGNORE` every non-`same` verdict into both tables (§5.4 step 10, 14.2); without a resolver every block is `inserted` | both | 3 |
| `core/ingest.ts:ingestInto` (491–493) | resurrection_pool | delete | consume the pool rows the reconcile resurrected (§5.4 step 11) | current-state | 3 |
| `core/ingest.ts:ingestInto` (497–502) | docs.current_rev, docs.file_hash, docs.conflicted | write | the current head pointer (a `revisions` FK by convention, no declared FK) + convergence hash (§5.4 step 12/14) | both | 3 |
| `core/ingest.ts:ingestInto` (511–515) → `reconstructContent` | blobs, revisions (via `currentFrontmatterRaw`) | read | the convergence check reloads the doc from rows (§5.4 step 13) | current-state | 3 |

### 2.2 `core/store/*` — writers, store, schema, delta, gc, rebuild, edges, retention, archive, size

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `core/store/writers.ts:putBlob` (40–49) | blobs | write | content-addressed `INSERT OR IGNORE` of a text (raw, trivia, frontmatter raw or delta) | both | 3 |
| `core/store/writers.ts:putNodeText` / `putTreeNode` (52–61) | tree_nodes | write | content-addressed node text (`[`-form or `{"d":…}`) | archival | 4 |
| `core/store/writers.ts:writeList` (92–107) | tree_nodes (write), blobs (write via `putBlob`), base `ResolvedTree` (read) | write | per sibling list: reuse the base's hash when unchanged and self-contained, else the smaller of delta/full (§4.4) | both | 3 |
| `core/store/writers.ts:isCheckpointRevision` (75–77) | revisions.archive (of `previous`) | read | checkpoint rule: cadence, no predecessor, or predecessor archived | archival | 4 |
| `core/store/writers.ts:writeFrontmatterBlob` (121–125) | blobs | write | raw at a checkpoint / no base, else the smaller of line-delta and raw | both | 3 |
| `core/store/writers.ts:newCommit` (138–158) | commits | read/write | `seq = 1 + MAX(seq)` per repo; insert `(commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops)` | both | 3 |
| `core/store/writers.ts:previousRevision` (172–176) | revisions | read | the doc's greatest-`seq` revision (`rev_id, seq, root_tree, frontmatter_blob, archive`) | archival | 4 |
| `core/store/writers.ts:writeRevision` (179–197) | revisions | read/write | `seq` (given or `1 + MAX(seq)` per doc), insert the row | both | 3 |
| `core/store/store.ts:ID_TABLES` + `Store.idInUse` (22–33, 61–72) | docs, blocks, block_changes, resurrection_pool, commits, revisions, external_nodes, edges, checkpoints, repos, sources, archives | read | the spec/store §2.1 mint oracle: `SELECT 1 FROM <table> WHERE <id col> = ?` per prefix — a `b` id is in use if it names a `blocks`, `block_changes` OR `resurrection_pool` row | both | 3 |
| `core/store/store.ts:Store` constructor (50–57) | embeddings/doc_embeddings vec blobs | schema | registers the `cosine(vec, vec)` SQL function OQX `semantic()` uses | semantic | 2 |
| `core/store/store.ts:Store.migrate` (74–108), `migrateV15` (210–243) | revisions (rebuild: nullable bodies, `archive`), archives | schema | forward migrations; v15 rebuilds `revisions` with FKs off because `pending_materializations.rev_id` references it; v16 is data-free | archival | 4 |
| `core/store/schema.ts:DDL` (218–445) | every table | schema | the embedded `schema.sql` (byte-equal to `spec/store/schema.sql`): history, current-state, semantic and sync tables in one DDL | both | 4 |
| `core/store/schema.ts:DOC_EMBEDDINGS_DDL` (135) | doc_embeddings | schema | the doc-vector table (also inside `DDL`) | semantic | 2 |
| `core/store/schema.ts:PENDING_MATERIALIZATIONS_DDL` (158) | pending_materializations | schema | the recovery-intent table; `rev_id REFERENCES revisions`, `commit_id REFERENCES commits` (declared FKs) | current-state | 3 |
| `core/store/schema.ts:ARCHIVES_DDL` (183) | archives | schema | segment registry | archival | none |
| `core/store/delta.ts:TreeResolver` (325–446) | tree_nodes (334), revisions (335: `root_tree, frontmatter_blob, archive … WHERE doc_id = ? AND seq = ?`), blobs (336) | read | resolve a `{`-form node/frontmatter in `(doc, seq)` context by walking `seq − 1` back to a checkpoint (≤ 15 steps); memoized per instance; `prefix` for a segment alias | both | 3 |
| `core/store/delta.ts:TreeResolver.checkpointForm` (454–470), `explicitEntries`, `parseNodeText`, `encodeDelta` | (pure) | — | encodings for the squash and the explicit GC mark | archival | none |
| `core/store/gc.ts:markReachable` (28–40) | revisions (`DISTINCT frontmatter_blob`, `DISTINCT root_tree` WHERE NOT NULL), tree_nodes | read | the mark: from LIVE revisions only; the `blocks` rows are not consulted (I3 makes them redundant today) | both | 3 |
| `core/store/gc.ts:explicitWalker` (50–67) | tree_nodes | read | the explicit walk (`[`-entries, `+`/`~` entries of a `{`-node) | archival | none |
| `core/store/gc.ts:sweepUnreachable` (74–89) | tree_nodes, blobs | delete | delete every row the mark did not reach; called by `runGc` and the retention squash | both | 3 |
| `core/store/gc.ts:countSameDispositions` (92–94), `runGc` (111–125) | dispositions, block_changes | read/delete | the 14.2 `same` sweep (flag-gated, dry-run aware) | archival | none |
| `core/store/gc.ts:sweepResurrectionPool` (129–132) | resurrection_pool | delete | `DELETE … WHERE expires_ts <= ?` — the one routine collection | current-state | 3 |
| `core/store/rebuild.ts:ARCHIVED_COMMITS_SQL` (16–17) | commits, revisions | read | commits whose every revision is archived | archival | none |
| `core/store/rebuild.ts:rebuildIndex` (39–50) | block_changes, dispositions | delete/write | re-derive `block_changes` from `dispositions` for non-archived commits (I8) | archival | none |
| `core/store/rebuild.ts:rebuildIndex` (27–30) → `rebuildDocEdges` | edges (open), doc_edges | read/write | roll up the open edges per live doc | current-state | 3 |
| `core/store/rebuild.ts:rebuildIndex` (21–37) | docs/blocks.deleted_commit, sections, blocks_fts | read/write | sections + FTS from live rows only | current-state | none |
| `core/store/edges.ts:maintainEdges` (31–71) | edges.to_commit / from_commit, doc_edges | read/write | diff the extracted set against `WHERE src_doc = ? AND to_commit IS NULL`; insert new with `from_commit`, `UPDATE … SET to_commit` for the rest (and for duplicate open rows) | current-state | 3 |
| `core/store/edges.ts:adoptPhantoms` (76–83) | edges (open) | read/write | re-point `phantom:<path>` destinations at the real doc when it becomes live | current-state | 3 |
| `core/store/edges.ts:rebuildDocEdges` (86–103) | edges (open), doc_edges | read/delete/write | the per-doc rollup, `WHERE to_commit IS NULL` | current-state | 3 |
| `core/store/edges.ts:resolveExternal` / `resolveDocPath` (106–125) | external_nodes, docs.deleted_commit | read/write | mint `x` ids; phantom ids for unknown paths | current-state | none |
| `core/store/properties.ts:writeDocProperties` (208–229) | properties.created_commit | delete/write | delete the doc's rows and insert the new ones with `created_commit = commitId`; `deleted_commit` is never set | current-state | 3 |
| `core/store/properties.ts:docPropertiesMerged` / `docPropertiesGrouped` (169–203) | properties.deleted_commit | read | `WHERE deleted_commit IS NULL` filter (always true, see §5) | current-state | none |
| `core/store/sections.ts:rebuildSections` (15–50), `fts.ts:LIVE_LEAF_SQL`/`ftsDeleteDoc`/`ftsIndexDoc`/`ftsBeforeEvictRows` (28–109), `nodes.ts:projectSectionNodes` (18–36) | blocks.deleted_commit | read | live-row predicates for the derived tables | current-state | none |
| `core/store/retention.ts:effectiveSettings` / `retentionPolicy` (149–175) | workspace_settings, repos.settings | read | `history.retention` policy | archival | none |
| `core/store/retention.ts:ReachMarker` (292–335) | tree_nodes, blobs | read | sizes + explicit mark for costing | archival | none |
| `core/store/retention.ts:evaluateRetention` (353–466) | docs.current_rev, revisions JOIN commits (`ts, origin, reason, archive`), pending_materializations.rev_id (369: pinned revisions), revisions (`archive IS NULL`) | read | the plan: keep rules 1–7 per doc, cost the archive set | archival | none |
| `core/store/archive.ts:ARCHIVE_DDL` (40–118) | segment: manifest, revisions, commits, blobs, tree_nodes, dispositions, block_changes | schema | `spec/store/archive.sql` embedded | archival | none |
| `core/store/archive.ts:readManifest` / `segmentRevisionIds` (169–192) | segment file | read | manifest + rev ids of a segment | archival | none |
| `core/store/archive.ts:archiveRow`/`recordArchive`/`attachArchive`/`detachArchive`/`listArchives`/`unrecordedSegments` (210–368) | archives, revisions.archive | read/write/delete | the segment registry; `unrecordedSegments` reads `SELECT archive FROM revisions WHERE rev_id = ?` per segment rev | archival | none |
| `core/store/archive.ts:archivePrefix` (398–420) | archives, `ATTACH DATABASE … AS arc_<id>`, `<alias>.manifest` | read | attach a segment on demand (≤ 8 aliases) | archival | none |
| `core/store/archive.ts:revisionBody` (441–455) | revisions (store), `<alias>.revisions` | read | a revision's row with bodies resolved from the store or its segment | both | 3 |
| `core/store/archive.ts:checkpointBodies` (466–482) | tree_nodes, blobs (via resolver) | read | checkpoint form of a live revision | archival | none |
| `core/store/archive.ts:whollyArchivedCommits` (548–566) | revisions | read | commits whose revisions all archive | archival | none |
| `core/store/archive.ts:writeSegment` (593–677) | revisions, commits, dispositions, block_changes, blobs, tree_nodes → segment | read/write | copy bodies (checkpoint form) and rows into a new segment file | archival | none |
| `core/store/archive.ts:squash` (687–726) | revisions (`UPDATE … root_tree = NULL, frontmatter_blob = NULL, archive = ?`), dispositions (delete per wholly-archived commit), block_changes (delete all but each block's EARLIEST row), tree_nodes/blobs (via `sweepUnreachable`), archives, repos.settings | write/delete | the squash transaction; keeps a block's earliest `block_changes` row **for the mint oracle** (703–709) | archival | none |
| `core/store/archive.ts:checkpointDependents` (735–760) | revisions (read/update), tree_nodes, blobs (write) | write | re-checkpoint the kept successor of an archived base (§4.4 base liveness) | archival | none |
| `core/store/archive.ts:exportHistory` (767–800), `archivedSummary` (804–810) | revisions.archive, archives | read | `omg history export`/`list` | archival | none |
| `core/store/size.ts:categoryOf` (32–56) | (classification) | read | labels `blobs, tree_nodes, revisions, commits, dispositions, block_changes, resurrection_pool, pending_materializations, archives` as "history" and `checkpoints` as "sync" (§5) | archival | none |
| `core/store/size.ts:sizeReport` (215–310) | every table (counts, dbstat), dispositions (`kind = 'same'`), `evaluateRetention` | read | `omg doctor --size` | archival | none |

### 2.3 `core/read/*`, `core/ids.ts` — the reads

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `core/read/document.ts:currentFrontmatterRaw` (91–97) | revisions (`doc_id, seq, frontmatter_blob WHERE rev_id = ?`), blobs, previous revisions via `TreeResolver.frontmatter` | read | the CURRENT frontmatter bytes — read through the current revision row and resolved through up to 15 earlier revisions when stored as a delta | current-state | 3 |
| `core/read/document.ts:reconstructContent` (104–136) | docs.current_rev, blobs (`raw_hash`, `trivia_hash` of live top-level blocks) | read | §6.1 reconstruct — `docs_read._raw`, `_raw` in OQX, the ingest convergence check | current-state | 3 |
| `core/read/document.ts:docsRead` (154–187) | docs.current_rev (`rev`), blobs | read | the whole-document read; exposes `rev: info.currentRev` as the `_rev` token | current-state | 3 |
| `core/read/document.ts:docsReadMany` (225–269) | as `docsRead` | read | batch form (`docs_read_many`) | current-state | 3 |
| `core/read/document.ts:readDocumentAtRevision` (318–368) | revisions (via `revisionBody`), tree_nodes + blobs (store or segment via `TreeResolver`), docs.leading_trivia/frontmatter_trivia | read | §6.2 reconstruct at a revision; current doc-level trivia (not versioned) → `renderedHashMatch`; used by `docs_read { at }`, `docs_diff_unified`, AND `materializeRow` | both | 3 |
| `core/read/reader.ts:liveDocRows` (51–76) | revisions JOIN commits (`c.ts WHERE r.rev_id = d.current_rev`), blocks.deleted_commit | read | `_updated_at` of every row of `docs_list` / `docs_tree` (`omg ls`) | current-state | 3 |
| `core/read/reader.ts:loadDocBlocks` (296–319) | blocks.deleted_commit | read | live containment forest | current-state | none |
| `core/read/reader.ts:blockRaw` (322–327) | blobs | read | a block's raw by `raw_hash` (`blocks_read` raw/full) | current-state | 3 |
| `core/read/reader.ts:findDoc` / `findDocByRef` (339–374) | docs.current_rev, deleted_commit | read | `DocInfo.currentRev` — the `rev`/`_rev` the surface returns and `plan-update` pins | current-state | 3 |
| `core/read/nodes.ts:project` (35–65) → `blockRaw` | blobs | read | `_raw`/`_hash` at `raw`/`full` resolution | current-state | 3 |
| `core/read/nodes.ts:nodesGetMany` (110–159), `refs.ts:resolveRef` (30–64), `outline.ts:docsOutline` (60–92) | blocks.deleted_commit, nodes | read | live-block lookups | current-state | none |
| `core/ids.ts:mintId` / `inUse` (147–172) | (via oracle) blocks, block_changes, resurrection_pool, commits, revisions, … | read | redraw while the id is issued-in-process or reported in use by an open store | both | 3 |
| `core/hash.ts:serializeTreeEntries` / `treeHash` (216–231) | (encoding of tree_nodes.entries) | — | §4.1 entry text; callers: `writers.ts`, `delta.ts` | archival | 4 |

### 2.4 `mutate/*` — plan, CAS, commit, materialize

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `mutate/commit.ts:readDocBase` (75–80) | docs.current_rev, docs.file_hash, deleted_commit | read | the CAS triple `(path, current_rev, file_hash)` every plan freezes and the commit re-validates | current-state | 3 |
| `mutate/commit.ts:commitChangeset` (181–184) | commits (+ full ingest), pending_materializations | write/delete | on a disk conflict: `ingestFile` the human's bytes as `observed`, drop the pending row, throw `sync_conflict` | both | 3 |
| `mutate/commit.ts:runPhases` phase A (219–231) | pending_materializations (read), revisions/tree_nodes/blobs (via `materializeRow`) | read/write(files) | replay an earlier request's intent at every touched path before reading the disk | current-state | 3 |
| `mutate/commit.ts:runPhases` phase C (239–250) → `newCommit` | commits | write | the ONE `api` commit of a request (`actor`, `reason`, `checkpointId`, `ops`) | both | 3 |
| `mutate/commit.ts:runPhases` `ingest_known`/`ingest_reconciled` (257–278) → `ingestInto` | every §2.1 row | write | per-document ingest under the shared commit | both | 3 |
| `mutate/commit.ts:runPhases` `move_path` (279–285) | revisions.rendered_hash (`WHERE rev_id = ?`) | read | the bytes a `rename` row expects at `to` | current-state | 3 |
| `mutate/commit.ts:runPhases` `tombstone` (287–295) | docs LEFT JOIN revisions (`rendered_hash`, `file_hash`) | read | the bytes a `remove` row may unlink | current-state | 3 |
| `mutate/commit.ts:runPhases` (303) → `insertPending` | pending_materializations (`rev_id`, `commit_id`, `rendered_hash`) | write | the recorded file intent (§5.7) | current-state | 3 |
| `mutate/commit.ts:validate` / `checkRow` (395–442) | docs.current_rev, file_hash, path | read | `stale_plan` when the triple moved; `doc_missing`; `path_taken` | current-state | 3 |
| `mutate/commit.ts:movePath` (453–471) | docs.path, revisions.path (`UPDATE … WHERE rev_id = current`), edges (open: re-point to `phantom:<from>`), doc_edges | write | `docs_move`'s row half; rewrites the CURRENT revision's `path` in place | both | 3 |
| `mutate/commit.ts:tombstone` (475–487) | resurrection_pool (when `pool`), blocks.deleted_commit, docs.deleted_commit, blocks_fts | write | api tombstone (`docs_delete`: `pool: false`) | current-state | 3 |
| `mutate/materialize.ts:readPending`/`listPending`/`insertPending`/`deletePending` (60–80) | pending_materializations | read/write/delete | the intent rows | current-state | 3 |
| `mutate/materialize.ts:priorRenderedHash` (85–91) | revisions (self-join `p.seq = r.seq − 1`) | read | the "prior bytes" a materializer may overwrite — the PREVIOUS revision's `rendered_hash` | current-state | 3 |
| `mutate/materialize.ts:renderedBytes` (98–103) → `readDocumentAtRevision` | revisions, tree_nodes, blobs | read | the bytes a `write`/`rename` row materializes: §6.2 reconstruct at `rev_id`, checked against `rendered_hash`; NOT the `blocks` table | current-state | 3 |
| `mutate/materialize.ts:materializeRow` / `materializePending` (120–222) | pending_materializations (+ the two above) | read/delete | the file half; the recovery point of the freshness sweep and `recoverRepo` | current-state | 3 |
| `mutate/known-ids.ts:makeKnownIdResolver` (80–148) | blocks.deleted_commit (`priorRows`), dispositions (produced in memory: `inserted`/`same`/`edited`/`moved`/`edited_moved` with `confidence 1, reason "api"`), `deleted`, `crossDocIds` | read | the intent-path id resolver; `deleted` feeds the pool, `crossDocIds` the eviction, `dispositions` the capture | both | 3 |
| `mutate/load.ts:loadMutDoc` (19–86) | blobs (raw + trivia of every live block), docs.current_rev → `currentFrontmatterRaw` (revisions, blobs, earlier revisions) | read | load a document into the mutation tree — every `apply`/`plan`/`execute`/sugar tool starts here | current-state | 3 |
| `mutate/docs.ts:planInboundRetarget` (85–112) | blocks JOIN blobs (`raw_hash`, `bytes`), blocks.deleted_commit | read | the CAS-pinned `update` per inbound block of a `docs_move` | current-state | 3 |
| `mutate/macros.ts:blockHash`/`blockRaw` (15–21), `links_repair` scan (239–245) | blocks, blobs | read | macro preconditions and the repo-wide raw scan | current-state | 3 |
| `mutate/apply.ts:ChangesetPlanner.ensureDoc` (165–179) | docs.current_rev/file_hash (`readDocBase`), blobs (`loadMutDoc`), blocks.deleted_commit (`priorIds`) | read | load + freeze the triple + the prior id set | current-state | 3 |
| `mutate/apply.ts:ApplyRevision` (75, 348) | (wire) | — | `revisions[]` in the kernel RESULT is `{ _id, _path, _hash }` of the docs written — a name collision with the table, not a read of it | current-state | none |
| `mutate/plan.ts:planEffects` preconditions (224–228) | docs.current_rev (`base_revision`), file_hash (`_hash`) | read | the plan's `preconditions.docs` | current-state | 3 |
| `mutate/plan.ts:executeAdmitted` (491–507) | docs.current_rev/file_hash/path | read | re-check every precondition → `stale_plan` with `fix: replan` | current-state | 3 |
| `mutate/plan.ts:executeAdmitted` head (513–521) | commits.ops | write | the intent record `canonical({ v:1, plan_id, effects, selection?, templates? })` on the `api` commit | archival | 4 |
| `mutate/plan.ts:executeAdmitted` moves/tombstones (560–578) | docs.current_rev | read | `currentRev` on the `move_path`/`tombstone` effects | current-state | 3 |
| `mutate/effects.ts:checkRevision` (859–871), move/remove lowering (1316–1359), `expect` resolution (1441) | docs.current_rev (`readDocBase`) | read | `expect.revision` guard → `stale_plan` | current-state | 3 |
| `mutate/effects.ts` (702, 735, 802–829, 1211) | blocks.deleted_commit, nodes | read | live-block guards and descendant scans | current-state | none |
| `mutate/plan-update.ts:planDocUpdate` (56–114) | docs.current_rev (`info.currentRev` → `precondition.baseRevision`), blobs (`loadMutDoc`), dispositions (in-memory, `dispositionsOf` 125) | read | the whole-document update plan pinned to the current revision | current-state | 3 |
| `mutate/select.ts:parseSelect` (591–592) | (vocabulary) | — | refuses `revisions` as a selector root | archival | none |
| `mutate/select.ts` (859), `mutate/sugar.ts:createdDoc` (207–208), `mutate/opset.ts` (37) | blocks.deleted_commit; receipt `revisions[]`; `_hash = docs.file_hash` | read | live rows; wire shapes | current-state | none |

### 2.5 `graph/*` — history surface and the edge index

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `graph/history.ts:historyNode` (25–39) | block_changes JOIN commits LEFT JOIN dispositions | read | `blocks_history` / `omg hist` | archival | none |
| `graph/history.ts:blocksAtRevision` / `diffBlocks` (59–102) | revisions (`revisionBody`), tree_nodes, blobs (store or segment) | read | `docs_diff` id → raw maps at two revisions | archival | none |
| `graph/history.ts:diffUnified` / `docDiffUnified` (114–149) | revisions (`ORDER BY seq DESC LIMIT 2`), `readDocumentAtRevision`, docs.path | read | `docs_diff_unified` / `omg diff` | archival | none |
| `graph/history.ts:changesSince` (251–287) | commits (`MAX(seq)` head; page `WHERE seq > ?`), revisions (`doc_id, path, rendered_hash WHERE commit_id = ?`), dispositions (`GROUP BY kind`), docs.deleted_commit (deleted paths) | read | the change feed (`changes_since` / `omg log`); its `seq` cursor and `revisions[]._hash` are what `@omgbase/sync` pulls on (§3.8) | both | 3 |
| `graph/history.ts:docHistory` (351–414) | docs.current_rev/deleted_commit, revisions JOIN commits (`archive` → `_archived`) | read | `docs_history` | archival | none |
| `graph/inbound-links.ts:inboundLinksTo` (56–93) | edges (`to_commit IS NULL`), blocks JOIN blobs (raw re-scan) | read | the inbound set a `docs_move`/`links_retarget` rewrites | current-state | 3 |
| `graph/links.ts:docLinks` (36–89) | edges (`to_commit IS NULL`), doc_edges | read | `graph` tool / `omg links` | current-state | 3 |
| `graph/link-health.ts:linksStale` / `linksStaleSummary` (114–150, 219–235) | edges (`to_commit IS NULL`) JOIN docs.deleted_commit | read | `links_stale`, `links_repair` | current-state | 3 |

### 2.6 `oqx-js/*` — the query engine

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `oqx-js/context.ts:REVISION_COLS`/`REVISION_FROM` + `scan("revisions")` (111–112, 165) | revisions JOIN docs JOIN commits (`is_current = (d.current_rev = r.rev_id)`, `archived`) | read | the `revisions` root (surface 4.7) | archival | none |
| `oqx-js/context.ts:docRevisions` / `rel.docs._revisions` (171–172, 364) | revisions JOIN commits | read | a document's `_revisions` relation | archival | none |
| `oqx-js/context.ts:attribute` docs `_updated_at` (520) | revisions JOIN commits (`c.ts WHERE r.rev_id = current_rev`) | read | a document's last-change time | current-state | 3 |
| `oqx-js/context.ts:attribute` docs `_created_at` (526) | revisions JOIN commits (`seq = 1`) | read | when the document was first observed | current-state | 3 |
| `oqx-js/context.ts:attribute` docs `_raw` (528) → `docsRead` | blobs, revisions (frontmatter) | read | the exact bytes | current-state | 3 |
| `oqx-js/context.ts:attribute` blocks `_raw` (546) | blobs | read | a block's bytes | current-state | 3 |
| `oqx-js/context.ts:attribute` blocks `_updated_at` (548) | block_changes JOIN commits (`MAX(c.ts)`) | read | the block's own last change | current-state | 3 |
| `oqx-js/context.ts:attribute` blocks `_created_at` (555) | block_changes JOIN commits (`MIN(c.ts)`) | read | the block's first write | current-state | 3 |
| `oqx-js/context.ts:attribute` revisions (589–602), `identity` (841), `indexFor` (884) | revisions rows | read | `_rev _seq _commit _ts _origin _actor _reason _hash _is_current _archived`; no store index for the scan | archival | none |
| `oqx-js/context.ts` relations `_out_links`/`_in_links` (368–376), link domain fns (704, 718–719) | edges (`to_commit IS NULL`) | read | open edges only — "history is not visible through links" (reference.ts:227) | current-state | 3 |
| `oqx-js/context.ts:blockVector` / `semanticScore` (746–760) | embeddings (`content_hash = raw_hash, ctx_hash, model`), doc_embeddings | read | `semantic("…")` scores | semantic | 2 |
| `oqx-js/names.ts:headSeq` / `repoCache` (91–102) | commits (`MAX(seq)`) | read | the vocabulary cache is keyed on the repo's head commit seq — a history row as the "did the store change?" clock | current-state | 3 |
| `oqx-js/names.ts:authoredKeys` / `present` (123, 129) | (vocabulary) | — | `revisions` is a closed kind | archival | none |
| `oqx-js/sql/translate.ts:attributeSql` docs (160–161) and joined-doc forms (353–355, 377–379) | revisions JOIN commits | read (pushed SQL) | `_updated_at`/`_created_at` predicates pushed into the tier-1 scan | current-state | 3 |
| `oqx-js/sql/translate.ts:ROW_ATTRIBUTES.blocks` (149) vs `attributeSql` (163–167) | block_changes (not pushed) | — | blocks `_updated_at`/`_created_at` are declared pushable but have no SQL case → evaluated in `context.ts` per row (§5) | current-state | 3 |
| `oqx-js/sql/scan.ts` links FROM/guards (22, 41, 57, 68) | edges (`to_commit IS NULL`) | read | the links scan | current-state | 3 |
| `oqx-js/root-row.ts:ROOT_NAMES` (29), `planner.ts` (28–29), `run.ts` (150, 268), `store-index.ts` (69–70) | (vocabulary) | — | `revisions` is a root the planner never plans; edge indexes named | archival | none |

### 2.7 `search/*` — vectors and legacy filters

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `search/embeddings.ts:EmbeddingWorker.getCached` / `process` (125–170) | embeddings | read/write | block vector cache keyed `(content_hash = blocks.raw_hash, ctx_hash, model)` | semantic | 2 |
| `search/embeddings.ts:EmbeddingWorker.getCachedDoc` / `processDocs` (193–298) | doc_embeddings | read/write | one vector per doc keyed `(doc_id, model)`, freshness by `input_hash` | semantic | 2 |
| `search/embeddings.ts:foreignVectorCount` / `pruneForeignVectors` (316–332) | embeddings, doc_embeddings | read/delete | other models' rows | semantic | 2 |
| `search/vector.ts:vectorSearch` / `docVectorSearch` (39–90) | embeddings, doc_embeddings, blocks.raw_hash, docs.deleted_commit | read | brute-force cosine | semantic | 2 |
| `search/tasks.ts:buildEmbedTasks` / `staleEmbedCount` / `buildDocEmbedTasks` (127–215), `makeBlockContextResolver` (65–125) | blocks (`raw_hash`, live), properties, sections, embeddings | read | the drain's task list; stale = no row for the current `(raw_hash, ctx)` | semantic | 2 |
| `search/drain.ts` | (via worker/tasks) | — | drain orchestration | semantic | 2 |
| `search/cel/compile.ts:compile` docs `updated_at` (247), blocks `updated_at` (273), `semantic` (751–752), edges (620, 762–767) | revisions JOIN commits; block_changes JOIN commits; embeddings/doc_embeddings; edges (`to_commit IS NULL`) | read (SQL text) | the CEL filter compiler — **no production importer**: only `FilterInvalid` (parser.ts) and the `SemanticVec` type are imported (`oqx-js/context.ts:24,29`, `run.ts:17–18`); `blocks_search` uses `textSearch` (`mcp/server.ts:891`) | test-only | none |
| `search/text.ts`, `fts-query.ts`, `rrf.ts`, `resolve.ts` | blocks_fts, blocks, docs, sections | read | FTS + RRF over live rows | current-state | none |

### 2.8 `sync/*` — observe, tombstone, checkpoint, recovery, status

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `sync/observe.ts:observeBatch` (116–124, 163–171) | docs.file_hash, deleted_commit | read | the echo gate (§5.1 step 3) | current-state | none |
| `sync/observe.ts:observeBatch` (131–147) | pending_materializations | read/delete | the §5.7 gate: echo of the owed bytes, "gone but owed" → no tombstone, foreign → file wins and the row drops (205–209) | current-state | 3 |
| `sync/observe.ts:observeBatch` (119) → `reconciling-ingest.loadPool` (112–121) | resurrection_pool (`expires_ts > ts`) | read | the pool offered to reconcile phase 6b, once per batch | current-state | 3 |
| `sync/observe.ts:commitPrepared` (253–258) → `ingestFile` | every §2.1 row | write | pass 2 per member, `origin = observed`, `conflicted` flag inside the transaction | both | 3 |
| `sync/observe.ts:observeFile`/`observeMany`/`observeDelete` (300–357) | resurrection_pool (sweep), pending_materializations (gate, 339–346), docs.deleted_commit | delete/read | the convenience entry points sweep once after their batch; `observeDelete` applies the gone-member gate | current-state | 3 |
| `sync/tombstone.ts:tombstoneObservedDeletion` (44–66) | commits (write: `reason = "observed deletion"`), resurrection_pool (snapshot every live block), blocks.deleted_commit, docs.deleted_commit, blocks_fts | write | §5.6 in one transaction; no revision, no dispositions | both | 3 |
| `sync/recovery.ts:recoverRepo` (26–60) | pending_materializations (step 0 via `materializePending` → revisions/tree_nodes/blobs), docs LEFT JOIN revisions (`rendered_hash` vs disk) | read/write(files) | spec/sync §4.3 recovery: replay intent, then re-ingest divergent files | current-state | 3 |
| `sync/checkpoint.ts:finishCheckpoint` (63–94) | checkpoints (write), resurrection_pool (sweep) | write/delete | the checkpoint row + the sweep in ONE transaction | current-state | 3 |
| `sync/admin.ts:reposStatus` (42–66) | docs JOIN revisions (`file_hash IS NOT rendered_hash` → `unconverged`), commits (count), edges (`to_commit IS NULL` count) | read | `repos_status` | current-state | 3 |
| `sync/admin.ts:syncStatus` (95–107) | commits (`MAX(seq)` → `lastCommitSeq`), checkpoints (latest by `ts`) | read | `sync_status` | current-state | 3 |
| `sync/reconciling-ingest.ts:loadOldMatchBlocks` (33–105) | blocks (live), blobs (raw of every block) | read | the OLD tree reconcile matches against — rebuilt from current state, not from the revision's Merkle tree | current-state | 3 |
| `sync/reconciling-ingest.ts:prepareReconcile` / `makeReconcilingResolver` (160–252) | docs (tombstoned rows too, 173), dispositions/deleted/consumedPool/crossDocIds (produced) | read | the observe-path resolver: `assignment` and `deleted` are current-state, `dispositions` (kind, confidence, reason, matcher_v, detail) are the capture payload | both | 3 |
| `sync/freshness.ts` (93–259), `sync/git-heuristics.ts`, `sync/stat-cache.ts` | file_stats, docs.file_hash, docs.conflicted | read/write | disk-drift scan and stat cache; "the convergence signal remains docs.file_hash" | current-state | none |
| `sync/driver.ts`, `watcher.ts`, `external-source.ts`, `attach.ts`, `workspace.ts`, `plugin.ts`, `sources.ts`, `settings.ts`, `watch-lease.ts`, `writer-lock.ts`, `fs-util.ts` | adapters, sources, attachments, sync_state, workspace_settings, repos.settings (no history table) | read/write | the sync registry; their commits go through `observeBatch`/`tombstoneObservedDeletion`/`finishCheckpoint` | current-state | none |

### 2.9 `reconcile/*`, `mcp/*`, misc

| file:function | touches | mode | purpose | class | phase |
| --- | --- | --- | --- | --- | --- |
| `reconcile/{reconcile,phases,phase5,phase6a,crossdoc,flatten,types}.ts` | (none — pure; the only hit is a comment at `crossdoc.ts:8`) | — | the matcher over `MatchBlock`s and `ResurrectionCandidate`s; returns `assignment`, `deleted`, `consumedPool` (current-state) and `dispositions` (capture) in one `DocReconcileResult` | both | 4 |
| `reconcile/eval/{generator,metrics}.ts` | (none) | — | benchmark harness | test-only | none |
| `mcp/server.ts` `docs_read` (573–609) → `docsRead` / `docsReadAt` (385–389) | blobs, revisions (current frontmatter; `at` → full §6.2) | read | `at` is the time-travel form | both | 3 |
| `mcp/server.ts` `docs_read_many` (612), `blocks_read` (638), `nodes_block_read` (664), `blocks_read_many` (688) | blobs (+ revisions for frontmatter) | read | reads | current-state | 3 |
| `mcp/server.ts` `docs_tree` (714), `docs_list` (755) → `liveDocRows` | revisions JOIN commits (`_updated_at`) | read | orientation reads | current-state | 3 |
| `mcp/server.ts` `query` (815), `graph` (855), `blocks_resolve` (899) | per §2.6/§2.7; `semantic` gate (515–540: `EXISTS doc_embeddings … OR EXISTS embeddings WHERE model = ?`) | read | the semantic gate is `semantic / 2`; the rest per the OQX rows | current-state | 3 |
| `mcp/server.ts` `blocks_search` (883) → `textSearch` | blocks_fts | read | FTS only | current-state | none |
| `mcp/server.ts` `apply` (924), `plan` (960), `execute` (995), `blocks_*`/`nodes_set`/`docs_append`/`blocks_append`/`links_*`/`docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`/`docs_update` (1041–1456) | §2.4 (`readDocBase`, `loadMutDoc`, `commitChangeset`, `insertPending`) | read/write | every write tool ends in `runPhases` | both | 3 |
| `mcp/server.ts` `observe` (1476), `observe_many` (1493), `observe_delete` (1510) | §2.8 | write | sync ingest (observed origin) | both | 3 |
| `mcp/server.ts` `blocks_history` (1527), `docs_diff` (1542), `docs_diff_unified` (1563), `docs_read_at` (1585), `docs_history` (1603) | block_changes, dispositions, commits, revisions, tree_nodes, blobs | read | the history tools | archival | none |
| `mcp/server.ts` `changes_since` (1645) → `changesSince` | commits, revisions, dispositions, docs.deleted_commit | read | the feed (both: sync base) | both | 3 |
| `mcp/server.ts` `repos_status` (1671), `sync_status` (1686) | revisions, commits, checkpoints, edges | read | §2.8 admin rows | current-state | 3 |
| `mcp/server.ts:docOfBlock` (392–396) | blocks.deleted_commit | read | live-block guard | current-state | none |
| `mcp/reference.ts` (138–143, 178–179, 227–258, 541–543, 621–644) | (documentation of `revisions`, `_revisions`, `_updated_at`, `_created_at`, "no from_commit: a query sees open edges only") | — | the `query_syntax` card and manual — must be re-worded wherever a Phase 3 replacement changes a value's source | both | 3 |
| `surface-paths.ts` (33–120), `index.ts` (109–118), `version.ts` | (wire shapes: `revisions[]._path` rooting; re-exports) | — | no table access | current-state | none |

**Counts.** 170 rows. By class: current-state 85, both 34, archival 40, semantic 9, test-only 2 (the reconcile eval harness and the dead CEL compiler). By phase: 3 = 101, 4 = 10, 2 = 9, none = 50. (A row that lists several tables is counted once; the current-state rows that touch no history table — live-row predicates, FTS, the sync registry — are included so the file coverage is complete, and are the `none`-phase part of the current-state count.)

## 3. Current-state dependencies on history

Every row above classed current-state or both that touches a history table,
grouped by the dependency, with the plan §3 replacement.

### 3.1 The current head pointer and the `_rev` token — `docs.current_rev` → `revisions`

`docs.current_rev` is a `revisions.rev_id` by convention (no declared FK,
`spec/store/schema.sql:17`). It is written by `ingestInto` (`core/ingest.ts:499,501`),
rewritten in place by `movePath` (`mutate/commit.ts:455` updates the current
revision's `path`), read as the CAS token by `readDocBase`
(`mutate/commit.ts:76`) and through it by `validate` (401–412), `executeAdmitted`
(`mutate/plan.ts:494–503`), `checkRevision` (`mutate/effects.ts:863–871`), the
plan's `preconditions.docs[].base_revision` (`mutate/plan.ts:226–228`),
`plan-update`'s `baseRevision` (`mutate/plan-update.ts:114`), and surfaced as
`rev` by `docsRead` (`core/read/document.ts:164`) and `findDoc`
(`core/read/reader.ts:353`). What breaks without `revisions`: nothing in the CAS
itself — the triple only compares the opaque string — but the string has to be
minted by something, and today that is `writeRevision`. **Replacement (plan §3
"current heads/content"):** a current-head token owned by the current-state
layer (a per-document monotonic version or content hash), with `revisions.rev_id`
equal to it when capture is on so `_rev` keeps meaning "the revision" for
`docs_read { at }`.

### 3.2 The current frontmatter bytes live only in history — `revisions.frontmatter_blob` + `TreeResolver`

There is no `blocks` row for the frontmatter block. Its raw is stored once, as
the blob named by `revisions.frontmatter_blob` (`core/ingest.ts:329–332`,
`writers.ts:121–125`), and since 16.0 that blob may be a `{"f":…}` line delta
over the previous revision's raw, so reading the CURRENT frontmatter means
`currentFrontmatterRaw` (`core/read/document.ts:91–97`) → `TreeResolver.
frontmatter` (`delta.ts:427–446`) → `revStmt` on `(doc_id, seq − 1)` repeatedly,
up to 15 earlier revisions, each a `blobs` read. Callers on the hot path:
`reconstructContent` (113) → `docsRead` / `docs_read_many` / OQX `_raw` /
`@omgbase/sync`'s content pull (`packages/sync/src/engine-client.ts:80`), the
ingest convergence check (`core/ingest.ts:515`), and `loadMutDoc`
(`mutate/load.ts:74`) — i.e. every `apply`/`plan`/`execute`/sugar write and every
`docs_set_meta`. Without `revisions`/`tree_nodes`-style history the frontmatter
of every document is unreadable. **Replacement (plan §3 "current
heads/content"):** store the frontmatter raw (and its hash) on the current state
— a `blocks` row of type `frontmatter`, or a `docs.frontmatter_hash` → `blobs` —
written by the current-state ingest; the recorder may still write the delta.
`spec/store` §6.1 ("only the frontmatter resolves") and I3 ("the live blocks …
of the current revision's resolved tree", body blocks only) both have to move.

### 3.3 Block bytes — `blobs` reached through `blocks.raw_hash`/`trivia_hash`

The current content IS in `blobs`: `reconstructContent` (`document.ts:123–134`),
`blockRaw` (`reader.ts:322–327`), `loadMutDoc` (`load.ts:33–46`),
`loadOldMatchBlocks` (`reconciling-ingest.ts:64–67`), `planInboundRetarget`
(`docs.ts:99`), `macros.ts:19–20, 239–244`, `inboundLinksTo`
(`inbound-links.ts:76`), OQX `_raw` (`context.ts:546`). Writes come from
`writeList` → `putBlob` (`writers.ts:94–95`) inside the TREE writer, so the raw
blobs are written as a side effect of writing history. **Reachability today:**
the GC mark (`gc.ts:28–40`) walks `revisions.root_tree` / `frontmatter_blob`
only; a blob referenced by a live `blocks` row is kept only because I3
guarantees the current revision's resolved tree names the same `raw_hash`/
`trivia_hash`. Blobs reachable from current state alone = every `raw_hash` and
non-NULL `trivia_hash` of a live `blocks` row + the current frontmatter raw (or
the blobs its delta chain resolves through); blobs reachable only from history =
everything else the mark reaches (older revisions' raws/trivias, every delta
frontmatter blob, every `blobs` row a tombstoned document's last revision still
names — its `blocks` rows are kept with `deleted_commit` set, so those are ALSO
current-state-reachable today). **Replacement (plan §3 "current content"):**
the current-state ingest puts raw/trivia blobs itself (`putBlob` moves out of
`writeList`) and the mark gains a current-state root (`blocks` live + tombstoned
rows, the frontmatter) so GC is correct with capture off; `spec/store` §7
("mark-and-sweep from every live revision's root_tree") and I5 change.

### 3.4 `_updated_at` / `_created_at` — `revisions` × `commits` and `block_changes` × `commits`

Document `_updated_at` is `commits.ts` of `current_rev`'s commit: `liveDocRows`
(`reader.ts:66`, every `docs_list`/`docs_tree` row), OQX `context.ts:520`,
pushed SQL `translate.ts:160, 354, 378`. Document `_created_at` is the `seq = 1`
revision's commit ts (`context.ts:526`, `translate.ts:161, 355, 379`). Block
`_updated_at`/`_created_at` are `MAX`/`MIN(commits.ts)` over the block's
`block_changes` (`context.ts:548, 555`) — which is why `same` verdicts stopped
being persisted (14.2): the table's contents define the value. What breaks:
every `docs_list`/`docs_tree` row (`_updated_at` is unconditional in
`liveDocRows`), four OQX attributes, three pushed predicates, the
`query-dates` fixtures. **Replacement (plan §3 "explicit creation/change
metadata"):** `docs.created_at`/`updated_at` and `blocks.created_at`/
`updated_at` columns written by the current-state ingest (the block value set
only when the block's own verdict is not `same`, preserving 14.2's semantics),
with the recorder free to derive the same from its tables. A design decision is
needed on `blocks.created_at` for a resurrected/moved-across-docs block (today:
the earliest `block_changes` row survives the pool and the squash — `archive.ts:
703–709` — so creation is the original mint; a column would have to be carried
by the eviction/resurrection path).

### 3.5 Identity claims — the mint oracle over `block_changes`, `resurrection_pool`, `commits`, `revisions`

`Store.idInUse` (`store.ts:22–33, 61–72`) answers "is this id in use" for a `b`
by `blocks` OR `block_changes` OR `resurrection_pool`, for `c` by `commits`, for
`r` by `revisions`, for `s` by `archives`, for `cp` by `checkpoints`. `mintId`
(`ids.ts:159–172`) redraws on a hit. The squash deliberately keeps each block's
earliest `block_changes` row so an archived block's id stays claimed
(`archive.ts:703–709`, `rebuild.ts:42–46`). What breaks without history
tables: a `b` id of a block deleted long ago (no `blocks` row, pool expired)
could be re-minted — a collision with the block's history, with external
references, and with another engine's capture. **Replacement (plan §3 "identity
claims"):** an explicit claims table (`id_claims(prefix, id)` or a per-prefix
bloom/exact set) written at mint time by the current-state layer and never
pruned, replacing the three-table union; `commits`/`revisions` prefixes become
the recorder's own claims. `spec/store` §2.1 "Uniqueness at mint" names the
tables and has to move.

### 3.6 The pool — `resurrection_pool`

Written on delete (`ingest.ts:347–354`, `commit.ts:476–483` with `pool: true`,
`tombstone.ts:52–56`), evicted (`ingest.ts:537, 545`), consumed (`ingest.ts:
491–493`), read for reconcile (`reconciling-ingest.ts:112–121`), swept
(`gc.ts:129–132`, called from `observe.ts:303, 318, 355` and `checkpoint.ts:91`).
Each row names a `deleted_commit` (I6) and copies `raw_hash`/`norm_hash`/`type`
from `blocks`. It is a current-state identity mechanism (reconcile phase 6b),
not history, but `size.ts:38` files it under "history" and the plan's list
calls it "tombstones". What breaks without it: delete→recreate loses block ids
(every re-created file re-mints; cross-batch moves become `deleted` +
`inserted`). **Replacement (plan §3 "identity claims"):** keep it in the
current-state layer; replace `deleted_commit` by the change token of §3.4/§3.9
(the only history it names) and drop the 30-day expiry's dependence on
`commits.ts` (I6 "exactly 30 days after that commit's `ts`").

### 3.7 Recovery payloads — `pending_materializations` → `revisions`, `tree_nodes`, `blobs`, previous revision

A pending row is `(path, kind, from_path, doc_id, rev_id, rendered_hash,
commit_id)` with declared FKs to `revisions` and `commits`
(`spec/store/schema.sql:153–163`, the FKs at 159 and 161). `renderedBytes` (`materialize.ts:98–103`) renders the file by
`readDocumentAtRevision` — §6.2 from the revision's Merkle tree, NOT from
`blocks` — and `priorRenderedHash` (`materialize.ts:85–91`) needs the PREVIOUS
revision's `rendered_hash` (a `revisions` self-join on `seq − 1`) to recognise
the engine's own stale bytes; `runPhases` reads `revisions.rendered_hash` for a
`rename` row (`commit.ts:283`) and `docs LEFT JOIN revisions` for a `remove` row
(291). `recoverRepo` (`recovery.ts:29–35`) compares disk to
`revisions.rendered_hash` of `current_rev`. `evaluateRetention` pins a pending
row's `rev_id` so the squash never archives the bodies a materializer still
needs (`retention.ts:368–370`). What breaks: crash recovery and the per-request
replay (phase A) cannot render or recognise files. **Replacement (plan §3
"self-contained recovery payloads"):** the row carries what it needs — the
rendered bytes (or a `blobs` hash of the whole rendered file) and the prior
file hash — and `renderedBytes` renders from current state (`reconstructContent`
is byte-exact for the current revision, which a pending row always names per
§5.7). `docs.file_hash` already holds the current rendered hash, so `recoverRepo`
and `reposStatus.unconverged` (`admin.ts:45–48`, `file_hash IS NOT
rendered_hash`) can compare against it; the `unconverged` metric then needs a
different definition (it is `file_hash ≠ rendered_hash`, which I1 says is never
true — see §5).

### 3.8 The feed and the sync base — `commits.seq`, `revisions.rendered_hash`, `dispositions`

`changesSince` (`history.ts:251–287`) pages `commits` by `seq`, lists each
commit's `revisions` as `{ _id, _path, _hash = rendered_hash }`, counts
`dispositions` by kind for the summary, and reads `docs.deleted_commit` for
deletions. `@omgbase/sync` polls it (`packages/sync/src/coordinator.ts:86–91`,
`engine-client.ts:41–65`, `mcp-engine-client.ts:83`) and uses the `seq` cursor
as its sync base and `_hash` to tell change from echo (ADR-014 §4.2);
`syncStatus.lastCommitSeq` and `reposStatus.commits` (`admin.ts:63, 96`) and
the OQX vocabulary cache key (`names.ts:91–102`) also read `MAX(commits.seq)`.
`reference.ts:231–249` documents `revisions` as "history as rows". What breaks:
the mirror/coordinator has no cursor, no change detection; the vocabulary cache
never invalidates. **Replacement (plan §3 "feed sequence separate from archive
retention"):** a current-state change log / sequence (per repo, dense, with the
touched doc ids and their current hashes, deletions and moves) written by the
current-state commit and bounded by its own retention, from which the recorder
builds `commits`; `changes_since`'s `summary` disposition counts become
optional (they are "unpinned by spec/surface", `history.ts:446`).

### 3.9 Change identifiers on current rows — `created_commit`, `deleted_commit`, `from_commit`/`to_commit`

`blocks.created_commit` (`ingest.ts:379`), `properties.created_commit`
(`properties.ts:224`), `docs.deleted_commit` and `blocks.deleted_commit`
(`ingest.ts:294`, `commit.ts:485–486`, `tombstone.ts:61–62`), `edges.from_commit`
/`to_commit` (`edges.ts:49–50, 62`, `commit.ts:461–462`) all name a `commits`
row; `resurrection_pool.deleted_commit` too (§3.6). Readers filter on NULL-ness
only (`deleted_commit IS NULL`, `to_commit IS NULL` — 40+ sites) except
`changesSince` (`history.ts:278`, deleted paths of a commit) and the spec
fixtures, which project the values. Edge maintenance CLOSES intervals rather
than deleting (`edges.ts:60–68`), so `edges` is an append-only history table
with an open-row index (`idx_edges_src/dst … WHERE to_commit IS NULL`) and a
temporal index nobody in this engine queries (`idx_edges_temporal`; no reader of
`from_commit` outside `schema.ts`/`reference.ts`). **Replacement (plan §3
"explicit creation/change metadata" and "current edges separate from
transitions"):** a current `edges` table holding open rows only (delete on
close) plus an optional recorder-owned `edge_transitions` (edge, opened_at,
closed_at); `created_commit`/`deleted_commit` become the current-state change
token (or a boolean tombstone + `updated_at`). `spec/graph/cases/intervals.json`
(33 `from_commit`/`to_commit` projections) moves to the recorder suite.

### 3.10 The commit row itself — `newCommit` on every write path

`ingestFile` (`ingest.ts:222`), `runPhases` (`commit.ts:241`),
`tombstoneObservedDeletion` (`tombstone.ts:46`) and the conflict re-ingest
(`commit.ts:182`) all mint a `c` and write `commits` before any current-state
row, because the current rows name it (§3.9) and the feed needs it (§3.8).
`plan.ts:513–521` writes the intent record into `commits.ops`. **Replacement:**
the current-state transaction mints the change token and appends to its own
change log (§3.8); the recorder, when enabled, writes `commits` with the same
id so fixtures that project `commit_id`s keep their values.

### 3.11 `revisions.rendered_hash` as the convergence oracle

`reposStatus.unconverged` (`admin.ts:45–48`), `recoverRepo` (`recovery.ts:
31–35, 48`), `runPhases` (`commit.ts:283, 291`), `materializeRow` via
`priorRenderedHash`. `docs.file_hash` is written with the same value in the
same statement (`ingest.ts:499`), so every current-state read can use
`file_hash` instead; only the PREVIOUS revision's hash (§3.7) has no
current-state home. **Replacement:** `pending_materializations.prior_hash`
written at commit time (the commit phase already passes it: `commit.ts:
324–327`, `fromHex(e.base.fileHash)`).

### 3.12 The `revisions`/`_revisions` OQX root and `docs_read { at }` on `readDocumentAtRevision`

Archival as a feature, but shared code: `readDocumentAtRevision`
(`document.ts:318–368`) and `revisionBody` (`archive.ts:441–455`) serve both
`docs_read { at }`/`docs_diff_unified` and the materializer (§3.7). Once §3.7
renders from current state, these two become archival-only (phase none) — the
split is "the materializer stops calling them", not a change to them.

### 3.13 Needs a design decision

- **Tombstoned documents' rows.** A tombstoned doc keeps its `blocks` rows
  (`deleted_commit` set) and its `docs` row, and the pool/`crossDocIds` logic
  relies on them (`ingest.ts:356–362`, `pool::resurrect-into-another-doc-
  evicts-tombstoned-row`). Are tombstoned block rows current state (they are
  reachable, they claim ids, their blobs must survive GC) or history? The
  current-state layer must keep them if the pool keeps working across a
  delete/recreate; the question is whether the recorder owns the "what was
  there" and the current-state layer only a path tombstone.
- **`docs_read { at }` / `docs_diff` on a current-only store.** The surface
  errors (`target_missing`, `revision_archived`) assume the row exists; a store
  with capture off needs a distinct refusal (`capability_unavailable`?) — a
  `spec/surface` decision.
- **`_rev` identity across engines with capture off.** If the current head
  token is not a minted `r` id, the interop suite's `_rev`/`rev` comparisons
  (spec/surface `reads`, `query-revisions`) need a rule for what the two
  engines must agree on.
- **The `conflicted` flag and `checkpoints`.** `checkpoints` is sync
  bookkeeping (`checkpoint.ts:88`, `admin.ts:97`), not history; it names no
  commit. Keep it in the current-state (sync) layer — confirm with the Rust
  inventory, which may class it with the recorder.

## 4. Tests that pin the coupled behaviour

Unit tests in `packages/core/src` (`*.test.ts`) that read or count the history
tables, by what they pin:

- **Row counts / presence of `revisions`, `commits`, `dispositions`,
  `block_changes`, `tree_nodes`, `blobs`, `resurrection_pool`,
  `pending_materializations`:** `core/store/store.test.ts` (table list 37–40,
  an `origin` CHECK 124), `core/store/gc.test.ts`, `core/store/rebuild.test.ts`
  (block_changes = projection of dispositions), `core/store/archive.test.ts`,
  `core/store/retention.test.ts`, `core/store/delta.test.ts` (node forms,
  checkpoint cadence, `root_tree` resolution), `core/store/writers.test.ts`,
  `core/store/size.test.ts` (category shares, `same` counts),
  `core/ingest.test.ts` (27–31 `current_rev == revId`, `file_hash ==
  rendered_hash`; 98 dense `revisions.seq`), `sync/transactions.test.ts`
  (statement ORDER inside the tombstone/ingest transactions: `INSERT INTO
  commits` → pool → FTS → `UPDATE blocks` → `UPDATE docs`, 70–76; rollback
  leaves the `commits` count unchanged, 84–145; sweep SQL text 157–187),
  `sync/checkpoint.test.ts` (dispositions per block in order 167–334, pool
  counts, `revisions` counts 131, convergence 135–184, `checkpoints.files`
  60), `sync/driver.test.ts`, `sync/observe.test.ts` (pool 89/148,
  `current_rev` after revival 143–145, digest `_hash == file_hash` 112–124),
  `sync/reconciling-ingest.test.ts` (dispositions `kind, matcher_v` 49–59),
  `sync/recovery.test.ts` (37–39 `file_hash == rendered_hash`),
  `mutate/materialize.test.ts`, `mutate/plan.test.ts`, `mutate/commit*.test.ts`,
  `mutate/docs-move.test.ts`, `mutate/apply.test.ts`, `mutate/torture.test.ts`,
  `mcp/migration.test.ts` (schema fingerprint incl. `pending_materializations`,
  `root_tree`), `mcp/changes-since.test.ts` (paging over `commits.seq`
  63–101), `mcp/traces.test.ts`, `mcp/effects.test.ts`, `mcp/docs-update.test.ts`,
  `mcp/server.test.ts`, `mcp/writer-lock.test.ts`.
- **`_updated_at` / `_created_at` as revision/commit timestamps:**
  `core/read/list.test.ts` (43, 120–132: `_updated_at` present on list/tree
  rows), `oqx-js/planner.test.ts` (27), `oqx-js/sql/translate.test.ts` (120–121
  "updated_at pushes as its revisions subquery", 410, 520–524 `r.rev_id =
  d.current_rev` in the pushed SQL).
- **`_rev` / revision tokens and time travel:** `graph/history.test.ts`
  (`historyNode`, `diffBlocks`, `docHistory` `_rev _seq _commit _is_current`,
  `changesSince` digests), `core/read/read.test.ts` (290–361: `readDocumentAtRevision`
  byte-exact with `rendered_hash` for the earliest revision; fidelity caveat),
  `core/read/fidelity.test.ts`, `oqx-js/names.test.ts` (`revisions` vocabulary),
  `mutate/select.test.ts` (`revisions` refused as a selector root),
  `mcp/reference.test.ts` (the card text).
- **Mint oracle:** `core/ids.test.ts` (158 lines; the repeating minter and the
  oracle over the ID_TABLES union).
- **Vectors:** `search/{embeddings,doc-vector,vector,drain,tasks,resolve,rrf,
  text}.test.ts`, `core/store/size.test.ts`, `core/store/store.test.ts` (cosine).
- **Edge intervals:** `graph/edges.integration.test.ts`, `sync/attach.test.ts`
  (27), `sync/driver.test.ts` (39) count `edges WHERE to_commit IS NULL`.

Fixture suites (run by the conformance tests listed in §1 step 5 — e.g.
`core/store/gc.test.ts`, `core/store/archive.test.ts`, `core/store/delta.test.ts`,
`sync/observe.test.ts`, `mutate/commit.test.ts`, `mutate/materialize.test.ts`,
`mcp/server.test.ts`, `graph/history.test.ts`, `mcp/examples.test.ts`,
`oqx-js/run.test.ts`):

- **`spec/store/cases/*.json`** (`batch` 9 cases, `deletion` 6, `delta` 5,
  `frontmatter` 7, `garbage` 1, `identity` 11, `observe` 9, `pool` 8,
  `retention` 12, `structure` 9, `schema` 1, `migrations` 9): every case
  projects the full table set — `docs` (`current_rev`, `file_hash`, `archive`),
  `blocks`, `blobs` (hashes), `tree_nodes` (hashes + entries), `revisions`
  (`rev`, `seq`, `root_tree`, `rendered_hash`), `commits`, `dispositions`,
  `block_changes`, `resurrection_pool`, `pending_materializations` — under the
  sequential minter, plus the §8 invariants after every step. Phase 3/4 moves
  the `revisions`/`tree_nodes`/`dispositions`/`block_changes`/`commits`
  projections into the recorder's suite and leaves `docs`/`blocks`/`blobs`
  (current-reachable)/pool/pending in the store's; `garbage.json` (the mark)
  and `delta.json` (checkpoint forms) are recorder-only; `identity.json` (the
  mint oracle over `block_changes`) changes shape with §3.5.
- **`spec/mutate/cases/commit.json`, `materialize.json`** (`rendered_hash` 40,
  `dispositions` 39, `revisions` 17, `commits` 16 projections): one `api`
  commit per request, per-document revisions, `pending_materializations` rows
  with `rev_id`, the crash/gate cases (`materialize::crash-then-observe-of-
  stale-file-is-foreign`). §3.7 changes the pending row's columns.
- **`spec/sync/cases/checkpoint.json`** (`rendered_hash` 36, `revisions`/
  `dispositions`/`commits`/`block_changes` 19 each): observed checkpoints
  project the history tables.
- **`spec/graph/cases/intervals.json`** (33 `from_commit`/`to_commit`): edge
  interval open/close per commit — moves to the recorder (§3.9).
- **`spec/surface/cases/reads.json`** (`revisions` 69, `dispositions` 68,
  `_updated_at` 51, `_seq` 47, `_archived` 40, `_rev`/`_commit` 36,
  `docs_history` 18, `docs_read_at` 10, `docs_diff_unified` 10, `docs_diff` 9,
  `changes_since` 8) and **`query-revisions.json`**, **`query-dates.json`**
  (`_updated_at`/`_created_at` values), **`query-links.json`** (open edges),
  **`interop.json`** (cross-engine byte equality of these): the `_rev` tokens
  and `_updated_at` timestamps are what Phase 3 re-sources; the history tools'
  cases move behind a capability flag.
- **`spec/cli/cases/history.json`** (70 cases: `log`, `log --since/--cursor/
  --origin`, `hist <block|doc>`, `diff <doc>`, `history plan/attach/detach`,
  `links`) and **`admin.json`** (`gc --dry-run` × 4, `doctor --size` × 3,
  `embed drain`): stdout pinned on `#seq origin summary` lines and the size
  categories; `embed drain`/`doctor --size` are the semantic/size half.
- **`spec/reconcile/cases/*`** and **`spec/properties/cases/*`**: in-memory
  (dispositions as matcher output, property rows) — unaffected by table
  placement, but `resurrection.json` assumes the pool semantics of §3.6.

## 5. Observations

1. **The current frontmatter is a history read on the hottest path.** Every
   `docs_read`, every `apply`/`plan`/`execute` (`loadMutDoc`) and the ingest
   convergence check go `docs.current_rev` → `revisions` → `blobs`, and since
   16.0 possibly 15 further `revisions`+`blobs` reads to resolve a delta
   (`document.ts:91–97`, `delta.ts:427–446`). The spec says so (§6.1 "only the
   frontmatter resolves") but the plan's list ("current frontmatter reads use
   `current_rev` + `TreeResolver`") understates it: with history off there is
   no frontmatter at all, because frontmatter has no `blocks` row.
2. **GC's mark never looks at `blocks`.** `markReachable` (`gc.ts:28–40`) roots
   only on `revisions`; current content survives by I3, not by its own
   reference. A current-only store needs a current-state root for the mark
   (and I5 reworded), or the first `omg gc` with capture off deletes every blob.
3. **Recovery renders from history, not from current state.** `renderedBytes`
   (`materialize.ts:98–103`) uses §6.2 (Merkle tree, segment-aware) although a
   pending row always names the current revision (§5.7), for which §6.1 is
   byte-exact; and `priorRenderedHash` (85–91) is the only current-state read
   of a NON-current revision. Both are avoidable today.
4. **The mint oracle's dependence on `block_changes` is load-bearing enough
   that the squash preserves rows for it** (`archive.ts:703–709`: "the mint
   oracle reads this table, so an id ever minted stays in use after its row,
   its pool entry and its history are gone"). Identity claims are the right
   abstraction; the current encoding makes `block_changes` un-droppable.
5. **`search/cel/compile.ts` is dead in production.** No module imports
   `compile()`; only `FilterInvalid` (parser) and the `SemanticVec` type are
   used (`oqx-js/context.ts:24,29`, `run.ts:17–18`), `blocks_search` is
   `textSearch` (`mcp/server.ts:891`), and no `search/cel/*.test.ts` exists. Its
   `updated_at` subqueries over `revisions`/`block_changes` (247, 273) and its
   `semantic`/edge SQL are 890 lines of coupling with no caller.
6. **`properties.deleted_commit` is write-never.** `writeDocProperties` deletes
   and re-inserts (`properties.ts:215–227`) and nothing sets the column, yet
   four partial indexes and every property read filter on `deleted_commit IS
   NULL` (`spec/store/schema.sql:288–291`, `properties.ts:171, 187`,
   `names.ts:112`). The
   TS matches the spec (the column exists) but the predicate is vestigial.
7. **`idx_edges_temporal (from_commit, to_commit)` has no reader.** Nothing in
   the TS engine queries `from_commit` (`spec/store/schema.sql:117` defines the
   index; the two open-row indexes at 115–116 are the ones every read uses);
   every read is `to_commit IS NULL`. The interval model is capture-only data
   living in a current-state table (`edges.ts:49–68`).
8. **`reposStatus.unconverged` is defined as `file_hash IS NOT rendered_hash`
   of `current_rev`** (`admin.ts:45–48`), which I1 says is always false and
   `ingest.ts:499` guarantees by writing both from `sha256(content)`. It is a
   history join that can only ever return 0; the disk-drift scan is the real
   signal (`admin.ts:54–56`).
9. **`size.ts` files `resurrection_pool` and `pending_materializations` under
   "history"** (`size.ts:38–39`) while both are current-state mechanisms
   (identity threading, recovery intent); `checkpoints` is "sync". The modular
   split should fix the labels or the `doctor --size` advice will mis-attribute
   growth.
10. **Spec/TS disagreement to track:** `spec/store` §3.1 says `revisions.
    frontmatter_blob` "a `blobs.hash` … or NULL" with no FK since 15.0, and
    `pending_materializations.rev_id REFERENCES revisions(rev_id)` IS a
    declared FK (`schema.sql:176`) — so `revisions` cannot be dropped or made
    optional without a schema major even though every other coupling is by
    convention. `migrateV15` already had to turn FKs off for this reason
    (`store.ts:203–207`, `214`).
11. **`movePath` rewrites history in place:** `UPDATE revisions SET path = ?
    WHERE … rev_id = current` (`commit.ts:455`). The current revision's `path`
    is treated as current state; older revisions keep their path. Under the
    split the current path is `docs.path` and the recorder decides whether a
    move is a new revision or an edit of the last.
12. **The OQX vocabulary cache is invalidated by `MAX(commits.seq)`**
    (`names.ts:91–102`) — a history row used as the store's modification
    clock. Any current-state change token (§3.8) must be monotonic per repo to
    replace it.
13. **The `ApplyRevision`/`revisions[]` wire name** (`apply.ts:75`,
    `plan.ts:604`, `sugar.ts:208`, `surface-paths.ts:37`) is not the table; a
    reader grepping for `revisions` finds 30 files, of which 9 are this shape.
14. **Both id resolvers conflate current-state output and capture payload in
    one return value** (`IdResolver` → `{ assigned, dispositions, deleted,
    consumedPool, crossDocIds, extractEdges }`, `ingest.ts:60–74`): `assigned`,
    `deleted`, `consumedPool`, `crossDocIds` drive the current rows and the
    pool; `dispositions` drive only `dispositions`/`block_changes`. Phase 4's
    seam is this type.
15. **`docs_tree`/`docs_list` compute `_updated_at` for every row
    unconditionally** (`reader.ts:66`, a correlated `revisions JOIN commits`
    subquery per document) even when `docs_tree` is called without `updated:
    true` and drops the value (`reader.ts:248`).
