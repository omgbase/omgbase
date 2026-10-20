---
crates:
  omgbase-surface: patch
  omgbase-format: patch
  omgbase-mutate: patch
  omgbase-properties: patch
  omgbase-reconcile: patch
  omgbase-search: patch
  omgbase-store: patch
  omgbase-sync: patch
  omgbase: patch
  oqx: patch
---
**Builds on Rust 1.88+ again, and says so.** `omgbase-surface` 5.0.0 did not compile on Rust 1.92 (`error[E0658]: if let guards are experimental`, `query.rs` — the static root-name check in the surface runner used an `if let` MATCH GUARD, which only a newer rustc accepts); the arm is rewritten with the `if let` inside the arm body (equivalent: the arm fell through to `_` either way). The workspace's declared `rust-version` moves from 1.85 to **1.88** — the toolchain that stabilized `if … && let …` chains, which the crates have used since store 16 — so an older toolchain is refused with cargo's clear message instead of a mid-build syntax error. Because clippy reads `rust-version` as its MSRV, the honest value also made `collapsible_if` ask for the let-chain form wherever a nested `if let` sat inside an `if`; `cargo clippy --fix` collapsed them across the workspace (51 files, every crate named above; re-indentation only, no behavior change — the diff is clippy's own rewrite). Verified: `cargo +1.92.0 check --workspace --all-targets --all-features` compiles, `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -D warnings` clean on 1.97, and the full `cargo test --workspace` sweep.
