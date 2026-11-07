---
npm:
  "@omgbase/core": minor
  omgbase: minor
  "@omgbase/sync": none
crates:
  omgbase-surface: minor
---
`spec/surface` 6.7: the `query` MCP tool now accepts `q` as a safe alias for
its `query` argument. `blocks_search`'s own argument IS named `q`, so an
agent reaching for that habit on `query` (which takes `query`) was an
understandable mix-up, not a new argument — and getting a schema error for
it was an avoidable ergonomics trap. `query { q: "..." }` now runs as
`query { query: "..." }`, with the result's new `argument_corrections` array
naming the mistake and asking the caller to use `query` henceforth, the same
teaching mechanism surface 6.6 introduced for a bare `id`/`path`. Giving
*both* `q` and `query` in the same call is a real collision, not an obvious
typo, so it is still refused (`filter_invalid`, `data.fix` the same call
respelled) rather than silently picking one.

Implemented through a SEPARATE, small per-tool alias table
(`TOOL_ARGUMENT_ALIASES` in the TypeScript reference,
`tool_argument_alias` in the Rust port) rather than an extension of 6.6's
`_`-prefix bare-engine-argument mechanism — this is a different kind of
mistake (a name borrowed from another tool), not a `_`-prefix confusion.
Both engines verified against the shared `spec/surface` fixtures.

A second reported bug — the `plan` MCP tool's advertised input schema
including `reason`, which the validator then rejected — was investigated and
found already resolved in both engines and in `spec/surface/README.md`:
`plan`'s schema takes `effects`, `select?`, `expect?`, `diffs?` and nothing
else, so there is nothing to align. No change made for that report.
