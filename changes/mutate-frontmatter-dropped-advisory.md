---
npm:
  "@omgbase/core": minor
crates:
  omgbase-mutate: minor
  omgbase-store: patch
  omgbase-surface: patch
---
Replacing a document's whole body with `set { field: "content" }` is, by
spec, a complete-document write — frontmatter fence included — so a value
with no fence silently clears whatever frontmatter the document currently
carries. That behavior was already correct; the only real gap was that
nothing *said* so at the moment of the mistake.

Two fixes, in both engines:

- The shape-check refusal for an invalid `set`/`unset` `field` on a document
  now spells out what `content` means: `` …or `content` (the complete
  document, frontmatter included)`` — previously it just said `` …or
  `content` ``, which read as "a frontmatter half and a body half" rather
  than "the whole file."
- `plan`/`apply`/`execute` (and the `docs_update` sugar built on them) now
  carry a `frontmatter_dropped: [{ effect_index, _id, _path }]` advisory on
  the Plan's preview and the Receipt: present whenever a `set content`
  effect's value has no frontmatter fence while the target document's
  current frontmatter is non-empty. This is advisory, not a refusal — a
  deliberate frontmatter-clearing replacement still commits — but an agent
  now sees the consequence before (via `plan`) or at (via the Receipt)
  commit time instead of discovering it afterward.

`spec/mutate` moves to 4.4 (additive: one new Plan/Receipt field — stacked
on 4.2's section-target fix and 4.3's list-marker disambiguation). The
`apply`/`plan`/`docs_update` tool descriptions also gained a compact
side-by-side example: a document's `set content` with a `---` fence next to
the existing block `set markdown` contrast, so the two mutation vocabularies
read as distinct at a glance.
