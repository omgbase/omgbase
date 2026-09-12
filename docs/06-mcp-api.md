# omgbase — MCP / API Surface

**Status:** normative. Tool names use snake_case (MCP-safe, mrplex heritage).
**Depends on:** all preceding docs. The design metric is **agent reasoning round trips**, not call count.

---

## 1. Cross-cutting response rules

These four rules apply to every tool and are non-negotiable:

1. **Explicit incompleteness.** Every list-shaped result carries `truncated: boolean` and, when true, `cursor`. An agent must never have to guess whether it saw everything.
2. **Budgets are first-class.** Every hydrating tool accepts `budget_tokens` (server estimates ~4 chars/token, truncates at block boundaries, sets `truncated`). Traversals accept `budget: {max_nodes, max_edges}`.
3. **Conflicts carry current truth.** See `04-mutation-and-concurrency.md` §4.
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

### Read

```
docs_outline { doc | path, resolution?: "skeleton"|"outline"|"preview", depth?, section?: block_id,
               annotate?: ["tasks","edges","updated","confidence"], budget_tokens? }
```
Returns the indented compact text format (id, type, label per line), optionally scoped to one section. The workhorse orientation call.

```
docs_read { doc | path, include_ids? }
```
Reads a whole document in one call: `content` is the complete file bytes (verbatim — the same bytes `apply` writes to disk, fences/tables/list markers preserved), `metadata` is the document's structured property bag, plus `path`/`docId`/`rev`. The cold-start "read the guide before doing anything" call — mirrors mrplex `docs_get`. `include_ids:true` also returns the document's block ids in order for follow-up edits. This is a server-side projection over ordered blocks, not blob storage: identity stays block-level (`docs_read` reads; `apply` writes via block ops). `nodes_get` on a doc/heading id returns only that block — use `docs_read` for the whole document.

`metadata` is format-dependent, produced by the ingest adapter, not universally "frontmatter": for markdown it is the parsed frontmatter block (and, as adapters grow, may merge intrinsics — inline dataview-style fields, an h1-derived title); for a YAML or JSON file it is the parsed object the file represents; a bespoke adapter (say a `.trx` terminal-scrape format, or a `.js` file exposing its top-level exports) extracts whatever its format defines. `docs_read` returns whatever the adapter stored — it does not impose the markdown frontmatter model.

```
nodes_get { id | locator, resolution?, include?: ["children","ancestors","edges","history","section"] }
nodes_get_many { ids[], resolution?, budget_tokens? }        // ≤ 100 ids
resolve { query: "free text or partial locator", scope?: doc|path_glob, kinds?: ["block","document"], limit? }
```
`resolve` is hybrid search specialized for "give me the ID of the thing I mean" — returns ranked `{id, locator, preview, evidence}`.

### Search

```
query { …see 05-graph-and-query.md §4… }
pipeline { seed?, expand?, hydrate? }                         // §7 there
```

### Graph

Traversal is the OQX `follow` operator on the `query` tool (05-… §3, 10-… OQX `follow`), not a dedicated tool: `query { query: 'from docs where $path == "x.md" follow doc.out' }`. The structured `graph_traverse`/`graph_path`/`graph_subgraph` tools were removed.

### History

```
changes_since { cursor | since_ts, scope?: doc|path_glob, origin?: "api"|"observed",
                min_confidence?, limit? }
```
Returns commit digests: `{ commit, ts, origin, actor?, summary, revisions: [{doc, path}], dispositions?: compact }`. `summary` is a one-line rendering, e.g. `api(agent:claude): moved 1 block into 'Decisions' (d_dec…)` / `observed: design.md — 2 edited (conf ≥0.93), 1 inserted`. This is the change feed; `cursor` is the repo commit seq.

```
history_node { id, limit?, cursor? }      // block or doc biography from block_changes / revisions
diff { doc, from_rev, to_rev, grain?: "blocks"|"unified" }
```

### Mutate

```
apply { repo, ops[], origin, dry_run? }                       // 04-… §2 (the only real writer)
tasks_complete | sections_append | sections_rename | sections_move
| lists_insert_item | links_retarget                          // macros; same changeset machinery
docs_create { path, markdown, frontmatter? }                  // fails path_taken if it exists
docs_delete { doc }             docs_move { doc, to_path }     // delete tombstones + resurrection-poolable
docs_set_meta { doc, set?, unset? }                           // surgical frontmatter key patch
```

> **As-built (implemented):** the four doc-level tools are registered in the MCP server and back the CLI's `new`/`mv`/`rm --doc`/`meta`. `docs_set_meta` takes `set` (keys to set) and `unset` (keys to remove) rather than a single `patch` object; the `expect` CAS guard specced above is not yet implemented (doc ops re-ingest the whole file, so concurrent-edit protection rides on the writer lock, not per-doc CAS). MCP-originated writes are actor `agent:mcp`.

### Admin

```
repos_list {}   repos_create { slug, root_path }   repos_status { repo }
sync_status { repo }          // watcher state, pending checkpoints, convergence check result
sync_flush { repo }           // force a checkpoint now — read-your-own-writes after telling a human to save
```

## 4. Tool-description contracts (write these into the MCP descriptions)

- IDs are stable within and across sessions; locators are display-only. Prefer IDs in follow-up calls (prompt-cache-friendly).
- After any conflict, the error already contains current state — retry from it, don't re-read.
- `links_retarget` and any multi-doc macro: call with `dry_run: true` first.
- Never rewrite whole documents to make small changes; use block ops. (`docs_put`-style whole-body replace intentionally does not exist. Whole-file rewrites arrive only via the filesystem.)
- `changes_since` with your last cursor is the cheap way to re-orient after time away.

## 5. Error codes

`stale_expectation` · `parent_missing` · `target_missing` · `block_missing` · `doc_missing` · `cycle_move` · `opaque_block` · `not_contiguous` · `type_mismatch` · `conflicted_document` · `path_taken` · `create_conflict` · `ambiguous_locator` · `filter_invalid` · `budget_exceeded` (partial result attached) · `semantic_unavailable` · `sync_conflict` · `repo_not_found`. Shape: `{ error, message, data?, retriable: boolean }` — stable codes, prose free to improve.

## 6. Outline wire format

```
b_k2n8x4q h2  Risks                          §
b_9fw3mzt p   Stable block identity is quite…
b_p7c1vd0 ul
b_r5h6yja li  ☐ decide on id write-back
```
Column 1: the full block id (`b_…`), emitted inline so it can be dropped straight into a follow-up op — no alias table to resolve. `§` marks heading lines that own a section range. Checkbox glyphs for tasks. `annotate` flags append terse suffixes (`←3 refs`, `~2d`, `conf .82`).

## 7. Worked traces (acceptance fixtures for Stage 6)

**T1 — "Move this decision from Open Questions into Decisions."**
1. `docs_outline { path: "projects/omgbase.md", resolution: "outline" }`
2. `apply { ops: [ move(b_q4 → section(b_decisions), end) ] }`
Budget: 2 turns, < 1k tokens total.

**T2 — "Complete deployment-related unchecked tasks under Launch."**
1. `query { from:"blocks", filter:"type=='task' && !attrs.checked && under_heading('Launch')", semantic:"deployment" }`
2. `tasks_complete { blocks: […] }`
2 turns.

**T3 — "What changed since yesterday?"**
1. `changes_since { since_ts: -24h }` — 1 turn.

**T4 — "Which exact paragraphs depend on this document?"**
1. `query { from:"blocks", filter:"has_edge('depends_on','d_x') || has_edge('references','d_x')" }` — 1 turn.

**T5 — "Everything downstream of this assumption."**
1. `query { query: 'from docs where $path == "assumptions.md" follow doc.in depth 4' }` — 1 turn. (`follow doc.in` walks incoming edges — who depends on / references the seed.)

**T6 — "Refactor this long note into three notes, provenance intact."**
1. `docs_outline` → 2. `apply { docs_create ×2 + move runs }` (moves carry identity across docs) → 3. optional `links_retarget`. ≤ 3 turns.

**T7 — "Add a caveat to the design rationale for stable block identity."**
1. `pipeline { seed: semantic, hydrate: text }` → 2. `apply { insert after b }`. 2 turns.

**T8 — "Change this relationship everywhere it is asserted."**
1. `links_retarget { dry_run: true }` → 2. same `{ dry_run: false }`. 2 turns.

**T9 — "Find contradictions between these two regions."**
1–2. `pipeline` per region → agent judgment (deliberately not an engine feature).

These traces, with their turn budgets, are executable acceptance tests: a scripted agent (or replayed transcript) must complete each within budget against the fixture vault.
