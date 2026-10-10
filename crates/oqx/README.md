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

Conformance-first, and conformant: `tests/spec.rs` runs every fixture in
`spec/oqx/cases` (1131 cases in 32 files at language version 0.17) and all of them
pass, so `cargo test -p oqx` requires every case to pass. Published on crates.io
as `oqx`.

The runner keeps an allowlist mechanism for the periods when the spec runs
ahead of the port (from `spec/oqx/README.md`): if `tests/spec-passing.txt`
exists, it names the case ids (`<file-stem>::<name>`, one per line) that must
pass; a listed case that fails fails the build, an unlisted case that passes
fails the build with a message asking for it to be added, and a listed id that
no longer exists is an error too. When the file is absent — the current state —
every case must pass. `cargo test -p oqx` prints `spec: N passed, M failed, K
listed` on stderr and, on failure, the offending case ids grouped by fixture
file with a one-line reason each.

To (re)generate the allowlist from the currently passing set — for example
after new fixtures land in `spec/oqx/cases` before the port catches up — run:

```sh
OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec
```

This writes the list (and prints any listed case that now fails, so nothing is
blessed silently), or deletes the file once every case passes.

## Layering

Mirrors the reference so the two can be read side by side:

- `lexer` / `parser` → `ast` — the fixed clause order (`select, from, where,
  follow, order by, limit, offset`; only a leading `select` may drop its
  keyword) and the expression grammar. Since 0.16 the tree is a language-level
  contract (`spec/oqx/AST.md`, below): every node carries a `Span`, every
  optional field is materialized, and `where` keeps its surface form. `follow` takes a comma-separated list
  of destinations (`Follow.destinations`, since 0.14): a relation of the
  current row, or a destination block — `^people collect { where manager ==
  ^id }`, a select-position directive re-read per frontier row with `^` bound
  to that row; the walk is their union, successors unioned by identity within a
  step, and the follow `where` reads the frontier row through `^`.
- `semantics` — the scalar contract every backend obeys: typed equality with no
  coercion, absent-aware ordering (absent sorts last both ways), membership,
  ranges, arithmetic, builtins.
- `regex_dialect` — `matches()`: the spec's regex baseline parsed and rewritten
  for the `regex` crate (`\d`→`[0-9]`, `\b`→`(?-u:\b)`, `\s`→one listed set,
  flags→`(?ims)`), so a pattern means the same here as in the reference;
  `DataContext::regex_dialect()` / `DefaultContext::with_regex_dialect` opt a
  host into the crate's native syntax instead (not portable).
- `resolve` — `resolve_aliases`: the `select`-alias substitution in `where`
  (SEMANTICS §14), applied exactly once by the entry points `run_query` /
  `execute` before the engine sees the query (an `Engine::run` evaluates the
  query it is given).
- `walk` — `visit` with a `Visitor` (enter/leave; the context carries the path,
  the `Clause` and the scope depth), `transform` (rebuild with every expression
  mapped, children first), `strip_spans`; `Node` is the borrowed any-node enum.
- `print` — the canonical printer: `print_query` / `print` (a `Node`), and
  `print_template` for a tree with bindings (`Template { strings, count,
  indices }`); the round-trip law `strip(parse(print(parse(q)))) ≡
  strip(parse(q))` is checked over every spec fixture by `tests/spec.rs`.
- `build` — node builders (`build::query`, `build::op`, `build::subquery`,
  `build::field`, `build::ident`, `build::lit`, …) producing `Span::EMPTY`
  nodes that print like parsed ones.
- `engine` — the in-memory engine over a `DataContext` (the seam that binds the
  language to a data model; the default context is plain `Value`s).
- `optimize` — the nested-block optimizer (below).
- `planner` — the seam for pushing work into a store and finishing the residual
  in memory.

## Performance: relational patterns

A nested block runs once per enclosing row, so `^customers first { where id ==
^customer_id }`, `^orders collect { … where customer_id == ^id }` and
`^customers exists { where id == ^customer_id }` would be quadratic if the block
scanned its receiver each time. `optimize` gives every block a `BlockPlan` and
applies `Rule`s (`fn(&BlockPlan, &RuleContext) -> Option<BlockPlan>`, a fixpoint
over `DEFAULT_RULES`), each proven unobservable — same rows, lifts and errors as
the scan:

- **Correlated equality → hash probe.** A top-level `&&` conjunct `local ==
  outer` (`local` an identifier/member chain on the block's row, `outer`
  reading nothing from it and raise-free) is answered from a `HashIndex` on the
  receiver built once per run (keys reproduce `==`: absent ≡ null, `-0` ≡ `0`,
  `NaN` matches nothing, arrays/objects structurally as this crate's `equals`
  is); the residual conjuncts run over the bucket in receiver order; several
  equalities intersect smallest first.
- **Invariant blocks run once** (nothing read from any enclosing row, no lifts).
- **`exists`/`none` stop at the first bucket row** that passes the residual.
- **`exists`/`none`/`count` with no residual** are answered from the bucket's
  size after the bound.

The sound rule: an equality is hoisted only when every conjunct to its left is
raise-free (no call, no `single`, no lift, no bound, no out-of-range binding)
and its outer side is; a `where` with a lift anywhere is never probed. Property
reads are treated as total (SEMANTICS §23); an `Err` from `DataContext::get`
while an index is built or a probe value evaluated falls back to the scan.

Unlike the reference, a `Value` has no identity, so the engine builds its own
index only over a receiver that is *statically* stable — it reads only the
root scope and bindings (`^customers` from a top-level block, a `${…}`
binding); such a receiver is also read once per run, with or without a
correlation. A per-row relation is scanned. `DataContext::index_for(collection,
path)` lets a context hand the engine a pre-built `Rc<dyn RowIndex>`
(`lookup` → positions); `IndexedCollection::context(extra_roots)` does so for
its fields. A `RowIndex` may also implement `lookup_rows` (the matching rows,
in receiver order): the engine then probes it **before** reading the
collection — for a stable receiver and for any receiver it is offered when
something is correlated — so a store-backed context (a lazy table marker, an
index on a column) answers with one indexed lookup and the table is never
materialized; one correlation is probed (the first whose outer side is a `^`
reference rather than a literal) and the other conjuncts, remaining equalities
included, stay residual in their original order. Such a marker is resolved by
`DataContext::materialize(value)` (default: identity) wherever the engine is
about to observe the value AS A VALUE — an operand, an argument, a projected
item, an `order by`/`distinct` key, a `where` scalar, a lift — and never in row
position (the source, a receiver, a `from`, a `follow` destination), where it
reaches `to_rows` / `index_for` as handed out; so the language never sees the
stand-in, and `$repo.docs == $repo.docs`, `"x" in $repo.docs`,
`entries($repo.docs)` behave as they do over the reference's lazy array. The
TypeScript package has the same optional `materialize` hook.
`InMemoryEngine::with_rules(&[])` is the naive engine;
`tests/spec.rs` proves optimized ≡ naive (result, or error stage and message)
over every spec fixture, and `tests/optimize.rs` covers the rules.

## The AST as a contract

```rust
use oqx::walk::{Node, VisitContext, Visitor};
use oqx::{parse_string, print, print_query, visit};

let q = parse_string("select name, n: jobs collect { employer } from people where jobs exists { where !end }")?;

// every consumer directive, with the clause it sits in and the scope depth it is evaluated at
struct Relations(Vec<(String, String, usize)>);
impl Visitor for Relations {
    fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
        if let Node::Op(op) = node {
            let clause = ctx.clause.map_or("", |c| c.as_str()).to_owned();
            self.0.push((print(Node::Expr(&op.receiver)).unwrap(), clause, ctx.depth));
        }
        true
    }
}
let mut rels = Relations(Vec::new());
visit(Node::Query(&q), &mut rels);
// [("jobs", "select", 1), ("jobs", "where", 1)]

print_query(&q)?; // the canonical source; `print` fails (stage `Print`) on a binding — use `print_template`
```

Spans are `[start, end)` in Unicode code points over the raw source (a
template's `raw_source`, where a binding occupies its `${n}` marker), the unit
every offset in a lex/parse error uses too. Nodes a tool builds (`build::*`)
carry `Span::EMPTY`; `strip_spans` normalizes a parsed tree for comparisons.

## Features

- `json` — `From`/`Into` between `oqx::Value` and `serde_json::Value`, plus the
  AST's `Serialize`/`Deserialize` in the exact JSON shape the reference produces
  (`kind`-tagged, camelCase, explicit nulls, operators as source words — proven
  equal by `spec/oqx/cases/ast.json`), `ast_to_json(&query)` (stamped with
  `"oqx": LANGUAGE_VERSION`) and `query_from_json`.
- `sqlite` — `adapters::sqlite::SqliteTable`, a `QueryPlanner` that pushes the
  flat query core (scan + translatable conjunctive predicates, `LIMIT` for
  unordered `first`/`single`) into SQL over a bundled SQLite via `rusqlite`,
  leaving the rest to the in-memory residual. Implies `json`.

## License

MIT
