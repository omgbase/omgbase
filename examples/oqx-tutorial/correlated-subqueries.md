<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 4. Correlated subqueries: exists, count, collect

The step up from flat filters: ask about the blocks or nodes **inside** each
document. A subquery like `nodes exists { … }` is *correlated* — evaluated once
per candidate document, over that document's own nodes.

## "documents that contain a matching node"

Which documents have an **open** (unchecked) task somewhere in them?

```console
$ omg query 'from docs where nodes exists { where kind == "md:task" && !attrs.checked }'
d_b089t54  lab/2026-01-notes.md
d_w18c2st  lab/2026-02-notes.md
d_nzb61j9  practitioners/jabir-ibn-hayyan.md
d_rw4ygr0  practitioners/newton.md
d_t5nvj1g  practitioners/paracelsus.md
d_zdac7ww  processes/calcination.md
d_jtnqxt2  processes/coagulation.md
d_91vsvhk  processes/dissolution.md
d_m67jwv8  processes/magnum-opus.md
d_f7w5k26  texts/mutus-liber.md
```

## It's per-document, not a global scan

Because the subquery is correlated, a document with no matching node simply
doesn't match. The corpus keeps actionable bench work in the lab notebooks, not
on the substance reference pages — so asking for substances with open tasks
returns nothing (`no hits`, still exit 0):

```console
$ omg query 'from docs where type == "substance" && nodes exists { where kind == "md:task" && !attrs.checked }'
  no hits
```

## Compose a document predicate with a node one

Both halves apply per document — "lab notes that still have open work":

```console
$ omg query 'from docs where type == "lab-note" && nodes exists { where kind == "md:task" && !attrs.checked }'
d_b089t54  lab/2026-01-notes.md
d_w18c2st  lab/2026-02-notes.md
```

(`count { … }` in filter position means the same as `exists` — non-empty — and
also lets you compare, e.g. `nodes count { where kind == "md:task" } >= 3`.)

## `none { }` — "no matching node" and "every"

`none` is the zero-cardinality test: true when the block yields no rows (the
same as `!… exists { … }`). Substances with no task at all — salt drops out,
because its supply list *is* a task list, even though every item is checked:

```console
$ omg query 'from docs where type == "substance" && nodes none { where kind == "md:task" }'
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
d_5zmf9f7  substances/sulphur.md
```

`none` over the *complement* is how you say "every": "every task is done" is
"no task is open", and now salt qualifies:

```console
$ omg query 'from docs where type == "substance" && nodes none { where kind == "md:task" && !attrs.checked }'
d_0vsapzt  substances/mercury.md
d_1rren8z  substances/philosophers-stone.md
d_prj3j7a  substances/prima-materia.md
d_h73rhv8  substances/salt.md
d_5zmf9f7  substances/sulphur.md
```

## `collect { }` — shape, don't just test

Where `exists`/`count` *test* a document's nodes, `collect` gathers them into the
result. This projects each lab note together with its open-task texts as a
nested list (`--jsonl` to see the structure):

```console
$ omg query 'from docs where type == "lab-note" select open: nodes collect { where kind == "md:task" && !attrs.checked select text: value }' --jsonl
{"id":"d_b089t54","path":"lab/2026-01-notes.md","open":[{"text":"Repeat the series with copper"},{"text":"Plot mass gain against heating time"},{"text":"Tabulate the metal sulphides by colour"}]}
{"id":"d_w18c2st","path":"lab/2026-02-notes.md","open":[{"text":"Assay cycle 1 and cycle 4 crops for iron"},{"text":"Write the plateau result up for the coagulation note"}]}
```

## Scoping to a section

`under_heading("…")` restricts blocks to a heading's section (case-insensitive
substring). The reference pages state open questions as prose bullets under an
"Open questions" heading:

```console
$ omg query 'from blocks where type == "list_item" && under_heading("Open questions")'
b_5wn6bqe  substances/philosophers-stone.md
b_k176dfc  substances/philosophers-stone.md
b_c1ks39r  substances/prima-materia.md
b_sjxw7ds  substances/prima-materia.md
```

The same reach via node structure: a block's enclosing section is a node, so
`section exists { where name == "Open questions" }` selects the identical items —
two routes to one section range:

```console
$ omg query 'from blocks where type == "list_item" && section exists { where name == "Open questions" }'
b_5wn6bqe  substances/philosophers-stone.md
b_k176dfc  substances/philosophers-stone.md
b_c1ks39r  substances/prima-materia.md
b_sjxw7ds  substances/prima-materia.md
```

Next: **[joins-and-lifts.md](./joins-and-lifts.md)** — correlating across the
whole repository.
