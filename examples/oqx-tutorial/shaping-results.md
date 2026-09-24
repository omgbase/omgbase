<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 3. Shaping results: select, order, limit

So far every query printed `<id>  <locator>`. This page projects specific
fields, sorts, and pages through large results.

## `select` — project fields

`select` names the fields you want on each hit. As soon as a query projects, the
human tier switches from `<id>  <locator>` lines to an aligned table: a dim
header row, then per hit the id, the path, and your selected fields as columns
in `select` order (here a frontmatter number and an inline field):

```console
$ omg query 'select era, known: known_for from docs where type == "practitioner" order by era asc'
id         path                                era   known
d_9px29y1  practitioners/maria-prophetissa.md  250   balneum mariae
d_nzb61j9  practitioners/jabir-ibn-hayyan.md   800   mercury-sulphur theory
d_t5nvj1g  practitioners/paracelsus.md         1530  tria prima
d_rw4ygr0  practitioners/newton.md             1680  unpublished alchemical corpus
```

`known: known_for` renames the projected column; a bare `era` keeps its name.
Select `$path` yourself and it takes the path column's place (the same path is
never printed twice):

```console
$ omg query 'select $path, era from docs where type == "practitioner" order by era asc'
id         $path                               era
d_9px29y1  practitioners/maria-prophetissa.md  250
d_nzb61j9  practitioners/jabir-ibn-hayyan.md   800
d_t5nvj1g  practitioners/paracelsus.md         1530
d_rw4ygr0  practitioners/newton.md             1680
```

Cells hold strings and numbers verbatim; a nested `collect` (a list or record)
renders as compact JSON, clipped at 60 characters with `…`. For the full values
ask for machine output: `--jsonl` prints one JSON object per hit — the id and
path always come along, then your selected fields:

```console
$ omg query 'select era, known: known_for from docs where type == "practitioner" order by era asc' --jsonl
{"id":"d_9px29y1","path":"practitioners/maria-prophetissa.md","era":250,"known":"balneum mariae"}
{"id":"d_nzb61j9","path":"practitioners/jabir-ibn-hayyan.md","era":800,"known":"mercury-sulphur theory"}
{"id":"d_t5nvj1g","path":"practitioners/paracelsus.md","era":1530,"known":"tria prima"}
{"id":"d_rw4ygr0","path":"practitioners/newton.md","era":1680,"known":"unpublished alchemical corpus"}
```

`known: known_for` renames the projected column; a bare `era` keeps its name.
The projection comes *first*: OQX clauses have one fixed order — `select`, `from`,
`where`, `follow`, `order by`, `limit`, `offset` — and `select` is the only keyword
you may drop (`era, known: known_for from docs …` means the same). A `where` may
refer to a `select` alias (`select $path, old: era < 1000 from docs where old`).

## `order by`

Sort with `order by <expr> [asc|desc]`. The `era` sort is numeric — 250 before
1680, not string-sorted:

```console
$ omg query 'from docs where type == "practitioner" order by era asc'
d_9px29y1  practitioners/maria-prophetissa.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_t5nvj1g  practitioners/paracelsus.md
d_rw4ygr0  practitioners/newton.md
$ omg query 'from docs where type == "practitioner" order by era desc'
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_9px29y1  practitioners/maria-prophetissa.md
```

## `-n` and paging with `--cursor`

`-n` caps the number of hits. Truncation is never silent: when there's more, the
CLI says so on stderr and hands you an opaque `--cursor` token for the next page
(exit status stays 0 — truncation isn't an error). Continue by passing it back:

```console
$ omg query 'from docs where type == "substance"' -n 3
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
… truncated; continue with --cursor WyJzdWJzdGFuY2VzL3ByaW1hLW1hdGVyaWEubWQiLCJkX3ByajNqN2EiXQ
$ omg query 'from docs where type == "substance"' -n 3 --cursor WyJzdWJzdGFuY2VzL3ByaW1hLW1hdGVyaWEubWQiLCJkX3ByajNqN2EiXQ
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

## `values` — bare values instead of hits

When you want a single column and nothing else, follow a one-item `select` with
`values`. The result is the bare projected value per row (no `{id, path}`
record), so the human tier prints one value per line — a list of paths, or a
list of numbers:

```console
$ omg query 'select $path values from docs where type == "practitioner" order by era asc'
practitioners/maria-prophetissa.md
practitioners/jabir-ibn-hayyan.md
practitioners/paracelsus.md
practitioners/newton.md
$ omg query 'select era values from docs where type == "practitioner" order by era asc'
250
800
1530
1680
```

It composes with `distinct` — the corpus's document types, deduped, as plain
strings:

```console
$ omg query 'select distinct type values from docs'
hub
lab-note
practitioner
process
substance
text
```

## `limit` / `offset` — bound the set in the query

`-n` is the *page* size; `limit N` / `offset N` inside the query define the
result **set** itself (applied after `where`, `order by`, and `distinct`). The
two most recent practitioners, then the two after skipping the most recent:

```console
$ omg query 'from docs where type == "practitioner" order by era desc limit 2'
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
$ omg query 'from docs where type == "practitioner" order by era desc limit 2 offset 1'
d_t5nvj1g  practitioners/paracelsus.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
```

The page walks *within* the bound: `limit 4` over the five substances, paged
three at a time, truncates once and the second page holds the single remaining
row — the fifth substance never appears.

```console
$ omg query 'from docs where type == "substance" limit 4' -n 3
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
… truncated; continue with --cursor WyJzdWJzdGFuY2VzL3ByaW1hLW1hdGVyaWEubWQiLCJkX3ByajNqN2EiXQ
$ omg query 'from docs where type == "substance" limit 4' -n 3 --cursor WyJzdWJzdGFuY2VzL3ByaW1hLW1hdGVyaWEubWQiLCJkX3ByajNqN2EiXQ
d_h73rhv8  substances/salt.md
```

Next: **[correlated-subqueries.md](./correlated-subqueries.md)** — asking about
the blocks and nodes *inside* a document.
