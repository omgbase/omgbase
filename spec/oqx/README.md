# The OQX specification

OQX (omgbase Query eXpressions) is a language with more than one implementation.
This directory is the specification both implementations conform to. It is
owned by neither of them.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/oqx` (TypeScript, npm) | `packages/oqx` | **Reference.** Grammar and semantics decisions land here first. |
| `oqx` (Rust, crates.io) | `crates/oqx` | Conformance-first port. Passes the same fixtures. |

The spec is four artifacts, versioned together by `VERSION`:

- `GRAMMAR.md` — the surface syntax: clause order, keywords, expressions, blocks, `follow`, the 0.17 sugar (implicit `collect`, where-first bodies, brackets, postfix `!`, `is`/`not`), the 0.18 absolute scope references (`0^docs`, `1^$path`), the 0.19 outer-reference destination blocks, and the 0.20 shapes: tuples `(a, b)`, a brace after any `follow` destination opening that destination's block (with `frontier`/`depth` as its clauses; the options block is gone), `frontier` on any body that has a `follow` (its seeds' frontier), `x distinct { … }`, and the receiver-block sugar wherever a value stands; the 0.21 template literals `` `text ${expr}` `` (a backtick string with interpolations, usable wherever a value stands); and the 0.22 infix regex operators `~` `~*` `!~` `!~*` (sugar over `matches` at comparison precedence).
- `SEMANTICS.md` — the scalar and collection rules: scopes (the root scope's row is the host's root object, since 0.18), equality, ordering, absent handling, truthiness, arithmetic, membership, ranges, builtins (including the regex baseline), `distinct`, `limit`/`offset`, consumers; since 0.20 the cardinality rule (one object in row position yields one record, a scalar is an error), tuples, and identity as `$key` (the host's, else structural; projectable); since 0.21 template literals (concatenation over the string form; absent propagates; a list or record is an eval error); since 0.22 the infix regex operators as one desugar each onto `matches` (an absent receiver is false under `~` and true under `!~`).
- `AST.md` — the abstract syntax tree as a contract (since 0.16): the node and field tables, spans, the JSON shape both implementations produce, the traversal and canonical-printer laws.
- `cases/*.json` — the executable fixtures. **When prose and fixtures disagree, the fixtures win**, and the prose gets fixed.

## Versioning: one number for the language

OQX is a language, so its version is the version users care about, and both
implementations share it. `VERSION` holds the language version as
`major.minor`. Every implementation's package version is
`<language major>.<language minor>.<patch>`:

- **A language change** (any fixture added or changed that alters behavior)
  bumps the minor here (pre-1.0) and in every implementation at once, even one
  whose code did not need to change. The `@omgbase/oqx` npm package and the
  `oqx` crate at `0.13.x` both mean "the 0.13 language".
- **The patch digit is per implementation** and free: bug fixes, performance,
  packaging. An implementation at `0.13.3` conforms to language `0.13` exactly
  like one at `0.13.0`.
- Each implementation exports a `LANGUAGE_VERSION` constant equal to `VERSION`
  so a caller can ask.

There is no separate "spec version" and no separate "component version"; the
language version is both.

## The rule for changing the language

1. **Fixture first.** Write the case that expresses the decision. Bump `VERSION` (and every implementation's minor) if behavior changes.
2. **Reference second.** Make it pass in `packages/oqx`.
3. **Rust third**, in the same change when practical. Otherwise the change is not done and must be tracked as an open loop.

A fixture that only one implementation runs is a spec bug. CI checks that every
file under `cases/` was executed by both runners.

## Fixture format

One JSON file per topic under `cases/`. A file is a suite:

```json
{
  "suite": "order-by",
  "cases": [ { ... }, { ... } ]
}
```

A case:

```json
{
  "name": "absent sorts last in both directions",
  "tags": ["order", "absent"],
  "roots": { "docs": [ { "name": "a", "rank": 2 }, { "name": "b" }, { "name": "c", "rank": 1 } ] },
  "query": "name from docs order by rank desc",
  "expect": { "result": [ { "name": "a" }, { "name": "c" }, { "name": "b" } ] }
}
```

Fields:

- `name` (required) — unique within the file. `<file>::<name>` is the case id used by allowlists and reports.
- `tags` (optional) — free-form strings for filtering.
- `notes` (optional) — why this case exists, if it is not obvious.
- `roots` (optional) — named values that `from <name>` and a bare directive receiver resolve against. Plain JSON; usually arrays, but a root may be any JSON value (an object, scalar, or `null`) when a case pins how a non-collection source is coerced.
- Exactly one of:
  - `query` — the query as a plain string. No interpolations.
  - `template` — a query with bindings, mirroring a JavaScript tagged template exactly: `{ "strings": ["name from ", " where employer == ", ""], "values": [ [...], "Globocorp" ] }`. `strings` has one more element than `values`. A runner parses it with the implementation's template entry point (`parseTemplate` in the reference) so bindings stay typed values, never source text.
- `expect` (required) — exactly one of:
  - `result` — the consumer-shaped result: an array for `collect` over a collection (a record or `null` over one object, SEMANTICS §3), a boolean for `exists`/`none`, a number for `count`, a record or `null` for `first`/`single`.
  - `error` — `{ "stage": "lex" | "parse" | "eval", "includes": ["substring", ...] }`. `stage` must match the implementation's error stage. Every string in `includes` (optional) must appear in the message. Fixtures should assert on stable fragments the spec names (a clause name, an operator, the clause-order sentence), not on full messages.
  - `ast` — the JSON tree of `parse(query)` (or of the template), in the shape `AST.md` defines. A runner serializes its tree (TypeScript: the objects themselves; Rust: serde under the `json` feature), drops every `span`, and compares after the canonicalization below. A case may set `"spans": true` at the top level to compare spans too; such a case keeps its source ASCII-only so the offsets are plainly countable (`cases/ast-spans.json`).
- `spans` (optional, with `expect.ast` only) — compare spans verbatim instead of stripping them.

Every case whose query parses (an `ast`/`result`/`eval`-error case) is also run through the canonical printer's round-trip law, `strip(parse(print(parse(q)))) ≡ strip(parse(q))` (`AST.md` §6), by both runners — no fixture field asks for it.

## Result canonicalization

Results are compared as JSON values after canonicalization, so the fixtures
stay language-neutral:

- A JavaScript `undefined` (Rust `Value::Undefined`) as an **object property is dropped**; as an **array element or a top-level result it becomes `null`**. This is `JSON.stringify` behavior and both runners apply it.
- **Object key order is ignored.** Array order is significant.
- Numbers compare as IEEE doubles. `-0` equals `0`. `NaN` and infinities must not appear in an expected result; a fixture whose result would contain one is a spec bug.
- Range values never appear in results.

## What does not belong in `cases/`

Anything that depends on a host language rather than on OQX:

- the tagged template API surface itself (caching by `strings` identity, the `unwrap` shape of `run`);
- `DataContext` customization (custom `get`, `identityOf`, `isSingle`, `callFunction`);
- host-only collection types (`Set`, `Map`, iterators);
- the SQLite adapter and planner pushdown. (Whether the planned path equals the in-memory path is an *implementation* conformance test; each implementation keeps its own.)

Those stay in each implementation's own test suite.

## Portability rules the fixtures rely on

These are the places a second implementation diverges from JavaScript by
accident. `SEMANTICS.md` states each as a rule; this is the short list.

- **Numbers are doubles.** There is no integer type. Integer-valued doubles print without a fraction.
- **Strings order and measure by Unicode code point**, not UTF-16 code unit and not byte.
- **`matches(pattern, flags?)` compiles the OQX regex baseline** (SEMANTICS §11), a fixed grammar with spec-defined meanings: `\d` `\w` `\b` are ASCII, `\s` is one listed set, the line terminator is `\n` alone, flags are the second argument. Every construct outside it is rejected by name; a fixture relying on an engine's native behavior (Unicode `\d`, inline `(?i)`, lookaround) is a spec bug. The **infix regex operators** (since 0.22) are the same call: `a ~ b` is `a.matches(b)`, `a ~* b` adds the `i` flag, `a !~ b` / `a !~* b` negate — so an absent receiver is false under `~` and **true** under `!~` (OQX's absent, not SQL's NULL), and the tree keeps the operator as written (`binary.op`).
- **Object property order is insertion order**, observed by `entries()` and by projection.
- **Identity is `$key`** (SEMANTICS §16, since 0.20): what `follow` dedup, `distinct` over unprojected rows and `is` compare, and what reading `$key` on a row returns. It is the host's identity when the `DataContext` names one (`identityOf` / `identity`), else the row's **structural value**; an entry's is its key; a block may project `$key: expr` to give the rows it yields that identity. The language never names an `id` property. The reference `DefaultContext` names no identity, so the fixtures project `$key: id` where a walk must recognise plain objects by id.
- **Cardinality** (SEMANTICS §3, since 0.20): in row position an array is a collection and a non-array object is ONE row — a block over it (and a body whose source it is) yields one record or absent, not a one-element list; a scalar is an eval error. A host may say which of its objects are collections (`DataContext.isSingle`); the fixtures assume the reference's rule (every non-array object is one row, `[]`-rooted values are collections).
- **Tuples** (SEMANTICS §3b, since 0.20): `(e1, e2, …)` concatenates its elements with one level of flattening; the one place the two spellings of absent differ — a missing property (`undefined`) contributes nothing, a `null` is kept.
- **The root object is host-defined** (SEMANTICS §2, since 0.18): the root scope's row — `$it` there, `^$it` from a top-level row — is whatever the host's `DataContext` returns as its root object; the reference `DefaultContext` returns the roots record, which is what the fixtures assume (`entries(^$it)` lists the roots in insertion order; `^$it.people` is `^people`). Bare names at the root are always `root(name)`, never a property of that object. A host with no root object leaves the root row absent.
- **Canonical print writes `and` / `or`** (AST.md §6, since 0.18); the symbols parse to the same nodes and the JSON operator words stay `&&` / `||`.
- **Template literals** (GRAMMAR §4, SEMANTICS §7b, since 0.21): the text decodes with the string escapes; an interpolated number renders as `+` renders it (no fraction when integer-valued), a boolean as the word; an absent interpolation makes the literal absent; a list, record or range interpolation is an eval error — no implementation may render one. The AST `template.parts` strictly alternates text strings and expressions (AST.md §2).

## Running

- TypeScript: `pnpm --filter @omgbase/oqx test` (the runner is `packages/oqx/test/spec.test.ts`).
- Rust: `cargo test -p oqx` (the runner is `crates/oqx/tests/spec.rs`). While the port is incomplete, `crates/oqx/tests/spec-passing.txt` lists the case ids that must pass; a listed case failing fails the build, and an unlisted case passing also fails the build with a message asking for it to be added. When the list equals the case set, the file is deleted.
