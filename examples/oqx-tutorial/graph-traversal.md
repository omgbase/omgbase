<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 7. Graph traversal: `follow`

`follow <relation>` walks a relation **recursively**, so a query closed over its
row type expands along that relation. omgbase exposes a few:

- `_out_links collect { from _dst }` / `_in_links collect { from _doc }` — the
  citation graph (Markdown links and `[[wikilinks]]` become `references`
  edges): a *destination block* that walks a document's link rows to the
  documents at their other end — `_dst` is a link's destination document (absent
  for an external or dangling link, which then contributes nothing), `_doc` its
  source. There is no `out`/`in` relation.
- `_children` — document structure: on a section node the heading outline, on a
  block a list's items.

Each reached row is decorated with recursion metadata you can select or filter
on: `$depth` (hops from the seed, seed = 1), `$stop` (why the walk stopped here),
and `$ordinal` (a deterministic 1..N rank over the walk). `distinct` collapses
the walk to the set of reached rows.

## The citation closure (`_out_links collect { from _dst }`)

Everything `index.md` reaches by following links, transitively. We print just
the paths, sorted, for a stable set:

```console
$ omg query 'from docs where _path == "/index.md" follow distinct _out_links collect { from _dst }' | awk '{print $2}' | sort
/index.md
/lab/2026-02-notes.md
/practitioners/jabir-ibn-hayyan.md
/practitioners/maria-prophetissa.md
/practitioners/newton.md
/practitioners/paracelsus.md
/processes/calcination.md
/processes/coagulation.md
/processes/dissolution.md
/processes/magnum-opus.md
/substances/philosophers-stone.md
/substances/prima-materia.md
/texts/emerald-tablet.md
/texts/mutus-liber.md
```

## Backlinks (`_in_links collect { from _doc }`)

`_in_links collect { from _doc }` walks the edges backwards — the inbound link
rows to their source documents. The walk's knobs are clauses of that destination
block, written after its `from`/`where`. Bound the walk to one hop (`depth 2`)
and keep only that hop (`$depth == 2`) to get the documents that *directly* cite
the magnum opus:

```console
$ omg query 'from docs where _path == "/processes/magnum-opus.md" and $depth == 2 follow _in_links collect { from _doc depth 2 }' | awk '{print $2}' | sort
/index.md
/practitioners/maria-prophetissa.md
/practitioners/newton.md
/substances/philosophers-stone.md
/substances/prima-materia.md
```

## Cutting the walk with `frontier`, and reading `$stop`

`frontier <predicate>` reports matching rows but doesn't expand *through* them —
useful to treat a class of documents as the edge of the walk. `$stop` records
why each row ended: `interior` (expanded), `leaf` (no further edges), `frontier`
(cut here), or `cycle` (a revisit, admitted once). Exploring `index.md`'s
citations but treating practitioner pages as the frontier:

```console
$ omg query 'select stop: $stop from docs where _path == "/index.md" follow distinct _out_links collect { from _dst frontier type == "practitioner" } order by _path asc' --jsonl
{"_id":"d_sz1e8z0","_path":"/index.md","stop":"interior"}
{"_id":"d_w18c2st","_path":"/lab/2026-02-notes.md","stop":"interior"}
{"_id":"d_nzb61j9","_path":"/practitioners/jabir-ibn-hayyan.md","stop":"frontier"}
{"_id":"d_9px29y1","_path":"/practitioners/maria-prophetissa.md","stop":"frontier"}
{"_id":"d_rw4ygr0","_path":"/practitioners/newton.md","stop":"frontier"}
{"_id":"d_t5nvj1g","_path":"/practitioners/paracelsus.md","stop":"frontier"}
{"_id":"d_zdac7ww","_path":"/processes/calcination.md","stop":"leaf"}
{"_id":"d_jtnqxt2","_path":"/processes/coagulation.md","stop":"interior"}
{"_id":"d_91vsvhk","_path":"/processes/dissolution.md","stop":"leaf"}
{"_id":"d_m67jwv8","_path":"/processes/magnum-opus.md","stop":"interior"}
{"_id":"d_1rren8z","_path":"/substances/philosophers-stone.md","stop":"interior"}
{"_id":"d_prj3j7a","_path":"/substances/prima-materia.md","stop":"interior"}
{"_id":"d_wc1napn","_path":"/texts/emerald-tablet.md","stop":"interior"}
{"_id":"d_f7w5k26","_path":"/texts/mutus-liber.md","stop":"interior"}
```

The body that carries the `follow` may write `frontier` too — after its `where`,
before `follow` — and there it applies to the **seeds**: a seed that matches stays
in the result with `$stop == "frontier"` but is not expanded, while each
destination block's `frontier` keeps governing the rows it reaches. Walking the
citations of every process but refusing to expand the unverified one:

```console
$ omg query 'select stop: $stop, verified from docs where type == "process" frontier !verified follow distinct _out_links collect { from _dst depth 2 } order by _path asc' --jsonl
{"_id":"d_e9q7sfr","_path":"/lab/2026-02-notes.md","stop":"depth","verified":true}
{"_id":"d_r4afgjj","_path":"/processes/calcination.md","stop":"leaf","verified":true}
{"_id":"d_zkbth9e","_path":"/processes/coagulation.md","stop":"interior","verified":true}
{"_id":"d_jrbnrez","_path":"/processes/dissolution.md","stop":"leaf","verified":true}
{"_id":"d_1z06pq9","_path":"/processes/magnum-opus.md","stop":"frontier","verified":false}
{"_id":"d_pjmerqy","_path":"/substances/philosophers-stone.md","stop":"depth","verified":false}
```

`magnum-opus` (`verified: false`) is a seed, so the body's `frontier` cuts it;
`philosophers-stone` is also unverified but was *reached* (through coagulation),
so the body's predicate does not apply to it — only the destination block's would.

## Structure: the heading outline (`_children`)

Follow works over structure too. From a top heading, `_children` walks the
outline one level per hop — the magnum opus's section and its four subsections
(`$depth` 1 then 2):

```console
$ omg query 'select _name, depth: $depth, stop: $stop from nodes where _kind == "md:section" and _name == "The magnum opus" follow _children order by $depth asc, _name asc' --jsonl
{"_id":"n_7a874b74b236","_path":"/processes/magnum-opus.md","_name":"The magnum opus","depth":1,"stop":"interior"}
{"_id":"n_cb7296cac24a","_path":"/processes/magnum-opus.md","_name":"Open questions","depth":2,"stop":"leaf"}
{"_id":"n_e7364dec9d89","_path":"/processes/magnum-opus.md","_name":"Operations","depth":2,"stop":"leaf"}
{"_id":"n_97dc3b054223","_path":"/processes/magnum-opus.md","_name":"The four stages","depth":2,"stop":"leaf"}
{"_id":"n_fcb087e2dfbc","_path":"/processes/magnum-opus.md","_name":"Why colour","depth":2,"stop":"leaf"}
```

Other knobs, briefly: `order by $ordinal` yields the walk's natural 1..N order
(seed first); a destination block may project `$key: <expr>` to re-key the
identity that `distinct` and cycle detection compare (`follow distinct
_out_links collect { $key: type from _dst }` keeps one document per *type*);
and every walk is capped at depth 8. On a block, `_children` walks a list down
to its items the same way.

Next: **[sugar.md](./sugar.md)** — the shorthand forms (brackets, `!`,
where-first blocks, `is`) and `refs()` for the document references a frontmatter
key holds.
