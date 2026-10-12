# omgbase — Query Language Spec (OQX)

**As-built (2026-09):** the query language is **OQX** (omgbase Query eXpressions),
the **`@omgbase/oqx`** package (parser + engine + scalar-semantics contract — a
standalone zero-dependency library, in-tree at `packages/oqx` since ADR-019 and
published on its own version line), bound to omgbase's SQLite store by `packages/core/src/oqx-js/`
(a `DataContext` in `context.ts`, the `oqxRun` wrapper in `run.ts`, and a tier-3
pushdown planner in `planner.ts`). See **ADR-013**. This document specs the
language as-built; the **behavioral ground truth** is the corpus
(`packages/core/corpus/oqx/alchemy.test.ts` + `conformance.test.ts`), then the
`query` tool description in `packages/core/src/mcp/server.ts`. Where this doc and
those disagree, they win.

> **Specs.** The language itself is `spec/oqx` (grammar, semantics, the fixture
> corpus both engines run). The *binding* of that language to the store — roots,
> fields, attributes, reach-through, relations, the row functions, the runner's
> paging — is `spec/surface/README.md` §1, pinned by the corpus-backed suites
> `spec/surface/cases/query-*.json` (the 18-document alchemy repository, every
> case run planned and pure in-memory, which must agree). Regenerate with
> `SURFACE_SPEC_UPDATE=1` on `packages/core/corpus/surface/spec.test.ts`.

> **Scalar semantics changed with ADR-013** (there were no active users). This
> replaces the former CEL sublanguage; the notable differences from the retired
> CEL rules are called out inline as **[was CEL: …]**.

---

## 1. OQX — one expression

The `query` MCP tool takes a single OQX **string** plus pagination:

```jsonc
{ "query": "<OQX expression>", "limit": 50, "cursor": null }
```

Every concern folds into the expression: `select <expr>, name: <expr>, …`
(projection), `from docs|blocks|nodes|links` (source), `where <predicate>`,
receiver-constrained nested queries (`nodes exists { … }`, `collect { … }`),
correlation/joins (the `^` sigil, with `^docs`/`^nodes`/`^blocks` reaching the
root row's collections), bounded traversal (`follow`), `order by <expr> [asc|desc]`, and
`limit`/`offset`. Results are lean projected hits (`{ id, path, …projections }`
— the envelope keys are the attributes the language reads, so a hit's `id`
pastes into the next `where id == "…"` unchanged), a `count`/`exists`/`none`
scalar, or — for a `select <expr> values` projection — the bare projected
values (`values: […]`, §7); never full documents; hydrate by `id` afterward
(every tool spells a row's identity `id`/`path`, §2).

**Clause order is fixed (ADR-020, oqx ≥ 0.11).** Within one body — the top level
or any `{ block }` — clauses appear at most once each, in exactly this order:

```
[select <projection>] from <source> [where <pred>] [follow <rel> [{…}]] [order by …] [limit N] [offset N]
```

Every clause is optional except a top-level `from`; the receiver-plus-consumer
form `<target> count|exists|none|first|single { <block> }` (a bare target at the
root scope) supplies its own
source, so the block's `from` is an optional re-projection. A clause out of order
is a parse error that names the order (`` `select` must come before `from` — OQX
clause order is select, from, where, follow, order by, limit, offset ``). **Only
`select` may drop its keyword, and only when it is the first clause written**
(`path, era from docs where …`; in a block, `nodes collect { value }` projects
`value`). Every other clause always carries its keyword — with the 0.17 sugar
that a **block** whose leading expression is syntactically a predicate is a
`where`-first body: `nodes exists { kind == "md:task" }` ≡
`nodes exists { where kind == "md:task" }` (§3.6; a bare name still projects, a
predicate after a projection still needs `where`). At the top level a predicate
always needs `where`, and `from docs count` is an error rather than a projection
of a field called `count` (write `docs count { … }`, or
`select count from docs`). **`where` (and, since 0.17, a later `select` item) may
reference the same body's `select` aliases** (`select path, old: era < 1000 from docs where old`): the alias's
expression is substituted before evaluation (`resolveAliases`, once, ahead of
the runner's own rewrites — the parsed tree keeps the alias), so the pushdown
planner sees an ordinary predicate; an alias shadows a same-named field inside `where`; a cycle among
aliases is a parse error; each block rewrites only against its own `select`.
`order by` is not rewritten — it reads row fields.

Consumers (oqx ≥ 0.9): `collect` (rows, the default), `exists` (≥ 1 row),
`none` (0 rows — exactly `not … exists { … }`, and the way to say "every":
`nodes none { where kind == "md:task" and not checked }`), `count`, `first`,
`single`. There is deliberately no `all { … }`: its block would have to mean
something different from every other consumer's.

## 2. Targets and field namespaces

**The name rule (spec/surface §1.2, 3.0).** `$` belongs to OQX: `$it`, `$key`,
`$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are values the *language*
injects into a scope, and omgbase adds **no** `$` names (a `$id` or `$path` in a
query is an unknown OQX identifier — absent — never an attribute). Every engine
attribute is a **bare, snake_case name that wins on collision** — the convention
the relations (`children`, `blocks`, `out_links`, `doc`, `frontmatter`, …) always
followed: a bare name that is an engine attribute reads the engine's value,
never the author's. User data is bare too, read by any non-colliding key; where
a key of yours collides with an engine name, reach it through a **source
handle**: `data.<k>` (the merged authored view — frontmatter + inline by the
property rule, exactly the read a bare non-colliding key performs),
`frontmatter.<k>`, `inline.<k>`. So `path` is the engine's `/`-rooted location
and `data.path` your `path:` key; `title` the computed title (the first H1,
`spec/properties` §3.3) and `data.title` your `title:`; `tags` your tags ∪ the
body `#hashtags` (deduped, authored first, then hashtags in document order;
`null` when both are absent) and `data.tags` the authored list alone;
`entries(data)` lists every authored top-level key (frontmatter ∪ inline,
deduped, key order). There is no loud-error set: a bare `id`/`path`/
`updated_at`/`hash`/`raw` is simply the attribute (before this batch of 3.0 the
attributes were `$`-prefixed and the bare spelling was a "did you mean `$path`?"
error). A foreign key is named for what it is (`doc_id`, `block_id`, `via_id`,
`dst_id`, `dst_path`, `uri`), a column is its column (`type`, `text`, `depth`,
`ordinal`, `kind`, `predicate`, `field`). **Same value, same name, everywhere:**
tool results and arguments spell a row the same way (`id`, `path`, `raw`,
`hash`, `updated_at`, `doc_id`, …), so a key read from any result pastes into a
query and into a tool's `id` argument. On the closed `blocks`/`nodes`/`links`
targets an unknown bare field reads as absent; on the open `docs` target a bare
key that is not an attribute, a handle or a relation is a document property.

| kind | attributes | handles / self / relations |
| --- | --- | --- |
| docs | `id` `path` `raw` `hash` `updated_at` `title` `tags` `format` | `data` `frontmatter` `inline`; `doc`; `blocks` `nodes` `out_links` `in_links` |
| blocks | `id` `path` `doc_id` `raw` `hash` `updated_at` `type` `text` `attrs` `depth` `ordinal` | `block` `doc`; `children` `nodes` `out_links` `section` |
| nodes | `id` `path` `doc_id` `block_id` `kind` `name` `value` `attrs` | `section` `doc` `block`; `blocks` `subsections` `children` |
| links | `id` `path` `doc_id` `block_id` `via_id` `dst_id` `dst_path` `uri` `field` `dst_kind` `predicate` `provenance` `anchor` | `doc` |

Language words that can never be a bare field: `select from where is not and
or`, the literals `true false null`. The contextual words (`limit order offset
follow collect count first distinct desc by in`) parse as fields in expression
position (`select o: order from docs`). A user key with any reserved name is
`data.<k>` (or `frontmatter.<k>` / `inline.<k>` by source; `attrs.<k>` on a block
or node).

**[was, before 3.0: the attributes were `$`-prefixed (`$id`, `$path`, …) with
`$body`/`$content_hash`; blocks `$doc`, `$ordinal`/`$depth` (colliding with the
`follow` recursion intrinsics, which shadowed them inside a walk); nodes
`$doc_id`/`$block_id`/`$node_id`; the `links` target was `edges` (its relations
`out_edges`/`in_edges`, its root collection `^edges`) with `$src`/`$dst`/`$src_block`/`$via`/
`$dst_path`/`$dst_uri`/`$from_commit` and the field `src_field`. `$from_commit`
is gone outright — a query sees open edges only.]**

**Paths (spec/surface 2.0).** omgbase stores a document's path repo-relative
(`projects/oqx.md`), but every reference an author writes is root-absolute
(`[x](/projects/oqx.md)`, `before: [/timeline/kickoff.md]`). The surface
speaks the reference form: `path` on every target, `dst_path` on links, the
`path` of every hit and of a row rendered as `{ id, path }` are `/`-rooted.
Every path the surface accepts tolerates both forms — tool arguments, `refs(x)`,
`within(…)`, and a **string literal** compared with `path`/`dst_path` by
`==`/`!=` or passed to their `.startsWith(…)`, which is rooted before
evaluation (`path == "a.md"` and `path == "/a.md"` both match; write the
rooted form). Nothing else is rewritten: a property's value is the author's
(`where customer == ^path`, `where ^path in list(after)` — no `"/" + ^path`
glue), and `matches`/`contains`/`endsWith` read the string as it is
(`matches("^/texts/")`). The planner de-roots the literal (or roots the
column) so pushed SQL and the in-memory engine agree.

### `docs`
- **Bare identifiers** = a document **property** (frontmatter + inline `key:: value`,
  unioned), resolved against the indexed `properties` table. Nested maps flatten
  to dotted keys (`meta.owner`), and a bare `logging` reconstructs the nested
  object so `logging.level` navigates it. A value is scalar-comparable only when
  the key is **single-valued and scalar-authored** in scope; a list/repeated/
  collided key compares unequal — use `list()` (§4).
- **Source handles:** `data.<k>` (the merged authored view, frontmatter +
  inline — the read a bare non-colliding key performs; the way to an authored
  key whose name is an attribute: `data.path`, `data.title`, `data.tags`),
  `frontmatter.<k>` / `inline.<k>` (one source). The whole bag as a collection:
  `entries(data)` / `entries(frontmatter)` / `entries(inline)` (oqx ≥ 0.10) —
  one entry per top-level key, **in key order** (authored position is not
  indexed), valued by the same scalar-vs-list rule as a bare read, dotted keys
  folded back into a nested value; inside the block `$key` is the key and `$it`
  the value.
- **Attributes:** `id`, `path` (the **reference form**, `/`-rooted — see "Paths"
  above), `updated_at` (ISO-8601 UTC, compares lexicographically =
  chronologically), `raw` (the whole file, frontmatter included), `hash` (its
  sha256, 64 hex), `title` (the computed title — the first H1 — `null` when
  none; the authored `title:` is `data.title`), `tags` (the authored tags ∪ the
  body `#hashtags`, deduped, authored first; the authored list alone is
  `data.tags`), `format` (`"markdown"`/`"yaml"`/`"json"`).
- **The root row** (spec/oqx 0.18, surface 2.0): the repository is the root
  scope's row. From a top-level row `^docs` / `^blocks` / `^nodes` / `^links` are
  the explicit root scans (§3.4; one caret per enclosing block, or the absolute
  `0^docs` from any depth), `^id` / `0^id` the repository id, and `^$it` the
  root object itself — `^$it.docs` ≡ `^docs`, `entries(^$it)` names the four
  collections (`id` is an attribute, not an entry). **[was: `$repo.<target>` /
  `$repo.id`, an intrinsic of every scope — removed in surface 2.0; reading
  `$repo` anywhere is `filter_invalid` naming the replacement. A bare target
  name inside a block (`docs collect { … }` at depth ≥ 1) is `filter_invalid`
  too — "did you mean `^docs`" — not an empty property read, and so is a
  `^docs` with more carets than enclosing scopes (`^docs count { }` at the top
  level — write the bare `docs`); a frontmatter key named
  `docs`/`blocks`/`nodes`/`links` is reachable only as `frontmatter.<k>`.]**
- **`$it`** (every scope, oqx ≥ 0.8): the current item **itself** — the row
  when scanning a target, or the scalar element when a block's receiver is a
  list-valued property (`tags exists { where $it == "pricing" }`,
  `tags collect { $it values }`). Inside a block `^$it` is the enclosing
  row. It is engine-owned (never a stored field) and never pushed to SQL.
- **Relations:** `nodes`, `blocks`, `doc.out_links`/`doc.in_links` (a doc's
  links as rows). There is no `out`/`in` relation (3.0): the documents at the
  other end of the links are `out_links collect distinct { from dst }` (linked
  to) and `in_links collect distinct { from doc }` (linking in) — `dst` is a
  link row's destination document, `doc` its source (see `links`).

### `blocks`
- **Bare fields:** `doc_id` (the owning document), `type`, `text` (the
  normalized text), `ordinal` (0-based among its siblings), `depth` (nesting
  depth, 0 at the top level), and every `attrs` key FLATTENED onto the row: a
  bare `checked` reads `attrs.checked` (`attrs.<key>` still works). The
  structural fields win on a name collision; an absent key is silently false in
  a predicate, exactly like a missing frontmatter key on a doc. Inside a
  `follow`, `$depth`/`$ordinal` are always the walk's metadata (§6); a block's
  own nesting is `depth`/`ordinal` everywhere.
- **Attributes:** `id`, `path` (the owning doc's path), `raw` (the block's raw
  source bytes — a container's raw holds its children verbatim), `hash` (its
  sha256; the value `update`/`split` expect as `expect.content_hash`),
  `updated_at`.
- **Doc reach-through:** `doc.<key>` / `doc.path` / `doc.id` / `doc.format`
  constrain by the owning document (scope, not selection). `doc.id` and
  `doc.path` are **foreign-key eliminated** (spec/surface §1, 3.0): they read
  the row's own `doc_id` / joined path — no owner lookup in memory, the FK
  column in SQL — so `doc.id == "d_1"` and `doc_id == "d_1"` plan to the same
  statement.
- **Relations:** `block.children`, `block.nodes`, `block.out_links`, `section`
  (enclosing `md:section` node(s)). **Structural functions:** §5.

### `nodes`
- **Bare fields:** `kind` (`md:task`/`md:link`/`yaml:…`), `name`, `value`, and
  every `attrs` key FLATTENED onto the row (`checked` on a task, `level` on a
  section == `attrs.checked` / `attrs.level`; `attrs.<key>` still works).
  `kind`/`name`/`value` win on a name collision; an absent key is silently false.
- **Bare fields (foreign keys):** `doc_id`, `block_id` (null for a block-less
  node).
- **Attributes:** `id`, `path`.
- **Reach-through:** `doc.<key>` / `doc.id` / `doc.path`, `block.type` /
  `block.text` / `block.id` / `block.path` / `block.doc_id` (the identity
  reads are FK-eliminated: the node's own columns).
- **Section relations:** `section.blocks` (content under an `md:section` node's
  heading), `section.children` (immediate child sections), `section.subsections`
  (all contained sections).

### `links`
The authored link graph as first-class rows — one row per link RELATION (the
open `edges` rows of the storage table, `to_commit IS NULL`; the target was named
`edges` before the 3.0 name pass). Distinct from the `md:link`/`md:wikilink`
NODE, which is a link's syntactic occurrence in the text: the `links` row is the
relation it establishes, `via_id` points at that node, and a frontmatter or
inline-field link has a row and no node.
- **Bare fields:** `doc_id` (the **source** document), `block_id` (the source
  block; null for a frontmatter edge), `via_id` (null unless derived through
  another node), `dst_id` (the destination node id: a doc id, an external node
  id or `phantom:<path>`), `dst_path` (target doc's path, `/`-rooted; null when
  external/dangling), `uri` (external URL; null otherwise), `predicate`,
  `provenance`, `dst_kind`, `anchor`, `field` (the frontmatter key / inline
  field the edge was authored in; null for a link).
- **Attributes:** `id`, `path` (the **source** document's path). There is no
  `from_commit`: a query sees open edges only; the creating commit is history
  (`blocks_history`, `changes_since`).
- Source-document reach-through: `doc.<key>` / `doc.id` / `doc.path`.
  `text()`/`semantic()` are unavailable (links carry no text/embedding).

## 3. Scalar semantics (`@omgbase/oqx` contract)

Everything inside `where`/`select`/`order by` that isn't structural navigation is
a scalar expression evaluated by `@omgbase/oqx`'s `semantics.ts`.

### 3.1 Grammar
Comparisons (`== != < <= > >=`), identity (`is`, `is not`; §3.6), boolean
`and or not` + grouping (the canonical spelling, and what `print` writes since
0.18; `&& || !` are accepted synonyms; prefix `is x` ≡ `!!x`, `not x` ≡ `!x`),
`in`, arithmetic (`+ - * / %`), Ruby-style range literals
(`lo..hi`, `lo...hi`, `..hi`, `lo..`; §3.5), method calls (`x.contains("s")`),
free functions (`list(x)`, `size(x)`, `has(x)` + omgbase's domain functions §5),
field/intrinsic access with `.` navigation, bracket lookups (`refs(x)[0]`,
`^docs[path == ^company]`; §3.6), the postfix required operator (`title!`;
§3.6), and outer references (`^name`, `^^name`). Reserved words (never a bare
field name): `from where select is not and or`, `true false null`.
**[was CEL: arithmetic, ternary, and `in` without `list()` were rejected — now
arithmetic and general `in` are supported.]**

### 3.2 Equality, comparison, absence — the normative rules
- **`==` / `!=` are strict, typed, and absence-normalized.** No cross-type
  coercion (`5 == "5"` is false). `null` and a missing field are the same
  "absent" value, and two absent values are **equal**. Therefore **`absent != v`
  is true.** **[was CEL: a missing key made *every* comparison false, including
  `!=` — that "absence collapses `!=`" rule is gone.]**
- **Relational `< <= > >=`:** if either operand is absent, the result is **false**
  (never orders, never throws). Present operands compare with native ordering
  (numbers numerically, strings lexicographically).
- **Truthiness (`where <expr>`, `!x`):** JavaScript truthiness — falsy is
  `false`, `0`, `""`, `null`, `undefined`, `NaN`; everything else (including `[]`,
  `{}`, and the non-empty string `"false"`) is truthy. **[was CEL: the string
  `"false"` was falsy.]**
- **Arithmetic:** `+` concatenates when either side is a string, else numeric;
  other operators coerce via `Number()`.

### 3.3 Strings and `in`
- `contains` / `startsWith` / `endsWith` / `matches` / `size` / `lower` / `upper`
  as methods; `matches` is a real **regexp**. **All string ops are
  CASE-SENSITIVE** — use `.lower()`/`.upper()` to fold. **[was CEL: `LIKE`-based
  ops were case-insensitive and `matches` was unimplemented.]**
- `x in y`: array → typed membership (`"5" in [5]` is false); string → substring;
  object → key existence; **range → interval coverage** (§3.5).

### 3.5 Ranges
A Ruby-style range is a value, used most often as the right side of `in`:
- `lo..hi` includes both bounds; `lo...hi` excludes the high bound; `..hi` and
  `lo..` are open-ended (a missing bound is unbounded on that side).
- `x in lo..hi` is coverage: `lo <= x` (if `lo` present) and `x <= hi` / `x < hi`
  (if `hi` present), using the same ordering as `<`/`<=`. An absent `x`, or one
  that doesn't order against a bound, is not covered (never throws). So ranges
  work over numbers **and ISO-8601 date/time strings** (lexical = chronological).
- **A frontmatter value can hold a range**, but it is stored as a **plain
  string** — `window: 2026-01-01..2026-01-31` compares, projects, and displays as
  text like any string. Wrap it in **`range(s)`** to read it as an interval:
  `where "2026-02-01" in range(window)` selects docs whose window covers that
  date. `range(...)` is the explicit opt-in — a value that merely looks rangey
  (`version: "1..4"`) is never silently reinterpreted, and `version == "1..4"`
  works normally. A non-range string yields an absent range, so
  `x in range(bad)` is false. Range-vs-range containment/overlap is not yet a
  surface.
  - The store still **autopromotes** a recognized range string into cached
    bounds (`detectRange` → `val_json`; see properties-table.md) — but purely as
    an index substrate for a future pushdown of `in range(prop)`, never changing
    an answer. So the promotion is safe: meaning is set by `range(...)`, not by
    what the value happens to look like.

### 3.6 Sugar (OQX 0.17)
Every form below is shorthand for an explicit directive and **desugars in the
parser** (the AST, `print`, the planner and the optimizer see the explicit form):

| Written | Means |
| --- | --- |
| `nodes { kind == "md:task" }` | `nodes collect { where kind == "md:task" }` — a receiver block without a consumer is `collect`; a block whose *leading* expression is syntactically a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a consumer test, a bracket chain or `x!` — anything but a bare name, a dotted path or a `^`-lift) is `where`-first. `nodes { name }` still projects; `nodes { is checked }` is the bare-field filter; `{ name where kind == "md:task" }` keeps the keyword. Wherever a value stands (spec/oqx 0.20), call arguments included (`size(children { is checked })`), and after any `follow` destination: `follow children { depth 2 }` and `follow refs(before) { depth 2 }` are that destination's block. `x distinct { … }` is `x collect distinct { … }`. |
| `(a, b)` | a tuple (spec/oqx 0.20): two or more expressions, concatenated one level flat — a value (`size((tags, aliases))`, `"x" in (tags, aliases)`) and a receiver (`(mom, dad) { title }`, `follow (before, after) { depth 2 }`); one parenthesized expression is grouping. |
| `refs(x)[0]`, `refs(x)[${i}]` | `refs(x) first { offset 0 }` — positional (an integer literal or a binding; out of range ⇒ absent); `refs(x)[0].title` navigates the row |
| `^docs[path == ^company]` | `^docs first { where path == ^company }` — the first match or absent |
| `^docs[path == ^company]!` | `^docs single { where path == ^company }!` — exactly one match; zero or many is `filter_invalid` |
| `title!` | required: `title`, or `filter_invalid` naming the expression (`` `title!` is absent on "d_…" ``). Never a filter, never a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!.name` vs `refs(c)[0].name!`). `select id!, status from docs` insists on identity before a write. |
| `is x`, `not x` | `!!x`, `!x` (truthiness) |
| `x is y`, `x is not y` | identity (`$key`, spec/oqx §16): a store row's id, a plain value structurally — so `$it is ^$it` compares rows (which `==` leaves unspecified); `owner is null` is absent; for scalars `is` ≡ `==`. Comparison precedence, no chaining. Never pushed down (residual). |
| `a and b`, `a or b` | the connectives — exactly `a && b`, `a || b` (precedence, short-circuit, value: `title or path` coalesces); the words are canonical |
| `boss: ^docs[path == ^manager], bossName: boss.title` | a `select` item may use the items to its left (inlined like a `where` alias; a reference to an item to its right is a parse error) |

The top level is unchanged: `type == "x" from docs` stays the parse error it was
(`where` would precede `from`). There is no `expand`/`unnest` and no automatic
dereference of a path-valued field: the body-level `from` chain flat-maps
(`docs collect { from nodes … }`) and `refs(x)[0].title` is the
dereference.

### 3.4 Correlation (`^`) and lifts
- **Bare names are local.** A bare identifier resolves against the **current row
  only**; an absent field is absent — it never falls through to an enclosing row
  or to the repository root, so adding a same-named field to an inner row cannot
  change what an outer reference means. Reach outward explicitly: `^name` for
  the enclosing row, `^docs` / `^nodes` / … for a root scan — the repository is
  the root row (spec/oqx 0.18), one caret per enclosing block, or the absolute
  `0^docs` from any depth. A bare target name inside a block is `filter_invalid`
  ("did you mean `^docs`"), never an empty read. **[was (surface < 2.0):
  `$repo.<target>` reached the root from any scope — refused now, with the
  replacement named; (oqx < 0.7): an absent local name climbed enclosing scopes,
  and a bare `repo` reached the root that way.]**
- **`^name` reads a name `N` scopes outward** (`^` = one scope, `^^` = two) — it
  resolves against the enclosing **row's fields/attributes/lifts**, not the outer
  query's select aliases. To reference the outer row's path write `^path` (not a
  `me: path` alias). **[was CEL/omgbase: `^name` read a bound select value; that
  binding indirection is gone — read the field directly.]**
- **`^name:` in a select** *lifts* the value `N` scopes out (flatten-append),
  binding it into the enclosing scope while the collect filters (§ lifts).

## 4. `list()` / `size()` / `has()` / `entries()`
`list(f)` coerces scalar-or-list to an array (absent → `[]`); legal anywhere,
canonically inside `in`/`size`. `size(x)` = string/array length or object key
count. `has(f)` = the field is present (not null). A list-authored key is not
scalar-comparable (`tags == "x"` is false); use `"x" in list(tags)`.

## 5. Domain functions (omgbase extensions)
omgbase registers these on the `DataContext` (they are not part of the generic
`@omgbase/oqx` builtins); they compose like any predicate, including inside
nested/correlated scopes:
- `text("terms")` — FTS5 pruning predicate (docs match via their blocks; nodes via
  the node index). Prunes; ranking is separate (`order by`).
- `semantic("phrase")` — embedding cosine **score** (docs/blocks), for a threshold
  (`semantic("x") > 0.6`) or projection; needs an embedding provider.
- **blocks-target structural functions:** `under(id_or_heading)`,
  `under_heading("s")` (case-insensitive), `within(doc|path|glob)`,
  `under_kind(type[, name])`, `yaml_path("a.b")`, `json_pointer("#/a/b")`,
  `has_edge(pred[, target])`, `has_anchor()`, `parent_type()`, `child_count()`.
- **`refs(x)`** (surface 1.5) — the live documents named by the **document
  references** a property holds: `x` is a string, a list, or absent; each
  string element that is a path in either form (`/timeline/kickoff.md`,
  `timeline/kickoff.md`) or a doc id (`d_…`) resolves to that document's row
  (an id is tried when no path matches); anything that resolves to
  nothing is dropped — no phantom, no error. Order preserved, duplicates kept.
  Index-backed (one lookup per element, never a scan). It yields docs rows, so
  it works wherever rows do: `follow refs(before), refs(after)` walks a
  timeline both ways; `select prior: refs(before) collect { path }` projects
  the referenced documents; `where refs(see_also) exists { where type == "x" }`
  filters on them; `from refs("/index.md")` is a source. The reverse direction
  needs no function: `path` is already the reference form, so
  `^docs collect { where ^path in list(after) }` is "the documents whose
  `after` names me".
- **A hit is a store row.** Every top-level row of a `collect`/`first`/`single`
  query must be a document, block, node or link; `follow before` over a list of
  paths reaches the list's *strings* and fails loud — `filter_invalid: a hit
  must be a document, block, node or link row — the query reached a string
  ("/timeline/kickoff.md"); to follow document references held in a property
  use refs(<field>)`. Write `follow refs(before)`. A `values` projection
  returns no hits and is exempt; nested blocks are unaffected (their rows are
  values, see §7).

## 6. `follow`, the edge graph, and `distinct`
- **Traversal:** `follow <dest>, …` recurses over one or more type-preserving
  destinations; a plain destination is a relation of the current row
  (`block.children`, `section.children`/`section.subsections`) or a destination
  block over the link rows — the citation graph is `follow out_links collect {
  from dst }` (outgoing) / `follow in_links collect { from doc }` (backlinks),
  the knobs as clauses of the block (`… collect { from dst depth 2 }`, spec/oqx
  0.20); an external or dangling link has no `dst` and contributes no successor.
  Per-path: a node reached by N paths yields N occurrences; `follow distinct`
  keeps one per identity (`$key` — a store row's id; a block may project `$key:
  <expr>` to rekey the rows it yields). Each occurrence carries `$depth` (seed =
  1), `$stop` (`interior|leaf|frontier|depth|cycle`) with `$leaf`/`$frontier`
  sugar, `$ordinal` (deterministic 1..N over the walk) and `$key`. A destination
  block's `where` shapes participating successors, its `frontier <pred>` cuts
  (occurrences this destination reached), its `depth <n>` bounds the walk
  through it (1..8). A revisited identity on the path is admitted once as `$stop
  == "cycle"` and never re-expanded. Recursion intrinsics are result metadata
  (valid in `select`/`order by` and the top-level post-walk `where`), not
  metadata of the candidate rows a destination block's `where` reads.
- **Destination lists** (`spec/oqx` 0.14): `follow out_links collect { from dst
  }, in_links collect { from doc }` walks the union of the destinations — within one step the successors are concatenated
  in source order and deduplicated by identity, so a document both cited by and
  citing the current row is stepped into once; the destination that reached a
  row first governs it (its `frontier`/`depth`). A tuple is one destination over
  the union of its elements: `follow (before, after) { depth 2 }`.
- **Destination blocks:** a destination may be a select-position block
  re-evaluated per frontier row — `follow ^docs collect { where out_links
  exists { where dst_path == ^^path } }` computes backlinks as a block over
  the root's documents (the same rows as `follow in_links collect { from doc
  }`). Inside the block `^` is the frontier row (the
  destination is read in that row's scope, so `^docs` there is the root's
  documents); `first`/`single` yield at
  most one successor; `exists`/`none`/`count` are not destinations. Since
  spec/oqx 0.20 **a brace after any destination opens that destination's
  block** with the implicit `collect` (there is no options block any more):
  `follow children { depth 2 }`, `follow refs(before), ^docs { where ^path in
  list(after) }` — the latter walks `before` references forward and, backward,
  every document whose `after` names the frontier row. Two clauses sit after a
  destination block's `where`: `frontier <pred>` and `depth <n>` (`follow
  out_links collect { from dst where layer == "canon" depth 2 }`); `depth` is a
  destination block's alone. **The body that carries the `follow` may write
  `frontier <pred>` too**, after its `where` and before `follow`, and it applies
  to the **seeds** — read in the seed's scope like the body's `where`: `from docs
  where type == "process" frontier !verified follow out_links collect { from dst
  }` keeps the unverified process in the result (`$stop == "frontier"`) without
  expanding it, while the destination's `frontier` governs the occurrences it
  reaches; neither applies to the other's rows. Without a `follow`, a body-level
  `frontier` is a parse error.
  The former `by <expr>` option is gone: identity is `$key` (a store row's id),
  and a block may project `$key: <expr>` to rekey the rows it yields (`follow
  out_links collect { $key: type from dst }`; in a destination block `$key:` is
  not a column). A bare `follow ^docs` (no brace, no consumer) is a parse error
  naming both block spellings.
- **Correlated successor `where`:** inside a destination block's `where`, a bare
  name is the candidate's own property, `^name` is the **frontier row** being
  expanded, and `^^name` the walk's enclosing scope — `follow out_links collect
  { from dst where out_links exists { where dst_path == ^^path } }` keeps
  only mutual citations
  (before 0.14 `^` skipped the frontier row and such predicates matched nothing).
- **Links as rows:** `from links …`, or a doc's `doc.out_links`/`doc.in_links`.
  A link row reaches both ends: `doc` is its source document and `dst` (3.0)
  its destination document — present when `dst_kind == "document"` and the
  document exists, absent for an external or block destination and for a
  dangling (phantom) target; `dst.title`, `dst { title }` (one record — `dst`
  is one object, so the block is a record or, when `dst` is absent, absent;
  spec/oqx 0.20 §3), `where out_links exists { where dst.layer == "draft" }`;
  `dst.<k>` pushes down like `doc.<k>`.
- **`distinct`** on any consumer dedups the rows it reduces by their **projected
  value**: `select distinct type`, `nodes collect distinct { select kind }`,
  `nodes count distinct { select kind } == 3`. Empty projection → dedup by
  identity.

## 7. `order by`, `select`, pagination
- **`order by <expr> [asc|desc], …`:** orders by attributes, bare fields,
  `doc.<key>`, or a `semantic(…)` score. **Absent values sort last** (ascending).
  Ties break by `(path, id)` for a stable keyset cursor; a custom `order by`
  disables the cursor (you get the top `limit` with `truncated`). **[was CEL/
  SQLite: NULLs sorted first ascending.]**
- **`select`:** default hit is `{ id, path }`; add `name: <expr>` fields and
  nested `collect { … }` / `first { … }` / `single { … }`. `select id, path` is
  simply the envelope (the attribute collapses onto its own key — never a
  duplicate column); any **other** projection whose output key would be `id` or
  `path` — `select data.path`, `select path: doc.layer` — is `filter_invalid`
  ("projection `path` collides with the hit envelope — alias it (`p:
  data.path`)"), so the envelope is never overwritten. An item that is not a
  plain navigation (a call, arithmetic) needs an alias — `n: size(tags)` —
  unless the projection is in `values` mode (which returns no hits, so the
  envelope rule does not apply there).
  **Rows as values** (surface 1.2; keys renamed in 3.0): wherever a store row
  surfaces as a *value* rather than a hit — a nested `collect { }` / `first { }`
  / `single { }` with an **empty** projection ("the row itself", oqx §12), a
  `values` projection of `$it`, a field bound to a row — it is rendered as
  `{ id, path }` (the row's id and its document's path), never the raw store
  row (before 1.2 the columns leaked, `attrs` as a JSON string and the `__path`
  join column included). `tasks: nodes collect { where kind == "md:task" }` is
  therefore a list of `{ id, path }` node refs — the same shape a hit leads
  with.
- **`values`** (oqx ≥ 0.8): `select <expr> values` — exactly **one** item — makes
  each row's result the bare value rather than a `{ name: value }` record. At the
  top level the result carries `values: […]` in place of `hits` (empty), paged
  and `distinct`-deduped exactly like hits (`select distinct type values from docs`
  → the type strings). Inside a `collect`/`first`/`single` block it yields a plain
  array / scalar (`tags: tags collect { $it values }`, `latest: nodes first
  { value values order by … }`). The runner implements the top-level form by
  projecting the single item under a reserved key alongside the injected
  `id`/`path`, then peeling the values off the final page — so the keyset
  cursor still works (`values` carries no hits, so the envelope rule does not
  touch it).
- **`limit N` / `offset N`** (oqx ≥ 0.9): bound the row set **after** `where` /
  `order by` / `distinct` and **before** the consumer reduces it, so they mean
  the same thing under every consumer (`nodes count { … limit 5 } <= 5`,
  `nodes exists { offset 1 }` = at least two, `first { … offset 1 }` = the
  second). At the top level they define the result **set**; the tool's
  `limit`/`cursor` options then page *within* it (so `order by era desc limit 3`
  with a page `limit` of 2 returns two hits, `truncated: true`, and the third on
  the next page). The runner applies a top-level bound after its own
  `distinct` dedup, so `select distinct type limit 3` is three distinct types.
  Top-level bounds must be integer literals; inside a block `^n` reads the
  enclosing row.
- **`cursor`:** opaque, keyset on `(path, id)`, valid for the same query only.

## 8. Execution model
- OQX parses to the `@omgbase/oqx` AST and runs on the in-memory engine over a
  store-backed `DataContext` (`context.ts`), which resolves fields/attributes/
  relations and the domain functions against SQLite.
- A **tier-3 pushdown planner** (`planner.ts`) translates a query's pushable
  top-level `where` conjuncts into one guarded SQL `SELECT` (via
  `sql/translate.ts`), reducing the scanned row set; everything it declines is a
  **residual** finished in-memory. The translator is **semantics-faithful** — e.g.
  `==`/`!=` → SQLite `IS`/`IS NOT` (null-safe), string ops → case-sensitive
  `substr`/`instr` (never `LIKE`). **[was CEL: the whole query compiled to a
  single SQL statement; now it is pushdown + residual.]** Invisibility is kept
  by declining (spec/surface §1, the 1.1 patch): a comparison is pushed only
  when its operand kinds (text, int, num, bool, null, json = an `attrs` read,
  prop = a document property) are provably compared the same way — plainly
  (`IS`/`IS NOT`, or the bare relational operator) when one side is text, or
  one side is null and the other is not a property, or both are numeric;
  `<`/`<=`/`>`/`>=` plainly only when both are text or both numeric
  (`sql/translate.ts`, `comparable`). A bool or num literal/binding against a
  json or prop read is a **typed push** (spec/surface §1, the 1.2 patch;
  `typedComparison`): the stored type is tested in SQL before the value and the
  whole test is wrapped `(…) IS 1` (`==` and the relational ops) or `(…) IS NOT
  1` (`!=`, the negated equality test), so an absent or differently typed value
  is unequal and never ordered, as in memory —
  `checked == true` → `(json_type(b.attrs, '$.checked') = 'true') IS 1` (no
  bind; `'false'` for false); `level >= 2` → `(json_type(b.attrs, '$.level')
  IN ('integer', 'real') AND json_extract(b.attrs, '$.level') >= ?) IS 1`;
  `verified == true` → `(SELECT p.type = 'bool' AND p.val_bool = ? FROM
  properties p WHERE …single scalar row… LIMIT 1) IS 1` (bound 1/0); `era !=
  800` → `(SELECT p.type = 'number' AND p.val_num = ? … LIMIT 1) IS NOT 1`. A
  constant on the left flips a relational op (`800 < era` ⇔ `era > 800`).
  Everything else — `$ordinal == checked`, `true == 1`, `tags != null`,
  `$ordinal < "3"`, `level < "x"`, `era == stages` — stays residual. A name that
  is a relation, reach-through or source handle or the `attrs` bag (`nodes`,
  `blocks`, `out_links`, `children`, `section`, `doc`, `dst`, `frontmatter`, `attrs`, …) is
  never read as a property (`NON_PROPERTY_NAMES`). When a residual conjunct
  could raise an OQX eval error (any function/method call, a `single` block, a
  `^` name, a bare reserved docs basename), the whole query runs unplanned so
  an emptying pushed conjunct cannot hide the error (`planner.ts`,
  `residualMayRaise`).
- **Nested blocks over a root scan are answered from SQLite indexes**
  (`oqx-js/store-index.ts`, Rust `omgbase-surface::store_index`). A root scan
  (`^docs`, `^links`, …, or a bare `docs` at the root scope) is handed
  to the engine as a *lazy* handle — one per target per run — that runs its
  `SELECT` only when something reads it whole (a `Proxy` over an array in
  TypeScript; in Rust a marker the engine resolves through
  `DataContext::materialize` before any operand, argument, key or projected
  item observes it — `spec/surface` `lazy-root-*` pins that both engines see
  the same array). The `@omgbase/oqx` optimizer
  turns a block's top-level `local == outer` conjunct (a `^` reference OR a
  literal: `where customer == ^path`, `where type == "order"`, `where dst_id ==
  ^id`) into a probe and asks the context for an index first
  (`DataContext.indexFor` → `RowIndex.lookupRows`); the store context answers
  with ONE prepared, index-driven statement per probe under the same live-row
  and repo guards as the planner (`sql/scan.ts`), yielding rows built exactly as
  the scan builds them — so the handle is never materialized and every
  attribute/relation works downstream. Indexed paths: docs `id` (PK), `path`
  (`UNIQUE (repo_id, path)`), `title` (the computed row) and any frontmatter/inline **property
  key** (`idx_props_key_text` / `idx_props_key_num`, under the scalar-in-scope
  rule and **typed**: a string probe matches only a `type = 'string'` row by
  `val_text`, a number only `type = 'number'` by `val_num`, a boolean only
  `type = 'bool'`, so `1` never meets `"1"`); blocks `id`, `doc_id`, `type`,
  `path`; nodes `id`, `doc_id`, `kind`, `name`, `path`; links `id`,
  `doc_id`, `dst_id`, `path`, `dst_path`. A `path` probe on a joined
  target drives from `docs (repo_id, path)` into the target's `doc_id` index. An
  **absent** probe (`key == null`, `name == ^missing`) is an anti-join SQLite has
  no index for: the handle is read once and filtered in memory (same answer).
  Not indexed — the engine's own hash index over the handle, built once per
  run — `format`, `raw`, `hash`, `updated_at`, `tags`, edge `predicate` /
  `field`, multi-segment paths (`meta.id`), the source handles. With several
  equalities the varying one is probed and the rest stay residual conjuncts in
  their original order. Nothing here changes a result: `corpus/oqx/
  conformance.test.ts` runs the correlated shapes planned vs. in-memory, and
  `oqx-js/store-index.test.ts` proves the root scan statement never runs and
  that the probe statement is prepared once. Measured: 500 raw probes over 5k
  documents ≈ 9 ms of SQLite time; the whole planned query ≈ 160–180 ms wall
  time in the test (engine overhead dominates), vs. a full scan per outer row.
  Probes are per outer row (one statement each, ~20 µs); batching them into
  `IN (…)` lists was measured and is not worth its complexity.
- **Correctness is guaranteed** by the residual fallback and verified by the
  differential conformance suite (`corpus/oqx/conformance.test.ts`): every query
  returns identical results planned vs. pure in-memory.
- Evaluation is deterministic (no clock/random functions).
- Errors surface as `filter_invalid` (the library's `OqxError` is normalized).

## 8b. Reflection: the AST
A parsed query is a first-class tree shared by both engines
(`spec/oqx/AST.md`, language 0.16, extended in 0.17): every node carries `kind` and a code-point
`span`, optionals are materialized, and `where` keeps its surface form (a
`select` alias stays an identifier; `resolveAliases` substitutes it before
evaluation — omgbase's runner does this once, before it injects `id`/`path`
and renames a `values` item). `@omgbase/oqx` exports `visit`/`transform` (one
child-key table drives both), `print`/`printTemplate` (canonical source, with
the round-trip law both spec runners enforce), `toJSON` (`{ "oqx": "0.19",
"kind": "query", … }`) and `build.*`; the Rust crate mirrors them (`walk`,
`print`, `build`, serde under `json`). omgbase uses them where it used to
hand-roll walks: the runner's `$self` rewrite is a `transform`, the
`semantic("…")` phrase scan a `visit`, and the `graph` macro assembles its
`follow` walk with builders and `print`s it (the root ids are literals in the
tree, never spliced text). A tool that wants to show which relationships a
query references reads the tree the same way.

## 9. Not part of the query surface
The `query` tool takes only an OQX string + `limit`/`cursor`. There is no flat
`{from, filter, …}` envelope, no `include_projected`/`resolution`, and no
projected-query fence (ADR-011, deferred).

## 10. Canonical examples
| Intent | OQX |
|---|---|
| Working-layer docs | `from docs where layer == "working"` |
| Guides, recently touched | `from docs where path.startsWith("/guides/") and updated_at >= "2026-08-01"` |
| Docs tagged pricing (scalar or list) | `from docs where "pricing" in list(tags)` |
| Case-insensitive title match | `from docs where title.lower().contains("aurora")` |
| Distinct doc types | `select distinct type from docs` |
| Distinct doc types as bare strings | `select distinct type values from docs` |
| Docs with no open task (every task done) | `from docs where nodes none { where kind == "md:task" and not checked }` |
| A doc's frontmatter as key/value rows | `select fm: entries(frontmatter) collect { k: $key, v: $it } from docs where path == "/x.md"` |
| Docs whose frontmatter has any numeric key over 1600 | `select path from docs where entries(frontmatter) exists { where $it > 1600 }` |
| An authored `path:`/`title:` key beside the engine's | `select p: data.path, t: data.title, title from docs where has(data.path)` |
| Two most recent practitioners | `from docs where type == "practitioner" order by era desc limit 2` |
| Each doc's first section heading | `select h: nodes first { name values where kind == "md:section" order by first_ordinal } from docs` |
| Each substance's tags minus one | `select tags: tags collect { $it values where $it != "substance" } from docs where type == "substance"` |
| Docs with ≥2 distinct link predicates | `from docs where doc.out_links count distinct { select predicate } >= 2` |
| Unchecked tasks under a heading (working docs) | `from blocks where type == "task" and not checked and under_heading("Launch") and doc.layer == "working"` |
| Blocks about a concept (semantic top-K) | `from blocks order by semantic("identity preservation across edits") desc` |
| Everything a note transitively cites | `from docs where path == "/index.md" follow out_links collect { from dst }` |
| The documents a note links to / that link to it | `select out: out_links collect distinct { from dst }, in: in_links collect distinct { from doc } from docs where path == "/index.md"` |
| Links into drafts, with the target's title | `select t: dst.title from links where dst.layer == "draft"` |
| The documents whose `after` names this one | `select next: ^docs collect { path where ^path in list(after) } from docs where path == "/timeline/kickoff.md"` |
| Every `depends_on` link, both endpoints | `select doc_id, dst_path from links where predicate == "depends_on"` |
