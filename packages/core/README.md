# @omgbase/core

**Open Markdown Graph Base — the embedded engine.**

`@omgbase/core` is a versioned, addressable graph layer over ordinary Markdown, YAML,
and JSON files. The files stay the human source of truth for *content*; an embedded
SQLite database (one per workspace, under `.omgbase/`) owns *identity, history, and
derived indexes*: stable block ids that survive edits, block-grain commit history,
a typed link/property graph, full-text + vector retrieval, and a six-op structural
mutation kernel with content-hash CAS. At quiescence, `sha256(file)` equals the
current revision's rendered hash for every tracked document. This package is the
library; the `omg` CLI ([`omgbase`](https://www.npmjs.com/package/omgbase)) and the
MCP server (`omg mcp`) are thin clients over it. The full as-built design lives in
the [monorepo README](https://github.com/omgbase/omgbase#readme) and
[`docs/`](https://github.com/omgbase/omgbase/tree/main/docs).

## Install

```bash
npm install @omgbase/core
```

- **Node ≥ 22.** ESM only (`"type": "module"`; no CommonJS build).
- SQLite is [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3), which
  ships prebuilt binaries for common platforms; a compiler is only needed where no
  prebuild exists.
- No ML dependency. Semantic search is optional and talks to an external embedder
  process/URL (e.g. `@omgbase/embedder`) over a small stdio/HTTP protocol.

## Quick start

Everything below was run as written against a scratch directory. A **workspace** is
a directory holding `.omgbase/omgbase.db`; a **repo** is a set of documents whose
bytes come from an attached source — here, a directory of Markdown.

```js
import { mkdirSync, writeFileSync } from "node:fs";
import {
  Workspace, ensureRepo, freshnessSweep,
  oqxRun, findDoc, docsRead,
  apply, tasksComplete, historyNode,
} from "@omgbase/core";

const wsDir = "/tmp/omg-demo";
const root = `${wsDir}/notes`;
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/todo.md`, "# Todo\n\n- [ ] write the README\n- [x] ship 0.1\n");

const ws = Workspace.open(wsDir);                     // creates .omgbase/ + the SQLite db
const repoId = ensureRepo(ws.store, "notes", root);   // repo row + an `fs` source rooted at `root`
const sweep = freshnessSweep(ws.store, repoId, root); // ingest new/changed *.md as one checkpoint
sweep.ingested;                                       // ["todo.md"]

// Query with OQX. Nodes are projections of blocks; $block_id is the anchor block.
const open = oqxRun(ws.store, repoId,
  'from nodes where kind == "md:task" && !attrs.checked select block: $block_id');
open.hits;  // [{ id: "n_…", path: "todo.md", block: "b_…" }]

// Read a whole document back byte-exact, with block ids + CAS hashes.
const doc = findDoc(ws.store, { repoId, path: "todo.md" });
const read = docsRead(ws.store, doc.docId, { includeIds: true });
read.content;  // "# Todo\n\n- [ ] write the README\n- [x] ship 0.1\n"
read.ids;      // ["b_…", "b_…", "b_…", "b_…"]   read.hashes[id] → content_hash

// Mutate. The macro expands to kernel `update` ops pinned by content_hash;
// apply() renders, writes the file, and commits a new revision.
const result = apply(ws.store, {
  repoId,
  rootPath: root,
  omgbaseDir: ws.omgbaseDir,   // take the cross-process writer lock
  ops: tasksComplete(ws.store, open.hits.map((h) => h.block)),
  origin: { actor: "agent:quickstart", reason: "demo" },
});
result;  // { results: [{ ids: ["b_…"] }], revisions: [{ doc: "d_…", path: "todo.md" }], committed: true }
// todo.md on disk now reads "- [x] write the README"

historyNode(ws.store, open.hits[0].block);  // [{ origin: "import", kind: "edited", … }, { origin: "observed", kind: "inserted", … }]
ws.close();
```

Raw kernel ops take the same route. An `update` whose `expect.content_hash` no
longer matches throws a `MutationError` with `code: "stale_expectation"`:

```js
apply(ws.store, {
  repoId, rootPath: root, omgbaseDir: ws.omgbaseDir,
  ops: [{ op: "update", block: read.ids[1], markdown: "hello, world",
          expect: { content_hash: read.hashes[read.ids[1]] } }],
  origin: { actor: "agent:quickstart" },
});
```

No filesystem at all? `new Store({ path: ":memory:" })`, `ensureRepo(store, slug, null)`,
feed bytes with `observeFile(store, repoId, "a.md", text)`, and pass
`docStore: new NullDocStore()` to `apply` — the DB is then the canonical artifact.

## Surface map

All of these are named exports of `@omgbase/core` (`src/index.ts`). Functions take
the `Store` first and are synchronous unless noted.

| Group | What it does | Key exports |
| --- | --- | --- |
| Store / workspace | Open the SQLite store (WAL, migrations to `SCHEMA_VERSION`); find a workspace by walking up for `.omgbase/`; list/select repos; layered settings | `Store`, `Workspace.open/find`, `Workspace#repos/selectRepo/close`, `ensureRepo`, `resolveSettings`, `workspaceSettings`, `writeWorkspaceSettings` |
| Ingest / sync | Get file bytes into the repo as observed commits: one-shot sweep, batch checkpoint, headless observe, directory walk, external stdio adapters, live watcher, writer lock | `freshnessSweep`, `processCheckpoint`, `observeFile/observeMany/observeDelete`, `ingestDirectory`, `createSource/attachSourceToRepo/listSources`, `createExternalSource`, `reconcileChanges`, `Watcher`, `WatchLease`, `withWriterLock`, `reposStatus`, `syncStatus` |
| Read | Byte-exact document read, outlines, block/node hydration, listings, ref resolution, cursors | `docsRead`, `docsOutline`, `nodesGet/nodesGetMany`, `findDoc`, `loadDocBlocks`, `blockRaw`, `docsList`, `docsTree`, `resolveRef`, `encodeCursor/decodeCursor` |
| Mutate — kernel | The six ops (`insert/update/move/remove/split/merge`) applied atomically as one changeset with CAS; write target is pluggable | `apply`, `Op`, `ApplyRequest`, `Expect`, `To`, `DocStore`, `FsDocStore`, `NullDocStore`, `MutationError` |
| Mutate — macros + doc ops | Op builders for common intents; whole-document create/move/delete/frontmatter; whole-document update planner | `tasksComplete`, `sectionsAppend`, `sectionsRename`, `sectionsMove`, `listsInsertItem`, `nodeSet`, `linksRetarget`, `docsCreate`, `docsMove`, `docsDelete`, `docsSetMeta`, `planUpdate`, `applyOpset`, `docsUpdate` |
| OQX | Run an OQX query over the store (`docs`/`blocks`/`nodes`/`edges`); async variant embeds `semantic("…")` phrases first | `oqxRun`, `oqxRunAsync`, `parseOqx`, `collectSemanticPhrases`, `OqxResult`, `FilterInvalid` |
| Graph / history | Block history, unified diffs between revisions, commit digests since a cursor, link edges | `historyNode`, `diffUnified`, `changesSince`, `docLinks`, `inboundLinksTo` |
| Search | Ranked "what does the caller mean" resolution; RRF fusion of FTS + vectors; raw vector search | `resolve`, `hybridSearch`, `vectorSearch`, `docVectorSearch` |
| Embeddings | Out-of-process embedder client, batching worker, post-mutation drainer, task builders | `createExternalProvider`, `EmbeddingWorker`, `EmbedDrainer`, `buildEmbedTasks`, `embeddingSettings`, `SemanticUnavailable` |
| Format adapters | Register/lookup the parsers that turn a file into blocks + nodes + edges | `registerAdapter`, `adapterForPath`, `detectFormat`, `markdownAdapter`, `yamlAdapter`, `jsonAdapter` |
| MCP server | Build the full tool surface (45 tools: `docs_read`, `query`, `apply`, `observe`, `changes_since`, …) as an `McpServer`; wire it to stdio | `buildServer({ store, repoId, rootPath?, embedQuery?, onMutation? })`, `serveStdio(ctx)` |
| Admin | Rebuild derived indexes; garbage-collect unreferenced blobs | `rebuildIndex`, `runGc`, `VERSION`, `EngineError` |

`omg mcp` is just a host for `serveStdio`: it opens the workspace, primes with
`freshnessSweep`, optionally starts a `Watcher` and `EmbedDrainer`, then calls
`serveStdio({ store, repoId, rootPath, embedQuery, onMutation })`. Embed the same
server in your own process with `buildServer(ctx)` and any MCP SDK transport.

## Data model in 10 lines

1. A **repo** (`rp_`) owns identity and history; its bytes come from attached sources (a directory, or nothing).
2. A **doc** (`d_`) is one file at a repo-relative path, in a format (`markdown`, `yaml`, `json`).
3. A doc is an ordered tree of **blocks** (`b_`): paragraphs, headings, list items, fences, YAML entries, JSON properties…
4. Block ids are minted once and threaded through re-ingests by the reconciler, so they survive edits and moves.
5. Blocks are the **mutation anchors**: every kernel op addresses `b_` ids; `expect.content_hash` (sha256 of the block's raw bytes) is the CAS token.
6. **Nodes** (`n_`) are semantic projections of blocks — `md:task`, `md:heading`, `md:section`, `md:link`, `md:wikilink`, `md:anchor`, `md:inline_field` — queryable but derived; `$block_id` points back at the anchor.
7. **Edges** are typed links between blocks/docs (wikilinks, `$ref`, frontmatter relations) with commit intervals.
8. Every ingest or mutation appends a **commit** (`c_`) and a per-doc **revision** (`r_`) whose rendered hash equals the file's bytes.
9. Commits carry `origin` (`observed` from disk, `import` from `apply`) and an actor; `historyNode`/`changesSince` read them back.
10. Indexes (FTS, properties table, sections, embeddings) are derived and rebuildable; the schema is `SCHEMA_VERSION = 13`.

## Query language

OQX is the standalone [`@omgbase/oqx`](https://www.npmjs.com/package/@omgbase/oqx)
engine bound to the store (`src/oqx-js/`): omgbase supplies a `DataContext` over
`docs`/`blocks`/`nodes`/`edges` and a SQLite pushdown planner, and the library
supplies the language (`from … where … select … order by … limit … follow …`,
consumers `collect/count/exists/none/first/single`, nested blocks, `^` outer
references, `entries()`, `values`). Row-scoped predicates like `text("…")` (FTS)
and `semantic("…")` (embedding score) are omgbase additions.

```js
oqxRun(ws.store, repoId, `
  from docs where nodes count { where kind == "md:task" && !attrs.checked } >= 2
  select $path, $title, open: nodes collect { where kind == "md:task" && !attrs.checked select $block_id }
  order by $path limit 10
`);
// hits: [{ id: "d_…", path: "more.md", $path: "more.md", $title: "More", open: [{ $block_id: "b_…" }, …] }]
```

See [`docs/query-language.md`](https://github.com/omgbase/omgbase/blob/main/docs/query-language.md)
for the omgbase surface (targets, fields, scoping, execution model) and the
[`@omgbase/oqx` README](https://github.com/omgbase/omgbase/blob/main/packages/oqx/README.md)
for the language itself.

## Where the truth lives

Code wins over prose. When in doubt, read these in the monorepo:

- `packages/core/src/index.ts` — the exported surface (this README's tables are derived from it).
- `packages/core/src/mcp/server.ts` — every MCP tool, its schema, and its inline description.
- `packages/core/src/core/store/schema.ts` — the SQLite DDL, `SCHEMA_VERSION`, and migrations.
- `packages/core/src/mutate/` — the six kernel ops, CAS, macros, and the whole-document planner.
- `packages/core/src/oqx-js/` — the OQX `DataContext` + planner; `corpus/oqx/README.md` has runnable query examples.
- `docs/` — as-built design references (`architecture.md`, `data-model.md`, `mutation-and-concurrency.md`, `graph-and-query.md`, `mcp-api.md`, `surface-map.md`); the repo-root `AGENTS.md` indexes them.

## License

MIT
