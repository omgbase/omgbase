# Changelog

All notable changes to `omgbase` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.9.0] - 2026-10-09

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

## [0.8.1] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.8.0] - 2026-10-09

### Minor
- OQX language **0.15**: the intrinsic naming the current item is **`$it`**; `$value` is no longer an intrinsic and has no synonym. `$it` is the scope's row itself — the top-level row, a nested block's inner item, each element of a scalar collection, the entry's value inside `entries(x)` — absent at the root, with `^$it` the enclosing row, `$it.field` navigation, `$it values`, `$it` as a `follow … { by $it }` identity. A row property literally named `$it` is shadowed by the intrinsic. `$value` is now an ordinary property name under SEMANTICS §2 step 5, exactly like the non-metadata `$` names since 0.13: `{ "$value": 3 }` projects `3`, a row without one reads absent, over scalars it is absent, and inside an `entries()` scope it is a property of the entry's *value*. Why: "self" implies a fixed referent while the row changes per scope; "it" is the pronoun for whatever is being handled; keeping `$value` as a synonym would spell one concept two ways. `$key` is unchanged, and the `{ key, value }` record of `entries(x)` used as a plain value is unchanged (that is a value shape, not the intrinsic). **Migration:** replace `$value` with `$it` in every query (`s/\$value/\$it/g`); nothing else moves. New `intrinsics` fixtures pin the rule; every other fixture query was rewritten with its expectation untouched. omgbase's query surface (`query`, `query_syntax`, the CLI help, `docs/query-language.md`, the tutorial, `spec/surface` fixture queries) follows: a `$value` in an omgbase query now reads a frontmatter/attrs key so named.

## [0.7.1] - 2026-10-09

### Patch
- Dependency pins moved: .

## [0.7.0] - 2026-10-06

### Minor
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

## [0.6.1] - 2026-10-01

### Patch
- Dependency pins moved: .

## [0.6.0] - 2026-09-28

### Minor
- `docs_move` now retargets the inbound links by default (spec/mutate 1.3): every authored link that named the old path (Markdown links and images, wikilinks, bare-path inline fields) is rewritten to the new path in the same call, as before with `retarget_inbound: true`, so a move never leaves the graph broken until a second `links_repair`. `retarget_inbound: false` is the opt-out for the rarer intent that the old path become unbound; frontmatter relations are still never rewritten and remain in `dangling`. The `omg mv` verb follows (spec/cli 1.2): it counts the rewritten links on stderr, `--no-retarget` opts out, and a dangling frontmatter relation now gets a `meta --set` fix hint instead of a `retarget` that could not have fixed it. The library default (`DocMoveOptions.retargetInbound`) flips the same way; the Rust catalog and binary mirror it.

## [0.5.0] - 2026-09-27

### Minor
- A `version` MCP tool (spec/surface 1.4) and an `omg version` verb (spec/cli 1.1): which engine you are talking to and what it was built from — `{ engine: "typescript", version, components: { omgbase, @omgbase/core, @omgbase/oqx, @omgbase/sync, @omgbase/fs-adapter }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk }, runtime, commit, built }`. `versionInfo(store?, host?)` and the compile-time `SPEC_VERSIONS` map (tested against every `spec/<x>/VERSION`) are exported from `@omgbase/core`; `pnpm build` writes `dist/build-info.json` (`commit`, `built`) into the `omgbase` package, which passes its identity to the engine as `ServerContext.host`. `omg version --json` is the tool result verbatim; `omg version --server …` renders the remote engine's answer, which is how you tell a TypeScript `omg mcp` from a Rust `omgbase mcp`. The fixtures record the result by shape (leaves as type names). `--version` is unchanged.

## [0.4.1] - 2026-09-27

### Patch
- What 0.4.1 carries over the published 0.4.0 (waves 3c–4d; the crates shipped
  each step and are already current on crates.io).

  - **cli 1.0** (`spec/cli`) — the reference `omg` brought to the spec's decided
    rules: usage errors exit 2 with `usage:`, engine error codes kept on the
    wire, `--version` from the package, `--dry-run` on the document verbs
    (`new`/`mv`/`rm --doc`/`meta`) via surface 1.3 `dry_run`, `node set` fixed,
    `done` checks the node type, `retarget` prints a unified diff, one
    machine-mode rule, tool-shaped `--json`, `embedQueue` = the stale count,
    `doctor` counts live leaves; every verb honors the `OMGBASE_SPEC_MINTER` /
    `OMGBASE_SPEC_CLOCK` seams.
  - **store 13.5** collision-safe minting: a production mint never returns an
    id already in use (a 3,000-document ingest had collided at 360k blocks).
  - **mutate 1.2** — the destination parent of insert/move must be a container;
    a leaf is `type_mismatch`. An insert into a heading had silently destroyed
    it (both kernels and the cross-document move path).
  - **surface 1.3** — `dry_run` on the docs tools (`docs_create` / `docs_move` /
    `docs_delete` / `docs_set_meta`); typed pushes in the pushdown planner
    (bool/number literals against attrs and property reads push with
    `json_type` / `properties.type`).
  - `@omgbase/sync`: a sourceless write throws the typed `repo_not_found` the
    server emits; the shared embedding provider between the query path and the
    drain.
