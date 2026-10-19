---
npm:
  "@omgbase/core": patch
crates:
  omgbase-surface: patch
---
The row-function rewrite targets `$it`, not a private `$self`. A bare row function (`text("x")`, `under(…)`, `semantic(…)`, …) now becomes `$it.text("x")` — `$it` is the language's own name for the scope's row (`spec/oqx` SEMANTICS §2) — instead of a method on a synthetic `$self` receiver the store context answered with the row. That receiver was an undocumented `$` name omgbase had added against its own name rule (`spec/surface` §1.2: omgbase adds no `$` names), and it leaked: a typed `$self.path` read the row's path on both engines. The `$self` branch is removed from both contexts; a typed `$self` is now an unknown OQX identifier like `$id` — absent, matching nothing — pinned by `query-errors::dollar-self-is-not-a-name`. Every other result is unchanged.
