---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-mutate: minor
  omgbase-surface: minor
  omgbase: minor
---
Teaching surfaces, second pass (spec/mutate 3.4, spec/surface 4.5), from a 78-run agent benchmark against the minimal profile that passed every task but guessed four effect shapes wrong first. The `effects` schema description now spells `at` ("right after block X" is `into: X's parent, at: { after: X }`), the per-op `expect` shapes, the `field` list per target kind and where `expect.max` lives. Four shape errors carry a literal corrected call in `data.fix`: a bare `"after"`/`"before"` anchor (the fix anchors on the block from its parent — the one shape fix that reads the store), a guard-first plural `expect` (inverted), an effect-level `expect.max` (moved beside `select`, or dropped), a block `field` of `text`/`content`/`body`/`raw` (`markdown`). The `query` ladder gains a `links` rung and a string-method rung. `plan { diffs?: boolean }` (default `false`) returns `preview.diffs` only on request; `plan_id` is unaffected, and the CLI's `--server` dry runs pass `diffs: true`. Every string-list argument (`docs`, `ids`, `roots`, `select`, `blocks`, `unset`) takes one bare string as a one-element list; a comma-joined string stays "must be an array of strings" with the comma-split call as its `fix`. Fixtures: `spec/mutate/cases/effects.json` 79 → 92 (`shape-*`), `spec/surface` `examples.json` (28 steps), `reads.json` (`arguments` 35 → 42 steps; plan previews without `diffs`), `interop.json`, `tool-descriptions.json`.
