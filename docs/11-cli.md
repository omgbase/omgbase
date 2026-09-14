# omgbase — CLI Surface (`omg`)

**Status:** As-built (verified 2026-09-14 against `packages/cli/src/cmd/`, `dispatch.ts`, and `packages/core/src/sync/`). Implemented in `packages/cli` — the read surface (§5.1–5.5), the write surface (§5.6: `apply` + all sugar, `edit`, `node`, `new`/`mv`/`rm --doc`/`meta`), `run`, the persistent session `shell` (§5.7a), `sync`/`watch`/`mcp` (§5.8), and admin (§5.9: `rebuild-index`/`gc`/`doctor`/`config`/`import`/`embed`). Deferred items in §9 remain deferred. The doc-level ops (`docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`) are library functions in `@omgbase/core` and are registered as MCP tools (06). Semantic search is live: `embedding.provider` names an **external embedder** — a spawned command speaking a stdio JSON protocol, or an http(s) endpoint — so the engine and CLI carry no ML dependency. `@omgbase/embedder` ships the default local embedder as the `omgbase-embedder` binary (transformers.js + all-MiniLM-L6-v2); `embed status/drain`, `find`, and `query --semantic` use it when configured, else `semantic_unavailable`.
**Depends on:** `01-architecture.md` §11–12; `02-data-model.md` §2, §6; `04-mutation-and-concurrency.md` §6; `06-mcp-api.md` (tool semantics); `10-query-language.md` (envelope, fenced form).

The binary is canonically `omgbase`, with `omg` installed as a convenience alias (both `bin` entries point at the same script). Examples below use `omg` for brevity; every one is equally valid as `omgbase`.

---

## 1. Purpose and audiences

The CLI is the engine's **second client**. The MCP server is the first; both are thin adapters over the same library functions. The CLI MUST NOT contain business logic — if a command needs behavior the library lacks, the library grows it and both clients get it. (This rule is what keeps the library surface honest; the MCP server already enforces it from one side.)

Three audiences, in priority order:

1. **A human in a terminal** — orientation, search, history, quick fixes. Design metric: **fewest keystrokes to a correct answer** (the CLI analogue of 06's "agent reasoning round trips").
2. **Scripts and pipes** — `omg` composes with `grep`, `fzf`, `xargs`, `jq`. Every list can emit bare IDs; every mutator can read IDs from stdin.
3. **Agents with a shell** — agents that reach for Bash instead of MCP get the same tool surface with the same budgets, truncation honesty, and typed errors.

## 2. Invocation model

### 2.1 Workspace discovery

Like git: walk up from the current directory looking for `.omgbase/`. The directory that contains `.omgbase/` is the **workspace**; its database is `<workspace>/.omgbase/omgbase.db` (02 §2).

- Repo selection within a workspace: the repo whose `root_path` contains the cwd; when none or several match, require `--repo <slug>` (error message lists the candidates).
- `-C <dir>` runs as if invoked from `<dir>` (git/make convention).
- No workspace found ⇒ every command except `init`, `attach`, and `--help`/`--version` fails with `repo_not_found` and a hint to run `omg init`.

### 2.2 Global flags

| Flag | Meaning |
|---|---|
| `-C <dir>` | Run as if cwd were `<dir>` |
| `--repo <slug>` | Select repo within the workspace |
| `--json` | Machine output: the library result object, verbatim, one JSON document on stdout |
| `--jsonl` | List-shaped results as one JSON object per line (streaming-friendly) |
| `--ids` | List-shaped results as bare IDs, one per line (pipe fuel) |
| `--stale` | Skip the freshness sweep (§3.3) |
| `--no-color` | Disable ANSI styling (also honors `NO_COLOR` and non-TTY stdout) |
| `--version`, `--help` | The usual |

`--dry-run` is global across every mutating command and means exactly what `apply.dry_run` means: full validation + render, per-file unified diffs printed, nothing committed.

### 2.3 Arguments: IDs, locators, stdin

Anywhere a node is named, the CLI accepts what the API accepts: a bare ID (`b_k7z2p9q`, `d_7f31k2m`) or a locator (`projects/foo.md#Risks/p[2]`). Locators contain `#`, `[`, and spaces — single-quote them. `ambiguous_locator` errors print the ranked candidates with IDs so the retry is a copy-paste.

Mutating commands that take block lists accept `-` meaning "read IDs from stdin, one per line" — the counterpart of `--ids`.

### 2.4 Exit codes and errors

| Code | Meaning |
|---|---|
| `0` | Success (including truncated results — truncation is not an error) |
| `1` | Typed engine error (06 §5 codes) or conflict |
| `2` | CLI usage error (unknown flag, missing argument) |

Errors go to **stderr**, always: human form `error[stale_expectation]: <message>` followed by the current-truth payload pretty-printed; with `--json`, the typed error object from 06 §5 as JSON on stderr and nothing on stdout. Conflict objects carry current truth (04 §4) — the CLI prints all of it, because the retry is built from it.

## 3. Process and concurrency model

**Embedded-first, daemonless by default.** Every `omg` command opens the SQLite database directly (WAL), does its work in-process via the library, and exits. No daemon is required for any command. Long-lived processes are explicit: `omg watch` (foreground watcher) and `omg mcp` (stdio MCP server, host-owned lifetime).

This is the design's central decision (ADR-012). The alternatives — a mandatory daemon with an IPC protocol, or a CLI that shells out to a server — buy nothing at the scale envelope (01 §13) and cost a protocol, a lifecycle manager, and a class of "is the daemon up?" failure modes.

### 3.1 Readers

Read commands open their own connection and see a consistent WAL snapshot. Always safe, concurrent with any writer, any watcher, any MCP session.

### 3.2 Writers: the cross-process writer lock

The write protocol's per-repo writer lock (04 §6 step 1) is a **cross-process advisory lock on `<workspace>/.omgbase/writer.lock`**, held for steps 2–7 of the protocol. All writers — one-shot CLI mutations, the watcher's checkpoint ingests, `omg mcp` applies — acquire it. Node exposes no `flock(2)` and the design forbids new runtime deps (§8), so the lock is an **O_EXCL lockfile** (`sync/writer-lock.ts`): exclusive creation is atomic on local filesystems, the holder writes its pid into the file for liveness, and a lockfile whose pid is dead is stolen — no daemon, no lease sweeper. The file-CAS + ingest-and-replay behavior (04 §6) is unchanged.

With the lock in place, a one-shot `omg` mutation while `omg watch` runs is safe end-to-end: the mutation writes file + DB under the lock; the watcher then observes a file whose hash equals `current_revision.rendered_hash` and records a no-op (echo suppression is hash-based, so it works cross-process for free).

### 3.3 Freshness: reads are current by default

Without a watcher, the database lags human edits made since the last ingest. A CLI that silently answers from stale state is a trap; one that re-ingests the whole vault per invocation is a different trap. The rule:

> Before executing, a command runs a **freshness sweep** — unless `--stale` is given, a live watcher holds the watch lease (§3.4), or the command is itself `sync`/`watch`/`mcp`.

The sweep: walk the repo's `*.md` files, `stat` each, compare `(mtime_ns, size)` against the `file_stats` cache; hash only the changed candidates; ingest non-convergent files as one observed checkpoint (under the writer lock). At the envelope (≤10⁴ docs) the no-change case is a directory walk plus stats — tens of milliseconds.

`file_stats` is a **derived** table (rebuildable by a full re-stat; part of the 02 §4 family), shipped in the schema (`core/store/schema.ts`):

```sql
CREATE TABLE file_stats (
  repo_id  TEXT NOT NULL,
  path     TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  hash     BLOB NOT NULL,          -- sha256 at last ingest/engine write
  PRIMARY KEY (repo_id, path)
);
```

### 3.4 The watch lease

`omg watch` (and `omg mcp`'s in-process watcher) holds an advisory lock on `<workspace>/.omgbase/watch.lock` for its lifetime — the same O_EXCL lockfile substitution as the writer lock (`sync/watch-lease.ts`). The holder records its pid in the file; liveness is a pid check (read the holder pid, `kill(pid, 0)`), and a lockfile whose holder pid is dead is stolen — no heartbeats, no stale-lease sweeper. Commands use the probe to skip the freshness sweep; `omg status` reports it (`watcher: live` / `watcher: none`).

### 3.5 Semantic staleness

Semantic search from a one-shot process serves whatever vectors exist; hits backed by stale embeddings are flagged (`~` suffix in human output, `stale: true` in JSON) per 05 §6. `omg embed drain` processes the queue on demand; `omg status` shows queue depth.

## 4. Output contract

1. **stdout is data; stderr is everything else.** Diagnostics, progress, truncation footers, errors — stderr. A piped `omg` never mixes prose into data.
2. **Human format by default**, when stdout is a TTY: aligned columns, `$id` always paired with `$locator` (06 §2 — locators are for eyes, IDs are for follow-ups), checkbox glyphs for tasks, the outline wire format (06 §6) for outlines — the CLI renders the same inline-`b_`-id text the MCP tool returns.
3. **`--json` is the library's result object, verbatim.** The CLI MUST NOT invent shapes: `QueryResult`, `ApplyResult`, `CommitDigest`, conflict objects — same fields as the MCP surface. `--jsonl` flattens list results to one object per line; `--ids` to bare IDs.
4. **Truncation is loud.** Any truncated result prints a stderr footer: `… truncated; continue with --cursor <c>`. Exit code stays 0.
5. **List paging.** List commands accept `-n` (limit) and `--cursor`; a truncated result stays exit 0 and prints the continuation footer (item 4).

## 5. Command catalog

Everything maps onto the 06 tool surface; the correspondence table in §5.10 is the completeness audit. Details follow only where behavior isn't obvious from the mapped tool.

### 5.1 Bootstrap

| Command | Does |
|---|---|
| `omg init [dir]` | Create the workspace (`.omgbase/` + DB) in `dir` (default cwd). Does **not** ingest files — that's a separate consent-gated `attach` step, so `init` never absorbs whatever happens to live under cwd (home dir, desktop, …). If inside a git working tree, offers to ignore the DB via the closest `.gitignore` at/above the workspace (creating one at the git root if none), written relative to that file — prompt on TTY, `--yes` for scripts, **never silent** (02 §2). Outside git, nothing to ignore. Also offers to set the embedding provider: if `omgbase-embedder` is installed it offers it (`--yes` accepts); `--embedder <cmd\|url>` sets any provider verbatim; `--no-embedder` skips. If none ends up set, prints install+config guidance. |
| `omg attach <path> [--slug <s>] [-y]` | Attach a working tree and ingest its Markdown (`attachRepo`; slug defaults to basename). Prompts before ingesting, showing a live file count that grows as the tree is scanned (`248+` while scanning, `248` when done) beside `[y/N]`; Enter = No. `-y` skips the prompt; a non-TTY without `-y` refuses rather than absorbing the tree silently. |
| `omg repos` | List repos: slug, root path, doc/block counts. |

### 5.2 Orient & read

| Command | Does |
|---|---|
| `omg status` | `repos_status` + `sync_status` + watch-lease probe + embedding queue depth. The "where am I" command. |
| `omg ls [glob]` | Live documents: path, block count, last-commit time. |
| `omg outline <doc\|path> [--depth n] [--section <loc>] [--annotate tasks,edges,updated,confidence]` | `docs_outline`, frozen wire format. Alias: `omg ol`. |
| `omg cat <node> [--resolution raw\|text\|outline\|skeleton\|full]` | Content only, default `raw` — exact bytes, pipe-clean. |
| `omg show <node> [--include children,ancestors,edges,history,section]` | `nodes_get` at `full`: attrs, placement, open edges, last change. The metadata card; `cat` is the bytes. |
| `omg find <text> [-n N] [-1] [-v] [--no-semantic]` | `resolve` — ranked `{id, locator, preview, evidence}`. Hybrid (FTS + vector) by default when an embedding provider is configured; `--no-semantic` forces FTS-only; `-v` prints per-hit evidence. `-1` prints the top hit's ID alone: `omg cat $(omg find "risks" -1)`. |

### 5.3 Query

```
omg query [filter] [--from blocks|docs] [--docs] [--text t] [--semantic s]
          [-s|--select f,f] [--order f,-f] [-n N] [--cursor c] [-f envelope.yaml|-]
```

Alias `omg q`. One query language, three input forms, all producing the same envelope (10 §1):

1. **Positional CEL filter** + flags: `omg q 'type == "task" && !attrs.checked' --text deploy`
2. **Flags only** (no filter is legal — pure FTS/semantic).
3. **`-f file|-`**: the envelope as YAML — *exactly* the ```` ```omg ```` fence body (10 §10). A query authored in a document runs unchanged from a file or stdin; one language everywhere.

Defaults: `--from blocks`; `--docs` is sugar for `--from docs`. Human output: one hit per line, `$id  $locator  <first line of text>`, evidence with `-v`.

`omg run <locator|path>` — evaluate the ```` ```omg ```` fence at a locator (or the first fence in a doc) and print its results with the same renderer. Strictly read-and-print: fences stay **inert** in the corpus (ADR-011 §8 reservations hold; nothing is projected, nothing is written). This is the fence-authoring loop: edit fence, `omg run`, repeat.

### 5.4 Graph

| Command | Does |
|---|---|
| `omg links <node> [--in\|--out] [--pred p,p] [--blocks]` | Open edges touching the node; default both directions, grouped; doc-grain by default (`doc_edges`), `--blocks` for block-grain. Backlinks = `omg links <node> --in`. |

Traversal is OQX `follow`, not a dedicated `graph` command: `omg q 'from docs where $path == "x.md" follow doc.out'` walks the outgoing citation graph, `follow doc.in` walks backlinks, and `follow block.children` / `section.children` / `section.subsections` walk structure — all with `$depth`/`$stop`/`$ordinal` metadata and a depth cap of 8 (see 10, OQX `follow`). The structured `graph_traverse`/`graph_path`/`graph_subgraph` API was removed.

There is no `pipeline` command: **the pipeline is the pipe.** `omg q 'from docs where $path == "x.md" follow doc.out' --ids | omg show -` covers seed → expand → hydrate; in-process `pipeline` remains an MCP-only round-trip optimization.

### 5.5 History

| Command | Does |
|---|---|
| `omg log [--since ts\|24h\|7d] [--cursor n] [--origin api\|observed] [--scope glob] [--min-confidence x] [-n N]` | `changes_since`, one digest summary per line (the 06 §3 summary strings were designed for exactly this). Relative `--since` values are resolved to **literal** ISO timestamps client-side before entering the envelope — the query language stays clock-free (10 §3.1). |
| `omg hist <node> [-n N] [--cursor c]` | `history_node` — the biography. |
| `omg diff <doc> [--from r_x] [--to r_y] [--blocks]` | `diff`; unified by default. With no revisions: current vs previous (the "what did the last commit do here" default). |

### 5.6 Mutate

`omg apply [-f changeset.json|-] [--reason s] [--actor s]` is the primitive — a changeset document, exactly 04 §2, from file or stdin. Everything below is sugar that expands to one changeset (macros expand server-side, per 04 §3) and shares its behavior: `--dry-run` everywhere, typed conflicts with current truth, `origin.actor` defaulting to `human:$USER` (override `--actor`; MCP-originated writes remain `agent:*`).

| Command | Expands to |
|---|---|
| `omg insert <to> [--at end\|start\|before X\|after X] (-m md \| -f file \| -)` | `insert` |
| `omg update <block> (-m md \| -f file \| -) [--expect hash]` | `update` (CAS: §5.7) |
| `omg edit <block>` | read → `$EDITOR` on the raw markdown → `update` with the pre-read hash as CAS. The human structural-edit loop for when opening the whole file is the slower path. |
| `omg node set <nodeId> <prop> <value>` / `omg node props <nodeId>` | Surgically set one editable property of a projected node (e.g. a link's target/text, a task's `checked`) via the adapter's registered editor — expands to a single `update` op. `node props` lists a node's editable properties (`editablePropsFor`). |
| `omg move <blocks…\|-> --to <parent> [--at …]` / `omg move --section <heading> --to …` | `move` / `sections_move` |
| `omg rm <blocks…\|->` | `remove` (resurrection pool catches regret) |
| `omg done <blocks…\|-> [--undo]` | `tasks_complete` (`--undo` ⇒ `update attrs.checked=false`) |
| `omg append <heading-loc> (-m md \| -f \| -)` | `sections_append` |
| `omg retarget <from> <to> [--scope glob] [--apply]` | `links_retarget` — **plan-by-default**: without `--apply` it runs the dry-run and prints the per-file diffs (the 06 §4 "always dry-run first" contract, encoded as the default). |
| `omg split <block> --at n[,n…]` / `omg merge <blocks…>` | `split` / `merge` |
| `omg new <path> (-f file \| -)` | `docs_create` — content is complete file bytes, frontmatter included. |
| `omg mv <doc> <new-path>` | `docs_move` |
| `omg rm --doc <doc>` | `docs_delete` (doc deletion always requires the explicit `--doc`) |
| `omg meta <doc> --set k=v … [--unset k …]` | `docs_set_meta` — surgical frontmatter patch. Values parse as YAML scalars; `--set-json k='…'` for structures. |

### 5.7 CAS ergonomics

`update` requires `expect.content_hash` (04 §1). Scripted callers pass `--expect <hash>` pinned from an earlier read — real CAS. Interactive callers omit it: the CLI reads the block, prints `updating <locator>: "<current first line…>"`, and applies with the just-read hash. That is read-then-CAS collapsed into one process — the protection against *concurrent* edits is fully intact; what's waived is protection against edits since a read the caller never made. `omg edit` always pins the hash from the text it opened in the editor, so a mid-edit change by someone else is a clean `stale_expectation` (with current truth printed), never a lost write.

### 5.7a Session (`omg shell`)

`omg shell` is a persistent in-process session (as-built). One workspace/store stays open for the session's lifetime — every command runs in-process, so the per-invocation startup cost is paid once, not per command. Beyond speed it adds **ephemeral typed session bindings** over command results (the interactive analogue of shell pipes): a command's structured library result — the same object `--json` emits — is captured *before* terminal formatting, and becomes addressable.

References all use `@` (OQX owns `$…` for intrinsics like `$depth`/`$leaf`):

| Reference | Resolves to |
|---|---|
| `@1`, `@2`, … | Row *N* (**1-based**, matching the `[1] [2]` display selectors) of the most recent **displayed collection frame**. A command that shows a single thing (a card, bytes) updates `@_` but leaves the frame intact; the next command that emits a collection replaces it. |
| `@_` | The previous command's typed result. |
| `@name` | A named binding. |
| `@name[i]` | Item *i* (1-based) of a bound/collection value. |
| `@name.field`, `@1.field`, `@_[i].field` | A shallow field on the addressed value — one `[i]` then one `.field`, and no deeper. As soon as you want `.where(…).map(…)`, the answer is: **use OQX.** The shell provides storage and dereferencing, not a second query language. |

Bindings are **snapshots**, not live queries: `let open = query '…'` captures the results *now*; using `@open` later does not re-run anything (stored executable queries would be a different concept — aliases/macros — and don't belong in basic bindings).

| Builtin | Does |
|---|---|
| `let <name> = <command>` | Run the command quietly and bind a snapshot of its typed result. |
| `let <name> = <@ref>` | Bind a snapshot of an existing reference. |
| `unset <name>` | Drop a binding. |
| `bindings` | List bindings. |
| `<@ref>` (alone) | Inspect a reference; a collection reference becomes the addressable frame. |
| `exit` / `quit` | Leave the shell (Ctrl-D also exits). |

A reference token is substituted into an ordinary command's argv, coerced to the value the command expects where a node is named (an id/locator); a bare collection reference is refused with a hint to pick a row with `[i]` — the shell never flattens a collection into one argument.

```
omg> query 'from docs where layer == "canon"'
d_a83f  projects/foo.md
d_194c  projects/bar.md
  2 rows — address with @1..@2
omg> show @1
omg> let canon = query 'from docs where layer == "canon"'
omg> show @canon[1]
omg> query 'from nodes where kind == "md:task" && !attrs.checked'
omg> done @1
```

Scope and lifetime: bindings and numbered selections are **ephemeral session state only** — not persisted into the repository, not part of OQX semantics, not stable across shell processes. Opaque OMG entity identities remain authoritative underneath them. The `ShellSession` runtime is drivable programmatically (`session.exec(line)`), so the same layer can power a future Markdown CLI-session test runner: interactive convenience and replayable testing share one session-binding layer.

Two drive modes: an interactive readline REPL on a TTY, and a **script runner** when stdin is piped (one command per line; `#` comments and blank lines are ignored) — the latter is what a piped test harness or a Markdown session test feeds. As a v1 simplification the numbered selectors are not rendered inline as `[n]` beside each command's own output; instead the shell prints a one-line `N rows — address with @1..@N` hint after a frame-producing command.

### 5.8 Sync & serve

| Command | Does |
|---|---|
| `omg sync` | One-shot freshness sweep (§3.3), verbose: files ingested, dispositions summary. Idempotent; safe alongside a live watcher (hash-based echo suppression makes double ingest a no-op). |
| `omg watch` | Foreground watcher (checkpoints at quiescence). Holds the watch lease. Process supervision is the OS's job (tmux/launchd/systemd) — the CLI does not daemonize in v1. |
| `omg mcp [--no-watch]` | MCP server on **stdio**; the host (Claude Code, Cursor, …) owns the process lifetime. Runs an in-process watcher by default so a lone `omg mcp` session is always fresh — auto-disabled when another live lease exists; `--no-watch` forces off. This is the one-line integration: `{"command": "omg", "args": ["mcp", "-C", "/path/to/vault"]}`. |

### 5.9 Admin, maintenance, dev

| Command | Does |
|---|---|
| `omg rebuild-index [--sections\|--edges\|--fts\|--vec\|--block-changes\|--projections\|--all]` | 02 §6, spelling kept verbatim. `--vec` re-enqueues embeddings (drain does the work); `--projections` accepted-but-inert in v1 (ADR-011); `--block-changes` is an as-built addition to 02's list. |
| `omg gc [--dry-run]` | Mark-and-sweep; **refuses** unless `gc.enabled` is set in repo settings (02 §7 ships it dark). Dry-run reports reclaimable bytes. |
| `omg import mrplex <export> [--execute]` | `planImport` report by default; `--execute` runs `importDocs` (minted IDs, no retro-history — invariant #7). Plan-by-default, same convention as `retarget`. |
| `omg doctor` | Cheap invariant sweep: per-doc convergence, FTS row count vs live blocks, dangling `current_rev`, orphaned blobs sample, `PRAGMA integrity_check`, lock/lease sanity. Non-zero exit on any violation — CI-able. |
| `omg config [get k \| set k v \| list]` | Read/write `repos.settings` JSON paths (`sync.quiescence_ms`, `embedding.provider`, `query.timeout_ms`, `gc.enabled`, …). Unknown namespaces warn. |
| `omg embed [status\|drain]` | Embedding queue depth / process the queue now (requires a configured provider; egress note printed — 05 §6). |

### 5.10 MCP ↔ CLI correspondence (completeness audit)

| MCP tool | CLI |
|---|---|
| `docs_outline` | `outline` |
| `nodes_get` / `nodes_get_many` | `show` / `cat` (many: stdin IDs) |
| `resolve` | `find` |
| `query` | `query` |
| `pipeline` | shell pipes (`q '… follow doc.out' --ids \| show -`) |
| traversal (`follow`) | `query`/`q`/`oqx` — OQX `follow` (no dedicated `graph` command) |
| `changes_since` / `history_node` / `diff` | `log` / `hist` / `diff` |
| `apply` | `apply` |
| `tasks_complete` / `sections_append` / `sections_rename` / `sections_move` / `lists_insert_item` / `links_retarget` | `done` / `append` / `update` (heading) / `move --section` / `insert` (list parent) / `retarget` |
| `docs_create` / `docs_delete` / `docs_move` / `docs_set_meta` | `new` / `rm --doc` / `mv` / `meta` |
| `repos_list` / `repos_create` / `repos_status` / `sync_status` | `repos` / `attach` / `status` / `status` |
| `sync_flush` | `sync` |

## 6. Acceptance traces (CLI analogues of 06 §7; executable, keystroke-budgeted)

**C1 — orient.** `omg outline projects/omgbase.md` — 1 command; wire format with inline block ids.

**C2 — "complete the unchecked deploy tasks under Launch."**
```
omg q 'type == "task" && !attrs.checked && under_heading("Launch")' --text deploy --ids | omg done -
```
1 line. The pipe is the changeset boundary: `done` receives IDs, builds one atomic changeset.

**C3 — "what changed since yesterday?"** `omg log --since 24h` — 1 command; one digest per line.

**C4 — "which paragraphs depend on this doc?"** `omg q 'has_edge("depends_on", "d_92aaaaa") || has_edge("references", "d_92aaaaa")'` — 1 command.

**C5 — "fix that one paragraph."** `omg find "stable identity rationale" -1` → `omg edit b_k7z2p9q` — 2 commands; editor round-trip; CAS pinned automatically.

**C6 — "retarget every link, safely."** `omg retarget /old.md /new.md` (prints plan + diffs) → same `--apply` — 2 commands, safe by default.

**C7 — fence authoring.** Edit an ```` ```omg ```` fence in a doc → `omg run 'hub.md#Launch readiness'` — preview without projection.

These traces become the CLI test suite's fixtures (spawn the built binary against the fixture vault; assert output shape, exit codes, and — for C2/C6 — resulting commits).

## 7. Implementation staging

Two stages, sequential exit gates (07 conventions):

- **CLI-A — read surface + freshness.** Scaffold (`bin` wiring, discovery, global flags, output contract, error rendering), `init/attach/repos/status/ls/outline/cat/show/find/query/log/hist/diff/links/sync`, `file_stats` + freshness sweep, cross-process writer-lock (O_EXCL lockfile) in the library. **Gate:** C1/C3/C4 pass as spawned-binary tests; freshness test (edit file out-of-band → query sees it without a watcher); `--json` shape parity with library types.
- **CLI-B — write surface + serve + admin.** `apply` + all sugar, `edit`, `node`, `run`, `watch`, `mcp`, `rebuild-index/gc/import/doctor/config/embed`. **Gate:** full C1–C7 suite; concurrent-writer torture (live `omg watch` + one-shot mutations under the writer lock — the 04 §5 scenarios re-run cross-process); `omg mcp` drives the existing Stage-6 trace suite over stdio unchanged.

## 8. Implementation notes

- **No new runtime dependencies.** `node:util` `parseArgs` per command + a small hand-rolled router (a ~20-command CLI does not need commander); `zod` (already present) validates `-f` payloads with the same schemas the MCP server uses. Renderers: reuse `docsOutline`'s text and `diffUnified` verbatim; one `src/cli/render.ts` for columns/color (ANSI by hand, no chalk).
- **Layout:** `src/cli/main.ts` (router) + `src/cli/cmd/<name>.ts`, each command a pure function `(store | workspace, args, io) → exit code` — testable without spawning; the spawn tests cover wiring and the traces.
- **Wiring:** `package.json` gains `"bin": {"omg": "./dist/cli/main.js"}`. The package is `private: true` and unlicensed — distribution is `pnpm link` / local install until licensing is decided; publishing is out of scope here.
- **Shell completions:** generated (static bash/zsh/fish) from the command catalog table, which is data in the router. SHOULD ship with CLI-B.
- **Docs-win rule:** shipping CLI-A updates `02-data-model.md` §4 (add `file_stats`) and the repo README's quickstart; `06-mcp-api.md` is untouched (the CLI adds no tools).

## 9. Deferred (not in v1; listed so their absence is a decision)

- **Daemon management** (`omg watch --detach`, PID files, restart) — the OS supervises; ship launchd/systemd snippets in docs instead.
- **Remote/HTTP serving** (`omg serve`: SSE MCP, REST) — arrives with the multi-user server, i.e. with the Postgres dialect trigger (ADR-001), not before.
- **TUI** (`omg ui`) — fzf compositions cover the interactive need for now.
- **`omg run --materialize`** — projections are ADR-011's Stage-8 feature; `run` stays read-and-print until then.
- **Workspace registry** (global `~/.config/omg` listing known workspaces) — discovery-by-walk is enough until someone has three vaults.
