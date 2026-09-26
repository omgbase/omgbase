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

The engine is feature-complete and tested: round-trip fidelity, core store, identity reconciliation, mutation & concurrency, graph, retrieval, agent ergonomics, and hardening are all built. A **store-to-store sync layer** (`@omgbase/sync`, ADR-014) is built: the source registry (`omg source`), the `observe`/`observe_many`/`observe_delete` MCP surface, the headless `DocStore` seam, and the standalone `omgbase-sync` coordinator. A repo now owns identity, not a filesystem — its bytes come from an attached source, the legacy `repos.root_path` column has been removed (schema v13; `RepoRow.rootPath` is derived), and sourceless/headless repos are first-class. See `docs/` for the as-built design reference and the repo-root `AGENTS.md` for orientation.

## Install

Requires **Node ≥ 22**.

### From npm

```bash
npm install -g omgbase              # the `omg` and `omgbase` binaries
npm install -g @omgbase/embedder    # optional: local semantic search (`omgbase-embedder`)
```

`omgbase` pulls in the engine (`@omgbase/core`), the filesystem source adapter (`@omgbase/fs-adapter`), and the sync coordinator (`@omgbase/sync`). The optional `@omgbase/embedder` runs sentence embeddings locally with transformers.js (default model `Xenova/gte-base`, 768-dim; weights download to the transformers.js cache on first run, then work offline) and is spoken to over stdio, so the engine and CLI carry no ML dependency. `omg init` offers to configure it as the workspace's `embedding.provider` when `omgbase-embedder` is on `PATH`. Note: under allow-scripts policies (npm `ignore-scripts`, pnpm `allowBuilds`) the `onnxruntime-node` postinstall may be skipped; if the embedder then fails to start (`embedder_failed`), allow that package's build script and reinstall.

### From source

Needs **pnpm 12** (the workspace `packageManager`).

```bash
git clone https://github.com/omgbase/omgbase && cd omgbase
pnpm install
pnpm build          # tsc -b across the workspace
pnpm rlink          # link every bin package globally: omg, omgbase, omgbase-sync, omgbase-embedder, omgbase-fs-adapter
```

`pnpm rlink` runs `pnpm add -g .` in each package that declares a `bin`, so it needs a configured pnpm global bin directory (`pnpm setup` once, then reopen the shell). The resulting shims point at the clone's `dist/`, so a later `pnpm build` is picked up without relinking.

### Developing

```bash
pnpm build && pnpm test   # vitest across the workspace; the cli package also replays the examples/ transcripts
pnpm lint
```

## Architecture at a glance

A single-writer engine process sits beside one or more working trees ("repos"). It watches the filesystem and ingests human edits (observation path), applies structural mutations from agents (intent path), and serializes all state changes through one append-only commit log per repo, backed by embedded SQLite (WAL) under `.omgbase/`.

The repo is a pnpm workspace of seven packages:

```
packages/
  core/          @omgbase/core — the embedded engine (README: packages/core/README.md)
    src/
      core/      parse · blocks · splice · hashing · ids · SQLite store · revisions · commits
      format/    adapter contract · registry · markdown/yaml/json adapters · node projection
      reconcile/ matcher phases · scoring · dispositions · eval harness
      sync/      observe primitive · source registry · external-source bridge · driver · checkpoints · watcher
      mutate/    six kernel ops · changesets · CAS · macros · DocStore seam
      graph/     edge extraction · intervals · traversal · history/diff
      oqx-js/    OQX bindings — the store `DataContext` + `oqxRun` over @omgbase/oqx (`oqx/` is a thin re-export)
      search/    FTS · embeddings · vector · RRF · resolve/pipeline
      mcp/       MCP server · tools · error mapping
    corpus/      round-trip + matcher fixtures
  oqx/           @omgbase/oqx — the OQX query language + engine (standalone, zero deps, own version line; omgbase binds it in core/src/oqx-js/) (README: packages/oqx/README.md)
  cli/           omgbase — the `omg` CLI binary (depends on @omgbase/core + @omgbase/fs-adapter + @omgbase/sync) (README: packages/cli/README.md)
  sync/          @omgbase/sync — standalone store-to-store synchronizer (coordinator + `omgbase-sync` bin) (README: packages/sync/README.md)
  client/        @omgbase/client — thin remote MCP client (placeholder) (README: packages/client/README.md)
  embedder/      @omgbase/embedder — external embedding provider (transformers.js + Xenova/gte-base, 768-dim) (README: packages/embedder/README.md)
  fs-adapter/    @omgbase/fs-adapter — external filesystem sync adapter (owns chokidar; stdio protocol) (README: packages/fs-adapter/README.md)
docs/            as-built design reference · decision log (ADRs)
crates/          the Rust side (cargo workspace at the root; independent of pnpm)
  oqx/           oqx — Rust implementation of OQX, conformant to spec/oqx (README: crates/oqx/README.md)
  omgbase-format/ omgbase-format — Rust format layer: source → block tree, splice render, conformant to spec/format
  omgbase-reconcile/ omgbase-reconcile — Rust block-identity matcher (phases, dispositions, cross-doc moves), conformant to spec/reconcile
  omgbase-store/ omgbase-store — Rust store: the SQLite schema, observe/commit, Merkle trees, reconstruct; opens the same database as core, conformant to spec/store
spec/            language-neutral specifications both sides run: oqx/ (grammar, semantics, fixtures) · format/ (block model, fixtures generated from core's round-trip corpus) · reconcile/ (the matcher: rules, thresholds, fixtures with reference-generated expectations) · store/ (the database: schema.sql verbatim, the observe procedure, invariants, observation-script fixtures)
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

Cross-format edges compose seamlessly: a markdown doc linking to a YAML config, which `extends` a base YAML file and references a JSON schema, produces a traversable graph that one OQX `follow doc.out` query (or the `graph` MCP tool, which compiles to it) walks in one call.

Block kinds use a colon-separated format qualifier for non-markdown formats: `yaml:mapping_entry`, `json:property`, `yaml:scalar`. Markdown block types remain unqualified for backward compatibility: `heading`, `paragraph`, `task`, `code_fence`, etc.

### Document properties

Document-level properties live in one indexed `properties` table (design in `docs/properties-table.md`), unifying three sources under a single query surface — no per-document JSON blob:

- **frontmatter** — the parsed YAML fence (markdown), or the whole parsed object (YAML/JSON files);
- **inline** — dataview-style `key:: value` fields in body text, accumulating across occurrences;
- **computed** — engine-derived `$`-intrinsics (`$title` from the first H1, `$tags` from body `#hashtags`) that never shadow authored keys.

An OQX bare key (`from docs where layer == "canon"`) queries the authored union (frontmatter + inline) as an indexed seek; `frontmatter.<k>` / `inline.<k>` narrow to one source; `$title` / `$tags` address the computed ones. A per-value `card` flag records the authored scalar-vs-list shape, so scalar `==`/`!=`/`<` match scalar-authored values while `list()` spans all — the `@omgbase/oqx` scalar semantics hold across the row-backed store (see `docs/query-language.md`).

### Structural query functions

In addition to the OQX query language (`@omgbase/oqx`; see `docs/query-language.md`), the store binding provides format-aware structural functions for the `blocks` target:

- `under_heading("Setup")` — markdown blocks under a heading (section range)
- `under_kind("yaml:mapping_entry", "database")` — blocks nested under an ancestor of the given kind
- `yaml_path("database.host")` — blocks at a YAML key path (walks parent chain)
- `json_pointer("#/definitions/User")` — blocks at a JSON Pointer path

## Quickstart (CLI)

The `omgbase` CLI (`packages/cli`, aliased `omg`) is the engine's second client — a thin adapter over `@omgbase/core`, embedded and daemonless (design in `docs/cli.md`, ADR-012). The full command surface is implemented (38 commands, registered in `packages/cli/src/commands.ts`): bootstrap (`init`, `source`, `repos`), reads (`status`, `ls`, `outline`/`ol`, `cat`, `show`, `find`, `query`/`q`, `run`, `log`, `hist`, `diff`, `links`), writes (`apply` + sugar: `insert`/`update`/`edit`/`move`/`rm`/`done`/`append`/`retarget`/`split`/`merge`/`node`, and doc-level `new`/`mv`/`meta`/`update`), the `shell` session, and sync/serve/admin (`sync` [`--watch`, `--server`], `mcp`, `rebuild-index`, `gc`, `doctor`, `config`, `embed`). `omg --help` prints the same catalog grouped by area.

### The mental model: workspace, repo, source, config

Four concepts, and getting them straight makes everything else obvious:

- A **workspace** is the `.omgbase/` directory + its SQLite database. It is *not* the content — it can live in a project root, a notes directory, or `$HOME`. Commands find it by walking **up** from the cwd (like `git`). One `omg init` creates one.
- A **repo** is a named scope *inside* a workspace that owns **identity + history** for a set of documents. One workspace can hold many repos; each has a `slug`. A repo does **not** intrinsically own a filesystem — it owns the versioned graph.
- A **source** is *where a repo's bytes come from*: a filesystem directory today (via the built-in `fs` adapter), git/S3/others later. A repo can have zero, one, or several attached sources — managed with `omg source`. (A repo with no source is **headless**: it lives entirely in the DB. See [Remote / headless](#remote--headless-servers).)
- **Config** is one settings schema at **two layers**: values set at the **workspace** layer are *defaults* every repo inherits; a repo can *override* any key. That's why an embedder is set once workspace-wide (so every repo shares one vector space) while something like `gc.enabled` is set per repo.

> There is no separate "attach/ingest/load" verb: `omg source add <dir>` is how content enters — it creates the repo if needed, registers the filesystem source, and runs the initial sync. The initial ingest is just that source's first sync (the same reconcile every later sync uses).

### 1. Get the binaries

`npm install -g omgbase` (plus `@omgbase/embedder` for semantic search), or from a clone `pnpm install && pnpm build && pnpm rlink` — see [Install](#install).

### 2. Create a workspace and point a repo at a directory

`init` creates the workspace **but ingests nothing** — pulling a directory of files in is a separate, consent-gated step, so `init` never silently absorbs whatever happens to live under the cwd.

```bash
omg init ./my-vault --yes         # create .omgbase/ + the DB (offers to .gitignore it)
cd ./my-vault
omg source add . -y --repo notes  # register this dir as the repo's fs source + initial sync
                                  # (slug defaults to the folder name; prompts without -y)

omg status                        # where am I: repo, sync state, watcher, embed queue
omg repos                         # every repo in this workspace: slug · root · doc/block counts
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

A repo stays current with its source(s). Once `omg source add <dir>` has pointed a repo at a directory, one verb keeps it fresh:

```bash
omg sync            # one-shot: re-ingest anything changed on disk since last ingest
omg sync --watch    # stay live: an external fs-adapter process streams edits; the engine reconciles them
```

(There is no separate `omg watch` — watching is `omg sync --watch`. And `omg sync` is just the explicit form of the freshness sweep every read already runs by default.)

`omg source` manages the registry — a repo can have more than one source, and existing sources can be re-bound:

```bash
omg source add ./notes --repo notes   # point a (new or current) repo at a dir + initial sync
omg source list                       # sources + which repos they feed
omg source attach notes-fs            # attach an existing source to the current repo
omg source detach notes-fs            # unbind (rm to delete)
```

### Remote / over-MCP sync (`--server`)

`omg sync` runs **in-process** against the local workspace by default. Point it at a server with the global **`--server`** flag and the *same command* runs against a **remote or headless** engine **over MCP** — the coordinator connects as an MCP client and drives the exact tools an agent uses:

```bash
omg sync --server "omg mcp -C /path/to/vault" --root ./my-vault           # one sync over MCP
omg sync --server "omg mcp -C /path/to/vault" --root ./my-vault --watch   # stay live over MCP
omg sync --server "…" --root ./my-vault --out                             # also export engine-authored changes back
```

`--server` is a **global flag** (ADR-014): the same command runs either embedded-local or remote-over-MCP. Remote mode is implemented for reads (`query`, `outline`, `hist`, `cat`, `ls`, `diff`, `find`, `log`), doc-level mutators (`new`, `mv`, `meta`, `rm`, `update`, `retarget`), block-level sugar (`apply`, `insert`, `move`, `split`, `merge`, `done`, `append`, `node` — ref resolution and CAS pinning happen server-side), `sync`, and `shell` (which threads `--server` into every line it runs) — the `REMOTE_OK` set in `packages/cli/src/context.ts`. The genuinely local-only commands (`edit`'s `$EDITOR` round-trip, `status`'s watcher state, `init`/`source`/admin) reject `--server` rather than silently running locally. `--server` takes either a stdio command (`"omg mcp -C /path"`) or an `http(s)` URL (with `-H "Name: value"` for extra headers).

The same coordinator ships as a standalone bin, **`omgbase-sync`**, for environments that don't have the full `omg` CLI — `omgbase-sync --root ./v [--watch] [--out]` is exactly `omg sync --server … --root ./v`. Under the hood both fetch changed files from a source adapter and call the engine's `observe` / `observe_many` tools (whole-file bytes → an *observed* commit, reconciled + echo-suppressed engine-side); the export direction polls `changes_since` and writes engine-authored changes back. Reconciliation never leaves the engine (`docs/sync-service-design.md`, ADR-014).

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

`omg mcp` serves the full engine tool surface over stdio, with an in-process watcher so the session stays fresh. The host (Claude Code, Claude Desktop, Cursor, …) owns the process lifetime. `-C` must point at an **initialized workspace** — a directory at or below one containing `.omgbase/` (`omg init <dir>` then `omg -C <dir> source add .`); hosts launch the server from their own cwd, so `omg mcp` in a directory without a workspace fails with `repo_not_found` and prints exactly that hint.

Claude Code:

```bash
claude mcp add omg -- omg mcp -C /path/to/vault
```

Claude Desktop (`claude_desktop_config.json`) and any other host that takes an `mcpServers` map:

```json
{ "mcpServers": { "omg": { "command": "omg", "args": ["mcp", "-C", "/path/to/vault"] } } }
```

Cursor (`.cursor/mcp.json`, project- or user-level) takes the same shape:

```json
{ "mcpServers": { "omg": { "command": "omg", "args": ["mcp", "-C", "/path/to/vault"] } } }
```

Add `--repo <slug>` to `args` when the workspace holds several repos, and `--no-watch` to skip the in-process watcher (it is auto-off when another live watcher holds the lease).

## Quickstart (library)

The engine can also be used directly as a library via `@omgbase/core`. All functions take a `Store` and a `repoId`.

### Attach a directory and query it

```ts
import { Store, ingestDirectory, oqxRun, docsOutline } from "@omgbase/core";

// Open (or create) the engine database. Use ":memory:" for tests.
const store = new Store({ path: "/path/to/vault/.omgbase/omgbase.db" });

// Walk a directory tree: create the repo (+ its fs source), ingest every file
// (md/yaml/json), thread identity, extract edges.
const { repoId } = ingestDirectory(store, "my-vault", "/path/to/vault");

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

For one-shot, non-watching ingestion, the synchronous filesystem fast-path is available directly as `ingestDirectory(store, slug, rootPath)` (a reconciling walk that also registers the repo's fs source) and `freshnessSweep(store, repoId, rootPath)` (what `omg sync` / `omg source add` use).

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

Tools exposed (45; the authoritative list is the `registerTool` calls in `packages/core/src/mcp/server.ts`): reads — `docs_outline`, `docs_read`, `docs_get_many`, `nodes_get`, `nodes_get_many`, `read_ref`, `docs_tree`, `docs_list`; search — `query`, `query_syntax`, `graph`, `text_search`, `resolve`; writes — `apply`, the block-level sugar `blocks_insert`/`blocks_update`/`blocks_move`/`blocks_remove`/`blocks_split`/`blocks_merge`, the macros `tasks_complete`/`node_set`/`sections_append`/`docs_append`/`links_retarget`/`links_repair` (+ the read-only `links_stale`), and the doc-level `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`/`docs_plan_update`/`docs_update`; sync — `observe`, `observe_many`, `observe_delete`; history — `history_node`, `diff`, `diff_unified`, `docs_read_at`, `docs_history`, `changes_since`; admin — `repos`, `repos_status`, `sync_status`. Every repo-scoped tool takes an optional `repo` slug; every list result carries `truncated` + a cursor. `docs_read` returns a whole document in one call — full file bytes (byte-exact) plus properties grouped by source. `observe`/`observe_many`/`observe_delete` are the sync-ingest surface (file→DB, observed-origin, echo-suppressed) that `@omgbase/sync` drives; `changes_since` digests carry per-revision `contentHash` for the export direction.

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

Semantic ranking needs an embedding provider, opt-in. `embedding.provider` names an **external embedder** — either a command the engine spawns and talks to over a stdio JSON protocol, or an `http(s)` endpoint — so the engine and CLI carry no ML dependency. The default local embedder ships as `@omgbase/embedder` (transformers.js + `Xenova/gte-base`, 768-dim; weights download on first run), exposed as the `omgbase-embedder` binary. Set it at the **workspace** layer (`--repo ""`) so every repo shares one vector space (`omg init` offers this automatically when `omgbase-embedder` is on `PATH`):

```bash
# omgbase-embedder is on PATH after `npm install -g @omgbase/embedder` (or `pnpm rlink` from a clone)
omg config set embedding.provider omgbase-embedder --repo ""   # a command (stdio), workspace-wide …
omg config set embedding.provider https://embed.internal/embed --repo ""   # … or an http endpoint
omg embed drain                         # embed the corpus (prints an egress note for remote providers)
omg q 'from blocks order by semantic("crash safety and durability") desc' -n 5   # semantic top-5: a score function becomes a ranking
omg find "how are ids kept stable" -n 5 # hybrid FTS ⊕ vector (RRF) by default when a provider is set
```

Without a configured provider, `semantic(…)` queries return `semantic_unavailable` (and `find` falls back to FTS alone); a configured-but-broken provider is a loud `embedder_failed`, never a silent downgrade. The provider contract is `embed(texts) => Promise<number[][]>`; a remote HTTP embedder is the same contract behind a URL.

```ts
import { EmbeddingWorker } from "@omgbase/core/search/embeddings";
import { hybridSearch } from "@omgbase/core/search/rrf";

const worker = new EmbeddingWorker(store, myProvider);   // provider = { model, dim, embed() }
const vec = await worker.embedQuery("stable identity across edits");
const hits = hybridSearch(store, { repoId, text: "identity", vector: { model: myProvider.model, vec } });
```

## Reading the design

Start with the repo-root `AGENTS.md` (orientation + the `docs/` trust index), then `docs/README.md`. The `docs/` are maintained as an **as-built** description of the implementation: where a doc and the code disagree, **the code wins** — fix the doc. `docs/decisions.md` is the ADR log (the "why"); `docs/sync-service-design.md` (ADR-014) is the design rationale + stage record for the sync service — implemented, all six stages.

## License

[MIT](./LICENSE).
