# omgbase — Query Language Spec (OQX)

**As-built (2026-09):** the query language is **OQX** (omgbase Query eXpressions),
now the external **`@omgbase/oqx`** package (parser + engine + scalar-semantics
contract), bound to omgbase's SQLite store by `packages/core/src/oqx-js/`
(a `DataContext` in `context.ts`, the `oqxRun` wrapper in `run.ts`, and a tier-3
pushdown planner in `planner.ts`). See **ADR-013**. This document specs the
language as-built; the **behavioral ground truth** is the corpus
(`packages/core/corpus/oqx/alchemy.test.ts` + `conformance.test.ts`), then the
`query` tool description in `packages/core/src/mcp/server.ts`. Where this doc and
those disagree, they win.

> **Scalar semantics changed with ADR-013** (there were no active users). This
> replaces the former CEL sublanguage; the notable differences from the retired
> CEL rules are called out inline as **[was CEL: …]**.

---

## 1. OQX — one expression

The `query` MCP tool takes a single OQX **string** plus pagination:

```jsonc
{ "query": "<OQX expression>", "limit": 50, "cursor": null }
```

Every concern folds into the expression: `from docs|blocks|nodes|edges` (source),
`where <predicate>`, `select <expr>, name: <expr>, …`, `order by <expr> [asc|desc]`,
receiver-constrained nested queries (`nodes exists { … }`, `collect { … }`),
correlation/joins (the `^` sigil with `$repo.docs`/`$repo.nodes`/`$repo.blocks`
roots), and bounded traversal (`follow`). Results are lean projected hits
(`{id, path, …projections}`), a `count`/`exists` scalar, or — for a
`select <expr> values` projection — the bare projected values (`values: […]`,
§7); never full documents; hydrate by id afterward.

## 2. Targets and field namespaces

The sigil rule: kernel-owned things carry `$`; bare identifiers are content. On
the closed `blocks`/`nodes`/`edges` targets an unknown bare field simply reads as
absent; on the open `docs` target a bare key is a document property, except a
bare first segment colliding with an intrinsic base name
(`id`/`path`/`repo`/`updated_at`/`content_hash`/`body`) is a loud error (a typo
guard — use `$path` or `frontmatter.path`).

### `docs`
- **Bare identifiers** = a document **property** (frontmatter + inline `key:: value`,
  unioned), resolved against the indexed `properties` table. Nested maps flatten
  to dotted keys (`meta.owner`), and a bare `logging` reconstructs the nested
  object so `logging.level` navigates it. A value is scalar-comparable only when
  the key is **single-valued and scalar-authored** in scope; a list/repeated/
  collided key compares unequal — use `list()` (§4).
- **Source-scoped:** `frontmatter.<k>` / `inline.<k>`.
- **Computed intrinsics:** `$title` (first H1), `$tags` (body `#hashtags`).
- **Intrinsics:** `$id`, `$path`, `$updated_at` (ISO-8601 UTC, compares
  lexicographically = chronologically), `$body`, `$content_hash`, `format`.
- **`$repo`** (every scope): the repository handle — `$repo.docs` / `$repo.nodes` /
  `$repo.blocks` / `$repo.edges` are the explicit root scans (§3.4), `$repo.$id`
  the repository id. **[was: `$repo` on a doc was the repository id string.]**
- **`$value`** (every scope, oqx ≥ 0.8): the current item **itself** — the row
  when scanning a target, or the scalar element when a block's receiver is a
  list-valued property (`tags exists { where $value == "pricing" }`,
  `tags collect { $value values }`). Inside a block `^$value` is the enclosing
  row. It is engine-owned (never a stored field) and never pushed to SQL.
- **Relations:** `nodes`, `blocks`, `doc.out`/`doc.in` (the citation graph),
  `doc.out_edges`/`doc.in_edges` (a doc's edges as rows).

### `blocks`
- **Bare fields:** `type`, `text`, and every `attrs` key FLATTENED onto the row:
  a bare `checked` reads `attrs.checked` (`attrs.<key>` still works). Structural
  `type`/`text` win on a name collision; an absent key is silently false in a
  predicate, exactly like a missing frontmatter key on a doc.
- **Intrinsics:** `$id`, `$doc`, `$path`, `$ordinal`, `$depth`, `$content_hash`,
  `$body` (the block text), `$updated_at`.
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
Comparisons (`== != < <= > >=`), boolean `&& || !` + grouping, `in`, arithmetic
(`+ - * / %`), Ruby-style range literals (`lo..hi`, `lo...hi`, `..hi`, `lo..`;
§3.5), method calls (`x.contains("s")`), free functions (`list(x)`, `size(x)`,
`has(x)` + omgbase's domain functions §5), field/intrinsic access with `.`/`[…]`
navigation, and outer references (`^name`, `^^name`).
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

## 4. `list()` / `size()` / `has()`
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

## 6. `follow`, the edge graph, and `distinct`
- **Traversal:** `follow <relation>` recurses over a type-preserving relation
  (`doc.out`/`doc.in`, `block.children`, `section.children`/`section.subsections`).
  Per-path: a node reached by N paths yields N occurrences; `follow distinct`
  keeps one per identity (`by <expr>` sets that identity). Each occurrence carries
  `$depth` (seed = 1), `$stop` (`interior|leaf|frontier|depth|cycle`) with
  `$leaf`/`$frontier` sugar, and `$ordinal` (deterministic 1..N over the walk).
  A follow-local `{ where <succ> }` shapes participating successors, `{ frontier
  <pred> }` cuts, `{ depth <n> }` bounds (1..8). A revisited identity on the path
  is admitted once as `$stop == "cycle"` and never re-expanded. Recursion
  intrinsics are result metadata (valid in `select`/`order by` and the top-level
  post-walk `where`), not in the successor `where`/`frontier`.
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
  projection is in `values` mode.
- **`values`** (oqx ≥ 0.8): `select <expr> values` — exactly **one** item — makes
  each row's result the bare value rather than a `{ name: value }` record. At the
  top level the result carries `values: […]` in place of `hits` (empty), paged
  and `distinct`-deduped exactly like hits (`from docs select distinct type values`
  → the type strings). Inside a `collect`/`first`/`single` block it yields a plain
  array / scalar (`tags: tags collect { $value values }`, `latest: nodes first
  { value values order by … }`). The runner implements the top-level form by
  projecting the single item under a reserved key alongside the injected
  id/path, then peeling the values off the final page — so the keyset cursor
  still works.
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
  single SQL statement; now it is pushdown + residual.]**
- **Correctness is guaranteed** by the residual fallback and verified by the
  differential conformance suite (`corpus/oqx/conformance.test.ts`): every query
  returns identical results planned vs. pure in-memory.
- Evaluation is deterministic (no clock/random functions).
- Errors surface as `filter_invalid` (the library's `OqxError` is normalized).

## 9. Not part of the query surface
The `query` tool takes only an OQX string + `limit`/`cursor`. There is no flat
`{from, filter, …}` envelope, no `include_projected`/`resolution`, and no
projected-query fence (ADR-011, deferred).

## 10. Canonical examples
| Intent | OQX |
|---|---|
| Working-layer docs | `from docs where layer == "working"` |
| Guides, recently touched | `from docs where $path.startsWith("guides/") && $updated_at >= "2026-08-01"` |
| Docs tagged pricing (scalar or list) | `from docs where "pricing" in list(tags)` |
| Case-insensitive title match | `from docs where $title.lower().contains("aurora")` |
| Distinct doc types | `from docs select distinct type` |
| Distinct doc types as bare strings | `from docs select distinct type values` |
| Each substance's tags minus one | `from docs where type == "substance" select tags: tags collect { $value values where $value != "substance" }` |
| Docs with ≥2 distinct link predicates | `from docs where doc.out_edges count distinct { select predicate } >= 2` |
| Unchecked tasks under a heading (working docs) | `from blocks where type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"` |
| Blocks about a concept (semantic top-K) | `from blocks order by semantic("identity preservation across edits") desc` |
| Everything a note transitively cites | `from docs where $path == "index.md" follow doc.out` |
| Every `depends_on` edge, both endpoints | `from edges where predicate == "depends_on" select $src, $dst_path` |
