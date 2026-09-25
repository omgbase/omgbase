# The OQX specification

OQX (omgbase Query eXpressions) is a language with more than one implementation.
This directory is the specification both implementations conform to. It is
owned by neither of them.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/oqx` (TypeScript, npm) | `packages/oqx` | **Reference.** Grammar and semantics decisions land here first. |
| `oqx` (Rust, crates.io) | `crates/oqx` | Conformance-first port. Passes the same fixtures. |

The spec is three artifacts, versioned together by `VERSION`:

- `GRAMMAR.md` — the surface syntax: clause order, keywords, expressions, blocks, `follow`.
- `SEMANTICS.md` — the scalar and collection rules: equality, ordering, absent handling, truthiness, arithmetic, membership, ranges, builtins (including the regex baseline), `distinct`, `limit`/`offset`, consumers.
- `cases/*.json` — the executable fixtures. **When prose and fixtures disagree, the fixtures win**, and the prose gets fixed.

## Versioning: one number for the language

OQX is a language, so its version is the version users care about, and both
implementations share it. `VERSION` holds the language version as
`major.minor`. Every implementation's package version is
`<language major>.<language minor>.<patch>`:

- **A language change** (any fixture added or changed that alters behavior)
  bumps the minor here (pre-1.0) and in every implementation at once, even one
  whose code did not need to change. The `@omgbase/oqx` npm package and the
  `oqx` crate at `0.12.x` both mean "the 0.12 language".
- **The patch digit is per implementation** and free: bug fixes, performance,
  packaging. An implementation at `0.12.3` conforms to language `0.12` exactly
  like one at `0.12.0`.
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
  - `result` — the consumer-shaped result: an array for `collect`, a boolean for `exists`/`none`, a number for `count`, a record or `null` for `first`/`single`.
  - `error` — `{ "stage": "lex" | "parse" | "eval", "includes": ["substring", ...] }`. `stage` must match the implementation's error stage. Every string in `includes` (optional) must appear in the message. Fixtures should assert on stable fragments the spec names (a clause name, an operator, the clause-order sentence), not on full messages.

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
- `DataContext` customization (custom `get`, `identity`, `callFunction`);
- host-only collection types (`Set`, `Map`, iterators);
- the SQLite adapter and planner pushdown. (Whether the planned path equals the in-memory path is an *implementation* conformance test; each implementation keeps its own.)

Those stay in each implementation's own test suite.

## Portability rules the fixtures rely on

These are the places a second implementation diverges from JavaScript by
accident. `SEMANTICS.md` states each as a rule; this is the short list.

- **Numbers are doubles.** There is no integer type. Integer-valued doubles print without a fraction.
- **Strings order and measure by Unicode code point**, not UTF-16 code unit and not byte.
- **`matches(pattern, flags?)` compiles the OQX regex baseline** (SEMANTICS §11), a fixed grammar with spec-defined meanings: `\d` `\w` `\b` are ASCII, `\s` is one listed set, the line terminator is `\n` alone, flags are the second argument. Every construct outside it is rejected by name; a fixture relying on an engine's native behavior (Unicode `\d`, inline `(?i)`, lookaround) is a spec bug.
- **Object property order is insertion order**, observed by `entries()` and by projection.
- **Identity** for `follow` dedup and `distinct` over unprojected rows is the row's `id` property when present, else the row's structural value.

## Running

- TypeScript: `pnpm --filter @omgbase/oqx test` (the runner is `packages/oqx/test/spec.test.ts`).
- Rust: `cargo test -p oqx` (the runner is `crates/oqx/tests/spec.rs`). While the port is incomplete, `crates/oqx/tests/spec-passing.txt` lists the case ids that must pass; a listed case failing fails the build, and an unlisted case passing also fails the build with a message asking for it to be added. When the list equals the case set, the file is deleted.
