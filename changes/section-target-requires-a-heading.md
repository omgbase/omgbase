---
npm:
  "@omgbase/core": minor
crates:
  omgbase-mutate: minor
---
A `{ kind: "section", heading_id }` effect target did not check that
`heading_id` resolved to a HEADING block. `resolveSection`/`resolve_section`
computed the section's range from whatever top-level block the id named,
defaulting its level to 1 when the block had no `attrs.level` — which every
non-heading block lacks — so a stale or re-targeted `heading_id` that later
pointed at a paragraph or a list was silently accepted as "the section": its
own text was reported as the section's name in `preview.summary` and the
Receipt, and the insert landed relative to it rather than to the heading the
caller meant (observed in the field: a journal's Log heading id resolved,
after other edits, to the log list itself; a companion sibling insert then
landed after the list instead of before the heading).

`insert`/`move` into a section whose `heading_id` names a non-heading block
now refuses with `type_mismatch { op_index, block, type }` — the sibling of
1.2's "the destination parent of `insert`/`move` must be a container" rule,
naming the block's real type instead of treating its text as a section name.
Fixed in both engines (`packages/core/src/mutate/ops.ts`,
`crates/omgbase-mutate/src/ops.rs`); `spec/mutate` 4.2 (§1.1, Decisions) —
a behavior change (a `heading_id` that used to be silently accepted now
errors), so a minor, not a conformance patch: the prior spec text computed
the section's level generically ("`attrs.level` or 1") without requiring the
resolved block's kind to be `heading`, so the gap was in the spec's own
wording, not only the implementation. New fixture:
`spec/mutate/cases/ops.json` `insert-into-section-heading-not-a-heading`.
