<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 5. Joins & lifts: correlating across the repository

[Correlated subqueries](./correlated-subqueries.md) reached *inside* a document.
This page reaches *across* documents. Two pieces do it:

- **`^name`** — inside a nested query, read a name bound one scope outward. (The
  outer query must bind that name, e.g. with `select` or a lift.)
- **`^docs` / `^nodes`** — an explicit scan of the *whole* repository, read
  from the root row one scope out (one caret per enclosing block, or the
  absolute `0^docs`), as opposed to the current row's own blocks/nodes.

Together they express dependent, semi-, anti-, and self-joins — no `JOIN`
keyword.

## Lifts: filter and capture at once

A lift `^name: value where …` inside a `collect` does double duty — it filters
the row to those that *have* a match, and captures the matched values into
`name` for the outer `select`. Each lab note with its open-task texts, in one
expression:

```console
$ omg query 'select p: $path, open from docs where type == "lab-note" and nodes collect { ^open: value where kind == "md:task" and not attrs.checked }' --jsonl
{"id":"d_b089t54","path":"/lab/2026-01-notes.md","p":"/lab/2026-01-notes.md","open":["Repeat the series with copper","Plot mass gain against heating time","Tabulate the metal sulphides by colour"]}
{"id":"d_w18c2st","path":"/lab/2026-02-notes.md","p":"/lab/2026-02-notes.md","open":["Assay cycle 1 and cycle 4 crops for iron","Write the plateau result up for the coagulation note"]}
```

Don't select the lifted name and the lift is just a filter — "processes with open
work":

```console
$ omg query 'from docs where type == "process" and nodes collect { ^todo: value where kind == "md:task" and not attrs.checked }'
d_zdac7ww  /processes/calcination.md
d_jtnqxt2  /processes/coagulation.md
d_91vsvhk  /processes/dissolution.md
d_m67jwv8  /processes/magnum-opus.md
```

## Dependent join: resolve links to documents

A wikilink's value is a slug, and substances/processes carry a `slug`. Lift each
document's wikilink targets into `refs`, then join the whole repo to the
documents whose slug is one of them — link extraction *and* resolution, i.e. a
citation graph. `index.md` links to the three tria-prima substances:

```console
$ omg query 'select cites: ^docs collect { select t: $path where slug in ^refs } from docs where $path == "/index.md" and nodes collect { ^refs: value where kind == "md:wikilink" }' --jsonl
{"id":"d_sz1e8z0","path":"/index.md","cites":[{"t":"/substances/mercury.md"},{"t":"/substances/salt.md"},{"t":"/substances/sulphur.md"}]}
```

## Semi-join and anti-join

Does *any* wikilink in the repo name this substance's slug? `^nodes exists`
is the global scan; `^slug` ties it to the current row (bound by the trailing
`select slug`). The three tria-prima substances are cited by name — and because
the query projects, the human tier shows the projected `slug` as a column
beside the id and path:

```console
$ omg query 'select slug from docs where type == "substance" and ^nodes exists { where kind == "md:wikilink" and value == ^slug }'
id         path                    slug
d_0vsapzt  /substances/mercury.md  mercury
d_h73rhv8  /substances/salt.md     salt
d_5zmf9f7  /substances/sulphur.md  sulphur
```

Negate the `exists` for the anti-join — substances no wikilink points to (the two
abstractions are named only in prose):

```console
$ omg query 'select slug from docs where type == "substance" and not ^nodes exists { where kind == "md:wikilink" and value == ^slug }'
id         path                               slug
d_1rren8z  /substances/philosophers-stone.md  philosophers-stone
d_prj3j7a  /substances/prima-materia.md       prima-materia
```

## Self-join

Two correlations at once — `^tradition` matches the tradition, `^$path` excludes
the row itself (`^` reads a field/intrinsic of the outer row) — pairs each
practitioner with their tradition-mates. Only the two Western practitioners have
any:

```console
$ omg query 'select me: $path, tradition, peers: ^docs collect { select p: $path where type == "practitioner" and tradition == ^tradition and $path != ^$path } from docs where type == "practitioner"' --jsonl
{"id":"d_nzb61j9","path":"/practitioners/jabir-ibn-hayyan.md","me":"/practitioners/jabir-ibn-hayyan.md","tradition":"islamic","peers":[]}
{"id":"d_9px29y1","path":"/practitioners/maria-prophetissa.md","me":"/practitioners/maria-prophetissa.md","tradition":"alexandrian","peers":[]}
{"id":"d_rw4ygr0","path":"/practitioners/newton.md","me":"/practitioners/newton.md","tradition":"western","peers":[{"p":"/practitioners/paracelsus.md"}]}
{"id":"d_t5nvj1g","path":"/practitioners/paracelsus.md","me":"/practitioners/paracelsus.md","tradition":"western","peers":[{"p":"/practitioners/newton.md"}]}
```

## 1:1 lookup with `single`

When a correlation is unique, `single { … }` returns one record (not an array)
and checks the cardinality. Each lab note names a `subject:` process slug; slugs
are unique, so the lookup is 1:1:

```console
$ omg query 'select subject, process: ^docs single { select p: $path, layer where slug == ^subject } from docs where type == "lab-note"' --jsonl
{"id":"d_b089t54","path":"/lab/2026-01-notes.md","subject":"calcination","process":{"p":"/processes/calcination.md","layer":"canon"}}
{"id":"d_w18c2st","path":"/lab/2026-02-notes.md","subject":"coagulation","process":{"p":"/processes/coagulation.md","layer":"working"}}
```

## The repository is the root row

Where does `^docs` come from? OQX scopes are rows, and the **root** scope's row
is the repository itself: an object whose entries are the four collections
(`docs`, `blocks`, `nodes`, `edges`) and whose `$id` is the repository id. A
top-level row sits one scope inside it, so `^docs` from a row is the root's
documents, `^$id` the repository id, and `^$it` the root object:

```console
$ omg query 'select n: size(^docs), repo: ^$id from docs limit 1' --jsonl
{"id":"d_sz1e8z0","path":"/index.md","n":20,"repo":"rp_7k2m9xq"}
$ omg query 'select collections: entries(^$it) collect { $key values } from docs limit 1' --jsonl
{"id":"d_sz1e8z0","path":"/index.md","collections":["docs","blocks","nodes","edges"]}
```

Carets count scopes — from a block's rows the root is two out (`^^docs`). The
**absolute** form `0^docs` names scope 0 (the root) from any depth and saves the
counting:

```console
$ omg query 'select $path, n: nodes first { select c: size(0^docs) values where kind == "md:section" } from docs where $path == "/index.md"' --jsonl
{"id":"d_sz1e8z0","path":"/index.md","$path":"/index.md","n":20}
```

At the top level the bare name *is* the scan (`from docs`, `docs count { … }`),
and a bare target name **inside** a block is an error rather than a silent empty
read — the current row has no property called `docs`:

```console
$ omg query 'from docs where docs exists { }'
error[filter_invalid]: `docs` inside a block reads a property of the current row, which has none — did you mean `^docs` (the repository's documents)?
  {
    "reason": "`docs` inside a block reads a property of the current row, which has none — did you mean `^docs` (the repository's documents)?",
    "hint": "OQX"
  }
```

(`nodes` and `blocks` on a *document* row are that document's own relations, as
on the previous page — `^nodes` is the whole repository's.)

Next: **[aggregates.md](./aggregates.md)** — folding a query to a number or a
single row, and full-text search.
