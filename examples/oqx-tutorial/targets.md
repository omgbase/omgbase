<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 2. Targets: docs, blocks, nodes

omgbase models a repository in three layers, and each is a query **target**:

- **`docs`** — whole documents (what [filtering.md](./filtering.md) queried).
- **`blocks`** — the structural pieces of a document: paragraphs, headings, list
  items, tables, code fences, blockquotes, tasks, …
- **`nodes`** — semantic projections extracted from blocks: tasks, links,
  wikilinks, headings-as-sections, inline `key:: value` fields.

You pick the target right after `from`.

## Blocks

Filter blocks by their `type`. The corpus's code fences live in the lab notes
and the process pages:

```console
$ omg query 'from blocks where type == "code_fence"'
b_3v5jvfy  lab/2026-01-notes.md
b_s7h330r  lab/2026-02-notes.md
b_sjsr2r8  processes/calcination.md
b_czj5j84  processes/coagulation.md
b_wj8swzf  processes/dissolution.md
```

Blockquotes — sources being quoted — sit on a different set of pages:

```console
$ omg query 'from blocks where type == "blockquote"'
b_cehq7cv  practitioners/maria-prophetissa.md
b_rayqtht  practitioners/paracelsus.md
b_3e22t5y  substances/prima-materia.md
b_1g0x8bk  texts/emerald-tablet.md
b_mhgthb4  texts/emerald-tablet.md
```

## Reaching the owning document with `doc.`

From a block or node you can filter on its **document's** fields through `doc.` —
so "task nodes on practitioner pages" is one expression:

```console
$ omg query 'from nodes where kind == "md:task" && !attrs.checked && doc.type == "practitioner"'
n_b6f7b0df318d  practitioners/jabir-ibn-hayyan.md
n_0c223e24f758  practitioners/newton.md
n_fa003dd8042f  practitioners/newton.md
n_cafa6b6cd406  practitioners/paracelsus.md
```

## Nodes

Nodes carry a `kind` — `md:task`, `md:link`, `md:wikilink`, `md:section`,
`md:inline_field` — plus kind-specific fields: a task's `attrs.checked`, a
section's or inline field's `name`, a link's or field's `value`.

Every heading becomes an `md:section` node named by its text. Three pages have
an "Open questions" section:

```console
$ omg query 'from nodes where kind == "md:section" && name == "Open questions"'
n_cb7296cac24a  processes/magnum-opus.md
n_db021d23b241  substances/philosophers-stone.md
n_3b1ccbd927ba  substances/prima-materia.md
```

Inline `key:: value` fields become `md:inline_field` nodes; only the lab notes
record an `operator::`:

```console
$ omg query 'from nodes where kind == "md:inline_field" && name == "operator"'
n_929fa29b9710  lab/2026-01-notes.md
n_6fbacec068c2  lab/2026-02-notes.md
```

## `--ids` — bare ids for piping

Every list can emit just its ids with `--ids`, ready to pipe into another
command. Here are the February note's open tasks, the input to a bulk
`omg done -` (see [editing-and-history.md](../editing-and-history.md)):

```console
$ omg query 'from blocks where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md"' --ids
b_46t8ere
b_dkgxmxr
```

Next: **[shaping-results.md](./shaping-results.md)** — projecting fields,
ordering, and limiting.
