---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase: minor
---
`query` gains `bare: true` (`spec/surface` 4.2, `spec/cli` 4.1): each hit is returned as its projection only, without the automatic `id`/`path` envelope members, for display and export where identity is noise. It needs a `select` (a hit without a projection is only its envelope) and is refused with `values` (already the bare-values form); `select id`/`path` under `bare` still projects the row's intrinsics; paging, `truncated` and `cursor` are unchanged because identity is kept internally. `omg query --bare` passes it through and prints the projection table without the id/path columns. The default envelope is unchanged: it is what makes a hit a follow-up handle and a selector's write target.
