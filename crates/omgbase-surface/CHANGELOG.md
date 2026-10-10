# Changelog

All notable changes to `omgbase-surface` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [2.0.0] - 2026-10-10

### Major
- **The repository is the root row; `$repo` is removed** (`spec/surface` 2.0 §1.1, `spec/cli` 2.0; Brendan's decision of 2026-10-09/10, building on OQX 0.18's root object). From a top-level row `^docs` / `^blocks` / `^nodes` / `^edges` reach the repository's collections — one caret per enclosing block (`^^docs` from depth two), or the absolute `0^docs` from any depth — and `^$id` / `0^$id` is the repository id (the root scope's `$id`). `^$it` is the root object: `^$it.docs` is the same lazy scan handle as `^docs` (a receiver, a value, an indexed probe), `entries(^$it)` yields exactly `docs`, `blocks`, `nodes`, `edges` (`$id` is an intrinsic of it, not an entry). At the root scope a bare target stays the scan: a top-level consumer is `docs count { … }`, `from docs`, `entries(docs)`.

  Three spellings are now `filter_invalid`, in both engines, with one message each:

  - **`$repo`** anywhere — bare, `$repo.docs`, `$repo.$id`, `^$repo`, `0^$repo` — `` `$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^$id` / `0^$id` ``. Detected statically over the parsed tree (one `visit`, before evaluation and before the planner), so the error does not depend on which rows the data holds.
  - **A bare target name inside a block** (scope depth ≥ 1: a row's clauses, a block body, a `from E` re-projection, a `follow` destination), until now a silent empty property read — `` `docs` inside a block reads a property of the current row, which has none — did you mean `^docs` (the repository's documents)? `` (the carets count the depth). `docs` and `edges` are refused statically; `blocks` and `nodes` are relations of some rows (`docs.blocks`, `docs.nodes`, `blocks.nodes`, `section.blocks`) and stay those — on a row that lacks the relation (`blocks` on a block or edge row, `nodes` on a node or edge row, `block.blocks`) the context raises the same error at read time, its hint spelling the rule. A frontmatter key named after a target is reachable only as `frontmatter.<k>`. The SQL translator declines a bare target name as a property read and the residual walk treats one that could raise as a residual that may raise, so a pushed conjunct cannot hide the error.
  - **A `^<target>` with more carets than enclosing scopes** (`^docs count { }` at the top level — the natural misspelling after this migration — or `^^edges` from a top-level row), which OQX reads as absent and would count a silent 0 — `` `^docs` reaches past the root — there is no enclosing row at this depth; at the top level the repository's documents are the bare `docs` (`docs count { … }`, `from docs`, `entries(docs)`) ``. Statically, target names only.

  **Migration** (every `$repo` in the fixtures, the tutorial, the corpus tests, the `query_syntax` text, the `query` tool description and the CLI help was rewritten this way):

  | Before | After |
  | --- | --- |
  | `select …, x: $repo.docs collect { … } from docs` (inside a row, depth 1) | `^docs collect { … }` |
  | `$repo.docs` two scopes down (a block's body) | `^^docs`, or `0^docs` from any depth |
  | `follow $repo.docs collect { where … == ^$path }` | `follow ^docs collect { … }` (the destination is read in the frontier row's scope) |
  | `$repo.docs count { … }` / `exists` / `none` / `first` / `single` at the top level | `docs count { … }` (a bare target at the root scope) |
  | `$repo.$id` | `^$id` (depth 1) / `0^$id` (anywhere) |
  | a bare `docs` inside a block (was an empty read) | `^docs` |
  | a frontmatter key named `docs` / `blocks` / `nodes` / `edges` | `frontmatter.<k>` |

  Fixtures: `spec/surface/cases/query-root.json` (31 cases: `^docs` at depth 1, `^^docs` and `0^docs` at depth 2, `^$id` / `0^$id` = `rp_0`, `entries(^$it)`, `^$it.docs` ≡ `^docs` as a value and as a correlated receiver, destination blocks over `^docs` / `0^docs` with the live rooted `^$path in list(after)` join, six `$repo` spellings, eleven bare-target shapes); every other suite's `$repo` query respelled with its expectation unchanged, except `query-edges::no-relations` and `query-nodes::no-relations-beyond-section`, which pinned the silent read and are re-queried with a non-target name; `interop.json` gained a `^docs` / `^$id` / `entries(^$it)` read and a `0^docs` read; `spec/cli` gained `query::root-caret`, `repo-removed`, `repo-removed-json`, `bare-target-in-block`, and the `query` help card is respelled. Builds on [the rooted-paths note](./surface-2.0-rooted-paths.md) (the same 2.0 major): `where ^$path in list(after)` inside `follow ^docs collect { … }` is live because both halves are the reference form.
- **Paths on the surface are `/`-rooted** (`spec/surface` 2.0, `spec/cli` 2.0; Brendan's decision of 2026-10-10). omgbase has two path forms — storage (`docs.path`, the adapters, every store/sync spec) uses git's repo-relative form (`projects/oqx.md`), while every reference an author writes is root-absolute (`/projects/oqx.md`). The surface now speaks the reference form: every path a query, an MCP tool or an `omg` verb **returns** is rooted — `$path`/`$dst_path`, every hit's `path`, rows rendered as `{ id, path }`, `docs_list`/`docs_tree` (the tree's `prefix` is `/` for the root), `docs_read`/`docs_read_at`/`docs_get_many`/`read_ref`, `docs_history`, `diff_unified`, `changes_since` (revisions, deletions, moves and the `summary`), `links_stale`/`links_repair`/`links_retarget`, `text_search`, `resolve` locators, `graph`, `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta` (incl. `dangling[].path` and the dry-run `diffs` keys), `apply`, `docs_update`/`docs_plan_update` opsets, `observe*`, and the CLI's `ls`/`query`/`outline`/`show`/`new`/`mv`/`rm --doc`/`meta`/`log`/`find`/`sync`/`retarget` renderings — and every path they **accept** tolerates both forms (a missing leading `/` is added, an extra one stripped). A string literal compared with `$path`/`$dst_path` by `==`/`!=`, or passed to their `startsWith`, is rooted before evaluation, so `$path == "a.md"` keeps matching; nothing else is rewritten (a property's value is the author's: `where ^$path in list(after)` replaces `"/" + ^$path`). The keyset cursor carries the rooted path; a cursor from a 1.x surface is refused as `filter_invalid` naming the cause. Storage is unchanged — no migration.

  Both engines: one normalization module each (`packages/core/src/core/paths.ts` + `surface-paths.ts` for the other-spec result shapes; `omgbase_surface::paths`), the SQL translator renders `$path` as `'/' || d.path` with an indexed fast path for a rooted equality literal, the store-index probes de-root their value, and the conformance suites, the surface fixtures (new `path-*`, `dst-path-*`, `refs-both-forms-resolve`, `reverse-reference-by-path-membership`, `cursor-from-1x-rejected` cases, `reads::alchemy` steps) and the interop suite prove the two agree byte for byte. `@omgbase/sync` / `omgbase-sync`: the coordinator de-roots the engine's paths before handing them to a source (`sync_out`, the reconcile summary). Rust `omgbase-sync` is otherwise untouched; `spec/sync` does not move.

  **Migration:** add the slash — `$path.startsWith("projects/")` → `"/projects/"`, `$path.matches("^texts/")` → `"^/texts/"`, `"/" + ^$path` → `^$path`; a `links_stale` `target` is now paste-ready as a repair `from`; a client parsing `docs_tree`'s `prefix` reads `/` for the root; discard stored cursors (`query`, `docs_list`, `docs_tree`) and start the page sequence again.

### Patch
- **OQX 0.17 — join syntax sugar** (`spec/oqx` 0.16 → 0.17; `cases/sugar.json`, 134 new cases, 1131 in all; GRAMMAR §2/§4, SEMANTICS §5b/§14, AST.md). Everything that is pure sugar desugars **in the parser** to existing nodes, so the optimizer, the pushdown planners and `print` see the explicit form; two shapes are new.

  - **A receiver block without a consumer is `collect`**: `x { … }` ≡ `x collect { … }` in select position, where position and as a whole query (`docs { age > 15 }`). Carve-out: after the last `follow` destination a brace is still the options block (`follow children { depth 2 }`); a destination block keeps its consumer.
  - **Where-first bodies**: a block whose leading expression is *syntactically* a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a postfix `!` or bracket chain, a consumer test — anything that is not a bare name, a dotted navigation or a lift) drops `where`: `people exists { age > 50 }`, `jobs collect { pay > 2 }`. Bare names stay projections (`docs { is active }` is the bare-field filter); `{ name where age >= 18 }` keeps the keyword; `{ age >= 18, name }` is an error suggesting that form. The top level is unchanged: `age > 15 from people` is still the parse error (where would precede from).
  - **Brackets**: `x[p]` → `x first { where p }`; `x[p]!` → `x single { where p }` under a `required` (zero matches is the required error, many the `single` error); `x[n]` / `x[${i}]` → `x first { offset n }` (out of range is absent; a non-integer binding is the `offset` eval error); `x[n]!` → required positional. Chains compose (`refs(company)[0].name`, `jobs[pay > 2][0]`); a negative or fractional literal index is a parse error; `[`/`]` are tokens.
  - **Postfix `!` = required** — new node `{ kind: "required", expr }` / `Expr::Required`: the value, or the eval error `` `<expr>!` is absent `` (`on <id>` when the row has a scalar identity). Never a filter or a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!.name` vs `refs(c)[0].name!`); a `!` right after a complete operand is postfix, a `!` at operand start is the negation (`!=` stays one token: write `a! == b` with the space).
  - **`is` / `not` / `and` / `or`** become keywords (reserved: `from where select is not and or` + the literal words). Prefix `is x` ≡ `!!x`, `not x` ≡ `!x`. Infix `x is y` / `x is not y` — new `binary` ops `"is"` / `"is not"` (`BinaryOp::Is` / `IsNot`) — compare **identity** per SEMANTICS §16 (a row's `id` when present, else structural), so `$it is ^$it` compares rows and for scalars `is` ≡ `==`; comparison precedence, non-chainable. `and` / `or` are exact synonyms of `&&` / `||` (same nodes, precedence, short-circuit and value semantics; `print` still writes the symbols). `in` over rows is unchanged (deferred).
  - **Alias reuse in `select`**: an item may reference the items to its left (`boss: ^people[id == ^manager], bossName: boss.name`), inlined by `resolveAliases` / `resolve_aliases` like a `where` alias; a reference to an item to the right is a parse error (a cycle when it refers back). **Behavior change:** `a: b, b: a` is now the cycle error (it was a field swap), and `senior: age > 50, s: senior` projects the alias (it was the row field `senior`).
  - **A directive may stand in value position** (`jobs first { }.pay`): this is how `print` writes a bracket chain back; `op` joins the `Expr` family by position (`isExpr` stays false for it; `transform` rebuilds it without handing it to the mapping). AST.md §8 records the additions (minor; nothing renamed or removed).
  - Existing fixtures that turned from error into meaning: `people exists { age > 50 }`-style blocks (`where` ×4, `errors-parse` consumer-after-projection re-queried as `{ name, jobs exists { } }`, `projection` call-in-block re-queried as `{ name, has(budget) }`), the `[` lex-error case (now a token).
  - **omgbase binding**: the pushdown planners decline `is` / `is not` (identity is the engine's structural notion, not SQL's `IS`), `required` and value-position directives (they may raise), so they stay residual; `query_syntax` gains a "Sugar" block; `docs/query-language.md` §3.6. The surface fixture `implicit-where-in-block` re-queried as `{ kind == "md:task", name }` (still the loud error pointing at `where`).
  - `@omgbase/oqx-syntax`: `[`/`]` are bracket punctuation (no longer lex errors), `is`/`not`/`and`/`or` are keywords highlighted as word operators, `LANGUAGE_VERSION` 0.17; assets regenerated.
- **OQX 0.18 — the root scope is a row, absolute scope references, canonical `and`/`or`** (`spec/oqx` 0.17 → 0.18; `cases/absolute-refs.json` new (24), `outer-refs` +6 (the `$it is absent at the root scope` case re-queried as the root-object cases), `limit-offset` +2: 1163 cases in all; GRAMMAR §1/§3/§4/§5/§6, SEMANTICS §2/§8/§18/§19, AST.md §1/§3/§6/§8, README).

  - **The root scope is a row: the host's root object.** SEMANTICS §2 step 1 no longer reads "absent at the root": `$it` at the root scope is the host's root object, so from a top-level row `^$it` is that object, `entries(^$it)` enumerates the named roots in insertion order, `^$it.people` ≡ `^people` (and works as a receiver), `^^$it` from depth two is the same object, and `$it values from $it` is the object as one row. The seam gained **`DataContext.rootObject?(): unknown`** (TypeScript, optional — absent keeps the root row absent) / **`fn root_object(&self) -> Value`** (Rust, provided method defaulting to `Value::Undefined`); `DefaultContext` returns the roots record it was constructed with. Step 5 at the root still reads `ctx.root(name)` — a bare name is never a property of the root object — so hosts with lazy roots are unaffected, and a host-provided root-level name (omgbase will expose the repository id as `$id`, cashing in `$repo.$id` → `^$id` from depth one, `^^$id` from depth two) is readable through `root(name)`. A top-level `limit`/`offset` is evaluated in the root scope *without* its row (SEMANTICS §18): `^$it` reached through a bracket inside the bound is absent, pinned.
  - **`N^name` — absolute scope references.** An unsigned integer literal immediately followed by `^` (no whitespace) names a scope by its syntactic depth (root 0, top-level rows 1, +1 per block body, a destination block's rows one below the frontier row, a follow `where` one deeper than the frontier row — the `visit` depth): `0^docs`, `0^$it`, `1^$path`, `0^$id`, and as a lift target `1^tasks: text`. It **desugars in the parser** to the existing `outer` node (or lift) with `levels = currentDepth − N`; no new AST shape, `print` writes the carets. `N ≥ currentDepth` is the parse error `scope N does not enclose this block (the current scope is depth D)`; `1 ^x` (a space) and `1.0^x` stay the stray-`^` error. Composes with brackets, calls and receivers (`0^docs[0]`, `x[p == 0^flag]`, `entries(0^$it)`, `0^$it.docs collect { … }`, `follow 0^people collect { where manager == 1^id }`, `follow next { where prev == 1^id && 0^k == 2 }`, `limit 1^n`). Both parsers now track the scope depth of every position.
  - **Canonical `print` writes `and` / `or`** for the `where` tree's `and`/`or` nodes and for `logical` expressions (both engines); `!` stays `!`, `is`/`is not` were already words, the JSON `logical.op` stays `"&&"`/`"||"`. Consequence: every query text omgbase's `graph` macro prints flips from `||` to `or` — the pinned `graph` query strings in `spec/surface` (`reads.json`, and the `omgbase-surface` unit test for the multi-root seed) are regenerated; nothing else in the surface fixtures changes.
  - **omgbase binding** (`@omgbase/core` `oqx-js/context.ts`, `omgbase-surface` `context.rs`): the root object is the repository root (`$repo`), so `^$it` from a top-level row is `$repo` and `^$it.docs` the docs scan. The `^docs`/`$repo` redesign and the `$id` root name are a separate change.
  - `@omgbase/oqx-syntax`: the `N^` lexeme highlights as one outer-reference token (`lift`), `LANGUAGE_VERSION` 0.18; assets regenerated.

## [1.5.0] - 2026-10-09

### Minor
- Surface 1.5: `refs(x)` and "a hit is a store row".

  - **`refs(x)`** — a new free function of the query binding: the live documents
    named by the document references a property holds. `x` is a string, a list
    or absent; each `/a/b.md`, `a/b.md` or `d_…` element resolves to that
    document's row (paths are matched against `$path` after one leading `/` is
    stripped; an id is tried when no path matches), and anything that resolves
    to nothing is dropped — no phantom row, no error. Order preserved, duplicates
    kept; index-backed (one lookup per element). It yields docs rows, so it is a
    source, a directive receiver, a `follow` destination or a value:
    `follow refs(before), refs(after)` walks a timeline both ways,
    `select prior: refs(before) collect { $path }` projects the referenced
    documents, `where refs(see_also) exists { … }` filters on them.
  - **A hit is a store row.** A top-level `collect`/`first`/`single` row that is
    not a document, block, node or edge now fails the query with
    `filter_invalid` — `a hit must be a document, block, node or edge row — the
    query reached a string ("/timeline/kickoff.md"); to follow document
    references held in a property use refs(<field>)` — instead of rendering the
    junk hit `{ "id": "undefined", "path": "" }`. `values` projections (no hits)
    and nested blocks (rows as values) are unchanged.
  - **Migration:** a `follow` over a property that holds paths or ids — `follow
    before` — reaches the strings and is now an error; write `follow
    refs(before)`. The same for `follow before, after` → `follow refs(before),
    refs(after)`.
  - The alchemy fixture corpus gained two `timeline/` documents whose
    `before`/`after`/`see_also` fields hold document references
    (`spec/surface` 1.5, `query-refs.json`; the `spec/cli` alchemy workspace and
    the §7 interop expectations moved with it).

## [1.4.6] - 2026-10-09

### Patch
- **OQX 0.16 — the AST is a first-class contract** (`spec/oqx/AST.md`, fixtures `cases/ast.json` + `cases/ast-spans.json`, 70 new cases; 959 in all). Both engines now produce one normalized tree a tool can reflect on without re-parsing:

  - **Spans on every node**: `span: [start, end)` in Unicode code points over the raw source (a template's `rawSource`, where a binding occupies its `${n}` marker). The TypeScript lexer counted UTF-16 units; it now counts code points like the Rust one, so the `(at offset N)` of a lex/parse error is the same number in both engines. `toUtf16(span, source)` converts for editors.
  - **Normalized shape**: `kind` on every node (`query`, `subquery`, `follow`, `order` added), optionals materialized (`where`/`limit`/`offset`/`countCmp: null`, `distinct`/`values: false`), operators and consumers serialized as their source words, the never-produced `Expr.index` variant removed. `toJSON(query)` / `ast_to_json(&query)` emit `{ "oqx": "0.16", "kind": "query", … }`; the Rust crate derives serde under the `json` feature (`query_from_json` reads it back).
  - **`where` keeps its surface form**: the parser no longer inlines `select` aliases into `where` (it only validates them — every `errors-parse` fixture is unchanged); the substitution is the exported pure `resolveAliases` / `resolve_aliases`, applied exactly once by the run entry points (`oqx`, `run`, `execute`, `runQuery`; `run_query`, `execute`). **An `Engine.run` now evaluates the query it is given** — code that drives `InMemoryEngine`/`PlannedEngine` directly with a query whose `where` uses aliases must resolve first (resolution is not idempotent: `name: name.upper() … where name`).
  - **Traversal**: `visit(root, { enter, leave })` with `{ path, clause, depth }` (scope depth, 0 = root) and `transform(root, f)`, both driven by one child-key table (`CHILDREN`; Rust `walk::visit`/`transform` with a `Visitor` trait, `Node`, `Clause`); `stripSpans` / `strip_spans`; builders `build.*` / `oqx::build::*` for hand-made nodes (empty span `[0, 0]`).
  - **Canonical printer**: `print(node)` / `print_query` — single spaces, `select` written at the top level, every item aliased, double-quoted strings, minimal parentheses from the precedence table; `printTemplate` → `{ strings, count, indices }` for a tree with bindings (`print` throws, new error stage `print`). Law, enforced by both spec runners over every fixture query: `strip(parse(print(parse(q)))) ≡ strip(parse(q))`.
  - **Migration** for anyone constructing AST literals (after 0.14's `receiver` → `destinations`): add `kind` to `Query`/`Subquery`/`Follow`/`OrderSpec`, `span` to every node, write the materialized fields (`limit: null`, `countCmp: null`, `distinct: false`, `values: false`), drop `index`; or use `build.*`. Rust: struct variants gained `span` (match with `..`), `Expr::Lit(v)` is `Expr::Lit { value, span }`, `Token` gained `end`.
  - **omgbase** (`@omgbase/core`, `omgbase-surface`): the runner's `$self` row-function rewrite is a `transform`, the `semantic("…")` scan a `visit`, aliases are resolved once before the runner's own rewrites; the `graph` macro builds its `follow` walk with the builders and `print`s it instead of splicing strings — the generated query text and every `spec/surface` result are unchanged. `@omgbase/oqx-syntax`'s `LANGUAGE_VERSION` moves to `0.16` (assets regenerated).

## [1.4.5] - 2026-10-09

### Patch
- OQX language **0.15**: the intrinsic naming the current item is **`$it`**; `$value` is no longer an intrinsic and has no synonym. `$it` is the scope's row itself — the top-level row, a nested block's inner item, each element of a scalar collection, the entry's value inside `entries(x)` — absent at the root, with `^$it` the enclosing row, `$it.field` navigation, `$it values`, `$it` as a `follow … { by $it }` identity. A row property literally named `$it` is shadowed by the intrinsic. `$value` is now an ordinary property name under SEMANTICS §2 step 5, exactly like the non-metadata `$` names since 0.13: `{ "$value": 3 }` projects `3`, a row without one reads absent, over scalars it is absent, and inside an `entries()` scope it is a property of the entry's *value*. Why: "self" implies a fixed referent while the row changes per scope; "it" is the pronoun for whatever is being handled; keeping `$value` as a synonym would spell one concept two ways. `$key` is unchanged, and the `{ key, value }` record of `entries(x)` used as a plain value is unchanged (that is a value shape, not the intrinsic). **Migration:** replace `$value` with `$it` in every query (`s/\$value/\$it/g`); nothing else moves. New `intrinsics` fixtures pin the rule; every other fixture query was rewritten with its expectation untouched. omgbase's query surface (`query`, `query_syntax`, the CLI help, `docs/query-language.md`, the tutorial, `spec/surface` fixture queries) follows: a `$value` in an omgbase query now reads a frontmatter/attrs key so named.

## [1.4.4] - 2026-10-09

### Patch
- Nested blocks over a root scan are answered from SQLite indexes instead of
  materializing the target. `$repo.docs` / `$repo.edges` / … (and a bare target
  at the root scope) are handed to the OQX engine as a lazy handle — one per
  target per run — and `makeStoreContext().indexFor` (TypeScript) /
  `StoreContext::index_for` (Rust, `store_index`) answers a block's correlated
  or constant equality (`$repo.docs collect { where customer == ^$path }`,
  `$repo.edges exists { where $dst == ^$id }`, `$repo.docs single { where type
  == "x" }`) with one prepared, index-driven statement per probe under the
  planner's live-row and repo guards, yielding rows built exactly as the scan
  builds them: docs `$id`, `$path`, `$title` and any property key (typed — a
  string probe matches only a string row, a number only a number row, a boolean
  only a bool row, under the scalar-in-scope rule); blocks `$id`, `$doc`, `type`,
  `$path`; nodes `$id`, `$doc_id`, `kind`, `name`, `$path`; edges `$id`, `$src`,
  `$dst`, `$path`, `$dst_path`. An absent probe (`key == null`) or an unindexed
  path (`format`, `predicate`, `$tags`, `meta.id`) reads the handle once per run
  and falls back to the scan's own answer. Results are unchanged (the
  conformance suites gained the correlated shapes); 500 raw probes over 5,000
  documents take ≈ 9 ms of SQLite time and the whole planned query ≈ 160–180 ms
  wall time (TypeScript); a 2,000-document / 200-probe run takes ≈ 60 ms end to
  end (Rust). The planner's scan SQL now lives in
  `oqx-js/sql/scan.ts` (shared with the indexes).

  The Rust `$repo.<target>` handle (a marker value) is resolved through the new
  `DataContext::materialize` seam, so `$repo.docs == $repo.docs`, `"x" in
  $repo.docs`, `entries($repo.docs)`, `size($repo.docs)`, truthiness,
  `distinct`, `order by` and projection see the rows exactly as the TypeScript
  `Proxy` array shows them; the runner's post-hoc expansion and the row-function
  argument expansion are gone. `spec/surface` gains eight `lazy-root-*` cases
  (`query-functions.json`) and an interop read pinning the handle as a value on
  both engines.

## [1.4.3] - 2026-10-06

### Patch
- OQX language **0.14** (`spec/oqx/VERSION`): `follow` gains correlated successor
  predicates and destination lists.

  - **`^` in the follow `where` is the frontier row.** `follow R { where P }` now
    reads `P` in the candidate's scope whose parent is the row being expanded, so
    `follow doc.in { where before.contains(^$path) }` steps only into rows that
    name the row they were reached from; `^^name` is the walk's enclosing scope.
    Before, `^` skipped the frontier row and read the enclosing scope (the root
    for a top-level walk), so a correlated predicate silently never held.
    `frontier` and `by` are unchanged (`^` there is the enclosing scope).
  - **Destination lists.** `follow a, b, …` walks the union of several
    destinations; each is a relation of the current row or a **destination
    block** — a select-position `collect`/`first`/`single` block re-evaluated per
    frontier row with `^` bound to it (`follow ^people collect { where manager ==
    ^id }`, `follow before, ^docs collect { where after.contains(^$path) }`).
    Within one expansion step the successors are unioned by identity — the
    walk's identity, so `by E` governs it: a relation holding a node twice now
    yields one successor, and under `by type` same-type siblings reached in one
    step are one node (the surface case `query-follow::by-rekeys-identity` goes
    from 8 to 5 hits). `frontier`, `depth`, `where`
    and `by` apply to the whole walk; `$ordinal` stays `(depth, path)`.
  - AST: `Follow.receiver` becomes `Follow.destinations` (TypeScript
    `(Expr | OpNode)[]`; Rust `Vec<FollowDestination>` with `Relation(Expr)` /
    `Block(OpNode)`). omgbase's query rewriters and planners read the new shape;
    `@omgbase/oqx-syntax` pins `LANGUAGE_VERSION` to `0.14`.
  - 27 new fixtures in `spec/oqx/cases/follow.json` (877 cases in 29 files).

## [1.4.2] - 2026-10-01

### Patch
- `diff_unified` (and `omg diff`) now diffs the two revisions' reconstructed files — the same bytes `docs_read_at` returns — instead of every live block's raw at every depth joined by `\n`. The old rendering emitted a list container's whole text and then each list item again beneath it, so appending one bullet to a list showed up as an insertion before the list's first item and the same `+` line repeated in a second hunk. Hunk line numbers now correspond to real file lines. `spec/surface` §3 wording and a §9 entry record the fix; the surface spec stays at 1.4.

## [1.4.1] - 2026-09-28

### Patch
- `docs_move` now retargets the inbound links by default (spec/mutate 1.3): every authored link that named the old path (Markdown links and images, wikilinks, bare-path inline fields) is rewritten to the new path in the same call, as before with `retarget_inbound: true`, so a move never leaves the graph broken until a second `links_repair`. `retarget_inbound: false` is the opt-out for the rarer intent that the old path become unbound; frontmatter relations are still never rewritten and remain in `dangling`. The `omg mv` verb follows (spec/cli 1.2): it counts the rewritten links on stderr, `--no-retarget` opts out, and a dangling frontmatter relation now gets a `meta --set` fix hint instead of a `retarget` that could not have fixed it. The library default (`DocMoveOptions.retargetInbound`) flips the same way; the Rust catalog and binary mirror it.

## [1.4.0] - 2026-09-27

### Minor
- `version` tool (`spec/surface` §4, 1.4) in the Rust catalog and `omgbase version [--json]` (`spec/cli` §6, 1.1): which engine and which versions — `engine: "rust"`, the binary's own version, `components` (the `omgbase` crate, every `omgbase-*` crate it is built from and `oqx`, keys sorted bytewise), `specs` (each crate's `SPEC_VERSION`, `oqx`'s `LANGUAGE_VERSION`, the binary's new `cli::SPEC_VERSION` pinned to `spec/cli/VERSION`), `schema` (`PRAGMA user_version`, `null` without a database), `mcp: { protocol }` (no SDK), `runtime` (`rustc <version>`), `commit` and `built`. The verb needs no repo, opens the workspace only for `schema`, and with `--server` returns the remote engine's answer — how a user learns whether a remote is the TypeScript or the Rust engine. `--version` is unchanged.
- `omgbase-surface`: `BuildInfo` + `Surface::with_build_info` + `version_info(store, build)`; `MCP_PROTOCOL_VERSION` (`2025-11-25`, what the reference's SDK serves) is now the transport's default at `initialize` (a client's own revision is still echoed).
- `crates/omgbase/build.rs` records `OMGBASE_COMMIT` (`git rev-parse --short HEAD` from a checkout, else the `sha1` of the packaged `.cargo_vcs_info.json`, else unset → `null`), `OMGBASE_BUILT` (RFC 3339, `SOURCE_DATE_EPOCH` honored) and `OMGBASE_RUSTC`.
- Every spec crate and `oqx` gain a `pub const VERSION` (their `CARGO_PKG_VERSION`) so the surface can report component versions.
- Runners: `spec/surface` §6 records a `version` read by shape (leaves → type names, `components` → `"<object>"`, `mcp.sdk` dropped); `spec/cli` §8 applies the same to the `version` verb's stdout (JSON leaves; human value cells; the component lines collapse to `  <object>`).
