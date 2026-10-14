---
npm:
  "@omgbase/oqx": none
  "@omgbase/oqx-syntax": patch
  "@omgbase/core": minor
  omgbase: minor
crates:
  oqx: none
  omgbase-surface: minor
  omgbase: minor
---
**Unknown names** (`spec/surface` 4.5 → 4.6, §1.5; `spec/oqx` 0.22 → 0.23,
AST.md §5b). A query that read a name no row of its kind can carry — `select
path, target from links` (links have `dst_path`), `select type, value from
blocks`, `where preview != ""` — used to run silently, returning absent columns
or matching every row. Now every name a query reads is judged **statically**,
before any row is read, against the vocabulary of the row kind it is read from:
tier 1, an engine attribute, handle or relation; tier 2, an authored property at
least one live object of the kind in the repository carries (a frontmatter or
inline key on docs — `stage` on three processes is enough; an `attrs` key on
blocks and nodes); tier 3, a name no object carries — the complaint. On `links`
(a closed row shape) a tier-3 name is `filter_invalid` listing the fields with
a nearest match (`` `dst_pth` is not a field of links (fields: id, path, …); did
you mean `dst_path`? ``); on docs, blocks and nodes a read returns its rows and
gains **`hints: [string…]`**, the last member of the `query` result, one line per
name in first-reference order (`` `titel` is not a field of docs and no document
in this repository carries a property by that name; did you mean `title`? ``;
under a source handle: `` no document in this repository carries a property
`path` (`data.path`) ``), absent when there is nothing to say; a **write
selector** (`plan`/`apply`/`execute` with `select`) is refused through the
runner's AST entry (`unknownNames: "refuse"`, its default; the source entry
every read uses hints), since `where target != "x"` would select every row. The
verdict never depends on the query's filter; a repository with no object of a
kind skips the check for that kind. The nearest match is case-insensitive
Damerau–Levenshtein ≤ 2 or a substring of ≥ 3 characters, lowest distance first
(two awkward edges — `x` → `id`, `via` → `id` over `via_id` — are pinned as
truth, not special-cased). The vocabulary is cached per repository on its head
commit.

- `@omgbase/oqx` 0.23.0 (hand-bumped with its CHANGELOG, per the standalone
  convention — `none` here): the **`references(query)`** static pass — every name
  a query reads from a row, with its clause and the row chain of its scope, for
  a host to judge against its data model; new fixture kind `expect.references`
  and suite `spec/oqx/cases/references.json` (29). The `oqx` crate's twin
  follows (`none` here; hand-bumped to 0.23.0 by the Rust change).
- `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.23 (no lexical change).
- `@omgbase/core`: `oqx-js/names.ts` (the vocabulary, the kind of a scope, the
  judgement, the messages, the nearest match), `oqxRun`/`oqxRunQuery` with
  `OqxOptions.unknownNames` and `OqxResult.hints`; `query_syntax` names the
  rule; `spec-versions.ts` surface 4.6.
- `omgbase` (CLI): `omg query` prints each hint as a dim `  hint: …` line on
  stderr after its rows (`--json` carries the member); four `spec/cli` cases.
- `omgbase-surface` / `omgbase` (crates): `reference.rs` synced byte for byte;
  the Rust judgement, `hints` and the `references` twin are the Rust change
  that follows this one (the new `query-unknown.json` and `references.json`
  suites wait on it).
