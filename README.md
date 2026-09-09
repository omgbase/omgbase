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
- **an MCP server** — the whole surface exposed as Model Context Protocol tools.

The files are always the source of truth for *content*; the engine's database owns *identity, history, and derived indexes*. At quiescence, `sha256(file) == current_revision.rendered_hash` for every tracked document with a round-trip renderer.

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

A single-writer engine process sits beside one or more working trees ("repos"). It watches the filesystem and ingests human edits (observation path), applies structural mutations from agents (intent path), and serializes all state changes through one append-only commit log per repo, backed by embedded SQLite (WAL) under `.omgbase/`.

The repo is a pnpm workspace of five packages:

```
packages/
  core/          @omgbase/core — the embedded engine
    src/
      core/      parse · blocks · splice · hashing · ids · SQLite store · revisions · commits
      format/    adapter contract · registry · markdown/yaml/json adapters · node projection
      reconcile/ matcher phases · scoring · dispositions · eval harness
      sync/      external-source bridge · driver · checkpoints · reconciling ingest · settings layering · watcher
      mutate/    six kernel ops · changesets · CAS · macros
      graph/     edge extraction · intervals · traversal · history/diff
      search/    CEL query compiler · FTS · embeddings · vector · RRF · resolve/pipeline
      mcp/       MCP server · tools · error mapping
      migrate/   mrplex importer
    corpus/      round-trip + matcher fixtures
  cli/           omgbase — the `omg` CLI binary (depends on @omgbase/core + @omgbase/fs-adapter)
  client/        @omgbase/client — thin remote MCP client (placeholder)
  embedder/      @omgbase/embedder — external embedding provider (transformers.js + all-MiniLM-L6-v2)
  fs-adapter/    @omgbase/fs-adapter — external filesystem sync adapter (owns chokidar; stdio protocol)
docs/            normative design documents
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

Document-level properties live in one indexed `properties` table (design in `docs/12-properties-table.md`), unifying three sources under a single query surface — no per-document JSON blob:

- **frontmatter** — the parsed YAML fence (markdown), or the whole parsed object (YAML/JSON files);
- **inline** — dataview-style `key:: value` fields in body text, accumulating across occurrences;
- **computed** — engine-derived `$`-intrinsics (`$title` from the first H1, `$tags` from body `#hashtags`) that never shadow authored keys.

A CEL bare key (`layer == "canon"`) queries the authored union (frontmatter + inline) as an indexed seek; `frontmatter.<k>` / `inline.<k>` narrow to one source; `$title` / `$tags` address the computed ones. A per-value `card` flag records the authored scalar-vs-list shape, so scalar `==`/`!=`/`<` match scalar-authored values while `list()` spans all — preserving the exact CEL semantics across the row-backed store.

### Structural query functions

In addition to the core CEL filter language (see `docs/10-query-language.md`), the query system provides format-aware structural functions for the `blocks` target:

- `under_heading("Setup")` — markdown blocks under a heading (section range)
- `under_kind("yaml:mapping_entry", "database")` — blocks nested under an ancestor of the given kind
- `yaml_path("database.host")` — blocks at a YAML key path (walks parent chain)
- `json_pointer("#/definitions/User")` — blocks at a JSON Pointer path

## Quickstart (CLI)

The `omgbase` CLI (`packages/cli`, aliased `omg`) is the engine's second client — a thin adapter over `@omgbase/core`, embedded and daemonless (design in `docs/11-cli.md`, ADR-012). The full command surface is implemented: bootstrap (`init`, `attach`, `repos`), reads (`status`, `ls`, `outline`, `cat`, `show`, `find`, `query`, `run`, `log`, `hist`, `diff`, `links`, `graph`), writes (`apply` + sugar: `insert`/`update`/`edit`/`move`/`rm`/`done`/`append`/`retarget`/`split`/`merge`, and doc-level `new`/`mv`/`meta`), and sync/serve/admin (`sync`, `watch`, `mcp`, `rebuild-index`, `gc`, `doctor`, `config`, `import`, `embed`).

**Workspace, repo, config — the three things to know first.**

- A **workspace** is the `.omgbase/` directory + its SQLite database. It is *not* the content — it can live in a project root, a notes directory, or `$HOME`. Commands find it by walking up from the cwd.
- A **repo** is a named, synced scope *inside* a workspace. One workspace can hold many. Today a repo is backed by a filesystem directory (its `root_path`); the sync layer is being generalized to external adapters (git/GitHub/Linear — see `docs/13-sync-plugins.md`).
- **Config** is one settings schema at **two layers**: values set at the **workspace** layer are *defaults* that every repo inherits; a repo can *override* any key. This is why an embedder is set once for the whole workspace (so every repo shares one vector space) while something like `gc.enabled` is set per repo.

```bash
pnpm -r build           # build all packages (core, cli, embedder, fs-adapter)
pnpm rlink              # globally link binaries (omg, omgbase, omgbase-embedder, omgbase-fs-adapter)

# --- bootstrap ------------------------------------------------------------
omg init ./my-vault --yes   # create the workspace + attach ./my-vault as a repo + ingest
cd ./my-vault
omg status                  # where am I: repo, sync, watcher, queue
omg repos                   # list every repo in this workspace

# --- config (workspace default vs repo override) --------------------------
omg config set embedding.provider omgbase-embedder --repo ""   # --repo "" ⇒ workspace default
omg config list --repo ""                                       # show workspace defaults
omg config list                                                 # effective view for this repo (◆ = overridden)
omg config set gc.enabled true                                  # no --repo ⇒ this repo's layer

# --- reads (current by default) -------------------------------------------
omg outline notes/hub.md                # compact orientation outline (frozen wire format)
omg q 'type == "task" && !attrs.checked' --text deploy --ids | omg cat -   # pipe fuel
omg log --since 24h                     # one commit digest per line
omg find "stable identity rationale" -1 # top hit's id alone

# --- writes — the pipe is the changeset boundary --------------------------
omg q 'type == "task" && !attrs.checked && under_heading("Launch")' --ids | omg done -
omg retarget old.md new.md              # plan by default; add --apply to commit
omg edit b_k7z2p9q                       # $EDITOR round-trip, CAS pinned
```

**Config scope in one rule:** `omg config` targets the repo you're in (by cwd or `--repo <slug>`); pass `--repo ""` to target the workspace default layer; at the workspace root of a multi-repo workspace, a bare `omg config` falls back to the workspace layer. `get` returns the *effective* value (default merged with any override); `list --repo <slug>` marks overridden keys with `◆`.

Reads are **current by default**: before each command a freshness sweep re-ingests any files changed on disk since the last ingest (skip with `--stale`, or run a `watch`er). Human output is colorized and glyph-rich on a capable TTY; `--json`/`--jsonl`/`--ids` emit machine data verbatim, and `NO_COLOR`/pipes degrade to plain text automatically.

### MCP server

`omg mcp` serves the full engine tool surface over stdio, with an in-process watcher so the session stays fresh. The host (Claude Code, Cursor, …) owns the process lifetime — the one-line integration:

```json
{ "command": "omg", "args": ["mcp", "-C", "/path/to/vault"] }
```

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

// Walk a directory tree: ingest every file (md/yaml/json), thread identity, extract edges.
const { repoId } = attachRepo(store, "my-vault", "/path/to/vault");

// CEL query over blocks (see docs/10-query-language.md for the full language).
const { hits } = query(store, repoId, {
  from: "blocks",
  filter: 'type == "task" && !attrs.checked && under_heading("Launch")',
  limit: 50,
});

// Query across formats: find YAML configs referencing a specific host.
const yamlHits = query(store, repoId, {
  from: "docs",
  filter: 'format == "yaml" && database.host == "localhost"',
});

// Query nodes: find unchecked tasks across all markdown files.
const tasks = query(store, repoId, {
  from: "nodes",
  filter: 'kind == "md:task" && attrs.checked == false',
});

// Compact orientation outline of one document.
const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get("notes.md");
const outline = docsOutline(store, doc.doc_id);
console.log(outline.text);
```

### Watch for human edits

Live watching runs in an **external adapter process** — chokidar lives in `@omgbase/fs-adapter` (spoken to over a stdio protocol), so the engine core carries no filesystem-watch dependency. The engine wraps the spawned adapter as a `SyncSource` and reconciles the batches it streams (design in `docs/13-sync-plugins.md`).

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

Tools exposed: `docs_outline`, `docs_read`, `nodes_get`, `nodes_get_many`, `query`, `query_syntax`, `graph_syntax`, `text_search`, `resolve`, `apply`, `tasks_complete`, `sections_append`, `links_retarget`, `docs_create`, `docs_move`, `docs_delete`, `docs_set_meta`, `graph_traverse`, `graph_path`, `history_node`, `diff`, `changes_since`, `repos_status`, `sync_status`. Every list result carries `truncated` + a cursor; every hydrating tool honors `budget_tokens`. `docs_read` returns a whole document in one call — full file bytes (byte-exact) plus properties grouped by source.

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

Start with `docs/README.md`, then the numbered documents. They are normative: where code and docs disagree, the docs win until an ADR (`docs/08-decisions.md`) says otherwise.

## License

Not yet specified.
