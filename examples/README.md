# omgbase CLI examples

These are **executable tutorials**. Each Markdown file reads like a real terminal
session teaching one facet of the `omg` CLI — and every command in it is run for
real and its output verified, so the documentation cannot silently drift from
the code.

They're powered by [`@simplebrains/recital`](https://www.npmjs.com/package/@simplebrains/recital):
a `<!-- recital … -->` comment at the top of each file opts it in, and every
fenced ` ```console ` block becomes a checked transcript (`$ ` lines are
commands, the lines after them are expected output).

The transcripts read **verbatim** — the ids, temp paths, and timestamps you see
are realistic-looking stand-ins, not `{{…}}` placeholders, so each block reads
like a real terminal session. They still match run-to-run because the shared
[`_fragments/omg-types.md`](./_fragments/omg-types.md) declares omgbase's value
shapes as recital **types** and binds them **by type**:

```markdown
<!-- recital type:
doc_id: "d_[a-z0-9]{7}"
block_id: "b_[a-z0-9]{7}"
-->
<!-- recital bind: { type: doc_id } -->
<!-- recital bind: { type: block_id } -->
```

A bind-by-type turns every distinct substring of that shape into its own
identity: the stand-in `d_9f4k2qa` in a transcript matches whatever id the CLI
actually mints, and a value that recurs (a captured id reused in a later
command) stays consistent. So there are no per-document id lists — the types
carry it.

## Read them in order

1. **[getting-started.md](./getting-started.md)** — `init`, `source add`, and orienting yourself in a workspace.
2. **[search-and-navigation.md](./search-and-navigation.md)** — `find`, `outline`, `show`, and the link/backlink graph.
3. **[editing-and-history.md](./editing-and-history.md)** — structured edits (completing tasks) and reading history back.
4. **[interactive-shell.md](./interactive-shell.md)** — `omg shell`: a persistent session with `@`-addressable results.
5. **[oqx-tutorial/](./oqx-tutorial/README.md)** — the OQX query language, end to end: filtering, targets, shaping, correlated subqueries, joins & lifts, aggregates, full-text, and graph traversal (seven pages).

## The corpus

Every session works over the **alchemy corpus** — eighteen interlinked Markdown
documents (substances, processes, practitioners, texts, and dated lab notes)
that live at `packages/core/corpus/oqx/fixtures/alchemy`. Each file is
**self-contained**: it pulls in a shared bootstrap with a recital `include`
directive —

```markdown
<!-- recital include: ./_fragments/attached-alchemy.md -->
```

— which locates the repo, puts the built `omg` on `PATH`, copies the corpus into
a throwaway temp directory, and (for all but getting-started) runs
`omg init` / `omg source add` against the copy; a `teardown` removes the temp
directory when the session ends. Nothing touches your real files or a shared
database, and there is no external environment to wire up.

The shared fragments live in [`_fragments/`](./_fragments/): `omg-types.md` (the
value types + bind-by-type above, pulled in by the bootstraps), and the
bootstraps themselves — `attached-alchemy.md` (corpus already attached — used by
the query/search/edit walkthroughs), `fresh-workspace.md` (un-attached — used by
getting-started, whose whole point is to demonstrate `init` / `source add` live), and
`attached-alchemy-shell.md` (same, but the session is the live `omg shell` REPL,
driven in recital's prompt mode — used by interactive-shell). They are spliced in
at parse time and are not standalone documents.

## Running them

The only prerequisite is a build (the setup shims the compiled `omg` at
`packages/cli/dist/src/main.js`). As part of the test suite — this is how CI
verifies them:

```bash
pnpm --filter omgbase build    # the setups shim the built ./dist binary
pnpm --filter omgbase test     # runs test/examples.test.ts over this folder
```

The vitest wiring in [`packages/cli/test/examples.test.ts`](../packages/cli/test/examples.test.ts)
is a one-liner — it just hands this folder to recital's `describeMarkdown`;
every session bootstraps itself.

To run one file directly with the recital CLI (from anywhere inside the repo):

```bash
pnpm --filter omgbase build
npx recital run examples/getting-started.md
```
