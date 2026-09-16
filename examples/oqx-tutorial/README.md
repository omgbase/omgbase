# OQX tutorial

A guided tour of **OQX**, omgbase's query language, over the alchemy corpus.
Every query on every page is run for real against that corpus and its output
verified (these pages are recital sessions), so nothing here can drift from how
the CLI actually behaves.

Read in order:

1. **[filtering.md](./filtering.md)** — `from` / `where`, and the CEL filter
   surface: frontmatter, numbers, booleans, `$path`, `list()`.
2. **[targets.md](./targets.md)** — the three targets `docs` / `blocks` /
   `nodes`, reaching the owning document with `doc.`, and `--ids`.
3. **[shaping-results.md](./shaping-results.md)** — `select`, `order by`, and
   paging with `-n` / `--cursor`.
4. **[correlated-subqueries.md](./correlated-subqueries.md)** — `exists`,
   `count`, and `collect` over a document's own blocks and nodes.
5. **[joins-and-lifts.md](./joins-and-lifts.md)** — `^name` correlation and
   `repo.*` scans: lifts, dependent/semi/anti/self joins, `single`.
6. **[aggregates.md](./aggregates.md)** — folding a query to a value
   (`count`/`exists`/`first`/`single`) and full-text `text()`.
7. **[graph-traversal.md](./graph-traversal.md)** — `follow` over the link and
   structure graphs, with `$depth` / `$stop` / `$ordinal`, `frontier`, and `by`.

New here? Start with **[../getting-started.md](../getting-started.md)** for what
omgbase and the corpus are; the OQX surface is also summarized (as-built) in
`docs/query-language.md`.
