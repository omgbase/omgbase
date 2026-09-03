# omgbase — Projected Queries (deferred design)

**Status:** design sketch for a post-v1 feature. DO NOT BUILD in v1 — except the §8 reservations, which are v1 tasks.
**Sequencing:** after Stage 5 (retrieval) is stable; realistically a Stage 8.
**Depends on:** `01-architecture.md`, `02-data-model.md`, `05-graph-and-query.md`.

---

## 1. The feature

A fenced code block inside a Markdown document declares a query. The engine evaluates it and **projects** derived content — virtual blocks (lists, tables, embeds, aggregates) and/or derived edges — that render under the query block and, critically, **participate in the queryable corpus**: other queries, traversals, and agents can see projected facts as if they were materialized data.

```markdown
## Launch readiness

​```omg
from: blocks
filter: type == "task" && !attrs.checked && under_heading("Launch")
order: ["$path", "$ordinal"]
limit: 200
project: list(ref)
```

(The fence body is the standard query envelope as YAML — `10-query-language.md` §10 — plus the projection-only keys defined here.)
```

This is the document-hosted form of a **materialized view**. Formal shape: **non-recursive, stratified view composition** (nonrecursive Datalog; dbt's `ref()` DAG; a spreadsheet's dependency graph). Prior art and anti-art: Obsidian Dataview/Bases and Roam/Tana queries are view-time only — results invisible to other queries, grep, and git (the limitation this feature exists to transcend); Notion rollups compose but with opaque staleness; dbt is the healthiest analogy (queries whose outputs are inputs to other queries, cycles refused, topological builds).

## 2. Semantics: the load-path rule extended

Projected facts are **derived data** (canonicality category 3): never canonical, rebuildable, excluded from revision trees (virtual form), outside reconciliation, outside the resurrection pool, outside history storage.

- **Provenance class `projected`** joins `authored` and `inferred`. Projected ≠ inferred: inferred is fuzzy (similarity scores); projected is **deterministic given sources** — a different trust grade, filterable everywhere.
- **Determinism invariant:** projection output is a pure function of `(corpus revision, query text, evaluator version)`. No clock, no RNG, and **no LLM calls inside query blocks** — nondeterminism would break caching, time travel, and history honesty. "Dynamic structuring that needs judgment" is an agent's job, not a projection's.
- **Additive-only invariant:** projections create new derived facts; they NEVER mutate authored content or attrs. (No "auto-tag matching blocks" projection shape — that is action-at-a-distance writing to authored nodes.)
- **Time travel is free:** projections are not versioned. `as_of` evaluation recomputes the query against the historical revision. (File-materialized output is versioned trivially, as ordinary content.)

## 3. Identity of projections

Deterministic, derived — **no minting, no matcher involvement**:

```
projection_id = "v_" + hash(query_block_id, source_node_id, projection_shape)
```

Stable across refreshes while the source stays in the result set; stable across *query edits* for members that remain; survives the query block moving (query block identity carries via the normal matcher). Every projected fact carries `projected_by: <query block id>` and `derived_from: <source id>` — machine-legible lineage. `v_` ids are addressable in reads and traversals but **read-only**: a typed edit against one returns `projected_block_readonly` with the source id in the error (conflict-carries-truth ethos — the agent retargets to the source in zero extra reads).

## 4. Cycles and stratification (the "clear rules")

- **Stratum 0:** authored facts. **Stratum 1:** outputs of queries that read only base (`reads: base`, the default). **Stratum n+1:** outputs of queries that opt into `reads: projected`.
- A query may read only facts of **strictly lower stratum**. Its own output — and transitively, its descendants' — is never in its input. Recursion is refused, not managed.
- Dependency analysis is a **conservative over-approximation**: Q depends on R iff R's projection targets (block types, landing docs/paths, edge predicates) intersect Q's read scope. A cycle in the over-approximation ⇒ `circular_projection` error naming the chain, rendered as an error placeholder under the offending query block (spreadsheet-style; the document stays healthy).
- `projections.max_stratum` default **2** (one level of composition), config ceiling 3. Raise only with demonstrated need — composition depth is where both explosion and debuggability die.
- Evaluation: topological order by stratum, single pass, deterministic. No iterate-to-fixpoint machinery ever (that is the cut list's CRDT of this feature).

## 5. Explosion limits

- `limit` is mandatory-with-default (500; hard cap 5,000). Over-limit results truncate with an explicit trailing marker block ("… and N more, truncated") — the explicit-incompleteness rule applied to documents.
- Per-repo projected-fact budget (`projections.max_facts`, default 100k rows across virtual blocks + projected edges). Exceeding it marks queries stale-with-error in deterministic order; never silent partial state.
- Refresh is async (embedding-worker discipline): commit-driven dirty marking by read-scope intersection, debounced, stratum-ordered; projections carry `computed_at_commit` and readers see `stale: true` until drained. Incremental view maintenance (DBSP/Materialize-style) is explicitly not built; coarse invalidation + recompute is correct first and fast enough at the envelope.
- Projected query blocks appearing **inside** projected output are inert — never evaluated (kills quine-style geometric explosion at the root).

## 6. Projection shapes

| Shape | Emits | Indexing rule |
|---|---|---|
| `list(ref)` | List items referencing source blocks (rendered with source text) | **Not re-indexed** (would duplicate every source in FTS/vec) |
| `embed(n)` | Bounded transclusions of matching blocks | Not re-indexed |
| `table(cols…)` | Computed table over frontmatter/intrinsics | Indexed (novel content) |
| `count` / aggregates | Scalar/paragraph | Indexed |
| `edges(pred → node)` | Derived edges (e.g. `member_of` to a collection) from each result | n/a — novel graph facts |

Rule of thumb baked into defaults: **novel derived facts (edges, aggregates) are visible to API queries by default (provenance-filterable); copy/ref projections are opt-in** (`include_projected: true`) — so hub pages full of live task lists never double-count the corpus. This lands on semantics mrplex already reserved: its bare `$in`/`$has`/`$links()`/`$backlinks()` predicates are documented to "transparently widen to include query-derived (dynamic) membership in a future release," with `_static` variants pinned to authored links — omgbase inherits exactly that contract (`10-query-language.md` §6), so this feature is the release those reservations were waiting for.

`edges(member_of → col)` is the headline: **dynamic set membership**. It unifies with `collections.spec` stored queries (05-… §8) — when this ships, stored-query collections become sugar over the same evaluator, strata, and budget pool; a document-hosted query block MAY declare `backs: col_x`.

Projections are **flat** under their query block: no projected headings/sections in the first version (structure-affecting projections would feed back into `under()`/section ranges — a layout feedback loop). `group_by` renders cosmetic bold labels, not heading blocks.

## 7. Virtual vs. file-materialized

- **Virtual (default):** projections live only in derived tables; files stay byte-clean; engine reads (`docs_outline` etc.) render them inline marked `~`; convergence invariant untouched (render ignores virtual blocks).
- **File-materialized (per-query opt-in, later):** the engine writes results into an engine-owned fenced region below the query block, via the normal write protocol, as commits with **origin `projection`** (actor = query block id) — a fourth origin class keeping history honest (neither human intent nor observed edit). Generated regions carry `attrs.generated: true`, are skipped by the matcher (replaced wholesale per refresh), and are refresh-rate-limited. Human edits inside a generated region are detected at checkpoint; policy `on_human_edit: detach` (default — region becomes authored content, query flagged detached) or `overwrite`. Files-win is preserved: the engine never silently destroys human input.

Ship virtual-first. File materialization is the most visible half and the most dangerous (autonomous file writes, git merge conflicts in generated regions, commit noise); it earns its way in later.

## 8. V1 reservations (build these NOW — cheap seams that prevent foreclosure)

1. **Parser:** recognize ```` ```omg ```` fences as `type: "query"` blocks — inert (no evaluation), round-tripping, addressable, editable as leaves. Files authored with query blocks are valid from day one.
2. **Schema enums:** `edges.provenance` CHECK includes `'projected'`; `commits.origin` CHECK includes `'projection'` (already reflected in `02-data-model.md`).
3. **Edges lineage column:** nullable `via_node TEXT` on `edges` (NULL for authored; query block id for projected) — in the v1 DDL.
4. **Evaluator seam:** the query planner reads facts through an interface parameterized by fact-source, so `base` vs `base ∪ projected(stratum < n)` is a parameter, not a rewrite.
5. **ID namespace:** `v_` prefix reserved for derived/virtual nodes.
6. **Attrs + config namespaces:** `attrs.generated` reserved (matcher guard may land as a no-op now); `projections.*` config namespace reserved.

## 9. Failure modes catalog

`circular_projection` (chain named; placeholder rendered) · `projection_budget_exceeded` (truncated, flagged) · query CEL invalid (error placeholder; document healthy) · source deleted (ref-projections dropped at next refresh) · upstream changed (stale flag until refresh) · human edit in generated region (detach/overwrite policy) · query block deleted (projections dropped in same maintenance pass — projected facts never survive their query or their sources).

## 10. What this feature is not

Not recursion (strata forbid it) · not incremental view maintenance (recompute is fine at envelope scale) · not an in-document scripting language (CEL query + fixed projection shapes only) · not an LLM hook (determinism is load-bearing) · not a write mechanism onto authored content (additive-only) · not Dataview compatibility (one query language everywhere — the engine's own).
