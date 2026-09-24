# omgbase — MCP / API Surface

**Status:** as-built reference — the tool roster below is verified 2026-09-23 against `packages/core/src/mcp/server.ts` (the 45 registered tools, their real params and inline descriptions). Tool names use snake_case (MCP-safe, mrplex heritage).
**Depends on:** all preceding docs. The design metric is **agent reasoning round trips**, not call count.

---

## 1. Cross-cutting response rules

These rules apply to every tool and are non-negotiable:

0. **Multi-repo (ADR-014).** Every repo-scoped tool accepts an optional `repo` (a slug); omitting it uses the server's bound default repo, so single-repo clients are unchanged. An unknown slug is a loud `repo_not_found`. Discover slugs with the `repos` tool; per-repo counts/convergence via `repos_status { repo }`. Mutators resolve the *target* repo's working-tree root, so a write always lands in the right tree.
1. **Explicit incompleteness.** Every list-shaped result carries `truncated: boolean` and, when true, `cursor`. An agent must never have to guess whether it saw everything.
2. **Budgets are first-class.** Hydrating tools (`docs_get_many`, `nodes_get_many`, …) accept `budget_tokens` (server estimates ~4 chars/token, truncates at block boundaries, sets `truncated`). Traversals bound the walk instead: `query`'s OQX `follow … { depth n }` / `where $ordinal <= N` and the `graph` tool's `degrees`/`max_documents`.
3. **Conflicts carry current truth.** See `mutation-and-concurrency.md` §4.
4. **One resolution ladder** wherever a block is hydrated:
   - `skeleton` — ids + types + one-line labels (~6 tokens/block)
   - `outline` — skeleton + heading text + first ~10 words per block
   - `text` — normalized text
   - `raw` — exact Markdown source
   - `full` — raw + attrs + placement + open edges + last-change info

   As built, the full ladder is a parameter of the block readers `nodes_get`, `nodes_get_many`, and `read_ref` (block refs; default `raw`); `docs_outline` accepts only `skeleton`|`outline`. The whole-document reads (`docs_read`, `docs_get_many`, `docs_read_at`) and the enumerators (`docs_tree`, `docs_list`) take no `resolution` — they return file bytes or path rows. `budget_tokens` is accepted by `docs_outline`, `docs_get_many`, `nodes_get_many`, `docs_tree`, and `docs_list`.

## 2. Resources

| URI | Content |
|---|---|
| `omg://<repo>/doc/<doc_id>[@<rev_id>]` | Document (current or at revision) |
| `omg://<repo>/block/<block_id>[@<rev_id>]` | Block subtree |
| `omg://<repo>/path/<filepath>` | Convenience → current document at path |

Tool arguments take bare IDs. A **ref** argument (`read_ref`, the `blocks_*` sugar, `omg cat`/`show`) is what `resolveRef` (`core/read/refs.ts`) accepts as built: a block id (`b_…`), a doc id (`d_…`), a node id (`n_…`, dereferenced to its block), or a repo-relative document path. In-doc anchor **locators** (`projects/foo.md#Risks/p[2]`, `#^anchor`) are a design notion that is **not implemented** — nothing parses them, so such a ref is `doc_missing` (the `ambiguous_locator` error code is declared but never raised). Locators still appear in *output* as a human-legible companion: responses pair `$id` with `$locator`, and IDs are the address to use in follow-ups.

## 3. Tools

The 45 registered tools, grouped as the server wires them. Signatures below match the Zod input schemas in `server.ts`; `?` marks an optional field. `doc` is id-OR-path everywhere it appears; `path` is explicit-path; when a tool takes a block `id`/`ids`, the owning doc is inferred so `doc`/`path` are optional.

### Read

```
docs_outline { doc?, path?, resolution?: "skeleton"|"outline", depth?, budget_tokens? }
```
Orientation call. Returns the indented compact text format (id, type, label per line; `§` marks section headings). `resolution` is only `skeleton` or `outline` (no `preview`/`section`/`annotate`). The workhorse orientation call.

```
docs_tree { path?, depth?, limit?, cursor?, budget_tokens? }     // repo-shape orientation: tree -L depth + du
docs_list { path_glob?, limit?, cursor?, budget_tokens? }        // flat `ls`, paged
```
`docs_tree` is the **repo-level** orientation call — the answer to "what does this repo contain?" in one small page. The engine stores paths as flat strings; this is the one read that treats `/` as a separator. Every live document under `path` (a directory prefix, normalized to no leading `/` and a trailing `/`; omit for the root) is collapsed at `depth` segments (default 1 = immediate children): `entries` is one `{ path, kind: "dir"|"doc", docs, blocks, ts }` per directory (path ends in `/`; `docs`/`blocks` are totals under it, `ts` the latest last-commit time under it) or per shallow document (`docs: 1`), ordered by path. `total: { docs, blocks }` always covers everything under `prefix` regardless of paging. Descend by re-calling with `path` set to a `dir` entry, or raise `depth`.

`docs_list` is the flat enumeration behind `omg ls`: `{ items: [{ path, blocks, ts }], truncated, cursor }`, ordered by path. `path_glob` is a SQL `LIKE` match where `*` matches any run **including `/`** (`projects/*` is the whole subtree — there is no "immediate children only"; that is `docs_tree`'s job). Unscoped on a large repo it is hundreds of rows, so it is paged like every other list: `limit` (default 200) caps rows, `cursor` from a truncated page resumes after the last row returned, `budget_tokens` caps the page's estimated size (at least one row is always returned so a paging client makes progress), and `truncated` is honest. A malformed `cursor` is `filter_invalid`. All keyset cursors on this surface (`query`'s collect page, `docs_list`, `docs_tree`) share one kernel encoding (`core/cursor.ts`: opaque base64url of a string tuple) and one rejection path — a cursor handed to a tool that did not issue it is loud, never a silent restart.

```
docs_read { doc?, path?, include_ids? }
```
Reads a whole document in one call: `content` is the complete file bytes (verbatim — the same bytes `apply` writes to disk, fences/tables/list markers preserved), `properties` is the document's property bag grouped by source, plus `path`/`docId`/`rev`. The cold-start "read the guide before doing anything" call — mirrors mrplex `docs_get`. `include_ids:true` also returns the document's block ids in order (`ids`) plus `hashes` — a `{block id → content hash}` map giving each block's current raw hash, exactly the `expect.content_hash` value raw `apply` ops (`update`/`split`/`merge`/`remove`) want. So one read yields both the stable ids AND the CAS tokens to mutate them, without a follow-up `nodes_get_many(resolution:"full")` hydration round trip. It also returns `parents` — `{block id → parent block id | null}` (null = top level) — because `ids` is a flat pre-order walk and otherwise a list is indistinguishable from its items; filtering `ids` to `parents[id] === null` gives the top-level blocks without an outline read. This is a server-side projection over ordered blocks, not blob storage: identity stays block-level (`docs_read` reads; `apply` writes via block ops). `nodes_get` on a doc/heading id returns only that block — use `docs_read` for the whole document.

`properties` is `{ frontmatter, inline, computed }` — the three property sources of the `properties` table (`properties-table.md`), each a `{ key → value }` record (`core/store/properties.ts` `docPropertiesGrouped`). `frontmatter` is format-dependent, produced by the ingest adapter, not universally a YAML fence: for markdown it is the parsed frontmatter block; for a YAML or JSON file it is the parsed object the file represents; a bespoke adapter (say a `.trx` terminal-scrape format, or a `.js` file exposing its top-level exports) extracts whatever its format defines. `inline` holds the dataview-style `key:: value` fields accumulated from the body; `computed` holds the engine intrinsics (`$title`, `$tags`). There is no `metadata` field — earlier drafts of this doc and of the tool description used that name for what is now `properties`.

```
docs_get_many { docs[], include_ids?, budget_tokens? }       // capped at MANY_DOCS_CAP refs
docs_read_at { doc?, path?, rev }                            // time-travel whole-doc read
```
`docs_get_many` is the plural of `docs_read` and the hydrate half of query→hydrate: pass a list of refs (each a doc id OR path) and get `{ items, errors, truncated }` — one full read per ref, a ref resolving to no live doc landing in `errors` (not failing the batch), duplicates collapsed, excess refs past the cap dropped with `truncated`. `include_ids:true` adds `ids` + `hashes` to each item, same as `docs_read`. `docs_read_at` reconstructs a document's whole file bytes AS OF a past `rev` (get a `rev` from `diff`/`history_node`/`docs_history`/`changes_since`); `properties` are current values.

```
nodes_get { doc?, path?, id, resolution?: "skeleton"|"outline"|"text"|"raw"|"full" }
nodes_get_many { doc?, path?, ids[], resolution?, budget_tokens? }   // ≤ 100 ids, any number of docs
```
`nodes_get` hydrates one block subtree at a resolution (the full ladder from §1). The `raw`/`full` resolutions include the block's `content_hash` (what `update`/`split` need in `expect.content_hash`). There is no `locator`/`include` param — the block id is the address and the owning doc is inferred.

`nodes_get_many` hydrates up to 100 blocks in request order and returns `{ nodes, truncated, unresolved }`. Block ids are globally unique, so `ids` may span any number of documents: each id is resolved to its owning doc server-side (grouped by doc, one forest load per doc). `doc`/`path` is an optional *scope* — when given, ids owned by other documents count as unresolved — never a requirement, and the owning doc is not inferred from `ids[0]`. `unresolved` lists the requested ids (within the cap) that name no live block; ids dropped by the 100-id cap or the token budget are reported by `truncated`, not `unresolved`. Nothing is silently dropped.

```
read_ref { ref, resolution?: "skeleton"|"outline"|"text"|"raw"|"full" }   // polymorphic: doc OR block, classified
```
`read_ref` is the polymorphic read behind `omg cat`: `ref` is ANY ref — a document (`d_…` id or repo-relative path) or a block (`b_…` id, or an `n_…` node id) — resolved server-side (`resolveRef`; no locator syntax, see §2), and the result is classified by `kind`. A document ref returns `{ kind: "document", ...docs_read result }` (complete file bytes + `properties`, no `include_ids`); a block ref returns `{ kind: "block", ...nodes_get result }` at `resolution` (default `raw`, so a block read yields its exact source; `resolution` is ignored for documents). Use it when you hold a ref and want its bytes without first knowing whether it names a document or a block; `docs_read` needs a doc and `nodes_get` needs a block id. A ref that names nothing is `doc_missing` (`block_missing` if the block vanished between resolution and read).

### Search

```
query { query: "<OQX expression string>", limit?, cursor? }
query_syntax {}                                              // returns the full OQX reference
text_search { q, limit? }                                    // FTS5 bm25 keyword search
resolve { query, limit? }                                    // hybrid ranker → {id, locator, preview, evidence}
```
`query` takes a single **OQX string** (not a `{from, filter, …}` envelope) — composable structural navigation, correlated subqueries, `select` projection, and bounded recursive traversal (`follow`) in one expression (see graph-and-query.md §4 and 10-oqx). `limit`/`cursor` page the lean hits `{id, path, …projections}`; a `count`/`exists`/`none` consumer returns a scalar; a `select <expr> values` projection returns the bare values as `values` (paged the same way, `hits` empty); a query-level `limit N`/`offset N` bounds the result set that `limit`/`cursor` then page within. `query_syntax` (no args) returns that whole reference — call it before writing a non-trivial filter. `text_search` is a plain-words FTS5 search box (words ANDed, `"quoted phrases"` adjacent, no DSL). `resolve` is the "give me the id of the thing I mean" hybrid ranker (FTS + semantic when a provider is configured); it has no `scope`/`kinds` param.

### Graph

```
graph { roots[], degrees?, direction?: "in"|"out"|"both", predicate?, select?[], max_documents? }
```
Neighborhood convenience macro: the bounded graph AROUND one or more root documents in ONE call — `{ documents, edges, frontier }`. It is a WRAPPER that compiles its args into an OQX `follow doc.out`/`doc.in` query and runs the same `query` path (the returned `queries` field is the exact follow query generated). `roots` are doc refs (paths and/or ids, depth 0); `degrees` is max hop distance (root = 0, default 1, capped so `degrees+1 ≤ 8`); `direction` defaults `both`; `predicate` restricts the walk to one edge predicate; `select` adds OQX doc projections; `max_documents` caps the set (default 200) with `truncated`.

Traversal proper is the OQX `follow` operator on the `query` tool, not a dedicated tool — reach for `query` directly when you need successor/frontier predicates, `by`-keyed identity, `$ordinal` budgets, cross-document correlation, or the `from edges` scan: `query { query: 'from docs where $path == "x.md" follow doc.out' }`. The old structured `graph_traverse`/`graph_path`/`graph_subgraph` tools were removed.

### Mutate

```
apply { ops[], reason?, dry_run? }                           // 04-… §2 (the only real block-op writer)
blocks_insert { to, markdown, at?, dry_run? }                // sugar: one insert op, ref-resolved server-side
blocks_update { block, markdown?, checked?, attrs?, expect?, dry_run? }  // sugar: one update op, CAS auto-pinned
blocks_move { blocks[], to, at?, dry_run? }                  // sugar: one move op
blocks_remove { blocks[], dry_run? }                         // sugar: one remove op (subtrees; container+descendants collapse)
blocks_split { block, at: number[], dry_run? }               // sugar: one split op, CAS auto-pinned
blocks_merge { blocks[], separator?, dry_run? }              // sugar: one merge op (≥ 2 adjacent blocks)
tasks_complete { blocks[], checked?, dry_run? }              // macro: mark task blocks checked (or unchecked)
node_set { node, prop, value }                               // macro: edit one prop of a projected node
sections_append { heading, markdown, doc?, path? }           // macro: append inside a heading's section
docs_append { doc?, path?, text }                            // macro: append at the document end
blocks_update { block, markdown?, checked?, attrs?, expect?, dry_run? }  // sugar: one update op, CAS pinned server-side; multi-block markdown allowed
links_stale { path_glob?, limit?, summary? }                 // READ-ONLY: surface dangling internal links (summary:true = counts only)
links_retarget { from_target, to_target, path_glob?, dry_run? }  // macro: rewrite one link destination
links_repair { repairs?[{from,to}], from_target?, to_target?, path_glob?, dry_run? }  // macro: bulk stale-link repair
docs_create { path, markdown, frontmatter? }                 // fails path_taken if it exists
docs_move { doc, to_path, retarget_inbound? }                // rename; identity + history preserved; returns dangling inbound links
docs_delete { doc }                                          // tombstone (resurrection-poolable) + remove file
docs_set_meta { doc, set?, unset? }                          // surgical frontmatter key patch
docs_plan_update { doc, content }                            // plan a whole-doc update; returns opset + plan, no write
docs_update { doc, content, reason?, dry_run? }              // whole-doc update w/ identity-preserving reconciliation (api-origin)
observe { path, content }                                    // sync ingest: whole-file bytes as an OBSERVED commit (file→DB); echo-suppressed
observe_many { files:[{path,content}] }                      // batch observe: one ts + one resurrection sweep; per-file results
observe_delete { path }                                      // sync delete: tombstone as an OBSERVED deletion; no file touched
```

**Block-level sugar (`blocks_*`).** The six `blocks_*` tools are one-op wrappers over `apply` — one kernel op each, applied through the same changeset machinery (actor `agent:mcp`, `reason` = the tool name) and returning the same `apply` result `{ results, revisions, committed, diffs? }` (`dry_run:true` returns the per-file diffs and writes nothing). What they add is **server-side ref resolution and CAS pinning**, which is what lets the CLI's block sugar (`insert`/`update`/`move`/`rm`/`split`/`merge`) run unchanged over `--server`: every `block`/`blocks` argument is a *ref* — a block id or a locator — resolved with `resolveRef`, and where the kernel wants an `expect.content_hash` the tool reads the block's current raw hash and pins it (a concurrent edit becomes `stale_expectation`, never a silent overwrite). They need a working tree: on a sourceless repo they fail `repo_not_found` ("repo has no filesystem source; mutation disabled").

- `blocks_insert` parses `markdown` into new block(s) under a parent. `to` is a ref: a **block** ref nests the new blocks under that block; a **document** ref (doc id or path) places them at the document's top level — so appending a new section is `{ to: "<path>", markdown: "## New\n\n…" }`, the positional generalization of `docs_append`. `at` places among the parent's children: `"end"` (default), `"start"`, or `{ before: <block ref> }` / `{ after: <block ref> }`.
- `blocks_move` moves `blocks` (refs, a contiguous sibling run) under `to` at `at` (same forms). `to` is a block ref, or the blocks' **own** document (id or path) to move them to its top level; moving to *another* document's root is not expressible and fails `target_missing` — anchor on a block in that document with `at.before`/`at.after` instead.
- `blocks_remove` removes `blocks` and their whole subtrees (into the resurrection pool). A set naming both a container and some of its descendants — e.g. every id of a section straight from `docs_read include_ids` — is fine: it collapses to the top-most blocks and the result's `removed` lists everything that left. To delete a whole document use `docs_delete`.
- `blocks_split` splits `block` at the character offsets in `at` (integers) into consecutive blocks; CAS pinned to the block's current bytes.
- `blocks_merge` merges `blocks` (≥ 2 adjacent refs) into the first, joined by `separator` (default a blank line).
- `blocks_update` — see its own description in `server.ts` (replace markdown and/or set attrs with CAS; flat `checked` sugar for tasks).
`docs_move` renames a document; block identity and history are preserved, but **links follow the path, not the identity**. Inbound links written against the old path now dangle: their open edges are re-pointed at `phantom:<old path>` (what re-extracting the source would produce), so `links_stale` reports them; phantom edges already written against the new path are adopted and resolve to the moved doc. The result is `{ docId, path, committed, dangling, retargeted }` — `dangling` lists each inbound occurrence `{ doc, path, block, target, anchor, field? }` (block `null` = a frontmatter relation; self-doc pure-fragment links `#H` are not path-dependent and are not listed). `retarget_inbound:true` rewrites those links in the same call — a destination-aware rewrite over the source blocks (anchors, link text, titles, and code spans preserved; absolute stays absolute, `./`/`../` is recomputed, bare root-relative stays bare) applied as one CAS-checked `update` changeset (actor `agent:mcp`), after which `dangling` holds only what was not rewritten (frontmatter relations) and `retargeted` lists the touched `blocks`/`docs`.

`apply` is the only real block-op writer: a changeset of kernel ops (insert/update/move/remove/split/merge) applied atomically; each op is a tagged object keyed by `"op"`, targeting its `block`/`blocks` field (never `id`/`target`). MCP-originated writes are actor `agent:mcp`; a successful non-dry-run write schedules a background embed drain.

Macros expand to `apply` ops through the same changeset machinery. Registered macros are exactly `tasks_complete`, `node_set`, `sections_append`, `docs_append`, `links_retarget`, `links_repair` — the once-specced `sections_rename`/`sections_move`/`lists_insert_item` are NOT registered MCP tools. `node_set` surgically edits one editable prop of a projected node (a link's `name`/`value`, a task's `checked`); it errors `node_not_editable` when the kind/prop has no editor. `sections_append` accepts a heading block id (preferred) or its text (resolved, scoped by `doc`/`path`; repo-wide non-unique text errors `ambiguous_heading`). `docs_append` is additive and identity-preserving (existing blocks keep their ids); the doc must already exist (else `doc_missing`). `links_stale` is READ-ONLY (not a writer): it surfaces DANGLING internal links (`phantom:` edges) with `stale[]` + `externalCount` + `totalOpenEdges` + `truncated`, scoped by `path_glob`. Each row carries both `target` — the canonical missing path, **no leading `/`** (`guides/old.md`) — and `authored` — the destination text exactly as written in the source block (`/guides/old.md#Setup`; `null` for frontmatter edges, which have no block). `summary: true` returns counts only (`staleCount`, `byTarget[{target,count}]`, `bySource[{srcPath,count}]`, `externalCount`, `totalOpenEdges`) for a repo-wide audit in one small call. Feed either `target` or `authored` into `links_repair` (batch of `{from,to}` pairs; `links_retarget` is its single-pair form) to fix them.

`links_repair` / `links_retarget` rewrite **link destinations, not substrings**: `from` must be the whole destination of a Markdown link/image `[t](dest)`, a wikilink `[[dest]]` / `[[dest|alias]]`, or a bare-path inline field `key:: /dest`. A leading `/` is optional on either side, and a trailing `#heading`/`^ref` fragment on the link is preserved and re-appended to `to`. Never rewritten: prose mentions, inline code, `code_fence` blocks, longer paths that merely contain `from` (`/b.md` does not match `/everland/b.md` or `/b.md.bak`), and frontmatter values (use `docs_set_meta`). Each destination takes the first matching pair (no chaining). Ops coalesce to one `update` per **top-most** block — a list and its list items carry the same bytes, and updating the container re-mints its children, so the child hit is dropped rather than failing `block_missing` mid-changeset. Scope source docs with `path_glob` (same glob rules as `links_stale`). Response: `hits[{block,path,oldRaw,newRaw}]`, `pairs[{from,to,hits}]` (per-pair destination counts; `0` = nothing matched), `applied`, and the kernel result (`results`, `revisions`, `committed`, plus `diffs` on a dry run). The dry run (`dry_run` omitted or `true`) **plans through the kernel** in dry-run mode, so it fails exactly where the apply would.

`blocks_update` (with the other `blocks_*` sugar) resolves a block ref, pins `expect.content_hash` server-side, and runs one kernel `update`. Its `markdown` may parse to **several** sibling blocks: the target keeps its id and takes the first, the rest are inserted right after it with fresh ids; a list item may likewise be replaced by a multi-item list. The response adds `id` (the target) and `ids` (every resulting block, in order) to the kernel result.

`docs_plan_update`/`docs_update` are the whole-document path with SMART identity preservation: submit the complete proposed `content` and the engine reconciles it against the current stable block tree, preserving ids for recognizably-same structure, minting for new, tombstoning removals. `docs_plan_update` returns the executable opset + human-readable plan without writing; `docs_update` = plan + commit (`dry_run:true` is identical to `docs_plan_update`), refusing a stale plan with `stale_plan`. Convergence is verified by simulation: the opset's `converges` flag says whether replaying the ops reproduces `content` byte-for-byte, and when a lowering diverges `diagnostics[]` names the first differing byte offset and the proposed block (index/type/byte range) that failed to round-trip. `docs_update` refuses a non-convergent plan with `plan_not_convergent` — the message names the failing block and the first divergent byte, and `data.diagnostics` carries the full list (`update-opsets.md`).

`observe` (ADR-014) is the whole-file **sync-ingest** counterpart: it records `content` as the current authoritative bytes for `path` as an **observed-origin** commit — a write *around* the engine (mirroring an external edit) rather than `docs_update`'s api-origin write *through* it. Both reconcile against the block tree and preserve ids; only `origin` differs (and thus the change-feed semantics + matcher path). `observe` writes **no file** (it is the file→DB direction), so it works on a headless/sourceless server; it is idempotent (bytes matching the stored revision are an echo — `echo:true`, `rev:null`, no commit) and flags git conflict markers (`conflicted:true`). Mirror a deletion with `docs_delete`. Returns `{ docId, path, rev, commitId, converged, echo, conflicted, dispositions[] }`. `observe_many` is the batch form — an array of `{path, content}` under one timestamp + a single resurrection-pool sweep, returning one result per file. `observe`/`observe_many` are the single reconcile primitive (`observeOne`) that the local filesystem checkpoint and the external-source driver also share, so on-the-wire and in-process reconciliation cannot drift.

`observe_delete` (ADR-014) is the deletion counterpart: it records that `path` left the source scope by tombstoning the live doc as an **observed** deletion — its blocks are pooled for resurrection if the path reappears, and no file is removed (it is already gone from the source). Returns `{ docId, path, deleted }`; idempotent, so a path with no live doc is a no-op (`docId: null, deleted: false`). Contrast `docs_delete`: an api-origin, intentional, non-pooled removal that also unlinks the working-tree file. A synchronizer mirroring an external delete uses `observe_delete`, never `docs_delete`.

> **As-built:** these doc-level tools are registered in the MCP server and back the CLI's `new`/`mv`/`rm --doc`/`meta`/`update`. `docs_set_meta` takes `set` (keys to set) and `unset` (keys to remove) rather than a single `patch` object; the per-op `expect` CAS guard specced in 04 is implemented on kernel ops (via `expect.content_hash`), while the doc-level tools re-ingest the whole file and ride the in-process writer lock. MCP-originated writes are actor `agent:mcp`.

### History

```
history_node { id, limit? }                                  // a block's biography, newest first
diff { doc, from_rev, to_rev }                               // block-grain diff between two revisions
diff_unified { doc, from_rev?, to_rev? }                     // line-based unified (+/-) text diff; defaults to the last commit
docs_history { path_glob?, doc?, include_deleted?, limit? }  // per-document revision lists
changes_since { cursor?, origin?: "api"|"observed"|"import", limit? }  // repo-wide commit feed → { digests, cursor, truncated, head }
```
`history_node` returns the commits that touched a block with disposition kind/confidence/reason (no `cursor` param). `diff` is block-grain only (added/removed/changed blocks) — there is no `grain` param; both `from_rev` and `to_rev` are required and `doc` is id-or-path (a path is resolved first, so an unknown doc is a loud `doc_missing` rather than an empty diff). `diff_unified` is the line-grain sibling — the `omg diff` rendering: `{ doc, path, from, to, diff }` where `diff` is the `+`/`-` unified text between the two revisions' reconstructed file bytes. Its revisions are optional: `to_rev` defaults to the document's current revision and `from_rev` to the one before it, so a bare `{ doc }` answers "what did the last commit change here" (a single-revision document diffs against itself; a document with no revisions is `target_missing`). `docs_history` groups revisions BY DOCUMENT (each `rev`/`seq`/`commit`/`ts`/`origin`/`actor`/`contentHash`/`isCurrent`, oldest→newest); require one of `path_glob` or `doc`, `include_deleted:true` to also see tombstoned docs, `limit` caps documents with `truncated`. `changes_since` is the repo-wide COMMIT feed: `cursor` is the repo commit seq (NOT a `since_ts`; no `scope`/`min_confidence`), poll with your last cursor to cheaply re-orient after time away. The result is `{ digests, cursor, truncated, head }`: `cursor` is the last digest's `seq` (pass it back while `truncated`), and `head` is the repo's current max seq, so a caller can tell "nothing new" (empty page, `cursor == head`) from "this cursor is not from this repo/server" (`cursor > head`) — seqs are a dense per-repo order and a cursor is only meaningful against the `repo` it came from. Each digest's `revisions[]` carries `{doc, path, contentHash}` (contentHash = hex of the revision's rendered file hash), so a synchronizer can decide "changed vs echo" against what it last wrote without a follow-up `docs_read`; `origin` filters to commits a given writer produced. Feed a `rev` from any of these into `docs_read_at` (whole doc at that rev) or `diff` (changes between two revs).

### Admin

```
repos {}                      // list the workspace's repos: { repos: [{ slug, hasSource }] }
repos_status { repo? }        // repo counts (docs/blocks/commits/open edges/unconverged) + on-disk drift
sync_status { repo? }         // watcher/sync state: last commit seq, last checkpoint, convergent?
```
`repos` enumerates the workspace's repos so a client can pick a `repo` slug for any tool (ADR-014). `repos_status`/`sync_status` report on the addressed repo (or the bound default). `repos_status.disk` is a read-only working-tree scan (`changed`/`deleted`/`untracked`/`checked`). `sync_status.convergent` is true ONLY when the DB is converged AND a working-tree scan ran and found no drift — never green while disk freshness is unverified. There are no `repos_create`/`sync_flush` tools on this surface (repo lifecycle lives in the CLI/store, not the MCP server).

## 4. Tool-description contracts (write these into the MCP descriptions)

- IDs are stable within and across sessions; locators are display-only. Prefer IDs in follow-up calls (prompt-cache-friendly).
- After any conflict, the error already contains current state — retry from it, don't re-read.
- `links_retarget`/`links_repair` and any multi-doc macro: call with `dry_run: true` first (the dry run runs the kernel planner, so it fails where the apply would).
- Never rewrite whole documents to make small changes; use block ops. A blind `docs_put`-style blob overwrite intentionally does not exist — whole-document submissions go through `docs_update`/`docs_plan_update`, which reconcile against the block tree to preserve identity rather than replacing it. Reserve those for genuine whole-doc rewrites.
- `changes_since` with your last cursor is the cheap way to re-orient after time away.

## 5. Error codes

`stale_expectation` · `parent_missing` · `target_missing` · `block_missing` · `doc_missing` · `cycle_move` · `opaque_block` · `not_contiguous` · `type_mismatch` · `conflicted_document` · `path_taken` · `create_conflict` · `ambiguous_locator` · `ambiguous_heading` (candidate ids attached) · `node_not_editable` (editable-prop list attached) · `stale_plan` (a `docs_update` whose base changed) · `plan_not_convergent` (a `docs_update` whose opset cannot reproduce `content` byte-for-byte; `data.diagnostics` attached) · `filter_invalid` · `budget_exceeded` (partial result attached) · `semantic_unavailable` (no embedder configured) · `embedder_failed` (embedder IS configured but couldn't start — spawn/handshake/endpoint failure; `data: { provider, reason }`) · `sync_conflict` · `repo_not_found`. Shape: `{ error, message, data?, retriable: boolean }` — stable codes, prose free to improve.

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
