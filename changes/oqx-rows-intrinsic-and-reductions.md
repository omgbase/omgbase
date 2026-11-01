---
npm:
  "@omgbase/oqx": major
  "@omgbase/oqx-syntax": major
  "@omgbase/core": minor
  "@omgbase/dataview": patch
crates:
  oqx: major
  omgbase-surface: patch
---

OQX 0.29: `$rows` is now a proper intrinsic — the group's rows at a group
scope, and `[$it]` (total, unlike the conditional walk intrinsics) everywhere
else — replacing the bare `rows` keyword, which collided with a host's own
`rows` property. `count sum min max avg collect first last any all` are no
longer a syntactic "aggregate" category: they are ordinary collection
functions (one argument, legal wherever a call is legal, no arity overload,
no `distinct` call-modifier — dedupe via the collection's own
`select distinct`). A non-key bare name at a group scope now reads the list
of that property's value across the group's rows instead of erroring. The
staging rule narrowed to what it actually needs to forbid: a pre-group clause
reading a `select` alias whose definition reads `$rows` (not the token
itself, which is legal everywhere).

Ported to both engines (`@omgbase/oqx` and the `oqx` crate) in lockstep.
`@omgbase/core` and `omgbase-surface` follow: two real bugs found and fixed
along the way — OQX's own group-vs-row reference classification and
omgbase's row-kind resolution (used for property-vocabulary hints) had both
hardcoded the bare `"rows"` string and silently misclassified `$rows`.
`@omgbase/oqx-syntax`'s `GROUP_ROWS` highlighting rule and export are
removed (`$rows` is now in `INTRINSICS`); `AGGREGATES` is renamed
`REDUCTIONS` (old name kept as a deprecated alias in `@omgbase/oqx` and
`@omgbase/oqx-syntax`, not in the `oqx` crate). `@omgbase/dataview`'s
`length(rows)` compilation target updated to `count($rows)`.

Deferred to a follow-up: the `?`/`!`/`?!` operator redefinition, and a
`distinct` postfix modifier on lists.
