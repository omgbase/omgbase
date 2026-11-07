---
npm:
  "@omgbase/core": none
crates:
  omgbase-surface: none
---
Wording-only fixes from the "OMG MCP complaints" friction log, no behavior or
argument-shape changes:

- The `query` tool's own description said its result was "rows"; the wire
  envelope is `hits` (`{ hits, truncated, cursor, consumer }`). Fixed to say
  "hits" so a client reading the tool description doesn't look for
  `result.rows` and come up empty.
- The `query_syntax` reference (both the full manual and the compact card) now
  states explicitly that `exists`/`none` are WHERE-position tests only — never
  a `select` projection — while `collect`/`first`/`single`/`count` project in
  `select` (`count` has been a value there since oqx 0.24), with a worked
  example (`docs { select n: _nodes count { _kind == "md:task" } }`).
  Previously the consumers were listed generically, which made a scalar
  computed-field projection with `count` look unsupported (or, going the other
  way, made `exists`/`none` look select-safe when they are not).
- The `query_syntax` reference's membership section now shows a literal-tuple
  example (`docs { type in ("lab-note", "hub") }`) alongside the existing
  authored-array membership examples, so `in [...]` (brackets — refused) isn't
  the first thing an agent reaches for; tuples are `(a, b)`, never `[a, b]`.
- The `apply` tool's one `insert` example previously showed only
  `at: "end"`; its comment now also names the `{before|after: "<id>"}` forms
  so position-before-a-heading isn't trial-and-error. (The client-portability
  budget on minimal-tool descriptions — 900 chars — left no room for a second
  full JSON rung; the existing rung's comment was extended instead, and a
  neighboring rung's comment was tightened to make space. `plan`'s ladder
  has the same `at` grammar via `blocks_insert`'s fuller description and
  `docs/mcp-api.md`, which already worked examples for `at.before`/`at.after`.)

Checked and found already correct (no change made): the `select`-before-`where`
clause order is documented consistently everywhere a caller would read it as a
template (the collection-heads-the-body braces form, `docs { select … where … }`,
is canonical throughout `reference.ts`, `docs/query-language.md`, `docs/cli.md`
and `docs/decisions.md`; no surviving example shows the rejected
`from … where … select` order). `docs/mcp-api.md` already says "hits" for the
`query` tool's result shape and already documents `at: {before|after}` with a
worked example in its effects section. The `content`-vs-`markdown`
(document-vs-block) side-by-side example was left for the sibling change
covering that diagnostic/behavior work, to avoid a collision in the same
ladder text.

`spec/surface/cases/examples.json`, `reads.json` and `tool-descriptions.json`
regenerated (`SURFACE_SPEC_UPDATE=1` + `node scripts/gen-tool-descriptions.mjs`)
to match; `crates/omgbase-surface/src/reference.rs` hand-mirrored to stay byte
for byte with `packages/core/src/mcp/reference.ts` (its own test enforces this).
