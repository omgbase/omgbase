---
npm:
  "@omgbase/oqx": none
  "@omgbase/oqx-syntax": minor
  "@omgbase/core": patch
crates:
  oqx: none
  omgbase-surface: patch
  omgbase: patch
---
OQX 0.22 (`spec/oqx` 0.21 → 0.22): **infix regex operators**, sugar over
`matches` at comparison precedence — `a ~ b` ≡ `a.matches(b)`, `a ~* b` ≡
`a.matches(b, "i")`, `a !~ b` ≡ `!a.matches(b)`, `a !~* b` ≡ `!a.matches(b,
"i")` (the PostgreSQL spellings; `uri ~ "newton"` is no longer `unexpected
character "~"`). Same unanchored search, same regex baseline, same string forms,
same absent rule (an absent receiver is false under `~`, hence **true** under
`!~` — OQX's absent, not SQL's NULL); non-associative; `!`/`not` bind tighter
(`not a ~ b` is `(!a) ~ b`). The AST keeps the operator as written (`binary.op`
`"~"` `"~*"` `"!~"` `"!~*"`), so `print` round-trips it. New suite
`spec/oqx/cases/regex-operators.json` (40 cases; 1350 fixtures).

- `@omgbase/oqx` 0.22.0 and the `oqx` crate 0.22.0 are bumped by hand with
  their CHANGELOGs, per the standalone convention (`none` here so the release
  does not bump them again); `omgbase-surface` and `omgbase` move their pin to
  `oqx = "0.22.0"`.
- `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.22; `OPERATORS.regex` (`!~*` `!~`
  `~*` `~`) highlighted as operators in every grammar (TextMate, Monarch,
  CodeMirror, Prism); `~` left `ILLEGAL_CHARACTERS`; assets regenerated.
- `@omgbase/core`: the `query_syntax` reference names the infix spellings under
  `strings`; the tier-3 planner treats a regex operator as it treats a
  `matches` call (never pushed, may raise, so the pushdown declines).
- `omgbase-surface`: `reference.rs` twin updated byte for byte; `translate.rs`
  leaves the four operators residual; `planner.rs` counts them as may-raise.
  `spec/surface/cases/examples.json` regenerated (the `query_syntax` text).
