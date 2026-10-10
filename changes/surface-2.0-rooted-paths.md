---
npm:
  "@omgbase/core": minor
  omgbase: minor
  "@omgbase/sync": patch
crates:
  omgbase-surface: major
  omgbase: minor
  omgbase-sync: patch
---
**Paths on the surface are `/`-rooted** (`spec/surface` 2.0, `spec/cli` 2.0; Brendan's decision of 2026-10-10). omgbase has two path forms — storage (`docs.path`, the adapters, every store/sync spec) uses git's repo-relative form (`projects/oqx.md`), while every reference an author writes is root-absolute (`/projects/oqx.md`). The surface now speaks the reference form: every path a query, an MCP tool or an `omg` verb **returns** is rooted — `$path`/`$dst_path`, every hit's `path`, rows rendered as `{ id, path }`, `docs_list`/`docs_tree` (the tree's `prefix` is `/` for the root), `docs_read`/`docs_read_at`/`docs_get_many`/`read_ref`, `docs_history`, `diff_unified`, `changes_since` (revisions, deletions, moves and the `summary`), `links_stale`/`links_repair`/`links_retarget`, `text_search`, `resolve` locators, `graph`, `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta` (incl. `dangling[].path` and the dry-run `diffs` keys), `apply`, `docs_update`/`docs_plan_update` opsets, `observe*`, and the CLI's `ls`/`query`/`outline`/`show`/`new`/`mv`/`rm --doc`/`meta`/`log`/`find`/`sync`/`retarget` renderings — and every path they **accept** tolerates both forms (a missing leading `/` is added, an extra one stripped). A string literal compared with `$path`/`$dst_path` by `==`/`!=`, or passed to their `startsWith`, is rooted before evaluation, so `$path == "a.md"` keeps matching; nothing else is rewritten (a property's value is the author's: `where ^$path in list(after)` replaces `"/" + ^$path`). The keyset cursor carries the rooted path; a cursor from a 1.x surface is refused as `filter_invalid` naming the cause. Storage is unchanged — no migration.

Both engines: one normalization module each (`packages/core/src/core/paths.ts` + `surface-paths.ts` for the other-spec result shapes; `omgbase_surface::paths`), the SQL translator renders `$path` as `'/' || d.path` with an indexed fast path for a rooted equality literal, the store-index probes de-root their value, and the conformance suites, the surface fixtures (new `path-*`, `dst-path-*`, `refs-both-forms-resolve`, `reverse-reference-by-path-membership`, `cursor-from-1x-rejected` cases, `reads::alchemy` steps) and the interop suite prove the two agree byte for byte. `@omgbase/sync` / `omgbase-sync`: the coordinator de-roots the engine's paths before handing them to a source (`sync_out`, the reconcile summary). Rust `omgbase-sync` is otherwise untouched; `spec/sync` does not move.

**Migration:** add the slash — `$path.startsWith("projects/")` → `"/projects/"`, `$path.matches("^texts/")` → `"^/texts/"`, `"/" + ^$path` → `^$path`; a `links_stale` `target` is now paste-ready as a repair `from`; a client parsing `docs_tree`'s `prefix` reads `/` for the root; discard stored cursors (`query`, `docs_list`, `docs_tree`) and start the page sequence again.
