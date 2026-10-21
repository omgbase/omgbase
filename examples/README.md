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
5. **[oqx-tutorial/](./oqx-tutorial/README.md)** — the OQX query language, end to end: filtering, targets, shaping, correlated subqueries, joins & lifts (and the repository as the root row), aggregates, full-text, graph traversal, and the sugar forms with `refs()` (eight pages).

Not tutorials, but also here:

- **[graph-ui/](./graph-ui/README.md)** — a Lit demo that runs an OQX query over MCP and renders the result as a graph, with the relationships that draw edges and lay the graph out inferred from the query (a probe of the reflection API).
- **[live-tail/](./live-tail/README.md)** — a Lit demo of the change feed: the most recently updated documents with the unified diff of their latest change, then every commit as it lands (`changes_since` polled with a cursor, each digest prepended with its revisions' diffs), both narrowed by an OQX `where` filter typed into the hole of the recent query itself (a CodeMirror editor whose frame is read-only).
- **[repo-explorer/](./repo-explorer/README.md)** — a Lit demo that browses a repository end to end over the **minimal tools profile** (`omg mcp --tools minimal`, ten tools): the tree (`docs_tree`), a document rendered with every block an anchor verified against its hash (`docs_read { include_ids }`), backlinks and outlinks and history as OQX over `links` and `revisions`, time travel (`docs_read { at }`) with a client-side diff, a live strip (`changes_since`), a query console with `hints` and `data.fix`, and frontmatter edits previewed with `plan` and committed with `execute`.
- **[attn/](./attn/README.md)** — an omgbase-native prototype of **attn**, an attention app built around one question (what has your attention right now?): intents are dated Markdown documents under `/attn/intents/` that carry their own cues as a `cues:` frontmatter list (`on: focus | time | query-enter | query-exit`), the focus is one pointer document `/attn/focus.md` (with an interrupt return stack) and switching writes nothing else, the Stream is reconstructed read-only from the pointer's own revisions (`revisions` + `docs_read { at }`), `#focus` a virtual OQX join against the pointer (never a tag), the feed the intents most recently edited first with cued intents lifted above; every switch one atomic `apply` under `expect.revision`, over the **minimal tools profile**; ends with the friction it found ("What the prototype learned").
- **[webdevproxy/](./webdevproxy/README.md)** — the development-only local web proxy the browser demos use to reach an omgbase MCP server (a local `omg mcp`, or a remote gateway behind OAuth) from a Vite dev server without CORS or OAuth setup on the server side. Private, unpublished, loopback only.

- **[agent-bench/](./agent-bench/README.md)** — a private benchmark harness answering two questions: does an agent work a knowledge base better through **omgbase or through generic file tools over the same vault** (the `fs` baseline), and within omgbase, against the full MCP catalog or the **minimal tools profile**? Thirteen editing tasks over the alchemy corpus and nine retrieval tasks — range inclusion, timeline traversal, aggregation, backlinks, open tasks, semantic search — over alchemy and a generated 348-note programme corpus (`corpora/timeline`). For every (task, profile, run) cell it builds a fresh workspace, serves it over `omg mcp` (or the in-process file-tool server), drives a model through the tools, and scores machine-checkable end states and answers — always through omgbase, so every profile is judged by the same oracle.

The browser demos check the `version` tool on connect and refuse an older server with a clear message. graph-ui and live-tail accept **surface ≥ 3.0** and adapt their spelling of the engine names to the server's (bare on 3.x/4.x, `_`-prefixed from 5.0); repo-explorer and attn require **surface ≥ 5.0**. The current `omg` speaks 5.0 — "underscore = engine", the rule [getting-started](./getting-started.md#one-naming-rule-everywhere) teaches.

## The corpus

Every session works over the **alchemy corpus** — twenty interlinked Markdown
documents (substances, processes, practitioners, texts, dated lab notes and two
timeline milestones whose frontmatter holds document references)
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
value types — `doc_id`, `block_id`, `node_id`, `repo_id`, … — + bind-by-type above, pulled in by the bootstraps), and the
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
