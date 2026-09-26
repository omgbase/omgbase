# The omgbase surface specification

The surface is what a client sees: the OQX **query binding** that exposes the
store's docs, blocks, nodes and edges to the `@omgbase/oqx` engine, the
**read** operations that hydrate documents and blocks, the **history**
reads, and the **MCP tool catalog** through which agents call all of it (the
`omg` CLI is a second rendering of the same catalog — `docs/surface-map.md`).
Every component beneath it has its own spec; this directory specifies the
layer that turns those components into one addressable engine, so a second
implementation serves the same tools with the same results. It is owned by
neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/oqx-js/{context,run,planner}.ts`, `core/read/{document,reader,outline,nodes,refs}.ts`, `core/cursor.ts`, `graph/history.ts`, `mcp/{server,errors,graph}.ts` | **Reference.** |
| `omgbase` (Rust binary + `omgbase-surface` crate, crates.io) | `crates/omgbase-surface`, `crates/omgbase` | Conformance-first port: the binding over `omgbase-store`, the reads, the tool catalog served over MCP stdio, the CLI. |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/query-language.md`,
`docs/mcp-api.md`, `docs/surface-map.md`, `docs/graph-and-query.md` §3.

## Versioning

`VERSION` is `<major>.<minor>`; the crates track it. A field, relation,
intrinsic, tool or result key added bumps the minor; one removed or changed
in meaning bumps the major. The OQX *language* is `spec/oqx`'s; this spec
only binds it.

## The rule for changing the surface

**Fixture first, TypeScript (reference) second, Rust third.** §9 records the
reference oddities surfaced and the decisions taken.

## 1. The query binding

OQX (`spec/oqx`) runs on the in-memory engine over a **data context** that
resolves roots, fields, relations and functions against the store. A
pushdown planner may pre-filter in SQL; it must be invisible (planned ==
in-memory, the reference proves it by a differential suite), so this spec
describes the in-memory semantics only.

### 1.1 Roots and rows

`from docs | blocks | nodes | edges` and `$repo.docs | .blocks | .nodes |
.edges` scan the repo's **live** rows in a fixed order:

| root | rows | order |
| --- | --- | --- |
| `docs` | `docs` with `deleted_commit IS NULL` | `(path, doc_id)` |
| `blocks` | live blocks of live docs | `(doc path, block_id)` |
| `nodes` | `nodes` of live docs | `(doc path, node_id)` |
| `edges` | open edges (`to_commit IS NULL`) of live source docs | `(source doc path, edge_id)` |

`$repo` is an intrinsic of every scope (the root and any row): `$repo.$id`
is the repo id, `$repo.<root>` the scan above. A row's **identity** (for
`distinct`, `follow` cycles) is its id column. A relation returns rows of
its successor target; a scalar reach-through (`doc`, `block`) returns one
row.

### 1.2 Fields, intrinsics, reach-through, relations

**docs.** Intrinsics: `$id` (doc id), `$path`, `$content_hash` (hex of
`file_hash`, null when none), `$updated_at` (the current revision's commit
`ts`, null when none), `$body` (the reconstructed file, `spec/store` §6.1),
`$title`/`$tags` (the computed properties, null when absent). `format` is
the format column. `frontmatter` / `inline` are **source handles**:
`frontmatter.<k>` reads the key from that source only; `entries(frontmatter)`
yields one entry per **top-level** key in `key` order (bytewise), dotted
keys folded back into nested objects, each valued by the property rule
below. Any other bare identifier is a **property** (`spec/properties`):
the rows of that key across authored sources (frontmatter + inline, `ord`
order) — exactly one row with `card = scalar` → the decoded scalar;
otherwise the array of decoded values; no row → the nested object rebuilt
from keys under `<k>.` (undefined when none). A bare `id`, `path`,
`updated_at`, `content_hash` or `body` is a **loud error** (`filter_invalid`:
"did you mean the intrinsic") — use `frontmatter.<k>` to force the property.
`doc` is the row itself. Relations: `nodes` (the doc's nodes in **document
order**: block-less nodes first, then by the owning block's pre-order rank,
then `span_start`, then `node_id` — §9), `blocks` (live, **document order**:
pre-order over the tree — §9), `out` / `in` (distinct docs linked to / linking from, by open edges,
`(path, doc_id)` order), `out_edges` / `in_edges` (open edges, `(predicate,
edge_id)` order).

**blocks.** Intrinsics: `$id`, `$doc`, `$path` (owning doc's path),
`$body` (= `text`), `$content_hash` (hex `raw_hash`), `$updated_at` (the
latest commit `ts` among the block's `block_changes`, null when none). The
binding also defines `$ordinal` and `$depth`, but outside a `follow` the
engine's recursion intrinsics of the same names shadow them and they read
undefined (§9). Fields: `type`, `text`, `attrs` (parsed); any other bare
identifier reads `attrs.<k>` (undefined when absent). `block` is the row;
`doc` the owning doc. Relations: `children` (live, `(ordinal, block_id)`),
`nodes` (nodes anchored to the block, `(span_start, node_id)` order),
`out_edges` (open
edges from the block, `(predicate, edge_id)`), `section` (the `md:section`
nodes whose `[first_ordinal, last_ordinal]` contains the block's **top-level
ancestor's ordinal**, by `(first_ordinal, node_id)`).

**nodes.** Intrinsics: `$id` = `$node_id`, `$doc_id`, `$block_id`, `$path`.
Fields: `kind`, `name`, `value`, `attrs`; other bare identifiers read
`attrs.<k>`. `section` is the row; `doc` and `block` reach through (`block`
undefined when the node has none). Section relations (a node read as a
section; empty when it has no `first_ordinal`): `blocks` (live blocks whose
top-level ancestor's ordinal lies in the range, in document order),
`subsections` (`md:section` nodes contained in the range with a greater
`level`, by `(first_ordinal, node_id)`), `children` (contained deeper
sections with **no** intervening section of a level strictly between, same
order).

**edges.** Intrinsics: `$id`, `$src`, `$dst`, `$src_block`, `$via`,
`$from_commit`, `$path` (the source doc's path), `$dst_path` (the target
doc's path, null when not a doc), `$dst_uri` (the external node's URI, null
otherwise). Fields: `predicate`, `provenance`, `dst_kind`, `anchor`,
`src_field`. `doc` reaches the source doc. No relations.

### 1.3 Functions

Free: the `spec/oqx` builtins, plus `entries(<source handle>)` (§1.2) and
`range(x)` — a range passes through, a string is parsed per
`spec/properties` §2.2 into a range value, anything else is null. Row
functions (`text`, `semantic`, `under`, `under_heading`, `within`,
`under_kind`, `yaml_path`, `json_pointer`, `has_edge`, `has_anchor`,
`child_count`, `parent_type`) are written as free calls and evaluated
against the current row:

- `text("terms")`: `spec/search` §1.2 sanitize; empty → false; docs → any
  live block of the doc matches; blocks → the block's FTS row matches;
  nodes → the node's FTS row matches; edges → `filter_invalid`.
- `semantic("phrase")`: docs/blocks only (else `filter_invalid`); the phrase
  must have been embedded for this query (`semantic_unavailable` when no
  provider); the score is `cosine` over the row's stored vector for the
  provider's model (docs: `doc_embeddings`; blocks: the first `embeddings`
  row for the block's `raw_hash`) or null when none.
- blocks only (`filter_invalid` elsewhere): `under(id)` — `ancestor_path`
  contains `/id/` or the block is `id`; `under_heading(s)` — some section
  containing the block's top ordinal has a heading whose text contains `s`
  case-insensitively; `within(t)` — `t` a doc id → same doc, `t` with `*` →
  path `LIKE` (`*` → `%`, `%`/`_` escaped), else path equality;
  `under_kind(type[, name])` — an ancestor of that `type` (and text
  containing `name` or `attrs.key == name`); `yaml_path` / `json_pointer` —
  for `yaml:`/`json:` blocks, `attrs.key` equals the path or its leaf.
- `has_edge(pred[, dst])` (docs and blocks): an open edge with that
  predicate (and target) from the row; `has_anchor()` (blocks): an edge
  from the block carrying an anchor; `child_count()`, `parent_type()`
  (blocks).

### 1.4 The runner

`query(source, limit = 50, cursor?)` → `OqxResult { hits, truncated,
cursor, consumer, count?, exists?, none?, values? }`:

- `exists` / `count` / `none` consumers return the scalar and no hits.
- otherwise every hit is `{ id, path, ...projection }` (`$id`/`$path`
  injected); `first`/`single` return zero or one hit, no cursor.
- `collect`: a top-level `select distinct` dedups hits by the user
  projection (first wins), the query's own `limit`/`offset` (integer
  literals only, else `filter_invalid`) bound the set after that, then the
  page: with the default order the keyset cursor `(path, id)` skips rows at
  or before the cursor, `cap = limit`, `truncated` = more remained, `cursor`
  = the last hit's `(path, id)` when truncated; a custom `order by` disables
  the cursor (the top `cap` is returned, `truncated` still honest).
- `values`: the single projected item is returned as `values: [...]` with
  `hits` empty.
- Errors: an OQX error is `filter_invalid` with the engine's message; a
  malformed cursor is `filter_invalid` naming the surface.

Cursors are `base64url(JSON [parts...])`: `[path, id]` for `query`,
`[path]` for `docs_list`/`docs_tree`.

## 2. Reads

- **`resolve_ref(ref)`**: an `n_` + 12 hex node id → its block when the block
  is live, else its doc; a `b_` id → its live block; a `d_` id → the live doc;
  anything else → the live doc at that path; null when nothing matches.
- **`docs_read(doc, include_ids?)`**: `{ path, doc_id, rev, properties
  (grouped, spec/properties §5), content (spec/store §6.1) }` + with ids
  `ids` (pre-order), `hashes` (id → hex `raw_hash`), `parents` (id → parent
  id or null). `docs_read_many(refs, include_ids?, budget_tokens?)`:
  first-seen dedup, cap 100 (`truncated`), a miss → `errors: [{ ref, error:
  "doc_not_found" }]`, the budget (`ceil(JSON length / 4)` per item) stops
  early with `truncated`. `docs_read_at(doc, rev)`: `spec/store` §6.2 plus
  `properties` (current) and `properties_are_current: true`.
- **`nodes_get(doc?, id, resolution = full)`**: the block subtree projected
  at a resolution — `skeleton` `{ id, type, label = heading text or type }`,
  `outline` `{ id, type, label = first 12 words… }`, `text` `{ id, type,
  text }`, `raw` `{ id, type, raw, content_hash }`, `full` (`raw`,
  `content_hash`, `text`, `attrs`, `placement { parent, ordinal, depth }`);
  `children` recursively. `nodes_get_many(doc?, ids, resolution = text,
  budget_tokens?)`: cap 100, request order, no children, `unresolved` for
  ids naming no live block (or one outside the scoping doc), `truncated`
  on the cap or the budget.
- **`docs_outline(doc, resolution = outline, depth?, budget_tokens?)`**:
  one line per block, `"  " × depth + id + " " + type label padded to 4 +
  " " + label`, `"  §"` appended for headings, trailing spaces trimmed; type
  labels `h<level>`, `p`, `ul`, `li` (list items and tasks), `bq`, `code`,
  `tbl`, `tr`, `hr`, `html`, `raw`; labels: containers `""`, tasks `☐`/`☑` +
  ten words, others ten words (`…` when cut), `skeleton` none; `depth`
  limits nesting; the budget (`ceil(line length / 4)`) truncates.
- **`docs_list(path_glob?, limit = 200, cursor?, budget_tokens?)`**: live
  docs by path, `path LIKE glob` (`*` → `%`, `%`/`_`/`\` escaped), rows
  `{ path, blocks (live count), ts (current revision's commit ts or null) }`,
  fetched `limit + 1`, keyset cursor `[path]`, budget as above (at least one
  row). **`docs_tree(path?, depth = 1, …)`**: the prefix normalized (no
  leading `/`, trailing `/` unless empty); every live doc under it collapsed
  at `depth` segments into `dir` entries (`path` ending `/`, summed `docs`
  and `blocks`, max `ts`) or `doc` entries; `total` over everything under
  the prefix; ordered by path and paged the same way.

## 3. History

Result keys in §2–§4 are written in the reference's **camelCase** on the
wire (`docId`, `contentHash`, `isCurrent`, `hasSource`, `blockId`,
`renderedHashMatch`, `propertiesAreCurrent`, …); the fixtures pin the wire
verbatim, and this prose uses snake_case only as a naming convention.

- **`history_node(id, limit = 100)`**: the block's `block_changes` joined to
  commits and dispositions, newest first: `{ commitId, seq, ts, origin,
  kind, confidence, reason }`.
- **`diff(doc, from_rev, to_rev)`**: both revisions must belong to the doc,
  else `target_missing` (§9: the reference treated an unknown revision as
  empty and reported every block removed); block-grain — the id → raw maps
  of both revisions' Merkle trees (all depths); entries `removed` (in from
  only), `changed` (raw differs), `added` (in to only), in that order,
  `before`/`after` as applicable. **`diff_unified(doc, from_rev?, to_rev?)`**:
  defaults to the previous and current revisions (`target_missing` when
  none); `{ doc, path, from, to, diff }` where `diff` is a line-by-line
  positional diff of the two revisions' raws joined by `\n` — for each line
  index where they differ, `- old` then `+ new` (§9: not a real diff
  algorithm).
- **`changes_since`**: `spec/sync` §6 (the digest shape and paging;
  `summary` unpinned).
- **`docs_history(path_glob | doc, include_deleted?, limit = 50)`**: docs by
  path (glob as `docs_list`; a glob without `*` is an exact path), live only
  unless `include_deleted`, `limit + 1` for `truncated`; each `{ doc_id,
  path, deleted, current_rev, versions: [{ rev, seq, commit, ts, origin,
  actor, content_hash, is_current }] }` oldest first.

## 4. The MCP tool catalog

Served as MCP over stdio; every result is one text content item holding
JSON; an error result has `isError: true` and the envelope `{ error: <code>,
message, data?, retriable }`. Codes: `spec/mutate` §8 plus `filter_invalid`
(OQX and cursor errors, `data: { reason, hint }`), `budget_exceeded`,
`semantic_unavailable`, `embedder_failed`, `repo_not_found`,
`ambiguous_heading`, `conflicted_document`, `ambiguous_locator`,
`seed_unresolved`. Any other failure is `repo_not_found` with the message
(§9).

**Repo scoping.** Every repo-scoped tool takes an optional `repo` slug;
omitted → the server's default repo; unknown → `repo_not_found`. A repo's
root is derived (`spec/sync` §1); a mutating tool on a sourceless repo fails
`repo_not_found` ("mutation disabled").

**Ref resolution (server side).** `doc` fields accept an id or a path;
`path` fields a path; a block-level tool's `block`/`blocks`/`to`/`at` refs go
through `resolve_ref` (a doc ref as `to` means the document's top level);
`heading` accepts a heading block id or heading text (an ATX-looking text
loses its hashes; matched against the normalized heading text repo-wide or
within `doc`/`path`; zero → `parent_missing`, several →
`ambiguous_heading { heading, candidates }`). Block-level tools pin
`expect.content_hash` from the live row when the caller omits it.

| Tool | Args | Result |
| --- | --- | --- |
| `docs_outline` | `doc?`, `path?`, `resolution?`, `depth?`, `budget_tokens?` | §2 |
| `docs_read` | `doc?`, `path?`, `include_ids?` | §2 |
| `docs_get_many` | `docs[]`, `include_ids?`, `budget_tokens?` | §2 |
| `nodes_get` | `doc?`, `path?`, `id`, `resolution?` | §2 (doc inferred from the block) |
| `nodes_get_many` | `doc?`, `path?`, `ids[]`, `resolution?`, `budget_tokens?` | §2 |
| `read_ref` | `ref`, `resolution? = raw` | `{ kind: "document", ...docs_read }` or `{ kind: "block", ...nodes_get }` |
| `docs_tree` / `docs_list` | §2 args | §2 |
| `query_syntax` | — | `{ syntax }` (reference text, unpinned) |
| `query` | `query`, `limit?`, `cursor?` | §1.4; `semantic(...)` with no provider → `semantic_unavailable` |
| `graph` | `roots[]`, `degrees? = 1`, `direction? = both`, `predicate?`, `select?[]`, `max_documents? = 200` | `{ documents: [{ id, path, degree, frontier, ...select }], edges: [{ id, src, dst, dst_path, dst_uri, predicate, provenance, dst_kind, anchor, src_field }], frontier, truncated, queries, degrees }` — compiled to `follow doc.out`/`doc.in` with `depth = degrees + 1` (≤ 8, so `degrees` clamps to 7 and the result reports the clamped value), roots depth 0; documents ordered bytewise by path (§9); a `$path` projection collapses onto the existing `path` key |
| `text_search` | `q`, `limit?` | `spec/search` §1.3 |
| `resolve` | `query`, `limit?` | `spec/search` §4 (vector fused when a provider exists) |
| `apply` | `ops[]`, `reason?`, `dry_run?` | `spec/mutate` §4, `origin.actor = "agent:mcp"` |
| `blocks_insert` | `to`, `markdown`, `at? = end`, `dry_run?` | the apply result |
| `blocks_update` | `block`, `markdown?`, `checked?`, `attrs?`, `expect?`, `dry_run?` | `{ id, ids, ...apply result }` (`checked` folds into attrs) |
| `blocks_move` | `blocks[]`, `to`, `at?`, `dry_run?` | a doc ref as `to` must be the blocks' own document, else `target_missing` |
| `blocks_remove` | `blocks[]`, `dry_run?` | |
| `blocks_split` | `block`, `at[]` (bytes), `dry_run?` | |
| `blocks_merge` | `blocks[]`, `separator?`, `dry_run?` | |
| `tasks_complete` | `blocks[]`, `checked? = true`, `dry_run?` | |
| `node_set` | `node`, `prop`, `value`, `dry_run?` | |
| `sections_append` | `heading`, `markdown`, `doc?`, `path?`, `dry_run?` | |
| `docs_append` | `doc?`, `path?`, `text` | (no dry run) |
| `links_retarget` | `from_target`, `to_target`, `path_glob?`, `dry_run? = true` | `{ hits, pairs, applied, ...apply result }` |
| `links_stale` | `path_glob?`, `limit? = 500`, `summary?` | `spec/graph` §6 shapes |
| `links_repair` | `repairs[]` or `from_target`+`to_target`, `path_glob?`, `dry_run? = true` | as retarget; neither given → `target_missing` |
| `docs_create` / `docs_move` / `docs_delete` / `docs_set_meta` | `spec/mutate` §6 args | its results |
| `docs_plan_update` | `doc`, `content` | `{ opset, plan }` (`plan` = the rendered one-line-per-op text) |
| `docs_update` | `doc`, `content`, `reason?`, `dry_run?` | `{ opset, plan, result }` |
| `observe` / `observe_many` / `observe_delete` | `spec/store` §5 | its outcomes (`observe` sweeps the pool) |
| `history_node` | `id`, `limit?` | §3 (not repo-scoped) |
| `diff` / `diff_unified` / `docs_read_at` / `docs_history` / `changes_since` | §3 | §3 |
| `repos_status` / `sync_status` | `repo?` | `spec/sync` §4.4 |
| `repos` | — | `{ repos: [{ slug, has_source }] }` by slug |

Dry runs never trigger the host's post-mutation hook (the embed drain);
successful writes do.

## 5. The CLI

`omg` is the same catalog in verb form (`docs/surface-map.md` is the
bijection); this spec pins the catalog, not the terminal rendering. A Rust
`omgbase` binary serves `omgbase mcp` from the same crate and may render the
verbs later.

## 6. Fixtures

- **corpus-backed query cases**: a suite carries `corpus: { "<path>":
  "<source>", … }` (the reference's alchemy repository, 18 documents, copied
  from `packages/core/corpus/oqx/fixtures/alchemy`; a test keeps the
  embedded copy equal to the files) observed into a fresh repo
  (`spec/store` §9.4 minter, one `observe` batch in bytewise path order at
  `2026-09-27T00:00:00.000Z`, so `d_0` is `index.md`), then `cases: [{ name,
  notes?, query, limit?, cursor?, expect }]` with `expect` the `OqxResult`
  as JSON (absent keys for undefined projections; numbers within 1e-9) or
  `{ error: "filter_invalid", message_includes }`. The reference runs every
  case both planned and in-memory and fails on any difference. Suites:
  `query-docs.json`, `query-blocks.json`, `query-nodes.json`,
  `query-edges.json`, `query-follow.json`, `query-functions.json`,
  `query-errors.json`.
- **`reads.json`**: observation scripts (`spec/store` §9.4) with `read`
  steps — `{ "read": { "tool": "<name>", "args": {...}, "ts"? } }` — invoked
  through the MCP server itself (the reference connects an SDK client over an
  in-memory transport and calls the tool); the outcome is the tool's JSON
  result, or `{ error, retriable, data? }` for an error result (`message`
  dropped; `data` dropped for `filter_invalid`; `changes_since` digests lose
  `summary`). A case with `workspace: true` gives the default repo a
  temporary directory as its `fs` source and server root, seeded from the
  `observe` steps, so writing tools work (file-CAS included) and `repos`
  reports `hasSource: true`; without it the repo is sourceless and every
  writing tool fails `repo_not_found`. `ts` pins the clock for the call
  (write tools stamp commits with "now"). Write tools are pinned by
  `spec/mutate`; `read` steps still record their results.
- **`cursor.json`**: `{ name, parts | (cursor, arity), expect }` encode /
  decode cases (`{ cursor }`, `{ parts }` or `{ error: "filter_invalid" }`).

- **`interop.json`** (§7): the cross-engine suite. The suite carries the
  alchemy `corpus` like a query suite; each case is `{ name, notes?, ts?,
  writes?: [{ tool, args }], reads: [{ tool, args }], expect: { writes,
  reads } }`. It is run by a different harness from the other suites (both
  engines as separate processes over MCP stdio, every writer × reader
  combination) — `packages/core/corpus/surface/interop.test.ts` and
  `crates/omgbase/tests/interop.rs`; `spec.test.ts` and the surface crate's
  `spec.rs` validate its shape and otherwise leave it to them.

**Generation.** `packages/core/corpus/surface/spec.test.ts`,
`SURFACE_SPEC_UPDATE=1` (also regenerates `interop.json` through the
interop harness, TypeScript writing and reading). **Allowlist (Rust).**
`crates/omgbase-surface/tests/spec-passing.txt`, `SURFACE_SPEC_UPDATE=1`.

## 7. Cross-engine interop

Everything above is specified so that two engines can serve **one
database**. §7 pins the payoff no single-engine fixture reaches: a workspace
built by either engine is served by the other with identical results, for
every read tool, and a workspace written *through* either engine's tools
reads identically from both. An engine that passes every other suite but
fails here has a divergence the fixtures' in-process runners could not see
(random ids, wall-clock stamps, a table only one engine maintains, a wire
key spelled differently on the two transports).

### 7.1 The test seams

Both binaries honor two environment variables, **for conformance runs
only** (never set in production; an engine may refuse them outside a test
build but must honor them when it accepts them):

- `OMGBASE_SPEC_MINTER=sequential` — install the fixture minter of
  `spec/store` §2.2 for the process (`d_0, d_1, …`, each prefix counting from
  0 independently, counters fresh at process start).
- `OMGBASE_SPEC_CLOCK=<RFC 3339>` — "now" for the process is that instant:
  every commit stamped by a tool call, every `ts` a tool reports as current.
  A reader never needs it; a writer always runs under it.

The reference reads them in `omg mcp` (`packages/cli/src/cmd/mcp.ts`), the
port in `omgbase mcp` (`crates/omgbase/src/main.rs`).

### 7.2 The workspace

A case runs in a fresh temporary directory `W`:

1. The harness writes the suite's `corpus` into `W` as files, bytes
   verbatim (`W/<path>`), and bootstraps the database `W/.omgbase/omgbase.db`
   with **its own engine** under the fixture minter: `ensure_repo("fixture",
   W)` of `spec/sync` §2 — repo `rp_0` (slug `fixture`) attached to the `fs`
   source `fixture-fs` (`src_0`) rooted at `W`; **no documents**. The two
   engines' `ensure_repo` write the same rows (the sync fixtures pin them), so
   the bootstrap is not part of what interop compares, and no `d`/`b`/`c`/`r`
   prefix has been minted when the writer starts.
2. The **writer** is spawned as an MCP server over stdio on `W` with the §7.1
   seams (`OMGBASE_SPEC_CLOCK` = the case's `ts`, default
   `2026-09-27T00:00:00.000Z`) and without a watcher (`omg mcp -C W
   --no-watch`; `omgbase mcp --workspace W`). The harness calls
   `observe_many` once with every corpus file in bytewise path order (so
   `d_0` is `index.md`, as in the query suites), then each of `writes` in
   order. Each result is recorded (§7.3). The writer is then closed (stdin
   EOF) and the harness waits for it to exit.
3. The **reader** is spawned the same way on `W` and each of `reads` is
   called in order and recorded; then closed.
4. The recorded `writes` and `reads` must equal the case's `expect`.

Every case runs for every `(writer, reader)` in `{typescript, rust}²`: the
two same-engine pairs prove each engine is consistent with the committed
expectation over stdio; the two cross pairs are the interop gate. `expect`
is generated by the reference pair (TypeScript writing and reading). A
harness cleans `W` up afterwards.

### 7.3 What is compared

Outcomes are recorded as `reads.json` records them (§6: the parsed JSON
result, or `{ error, retriable, data? }` with `data` dropped for
`filter_invalid`; `changes_since` digests lose `summary`), with one more
normalization: every string equal to `W`, or beginning with `W` followed by
`/`, has that prefix replaced by `<workspace>` (the temporary directory
differs per run; a tool that reports absolute paths still compares).
Numbers compare within 1e-9. `query_syntax` is not compared (its text is
unpinned).

The suite's cases call **every read tool** of §4 at least once over the
corpus, and every writing tool at least once followed by reads that show
its effect (a `blocks_update` then `docs_read`, `docs_history`,
`changes_since`, `diff`; a `docs_move` then `docs_tree`, `links_stale`; a
`docs_create` then `graph`; …). `apply`'s file-CAS holds in the writing
engine's working tree, so a write through one engine and a later read of
`repos_status`/`sync_status` through the other exercises the sync tables
(`file_stats`, checkpoints) both engines must maintain alike.

### 7.4 Peers

The TypeScript harness finds the port at `$OMGBASE_RUST_BIN`, else
`<repo>/target/debug/omgbase`, else `<repo>/target/release/omgbase`; the
Rust harness finds the reference at `$OMGBASE_TS_MCP` (a command line whose
argv the harness extends with `mcp -C W --no-watch`), else `node
<repo>/packages/cli/dist/src/main.js`. A missing peer **fails** the cross
pairs with the build command in the message (`cargo build -p omgbase`;
`pnpm build`); `OMGBASE_INTEROP=skip` turns that into a skip (for a host
without the other toolchain). `pnpm interop` at the repository root builds
both and runs both harnesses.

## 9. Reference oddities surfaced while specifying, and decisions

- **Fixed — `docs.nodes` and `blocks.nodes` had no order**, and `blocks`
  relations ordered by sibling ordinal across depths (nested children before
  later top-level blocks). Now document order for both: nodes by their
  owning block's pre-order rank, then `span_start`, then `node_id` (an id
  order would reshuffle on every fresh ingest, since `node_id` hashes the
  random doc id); blocks in pre-order (`query-functions::nested-collect-distinct`,
  `query-docs::relation-blocks-in-document-order`).
- **Fixed — `diff` with an unknown revision reported every block removed.**
  Now `target_missing`.
- **Fixed — `graph` ordered documents with `localeCompare`.** Bytewise now.
- **Pinned — `$ordinal`/`$depth` on blocks are shadowed** by the engine's
  recursion intrinsics outside a `follow` (they read undefined). The fix
  belongs to `spec/oqx` (recursion intrinsics fall through to the context
  when no walk is active) and is recorded there as a candidate minor.
- **Pinned — an empty-projection nested `collect { }` yields the raw store
  row** (store columns, `attrs` as a JSON string, the join column `__path`).
  A port reproduces the same keys. Recorded for a decision (a `{ id, path }`
  projection would be a minor here).
- **Pinned — budgets are asymmetric.** `docs_get_many`/`nodes_get_many`
  return zero items when the first exceeds `budget_tokens`; `docs_list`/
  `docs_tree` always return one row.
- **Pinned — `semantic()` without a provider is `filter_invalid` at the
  runner** ("needs an embedding provider"); only the `query` tool pre-checks
  and reports `semantic_unavailable`.
- **Pinned — wikilinks resolve by path**, so a `[[slug]]` whose slug is not a
  path is a phantom edge (`spec/graph` §3.2); the alchemy corpus's `out`/`in`
  never reach documents through wikilinks.
- **Pinned — the cursor decoder is lenient** (standard-alphabet base64 and
  `=` padding are accepted).
- **Pinned — dry runs consume minted ids** (a dry-run insert advances the
  `b` counter).
- **Pinned — `nodes_get` with an unknown block id is `doc_missing`** (the doc
  is inferred first); a block outside an explicit `doc` scope is
  `block_missing` without data.
- **Pinned — `$tags` is body hashtags only** (`spec/properties` §3.3); a
  corpus without `#tags` in prose has `$tags` null everywhere.
- **Port notes.** Argument-shape failures (the reference's MCP/zod
  validation) are unpinned; the Rust catalog reports them as `filter_invalid`
  with `reason: "arguments"`. The `frontmatter`/`inline` source handles are
  lazy in the reference and materialized eagerly in the port (same values;
  `size(frontmatter)` would differ — unpinned). Blob columns leaking through an
  empty-projection collect are hex in the port and a Node `Buffer` object in
  the reference (unexercised). The Rust port runs every query in memory
  (no pushdown planner yet — the spec describes in-memory semantics only);
  its binary serves a hand-rolled JSON-RPC 2.0 stdio transport, honors the
  §7.1 seams, and does not yet wire the filesystem watcher or the background
  embed drain. The `oqx`
  `DataContext::get` has no error channel, so the port surfaces the
  reserved-basename guard after the run; a future `oqx` minor may add one.
- **Pinned — `diff_unified` is positional.** It compares the two revisions'
  raws line by line at equal indices, so one inserted line makes every
  following line a `-`/`+` pair. Recorded for a decision (a Myers diff is a
  minor here).
- **Pinned — the catch-all error is `repo_not_found`.** An unexpected
  exception in a tool is reported under that code with its message.
- **Pinned — `history_node` is not repo-scoped**; block ids are global.
- **Pinned — `entries(frontmatter)` is in key order**, not authored order
  (`ord` positions only within a list-valued key).
- **Pinned — `semantic()` on blocks reads the first cache row for the
  block's content hash**, whatever its context (see `spec/search` §8).
- **Pinned — `blocks_split` sends an empty `content_hash`** when the block
  has no live row, so the kernel raises `stale_expectation` with the current
  hash rather than `block_missing`.

## Decisions

- 2026-09-27, surface 1.0 specified as built. Last spec of the series: with
  it, a Rust `omgbase` binary can be conformance-tested end to end.
- 2026-09-26, surface 1.1: §7 cross-engine interop — one database, two
  engines, every read tool compared over MCP stdio in both directions — and
  the two test seams (`OMGBASE_SPEC_MINTER`, `OMGBASE_SPEC_CLOCK`) that make
  a committed expectation possible across processes. No field, tool or
  result key changed.
