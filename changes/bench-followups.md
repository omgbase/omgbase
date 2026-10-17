---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase-mutate: patch
  omgbase: minor
---
Four teaching and tolerance changes from the 2026-10-17 agent-bench re-run (spec/surface 4.11; spec/mutate 3.5 patch):

- **Stringified JSON arrays.** Every string-list argument (`docs`, `ids`, `roots`, `blocks`, `select`, `unset`) accepts a string that IS a JSON array of strings (`ids: "[\"b_1\",\"b_2\"]"`) as that list; a `[…` string that is a JSON array with non-string members keeps the "must be an array of strings" error with the parsed array as its `fix`, a malformed `[` the comma split (`reads::arguments`).
- **The `plan` ladder** spells `diffs: true` as the opt-in it is (`Need file bodies? add diffs: true.`); no rung moved.
- **`block` on a links row** — the source block the link was written in (`select t: block.text from links …`), mirroring `doc`; absent for a frontmatter link; `block.id`/`block.path`/`block.doc_id` read the row's own columns and a `where` over `block.<k>` pushes down (`query-links::block-*`).
- **`id in ["a", "b"]`** on `query` or a `plan`/`apply`/`execute` selector: the parse error gains `; a list is written as a tuple: (…)` and `data.fix` — the same request with `[…]` rewritten to `(…)` — when the bracket holds a comma list of literals (`query-errors::bracket-*`, `effects::select-bracket-list-is-a-tuple`). The language is unchanged.
