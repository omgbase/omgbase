# Changelog

All notable changes to `@omgbase/sync` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.4.10] - 2026-10-10

### Patch
- **Paths on the surface are `/`-rooted** (`spec/surface` 2.0, `spec/cli` 2.0; Brendan's decision of 2026-10-10). omgbase has two path forms — storage (`docs.path`, the adapters, every store/sync spec) uses git's repo-relative form (`projects/oqx.md`), while every reference an author writes is root-absolute (`/projects/oqx.md`). The surface now speaks the reference form: every path a query, an MCP tool or an `omg` verb **returns** is rooted — `$path`/`$dst_path`, every hit's `path`, rows rendered as `{ id, path }`, `docs_list`/`docs_tree` (the tree's `prefix` is `/` for the root), `docs_read`/`docs_read_at`/`docs_get_many`/`read_ref`, `docs_history`, `diff_unified`, `changes_since` (revisions, deletions, moves and the `summary`), `links_stale`/`links_repair`/`links_retarget`, `text_search`, `resolve` locators, `graph`, `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta` (incl. `dangling[].path` and the dry-run `diffs` keys), `apply`, `docs_update`/`docs_plan_update` opsets, `observe*`, and the CLI's `ls`/`query`/`outline`/`show`/`new`/`mv`/`rm --doc`/`meta`/`log`/`find`/`sync`/`retarget` renderings — and every path they **accept** tolerates both forms (a missing leading `/` is added, an extra one stripped). A string literal compared with `$path`/`$dst_path` by `==`/`!=`, or passed to their `startsWith`, is rooted before evaluation, so `$path == "a.md"` keeps matching; nothing else is rewritten (a property's value is the author's: `where ^$path in list(after)` replaces `"/" + ^$path`). The keyset cursor carries the rooted path; a cursor from a 1.x surface is refused as `filter_invalid` naming the cause. Storage is unchanged — no migration.

  Both engines: one normalization module each (`packages/core/src/core/paths.ts` + `surface-paths.ts` for the other-spec result shapes; `omgbase_surface::paths`), the SQL translator renders `$path` as `'/' || d.path` with an indexed fast path for a rooted equality literal, the store-index probes de-root their value, and the conformance suites, the surface fixtures (new `path-*`, `dst-path-*`, `refs-both-forms-resolve`, `reverse-reference-by-path-membership`, `cursor-from-1x-rejected` cases, `reads::alchemy` steps) and the interop suite prove the two agree byte for byte. `@omgbase/sync` / `omgbase-sync`: the coordinator de-roots the engine's paths before handing them to a source (`sync_out`, the reconcile summary). Rust `omgbase-sync` is otherwise untouched; `spec/sync` does not move.

  **Migration:** add the slash — `$path.startsWith("projects/")` → `"/projects/"`, `$path.matches("^texts/")` → `"^/texts/"`, `"/" + ^$path` → `^$path`; a `links_stale` `target` is now paste-ready as a repair `from`; a client parsing `docs_tree`'s `prefix` reads `/` for the root; discard stored cursors (`query`, `docs_list`, `docs_tree`) and start the page sequence again.

## [0.4.9] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.4.8] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.4.7] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.4.6] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.4.5] - 2026-10-06

### Patch
- Dependency pins moved: .

## [0.4.4] - 2026-10-01

### Patch
- Dependency pins moved: .

## [0.4.3] - 2026-09-28

### Patch
- Dependency pins moved: .

## [0.4.2] - 2026-09-27

### Patch
- Dependency pins moved: .

## [0.4.1] - 2026-09-27

### Patch
- What 0.4.1 carries over the published 0.4.0 (waves 3c–4d; the crates shipped
  each step and are already current on crates.io).

  - **cli 1.0** (`spec/cli`) — the reference `omg` brought to the spec's decided
    rules: usage errors exit 2 with `usage:`, engine error codes kept on the
    wire, `--version` from the package, `--dry-run` on the document verbs
    (`new`/`mv`/`rm --doc`/`meta`) via surface 1.3 `dry_run`, `node set` fixed,
    `done` checks the node type, `retarget` prints a unified diff, one
    machine-mode rule, tool-shaped `--json`, `embedQueue` = the stale count,
    `doctor` counts live leaves; every verb honors the `OMGBASE_SPEC_MINTER` /
    `OMGBASE_SPEC_CLOCK` seams.
  - **store 13.5** collision-safe minting: a production mint never returns an
    id already in use (a 3,000-document ingest had collided at 360k blocks).
  - **mutate 1.2** — the destination parent of insert/move must be a container;
    a leaf is `type_mismatch`. An insert into a heading had silently destroyed
    it (both kernels and the cross-document move path).
  - **surface 1.3** — `dry_run` on the docs tools (`docs_create` / `docs_move` /
    `docs_delete` / `docs_set_meta`); typed pushes in the pushdown planner
    (bool/number literals against attrs and property reads push with
    `json_type` / `properties.type`).
  - `@omgbase/sync`: a sourceless write throws the typed `repo_not_found` the
    server emits; the shared embedding provider between the query path and the
    drain.
