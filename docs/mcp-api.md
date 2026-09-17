# omgbase — MCP / API Surface

**Status:** as-built reference — the tool roster below is verified 2026-09-14 against `packages/core/src/mcp/server.ts` (the 31 registered tools, their real params and inline descriptions). Tool names use snake_case (MCP-safe, mrplex heritage).
**Depends on:** all preceding docs. The design metric is **agent reasoning round trips**, not call count.

---

## 1. Cross-cutting response rules

These four rules apply to every tool and are non-negotiable:

1. **Explicit incompleteness.** Every list-shaped result carries `truncated: boolean` and, when true, `cursor`. An agent must never have to guess whether it saw everything.
2. **Budgets are first-class.** Hydrating tools (`docs_get_many`, `nodes_get_many`, …) accept `budget_tokens` (server estimates ~4 chars/token, truncates at block boundaries, sets `truncated`). Traversals bound the walk instead: `query`'s OQX `follow … { depth n }` / `where $ordinal <= N` and the `graph` tool's `degrees`/`max_documents`.
3. **Conflicts carry current truth.** See `mutation-and-concurrency.md` §4.
4. **Uniform resolution ladder** on every reader:
   - `skeleton` — ids + types + one-line labels (~6 tokens/block)
   - `outline` — skeleton + heading text + first ~10 words per block
   - `text` — normalized text
   - `raw` — exact Markdown source
   - `full` — raw + attrs + placement + open edges + last-change info

## 2. Resources

| URI | Content |
|---|---|
| `omg://<repo>/doc/<doc_id>[@<rev_id>]` | Document (current or at revision) |
| `omg://<repo>/block/<block_id>[@<rev_id>]` | Block subtree |
| `omg://<repo>/path/<filepath>` | Convenience → current document at path |

Tool arguments take bare IDs. **Locators** (`projects/foo.md#Risks/p[2]`, `#^anchor`) are accepted anywhere an ID is; resolved server-side; `ambiguous_locator` errors return ranked candidates. Locators are never returned as the sole address — responses pair `$id` with `$locator` for human legibility.

## 3. Tools

The 31 registered tools, grouped as the server wires them. Signatures below match the Zod input schemas in `server.ts`; `?` marks an optional field. `doc` is id-OR-path everywhere it appears; `path` is explicit-path; when a tool takes a block `id`/`ids`, the owning doc is inferred so `doc`/`path` are optional.

### Read

```
docs_outline { doc?, path?, resolution?: "skeleton"|"outline", depth?, budget_tokens? }
```
Orientation call. Returns the indented compact text format (id, type, label per line; `§` marks section headings). `resolution` is only `skeleton` or `outline` (no `preview`/`section`/`annotate`). The workhorse orientation call.

```
docs_read { doc?, path?, include_ids? }
```
Reads a whole document in one call: `content` is the complete file bytes (verbatim — the same bytes `apply` writes to disk, fences/tables/list markers preserved), `metadata` is the document's structured property bag, plus `path`/`docId`/`rev`. The cold-start "read the guide before doing anything" call — mirrors mrplex `docs_get`. `include_ids:true` also returns the document's block ids in order for follow-up edits. This is a server-side projection over ordered blocks, not blob storage: identity stays block-level (`docs_read` reads; `apply` writes via block ops). `nodes_get` on a doc/heading id returns only that block — use `docs_read` for the whole document.

`metadata` is format-dependent, produced by the ingest adapter, not universally "frontmatter": for markdown it is the parsed frontmatter block (and, as adapters grow, may merge intrinsics — inline dataview-style fields, an h1-derived title); for a YAML or JSON file it is the parsed object the file represents; a bespoke adapter (say a `.trx` terminal-scrape format, or a `.js` file exposing its top-level exports) extracts whatever its format defines. `docs_read` returns whatever the adapter stored — it does not impose the markdown frontmatter model.

```
docs_get_many { docs[], include_ids?, budget_tokens? }       // capped at MANY_DOCS_CAP refs
docs_read_at { doc?, path?, rev }                            // time-travel whole-doc read
```
`docs_get_many` is the plural of `docs_read` and the hydrate half of query→hydrate: pass a list of refs (each a doc id OR path) and get `{ items, errors, truncated }` — one full read per ref, a ref resolving to no live doc landing in `errors` (not failing the batch), duplicates collapsed, excess refs past the cap dropped with `truncated`. `docs_read_at` reconstructs a document's whole file bytes AS OF a past `rev` (get a `rev` from `diff`/`history_node`/`docs_history`/`changes_since`); `properties` are current values.

```
nodes_get { doc?, path?, id, resolution?: "skeleton"|"outline"|"text"|"raw"|"full" }
nodes_get_many { doc?, path?, ids[], resolution?, budget_tokens? }   // ≤ 100 ids
```
`nodes_get` hydrates one block subtree at a resolution (the full ladder from §1). The `raw`/`full` resolutions include the block's `content_hash` (what `update`/`split` need in `expect.content_hash`). There is no `locator`/`include` param — the block id is the address and the owning doc is inferred.

### Search

```
query { query: "<OQX expression string>", limit?, cursor? }
query_syntax {}                                              // returns the full OQX reference
text_search { q, limit? }                                    // FTS5 bm25 keyword search
resolve { query, limit? }                                    // hybrid ranker → {id, locator, preview, evidence}
```
`query` takes a single **OQX string** (not a `{from, filter, …}` envelope) — composable structural navigation, correlated subqueries, `select` projection, and bounded recursive traversal (`follow`) in one expression (see graph-and-query.md §4 and 10-oqx). `limit`/`cursor` page the lean hits `{id, path, …projections}`; a `count`/`exists` consumer returns a scalar. `query_syntax` (no args) returns that whole reference — call it before writing a non-trivial filter. `text_search` is a plain-words FTS5 search box (words ANDed, `"quoted phrases"` adjacent, no DSL). `resolve` is the "give me the id of the thing I mean" hybrid ranker (FTS + semantic when a provider is configured); it has no `scope`/`kinds` param.

### Graph

```
graph { roots[], degrees?, direction?: "in"|"out"|"both", predicate?, select?[], max_documents? }
```
Neighborhood convenience macro: the bounded graph AROUND one or more root documents in ONE call — `{ documents, edges, frontier }`. It is a WRAPPER that compiles its args into an OQX `follow doc.out`/`doc.in` query and runs the same `query` path (the returned `queries` field is the exact follow query generated). `roots` are doc refs (paths and/or ids, depth 0); `degrees` is max hop distance (root = 0, default 1, capped so `degrees+1 ≤ 8`); `direction` defaults `both`; `predicate` restricts the walk to one edge predicate; `select` adds OQX doc projections; `max_documents` caps the set (default 200) with `truncated`.

Traversal proper is the OQX `follow` operator on the `query` tool, not a dedicated tool — reach for `query` directly when you need successor/frontier predicates, `by`-keyed identity, `$ordinal` budgets, cross-document correlation, or the `from edges` scan: `query { query: 'from docs where $path == "x.md" follow doc.out' }`. The old structured `graph_traverse`/`graph_path`/`graph_subgraph` tools were removed.

### Mutate

```
apply { ops[], reason?, dry_run? }                           // 04-… §2 (the only real block-op writer)
tasks_complete { blocks[] }                                  // macro: mark task blocks checked
node_set { node, prop, value }                               // macro: edit one prop of a projected node
sections_append { heading, markdown, doc?, path? }           // macro: append inside a heading's section
docs_append { doc?, path?, text }                            // macro: append at the document end
links_stale { path_glob?, limit? }                           // READ-ONLY: surface dangling internal links
links_retarget { from_target, to_target, dry_run? }          // macro: rewrite one link destination
links_repair { repairs?[{from,to}], from_target?, to_target?, dry_run? }  // macro: bulk stale-link repair
docs_create { path, markdown, frontmatter? }                 // fails path_taken if it exists
docs_move { doc, to_path }                                   // rename; identity + history preserved
docs_delete { doc }                                          // tombstone (resurrection-poolable) + remove file
docs_set_meta { doc, set?, unset? }                          // surgical frontmatter key patch
docs_plan_update { doc, content }                            // plan a whole-doc update; returns opset + plan, no write
docs_update { doc, content, reason?, dry_run? }              // whole-doc update w/ identity-preserving reconciliation (api-origin)
observe { path, content }                                    // sync ingest: whole-file bytes as an OBSERVED commit (file→DB); echo-suppressed
observe_many { files:[{path,content}] }                      // batch observe: one ts + one resurrection sweep; per-file results
```
`apply` is the only real block-op writer: a changeset of kernel ops (insert/update/move/remove/split/merge) applied atomically; each op is a tagged object keyed by `"op"`, targeting its `block`/`blocks` field (never `id`/`target`). MCP-originated writes are actor `agent:mcp`; a successful non-dry-run write schedules a background embed drain.

Macros expand to `apply` ops through the same changeset machinery. Registered macros are exactly `tasks_complete`, `node_set`, `sections_append`, `docs_append`, `links_retarget`, `links_repair` — the once-specced `sections_rename`/`sections_move`/`lists_insert_item` are NOT registered MCP tools. `node_set` surgically edits one editable prop of a projected node (a link's `name`/`value`, a task's `checked`); it errors `node_not_editable` when the kind/prop has no editor. `sections_append` accepts a heading block id (preferred) or its text (resolved, scoped by `doc`/`path`; repo-wide non-unique text errors `ambiguous_heading`). `docs_append` is additive and identity-preserving (existing blocks keep their ids); the doc must already exist (else `doc_missing`). `links_stale` is READ-ONLY (not a writer): it surfaces DANGLING internal links (`phantom:` edges) with `stale[]` + `externalCount` + `truncated`, scoped by `path_glob`; feed its targets into `links_repair` (batch of `{from,to}` pairs, a generalization of the single-pair `links_retarget`) to fix them.

`docs_plan_update`/`docs_update` are the whole-document path with SMART identity preservation: submit the complete proposed `content` and the engine reconciles it against the current stable block tree, preserving ids for recognizably-same structure, minting for new, tombstoning removals. `docs_plan_update` returns the executable opset + human-readable plan without writing; `docs_update` = plan + commit (`dry_run:true` is identical to `docs_plan_update`), refusing a stale plan with `stale_plan`.

`observe` (ADR-014) is the whole-file **sync-ingest** counterpart: it records `content` as the current authoritative bytes for `path` as an **observed-origin** commit — a write *around* the engine (mirroring an external edit) rather than `docs_update`'s api-origin write *through* it. Both reconcile against the block tree and preserve ids; only `origin` differs (and thus the change-feed semantics + matcher path). `observe` writes **no file** (it is the file→DB direction), so it works on a headless/sourceless server; it is idempotent (bytes matching the stored revision are an echo — `echo:true`, `rev:null`, no commit) and flags git conflict markers (`conflicted:true`). Mirror a deletion with `docs_delete`. Returns `{ docId, path, rev, commitId, converged, echo, conflicted, dispositions[] }`. `observe_many` is the batch form — an array of `{path, content}` under one timestamp + a single resurrection-pool sweep, returning one result per file. `observe`/`observe_many` are the single reconcile primitive (`observeOne`) that the local filesystem checkpoint and the external-source driver also share, so on-the-wire and in-process reconciliation cannot drift.

> **As-built:** these doc-level tools are registered in the MCP server and back the CLI's `new`/`mv`/`rm --doc`/`meta`/`update`. `docs_set_meta` takes `set` (keys to set) and `unset` (keys to remove) rather than a single `patch` object; the per-op `expect` CAS guard specced in 04 is implemented on kernel ops (via `expect.content_hash`), while the doc-level tools re-ingest the whole file and ride the in-process writer lock. MCP-originated writes are actor `agent:mcp`.

### History

```
history_node { id, limit? }                                  // a block's biography, newest first
diff { doc, from_rev, to_rev }                               // block-grain diff between two revisions
docs_history { path_glob?, doc?, include_deleted?, limit? }  // per-document revision lists
changes_since { cursor?, origin?: "api"|"observed"|"import", limit? }  // repo-wide commit feed
```
`history_node` returns the commits that touched a block with disposition kind/confidence/reason (no `cursor` param). `diff` is block-grain only (added/removed/changed blocks) — there is no `grain` param. `docs_history` groups revisions BY DOCUMENT (each `rev`/`seq`/`commit`/`ts`/`origin`/`actor`/`contentHash`/`isCurrent`, oldest→newest); require one of `path_glob` or `doc`, `include_deleted:true` to also see tombstoned docs, `limit` caps documents with `truncated`. `changes_since` is the repo-wide COMMIT feed: `cursor` is the repo commit seq (NOT a `since_ts`; no `scope`/`min_confidence`), poll with your last cursor to cheaply re-orient after time away. Each digest's `revisions[]` carries `{doc, path, contentHash}` (contentHash = hex of the revision's rendered file hash), so a synchronizer can decide "changed vs echo" against what it last wrote without a follow-up `docs_read`; `origin` filters to commits a given writer produced. Feed a `rev` from any of these into `docs_read_at` (whole doc at that rev) or `diff` (changes between two revs).

### Admin

```
repos_status {}               // repo counts (docs/blocks/commits/open edges/unconverged) + on-disk drift
sync_status {}                // watcher/sync state: last commit seq, last checkpoint, convergent?
```
Both take no arguments and report on the server's single configured repo. `repos_status.disk` is a read-only working-tree scan (`changed`/`deleted`/`untracked`/`checked`). `sync_status.convergent` is true ONLY when the DB is converged AND a working-tree scan ran and found no drift — never green while disk freshness is unverified. There are no `repos_list`/`repos_create`/`sync_flush` tools on this surface (repo lifecycle lives in the CLI/store, not the MCP server).

## 4. Tool-description contracts (write these into the MCP descriptions)

- IDs are stable within and across sessions; locators are display-only. Prefer IDs in follow-up calls (prompt-cache-friendly).
- After any conflict, the error already contains current state — retry from it, don't re-read.
- `links_retarget`/`links_repair` and any multi-doc macro: call with `dry_run: true` first.
- Never rewrite whole documents to make small changes; use block ops. A blind `docs_put`-style blob overwrite intentionally does not exist — whole-document submissions go through `docs_update`/`docs_plan_update`, which reconcile against the block tree to preserve identity rather than replacing it. Reserve those for genuine whole-doc rewrites.
- `changes_since` with your last cursor is the cheap way to re-orient after time away.

## 5. Error codes

`stale_expectation` · `parent_missing` · `target_missing` · `block_missing` · `doc_missing` · `cycle_move` · `opaque_block` · `not_contiguous` · `type_mismatch` · `conflicted_document` · `path_taken` · `create_conflict` · `ambiguous_locator` · `ambiguous_heading` (candidate ids attached) · `node_not_editable` (editable-prop list attached) · `stale_plan` (a `docs_update` whose base changed) · `filter_invalid` · `budget_exceeded` (partial result attached) · `semantic_unavailable` · `sync_conflict` · `repo_not_found`. Shape: `{ error, message, data?, retriable: boolean }` — stable codes, prose free to improve.

## 6. Outline wire format

```
b_k2n8x4q h2  Risks                          §
b_9fw3mzt p   Stable block identity is quite…
b_p7c1vd0 ul
b_r5h6yja li  ☐ decide on id write-back
```
Column 1: the full block id (`b_…`), emitted inline so it can be dropped straight into a follow-up op — no alias table to resolve. `§` marks heading lines that own a section range. Checkbox glyphs for tasks.

## 7. Worked traces (acceptance fixtures for Stage 6)

**T1 — "Move this decision from Open Questions into Decisions."**
1. `docs_outline { path: "projects/omgbase.md", resolution: "outline" }`
2. `apply { ops: [ move(b_q4 → section(b_decisions), end) ] }`
Budget: 2 turns, < 1k tokens total.

**T2 — "Complete deployment-related unchecked tasks under Launch."**
1. `query { query: 'from nodes where kind == "md:task" && !attrs.checked && semantic("deployment") > 0.6 && section exists { where name == "Launch" }' }`
2. `tasks_complete { blocks: […] }`
2 turns.

**T3 — "What changed since yesterday?"**
1. `changes_since { cursor: <last seen commit seq> }` — 1 turn. (`changes_since` is cursor-based on the repo commit seq; there is no `since_ts`.)

**T4 — "Which exact paragraphs depend on this document?"**
1. `query { query: 'from edges where $dst_path == "x.md" && (predicate == "depends_on" || predicate == "references") select $src, $src_field' }` — 1 turn.

**T5 — "Everything downstream of this assumption."**
1. `query { query: 'from docs where $path == "assumptions.md" follow doc.in { depth 4 }' }` — 1 turn. (`follow doc.in` walks incoming edges — who depends on / references the seed.)

**T6 — "Refactor this long note into three notes, provenance intact."**
1. `docs_outline` → 2. `apply { docs_create ×2 + move runs }` (moves carry identity across docs) → 3. optional `links_retarget`. ≤ 3 turns.

**T7 — "Add a caveat to the design rationale for stable block identity."**
1. `resolve { query: "stable block identity rationale" }` (or `query` with a `semantic("…")` prune) to get the block id → 2. `apply { ops: [ insert after b_… ] }`. 2 turns.

**T8 — "Change this relationship everywhere it is asserted."**
1. `links_retarget { from_target, to_target, dry_run: true }` → 2. same `{ dry_run: false }`. 2 turns.

**T9 — "Find contradictions between these two regions."**
1–2. `query` (with a `semantic("…")` prune) or `docs_get_many` per region → agent judgment (deliberately not an engine feature).

These traces, with their turn budgets, are executable acceptance tests: a scripted agent (or replayed transcript) must complete each within budget against the fixture vault.
