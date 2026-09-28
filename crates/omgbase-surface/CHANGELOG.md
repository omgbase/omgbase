# Changelog

All notable changes to `omgbase-surface` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [1.4.1] - 2026-09-28

### Patch
- `docs_move` now retargets the inbound links by default (spec/mutate 1.3): every authored link that named the old path (Markdown links and images, wikilinks, bare-path inline fields) is rewritten to the new path in the same call, as before with `retarget_inbound: true`, so a move never leaves the graph broken until a second `links_repair`. `retarget_inbound: false` is the opt-out for the rarer intent that the old path become unbound; frontmatter relations are still never rewritten and remain in `dangling`. The `omg mv` verb follows (spec/cli 1.2): it counts the rewritten links on stderr, `--no-retarget` opts out, and a dangling frontmatter relation now gets a `meta --set` fix hint instead of a `retarget` that could not have fixed it. The library default (`DocMoveOptions.retargetInbound`) flips the same way; the Rust catalog and binary mirror it.

## [1.4.0] - 2026-09-27

### Minor
- `version` tool (`spec/surface` §4, 1.4) in the Rust catalog and `omgbase version [--json]` (`spec/cli` §6, 1.1): which engine and which versions — `engine: "rust"`, the binary's own version, `components` (the `omgbase` crate, every `omgbase-*` crate it is built from and `oqx`, keys sorted bytewise), `specs` (each crate's `SPEC_VERSION`, `oqx`'s `LANGUAGE_VERSION`, the binary's new `cli::SPEC_VERSION` pinned to `spec/cli/VERSION`), `schema` (`PRAGMA user_version`, `null` without a database), `mcp: { protocol }` (no SDK), `runtime` (`rustc <version>`), `commit` and `built`. The verb needs no repo, opens the workspace only for `schema`, and with `--server` returns the remote engine's answer — how a user learns whether a remote is the TypeScript or the Rust engine. `--version` is unchanged.
- `omgbase-surface`: `BuildInfo` + `Surface::with_build_info` + `version_info(store, build)`; `MCP_PROTOCOL_VERSION` (`2025-11-25`, what the reference's SDK serves) is now the transport's default at `initialize` (a client's own revision is still echoed).
- `crates/omgbase/build.rs` records `OMGBASE_COMMIT` (`git rev-parse --short HEAD` from a checkout, else the `sha1` of the packaged `.cargo_vcs_info.json`, else unset → `null`), `OMGBASE_BUILT` (RFC 3339, `SOURCE_DATE_EPOCH` honored) and `OMGBASE_RUSTC`.
- Every spec crate and `oqx` gain a `pub const VERSION` (their `CARGO_PKG_VERSION`) so the surface can report component versions.
- Runners: `spec/surface` §6 records a `version` read by shape (leaves → type names, `components` → `"<object>"`, `mcp.sdk` dropped); `spec/cli` §8 applies the same to the `version` verb's stdout (JSON leaves; human value cells; the component lines collapse to `  <object>`).
