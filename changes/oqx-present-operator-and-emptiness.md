---
npm:
  "@omgbase/oqx": major
  "@omgbase/oqx-syntax": major
  "@omgbase/dataview": patch
crates:
  oqx: major
  omgbase-surface: patch
---

OQX 0.30: truthiness is now "absent, or the empty/zero form of its own
type" — `[]` and `{}` join `false`/`0`/`""` as falsy (through 0.29 an empty
array or object was truthy). This is a real behavior change to any existing
`where`/`!`/`&&`/`||` over a collection, not just new syntax.

New postfix `x?` — the present operator: over an array, the present elements
(absent when none survive, including an array that started empty — never
`[]`); over anything else (a scalar, an object, absent itself), unchanged.
Its point is scope-polymorphism: `weapon?` means the right thing whether
`weapon` is a row-scope scalar or a group-scope per-row list (§24), so
`having weapon?` reads "some row in this group has one" with no bespoke
grammar. Composes transparently with reductions (`count`/`sum`/etc. already
skip absent elements, so `?` changes nothing for them) and makes `has(x?)`
finally agree with `!x?`/`where x?` on "did anything survive" — before this,
`has(x?)` was unconditionally true, since `[]` was present.

`x?!` ("raise when nothing survives") was designed, then retired before
shipping: `first(x)!` / `last(x)!` already do that, at either scope, with a
choice of end — strictly more than a bespoke atom would offer, for zero new
syntax.

Also fixed in passing: SEMANTICS §24 claimed a reduction raises "cannot
reduce … not a collection" for a non-collection argument. Neither engine
ever implemented that — a reduction's argument is coerced leniently and
totally (absent → `[]`, anything else → a one-element collection), matching
§3's own absent-source rule. The prose now matches the already-shipped,
already cross-engine-consistent behavior; no code changed.

Ported to both engines in lockstep (TypeScript `@omgbase/oqx`, the `oqx`
crate), plus the one downstream gap each surfaced: `@omgbase/dataview`'s
`rebase` (an AST transform) and `omgbase-surface`'s SQL-pushdown
raise-analysis both had exhaustive matches over `Expr` missing the new
`present` node — both fixed, confirmed via `cargo build --workspace` /
`tsc -b` catching every site. `@omgbase/oqx-syntax`'s `LANGUAGE_VERSION`
bumped to 0.30 and `?` moved from its illegal-character list into its
operator table (assets regenerated).
