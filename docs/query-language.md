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
> fields, intrinsics, reach-through, relations, the row functions, the runner's
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
(projection), `from docs|blocks|nodes|edges` (source), `where <predicate>`,
receiver-constrained nested queries (`nodes exists { … }`, `collect { … }`),
correlation/joins (the `^` sigil with `$repo.docs`/`$repo.nodes`/`$repo.blocks`
roots), bounded traversal (`follow`), `order by <expr> [asc|desc]`, and
`limit`/`offset`. Results are lean projected hits (`{id, path, …projections}`),
a `count`/`exists`/`none` scalar, or — for a `select <expr> values` projection —
the bare projected values (`values: […]`, §7); never full documents; hydrate by
id afterward.

**Clause order is fixed (ADR-020, oqx ≥ 0.11).** Within one body — the top level
or any `{ block }` — clauses appear at most once each, in exactly this order:

```
[select <projection>] from <source> [where <pred>] [follow <rel> [{…}]] [order by …] [limit N] [offset N]
```

Every clause is optional except a top-level `from`; the receiver-plus-consumer
form `$repo.<target> count|exists|none|first|single { <block> }` supplies its own
source, so the block's `from` is an optional re-projection. A clause out of order
is a parse error that names the order (`` `select` must come before `from` — OQX
clause order is select, from, where, follow, order by, limit, offset ``). **Only
`select` may drop its keyword, and only when it is the first clause written**
(`$path, era from docs where …`; in a block, `nodes collect { value }` projects
`value`). Every other clause always carries its keyword — with the 0.17 sugar
that a **block** whose leading expression is syntactically a predicate is a
`where`-first body: `nodes exists { kind == "md:task" }` ≡
`nodes exists { where kind == "md:task" }` (§3.6; a bare name still projects, a
predicate after a projection still needs `where`). At the top level a predicate
always needs `where`, and `from docs count` is an error rather than a projection
of a field called `count` (write `$repo.docs count { … }`, or
`select count from docs`). **`where` (and, since 0.17, a later `select` item) may
reference the same body's `select` aliases** (`select $path, old: era < 1000 from docs where old`): the alias's
expression is substituted before evaluation (`resolveAliases`, once, ahead of
the runner's own rewrites — the parsed tree keeps the alias), so the pushdown
planner sees an ordinary predicate; an alias shadows a same-named field inside `where`; a cycle among
aliases is a parse error; each block rewrites only against its own `select`.
`order by` is not rewritten — it reads row fields.

Consumers (oqx ≥ 0.9): `collect` (rows, the default), `exists` (≥ 1 row),
`none` (0 rows — exactly `!… exists { … }`, and the way to say "every":
`nodes none { where kind == "md:task" && !checked }`), `count`, `first`,
`single`. There is deliberately no `all { … }`: its block would have to mean
something different from every other consumer's.

## 2. Targets and field namespaces

The sigil rule: kernel-owned things carry `$`; bare identifiers are content. On
the closed `blocks`/`nodes`/`edges` targets an unknown bare field simply reads as
absent; on the open `docs` target a bare key is a document property, except a
bare first segment colliding with an intrinsic base name
(`id`/`path`/`repo`/`updated_at`/`content_hash`/`body`) is a loud error (a typo
guard — use `$path` or `frontmatter.path`).

**Paths (spec/surface 2.0).** omgbase stores a document's path repo-relative
(`projects/oqx.md`), but every reference an author writes is root-absolute
(`[x](/projects/oqx.md)`, `before: [/timeline/kickoff.md]`). The surface
speaks the reference form: `$path` on every target, `$dst_path` on edges, the
`path` of every hit and of a row rendered as `{ id, path }` are `/`-rooted.
Every path the surface accepts tolerates both forms — tool arguments, `refs(x)`,
`within(…)`, and a **string literal** compared with `$path`/`$dst_path` by
`==`/`!=` or passed to their `.startsWith(…)`, which is rooted before
evaluation (`$path == "a.md"` and `$path == "/a.md"` both match; write the
rooted form). Nothing else is rewritten: a property's value is the author's
(`where customer == ^$path`, `where ^$path in list(after)` — no `"/" + ^$path`
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
- **Source-scoped:** `frontmatter.<k>` / `inline.<k>`. The whole bag as a
  collection: `entries(frontmatter)` / `entries(inline)` (oqx ≥ 0.10) — one
  entry per top-level key, **in key order** (authored position is not indexed),
  valued by the same scalar-vs-list rule as a bare read, dotted keys folded back
  into a nested value; inside the block `$key` is the key and `$it` the value.
- **Computed intrinsics:** `$title` (first H1), `$tags` (body `#hashtags`).
- **Intrinsics:** `$id`, `$path` (the **reference form**, `/`-rooted — see
  "Paths" below), `$updated_at` (ISO-8601 UTC, compares lexicographically =
  chronologically), `$body`, `$content_hash`, `format`.
- **`$repo`** (every scope): the repository handle — `$repo.docs` / `$repo.nodes` /
  `$repo.blocks` / `$repo.edges` are the explicit root scans (§3.4), `$repo.$id`
  the repository id. **[was: `$repo` on a doc was the repository id string.]**
- **`$it`** (every scope, oqx ≥ 0.8): the current item **itself** — the row
  when scanning a target, or the scalar element when a block's receiver is a
  list-valued property (`tags exists { where $it == "pricing" }`,
  `tags collect { $it values }`). Inside a block `^$it` is the enclosing
  row. It is engine-owned (never a stored field) and never pushed to SQL.
- **Relations:** `nodes`, `blocks`, `doc.out`/`doc.in` (the citation graph),
  `doc.out_edges`/`doc.in_edges` (a doc's edges as rows).

### `blocks`
- **Bare fields:** `type`, `text`, and every `attrs` key FLATTENED onto the row:
  a bare `checked` reads `attrs.checked` (`attrs.<key>` still works). Structural
  `type`/`text` win on a name collision; an absent key is silently false in a
  predicate, exactly like a missing frontmatter key on a doc.
- **Intrinsics:** `$id`, `$doc`, `$path`, `$ordinal` (0-based ordinal among
  its siblings), `$depth` (nesting depth, 0 at the top level), `$content_hash`,
  `$body` (the block text), `$updated_at`. Inside a `follow` the walk's own
  `$ordinal`/`$depth` (§6) take precedence over the block's; everywhere else
  the block's values read as plain properties (`@omgbase/oqx` 0.13).
- **Doc reach-through:** `doc.<key>` / `doc.$path` / `doc.format` constrain by the
  owning document (scope, not selection).
- **Relations:** `block.children`, `block.nodes`, `block.out_edges`, `section`
  (enclosing `md:section` node(s)). **Structural functions:** §5.

### `nodes`
- **Bare fields:** `kind` (`md:task`/`md:link`/`yaml:…`), `name`, `value`, and
  every `attrs` key FLATTENED onto the row (`checked` on a task, `level` on a
  section == `attrs.checked` / `attrs.level`; `attrs.<key>` still works).
  `kind`/`name`/`value` win on a name collision; an absent key is silently false.
- **Intrinsics:** `$id`(=`$node_id`), `$node_id`, `$doc_id`, `$block_id`, `$path`.
- **Reach-through:** `doc.<key>`, `block.type`/`block.text`.
- **Section relations:** `section.blocks` (content under an `md:section` node's
  heading), `section.children` (immediate child sections), `section.subsections`
  (all contained sections).

### `edges`
The authored link graph as first-class rows (open edges, `to_commit IS NULL`).
- **Bare fields:** `predicate`, `provenance`, `dst_kind`, `anchor`, `src_field`.
- **Intrinsics:** `$id`, `$src`, `$dst`, `$dst_path` (target doc's path; null when
  external/dangling), `$dst_uri` (external URL; null otherwise), `$src_block`,
  `$via`, `$from_commit`, `$path` (the **source** document's path).
- Source-document reach-through: `doc.<key>` / `doc.$path`. `text()`/`semantic()`
  are unavailable (edges carry no text/embedding).

## 3. Scalar semantics (`@omgbase/oqx` contract)

Everything inside `where`/`select`/`order by` that isn't structural navigation is
a scalar expression evaluated by `@omgbase/oqx`'s `semantics.ts`.

### 3.1 Grammar
Comparisons (`== != < <= > >=`), identity (`is`, `is not`; §3.6), boolean
`&& || !` + grouping (`and`/`or` are synonyms of `&&`/`||`; prefix `is x` ≡ `!!x`,
`not x` ≡ `!x`), `in`, arithmetic (`+ - * / %`), Ruby-style range literals
(`lo..hi`, `lo...hi`, `..hi`, `lo..`; §3.5), method calls (`x.contains("s")`),
free functions (`list(x)`, `size(x)`, `has(x)` + omgbase's domain functions §5),
field/intrinsic access with `.` navigation, bracket lookups (`refs(x)[0]`,
`$repo.docs[$path == ^company]`; §3.6), the postfix required operator (`title!`;
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
| `nodes { kind == "md:task" }` | `nodes collect { where kind == "md:task" }` — a receiver block without a consumer is `collect`; a block whose *leading* expression is syntactically a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a consumer test, a bracket chain or `x!` — anything but a bare name, a dotted path or a `^`-lift) is `where`-first. `nodes { name }` still projects; `nodes { is checked }` is the bare-field filter; `{ name where kind == "md:task" }` keeps the keyword. Not after `follow`: `follow children { depth 2 }` is the options block. |
| `refs(x)[0]`, `refs(x)[${i}]` | `refs(x) first { offset 0 }` — positional (an integer literal or a binding; out of range ⇒ absent); `refs(x)[0].$title` navigates the row |
| `$repo.docs[$path == ^company]` | `$repo.docs first { where $path == ^company }` — the first match or absent |
| `$repo.docs[$path == ^company]!` | `$repo.docs single { where $path == ^company }!` — exactly one match; zero or many is `filter_invalid` |
| `title!` | required: `title`, or `filter_invalid` naming the expression (`` `title!` is absent on "d_…" ``). Never a filter, never a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!.name` vs `refs(c)[0].name!`). `select $id!, status from docs` insists on identity before a write. |
| `is x`, `not x` | `!!x`, `!x` (truthiness) |
| `x is y`, `x is not y` | identity: a row's `id` when present, else structural — so `$it is ^$it` compares rows (which `==` leaves unspecified); `owner is null` is absent; for scalars `is` ≡ `==`. Comparison precedence, no chaining. Never pushed down (residual). |
| `a and b`, `a or b` | exactly `a && b`, `a || b` (precedence, short-circuit, value: `title or $path` coalesces) |
| `boss: $repo.docs[$path == ^manager], bossName: boss.$title` | a `select` item may use the items to its left (inlined like a `where` alias; a reference to an item to its right is a parse error) |

The top level is unchanged: `type == "x" from docs` stays the parse error it was
(`where` would precede `from`). There is no `expand`/`unnest` and no automatic
dereference of a path-valued field: the body-level `from` chain flat-maps
(`$repo.docs collect { from nodes … }`) and `refs(x)[0].$title` is the
dereference.

### 3.4 Correlation (`^`) and lifts
- **Bare names are local.** A bare identifier resolves against the **current row
  only**; an absent field is absent — it never falls through to an enclosing row
  or to the repository root, so adding a same-named field to an inner row cannot
  change what an outer reference means. Reach outward explicitly: `^name` for
  the enclosing row, `$repo.<target>` for a root scan from any depth. **[was
  (oqx < 0.7): an absent local name climbed enclosing scopes, and a bare `repo`
  reached the root that way.]**
- **`^name` reads a name `N` scopes outward** (`^` = one scope, `^^` = two) — it
  resolves against the enclosing **row's fields/intrinsics/lifts**, not the outer
  query's select aliases. To reference the outer row's path write `^$path` (not a
  `me: $path` alias). **[was CEL/omgbase: `^name` read a bound select value; that
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
  timeline both ways; `select prior: refs(before) collect { $path }` projects
  the referenced documents; `where refs(see_also) exists { where type == "x" }`
  filters on them; `from refs("/index.md")` is a source. The reverse direction
  needs no function: `$path` is already the reference form, so
  `$repo.docs collect { where ^$path in list(after) }` is "the documents whose
  `after` names me".
- **A hit is a store row.** Every top-level row of a `collect`/`first`/`single`
  query must be a document, block, node or edge; `follow before` over a list of
  paths reaches the list's *strings* and fails loud — `filter_invalid: a hit
  must be a document, block, node or edge row — the query reached a string
  ("/timeline/kickoff.md"); to follow document references held in a property
  use refs(<field>)`. Write `follow refs(before)`. A `values` projection
  returns no hits and is exempt; nested blocks are unaffected (their rows are
  values, see §7).

## 6. `follow`, the edge graph, and `distinct`
- **Traversal:** `follow <dest>, …` recurses over one or more type-preserving
  destinations; a plain destination is a relation of the current row
  (`doc.out`/`doc.in`, `block.children`, `section.children`/`section.subsections`).
  Per-path: a node reached by N paths yields N occurrences; `follow distinct`
  keeps one per identity (`by <expr>` sets that identity). Each occurrence carries
  `$depth` (seed = 1), `$stop` (`interior|leaf|frontier|depth|cycle`) with
  `$leaf`/`$frontier` sugar, and `$ordinal` (deterministic 1..N over the walk).
  A follow-local `{ where <succ> }` shapes participating successors, `{ frontier
  <pred> }` cuts, `{ depth <n> }` bounds (1..8). A revisited identity on the path
  is admitted once as `$stop == "cycle"` and never re-expanded. Recursion
  intrinsics are result metadata (valid in `select`/`order by` and the top-level
  post-walk `where`), not metadata of the candidate rows the successor
  `where`/`frontier` read.
- **Destination lists** (`spec/oqx` 0.14): `follow doc.out, doc.in` walks the
  union of the destinations — within one step the successors are concatenated
  in source order and deduplicated by identity, so a document both cited by and
  citing the current row is stepped into once. `frontier`, `depth` and `by`
  apply whichever destination reached a row.
- **Destination blocks:** a destination may be a select-position block
  re-evaluated per frontier row — `follow $repo.docs collect { where doc.out
  exists { where $path == ^^$path } }` computes backlinks as a block (the same
  rows as `follow doc.in`). Inside the block `^` is the frontier row (`$repo` is
  readable from every scope, so it needs no caret); `first`/`single` yield at
  most one successor; `exists`/`none`/`count` are not destinations.
- **Correlated successor `where`:** inside the follow-local `where`, a bare name
  is the candidate's own property, `^name` is the **frontier row** being
  expanded, and `^^name` the walk's enclosing scope — `follow doc.out { where
  doc.out exists { where $path == ^^$path } }` keeps only mutual citations
  (before 0.14 `^` skipped the frontier row and such predicates matched nothing).
- **Edges as rows:** `from edges …`, or a doc's `doc.out_edges`/`doc.in_edges`.
- **`distinct`** on any consumer dedups the rows it reduces by their **projected
  value**: `select distinct type`, `nodes collect distinct { select kind }`,
  `nodes count distinct { select kind } == 3`. Empty projection → dedup by
  identity.

## 7. `order by`, `select`, pagination
- **`order by <expr> [asc|desc], …`:** orders by intrinsics, bare fields,
  `doc.<key>`, or a `semantic(…)` score. **Absent values sort last** (ascending).
  Ties break by `(path, id)` for a stable keyset cursor; a custom `order by`
  disables the cursor (you get the top `limit` with `truncated`). **[was CEL/
  SQLite: NULLs sorted first ascending.]**
- **`select`:** default hit is `{id, path}`; add `name: <expr>` fields and nested
  `collect { … }` / `first { … }` / `single { … }`. An item that is not a plain
  navigation (a call, arithmetic) needs an alias — `n: size(tags)` — unless the
  projection is in `values` mode. **Rows as values** (surface 1.2): wherever a
  store row surfaces as a *value* rather than a hit — a nested `collect { }` /
  `first { }` / `single { }` with an **empty** projection ("the row itself",
  oqx §12), a `values` projection of `$it`, a field bound to a row — it is
  rendered as `{ id, path }` (the row's id and its document's path), never the
  raw store row (before 1.2 the columns leaked, `attrs` as a JSON string and the
  `__path` join column included). `tasks: nodes collect { where kind ==
  "md:task" }` is therefore a list of `{ id, path }` node refs.
- **`values`** (oqx ≥ 0.8): `select <expr> values` — exactly **one** item — makes
  each row's result the bare value rather than a `{ name: value }` record. At the
  top level the result carries `values: […]` in place of `hits` (empty), paged
  and `distinct`-deduped exactly like hits (`select distinct type values from docs`
  → the type strings). Inside a `collect`/`first`/`single` block it yields a plain
  array / scalar (`tags: tags collect { $it values }`, `latest: nodes first
  { value values order by … }`). The runner implements the top-level form by
  projecting the single item under a reserved key alongside the injected
  id/path, then peeling the values off the final page — so the keyset cursor
  still works.
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
  store-backed `DataContext` (`context.ts`), which resolves fields/intrinsics/
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
  `blocks`, `out`, `children`, `section`, `doc`, `frontmatter`, `attrs`, …) is
  never read as a property (`NON_PROPERTY_NAMES`). When a residual conjunct
  could raise an OQX eval error (any function/method call, a `single` block, a
  `^` name, a bare reserved docs basename), the whole query runs unplanned so
  an emptying pushed conjunct cannot hide the error (`planner.ts`,
  `residualMayRaise`).
- **Nested blocks over a root scan are answered from SQLite indexes**
  (`oqx-js/store-index.ts`, Rust `omgbase-surface::store_index`). A root scan
  (`$repo.docs`, `$repo.edges`, …, or a bare `docs` at the root scope) is handed
  to the engine as a *lazy* handle — one per target per run — that runs its
  `SELECT` only when something reads it whole (a `Proxy` over an array in
  TypeScript; in Rust a marker the engine resolves through
  `DataContext::materialize` before any operand, argument, key or projected
  item observes it — `spec/surface` `lazy-root-*` pins that both engines see
  the same array). The `@omgbase/oqx` optimizer
  turns a block's top-level `local == outer` conjunct (a `^` reference OR a
  literal: `where customer == ^$path`, `where type == "order"`, `where $dst ==
  ^$id`) into a probe and asks the context for an index first
  (`DataContext.indexFor` → `RowIndex.lookupRows`); the store context answers
  with ONE prepared, index-driven statement per probe under the same live-row
  and repo guards as the planner (`sql/scan.ts`), yielding rows built exactly as
  the scan builds them — so the handle is never materialized and every
  intrinsic/relation works downstream. Indexed paths: docs `$id` (PK), `$path`
  (`UNIQUE (repo_id, path)`), `$title` and any frontmatter/inline **property
  key** (`idx_props_key_text` / `idx_props_key_num`, under the scalar-in-scope
  rule and **typed**: a string probe matches only a `type = 'string'` row by
  `val_text`, a number only `type = 'number'` by `val_num`, a boolean only
  `type = 'bool'`, so `1` never meets `"1"`); blocks `$id`, `$doc`, `type`,
  `$path`; nodes `$id`/`$node_id`, `$doc_id`, `kind`, `name`, `$path`; edges
  `$id`, `$src`, `$dst`, `$path`, `$dst_path`. A `$path` probe on a joined
  target drives from `docs (repo_id, path)` into the target's `doc_id` index. An
  **absent** probe (`key == null`, `name == ^missing`) is an anti-join SQLite has
  no index for: the handle is read once and filtered in memory (same answer).
  Not indexed — the engine's own hash index over the handle, built once per
  run — `format`, `$tags`, edge `predicate` / `src_field`, multi-segment paths
  (`meta.id`), reserved docs basenames (the scan raises). With several
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
evaluation — omgbase's runner does this once, before it injects `$id`/`$path`
and renames a `values` item). `@omgbase/oqx` exports `visit`/`transform` (one
child-key table drives both), `print`/`printTemplate` (canonical source, with
the round-trip law both spec runners enforce), `toJSON` (`{ "oqx": "0.17",
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
| Guides, recently touched | `from docs where $path.startsWith("/guides/") && $updated_at >= "2026-08-01"` |
| Docs tagged pricing (scalar or list) | `from docs where "pricing" in list(tags)` |
| Case-insensitive title match | `from docs where $title.lower().contains("aurora")` |
| Distinct doc types | `select distinct type from docs` |
| Distinct doc types as bare strings | `select distinct type values from docs` |
| Docs with no open task (every task done) | `from docs where nodes none { where kind == "md:task" && !checked }` |
| A doc's frontmatter as key/value rows | `select fm: entries(frontmatter) collect { k: $key, v: $it } from docs where $path == "/x.md"` |
| Docs whose frontmatter has any numeric key over 1600 | `select $path from docs where entries(frontmatter) exists { where $it > 1600 }` |
| Two most recent practitioners | `from docs where type == "practitioner" order by era desc limit 2` |
| Each doc's first section heading | `select h: nodes first { name values where kind == "md:section" order by first_ordinal } from docs` |
| Each substance's tags minus one | `select tags: tags collect { $it values where $it != "substance" } from docs where type == "substance"` |
| Docs with ≥2 distinct link predicates | `from docs where doc.out_edges count distinct { select predicate } >= 2` |
| Unchecked tasks under a heading (working docs) | `from blocks where type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"` |
| Blocks about a concept (semantic top-K) | `from blocks order by semantic("identity preservation across edits") desc` |
| Everything a note transitively cites | `from docs where $path == "/index.md" follow doc.out` |
| The documents whose `after` names this one | `select next: $repo.docs collect { $path where ^$path in list(after) } from docs where $path == "/timeline/kickoff.md"` |
| Every `depends_on` edge, both endpoints | `select $src, $dst_path from edges where predicate == "depends_on"` |
