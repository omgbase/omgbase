# omgbase — the `omg` CLI

`omg` (also installed as `omgbase`) is the command-line client for **Open Markdown Graph Base**: a versioned, addressable graph layer over a directory of Markdown/YAML/JSON files. Your files stay the human source of truth; an embedded SQLite database under `.omgbase/` owns block identity, history, links, and the indexes you query. The CLI is the engine's second client — a thin adapter over [`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core), **embedded and daemonless**: every command opens the database directly, does its work in-process, and exits. Design notes live in the [monorepo README](https://github.com/omgbase/omgbase#readme) and [`docs/cli.md`](https://github.com/omgbase/omgbase/blob/main/docs/cli.md).

## Install

```bash
npm install -g omgbase              # the `omg` and `omgbase` binaries (Node >= 22)
npm install -g @omgbase/embedder    # optional: local semantic search
```

`@omgbase/embedder` provides `omgbase-embedder`, a local transformers.js model (`Xenova/gte-base`, 768-dim) spoken to over stdio, so the CLI itself carries no ML dependency. Without it, full-text search, queries, and edits all work; `omg find` and OQX `semantic("…")` just have no embedding index to rank by. `omg init` offers to configure it when it is on `PATH`, or set it later with `omg config set embedding.provider omgbase-embedder --repo ""`.

## Five-minute tour

A throwaway directory with two Markdown files, `README.md` (a heading, a task list, a `[[decisions]]` link) and `decisions.md` (frontmatter plus two ADR headings). Every transcript below is real output.

```console
$ omg init
  not inside a git repo — no .gitignore needed for .omgbase/
  omgbase  >  initialized
  ----------------------------------------
  ok workspace  /private/tmp/omg-tour/notes
  next: omg source add . to point a repo at a directory of files

$ omg source add . -y
  * notes ← /private/tmp/omg-tour/notes  2 files

$ omg status
  omgbase  >  notes
  /private/tmp/omg-tour/notes
  ----------------------------------------
  [D] docs  2             watcher o none
  [B] blocks  13          synced  ok converged
  * commits  2            queue   empty
  > edges  1              commit# 2

$ omg ls
README.md     8 blocks  0s ago
decisions.md  5 blocks  0s ago
```

`init` creates the workspace and ingests nothing; `source add` points a repo at a directory (the repo takes the directory's name) and runs the initial sync. Now find and query:

```console
$ omg find sqlite
b_v32ar6f  decisions.md#heading[3]  ADR-002 Embedded SQLite

$ omg q 'from blocks where type == "task" && !attrs.checked'
b_24nr0y0  README.md
b_36p2zw1  README.md

$ omg q '$repo.blocks count { where type == "task" && !attrs.checked }'
2

$ omg outline README.md
  omgbase  >  README.md
  ----------------------------------------
b_7046e9t h1   Project notes  §
b_y9cqtgq p    A small vault to try out omgbase.
b_e1x1y8p h2   Launch  §
b_zysh41w ul
  b_36p2zw1 li   ☐ Write the announcement
  b_24nr0y0 li   ☐ Ship the release
  b_1nrsgvf li   ☑ Pick a date
b_1w4t737 p    See [[decisions]] for the why.

$ omg cat b_v32ar6f --resolution text
ADR-002 Embedded SQLite
```

`omg cat <path>` prints a document's exact bytes (frontmatter and all); given a block id it prints that block. Edits are structural mutations that update the file and the database together. The pipe is the changeset boundary — `--ids` emits block ids, `done -` reads them from stdin and completes them in one commit:

```console
$ omg q 'from blocks where type == "task" && !attrs.checked' --ids | omg done -
  ok committed · 1 document touched
b_24nr0y0
b_36p2zw1

$ omg append b_e1x1y8p -m 'Shipped on time.'
  ok committed · 1 document touched
b_qb861mj

$ omg cat README.md | tail -3
See [[decisions]] for the why.

Shipped on time.

$ omg log
#1 observed observed: README.md — 8 inserted
#2 observed observed: decisions.md — 5 inserted
#3 api      api(human:alice): README.md — 8 edited
#4 api      api(human:alice): README.md — 8 edited, 1 inserted
```

Every edit is a commit; `omg hist <block>` is one block's biography and `omg diff <doc>` a unified diff. More worked examples (a larger corpus, the OQX tutorial, the interactive shell) are under [`examples/`](https://github.com/omgbase/omgbase/tree/main/examples).

## Command catalog

Grouped exactly as `omg --help` prints them; `omg <command> --help` gives one uniform card per command.

**bootstrap**
- `init` — Create a workspace (run `source add` to ingest files)
- `source` — Where a repo's bytes come from (add/list/attach/detach/rm)
- `repos` — List repos in this workspace

**orient & read**
- `status` — Where am I: repo, sync, watcher, queue
- `ls` — List live documents
- `outline`, `ol` — Document outline (frozen wire format)
- `cat` — Content bytes of a node (default raw)
- `show` — Metadata card for a node
- `find` — Ranked hybrid search for the id of a thing

**query**
- `query`, `q` — Composable query (OQX: from/where/select + collection ops)
- `run` — Evaluate an ```` ```omg ```` fence (OQX, inert, read-only)

**history & links**
- `log` — Commit digests (change feed)
- `hist` — A block's change biography
- `diff` — Unified diff of a document
- `links` — Open edges touching a node

**mutate**
- `apply` — Apply a raw changeset (the primitive)
- `insert` — Insert blocks under a parent
- `update` — Replace a block, or reconcile a whole document (identity-preserving)
- `edit` — Edit a block in `$EDITOR` (CAS pinned)
- `move` — Move blocks under a new parent
- `rm` — Remove blocks (or `--doc` a document)
- `done` — Check/uncheck task blocks
- `append` — Append into a heading's section
- `retarget` — Rewrite a link target (plan-by-default)
- `split` — Split a block at offsets
- `merge` — Merge adjacent blocks
- `node` — Edit a node's editable properties (surgical)

**documents**
- `new` — Create a document
- `mv` — Rename a document
- `meta` — Patch a document's frontmatter

**session**
- `shell` — Persistent session with typed bindings (`@1`/`@_`/`@name`)

**sync & serve**
- `sync` — Reconcile a repo with its filesystem source (`--watch` to stay live; `--server` for remote)
- `mcp` — Serve the MCP tool surface on stdio

**admin**
- `rebuild-index` — Rebuild derived tables
- `gc` — Mark-and-sweep (flag-gated)
- `doctor` — Invariant sweep (CI-able)
- `config` — Read/write repo settings
- `embed` — Embedding queue: status, or drain to embed

## MCP server

`omg mcp` serves the full engine tool surface over stdio with an in-process file watcher, so an agent session stays fresh; the host owns the process lifetime. Hosts launch servers from their own cwd, so point `-C` at an initialized workspace (a directory at or below one containing `.omgbase/`). Run outside a workspace it fails with `repo_not_found` and prints the `-C` form to use.

Claude Code:

```bash
claude mcp add omg -- omg mcp -C /path/to/vault
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`), and any host that takes an `mcpServers` map:

```json
{ "mcpServers": { "omg": { "command": "omg", "args": ["mcp", "-C", "/path/to/vault"] } } }
```

Add `--repo <slug>` to `args` when the workspace holds several repos, and `--no-watch` to skip the in-process watcher (it is auto-off when another live watcher already holds the lease).

## Remote mode

The global `--server <cmd|url>` flag runs the same command against a **remote engine over MCP** instead of the embedded local store: an `http(s)://` value connects over Streamable HTTP (add headers with repeatable `-H "Name: value"`), anything else is a command spawned and spoken to over stdio, e.g. `omg --server "omg mcp -C /path/to/vault" ls`. Implemented for the reads `sync`, `query`, `outline`, `hist`, `cat`, `ls`, `diff`, `find`, `log`; the doc-level mutators `new`, `mv`, `meta`, `rm`, `update`, `retarget`; the block-level sugar `apply`, `insert`, `move`, `split`, `merge`, `done`, `append`, `node`; and `shell`. Other commands (`status`, `edit`, `init`, `source`, admin) reject `--server` with a usage error rather than silently running locally.

## Output contract

Global flags are recognized anywhere on the line: `-C <dir>`, `--repo <slug>`, `--json`, `--jsonl`, `--ids`, `--stale`, `--no-color`, `--dry-run`, `--server <cmd|url>`, `-H <header>`, `--help`/`-h`, `--version`/`-V`.

- Human output (default) is colorized on a TTY; `--no-color`, `NO_COLOR`, or a pipe degrades to plain text.
- Query hits (`omg q`, `omg run`) print as `<id>  <path>` lines. When the query projects (`select …`), they print as an aligned table instead: a dim header row, the id first, then the path (unless the projection itself selects `$path`), then the projected columns in `select` order. Strings and numbers are verbatim, an absent field is an empty cell, and a nested list/record is compact JSON clipped at 60 characters with `…`; `--jsonl` has the full values.
- `--json` prints the library's result object verbatim as one JSON document (the same shape the MCP tools return). `--jsonl` flattens list results to one object per line; `--ids` prints bare ids/paths, one per line — pipe fuel for `omg cat -`, `omg show -`, `omg done -`.
- `--dry-run` is global across every mutator: full validation and render, diffs printed, nothing committed.
- Errors always go to stderr: `error[<code>]: <message>` plus any conflict payload, or the typed error object as JSON with `--json`.
- Truncated list results print `… truncated; continue with --cursor <c>` on stderr and still exit 0.

Exit codes: `0` success (including truncated); `1` typed engine error or conflict; `2` CLI usage error (unknown command or flag, missing argument, `--server` on an unsupported command).

## Freshness

Reads are current by default: before running, a command sweeps the repo's files for changes since the last ingest and re-ingests what moved (tens of milliseconds when nothing changed). Skip the sweep with `--stale`, or run `omg sync --watch` — a live watcher holds a lease on `.omgbase/watch.lock`, and commands that see a live lease skip the sweep. `omg status` reports `watcher: live` or `none`.

## License

MIT
