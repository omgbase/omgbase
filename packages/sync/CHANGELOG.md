# Changelog

All notable changes to `@omgbase/sync` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

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
