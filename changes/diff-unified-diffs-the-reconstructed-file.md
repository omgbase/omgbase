---
npm:
  "@omgbase/core": patch
crates:
  omgbase-surface: patch
---
`diff_unified` (and `omg diff`) now diffs the two revisions' reconstructed files — the same bytes `docs_read_at` returns — instead of every live block's raw at every depth joined by `\n`. The old rendering emitted a list container's whole text and then each list item again beneath it, so appending one bullet to a list showed up as an insertion before the list's first item and the same `+` line repeated in a second hunk. Hunk line numbers now correspond to real file lines. `spec/surface` §3 wording and a §9 entry record the fix; the surface spec stays at 1.4.
