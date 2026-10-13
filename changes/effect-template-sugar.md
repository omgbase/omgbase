---
npm:
  "@omgbase/core": minor
  omgbase: patch
crates:
  omgbase-mutate: minor
  omgbase-store: patch
  omgbase-surface: patch
  omgbase: patch
---
Effect template sugar (spec/mutate 3.2 §11.8 "Sugar"). In every slot that admits an expression (`markdown`, `to`, `path`, `separator`, `at.before|after`, `value`, top-level `create.frontmatter` values, a target's `id`/`path`, and whole targets), a JSON string beginning exactly `-> ` (dash, greater-than, space) is an OQX expression — the rest of the string — desugared to `{ oqx }` before compilation, so `"into": "-> project"` and `"markdown": "-> `- [${title}](${path})`"` read the hit's row with OQX 0.21 template literals as the string-building form. A string not beginning `-> ` is literal, always: no escaping, no `${` scanning; `-> "-> x"` spells a literal that begins with the leader. A leader whose expression is a bare string literal or an interpolation-free template folds to the plain literal before planning, so `-> "x"` and `"x"` share a `plan_id` (pinned). Bare targets: a document path, a `b_`/`d_`/`n_` id or `$new.n` stands for the target object (`"/x.md"` → `{ kind: "document", path }`); a `#` locator is `filter_invalid` with a `fix` naming `blocks_resolve`/`query`. Without a selector, an expression slot evaluates in its own target's row scope (one synthetic `from <root> where id == …` query per target; a `create`, an expression target or a `$new.n` target without `select` is refused with a hint), and the Plan and the intent record gain `templates` — the effects as written — only when a slot was an expression, so no existing plan digest moves (`planner_v` stays p3). A leader in a slot that takes no expression (`expect`, `field`, `op`, `heading_id`, `split.at`) and an unparsable expression (offset shifted past the leader) are `filter_invalid { hint: "selection" }`. Sixteen `sugar-*` cases in `spec/mutate/cases/effects.json` (63 → 79), both engines.
