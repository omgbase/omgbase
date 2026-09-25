<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 6. Aggregates & full-text

## Fold a query to one value

A **top-level** consumer — `$repo.<target> <op> { … }` — reduces the whole
matching set instead of listing rows. `count` yields a number:

```console
$ omg query '$repo.docs count { }'
18
$ omg query '$repo.docs count { where type == "substance" }'
5
```

`exists` yields a boolean:

```console
$ omg query '$repo.docs exists { where layer == "draft" }'
true
$ omg query '$repo.docs exists { where layer == "legendary-only" }'
false
```

`first` returns zero-or-one row (here the first in path order):

```console
$ omg query '$repo.docs first { }'
d_sz1e8z0  index.md
```

`single` returns exactly one — and fails loudly if the filter matches more than
one, so it doubles as an assertion. Exactly one document is a draft:

```console
$ omg query '$repo.docs single { where layer == "draft" }'
d_f7w5k26  texts/mutus-liber.md
```

Point it at the canon documents and it refuses to pick — and tells you exactly
how many matched:

```console
$ omg query '$repo.docs single { where layer == "canon" }'
error[error]: single { … } matched 13 rows; use first { … } for zero-or-one
```

## Full-text with `text()`

`text("…")` is a full-text match over a document's content (stemmed). Everything
that mentions mercury:

```console
$ omg query 'from docs where text("mercury")'
d_sz1e8z0  index.md
d_b089t54  lab/2026-01-notes.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

It composes with ordinary predicates — full-text prunes, the scalar narrows.
Adding `layer == "canon"` drops the working-layer lab note and Newton:

```console
$ omg query 'from docs where text("mercury") && layer == "canon"'
d_sz1e8z0  index.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_t5nvj1g  practitioners/paracelsus.md
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

And it works **inside** a correlated subquery — "documents with a task node whose
text mentions recrystallization" (a query the flat search surface can't express):

```console
$ omg query 'from docs where nodes exists { where kind == "md:task" && text("recrystallization") }'
d_w18c2st  lab/2026-02-notes.md
d_jtnqxt2  processes/coagulation.md
```

Next: **[graph-traversal.md](./graph-traversal.md)** — walking the link and
structure graphs with `follow`.
