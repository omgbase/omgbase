# omgbase — Graph, Query, and Retrieval Spec

**Status:** normative.
**As-built (verified 2026-09-14).**
**Depends on:** `architecture.md` §8–9; `data-model.md` §3–4.

---

## 1. Edge principles

1. **Derived from content, never inherited through identity.** Extraction is a pure function of `(revision content, extraction_version)`. Block identity threads only the validity intervals (edge history).
2. **Block-grain truth, doc-grain speed.** `edges` rows originate from blocks (or frontmatter); `doc_edges` is a materialized rollup.
3. **Inferred is quarantined.** `inferred_edges` is a separate table (each row carries `method`/`score`/`model_v`/`computed_at`), excluded from every query and traversal by construction. As-built it is a schema stub — no writer or reader is wired to it yet.
4. **Structural relations are not edges.** parent/child/sibling order live in Placement, not the edge tables; OQX navigates them through relations (`block.children`, `section.children`/`section.subsections`, `section`, `section.blocks`) and the `follow` operator (§3), not through edge rows.

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

- `doc.out` / `doc.in` (docs→docs) — the authored citation graph: outgoing links / backlinks. Replaces `direction: "out"|"in"` traversal of the edge graph. To inspect the licensing edges (predicate/provenance/anchor), read a doc's edges as rows via `doc.out_edges`/`doc.in_edges` and filter with a plain `where`. (There is no edge-predicate-filtered walk clause — ADR-013 dropped `via`; the query dialect is exactly `@omgbase/oqx`.)
- `block.children` (blocks→blocks) — the block subtree.
- `section.children` (nodes→nodes) — immediate child `md:section` nodes (the outline depth ladder); `section.subsections` — the whole transitive sub-tree.

Knobs go in a `{ … }` block after the relation (a bare `follow <rel>` carries none): `follow <rel> { where <pred> }` filters which successors keep participating (running out ⇒ a leaf); `{ frontier <pred> }` cuts a relation that would otherwise continue; `{ depth <n> }` bounds the walk (1..8, default 8); `follow distinct` dedups by identity; `follow <rel> { by <expr> }` sets the identity used for cycle detection + dedup — e.g. `follow doc.out { where layer != "draft" frontier layer == "canon" depth 4 }`. Each reached row carries recursion metadata `$depth` (seed = 1), `$stop` (interior|leaf|frontier|depth|cycle, with `$leaf`/`$frontier` sugar), and `$ordinal` (deterministic walk rank) — queryable in `select`/`order by` and filterable post-walk in the top-level `where`. Cyclic graphs are safe: a revisited node is admitted once as `$stop == "cycle"` and never re-expanded.

- A `graph` **convenience tool** now exists (`mcp/server.ts`): a neighborhood macro that takes `roots` + `degrees`/`direction`/`predicate`/`select` and compiles to an OQX `follow doc.out`/`doc.in` query run through the same `query` path, returning `{ documents, edges, frontier }` (the generated follow query is echoed in a `queries` field). It is a wrapper, not a new engine — reach for `query` directly for successor/frontier predicates, `by`-keyed identity, `$ordinal` budgets, correlation, or the `edges` scan.
- The induced-subgraph analytics export (`graph_subgraph`) has no OQX equivalent and was dropped.
- Extraction, the edge tables, and interval validity (§1–§2) are unchanged — only the query-time traversal surface moved.

## 4. Query

The `query` tool takes a **single OQX string** (`packages/core/src/mcp/server.ts`) — not a structured JSON envelope. OQX (omgbase Query eXpressions) covers targets (`docs`/`blocks`/`nodes`/`edges`), dot navigation, whitespace query directives (`collect`/`exists`/`count`/`first`/`single`), correlated subqueries (the `^` sigil), `follow` recursion (§3), and `order by` ranking (including `semantic(…)`/`text(…)` predicates). It is **normatively specified in `query-language.md`** and summarized in the `query` tool's own description. Alongside it: the `graph` neighborhood macro (§3) and `text_search` (FTS5 keyword search over block text). A `semantic(…)` clause with no embedding provider configured fails `semantic_unavailable`; a malformed query fails `filter_invalid` (reason + hint).

## 5. Hybrid retrieval & ranking

- Lexical: FTS5 (`bm25()`), block grain.
- Vector: **brute-force cosine** over the current block embeddings (`search/vector.ts`); sqlite-vec/pgvector are the deferred pressure valve, not v1.
- Fusion: **RRF** — `score(d) = Σ 1/(60 + rank_i(d))` over the active rankers.
- Boosts (multiplicative, explainable): title match ×1.25, heading-chain match ×1.15, path-segment match ×1.10, layer (`canon` ×1.30, `working` ×1.15, `proposed` ×1.0, `draft` ×0.85). A `recency` multiplier slot exists in the boost struct but is not yet computed (`search/rrf.ts`).
- Every hit returns `evidence: { rrf, boosts, ftsRank?, vectorRank?, cosine? }`.
- No learned ranker in v1 (ADR-009).

## 6. Embeddings

- **Unit:** individual blocks (paragraphs, list items/tasks, table rows, headings). Blocks under 24 tokens (`shouldEmbed`, `search/embeddings.ts`) are not embedded on their own — they still feed the token-weighted doc-level pooled vector.
- **Input text:** `"{doc title} · {path} · {heading chain} · {block type}\n{block text}"`. Queries embed bare.
- **Key:** `(content_hash, ctx_hash, model)` — pure content addressing; identity errors cannot poison the cache.
- **Worker:** async queue; recomputes on content or ancestry-context change (a heading rename shifts its subtree's `ctx_hash`). Because vectors are keyed by `(content_hash, ctx_hash, model)`, a changed block simply misses the cache until the worker drains — semantic recall degrades silently for not-yet-embedded blocks rather than serving a stale vector (`search/drain.ts`).
- **Hook:** the embedding provider is a plugin named in repo settings — `embedding.provider` (a package exporting `createProvider`), with optional `embedding.model` / `dim` / `maxInputTokens` (`search/provider.ts`). The dynamic import lives in the application (the CLI), so core carries no ML dependency; `@omgbase/embedder` is the default local provider and a remote HTTP provider is the same contract behind a different package name. No provider configured ⇒ `semantic_unavailable`. (The CLI prints an egress notice before embedding, since vault text leaves the machine.)
- Doc-level embedding (`method: "whole" | "pooled"`): the whole-document input — a header line + reconstructed body — is embedded when it fits the token budget (the provider's/config's `maxInputTokens`, else `DEFAULT_DOC_TOKEN_BUDGET` = 512); over budget it falls back to a token-weighted pooled mean of the doc's already-cached block vectors (zero embedding calls). Its sha256 is the freshness key for both strategies.

## 7. Collections

As-built, collections are only a schema stub: a `collections` table (`node_id`, `repo_id`, `name`, `spec`) in `packages/core/src/core/store/schema.ts`, with no writer or reader wired up. The aspirational `member_of` pseudo-edges, read-time membership materialization, and `within()`/traversal-seed addressing are **not** implemented — `within()` resolves only a doc id, exact path, or glob (`search/cel/compile.ts`).
