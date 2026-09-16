<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 1. Filtering with `from` / `where`

OQX is omgbase's one query language. Every query names a **target** to draw rows
from and, usually, a **filter** that keeps some of them:

```
from <target> where <filter>
```

`omg query` runs a query (`omg q` is the short alias). In human output each hit
prints as `<id>  <locator>` — a stable id paired with a readable locator. (Ids
are minted per ingest, so yours will differ from the ones shown.)

> Every block on this page is run for real against the alchemy corpus — eighteen
> interlinked notes on substances, processes, practitioners, texts, and lab
> work. See [getting-started.md](../getting-started.md) for what that corpus is.

## Filter on frontmatter

A document's YAML frontmatter keys (`type:`, `layer:`, `era:`, `tags:` …) are
just fields you filter on. The five substances:

```console
$ omg query 'from docs where type == "substance"'
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

Hits come back in path order unless you ask for another (see
[shaping-results.md](./shaping-results.md)).

## Numbers compare as numbers

The practitioners carry an `era:` year. Comparisons are numeric, not textual —
so `> 1600` finds the one modern practitioner rather than mis-sorting by digits:

```console
$ omg query 'from docs where type == "practitioner" && era > 1600'
d_rw4ygr0  practitioners/newton.md
$ omg query 'from docs where era < 1000'
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_9px29y1  practitioners/maria-prophetissa.md
d_wc1napn  texts/emerald-tablet.md
```

## Booleans, and absence

A bare field name is a boolean test; `!` negates it. A **missing** key counts as
false, so `!verified` returns both the documents that set `verified: false` and
those that never mention it:

```console
$ omg query 'from docs where !verified'
d_m67jwv8  processes/magnum-opus.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
d_f7w5k26  texts/mutus-liber.md
```

## Combine terms

`&&`, `||`, and `!` compose the usual way:

```console
$ omg query 'from docs where type == "practitioner" && tradition == "western" && era > 1600'
d_rw4ygr0  practitioners/newton.md
```

## Match on the path

`$`-prefixed names are **intrinsics** — properties of the row itself rather than
its frontmatter. `$path` is the document's path, with the usual string methods:

```console
$ omg query 'from docs where $path.startsWith("practitioners/")'
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_9px29y1  practitioners/maria-prophetissa.md
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
```

## `list()` — one test for scalar-or-list fields

`tags:` is sometimes a single value and sometimes a list. `list(field)` treats
both uniformly, so a membership test works regardless of how a document wrote it:

```console
$ omg query 'from docs where "goal" in list(tags)'
d_1rren8z  substances/philosophers-stone.md
```

`list()` also reaches **inline fields** — the `key:: value` lines in a document's
body. Only calcination declares `element:: fire`:

```console
$ omg query 'from docs where "fire" in list(element)'
d_zdac7ww  processes/calcination.md
```

Next: **[targets.md](./targets.md)** — querying blocks and nodes, not just whole
documents.
