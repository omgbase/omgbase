---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-mutate: minor
  omgbase: minor
---
`split` trims whitespace at the cut (spec/mutate 3.5, §2.5): after cutting the raw at the byte offsets, every piece but the last loses its trailing whitespace and every piece but the first its leading whitespace (the format's trim set), while the raw's own start and end stay as authored. An offset immediately before or after a space — or inside a run of whitespace, at a `\n`, or in a two-space hard break — yields the same trimmed pieces, so no piece ends in a stray space the caller cannot see with `plan { diffs }` off. Exact offsets were a trap: in an agent benchmark every split-paragraph run fought the seam. `preview.summary` and split `plan_id`s are unchanged. The `query` tool's description gains a blocks-of-a-document rung (`select type, text from blocks where path == …`) so a document's block ids, types and text are one obvious query; the other rungs' comments were tightened to keep the description under its budget.
