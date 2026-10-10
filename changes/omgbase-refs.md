---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: minor
  omgbase: minor
---
Surface 1.5: `refs(x)` and "a hit is a store row".

- **`refs(x)`** — a new free function of the query binding: the live documents
  named by the document references a property holds. `x` is a string, a list
  or absent; each `/a/b.md`, `a/b.md` or `d_…` element resolves to that
  document's row (paths are matched against `$path` after one leading `/` is
  stripped; an id is tried when no path matches), and anything that resolves
  to nothing is dropped — no phantom row, no error. Order preserved, duplicates
  kept; index-backed (one lookup per element). It yields docs rows, so it is a
  source, a directive receiver, a `follow` destination or a value:
  `follow refs(before), refs(after)` walks a timeline both ways,
  `select prior: refs(before) collect { $path }` projects the referenced
  documents, `where refs(see_also) exists { … }` filters on them.
- **A hit is a store row.** A top-level `collect`/`first`/`single` row that is
  not a document, block, node or edge now fails the query with
  `filter_invalid` — `a hit must be a document, block, node or edge row — the
  query reached a string ("/timeline/kickoff.md"); to follow document
  references held in a property use refs(<field>)` — instead of rendering the
  junk hit `{ "id": "undefined", "path": "" }`. `values` projections (no hits)
  and nested blocks (rows as values) are unchanged.
- **Migration:** a `follow` over a property that holds paths or ids — `follow
  before` — reaches the strings and is now an error; write `follow
  refs(before)`. The same for `follow before, after` → `follow refs(before),
  refs(after)`.
- The alchemy fixture corpus gained two `timeline/` documents whose
  `before`/`after`/`see_also` fields hold document references
  (`spec/surface` 1.5, `query-refs.json`; the `spec/cli` alchemy workspace and
  the §7 interop expectations moved with it).
