<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 7. Graph traversal: `follow`

`follow <relation>` walks a relation **recursively**, so a query closed over its
row type expands along that relation. omgbase exposes a few:

- `doc.out` / `doc.in` — the citation graph (Markdown links and `[[wikilinks]]`
  become `references` edges).
- `section.children` / `block.children` — document structure (the heading
  outline, a list's items).

Each reached row is decorated with recursion metadata you can select or filter
on: `$depth` (hops from the seed, seed = 1), `$stop` (why the walk stopped here),
and `$ordinal` (a deterministic 1..N rank over the walk). `distinct` collapses
the walk to the set of reached rows.

## The citation closure (`doc.out`)

Everything `index.md` reaches by following links, transitively. We print just
the paths, sorted, for a stable set:

```console
$ omg query 'from docs where $path == "index.md" follow distinct doc.out' | awk '{print $2}' | sort
index.md
lab/2026-02-notes.md
practitioners/jabir-ibn-hayyan.md
practitioners/maria-prophetissa.md
practitioners/newton.md
practitioners/paracelsus.md
processes/calcination.md
processes/coagulation.md
processes/dissolution.md
processes/magnum-opus.md
substances/philosophers-stone.md
substances/prima-materia.md
texts/emerald-tablet.md
texts/mutus-liber.md
```

## Backlinks (`doc.in`)

`doc.in` walks the edges backwards. Bound the walk to one hop (`depth 2`) and
keep only that hop (`$depth == 2`) to get the documents that *directly* cite the
magnum opus:

```console
$ omg query 'from docs where $path == "processes/magnum-opus.md" && $depth == 2 follow doc.in { depth 2 }' | awk '{print $2}' | sort
index.md
practitioners/maria-prophetissa.md
practitioners/newton.md
substances/philosophers-stone.md
substances/prima-materia.md
```

## Cutting the walk with `frontier`, and reading `$stop`

`frontier <predicate>` reports matching rows but doesn't expand *through* them —
useful to treat a class of documents as the edge of the walk. `$stop` records
why each row ended: `interior` (expanded), `leaf` (no further edges), `frontier`
(cut here), or `cycle` (a revisit, admitted once). Exploring `index.md`'s
citations but treating practitioner pages as the frontier:

```console
$ omg query 'from docs where $path == "index.md" select stop: $stop order by $path asc follow distinct doc.out { frontier type == "practitioner" }' --jsonl
{"id":"d_sz1e8z0","path":"index.md","stop":"interior"}
{"id":"d_w18c2st","path":"lab/2026-02-notes.md","stop":"interior"}
{"id":"d_nzb61j9","path":"practitioners/jabir-ibn-hayyan.md","stop":"frontier"}
{"id":"d_9px29y1","path":"practitioners/maria-prophetissa.md","stop":"frontier"}
{"id":"d_rw4ygr0","path":"practitioners/newton.md","stop":"frontier"}
{"id":"d_t5nvj1g","path":"practitioners/paracelsus.md","stop":"frontier"}
{"id":"d_zdac7ww","path":"processes/calcination.md","stop":"leaf"}
{"id":"d_jtnqxt2","path":"processes/coagulation.md","stop":"interior"}
{"id":"d_91vsvhk","path":"processes/dissolution.md","stop":"leaf"}
{"id":"d_m67jwv8","path":"processes/magnum-opus.md","stop":"interior"}
{"id":"d_1rren8z","path":"substances/philosophers-stone.md","stop":"interior"}
{"id":"d_prj3j7a","path":"substances/prima-materia.md","stop":"interior"}
{"id":"d_wc1napn","path":"texts/emerald-tablet.md","stop":"interior"}
{"id":"d_f7w5k26","path":"texts/mutus-liber.md","stop":"interior"}
```

## Structure: the heading outline (`section.children`)

Follow works over structure too. From a top heading, `section.children` walks the
outline one level per hop — the magnum opus's section and its four subsections
(`$depth` 1 then 2):

```console
$ omg query 'from nodes where kind == "md:section" && name == "The magnum opus" select name, depth: $depth, stop: $stop order by $depth asc, name asc follow section.children' --jsonl
{"id":"n_7a874b74b236","path":"processes/magnum-opus.md","name":"The magnum opus","depth":1,"stop":"interior"}
{"id":"n_cb7296cac24a","path":"processes/magnum-opus.md","name":"Open questions","depth":2,"stop":"leaf"}
{"id":"n_e7364dec9d89","path":"processes/magnum-opus.md","name":"Operations","depth":2,"stop":"leaf"}
{"id":"n_97dc3b054223","path":"processes/magnum-opus.md","name":"The four stages","depth":2,"stop":"leaf"}
{"id":"n_fcb087e2dfbc","path":"processes/magnum-opus.md","name":"Why colour","depth":2,"stop":"leaf"}
```

Other knobs, briefly: `order by $ordinal` yields the walk's natural 1..N order
(seed first); `by <expr>` re-keys node identity so the walk stops when the
expression repeats (e.g. `by type` — stop when a document *type* recurs); and
every walk is capped at depth 8. `block.children` walks a list down to its items
the same way.

---

That's the language end to end — filtering, targets, shaping, correlated
subqueries, joins & lifts, aggregates, full-text, and traversal. Back to the
[tutorial index](./README.md).
