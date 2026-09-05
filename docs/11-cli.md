# omgbase — CLI Surface (`omg`)

**Status:** normative design, `proposed` (ADR-012). As-built: implemented in `packages/cli` — the read surface (§5.1–5.5), the write surface (§5.6: `apply` + all sugar, `edit`, `new`/`mv`/`rm --doc`/`meta`), `graph`, `run`, `sync`/`watch`/`mcp` (§5.8), and admin (§5.9: `rebuild-index`/`gc`/`doctor`/`config`/`import`/`embed`). Deferred items in §9 remain deferred; `embed` is a stub until an embedding provider is wired (05 §6). The doc-level ops (`docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`) were built as library functions (`@omgbase/core`) to back `new`/`mv`/`rm --doc`/`meta`; wiring them as MCP tools (06) is still pending.
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

The per-repo writer lock in the write protocol (04 §6 step 1) is today an in-process mutex. The CLI generalizes it: **an advisory `flock` on `<workspace>/.omgbase/writer.lock`**, held for steps 2–7 of the protocol. All writers — one-shot CLI mutations, the watcher's checkpoint ingests, `omg mcp` applies — acquire it. This is a small library change (lock acquisition becomes flock-based), not a protocol change; the file-CAS + ingest-and-replay behavior is unchanged.

With the flock in place, a one-shot `omg` mutation while `omg watch` runs is safe end-to-end: the mutation writes file + DB under the lock; the watcher then observes a file whose hash equals `current_revision.rendered_hash` and records a no-op (echo suppression is hash-based, so it works cross-process for free).

### 3.3 Freshness: reads are current by default

Without a watcher, the database lags human edits made since the last ingest. A CLI that silently answers from stale state is a trap; one that re-ingests the whole vault per invocation is a different trap. The rule:

> Before executing, a command runs a **freshness sweep** — unless `--stale` is given, a live watcher holds the watch lease (§3.4), or the command is itself `sync`/`watch`/`mcp`.

The sweep: walk the repo's `*.md` files, `stat` each, compare `(mtime_ns, size)` against the `file_stats` cache; hash only the changed candidates; ingest non-convergent files as one observed checkpoint (under the writer flock). At the envelope (≤10⁴ docs) the no-change case is a directory walk plus stats — tens of milliseconds.

`file_stats` is a new **derived** table (rebuildable by a full re-stat; joins the 02 §4 family, and 02 MUST be updated to as-built when this ships):

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

`omg watch` holds an advisory flock on `<workspace>/.omgbase/watch.lock` for its lifetime. Liveness probing is the flock itself (try-acquire non-blocking; acquirable ⇒ no live watcher) — no heartbeats, no PID files, no stale-lease sweeper. Commands use the probe to skip the freshness sweep; `omg status` reports it (`watcher: live` / `watcher: none`).

### 3.5 Semantic staleness

Semantic search from a one-shot process serves whatever vectors exist; hits backed by stale embeddings are flagged (`~` suffix in human output, `stale: true` in JSON) per 05 §6. `omg embed drain` processes the queue on demand; `omg status` shows queue depth.

## 4. Output contract

1. **stdout is data; stderr is everything else.** Diagnostics, progress, truncation footers, errors — stderr. A piped `omg` never mixes prose into data.
2. **Human format by default**, when stdout is a TTY: aligned columns, `$id` always paired with `$locator` (06 §2 — locators are for eyes, IDs are for follow-ups), checkbox glyphs for tasks, the frozen outline wire format (06 §6) for outlines — the CLI renders the same `b01`-aliased text the MCP tool returns, ids table included.
3. **`--json` is the library's result object, verbatim.** The CLI MUST NOT invent shapes: `QueryResult`, `ApplyResult`, `CommitDigest`, conflict objects — same fields as the MCP surface. `--jsonl` flattens list results to one object per line; `--ids` to bare IDs.
4. **Truncation is loud.** Any truncated result prints a stderr footer: `… truncated; continue with --cursor <c>`. Exit code stays 0.
5. **Budgets exist here too.** Hydrating commands accept `--budget-tokens` (for agent-with-shell use); list commands accept `-n/--limit` and `--cursor`.

## 5. Command catalog

Everything maps onto the 06 tool surface; the correspondence table in §5.10 is the completeness audit. Details follow only where behavior isn't obvious from the mapped tool.

### 5.1 Bootstrap

| Command | Does |
|---|---|
| `omg init [dir]` | Create `.omgbase/` + DB in `dir` (default cwd), attach `dir` as a repo (slug = basename). Offers to append `.omgbase/` to `.gitignore` — prompt on TTY, `--yes` for scripts, **never silent** (02 §2). Then full initial ingest. |
| `omg attach <path> --slug <s>` | Attach an additional working tree to this workspace (`attachRepo`). |
| `omg repos` | List repos: slug, root path, doc/block counts. |

### 5.2 Orient & read

| Command | Does |
|---|---|
| `omg status` | `repos_status` + `sync_status` + watch-lease probe + embedding queue depth. The "where am I" command. |
| `omg ls [glob]` | Live documents: path, block count, last-commit time. |
| `omg outline <doc\|path> [--depth n] [--section <loc>] [--annotate tasks,edges,updated,confidence]` | `docs_outline`, frozen wire format. Alias: `omg ol`. |
| `omg cat <node> [--resolution raw\|text\|outline\|skeleton\|full]` | Content only, default `raw` — exact bytes, pipe-clean. |
| `omg show <node> [--include children,ancestors,edges,history,section]` | `nodes_get` at `full`: attrs, placement, open edges, last change. The metadata card; `cat` is the bytes. |
| `omg find <text> [--scope glob] [--kind block\|document] [-n N] [-1]` | `resolve` — ranked `{id, locator, preview, evidence}`. `-1` prints the top hit's ID alone: `omg cat $(omg find "risks" -1)`. |

### 5.3 Query

```
omg query [filter] [--from blocks|documents] [--docs] [--text t] [--semantic s]
          [--select f,f] [--order f,-f] [-n N] [--cursor c] [-f envelope.yaml|-]
```

Alias `omg q`. One query language, three input forms, all producing the same envelope (10 §1):

1. **Positional CEL filter** + flags: `omg q 'type == "task" && !attrs.checked' --text deploy`
2. **Flags only** (no filter is legal — pure FTS/semantic).
3. **`-f file|-`**: the envelope as YAML — *exactly* the ```` ```omg ```` fence body (10 §10). A query authored in a document runs unchanged from a file or stdin; one language everywhere.

Defaults: `--from blocks`; `--docs` is sugar for `--from documents`. Human output: one hit per line, `$id  $locator  <first line of text>`, evidence with `-v`.

`omg run <locator|path>` — evaluate the ```` ```omg ```` fence at a locator (or the first fence in a doc) and print its results with the same renderer. Strictly read-and-print: fences stay **inert** in the corpus (ADR-011 §8 reservations hold; nothing is projected, nothing is written). This is the fence-authoring loop: edit fence, `omg run`, repeat.

### 5.4 Graph

| Command | Does |
|---|---|
| `omg links <node> [--in\|--out] [--pred p,p] [--blocks]` | Open edges touching the node; default both directions, grouped; doc-grain by default (`doc_edges`), `--blocks` for block-grain. Backlinks = `omg links <node> --in`. |
| `omg graph traverse [-f spec.json] [--from id,… \| -] [--via p,p] [--dir out\|in\|both] [--depth n] [--as-of c] [--filter cel] [--max-nodes n] [--max-edges n]` | `graph_traverse`. Seeds from stdin (`-`) compose with `--ids`. |
| `omg graph path --from a --to b [--via p,p] [--max-len n] [-k n]` | `graph_path`. |
| `omg graph subgraph --seeds id,… [--radius n]` | `graph_subgraph` — the analytics export; usually with `--json`. |

There is no `pipeline` command: **the pipeline is the pipe.** `omg q … --ids | omg graph traverse - --via references | omg show -` covers seed → expand → hydrate; in-process `pipeline` remains an MCP-only round-trip optimization.

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
| `omg eval-matcher [--n N] [--size s] [--intensity i]` | Existing dev command (07 task 2.6), kept; exits non-zero when release gates fail. Hidden from default help along with `omg parse <file>` (round-trip + block-table debug dump). |

### 5.10 MCP ↔ CLI correspondence (completeness audit)

| MCP tool | CLI |
|---|---|
| `docs_outline` | `outline` |
| `nodes_get` / `nodes_get_many` | `show` / `cat` (many: stdin IDs) |
| `resolve` | `find` |
| `query` | `query` |
| `pipeline` | shell pipes (`q --ids \| graph traverse - \| show -`) |
| `graph_traverse` / `graph_path` / `graph_subgraph` | `graph traverse/path/subgraph` |
| `changes_since` / `history_node` / `diff` | `log` / `hist` / `diff` |
| `apply` | `apply` |
| `tasks_complete` / `sections_append` / `sections_rename` / `sections_move` / `lists_insert_item` / `links_retarget` | `done` / `append` / `update` (heading) / `move --section` / `insert` (list parent) / `retarget` |
| `docs_create` / `docs_delete` / `docs_move` / `docs_set_meta` | `new` / `rm --doc` / `mv` / `meta` |
| `repos_list` / `repos_create` / `repos_status` / `sync_status` | `repos` / `attach` / `status` / `status` |
| `sync_flush` | `sync` |

## 6. Acceptance traces (CLI analogues of 06 §7; executable, keystroke-budgeted)

**C1 — orient.** `omg outline projects/omgbase.md` — 1 command; frozen wire format; ids table trailer.

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

- **CLI-A — read surface + freshness.** Scaffold (`bin` wiring, discovery, global flags, output contract, error rendering), `init/attach/repos/status/ls/outline/cat/show/find/query/log/hist/diff/links/sync`, `file_stats` + freshness sweep, writer-lock flock refactor in the library. **Gate:** C1/C3/C4 pass as spawned-binary tests; freshness test (edit file out-of-band → query sees it without a watcher); `--json` shape parity with library types.
- **CLI-B — write surface + serve + admin.** `apply` + all sugar, `edit`, `graph`, `run`, `watch`, `mcp`, `rebuild-index/gc/import/doctor/config/embed`. **Gate:** full C1–C7 suite; concurrent-writer torture (live `omg watch` + one-shot mutations under flock — the 04 §5 scenarios re-run cross-process); `omg mcp` drives the existing Stage-6 trace suite over stdio unchanged.

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
