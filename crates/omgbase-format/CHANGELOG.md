# Changelog

All notable changes to `omgbase-format` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.2.4] - 2026-10-20

### Patch
- **Builds on Rust 1.88+ again, and says so.** `omgbase-surface` 5.0.0 did not compile on Rust 1.92 (`error[E0658]: if let guards are experimental`, `query.rs` — the static root-name check in the surface runner used an `if let` MATCH GUARD, which only a newer rustc accepts); the arm is rewritten with the `if let` inside the arm body (equivalent: the arm fell through to `_` either way). The workspace's declared `rust-version` moves from 1.85 to **1.88** — the toolchain that stabilized `if … && let …` chains, which the crates have used since store 16 — so an older toolchain is refused with cargo's clear message instead of a mid-build syntax error. Because clippy reads `rust-version` as its MSRV, the honest value also made `collapsible_if` ask for the let-chain form wherever a nested `if let` sat inside an `if`; `cargo clippy --fix` collapsed them across the workspace (51 files, every crate named above; re-indentation only, no behavior change — the diff is clippy's own rewrite). Verified: `cargo +1.92.0 check --workspace --all-targets --all-features` compiles, `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -D warnings` clean on 1.97, and the full `cargo test --workspace` sweep.

## [0.2.3] - 2026-10-17

### Patch
- YAML and JSON documents join the properties pipeline (spec/properties 1.2, §3.4): a `yaml`/`json` document's whole top-level mapping is its frontmatter — written as `source = frontmatter` rows, the same source a Markdown fence uses, so bare keys (`select focused_intent from docs where path == "/attn/focus.yaml"`), `data.<k>`/`frontmatter.<k>`, `entries(frontmatter)`, the `where` pushdown and `docs_read.properties.frontmatter` read it unchanged, on the observe path and the API path (`create`, `set content`) alike. A YAML stream's first document is the mapping; a parse error (the reference no longer takes a lenient parser's recovered mapping), a non-mapping root or an empty file yields no rows. No inline and no computed rows for these formats (`title`/`tags` are authored keys; no basename title). The frontmatter effects stay Markdown's for now: `set`/`unset frontmatter.<key>`, `docs_set_meta` and `create { frontmatter }` on a `yaml`/`json` document are refused with `type_mismatch` instead of fencing the file. New fixtures `spec/properties/cases/whole-document.json` (a `format` field per case) and `spec/surface` `reads::yaml-json-documents`. The Rust twin follows: `omgbase-properties` (unchanged rows), `omgbase-store`'s observe properties step over `omgbase-format`'s YAML/JSON mappings, and `omgbase-surface`'s refusal.

## [0.2.2] - 2026-09-27

### Patch
- `version` tool (`spec/surface` §4, 1.4) in the Rust catalog and `omgbase version [--json]` (`spec/cli` §6, 1.1): which engine and which versions — `engine: "rust"`, the binary's own version, `components` (the `omgbase` crate, every `omgbase-*` crate it is built from and `oqx`, keys sorted bytewise), `specs` (each crate's `SPEC_VERSION`, `oqx`'s `LANGUAGE_VERSION`, the binary's new `cli::SPEC_VERSION` pinned to `spec/cli/VERSION`), `schema` (`PRAGMA user_version`, `null` without a database), `mcp: { protocol }` (no SDK), `runtime` (`rustc <version>`), `commit` and `built`. The verb needs no repo, opens the workspace only for `schema`, and with `--server` returns the remote engine's answer — how a user learns whether a remote is the TypeScript or the Rust engine. `--version` is unchanged.
- `omgbase-surface`: `BuildInfo` + `Surface::with_build_info` + `version_info(store, build)`; `MCP_PROTOCOL_VERSION` (`2025-11-25`, what the reference's SDK serves) is now the transport's default at `initialize` (a client's own revision is still echoed).
- `crates/omgbase/build.rs` records `OMGBASE_COMMIT` (`git rev-parse --short HEAD` from a checkout, else the `sha1` of the packaged `.cargo_vcs_info.json`, else unset → `null`), `OMGBASE_BUILT` (RFC 3339, `SOURCE_DATE_EPOCH` honored) and `OMGBASE_RUSTC`.
- Every spec crate and `oqx` gain a `pub const VERSION` (their `CARGO_PKG_VERSION`) so the surface can report component versions.
- Runners: `spec/surface` §6 records a `version` read by shape (leaves → type names, `components` → `"<object>"`, `mcp.sdk` dropped); `spec/cli` §8 applies the same to the `version` verb's stdout (JSON leaves; human value cells; the component lines collapse to `  <object>`).
