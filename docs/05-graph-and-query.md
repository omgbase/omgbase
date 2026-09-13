# omgbase — Graph, Query, and Retrieval Spec

**Status:** normative.
**Depends on:** `01-architecture.md` §8–9; `02-data-model.md` §3–4.

---

## 1. Edge principles

1. **Derived from content, never inherited through identity.** Extraction is a pure function of `(revision content, extraction_version)`. Block identity threads only the validity intervals (edge history).
2. **Block-grain truth, doc-grain speed.** `edges` rows originate from blocks (or frontmatter); `doc_edges` is a materialized rollup.
3. **Inferred is quarantined.** `inferred_edges` is a separate table; excluded from every query/traversal unless `include_inferred: true`; every row carries method/score/model_v.
4. **Structural relations are not edges.** parent/child/next/prev live in Placement; the traversal API presents them as pseudo-predicates (`contains`, `contained_by`, `next`, `prev`) dispatched to the blocks table.

## 2. Extraction rules (extraction_version: x1)

Run per touched document inside the commit transaction:

| Source | Edge | Provenance |
|---|---|---|
| Inline link `[t](/path/doc.md)` or `[t](/path/doc.md#Heading)` | `src_block —references→ d_target` (+`anchor`) | `link` |
| Wikilink `[[note]]`, `[[note#Heading]]`, `[[note^ref]]` | same; `^ref` targets resolve to `dst_kind: block` when the anchor is known | `link` |
| Autolink / bare URL | `src_block —references→ x_<normalized-uri>` | `link` |
| Frontmatter field whose value(s) are repo paths or wikilinks, e.g. `depends_on: [/a.md]` | `doc —<field>→ target` with `src_block = NULL, src_field = <field>` | `frontmatter` |
| Inline field `key:: [[target]]` (Dataview convention; also `key:: /path.md`) | `src_block —<key>→ target` | `inline_field` |
| Image `![alt](path)` | `src_block —embeds→ x_/d_` | `link` |

- Unresolvable internal targets mint a **phantom document node** (`dst_kind:"document"`, `dst_node` = path-keyed placeholder) so backlinks appear the moment the target is created. Phantoms are flagged in results.
- Predicates are freeform lowercase snake_case from field/key names; `references` and `embeds` are reserved.
- Interval maintenance at commit: diff extracted set vs currently-open rows for the doc → close missing (`to_commit = this`), open new (`from_commit = this`). Unchanged rows untouched. `doc_edges` rollup recomputed for the touched doc in the same transaction.

## 3. Traversal API

**Update:** the structured `graph_traverse` / `graph_path` / `graph_subgraph` specs (and the `omg graph` CLI command) were **removed**. Traversal is now the OQX `follow` operator, part of the one `query` surface — no separate graph query language, still (ADR-006).

`follow` makes a query recursive over a **type-preserving relation** (the relation's successor type equals the query target). The `where` seeds the walk; `follow <relation>` expands each hop. Relations today:

- `doc.out` / `doc.in` (docs→docs) — the authored citation graph: outgoing links / backlinks. Replaces `direction: "out"|"in"` traversal of the edge graph. **Predicate-filtered** via `follow doc.out { via <edge predicate> }` — an edge-scoped predicate (compiled against the `edges` target, e.g. `via predicate == "depends_on"`) filtering which authored edges license each hop, distinct from the successor `where` (which filters the reached doc).
- `block.children` (blocks→blocks) — the block subtree.
- `section.children` (nodes→nodes) — immediate child `md:section` nodes (the outline depth ladder); `section.subsections` — the whole transitive sub-tree.

Knobs go in a `{ … }` block after the relation (a bare `follow <rel>` carries none): `follow <rel> { where <pred> }` filters which successors keep participating (running out ⇒ a leaf); `{ frontier <pred> }` cuts a relation that would otherwise continue; `{ depth <n> }` bounds the walk (1..8, default 8); `follow distinct` dedups by identity; `follow <rel> { by <expr> }` sets the identity used for cycle detection + dedup — e.g. `follow doc.out { where layer != "draft" frontier layer == "canon" depth 4 }`. Each reached row carries recursion metadata `$depth` (seed = 1), `$stop` (interior|leaf|frontier|depth|cycle, with `$leaf`/`$frontier` sugar), and `$ordinal` (deterministic walk rank) — queryable in `select`/`order by` and filterable post-walk in the top-level `where`. Cyclic graphs are safe: a revisited node is admitted once as `$stop == "cycle"` and never re-expanded.

- The induced-subgraph analytics export (`graph_subgraph`) has no OQX equivalent and was dropped with the rest.
- Extraction, the edge tables, and interval validity (§1–§2) are unchanged — only the query-time traversal surface moved.

## 4. Query

```jsonc
{
  "from": "blocks",                          // "docs" | "blocks"
  "filter": "type == 'task' && !attrs.checked && under_heading('Launch') && doc.layer == 'working'",
  "text": "deploy",                          // FTS5 over block text (docs: over doc text)
  "semantic": "deployment readiness",        // optional; requires embedding hook
  "select": ["$id", "$doc", "$path", "$locator", "$text"],
  "resolution": "text",
  "limit": 50, "cursor": null
}
```

**The query language is normatively specified in `10-query-language.md`** (envelope, targets, CEL subset grammar, absence semantics, structural functions, ordering, compilation contract). Summary only here:

- **Targets:** `docs` (metadata keys bare — frontmatter in markdown, the parsed object for YAML/JSON; `$`-intrinsics), `blocks` (`type`, `attrs.*`, `text`; `$id`/`$doc`/`$path`/`$locator`/`$ordinal`/`$depth`/`$updated_at`; doc metadata via `doc.<key>`), and `edges` — the open authored edge rows themselves (`predicate`/`provenance`/`dst_kind`/`anchor`/`src_field`; `$src`/`$dst`/`$dst_path`/`$dst_uri`; source-doc reach-through via `$path`/`doc.<key>`), so the graph is queryable directly rather than only via `has_edge`/`$links`/`follow` (10 §2). mrplex CEL semantics carry over (missing key never matches; `list()` polymorphism; string fns; `_static` link-predicate variants).
- **Structural functions (blocks target),** compiled to indexed SQL: `under()`, `under_heading()`, `within()`, `has_edge()`, `has_anchor()`, `parent_type()`, `child_count()` (final set per 10-… §5 — object-returning `parent()`/`ancestors()` were dropped as not worth their compiler).
- **Link-graph predicates (docs target),** mrplex-compatible: `$in(glob)`, `$has(glob)`, `$links()`, `$backlinks()` + `_static` variants with the reserved widening semantics (10-… §6).
- Modes intersect (AND). Order: semantic score if present, else text rank, else `$updated_at` desc.
- CEL compilation: compile the supported subset to SQL WHERE; anything else evaluates as a post-filter over candidate rows (correct first, fast where it matters). `filter_invalid` errors carry reason + hint.

## 5. Hybrid retrieval & ranking

- Lexical: FTS5 (`bm25()`), block grain.
- Vector: sqlite-vec over current block embeddings.
- Fusion: **RRF** — `score(d) = Σ 1/(60 + rank_i(d))` over the active rankers.
- Boosts (multiplicative, explainable, config): title match ×1.25, heading-chain match ×1.15, path segment match ×1.10, layer (`canon` ×1.30, `working` ×1.15, `proposed` ×1.0, `draft` ×0.85), recency half-life 180d ×[0.9–1.1].
- Every hit returns `evidence: { fts_rank?, cosine?, boosts: {…} }`.
- No learned ranker in v1 (ADR-009).

## 6. Embeddings

- **Unit:** paragraphs, list items/tasks, table rows, headings; blocks < 24 tokens roll into their section aggregate instead of embedding alone.
- **Input text:** `"{doc title} · {path} · {heading chain} · {block type}\n{block text}"`. Queries embed bare.
- **Key:** `(content_hash, ctx_hash, model)` — pure content addressing; identity errors cannot poison the cache.
- **Worker:** async queue; recompute on content or ancestry-context change (heading rename invalidates its subtree's contexts — batched); retrieval serves stale vectors flagged `stale: true` until drained.
- **Hook:** embedding provider is a configured hook (HTTP or local); config names the provider explicitly (`embedding.provider`, `embedding.egress_note`) because vault text leaves the machine. No provider configured ⇒ `semantic_unavailable`.
- Doc-level embedding: title + first paragraph. Section/RAPTOR rollups: experimental flag, off by default.

## 7. The pipeline call

One round trip for seed → expand → hydrate; each stage optional; stages share budgets.

```jsonc
{
  "seed":    { "from": "blocks", "semantic": "stable identity across edits", "limit": 8 },
  "expand":  { "via": ["references","depends_on"], "direction": "both", "depth": 2,
               "budget": { "max_nodes": 60 } },
  "hydrate": { "resolution": "text", "budget_tokens": 4000 }
}
// → { seeds: [hits+evidence], graph: {nodes, edges, truncated}, content: {blocks…, truncated} }
```

## 8. Collections

A collection node is either an explicit member list, a stored query, or both (`spec` JSON). Membership materializes as `member_of` pseudo-edges at read time for explicit members; stored-query collections evaluate lazily (never persisted as edges). Collections are addressable in `within()`, traversal seeds, and `sections_move` targets are NOT (they're doc structure).
