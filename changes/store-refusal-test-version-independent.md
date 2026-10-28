---
npm: {}
crates:
  omgbase-store: none
---
Express the newer-database refusal test in terms of `SCHEMA_VERSION` instead of
the literal of the day. The Rust unit twin hardcoded "v18 meeting a v17 build",
so the 17 → 18 bump turned its "one major ahead" into "exactly current" and the
case into a no-op — the same trap `spec/store`'s `newer-version-is-refused`
fixture fell into. Test-only; no behavior change.
