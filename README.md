<center><img src="https://i.imgur.com/GuNPnuA.png" maxwidth="80%"></center>

# omgbase

**Open Markdown Graph Base** — a versioned, addressable graph of authored Markdown structure.

Ordinary Markdown files stay the human representation (editable in any editor, Obsidian, Git, shell tools). The engine adds, on top of those files:

- **stable block identity** — every paragraph, heading, list item, etc. gets a durable id that survives edits and moves;
- **block-grain history** — who/what changed each block, across commits;
- **a typed knowledge graph** — links, wikilinks, frontmatter relations, and inline fields become queryable, temporal edges;
- **hybrid retrieval** — full-text (FTS5) + vector search fused with reciprocal-rank fusion;
- **a safe structural mutation API** — six kernel ops with content-hash CAS, built for autonomous agents;
- **an MCP server** — the whole surface exposed as Model Context Protocol tools.

The files are always the source of truth for *content*; the engine's database owns *identity, history, and derived indexes*. At quiescence, `sha256(file) == current_revision.rendered_hash` for every tracked document.

## Status

All stages of the implementation plan (`docs/07-implementation-plan.md`) are complete: round-trip fidelity, core store, identity reconciliation, mutation & concurrency, graph, retrieval, agent ergonomics, and hardening. See `docs/` for the full normative design.

## Install

Requires **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

## Architecture at a glance

A single-writer engine process sits beside one or more Markdown working trees ("repos"). It watches the filesystem and ingests human edits (observation path), applies structural mutations from agents (intent path), and serializes all state changes through one append-only commit log per repo, backed by embedded SQLite (WAL) under `.omgbase/`.

The repo is a pnpm workspace of three packages:

```
packages/
  core/          @omgbase/core — the embedded engine
    src/
      core/      parse · blocks · splice · hashing · ids · SQLite store · revisions · commits
      reconcile/ matcher phases · scoring · dispositions · eval harness
      sync/      watcher · checkpoints · reconciling ingest · recovery · git heuristics
      mutate/    six kernel ops · changesets · CAS · macros
      graph/     edge extraction · intervals · traversal · history/diff
      search/    CEL query compiler · FTS · embeddings · vector · RRF · resolve/pipeline
      mcp/       MCP server · tools · error mapping
      migrate/   mrplex importer
    corpus/      round-trip + matcher fixtures
  cli/           omgbase — the `omg` CLI binary (depends on @omgbase/core)
  client/        @omgbase/client — thin remote MCP client (placeholder)
docs/            normative design documents
```

Rendering is **splice-only**: untouched blocks emit their exact retained bytes; only changed blocks are re-serialized. A lint rule bans `remark-stringify` to enforce this.

## Quickstart (CLI)

The `omgbase` CLI (`packages/cli`, aliased `omg`) is the engine's second client — a thin adapter over `@omgbase/core`, embedded and daemonless (design in `docs/11-cli.md`, ADR-012). CLI-A (the read surface) is implemented: `init`, `attach`, `repos`, `status`, `ls`, `outline`, `cat`, `show`, `find`, `query`, `log`, `hist`, `diff`, `links`, `sync`. Write/serve commands (`apply` + sugar, `watch`, `mcp`, admin) are CLI-B.

```bash
pnpm -r build           # build core + cli
node packages/cli/dist/src/main.js init ./my-vault --yes   # or `pnpm link` to get `omgbase`/`omg` on PATH

omg status                              # where am I: repo, sync, watcher, queue
omg outline notes/hub.md                # compact orientation outline (frozen wire format)
omg q 'type == "task" && !attrs.checked' --text deploy --ids | omg cat -   # pipe fuel
omg log --since 24h                     # one commit digest per line
omg find "stable identity rationale" -1 # top hit's id alone
```

Reads are **current by default**: before each command a freshness sweep re-ingests any files changed on disk since the last ingest (skip with `--stale`, or run a `watch`er). Human output is colorized and glyph-rich on a capable TTY; `--json`/`--jsonl`/`--ids` emit machine data verbatim, and `NO_COLOR`/pipes degrade to plain text automatically.

## Quickstart (library)

The engine can also be used directly as a library via `@omgbase/core`. All functions take a `Store` and a `repoId`.

### Attach a directory and query it

```ts
import { Store } from "@omgbase/core/core/store/store";
import { attachRepo } from "@omgbase/core/sync/attach";
import { query } from "@omgbase/core/search/query";
import { docsOutline } from "@omgbase/core/core/read/outline";

// Open (or create) the engine database. Use ":memory:" for tests.
const store = new Store({ path: "/path/to/vault/.omgbase/omgbase.db" });

// Walk a Markdown tree: ingest every file, thread identity, extract edges.
const { repoId } = attachRepo(store, "my-vault", "/path/to/vault");

// CEL query over blocks (see docs/10-query-language.md for the full language).
const { hits } = query(store, repoId, {
  from: "blocks",
  filter: 'type == "task" && !attrs.checked && under_heading("Launch")',
  limit: 50,
});

// Compact orientation outline of one document.
const doc = store.db.prepare("SELECT doc_id FROM documents WHERE path = ?").get("notes.md");
const outline = docsOutline(store, doc.doc_id);
console.log(outline.text);
```

### Watch for human edits

```ts
import { Watcher } from "@omgbase/core/sync/watcher";

const watcher = new Watcher(store, repoId, "/path/to/vault", {
  quiescenceMs: 750,
  onCheckpoint: (cp) => console.log("ingested", cp.ingested),
});
watcher.start();
// Human saves are debounced into checkpoints; the engine reconciles block
// identity and maintains the graph + indexes automatically.
```

### Apply a structural mutation

```ts
import { apply } from "@omgbase/core/mutate/apply";

// Move a block into a section, then edit it — atomically, in one changeset.
apply(store, {
  repoId,
  rootPath: "/path/to/vault",
  ops: [
    { op: "move", blocks: ["b_q4aaaaa"],
      to: { parent: { heading: "b_decs01", scope: "section" }, at: "end" } },
    { op: "update", block: "b_q4aaaaa",
      markdown: "**Decided:** stable ids are engine-local.",
      expect: { content_hash: "9f2c…" } },  // content-hash CAS
  ],
  origin: { actor: "agent:me", reason: "promote decision" },
  // dryRun: true  → returns per-file diffs, writes nothing
});
```

Mutations render the tree by splice, write the file atomically (temp → rename), and record the revision. Conflicts are typed and carry current truth so callers retry without re-reading.

### Serve over MCP

```ts
import { buildServer } from "@omgbase/core/mcp/server";

const server = buildServer({ store, repoId, rootPath: "/path/to/vault" });
// Connect `server` to any MCP transport (stdio, in-memory, …).
```

Tools exposed: `docs_outline`, `nodes_get`, `nodes_get_many`, `query`, `text_search`, `resolve`, `apply`, `tasks_complete`, `sections_append`, `links_retarget`, `graph_traverse`, `graph_path`, `history_node`, `diff`, `changes_since`, `repos_status`, `sync_status`. Every list result carries `truncated` + a cursor; every hydrating tool honors `budget_tokens`.

### Semantic search (optional)

Vector search needs an embedding provider hook (vault text leaves the machine, so it is opt-in). Without one, semantic queries return `semantic_unavailable`.

```ts
import { EmbeddingWorker } from "@omgbase/core/search/embeddings";
import { hybridSearch } from "@omgbase/core/search/rrf";

const worker = new EmbeddingWorker(store, myProvider);   // provider = { model, dim, embed() }
const vec = await worker.embedQuery("stable identity across edits");
const hits = hybridSearch(store, { repoId, text: "identity", vector: { model: myProvider.model, vec } });
```

## Reading the design

Start with `docs/README.md`, then the numbered documents. They are normative: where code and docs disagree, the docs win until an ADR (`docs/08-decisions.md`) says otherwise.

## License

Not yet specified.
