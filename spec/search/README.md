# The omgbase search specification

Search is how a repository is *found in*: full-text search over block text
(SQLite FTS5, bm25), semantic search over block and document embeddings
(brute-force cosine), and their fusion with explainable boosts. The engine
owns the index maintenance, the exact text that is embedded, the cache keys
that make an embedding reusable, the pooling that builds a document vector
out of block vectors, and the ranking arithmetic; the embedding model itself
is an external process or endpoint. This directory specifies all of that so
two engines produce the same indexes, ask a provider for the same strings,
store the same vectors and rank the same way. It is owned by neither
implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/search/{fts-query,text,embeddings,tasks,vector,rrf,external,provider}.ts`, `core/store/fts.ts`, `core/vec.ts` | **Reference.** Search decisions land here first. |
| `omgbase-search` (Rust, crates.io) | `crates/omgbase-search` | Conformance-first port: the pure pieces (sanitizer, embed inputs, pooling, cosine, fusion) plus the provider protocol; `omgbase-store` owns the FTS maintenance and the queries. |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/graph-and-query.md` §5–§6.

## Versioning

`VERSION` is `<major>.<minor>`; the `omgbase-search` crate is
`<major>.<minor>.<patch>`. A change to what is indexed, embedded or how a
score is computed bumps the minor; a change to a stored shape (cache keys,
vector encoding, `doc_embeddings.method`) bumps the major.

## The rule for changing search

**Fixture first, TypeScript (reference) second, Rust third.** §8 records the
reference oddities surfaced and the decisions taken.

## 1. Full-text search

### 1.1 The index

`blocks_fts` is an FTS5 **external-content** table over `blocks(text)`
(`content='blocks'`, `content_rowid='rowid'`, tokenizer `porter unicode61`);
`nodes_fts` the same over `nodes(name, value)` (`spec/store` `schema.sql`).
Only **live** blocks are indexed: before a document's rows change the engine
issues `INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete',
rowid, text)` for each live row (with the text as stored), and after the new
rows are inserted it inserts `(rowid, text)` for each. A tombstoned block has
no index row; a rebuild is `INSERT INTO blocks_fts(blocks_fts)
VALUES('rebuild')`. Both engines link a SQLite with FTS5 and the same
tokenizer, so identical `blocks` content gives identical indexes.

### 1.2 The query sanitizer

User input is a search box, not the FTS5 query language. `sanitize(input)`
compiles it to a grammar-free MATCH expression:

- split on whitespace (the JavaScript `\s` set) into tokens; a run enclosed
  in double quotes is one **phrase** token (the closing quote may be missing:
  the phrase runs to the end); quotes never nest;
- a bareword ending in `*` is a **prefix** token (one `*` is stripped and
  re-appended outside the quotes; `foo**` → `"foo*"*`);
- a token with no letter or digit (Unicode `L`/`N` categories) is dropped;
- each surviving token is emitted as `"…"`, joined by single spaces (FTS5's
  implicit AND); a prefix token as `"…"*`. A `"` always ends a bareword and
  starts a phrase, so no token ever contains one (`a"b` → `"a" "b"`).

`guides/onboarding` → `"guides/onboarding"` (the tokenizer splits on `/`,
so this is an AND of two terms); `"exact phrase" other*` → `"exact phrase"
"other"*`; `---` → `""` (empty result: the caller skips the MATCH and
returns no hits).

### 1.3 `text_search(repo, query, limit = 50)`

If the sanitized query is empty → no hits. Otherwise the live blocks of the
repo whose FTS row matches, ordered by `bm25(blocks_fts)` ascending (best
first), ties in SQLite's order — the fixtures pin only cases without ties —
limited to `limit`, `truncated` = more than `limit` matched. A hit is
`{ block_id, doc_id, path, type, text, score = −bm25 }` (higher is better).
bm25 is SQLite's; a runner compares scores within 1e-6.

## 2. Embeddings

### 2.1 Which blocks embed

A live block embeds on its own when its `text` has at least **24 tokens**,
tokens being the non-empty pieces of the text split on `\s+`
(`should_embed`). Frontmatter is not a block and never embeds. A container's
text is its children's text, so a long single-item list yields two tasks
(the `list` and the `list_item`, same `content_hash`, different ctx) and both
pool into the document vector (§8). Shorter blocks are never embedded, and since pooling
(§2.5) reads only *cached* block vectors they contribute nothing to the
document vector either (§8). `estimate_tokens(text) = ceil(words × 1.3)` is
the budget estimate used for documents (§2.4) and the pooling weights.

### 2.2 Context and input

For a block *b* in document *d*:

```text
doc_title      the doc's frontmatter `title` when it is a scalar string
               property (spec/properties: source frontmatter, card scalar,
               type string) and non-blank; else the text of the doc's first
               section heading (sections ordered by first_ordinal — the
               reference query has no ORDER BY, a port orders explicitly);
               else the path
heading_chain  the texts of the sections whose [first_ordinal, last_ordinal]
               contains b.ordinal, ordered by level ascending (shallowest first)
ctx            doc_title + " · " + path + " · " + heading_chain.join(" › ") + " · " + b.type
input          ctx + "\n" + b.text
ctx_hash       sha256(ctx)
content_hash   b.raw_hash
```

The three separators are ` · ` (U+00B7 with spaces) and ` › ` (U+203A).
An empty chain leaves an empty segment (`title · path ·  · paragraph`).
Only top-level ordinals are in `sections`, so a nested block's chain uses its
own `ordinal` against the top-level ranges — a nested block at ordinal 0
inherits the chain of top-level ordinal 0 (§8).

### 2.3 The block cache

`embeddings(content_hash, ctx_hash, model) → (dim, vec)`; `vec` is the
vector as **little-endian float32** bytes, `dim` its length. The key is pure
content addressing: identical text under an identical context re-uses the
vector regardless of block identity — and since `ctx` contains the path,
that sharing happens within one document (two identical blocks in one doc:
one row; the same block in two docs: two rows). A heading rename changes
every descendant's `ctx_hash` and so misses the cache; the old rows stay.
Two identical misses in one drain are both sent to the provider. A block is **stale** when
its current `(content_hash, ctx_hash)` has no row for the current model.
`process(tasks)`: partition into cached and misses; embed the misses' inputs
in batches of 32 (a request size, never a semantic boundary); `INSERT OR
REPLACE` each vector with the provider's `model` and `dim`.

### 2.4 The document input

For a live document with reconstructable content:

```text
title   $title (computed) if a non-blank string; else frontmatter `title` if a
        non-blank string; else the path
header  [title, path, "type: " + type?, "layer: " + layer?].join(" · ")
        (type/layer only when the merged property is a non-blank string)
input   header + "\n" + reconstruct(doc)        (spec/store §6.1: the whole file)
```

Documents whose `input` is blank are skipped. `input_hash = sha256(input)`
is the freshness key: a `doc_embeddings` row whose `input_hash` differs from
the current input is stale. The token budget is
`max(1, (provider.max_input_tokens ?? 512) − 16)`; a document whose
`estimate_tokens(input)` is **within** the budget embeds **whole**
(`method = whole`, the input sent to the provider); one **over** budget is
**pooled** (§2.5) from its blocks' cached vectors with no provider call.

### 2.5 Pooling

Over the document's embeddable blocks (§2.1) in `(path, ordinal)` order,
each with its `(content_hash, ctx)` and weight `w = max(1,
estimate_tokens(text))`: skip blocks with no cached vector; accumulate
`acc[i] += w × v[i]` over `min(dim, |v|)` components in **f64**; if no
block contributed, the document stays queued (no row). Else `acc[i] /=
Σw`, compute `norm = sqrt(Σ acc[i]²)`, and emit `out[i] = acc[i] / norm` as
float32 (all zeros when `norm = 0`). Stored as `method = pooled` with the
provider's `dim`.

### 2.6 Draining

The block pass runs before the document pass in one drain, so a large
document can pool from vectors cached moments earlier. A drain never blocks a
mutation; hosts debounce (500 ms) and single-flight. Vectors under another
`model` are never read or overwritten; `prune_foreign_vectors` deletes them
on request.

## 3. Vectors and similarity

`cosine(a, b)` over two float32 vectors: with `n = min(|a|, |b|)`,
accumulate `dot`, `‖a‖²`, `‖b‖²` over `i < n` left to right in **f64** from
the float32 values; `0` when either norm is 0; else `dot / (sqrt(‖a‖²) ×
sqrt(‖b‖²))`. The SQL function `cosine(blob, blob)` (`spec/store` §1) is the
same over blobs, `NULL` when either operand is `NULL`; a blob's length is
floored to a multiple of 4.

`vector_search(repo, model, q, limit = 50)`: over every `embeddings` row of
`model` joined to a live block with `raw_hash = content_hash`, score
`cosine(q, vec)`; **one hit per block** — a block with several rows (a stale
context row left by a heading rename beside its current one) keeps its
highest cosine (§8: the reference listed it twice); sort by score
descending then `block_id` bytewise ascending, take `limit`. Two identical
blocks are two hits. Hit: `{ block_id, doc_id, path, cosine }`.
`doc_vector_search` is the same over `doc_embeddings` joined to live docs,
ties by `doc_id`.

## 4. Fusion and boosts

`hybrid(repo, text?, vector?, terms?, limit = 50)`:

1. FTS ranks: `text_search(text, limit 200)`, rank = 1-based position of the
   first occurrence of each `block_id`. Vector ranks: `vector_search(…, limit
   200)`, rank likewise (first occurrence), remembering each cosine.
2. Candidates = the union of block ids; a candidate whose block no longer
   exists is dropped.
3. `rrf = (fts_rank ? 1 / (60 + fts_rank) : 0) + (vec_rank ? 1 / (60 +
   vec_rank) : 0)`.
4. `terms` default to `text` split on `\s+`; lower-cased for matching.
   Boosts (each present only when it applies): **title** ×1.25 when the
   doc's merged `title` property, stringified as JavaScript `String(v)`
   (an array joins with commas; fixtures use strings only) and lower-cased,
   contains any term; **heading** ×1.15 when any section heading text whose range contains
   the block (any level) contains a term; **path** ×1.10 when the lower-cased
   path contains a term; **layer** from the merged `layer` property: `canon`
   ×1.30, `working` ×1.15, `draft` ×0.85 (`proposed` is ×1.0 and not
   recorded); `recency` is a reserved slot, never set.
5. `score = rrf × title × heading × path × layer × recency`, multiplied
   left to right in that order (an absent boost is 1; association matters in
   the last bit); sort by score descending then `block_id` bytewise; take
   `limit`. Each hit carries `evidence = { fts_rank?,
   vector_rank?, cosine?, rrf, boosts }`.

`resolve(repo, query, vector?, limit = 10)` is `hybrid` reshaped: `{ id,
locator = path + "#" + type + "[" + ordinal + "]", preview = the first 12
whitespace-separated words of the text (+ "…" when cut), evidence }`.
`ordinal` is the sibling ordinal, so a nested block's locator is ambiguous
(§8).

## 5. The provider protocol

The provider is named by the repo setting `embedding.provider`: a **command**
(spawned; the settings `embedding.model`/`dim`/`maxInputTokens`, when set,
are exported as `OMGBASE_EMBEDDER_MODEL`/`_DIM`/`_MAX_TOKENS`) or an
**http(s) URL**. No provider → `semantic_unavailable`; a provider that
cannot be spawned or fails its handshake → `embedder_failed`.

- **stdio**, newline-delimited JSON: the process writes one handshake line
  `{"model": "…", "dim": N, "maxInputTokens"?: N}`; the engine writes
  `{"id": n, "texts": ["…"]}` per request and reads `{"id": n, "vectors":
  [[…], …]}`; stderr is logging only.
- **http**: `GET url` → the same metadata object (best-effort; a failure
  leaves the configured `model`/`dim`); `POST url {"texts": [...], "model":
  "…"}` → `{"vectors": [[…], …]}`; a non-2xx or a body without `vectors`
  is an error.

Vectors arrive as JSON numbers and are stored as float32 (§2.3).

## 6. The fixture embedder

Real models are not deterministic across hosts; the fixtures use a
**hash embedder** every runner implements identically: `model =
"fixture-hash-8"`, `dim = 8`, `max_input_tokens = 64`. For an input string
*s*, let `h = sha256(utf8(s))`; for `i` in `0..8`, `u = h[2i] × 256 +
h[2i+1]` and `raw[i] = u / 65535 × 2 − 1` (in f64); L2-normalize `raw` in
f64; store each component as float32. This gives realistic-looking unit
vectors, exercises every code path (cache hits, whole vs pooled, cosine
ordering, fusion) and is exactly reproducible.

## 7. Fixtures

`cases/<suite>.json`. Three case shapes:

- **`sanitize.json`** — `{ name, input, expect: "<match expression>" }`;
  pure string → string.
- **`cosine.json`** — `{ name, a: [floats], b: [floats], expect: <number> }`
  with the vectors given as float32-representable decimals; compared within
  1e-9.
- **Observation scripts** (as `spec/store` §9.4: `steps` of
  `observe`/`sweep`, plus two new steps `{ "drain": true }` — run the block
  pass then the document pass with the fixture embedder — and `{ "search":
  { "text"?, "semantic"?, "limit"? } }` whose outcome is recorded in
  `expect.steps`). `expect` after the last step:
  - `steps`: per step as in `spec/store`, plus for `drain` `{ embedded,
    cached, doc_embedded, doc_cached, doc_pooled }`; for `search` the hits:
    text-only → `text_search` hits (`score` within 1e-6); semantic-only →
    the query embedded with the fixture embedder **and rounded to float32**
    like a stored vector, `vector_search` hits (`cosine` within 1e-9); both
    → `hybrid` hits with evidence (`boosts` holds only the applied keys);
    for `{ "resolve": { query, semantic?, limit? } }` → `{ hits: [{ id,
    locator, preview, evidence }] }`.
  - `embed_tasks`: every embeddable block's `{ block_id, content_hash, ctx }`
    in `(path, ordinal, block_id bytewise)` order (nested blocks share
    ordinals with top-level ones); `doc_tasks`: every document's `{ doc_id,
    header, input_hash, method_if_embedded: "whole" | "pooled", blocks: [{
    content_hash, tokens }] }`.
  - `embeddings`: rows sorted by (`content_hash`, `ctx_hash`) as `{
    content_hash, ctx_hash, model, dim, vec: [8 floats] }` (each float32
    value printed as a JSON number — the reference prints the f64 repr of
    the f32, a port may print the f32 shortest repr; both sides are rounded
    to float32 before the 1e-9 comparison); `doc_embeddings` sorted by `doc_id` as `{ doc_id, model,
    input_hash, method, dim, vec }`.

Suites: `sanitize.json`, `cosine.json`, `fts.json` (index maintenance across
edits and tombstones, ranking without ties, truncation, prefix and phrase
queries), `embed.json` (should-embed threshold, context prefix incl. title
fallbacks and heading chains, cache hits across identical blocks and across
revisions, ctx invalidation on heading rename, whole vs pooled by budget,
pooling math, foreign-model isolation), `rank.json` (vector ordering and
ties, hybrid fusion, each boost, resolve locators).

**Generation.** `packages/core/corpus/search/spec.test.ts`,
`SEARCH_SPEC_UPDATE=1`; the reference installs the fixture embedder as its
provider. **Allowlist (Rust).** `crates/omgbase-search/tests/spec-passing.txt`
(or wherever the runner that drives `omgbase-store` lives),
`SEARCH_SPEC_UPDATE=1`.

## 8. Reference oddities surfaced while specifying, and decisions

- **Fixed — a block with a stale context row was two vector hits.** After a
  heading rename the old `(content_hash, old ctx_hash)` row stays, and the
  reference's join on `content_hash` alone listed the block twice with two
  cosines; `hybrid` then recorded the *last* seen (worse) vector rank because
  only the FTS pass kept first occurrences. §3 dedupes per block keeping the
  best cosine and §4 takes first occurrences in both rankers
  (`rank::vector-stale-ctx-row-dedupes`, `rank::hybrid-stale-ctx-row-first-wins`).
  "Highest cosine" can keep the *stale* row's vector when it scores higher;
  both rows embed the same text under slightly different context prefixes,
  so with a real model they are near-identical. Recorded for a refinement:
  scoring only the row matching the block's current context (a minor).
- **Pinned — bm25 needs non-matching rows.** When every indexed row matches
  a query, FTS5 clamps idf and all scores collapse to about 1e-6; fixtures
  include filler blocks so scores differ, and any added block anywhere in
  the repo changes every score (avgdl and row count).
- **Pinned — vectors of tombstoned documents linger.** Neither cache is
  pruned on deletion; the joins to live rows hide them.
- **Pinned — the title boost reads the frontmatter `title` only.** A
  document whose only title is an H1 gets no title boost (the code's comment
  claimed a heading fallback).
- **Pinned — short blocks never reach the document vector.** The pooled
  fallback averages *cached block vectors*, and only blocks of ≥ 24 tokens
  are embedded, so a long document made of short blocks that is over the
  budget stays queued forever (no row). `docs/graph-and-query.md` §6 says
  short blocks "still feed the pooled vector"; they do not. Recorded for a
  decision.
- **Pinned — the heading chain of nested blocks uses their own sibling
  ordinal** against top-level section ranges, so a list item at index 0
  inherits the first section's chain whatever list it is in.
- **Pinned — the block cache is repo-blind.** `embeddings` has no `repo_id`;
  identical text under an identical context shares a vector across repos of
  the workspace (by design: content addressing).
- **Pinned — `doc_title` for the block context prefers the frontmatter
  `title`, while the document header prefers `$title`.** Two different
  precedence orders for "the title", as built.
- **Pinned — ties in `text_search` are SQLite's order** (undefined by this
  spec); fixtures avoid them. `hybrid`'s FTS pass caps at 200 hits, so a
  block ranked beyond 200 by FTS has no `fts_rank`.
- **Pinned — two identical live blocks are two hits** with equal cosine,
  ordered by id (the join is by content hash, one hit per live block).
- **Pinned — `layer` boost only records non-1.0 values**, so `proposed` and
  unknown layers leave `boosts.layer` absent.

## Decisions

- 2026-09-26, search 1.0 specified as built. The fixture embedder is a runner
  device, like the fixture id minter: it never ships in a product path.
