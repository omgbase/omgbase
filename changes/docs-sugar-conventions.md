---
npm:
  omgbase: patch
  "@omgbase/core": patch
  "@omgbase/oqx": none
crates:
  omgbase: patch
  omgbase-surface: patch
  oqx: none
---
Documentation sweep for the OQX 0.17/0.18 and surface 2.0 conventions — every human-facing description of OQX now teaches the canonical forms: `and` / `or` / `not` as the connectives (`&&` / `||` / `!` stay accepted synonyms, said once per text), prefix `is x` / `not x`, infix `is` / `is not` (`x is null` for absence), the sugar (a receiver block without a consumer is `collect`, where-first bodies with bare names still projecting, brackets `x[p]` / `x[p]!` / `x[n]`, postfix `!` = required, select-alias reuse, the `follow { … }` options carve-out), `$it` as the current item, the repository as the root row (`^docs` / `0^docs` / `^$id`; a bare target inside a block is an error), `refs(field)` for document references held in properties, and `/`-rooted paths. The `query` and `query_syntax` tool descriptions are respelled in both engines (the Rust catalog now carries the same `query`, `graph` and `query_syntax` wording as the reference; the stale "CEL filter subset" line is gone; the top-level rule reads "a top-level predicate needs `where` because `where` follows `from`"), the `query_syntax` text fixes its `select n: ^docs count { }` example (count is a where-position test — `size(^docs)`) and the two engines' texts are word-for-word identical through the Paths section. The `omg query --help` card gains a sugar block, `refs()`, `^$id` and rooted-path lines in both binaries (`spec/cli` help-card fixture regenerated). The OQX tutorial gains `examples/oqx-tutorial/sugar.md` (runnable over the alchemy timeline milestones), a root-row section and the rooted-path convention; the corpus README and `alchemy.test.ts` gain four sugar / `refs()` / root-row tests; `docs/cli.md`, `docs/mcp-api.md`, `docs/graph-and-query.md`, `docs/object-model.md`, `docs/README.md` and the two `oqx` READMEs are brought to the same conventions.
