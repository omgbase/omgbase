---
npm:
  "@omgbase/core": patch
crates:
  omgbase-surface: patch
---

Finished an in-progress edit to the `plan`/`apply` tool descriptions: a new
example rung demonstrating `set { field: "content" }` (replacing the whole
document, frontmatter fence included — spec/mutate §11.2) had pushed both
descriptions over the 900-character portability budget (`mcp/examples.test.ts`),
which was failing the drift gate (`example_ladders_are_well_formed_and_match_the_suite_bytewise`
in both engines). Trimmed comments throughout `apply`'s ladder to fit its new
4th rung; for `plan`, swapped the new rung in for the existing "no target: the
hit" rung rather than appending a 6th line — that pattern stays demonstrated
by `apply`'s bulk-check-off rung, which also omits `target`. No digest-pinned
rung's effects JSON changed. `spec/surface/cases/examples.json` and
`crates/omgbase-surface/src/descriptions.rs` regenerated from the new
descriptions via their documented hooks.
