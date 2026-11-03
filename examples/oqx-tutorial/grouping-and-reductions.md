<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 7. Grouping and reductions

`group by <key>, …` turns the rows a query yields into **one row per distinct
key**. Reading that group back out is what this page covers — and, since
0.30, the one postfix operator (`?`) that lets a single expression read
correctly whichever scope it lands in.

## A census in one query

Without a `select`, a grouped query projects its keys plus a `count`. A
grouped row carries no `_id`/`_path` — it is not a store row — so there is no
envelope column either:

```console
$ omg query 'docs { group by layer }'
layer    count
canon    13
working  6
draft    1
```

Name the group's rows yourself with **`$rows`** — the group's rows, a value
and a receiver — and `count($rows)` is the same count spelled out. `$rows`
is never bare `rows`: that would collide with a host's own `rows` field, so
OQX gives it the same `$`-sigil every other engine-injected value has
(`$it`, `$key`):

```console
$ omg query 'docs { select layer, n: count($rows) group by layer order by count($rows) desc }'
layer    n
canon    13
working  6
draft    1
```

## A non-key name is its per-row list

Project any other field and you get the **list of that field's value across
the group's rows**, one element per row — not an error, and not an arbitrary
row's value. `element` is a property only processes and substances carry;
grouping by `type` shows every other type's rows all lacking one:

```console
$ omg query 'docs { select type, element group by type order by type }'
type          element
hub           [null]
lab-note      [null,null]
milestone     [null,null]
practitioner  [null,null,null,null]
process       ["fire","earth","water",null]
substance     ["mercury",null,null,"salt","sulphur"]
text          [null,null]
```

## `x?` — the present elements, at whichever scope

That raw per-row list is rarely what you want to read; usually you want
**what's actually there**. `x?` (0.30) is the present elements of an array,
in order — **absent when none survive**, never `[]`. Over anything that
isn't an array (a scalar, an object, absent itself) it's simply unchanged —
which is the point: `element?` means the right thing whether you're reading
a single document's own `element` or a group's per-row list of them.

```console
$ omg query 'docs { select type, element? group by type order by type }'
type          element
hub
lab-note
milestone
practitioner
process       ["fire","earth","water"]
substance     ["mercury","salt","sulphur"]
text
```

Every type but `process` and `substance` now reads **absent** — there's
nothing to show, not an empty list — which means `has()` and bare truthiness
finally agree on "did anything survive":

```console
$ omg query 'docs { select type group by type having element? order by type }'
type
process
substance
```

`having element?` reads "some document in this group has one," with no
bespoke grammar for that question. It works because `[]` is falsy (0.30,
same release): through 0.29 an empty array was truthy, so an all-absent
group's per-row list — never literally `[]`, but `element?` on it would have
been — would have survived the filter anyway.

## Reductions don't need `?` — they already skip absent

`count`, `sum`, `collect`, and the rest already see only the **present**
values of whatever they're handed, so `?` changes nothing for them:

```console
$ omg query 'docs { select type, a: count(element), b: count(element?) group by type order by type }'
type          a  b
hub           0  0
lab-note      0  0
milestone     0  0
practitioner  0  0
process       3  3
substance     3  3
text          0  0
```

`?` earns its keep for the cases reductions don't cover: reading the actual
filtered value (not a count of it), and `having`/`where`-shaped presence
tests with no number in sight.

## `having` and `$rows` as a receiver together

Open tasks per document, counted with `$rows` opened as a receiver (`$rows
count { … }` is an ordinary consumer directive, the group's rows as its
source) and filtered down to documents that have any task at all:

```console
$ omg query 'blocks { select _path, open: $rows count { where not checked } where _type == "task" group by _path having count($rows) > 0 order by _path }'
_path                               open
/lab/2026-01-notes.md               3
/lab/2026-02-notes.md               2
/practitioners/jabir-ibn-hayyan.md  1
/practitioners/newton.md            2
/practitioners/paracelsus.md        1
/processes/calcination.md           2
/processes/coagulation.md           1
/processes/dissolution.md           1
/processes/magnum-opus.md           2
/substances/salt.md                 0
/texts/mutus-liber.md               3
```

`having count($rows) > 0` keeps documents with at least one task row at all
— `/substances/salt.md` qualifies and still shows `open: 0`: it has tasks,
just none left open. `$rows count { where not checked }` is a second,
independent reduction over the same group's rows, counting only the ones
that are.

Next: **[graph-traversal.md](./graph-traversal.md)** — walking the link and
structure graphs with `follow`.
