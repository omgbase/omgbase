# omgbase-search

**The omgbase search layer — Rust implementation (the pure half).**

Search is how an omgbase repository is *found in*: full-text search over
block text (SQLite FTS5, bm25), semantic search over block and document
embeddings (brute-force cosine), and their fusion with explainable boosts.
This crate holds the parts that are pure functions of their inputs plus the
provider protocol: the FTS5 query sanitizer, which blocks embed and the exact
strings a provider is asked for, the cache keys, the document input and its
whole-vs-pooled budget, block-vector pooling, cosine, RRF fusion and boosts,
the `resolve` shaping, the `EmbeddingProvider` seam with its stdio and
http(s) implementations (the latter behind the `http` feature), and the
deterministic fixture embedder the conformance fixtures use. Index
maintenance and the queries over the database live in
[`omgbase-store`](https://crates.io/crates/omgbase-store), which calls this
crate for its `text_search`, embedding drain, `vector_search`, `hybrid_search`
and `resolve`.

```rust
use omgbase_search::{FixtureEmbedder, EmbeddingProvider, cosine_f32, rrf_score, sanitize_fts_query};

assert_eq!(sanitize_fts_query("\"exact phrase\" other*"), "\"exact phrase\" \"other\"*");
let q = FixtureEmbedder.embed_query("hello").unwrap();
assert!((cosine_f32(&q, &q) - 1.0).abs() < 1e-9);
assert_eq!(rrf_score(Some(1), None), 1.0 / 61.0);
```

The reference is the TypeScript engine
[`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core)
(`search/{fts-query,embeddings,tasks,vector,rrf,resolve,external}.ts`). Both
conform to the language-neutral specification at
[`spec/search`](https://github.com/omgbase/omgbase/tree/main/spec/search):
`README.md` is the contract, `cases/*.json` the executable fixtures. The
conformance runner (`tests/spec.rs`) drives `omgbase-store` through the
observation scripts, drains with the fixture embedder and checks every
projection; `tests/spec-passing.txt`, when present, names the cases that must
pass while the port runs behind the fixtures (`SEARCH_SPEC_UPDATE=1` rewrites
it).

## Features

- `http` — the http(s) provider (`GET` metadata, `POST {texts, model}`), via
  `ureq`. Off by default; the stdio provider needs nothing extra.

## License

MIT.
