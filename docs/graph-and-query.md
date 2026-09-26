# omgbase — Graph, Query, and Retrieval Spec

**Status:** normative.
**As-built (verified 2026-09-23).**
**Depends on:** `architecture.md` §8–9; `data-model.md` §3–4.

---

## 1. Edge principles

1. **Derived from content, never inherited through identity.** Extraction is a pure function of `(revision content, extraction_version)`. Block identity threads only the validity intervals (edge history).
2. **Block-grain truth, doc-grain speed.** `edges` rows originate from blocks (or frontmatter); `doc_edges` is a materialized rollup.
3. **Inferred is quarantined.** `inferred_edges` is a separate table (each row carries `method`/`score`/`model_v`/`computed_at`), excluded from every query and traversal by construction. As-built it is a schema stub — no writer or reader is wired to it yet.
4. **Structural relations are not edges.** parent/child/sibling order live in Placement, not the edge tables; OQX navigates them through relations (`block.children`, `section.children`/`section.subsections`, `section`, `section.blocks`) and the `follow` operator (§3), not through edge rows.

## 2. Extraction rules (extraction_version: x2)

> **The language-neutral contract is `spec/graph/README.md`** (node projection and `node_id`, the edge descriptor and every scanner as an exact rule, resolution, interval maintenance, the `doc_edges` rollup, phantom adoption, URI normalization, the reference oddities) with executable fixtures under `spec/graph/cases` that both the reference (`packages/core/corpus/graph/spec.test.ts`, `GRAPH_SPEC_UPDATE=1` regenerates) and the Rust `omgbase-graph` crate run. This section is the design rationale; when the two disagree, the spec's fixtures win. `x2` is folded into `spec/graph/VERSION` and is not persisted.

**Node spans are bytes.** `nodes.span_start` / `span_end` are `[start, end)` offsets into the UTF-8 bytes of the block's `raw` (spec/graph §2.3, like every offset in spec/format), not JavaScript string indices. The markdown adapter's `projectNodes` still records UTF-16 code-unit indices; ingest converts them at the store boundary (`core/store/nodes.ts` `toByteSpans`, via `core/utf8.ts`) before the rows are written, and `node_set` (`mutate/macros.ts`) converts a stored span back to code units before an editor slices the raw. A database written by the reference and read by a byte-native engine therefore agrees on any block with non-ASCII text before the feature (spec/graph §8 "Fixed").

Run per touched document inside the commit transaction. **Code is not prose**: a `code_fence` block yields no edges, and inline code spans (`` `…` ``, any backtick-run length, CommonMark matching) are masked before the scanners below run — so a backticked `[[wikilink]]` example, a placeholder link inside a fence, or a regex fragment with square brackets never mints a `references` edge (`graph/extract.ts` `maskCode`). The markdown adapter's `md:link` / `md:wikilink` / `md:anchor` / `md:inline_field` node projection applies the same mask, so nodes and edges agree. The version is not persisted: an existing repo picks up x2 for a document the next time that document is ingested (checkpoint / `observe` / `apply` / `docs_update`); `rebuild-index --edges` only recomputes the `doc_edges` rollup and does not re-extract.

| Source | Edge | Provenance |
|---|---|---|
| Inline link `[t](/path/doc.md)` or `[t](/path/doc.md#Heading)` | `src_block —references→ d_target` (+`anchor`) | `link` |
| Wikilink `[[note]]`, `[[note#Heading]]`, `[[note^ref]]` | same; `^ref` targets resolve to `dst_kind: block` when the anchor is known | `link` |
| Autolink / bare URL | `src_block —references→ x_<normalized-uri>` | `link` |
| Frontmatter field whose value(s) are repo paths or wikilinks, e.g. `depends_on: [/a.md]` | `doc —<field>→ target` with `src_block = NULL, src_field = <field>` | `frontmatter` |
| Inline field `key:: [[target]]` (Dataview convention; also `key:: /path.md`) | `src_block —<key>→ target` | `inline_field` |
| Image `![alt](path)` | `src_block —embeds→ x_/d_` | `link` |

- Unresolvable internal targets mint a **phantom document node** (`dst_kind:"document"`, `dst_node` = path-keyed placeholder) so backlinks appear the moment the target is created. Phantoms are flagged in results.
- Internal targets resolve **by path**: `./`/`../` destinations against the source doc's directory, anything else root-relative, one leading `/` stripped (`graph/extract.ts` `resolveRelativePath`). Consequently `docs_move` re-points the moved doc's open inbound edges at `phantom:<old path>` (a self-doc pure-fragment link `#H` excepted) and adopts phantoms at the new path — the edge index after a move equals what re-extraction would produce (`mutate/docs.ts`, `graph/inbound-links.ts`).
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

The `query` tool takes a **single OQX string** (`packages/core/src/mcp/server.ts`) — not a structured JSON envelope. OQX (omgbase Query eXpressions) covers targets (`docs`/`blocks`/`nodes`/`edges`), dot navigation, whitespace query directives (`collect`/`exists`/`none`/`count`/`first`/`single`, plus `values`, `limit`/`offset`, `entries()`), correlated subqueries (the `^` sigil), `follow` recursion (§3), and `order by` ranking (including `semantic(…)`/`text(…)` predicates). It is **normatively specified in `query-language.md`** and summarized in the `query` tool's own description. Alongside it: the `graph` neighborhood macro (§3) and `text_search` (FTS5 keyword search over block text). A `semantic(…)` clause with no embedding provider configured fails `semantic_unavailable`; a provider that IS configured but couldn't start (spawn/handshake/endpoint failure) fails `embedder_failed` (the `omg mcp` server also warns loudly at startup and stays up for non-semantic tools rather than dying); a malformed query fails `filter_invalid` (reason + hint).

## 5. Hybrid retrieval & ranking

Specified in `spec/search/README.md` §1 (FTS index + query sanitizer), §3 (cosine, vector search) and §4 (fusion, boosts, `resolve`); the fixtures under `spec/search/cases` (`fts.json`, `rank.json`) are the executable contract and win over this summary.

- Lexical: FTS5 (`bm25()`), block grain. Only live blocks are indexed; the user string is compiled to a grammar-free MATCH expression (`search/fts-query.ts`).
- Vector: **brute-force cosine** over the current block embeddings (`search/vector.ts`); sqlite-vec/pgvector are the deferred pressure valve, not v1.
- Fusion: **RRF** — `score(d) = Σ 1/(60 + rank_i(d))` over the active rankers.
- Boosts (multiplicative, explainable): title match ×1.25, heading-chain match ×1.15, path-segment match ×1.10, layer (`canon` ×1.30, `working` ×1.15, `proposed` ×1.0, `draft` ×0.85). A `recency` multiplier slot exists in the boost struct but is not yet computed (`search/rrf.ts`).
- Every hit returns `evidence: { rrf, boosts, ftsRank?, vectorRank?, cosine? }`.
- No learned ranker in v1 (ADR-009).

## 6. Embeddings

Specified in `spec/search/README.md` §2 (which blocks embed, context/input, cache keys, document input, pooling, draining), §5 (provider protocol) and §6 (the fixture embedder used only by the runners); `spec/search/cases/embed.json` is the executable contract.

- **Unit:** individual blocks (paragraphs, list items/tasks, table rows, headings; frontmatter is a revision blob, not a block). Blocks under 24 whitespace tokens (`shouldEmbed`, `search/embeddings.ts`) are never embedded, and — because the pooled document vector averages only *cached* block vectors — they contribute nothing to it either (spec/search §8): a long document made only of short blocks that is over the whole-doc budget gets no document vector at all.
- **Input text:** `"{doc title} · {path} · {heading chain} · {block type}\n{block text}"`. Queries embed bare.
- **Key:** `(content_hash, ctx_hash, model)` — pure content addressing; identity errors cannot poison the cache.
- **Worker:** async queue; recomputes on content or ancestry-context change (a heading rename shifts its subtree's `ctx_hash`). Because vectors are keyed by `(content_hash, ctx_hash, model)`, a changed block simply misses the cache until the worker drains — semantic recall degrades silently for not-yet-embedded blocks rather than serving a stale vector (`search/drain.ts`).
- **Hook:** the embedding provider is an **external process or endpoint** named in repo settings — `embedding.provider` is either a shell command (spawned, spoken to over a newline-delimited JSON stdio protocol: one `{model, dim, maxInputTokens?}` handshake line, then `{id, texts}` → `{id, vectors}`) or an `http(s)` URL (`GET` → metadata, `POST {texts}` → `{vectors}`) — `search/external.ts`, settings shape in `search/provider.ts`. Nothing is imported in-process, so core carries no ML dependency; `@omgbase/embedder`'s `omgbase-embedder` binary is the default local embedder and an HTTP endpoint is the same contract over the wire. Optional `embedding.model` / `dim` / `maxInputTokens`: for a spawned command they are exported as `OMGBASE_EMBEDDER_MODEL` / `_DIM` / `_MAX_TOKENS` (an explicit setting wins over an inherited variable; unset settings leave the ambient env alone), and in every case the provider's handshake/metadata reply is what the engine records. No provider configured ⇒ `semantic_unavailable`; a configured provider that fails to spawn/handshake ⇒ `embedder_failed`. (The CLI prints an egress notice before embedding, since vault text leaves the machine.)
- Doc-level embedding (`method: "whole" | "pooled"`): the whole-document input — a header line + reconstructed body — is embedded when its estimated tokens (`ceil(words × 1.3)`) fit the budget (the provider's/config's `maxInputTokens`, else `DEFAULT_DOC_TOKEN_BUDGET` = 512, minus a 16-token header margin); over budget it falls back to a token-weighted pooled mean of the doc's already-cached block vectors (zero embedding calls; no row while none is cached). Its sha256 is the freshness key for both strategies.

## 7. Collections

As-built, collections are only a schema stub: a `collections` table (`node_id`, `repo_id`, `name`, `spec`) in `packages/core/src/core/store/schema.ts`, with no writer or reader wired up. The aspirational `member_of` pseudo-edges, read-time membership materialization, and `within()`/traversal-seed addressing are **not** implemented — `within()` resolves only a doc id, exact path, or glob (the `within` domain function in `packages/core/src/oqx-js/context.ts`).
