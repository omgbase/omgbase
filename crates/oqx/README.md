# oqx

**OQX (omgbase Query eXpressions) — Rust implementation.**

OQX is a small query language for querying JSON-shaped collections — arrays of
records, nested relations, recursive trees — with a readable, declarative
syntax:

```text
select name, id, title
from people
where jobs exists { where employer == "Globocorp" && !end_date }
```

This crate is the second implementation of the language. The reference
implementation is the TypeScript package
[`@omgbase/oqx`](https://github.com/omgbase/omgbase/tree/main/packages/oqx).
Both conform to the language-neutral specification and fixtures at
[`spec/oqx`](https://github.com/omgbase/omgbase/tree/main/spec/oqx) in the same
repository, and each reports the spec version it conforms to.

## Status

Under construction: the port is conformance-first. `tests/spec.rs` runs every
fixture in `spec/oqx/cases`; `tests/spec-passing.txt` lists the cases that must
pass today and grows until it equals the case set. Not yet published.

## Layering

Mirrors the reference so the two can be read side by side:

- `lexer` / `parser` → `ast` — the fixed clause order (`select, from, where,
  follow, order by, limit, offset`; only a leading `select` may drop its
  keyword) and the expression grammar.
- `semantics` — the scalar contract every backend obeys: typed equality with no
  coercion, absent-aware ordering (absent sorts last both ways), membership,
  ranges, arithmetic, builtins.
- `engine` — the in-memory engine over a `DataContext` (the seam that binds the
  language to a data model; the default context is plain `Value`s).
- `planner` — the seam for pushing work into a store and finishing the residual
  in memory.

## Features

- `json` — `From`/`Into` between `oqx::Value` and `serde_json::Value`.

## License

MIT
