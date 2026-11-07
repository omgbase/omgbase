---
npm:
  "@omgbase/core": minor
crates:
  omgbase-mutate: minor
---
Fix a structural-corruption bug: `insert`/`update` landing new content right
next to an existing top-level list of the same marker (e.g. `blocks_insert`
at `{ after: <heading> }` with that heading's existing list right after it,
or `blocks_append`/`docs_append`/CLI `append` into a section that already
ends in a list) rendered the new list directly against the old one with
nothing but a blank line between them. CommonMark does not split two
adjacent `-`/`*`/`+` (or ordered) lists that share a marker just because a
blank line sits between them, so the next commit's reparse read them as ONE
list — and the known-id resolver, which assigns ids by position on the
assumption that `parse(render(tree))` stays structurally identical to the op
tree, then misassigned every id from the merge point on: the untouched
list's items absorbed the new content under one id, and every block after it
(a following heading included) silently inherited an id that used to belong
to its next sibling. Confirmed independently in the existing fixture corpus,
not just a constructed repro — `spec/surface`'s `reads::diff-unified-list-
append` / `reads::append-into-blocks` and `spec/cli`'s `mutate::append-stdin`
all already exercised this path and had the corruption baked into their
`expect` until this fix's regeneration.

`insert` (and `update`'s extra-sibling path) now give the newly inserted
edge list a different marker (`-`/`*`/`+`, or `.`/`)`  for ordered lists)
whenever it would otherwise merge with a neighbor that existed before the
changeset — the untouched neighbor's bytes and id are never touched. A
neighbor minted earlier in the SAME changeset (the row-template "rollup"
insert pattern) is left free to merge, since both sides are new. `spec/mutate`
4.1 → 4.2 (§2.1 disambiguation rule, §3 `attrs.bullet`/`attrs.delim`
override, §10 write-up); `spec/reconcile` is unaffected — `docs_update`'s
probabilistic matcher degrades gracefully on an already-merged list and was
never exposed, which is why "docs_update the whole note" was a working
workaround in the original report.
