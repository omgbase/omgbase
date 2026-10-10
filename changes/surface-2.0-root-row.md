---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-surface: major
  omgbase: minor
---
**The repository is the root row; `$repo` is removed** (`spec/surface` 2.0 §1.1, `spec/cli` 2.0; Brendan's decision of 2026-10-09/10, building on OQX 0.18's root object). From a top-level row `^docs` / `^blocks` / `^nodes` / `^edges` reach the repository's collections — one caret per enclosing block (`^^docs` from depth two), or the absolute `0^docs` from any depth — and `^$id` / `0^$id` is the repository id (the root scope's `$id`). `^$it` is the root object: `^$it.docs` is the same lazy scan handle as `^docs` (a receiver, a value, an indexed probe), `entries(^$it)` yields exactly `docs`, `blocks`, `nodes`, `edges` (`$id` is an intrinsic of it, not an entry). At the root scope a bare target stays the scan: a top-level consumer is `docs count { … }`, `from docs`, `entries(docs)`.

Three spellings are now `filter_invalid`, in both engines, with one message each:

- **`$repo`** anywhere — bare, `$repo.docs`, `$repo.$id`, `^$repo`, `0^$repo` — `` `$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^$id` / `0^$id` ``. Detected statically over the parsed tree (one `visit`, before evaluation and before the planner), so the error does not depend on which rows the data holds.
- **A bare target name inside a block** (scope depth ≥ 1: a row's clauses, a block body, a `from E` re-projection, a `follow` destination), until now a silent empty property read — `` `docs` inside a block reads a property of the current row, which has none — did you mean `^docs` (the repository's documents)? `` (the carets count the depth). `docs` and `edges` are refused statically; `blocks` and `nodes` are relations of some rows (`docs.blocks`, `docs.nodes`, `blocks.nodes`, `section.blocks`) and stay those — on a row that lacks the relation (`blocks` on a block or edge row, `nodes` on a node or edge row, `block.blocks`) the context raises the same error at read time, its hint spelling the rule. A frontmatter key named after a target is reachable only as `frontmatter.<k>`. The SQL translator declines a bare target name as a property read and the residual walk treats one that could raise as a residual that may raise, so a pushed conjunct cannot hide the error.
- **A `^<target>` with more carets than enclosing scopes** (`^docs count { }` at the top level — the natural misspelling after this migration — or `^^edges` from a top-level row), which OQX reads as absent and would count a silent 0 — `` `^docs` reaches past the root — there is no enclosing row at this depth; at the top level the repository's documents are the bare `docs` (`docs count { … }`, `from docs`, `entries(docs)`) ``. Statically, target names only.

**Migration** (every `$repo` in the fixtures, the tutorial, the corpus tests, the `query_syntax` text, the `query` tool description and the CLI help was rewritten this way):

| Before | After |
| --- | --- |
| `select …, x: $repo.docs collect { … } from docs` (inside a row, depth 1) | `^docs collect { … }` |
| `$repo.docs` two scopes down (a block's body) | `^^docs`, or `0^docs` from any depth |
| `follow $repo.docs collect { where … == ^$path }` | `follow ^docs collect { … }` (the destination is read in the frontier row's scope) |
| `$repo.docs count { … }` / `exists` / `none` / `first` / `single` at the top level | `docs count { … }` (a bare target at the root scope) |
| `$repo.$id` | `^$id` (depth 1) / `0^$id` (anywhere) |
| a bare `docs` inside a block (was an empty read) | `^docs` |
| a frontmatter key named `docs` / `blocks` / `nodes` / `edges` | `frontmatter.<k>` |

Fixtures: `spec/surface/cases/query-root.json` (31 cases: `^docs` at depth 1, `^^docs` and `0^docs` at depth 2, `^$id` / `0^$id` = `rp_0`, `entries(^$it)`, `^$it.docs` ≡ `^docs` as a value and as a correlated receiver, destination blocks over `^docs` / `0^docs` with the live rooted `^$path in list(after)` join, six `$repo` spellings, eleven bare-target shapes); every other suite's `$repo` query respelled with its expectation unchanged, except `query-edges::no-relations` and `query-nodes::no-relations-beyond-section`, which pinned the silent read and are re-queried with a non-target name; `interop.json` gained a `^docs` / `^$id` / `entries(^$it)` read and a `0^docs` read; `spec/cli` gained `query::root-caret`, `repo-removed`, `repo-removed-json`, `bare-target-in-block`, and the `query` help card is respelled. Builds on [the rooted-paths note](./surface-2.0-rooted-paths.md) (the same 2.0 major): `where ^$path in list(after)` inside `follow ^docs collect { … }` is live because both halves are the reference form.
