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

## Ranges

A Ruby-style range tests membership in an interval. `lo..hi` includes both ends;
`lo...hi` (three dots) excludes the high end. So the eras from Jabir (800)
through Newton (1680), inclusive:

```console
$ omg query 'from docs where era in 800..1680'
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
d_wc1napn  texts/emerald-tablet.md
d_f7w5k26  texts/mutus-liber.md
```

Make the high end exclusive with `...` and Newton (exactly 1680) drops out:

```console
$ omg query 'from docs where era in 800...1680'
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_t5nvj1g  practitioners/paracelsus.md
d_wc1napn  texts/emerald-tablet.md
d_f7w5k26  texts/mutus-liber.md
```

Either end may be omitted for an open-ended range — `1600..` is "1600 and up",
`..300` is "up to and including 300":

```console
$ omg query 'from docs where era in 1600..'
d_rw4ygr0  practitioners/newton.md
d_f7w5k26  texts/mutus-liber.md
$ omg query 'from docs where era in ..300'
d_9px29y1  practitioners/maria-prophetissa.md
```

Ranges order by the same rule as `<`/`<=`, so they work over ISO-8601 date
strings too — `where published in "2026-01-01".."2026-03-31"` selects a quarter.

## A frontmatter value can be a range

The range can also live in the document. A frontmatter value written as a range
— `window: 2026-01-01..2026-01-31`, `stage_range: 1..4` — is stored as text;
wrap it in `range(...)` to read it as an interval and ask which document's range
**contains** a point. The two lab notes carry a monthly `window`:

```console
$ omg query 'from docs where "2026-01-15" in range(window)'
d_labjan1  lab/2026-01-notes.md
$ omg query 'from docs where "2026-02-10" in range(window)'
d_labfeb1  lab/2026-02-notes.md
```

It reads as "is this date inside the note's window". Numeric range values work
the same — magnum-opus records `stage_range: 1..4`, so stage 2 is inside it but
stage 5 is past the end:

```console
$ omg query 'from docs where 2 in range(stage_range)'
d_magnop1  processes/magnum-opus.md
$ omg query 'from docs where 5 in range(stage_range)'
```

`range(...)` is the explicit opt-in: a bare `window` is just its string, so a
value that only looks rangey (`version: "1..4"`) keeps string behavior until you
ask for a range.

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

## `$value` — the current item itself

A list-valued property can be a subquery receiver: `tags exists { … }` runs the
block once per **element**, and `$value` names that element. So this is the
element-wise spelling of `"tria-prima" in list(tags)`:

```console
$ omg query 'from docs where tags exists { where $value == "tria-prima" }'
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

In a projection the same idea filters a list in place — each substance's tags
minus the `substance` tag itself (`$value values` makes it a plain array; a
scalar-authored `tags: substance` is one element, so mercury's list empties):

```console
$ omg query 'from docs where type == "substance" select tags: tags collect { $value values where $value != "substance" }' --jsonl
{"id":"d_0vsapzt","path":"substances/mercury.md","tags":[]}
{"id":"d_1rren8z","path":"substances/philosophers-stone.md","tags":["goal","legendary"]}
{"id":"d_prj3j7a","path":"substances/prima-materia.md","tags":["theory"]}
{"id":"d_h73rhv8","path":"substances/salt.md","tags":["tria-prima"]}
{"id":"d_5zmf9f7","path":"substances/sulphur.md","tags":["tria-prima"]}
```

## `entries()` — a record as rows, with `$key`

`entries(frontmatter)` turns the whole authored frontmatter bag into a
collection of key/value entries (in key order); inside the block `$key` is the
key and `$value` the value. Salt's frontmatter as `{k, v}` rows — the list key
comes back as an array, exactly as a bare `tags` reads:

```console
$ omg query 'from docs where $path == "substances/salt.md" select fm: entries(frontmatter) collect { k: $key, v: $value }' --jsonl
{"id":"d_h73rhv8","path":"substances/salt.md","fm":[{"k":"element","v":"salt"},{"k":"layer","v":"canon"},{"k":"slug","v":"salt"},{"k":"tags","v":["substance","tria-prima"]},{"k":"tradition","v":"western"},{"k":"type","v":"substance"},{"k":"verified","v":true}]}
```

Keys are queryable too, so you can filter on a key you name at query time
(here it is the same set as `era > 1600`):

```console
$ omg query 'from docs where entries(frontmatter) exists { where $key == "era" && $value > 1600 }'
d_rw4ygr0  practitioners/newton.md
d_f7w5k26  texts/mutus-liber.md
```

`entries(inline)` does the same for the body's `key:: value` fields (empty for
documents that have none), and `entries(attrs)` works on a block or node's attrs
bag.

Next: **[targets.md](./targets.md)** — querying blocks and nodes, not just whole
documents.
