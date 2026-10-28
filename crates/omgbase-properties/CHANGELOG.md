# Changelog

All notable changes to `omgbase-properties` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [2.0.0] - 2026-10-27

### Major
- **The stored computed property keys lose the `$` sigil: `$title`/`$tags` become
  `_title`/`_tags`** (`spec/properties` 2.0, `spec/store` 18.0). `$` is reserved
  for OQX's intrinsics, and storage was the last place omgbase still spent it —
  both engines wrote `source = 'computed'` rows keyed `$title`/`$tags` and the
  surface re-keyed them to `_title`/`_tags` at the tool boundary. Now the stored
  key is the surfaced name and that translation is gone, so a computed property is
  spelled one way from the row to the result.

  A major rather than a minor because `prop_id` hashes the key
  (`spec/properties` §1), so every computed row's identity moves with it. The DDL
  does **not** change: `properties.key` carries no CHECK and the schema
  fingerprint is PRAGMA-derived, so the column's comment lies outside it.

  - **Migration 18** (`spec/store` §3.4 step 18) rewrites the rows of an existing
    database and re-derives each `prop_id`. It is programmatic, since stock SQLite
    has no `sha256`, and idempotent. **Scoped to `source = 'computed'` alone:** an
    authored key beginning with `$` is the user's own and is stored verbatim
    (reached as `_frontmatter.$x`), so a blanket `key LIKE '$%'` rewrite would
    corrupt it — `spec/store/cases/migrations.json`'s
    `v17-to-v18-computed-keys-lose-the-sigil` pins both halves: the computed rows
    re-keyed with new ids, and authored `$title`/`_title`/`title` rows untouched,
    key and `prop_id` alike.
  - **The boundary re-keying is deleted** in both engines (`surfaceProperties` /
    `surface_properties`); `docs_read`'s `properties.computed` is the grouped shape
    verbatim. The surface's output is byte-identical, so `spec/surface` does not
    move.
  - **Fixed, caught by `spec/cli`:** `omg show` subtracted the computed rows from
    the merged properties bag with a `!k.startsWith("$")` filter, which the rename
    silently defeated — `_title` was rendered twice, once under `properties` and
    again under `computed`. Both engines now subtract them by name, from the
    `properties.computed` group itself.
  - `@omgbase/core`'s exported `docPropertiesMerged` returns the stored keys, so
    its computed entries are now `_title`/`_tags` — a breaking change for a
    library caller that reads them.
  - Also corrected while here: `spec/properties`' header still claimed the surface
    reads the computed rows as the **bare** `title`/`tags`, a spelling two majors
    out of date, and the `newer-version-is-refused` migration fixture was pinned
    to `user_version: 18`, which the bump would have turned from a refusal into a
    successful open — it is now 19.

## [1.2.1] - 2026-10-20

### Patch
- **Builds on Rust 1.88+ again, and says so.** `omgbase-surface` 5.0.0 did not compile on Rust 1.92 (`error[E0658]: if let guards are experimental`, `query.rs` — the static root-name check in the surface runner used an `if let` MATCH GUARD, which only a newer rustc accepts); the arm is rewritten with the `if let` inside the arm body (equivalent: the arm fell through to `_` either way). The workspace's declared `rust-version` moves from 1.85 to **1.88** — the toolchain that stabilized `if … && let …` chains, which the crates have used since store 16 — so an older toolchain is refused with cargo's clear message instead of a mid-build syntax error. Because clippy reads `rust-version` as its MSRV, the honest value also made `collapsible_if` ask for the let-chain form wherever a nested `if let` sat inside an `if`; `cargo clippy --fix` collapsed them across the workspace (51 files, every crate named above; re-indentation only, no behavior change — the diff is clippy's own rewrite). Verified: `cargo +1.92.0 check --workspace --all-targets --all-features` compiles, `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -D warnings` clean on 1.97, and the full `cargo test --workspace` sweep.

## [1.2.0] - 2026-10-17

### Minor
- YAML and JSON documents join the properties pipeline (spec/properties 1.2, §3.4): a `yaml`/`json` document's whole top-level mapping is its frontmatter — written as `source = frontmatter` rows, the same source a Markdown fence uses, so bare keys (`select focused_intent from docs where path == "/attn/focus.yaml"`), `data.<k>`/`frontmatter.<k>`, `entries(frontmatter)`, the `where` pushdown and `docs_read.properties.frontmatter` read it unchanged, on the observe path and the API path (`create`, `set content`) alike. A YAML stream's first document is the mapping; a parse error (the reference no longer takes a lenient parser's recovered mapping), a non-mapping root or an empty file yields no rows. No inline and no computed rows for these formats (`title`/`tags` are authored keys; no basename title). The frontmatter effects stay Markdown's for now: `set`/`unset frontmatter.<key>`, `docs_set_meta` and `create { frontmatter }` on a `yaml`/`json` document are refused with `type_mismatch` instead of fencing the file. New fixtures `spec/properties/cases/whole-document.json` (a `format` field per case) and `spec/surface` `reads::yaml-json-documents`. The Rust twin follows: `omgbase-properties` (unchanged rows), `omgbase-store`'s observe properties step over `omgbase-format`'s YAML/JSON mappings, and `omgbase-surface`'s refusal.

## [1.1.1] - 2026-09-27

### Patch
- `version` tool (`spec/surface` §4, 1.4) in the Rust catalog and `omgbase version [--json]` (`spec/cli` §6, 1.1): which engine and which versions — `engine: "rust"`, the binary's own version, `components` (the `omgbase` crate, every `omgbase-*` crate it is built from and `oqx`, keys sorted bytewise), `specs` (each crate's `SPEC_VERSION`, `oqx`'s `LANGUAGE_VERSION`, the binary's new `cli::SPEC_VERSION` pinned to `spec/cli/VERSION`), `schema` (`PRAGMA user_version`, `null` without a database), `mcp: { protocol }` (no SDK), `runtime` (`rustc <version>`), `commit` and `built`. The verb needs no repo, opens the workspace only for `schema`, and with `--server` returns the remote engine's answer — how a user learns whether a remote is the TypeScript or the Rust engine. `--version` is unchanged.
- `omgbase-surface`: `BuildInfo` + `Surface::with_build_info` + `version_info(store, build)`; `MCP_PROTOCOL_VERSION` (`2025-11-25`, what the reference's SDK serves) is now the transport's default at `initialize` (a client's own revision is still echoed).
- `crates/omgbase/build.rs` records `OMGBASE_COMMIT` (`git rev-parse --short HEAD` from a checkout, else the `sha1` of the packaged `.cargo_vcs_info.json`, else unset → `null`), `OMGBASE_BUILT` (RFC 3339, `SOURCE_DATE_EPOCH` honored) and `OMGBASE_RUSTC`.
- Every spec crate and `oqx` gain a `pub const VERSION` (their `CARGO_PKG_VERSION`) so the surface can report component versions.
- Runners: `spec/surface` §6 records a `version` read by shape (leaves → type names, `components` → `"<object>"`, `mcp.sdk` dropped); `spec/cli` §8 applies the same to the `version` verb's stdout (JSON leaves; human value cells; the component lines collapse to `  <object>`).
