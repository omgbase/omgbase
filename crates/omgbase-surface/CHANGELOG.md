# Changelog

All notable changes to `omgbase-surface` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

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
