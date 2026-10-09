# Changelog

All notable changes to `@omgbase/oqx-syntax` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.2.2] - 2026-10-09

### Patch
- OQX language **0.15**: the intrinsic naming the current item is **`$it`**; `$value` is no longer an intrinsic and has no synonym. `$it` is the scope's row itself — the top-level row, a nested block's inner item, each element of a scalar collection, the entry's value inside `entries(x)` — absent at the root, with `^$it` the enclosing row, `$it.field` navigation, `$it values`, `$it` as a `follow … { by $it }` identity. A row property literally named `$it` is shadowed by the intrinsic. `$value` is now an ordinary property name under SEMANTICS §2 step 5, exactly like the non-metadata `$` names since 0.13: `{ "$value": 3 }` projects `3`, a row without one reads absent, over scalars it is absent, and inside an `entries()` scope it is a property of the entry's *value*. Why: "self" implies a fixed referent while the row changes per scope; "it" is the pronoun for whatever is being handled; keeping `$value` as a synonym would spell one concept two ways. `$key` is unchanged, and the `{ key, value }` record of `entries(x)` used as a plain value is unchanged (that is a value shape, not the intrinsic). **Migration:** replace `$value` with `$it` in every query (`s/\$value/\$it/g`); nothing else moves. New `intrinsics` fixtures pin the rule; every other fixture query was rewritten with its expectation untouched. omgbase's query surface (`query`, `query_syntax`, the CLI help, `docs/query-language.md`, the tutorial, `spec/surface` fixture queries) follows: a `$value` in an omgbase query now reads a frontmatter/attrs key so named.

## [0.2.1] - 2026-10-06

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

## [0.2.0] - 2026-09-28

### Minor
- New package **`@omgbase/oqx-syntax`**: syntax highlighting assets for OQX, generated from one lexical vocabulary so no editor grammar can drift from another. It ships the TextMate grammar (`source.oqx`, `syntax/oqx.tmLanguage.json`), a Monaco Monarch grammar (`syntax/oqx.monarch.json`), a CodeMirror 6 stream parser (`oqxStreamParser(tags)`, plus `oqxLegacyMode()` in CodeMirror 5's shape for Obsidian), a Prism grammar (`oqxPrismGrammar`, `registerOqxPrism`), the editor language configuration, language metadata (`LANGUAGE`, `LANGUAGE_VERSION`), the vocabulary itself (keywords, contextual words, consumers, builtins, intrinsics, the omgbase host names), and adapters for Shiki (`oqxShikiLanguage`), Monaco (`registerOqx`) and a VS Code extension under `vscode/` that also highlights ```` ```oqx ```` Markdown fences. Highlighting is lexical: contextual words are colored only in position (`count {`, `limit 10`, `order by`, `in <value>`), malformed numbers and lex-error characters are marked `invalid`, and every `$name` is an intrinsic. Tests tokenize with the real TextMate engine (golden corpus), prove that the Monarch, CodeMirror and Prism grammars tokenize every `spec/oqx` fixture exactly as TextMate does, check that lexically valid fixtures never show an error token, pin the vocabulary to the spec prose and to `@omgbase/oqx`'s `LANGUAGE_VERSION`, and load the grammar into Shiki.
