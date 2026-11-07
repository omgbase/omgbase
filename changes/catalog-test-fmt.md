---
npm: {}
crates:
  omgbase-surface: none
---
`cargo fmt` picked up pre-existing drift in `catalog.rs`'s test module (two
multi-line `assert_eq!` calls over long string literals) while running the
verification gate for an unrelated change. Formatting only, inside
`#[cfg(test)] mod tests`; no behavior change.
