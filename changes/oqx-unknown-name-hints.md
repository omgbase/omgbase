---
npm:
  "@omgbase/oqx": patch
  "@omgbase/core": patch
crates:
  oqx: patch
  omgbase-surface: patch
---

Two conformance fixes to the "did you mean" unknown-name hint mechanism
(`spec/surface` §1.5), in both engines:

- **`nodes { select _ordinal }`** (an engine-name error) used to suggest a
  coincidental, wrong authored vocabulary key (`last_ordinal`, a `md:section`
  node's own computed-looking attrs key) instead of a real field. The nearest
  match now also tries an exact reach-through correction first — `_ordinal`
  is a block attribute, reached through `_block` — so the error now reads
  `` …; did you mean `_block._ordinal`? ``, the actually reachable fix.
- **A `$`-prefixed name that is not one of the language's recognized
  intrinsics** (`$it`, `$key`, `$rows`, `$depth`, `$stop`, `$leaf`,
  `$frontier`, `$ordinal`) — notably the pre-5.0 (in fact pre-3.0) `$`-spelled
  engine attributes (`$path`, `$title`, `$updated_at`, …) and `$value` (which
  `spec/oqx/SEMANTICS.md` §2 already documents as "not an intrinsic... an
  ordinary property name") — used to be silently excluded from the
  `references()` static pass (`@omgbase/oqx` / `oqx`), so a stale 2.x client
  typing `$path` got no diagnostic at all: the projection was just absent and
  `order by $updated_at` silently did nothing. `references()` now treats any
  non-intrinsic `$`-name as an ordinary reference, so the surface's existing
  unknown-bare-name hint machinery judges it the same way it judges a bare
  `path` — `hints` now reads `` no document in this repository carries a
  property `$path`; did you mean `_path`? `` — and the nearest-match
  algorithm treats a leading `$` the same way it already treats a leading `_`
  (both are a stripped "engine declaration" prefix, `$path` being the
  language's own historical spelling of the same field `_path` now names).

`spec/oqx/AST.md` §5b's "What is not" bullet is corrected to name the actual
closed set of intrinsics (it previously said "`$`-names ... are the
language's values", which conflated the closed set with `$value`, already
documented elsewhere as not one of them) — a conformance fix, not a language
change, so `spec/oqx/VERSION` does not move.

Fixtures: `spec/oqx/cases/references.json` (`$value`/`$path` are now ordinary
references), `spec/surface/cases/query-errors.json` (the reach-through case,
and `hints` added to `dollar-names-are-not-omgbase-names` /
`dollar-self-is-not-a-name`), `spec/surface/cases/reads.json` and
`examples.json` regenerated (`SURFACE_SPEC_UPDATE=1`) for the `query_syntax`
card/manual text and the one affected `reads` case. `docs/query-language.md`
and the `query_syntax` text (both engines, byte-identical) updated to match.
