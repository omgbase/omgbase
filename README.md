<center><img src="https://i.imgur.com/U4Gunuy.png" maxwidth="80%"></center>

# omgbase

**Open Markdown Graph Base** — a versioned, addressable graph of authored structure across Markdown, YAML, JSON, and user-defined formats.

Ordinary files stay the human representation (editable in any editor, Obsidian, Git, shell tools). The engine adds, on top of those files:

- **stable block identity** — every paragraph, heading, YAML mapping entry, JSON property, etc. gets a durable id that survives edits and moves;
- **block-grain history** — who/what changed each block, across commits;
- **a typed knowledge graph** — links, `$ref`s, `extends`, frontmatter relations, and inline fields become queryable, temporal edges that cross format boundaries;
- **semantic node projection** — links, tasks, anchors, environment variables, schema references, and other features are projected as queryable nodes anchored to their source blocks;
- **hybrid retrieval** — full-text (FTS5) + vector search fused with reciprocal-rank fusion;
- **a safe structural mutation API** — six kernel ops with content-hash CAS, built for autonomous agents;
- **an MCP server** — the whole surface exposed as Model Context Protocol tools;
- **store-to-store sync** — mirror an external store (a filesystem directory today; git/S3/others via adapters) into a repo, locally or against a **remote / headless** server over MCP, with no local files required on the server.

The files are always the source of truth for *content*; the engine's database owns *identity, history, and derived indexes*. At quiescence, `sha256(file) == current_revision.rendered_hash` for every tracked document with a round-trip renderer.

## Status

The engine is feature-complete and tested: round-trip fidelity, core store, identity reconciliation, mutation & concurrency, graph, retrieval, agent ergonomics, and hardening are all built. A **store-to-store sync layer** (`@omgbase/sync`, ADR-014) is in progress — the source registry, the `observe`/`observe_many`/`observe_delete` MCP surface, the headless `DocStore` seam, and the standalone `omgbase-sync` coordinator are built; `attach`-as-source-sugar and retiring the legacy `root_path` column are the remaining migration steps. See `docs/` for the as-built design reference and the repo-root `AGENTS.md` for orientation.

## Install

Requires **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

## Architecture at a glance

A single-writer engine process sits beside one or more working trees ("repos"). It watches the filesystem and ingests human edits (observation path), applies structural mutations from agents (intent path), and serializes all state changes through one append-only commit log per repo, backed by embedded SQLite (WAL) under `.omgbase/`.

The repo is a pnpm workspace of six packages:

```
packages/
  core/          @omgbase/core — the embedded engine
    src/
      core/      parse · blocks · splice · hashing · ids · SQLite store · revisions · commits
      format/    adapter contract · registry · markdown/yaml/json adapters · node projection
      reconcile/ matcher phases · scoring · dispositions · eval harness
      sync/      observe primitive · source registry · external-source bridge · driver · checkpoints · watcher
      mutate/    six kernel ops · changesets · CAS · macros · DocStore seam
      graph/     edge extraction · intervals · traversal · history/diff
      search/    OQX bindings · FTS · embeddings · vector · RRF · resolve/pipeline
      mcp/       MCP server · tools · error mapping
      migrate/   mrplex importer
    corpus/      round-trip + matcher fixtures
  cli/           omgbase — the `omg` CLI binary (depends on @omgbase/core + @omgbase/fs-adapter)
  sync/          @omgbase/sync — standalone store-to-store synchronizer (coordinator + `omgbase-sync` bin)
  client/        @omgbase/client — thin remote MCP client (placeholder)
  embedder/      @omgbase/embedder — external embedding provider (transformers.js + all-MiniLM-L6-v2)
  fs-adapter/    @omgbase/fs-adapter — external filesystem sync adapter (owns chokidar; stdio protocol)
docs/            as-built design reference · decision log (ADRs)
```

Rendering is **splice-only**: untouched blocks emit their exact retained bytes; only changed blocks are re-serialized. A lint rule bans `remark-stringify` to enforce this.

### Three-layer model

Every tracked file is a **Doc** (a versioned repository-level authored unit). Each doc decomposes into **Blocks** (source-backed structural regions — the mutation anchors) and **Nodes** (semantic features projected by format adapters — the discovery targets).

- **Blocks** are what you *mutate*: markdown paragraphs, YAML mapping entries, JSON properties. Stable identity survives edits.
- **Nodes** are what you *discover*: links, tasks, `$ref` references, environment variables, anchors, inline fields. Derived, deterministic, queryable.

Agents query nodes to find what's relevant, then mutate the blocks those nodes are anchored to.

### Multiformat support

Format is auto-detected from file extension. Each format adapter declares progressive capabilities:

| Format | Extensions | Parse | Render | Edges | Nodes | Mutation | Properties |
|--------|-----------|-------|--------|-------|-------|----------|------------|
| **Markdown** | `.md` `.markdown` | yes | yes | links, wikilinks, frontmatter, inline fields | `md:link` `md:wikilink` `md:task` `md:anchor` `md:inline_field` | yes | frontmatter + inline (`key:: value`) + computed (`$title`, `$tags`) |
| **YAML** | `.yaml` `.yml` | yes | yes | `$ref` `extends` `$schema` path values | `yaml:ref` `yaml:schema` `yaml:anchor` `yaml:alias` `yaml:env_var` | yes | full structure |
| **JSON** | `.json` | yes | yes | `$ref` `$schema` path values | `json:ref` `json:schema` | yes | full object |

Cross-format edges compose seamlessly: a markdown doc linking to a YAML config, which `extends` a base YAML file and references a JSON schema, produces a traversable graph that `graph_traverse` follows in one call.

Block kinds use a colon-separated format qualifier for non-markdown formats: `yaml:mapping_entry`, `json:property`, `yaml:scalar`. Markdown block types remain unqualified for backward compatibility: `heading`, `paragraph`, `task`, `code_fence`, etc.

### Document properties

Document-level properties live in one indexed `properties` table (design in `docs/properties-table.md`), unifying three sources under a single query surface — no per-document JSON blob:

- **frontmatter** — the parsed YAML fence (markdown), or the whole parsed object (YAML/JSON files);
- **inline** — dataview-style `key:: value` fields in body text, accumulating across occurrences;
- **computed** — engine-derived `$`-intrinsics (`$title` from the first H1, `$tags` from body `#hashtags`) that never shadow authored keys.

A CEL bare key (`layer == "canon"`) queries the authored union (frontmatter + inline) as an indexed seek; `frontmatter.<k>` / `inline.<k>` narrow to one source; `$title` / `$tags` address the computed ones. A per-value `card` flag records the authored scalar-vs-list shape, so scalar `==`/`!=`/`<` match scalar-authored values while `list()` spans all — preserving the exact CEL semantics across the row-backed store.

### Structural query functions

In addition to the core CEL filter language (see `docs/query-language.md`), the query system provides format-aware structural functions for the `blocks` target:

- `under_heading("Setup")` — markdown blocks under a heading (section range)
- `under_kind("yaml:mapping_entry", "database")` — blocks nested under an ancestor of the given kind
- `yaml_path("database.host")` — blocks at a YAML key path (walks parent chain)
- `json_pointer("#/definitions/User")` — blocks at a JSON Pointer path

## Quickstart (CLI)

The `omgbase` CLI (`packages/cli`, aliased `omg`) is the engine's second client — a thin adapter over `@omgbase/core`, embedded and daemonless (design in `docs/cli.md`, ADR-012). The full command surface is implemented: bootstrap (`init`, `attach`, `repos`, `source`), reads (`status`, `ls`, `outline`, `cat`, `show`, `find`, `query`, `run`, `log`, `hist`, `diff`, `links`), writes (`apply` + sugar: `insert`/`update`/`edit`/`move`/`rm`/`done`/`append`/`retarget`/`split`/`merge`, and doc-level `new`/`mv`/`meta`/`update`), and sync/serve/admin (`sync`, `watch`, `mcp`, `rebuild-index`, `gc`, `doctor`, `config`, `import`, `embed`, `shell`).

### The mental model: workspace, repo, source, config

Four concepts, and getting them straight makes everything else obvious:

- A **workspace** is the `.omgbase/` directory + its SQLite database. It is *not* the content — it can live in a project root, a notes directory, or `$HOME`. Commands find it by walking **up** from the cwd (like `git`). One `omg init` creates one.
- A **repo** is a named scope *inside* a workspace that owns **identity + history** for a set of documents. One workspace can hold many repos; each has a `slug`. A repo does **not** intrinsically own a filesystem — it owns the versioned graph.
- A **source** is *where a repo's bytes come from*: a filesystem directory today (via the built-in `fs` adapter), git/S3/others later. A repo can have zero, one, or several attached sources — managed with `omg source`. (A repo with no source is **headless**: it lives entirely in the DB. See [Remote / headless](#remote--headless-servers).)
- **Config** is one settings schema at **two layers**: values set at the **workspace** layer are *defaults* every repo inherits; a repo can *override* any key. That's why an embedder is set once workspace-wide (so every repo shares one vector space) while something like `gc.enabled` is set per repo.

> The `attach` command is the fast path that does the common thing in one step: create a repo *and* point it at a filesystem directory *and* ingest it. `omg source` is the general form underneath, for repos that need more than one source or a non-default layout.

### 1. Build and link the binaries

```bash
pnpm install
pnpm -r build     # build every package (core, cli, sync, embedder, fs-adapter)
pnpm rlink        # link binaries onto PATH: omg, omgbase, omgbase-sync, omgbase-embedder, omgbase-fs-adapter
```

### 2. Create a workspace and attach a repo

`init` creates the workspace **but ingests nothing** — pulling a directory of files in is a separate, consent-gated step, so `init` never silently absorbs whatever happens to live under the cwd.

```bash
omg init ./my-vault --yes   # create .omgbase/ + the DB (offers to .gitignore it)
cd ./my-vault
omg attach . -y             # ingest this tree as a repo (slug defaults to the folder name; prompts without -y)

omg status                  # where am I: repo, sync state, watcher, embed queue
omg repos                   # every repo in this workspace: slug · root · doc/block counts
```

### 3. Read and query

Reads are **current by default**: before each command a freshness sweep re-ingests any files that changed on disk since the last ingest (skip with `--stale`, or keep a `watch`er running). OQX is the one query + traversal language (`from … where … select … follow …`; see `docs/query-language.md`).

```bash
omg outline notes/hub.md                       # compact orientation outline (stable wire format)
omg cat notes/hub.md                            # exact file bytes, reconstructed from the DB
omg query 'from docs where layer == "canon"'    # query documents by frontmatter
omg q 'from nodes where kind == "md:task" && !attrs.checked' --ids | omg cat -   # pipe ids as fuel
omg find "stable identity rationale" -1         # top hybrid-search hit's id alone
omg log --since 24h                             # one commit digest per line
```

### 4. Edit — the pipe is the changeset boundary

Every mutation renders by splice, writes the file atomically, and records a revision; conflicts are typed and carry current truth.

```bash
omg q 'from blocks where type == "task" && !attrs.checked && under_heading("Launch")' --ids | omg done -
echo '# New idea' | omg new notes/idea.md -     # create a document from bytes on stdin (or: -f file.md)
omg edit b_k7z2p9q                              # $EDITOR round-trip on one block, CAS-pinned
omg retarget old.md new.md                      # rewrite links; plan by default, --apply to commit
omg hist b_k7z2p9q                              # a block's biography: every commit that touched it
```

Human output is colorized and glyph-rich on a capable TTY; `--json` / `--jsonl` / `--ids` emit machine data verbatim, and `NO_COLOR` / pipes degrade to plain text automatically.

### 5. Config (workspace default vs repo override)

```bash
omg config set embedding.provider omgbase-embedder --repo ""   # --repo "" ⇒ workspace default
omg config list --repo ""                                       # show workspace defaults
omg config list                                                 # effective view for this repo (◆ = overridden)
omg config set gc.enabled true                                  # no --repo ⇒ this repo's layer
```

`omg config` targets the repo you're in (by cwd or `--repo <slug>`); `--repo ""` targets the workspace default layer; at a multi-repo workspace root a bare `omg config` falls back to the workspace layer. `get` returns the *effective* value (default merged with any override).

## Sources & syncing

A repo stays current with its source(s). For a repo created by `attach` (which points it at a directory), the built-in freshness/watch machinery keeps it fresh with no extra setup:

```bash
omg sync            # one-shot: re-ingest anything changed on disk since last ingest
omg watch           # stay live: an external fs-adapter process streams edits; the engine reconciles them
```

`omg source` is the general registry when a repo needs an explicit or additional source:

```bash
omg source add notes-fs --root ./notes    # register a filesystem source (adapter defaults to fs)
omg source attach notes-fs                 # bind it to the current repo
omg source list                            # sources + which repos they feed
omg source detach notes-fs                 # unbind (rm to delete)
```

### The standalone synchronizer (`omgbase-sync`)

`@omgbase/sync` is a separate coordinator that mirrors a store against an omgbase repo reached **over MCP** — the same tools an agent uses. This is how you sync against a **remote or headless** server, or run sync as its own process:

```bash
# Mirror a directory into the repo served by an MCP server (spawned as `omg mcp` by default):
omgbase-sync --root ./my-vault              # one initial sync (filesystem → engine)
omgbase-sync --root ./my-vault --watch      # stay live: mirror edits as they land
omgbase-sync --root ./my-vault --out        # also export engine-authored changes back to disk
omgbase-sync --root ./my-vault --server "omg mcp -C /path/to/vault"   # custom / remote server command
```

Under the hood it fetches changed files from a source adapter and calls the engine's `observe` / `observe_many` tools (whole-file bytes → an *observed* commit, reconciled and echo-suppressed engine-side); the export direction polls `changes_since` and writes engine-authored changes back out. It never re-implements reconciliation — that stays in the engine (`docs/sync-service-design.md`, ADR-014).

### Remote / headless servers

Because the engine's database already holds a **byte-exact** representation of every file (blocks' retained bytes + trivia + frontmatter; `docs_read` reconstructs the file byte-for-byte), a server needs **no local working tree**. A repo with no attached source is *headless* — the DB is the source of truth for content, and `omgbase-sync` (or any MCP client) syncs bytes in via `observe` and out via `changes_since` + `docs_read`. Mutations on a headless repo commit to the DB and skip the file write entirely.

### Interactive shell

`omg shell` opens a persistent in-process session: one workspace/store stays open, so the per-command startup cost is paid once. Beyond speed it adds **ephemeral typed session bindings** over results — a command's structured result (the same object `--json` emits) is captured *before* rendering and becomes addressable with `@`. Filtering, traversal, and projection stay in OQX; the shell just stores and dereferences.

```
omg> query 'from docs where layer == "canon"'
d_a83f  projects/foo.md
d_194c  projects/bar.md
  2 rows — address with @1..@2
omg> show @1                       # @N = row N of the last displayed collection (1-based)
omg> let canon = query 'from docs where layer == "canon"'   # let binds a snapshot, not a live query
omg> show @canon[1]                # @name[i] / @name.field — shallow addressing only
omg> query 'from nodes where kind == "md:task" && !attrs.checked'
omg> done @1                       # references substitute into any command's args
```

`@_` is the previous result; `bindings` lists them, `unset x` drops one, `exit` (or Ctrl-D) leaves. On a TTY it's a readline REPL; with piped stdin it runs one command per line (`#` comments and blanks ignored) — the same `ShellSession` runtime that a Markdown CLI-session test would drive. Full reference: `docs/cli.md` §5.7a.

### MCP server

`omg mcp` serves the full engine tool surface over stdio, with an in-process watcher so the session stays fresh. The host (Claude Code, Cursor, …) owns the process lifetime — the one-line integration:

```json
{ "command": "omg", "args": ["mcp", "-C", "/path/to/vault"] }
```

## Quickstart (library)

The engine can also be used directly as a library via `@omgbase/core`. All functions take a `Store` and a `repoId`.

### Attach a directory and query it

```ts
import { Store, attachRepo, oqxRun, docsOutline } from "@omgbase/core";

// Open (or create) the engine database. Use ":memory:" for tests.
const store = new Store({ path: "/path/to/vault/.omgbase/omgbase.db" });

// Walk a directory tree: ingest every file (md/yaml/json), thread identity, extract edges.
const { repoId } = attachRepo(store, "my-vault", "/path/to/vault");

// OQX is the one query + traversal language (see docs/query-language.md).
// Blocks under a heading:
const tasks = oqxRun(store, repoId, 'from blocks where type == "task" && !attrs.checked && under_heading("Launch")', { limit: 50 });

// Across formats — YAML configs referencing a specific host:
const configs = oqxRun(store, repoId, 'from docs where format == "yaml" && database.host == "localhost"');

// Nodes — unchecked tasks across all markdown files:
const openTasks = oqxRun(store, repoId, 'from nodes where kind == "md:task" && attrs.checked == false');
console.log(tasks.hits, configs.hits, openTasks.hits);

// Compact orientation outline of one document.
const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get("notes.md") as { doc_id: string };
console.log(docsOutline(store, doc.doc_id).text);
```

### Watch for human edits

Live watching runs in an **external adapter process** — chokidar lives in `@omgbase/fs-adapter` (spoken to over a stdio protocol), so the engine core carries no filesystem-watch dependency. The engine wraps the spawned adapter as a `SyncSource` and reconciles the batches it streams (design in `docs/sync-plugins.md`).

```ts
import { Watcher, createExternalSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import { execPath } from "node:process";

// Spawn the filesystem adapter as an external process and present it as a source.
const source = await createExternalSource({
  command: execPath,
  args: [fsAdapterBinPath(), "--root", "/path/to/vault"],
});

const watcher = new Watcher(store, repoId, source, {
  onCheckpoint: (cp) => console.log("ingested", cp.ingested),
});
await watcher.start();
// Human saves are debounced (adapter-side) into checkpoints; the engine
// reconciles block identity and maintains the graph + indexes automatically.
// On shutdown: await watcher.stop(); await source.close();
```

For one-shot, non-watching ingestion (used by `omg init`/`attach`/`sync`), the synchronous filesystem fast-path is still available directly as `attachRepo(store, slug, rootPath)` and `freshnessSweep(store, repoId, rootPath)`.

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

Tools exposed (the authoritative list is the registrations in `packages/core/src/mcp/server.ts`): reads — `docs_outline`, `docs_read`, `docs_get_many`, `nodes_get`, `nodes_get_many`, `query`, `query_syntax`, `graph`, `text_search`, `resolve`; writes — `apply`, `tasks_complete`, `node_set`, `sections_append`, `docs_append`, `links_stale`, `links_retarget`, `links_repair`, `docs_create`, `docs_move`, `docs_delete`, `docs_set_meta`, `docs_plan_update`, `docs_update`; sync — `observe`, `observe_many`, `observe_delete`; history — `history_node`, `diff`, `docs_read_at`, `docs_history`, `changes_since`; admin — `repos_status`, `sync_status`. Every list result carries `truncated` + a cursor. `docs_read` returns a whole document in one call — full file bytes (byte-exact) plus properties grouped by source. `observe`/`observe_many`/`observe_delete` are the sync-ingest surface (file→DB, observed-origin, echo-suppressed) that `@omgbase/sync` drives; `changes_since` digests carry per-revision `contentHash` for the export direction.

### Synchronize a source into a repo (library)

`@omgbase/sync` reconciles a `SyncSource` (external store) with an omgbase repo reached through an `EngineClient` — `InProcessEngineClient` (direct `Store`) locally, or `McpEngineClient` (over MCP) against a remote/headless server. The `Coordinator` owns the loop; the engine owns reconciliation.

```ts
import { Coordinator, InProcessEngineClient, connectStdioEngine } from "@omgbase/sync";
import { createExternalSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import { execPath } from "node:process";

// A filesystem source (external adapter process) …
const source = await createExternalSource({ command: execPath, args: [fsAdapterBinPath(), "--root", "/path/to/vault"] });

// … synced against a local in-process engine …
const engine = new InProcessEngineClient(store, repoId);
// … or a remote/headless server over MCP:
//   const engine = await connectStdioEngine({ command: "omg", args: ["mcp", "-C", "/path/to/vault"] });

const coord = new Coordinator(engine, source);
await coord.syncIn();                       // filesystem → engine (initial ingest, echo-suppressed)
await coord.syncOut();                       // engine → filesystem (export engine-authored changes)
const sub = await coord.watchIn({ onSummary: (s) => console.log("mirrored", s) });  // stay live
// On shutdown: await sub?.stop(); await source.close(); await engine.close();
```

### Semantic search (optional)

Semantic ranking needs an embedding provider, opt-in. `embedding.provider` names an **external embedder** — either a command the engine spawns and talks to over a stdio JSON protocol, or an `http(s)` endpoint — so the engine and CLI carry no ML dependency. The default local embedder ships as `@omgbase/embedder` (transformers.js + all-MiniLM-L6-v2, 384-dim), exposed as the `omgbase-embedder` binary. Set it at the **workspace** layer (`--repo ""`) so every repo shares one vector space:

```bash
# omgbase-embedder is on PATH after `pnpm rlink`
omg config set embedding.provider omgbase-embedder --repo ""   # a command (stdio), workspace-wide …
omg config set embedding.provider https://embed.internal/embed --repo ""   # … or an http endpoint
omg embed drain                         # embed the corpus (prints an egress note for remote providers)
omg q --semantic "crash safety and durability" -n 5
omg find "how are ids kept stable"      # hybrid FTS ⊕ vector by default when a provider is set
```

Without a configured provider, semantic queries return `semantic_unavailable`. The provider contract is `embed(texts) => Promise<number[][]>`; a remote HTTP embedder is the same contract behind a URL.

```ts
import { EmbeddingWorker } from "@omgbase/core/search/embeddings";
import { hybridSearch } from "@omgbase/core/search/rrf";

const worker = new EmbeddingWorker(store, myProvider);   // provider = { model, dim, embed() }
const vec = await worker.embedQuery("stable identity across edits");
const hits = hybridSearch(store, { repoId, text: "identity", vector: { model: myProvider.model, vec } });
```

## Reading the design

Start with the repo-root `AGENTS.md` (orientation + the `docs/` trust index), then `docs/README.md`. The `docs/` are maintained as an **as-built** description of the implementation: where a doc and the code disagree, **the code wins** — fix the doc. `docs/decisions.md` is the ADR log (the "why"); `docs/sync-service-design.md` (ADR-014) is the forward design for the sync service migration.

## License

Not yet specified.
