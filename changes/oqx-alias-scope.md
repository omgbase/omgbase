---
npm:
  "@omgbase/oqx": minor
  "@omgbase/oqx-syntax": patch
  "@omgbase/core": patch
crates:
  oqx: minor
  omgbase-surface: patch
---
OQX 0.27 — a body's `select` names are the names of its rows everywhere. Through 0.26 only `where`, `having` and the items to an item's right saw a `select` alias; now every clause that reads the rows does — `where`, `having`, `frontier`, a `follow` destination (`follow kids` with `kids: children { where ok }`), `flatten`, a `group by` key, `order by` (`order by decade` with `decade: age / 10`) — and a nested block reads an enclosing body's alias through `^alias` (`^people count { where kind == ^k }` with `k: kind`), the alias's expression inlined shifted to the scope it is read from. An alias shadows a same-named row field wherever it is visible; `$it.name` reads the field. A block alias inlines as a value-position directive inside an expression (`where kids.size() > 1`; an error through 0.26) and still means "non-empty" alone as a leaf. In a grouped body a key that is a bare alias name takes the alias's expression and the post-group clauses read it as the key (`select kk: kind, n: count() … group by kk order by n desc`). Forward references stay errors, `^name` from a block included; `from`, `limit`/`offset` and the source are never rewritten. The tree keeps the surface form; `resolveAliases` / `resolve_aliases` perform the substitution and the `references` pass skips what they substitute. New fixture suite `spec/oqx/cases/alias-scope.json` (21 cases); the fixtures that pinned the old rule are flipped. The `query_syntax` card and manual describe the rule.
