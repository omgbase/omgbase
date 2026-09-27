# The omgbase sync specification

Sync is how bytes get *between* an omgbase repository and the places they
live: the workspace on disk that holds the database, the source registry
that says where a repo's bytes come from, the adapter processes that
transport them, the freshness sweep and checkpoints that observe a
filesystem, the coordinator that mirrors a source against an engine over a
client, and the locks that keep writers and watchers from colliding. The
reconciliation itself is `spec/store` §5 (observe) and `spec/reconcile`;
this directory specifies everything around it so two engines share a
workspace, its registry and its adapters. It is owned by neither
implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) + `@omgbase/sync` | `packages/core/src/sync/{workspace,sources,settings,attach,checkpoint,freshness,driver,external-source,plugin,recovery,admin,writer-lock,watch-lease,fs-util}.ts`, `core/attach.ts`, `packages/sync/src/{coordinator,engine-client}.ts` | **Reference.** |
| `omgbase-sync` (Rust, crates.io) | `crates/omgbase-sync` | Conformance-first port over `omgbase-store`: registry, settings, workspace, checkpoints, the sweep, the adapter client, the coordinator, the locks, and (1.3) `McpEngineClient` — the §6 engine client over MCP stdio / Streamable HTTP. |
| `omgbase-fs-adapter` (Rust, crates.io) | `crates/omgbase-fs-adapter` | A second implementation of the `fs` adapter of §5 (the reference is `@omgbase/fs-adapter`, `packages/fs-adapter`): the `omgbase-fs-adapter` binary over `notify`, wire-compatible, so a host needs no Node. |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/sync-plugins.md`,
`docs/sync-service-design.md`, `docs/cli.md` §3.

## Versioning

`VERSION` is `<major>.<minor>`; the `omgbase-sync` crate is
`<major>.<minor>.<patch>`. A change to a procedure or a decision rule bumps
the minor; a change to a stored row's meaning, the adapter protocol or a
lock file's format bumps the major. The adapter protocol carries its own
`protocol: 1` number in the handshake; bumping it is a major here.

## The rule for changing sync

**Fixture first, TypeScript (reference) second, Rust third.** §9 records the
reference oddities surfaced and the decisions taken.

## 1. Workspace

A **workspace** is a directory containing `.omgbase/`; its database is
`.omgbase/omgbase.db` (`spec/store` §1). Discovery walks up from a start
directory to the filesystem root and takes the first directory holding a
`.omgbase` directory; none → no workspace. An explicit `--workspace` flag
wins over the `OMGBASE_WORKSPACE` environment variable, which wins over
discovery.

A workspace holds many repos. A repo's **root path** is derived: the
`config.root` of the first `fs` source attached to it (attachments joined to
sources with `adapter = 'fs'`, repos listed by `slug`; a non-string or empty
root counts as none); a repo with none is **sourceless** — its sync and
watch are no-ops and the database is authoritative for its content.

**Repo selection** for a command run in `cwd`: an explicit slug must exist
(`repo_not_found` with the candidate slugs); else with exactly one repo,
that repo; else the repos whose root path contains `cwd` (path-prefix
containment after resolving both; sourceless repos never match) — exactly
one → it; none → `repo_not_found`; several → the one with the longest
resolved root path.

## 2. The source registry

`adapters(name, command, args JSON)`, `sources(source_id, name, adapter,
config JSON, env JSON)`, `attachments(repo_id, source_id)`,
`sync_state(repo_id, source_id, path, revision, cursor)` (`spec/store`
`schema.sql`).

- `ensure_adapter(name, command, args = [])`: insert or update by name.
- `create_source({ name, adapter, config = {}, env = {} })`: **mint `src`**
  (before the insert — a failure consumes the id, §9), insert; a taken name
  fails `unique`, an unknown adapter `foreign_key`.
- `delete_source(id)`: delete its attachments, its `sync_state` rows, the
  source.
- `attach(repo, source)` / `detach`: `INSERT OR IGNORE` / `DELETE`.
- `sources_for_repo(repo)`: attached sources ordered by `name`.
- **`ensure_repo(slug, root_path?)`**: an existing slug returns its id;
  else **mint `rp`**, insert `(repo_id, slug)` with default settings, and
  when a root is given register the filesystem source: `INSERT OR IGNORE`
  the `fs` adapter (`command 'omgbase-fs-adapter'`, `args '[]'`), find or
  create (**mint `src`**) a source named `<slug>-fs` with `adapter 'fs'`,
  `config {"root": <root>}`, `env {}`, and attach it — an existing source of
  that name is attached as is, its root not rewritten (§9). (`spec/store`
  §3.4 migration 13 does the same for legacy rows.)
- **`render_config_flags(config)`**: for each entry in the object's own
  order, skip `null`/absent values; a `true` boolean → `--key`; `false` →
  nothing; anything else → `--key`, `String(value)` (JavaScript
  stringification: numbers as JS prints them, arrays comma-joined, objects
  `[object Object]` — fixtures use scalars).
- `sync_state` is **reserved**: nothing reads or writes it except
  `delete_source`.

## 3. Settings

One schema at two layers: `workspace_settings` (singleton row `id = 0`) is
the default layer; `repos.settings` overrides it. Both are JSON objects
(unparsable or non-object text reads as `{}`). **`resolve(repo?)`** =
`deep_merge(workspace, repo_own)` where a plain object over a plain object
merges recursively and anything else (scalars, arrays, null) replaces
wholesale; `resolve(null)` is the workspace layer alone. Writers replace the
whole blob (`INSERT … ON CONFLICT DO UPDATE` for the workspace row; `UPDATE
repos SET settings` for a repo). Known keys are the consumers' business
(`embedding.*` — `spec/search` §5).

## 4. Checkpoints and the filesystem fast path

### 4.1 Checkpoint row

Every batch observed through the filesystem fast path or the adapter driver
records one `checkpoints` row: **mint `cp`**, `ts` = the batch timestamp,
`files` = JSON `[[path, old_hash_hex | null, new_hash_hex | null], …]` in
batch order (a gone member has `null` new hash; the old hash is the prior
`file_hash` or `null`), `git_head` = the caller's value or `null`. Then the
resurrection pool is swept at `ts` (`spec/store` §5.5). The result is
`{ checkpoint_id, ingested, suppressed (echoes), deleted (gone members that
had a live doc), conflicted }` in batch order.

`process_checkpoint(repo, root, paths, ts)`: read each path under the root
(`null` when the file is absent), `observe_batch` (`spec/store` §5),
record the checkpoint.

### 4.2 The walk

`walk_markdown(root)`: every regular file whose name ends in `.md`, at any
depth, skipping the directories named `.omgbase`, `.git` and
`node_modules`, as repo-relative paths with `/` separators, depth-first,
the entries of each directory in **bytewise order of their names** (Node's
`readdir` sorts through libuv; a port whose directory listing is unsorted
sorts — §9). The in-memory filesystem the fixtures use follows the same
rule.

### 4.3 The freshness sweep

Inputs: the repo's `file_stats` cache rows `(path, mtime_ns, size, hash)` —
`mtime_ns` read as a 64-bit integer, never a double (§9) — and the current
filesystem snapshot (the walk with each file's `(mtime_ns, size)`).

1. **Candidates**: paths not in the cache, or whose `(mtime_ns, size)`
   differs from the cache. **Deletions**: cached paths not on disk.
2. For each candidate, hash its bytes. If the hash differs from the cached
   hash (or there is no cache row) it is **changed**; otherwise only the
   cache's `(mtime_ns, size)` is refreshed (a touch without an edit costs a
   hash, never an ingest).
3. `process_checkpoint(changed ++ deletions)` as one batch.
4. Refresh the cache for every changed path (`record_file_stat`: `INSERT …
   ON CONFLICT DO UPDATE` with the fresh stat and the hash; a path that
   vanished meanwhile deletes its row) and delete the rows of the deletions.

Result: the checkpoint result plus `{ scanned, candidates, changed:
ingested or deleted or conflicted non-empty }`; a sweep with nothing to do
still records a checkpoint row with `files: []`. `file_stats` is derived: a
rebuild deletes the repo's rows, then re-stats and re-hashes every walked
file **that has a live doc** (one whose `file_hash` is null matches nothing)
and records a row **only when the bytes' hash equals that `file_hash`** — a
file with no live doc, or whose bytes differ from what was ingested, gets no
row, so the next sweep still sees it as a candidate and drift still reports
it. Returns the number of files walked.
Since 1.1 (§9: the reference recorded every file, hiding a pending edit).

**Disk drift** (read-only): with the same cache and snapshot, count
`untracked` = candidates with no live doc at that path, `changed` =
candidates whose live doc's `file_hash` differs from the bytes' hash (or is
null), `deleted` = live docs whose path is not on disk. Touches nothing.

**Recovery** (startup): for every live doc, a missing file is `missing`; a
file whose hash differs from the current revision's `rendered_hash` (or
`file_hash` when there is no revision) is re-ingested as an observed commit
(one document at a time, not a batch — §9) and listed `healed`. Recovery
records no checkpoint row and does not refresh `file_stats` (the next sweep
re-hashes the healed file and echo-suppresses it).

### 4.4 Status

`repos_status(repo, root?)`: counts of live docs, live blocks, commits, open
edges; `unconverged` = live docs whose `file_hash` differs from their
current revision's `rendered_hash`; `disk` = the drift counts with
`checked: true` when a root was supplied, else zeros with `checked: false`.
`sync_status`: `last_commit_seq`, `last_checkpoint` (latest by `ts`),
`convergent` = `unconverged == 0 && checked && no drift` — never green on an
unverified disk.

## 5. The adapter protocol

An adapter is a child process; its `argv` is the adapter's `command`, its
fixed `args`, then `render_config_flags(config)`; its environment is the
parent's with the source's `env` merged over it. Newline-delimited JSON:
stdout is the protocol, stderr is logs.

- **Handshake** (first line from the adapter):
  `{"protocol": 1, "capabilities": {"identity": "inferred" | "borne",
  "writeThrough": bool, "watch": bool}}`. A missing or non-1 `protocol`, or
  a line that is not JSON, is `invalid_handshake` and the child is
  terminated (§9: the reference accepted any protocol); a spawn failure is
  `spawn`; an exit before the handshake is `exited`.
- **Requests** `{"id": n, "method": m, "params": {...}}` with monotonically
  increasing `id` from 1; **responses** `{"id": n, "result": {...}}` or
  `{"id": n, "error": "message"}`, matched by id. The engine awaits one
  request at a time; a response whose id is not the awaited one is
  discarded (§9). A `batch` event before `watch` was requested is dropped.

| method | params | result |
| --- | --- | --- |
| `enumerate` | — | `{ "entries": [{ "path", "revision", "sourceId"? }] }` |
| `fetch` | `{ "path" }` | `{ "item": { "path", "revision", "content" } \| null }` |
| `write` | `{ "path", "content" }` | `{ "ok": true }` (writeThrough only) |
| `remove` | `{ "path" }` | `{ "ok": true }` (writeThrough only) |
| `watch` | — | `{ "ok": true }` (subscribed); then one unsolicited `{"event": "ready"}` once the feed is primed; thereafter unsolicited `{"event": "batch", "paths": [...]}` lines |
| `unwatch` | — | `{ "ok": true }`; the adapter stops emitting and exits on stdin EOF / SIGTERM |

`path` is the repo-relative storage key; `revision` the source's cheap
change token (the fs adapter emits `"<mtime_ns>:<size>"`); the engine
hashes `content` itself and never trusts `revision` for echo suppression.
Debouncing of the watch feed is adapter-side.

**Readiness (1.2).** The `watch` response only acknowledges the
subscription; a change made before the adapter's feed is primed (the fs
adapter: chokidar's initial scan) may never be reported. An adapter that
advertises `watch` therefore emits **one** `{"event": "ready"}` line after
its `watch` response, as soon as every change from then on will be reported;
a `ready` outside a live watch is dropped like a stray `batch` (§9). The
engine surfaces `ready` to its caller as an event of the watch (§8: the
runner records it), and a **host** that starts a watcher (`omg mcp`,
`omg sync --watch`, `omgbase mcp`) orders its startup by it: take the lease,
spawn the adapter, `watch`, **wait for `ready`**, then run the priming
freshness sweep (§4.3), then report the watcher live — so an edit landing in
the window before readiness is caught by the sweep, and one landing after
it by the feed (an edit caught by both is an echo). The wait is bounded by
host patience (unpinned; both hosts use 30 s) and a timeout is a warning,
never a failure: the host proceeds as if ready, so an adapter built before
1.2 still works, with the old window.

The `fs` adapter (`omgbase-fs-adapter --root <dir>`): `enumerate` = the walk
of §4.2 with stat revisions; `fetch` reads the file (`null` when absent);
`write` = atomic temp-file + rename with parent directories created;
`remove` unlinks if present; `watch` streams debounced batches of changed
paths, `ready` following the `watch` response once the watcher's initial
scan has completed.

**Launching the built-in `fs` adapter (1.2).** The registry row for `fs`
(§2: `command 'omgbase-fs-adapter'`, `args '[]'`) exists to satisfy the
`sources.adapter` reference and to be read back; **it is not what a host
runs.** A host launches the `fs` adapter as `$OMGBASE_FS_ADAPTER`
(whitespace-split into a command and leading arguments) when that variable
is set and non-empty, else as its own launcher — the reference runs its
bundled `@omgbase/fs-adapter` bin under the running `node`, the port runs
`omgbase-fs-adapter` from `PATH` — followed in either case by the row's
fixed `args` and then `render_config_flags(config)`. Every other adapter
runs its stored `command`. (§9: before 1.2 the reference ignored the
variable and the port read the row's command.)

## 6. The driver and the coordinator

**Driver** (`reconcile_changes(repo, source, paths, ts)`): fetch every path
through the source (`null` → gone), then `observe_batch` and record the
checkpoint exactly as §4.1. **Attach** (`attach_source(slug, root, source)`):
`ensure_repo`, then for every enumerated entry fetch and ingest with the
reconciling resolver when `identity` is `inferred` (the plain re-mint
ingest otherwise — §9), counting files and whether all converged.

**Coordinator** (`@omgbase/sync`): drives a source against an **engine
client** (in-process or over MCP) with no reconciliation logic of its own.

- `sync_in`: `reconcile(enumerate().paths)`.
- `reconcile(paths)`: fetch each; present items go to `observe_many` in one
  call (summary buckets: `echo` → suppressed, `conflicted`, else ingested);
  gone paths go to `observe_delete` one by one (`deleted` when a live doc
  was tombstoned).
- The engine's **change feed**, `changes_since(cursor = 0, limit = 50,
  origin?)`: the repo's commits with `seq > cursor` (optionally of one
  origin), in `seq` order, `limit + 1` fetched to set `truncated`; each
  digest `{ commit, seq, ts, origin, actor, summary, revisions: [{ doc,
  path, content_hash = hex(rendered_hash) }] }`; the page's `cursor` is the
  last digest's `seq` (or the input cursor when empty) and `head` the repo's
  max `seq`. `summary` is a human line the fixtures do not pin.
- `sync_out(cursor = 0)`: page the engine's `changes_since(cursor)`; for
  every digest **whose origin is not `observed`** and every revision in it,
  read the doc by path and `write` its bytes, or `remove` the path when the
  doc no longer reads (tombstoned); follow `truncated` pages; return the
  final cursor. A source without `write` exports nothing and returns the
  cursor unchanged. Loop safety: the engine's echo gate makes a written file
  that comes back an echo, and observed commits are never exported.
- `watch_in`: subscribe when the source can watch; each batch runs
  `reconcile`.

## 7. Locks

Both are advisory lock files under `.omgbase/`, created with exclusive
`O_EXCL` semantics, holding `{"pid": <holder>, ...}` as JSON; a lock whose
holder pid is no longer alive (signal 0 fails with anything but `EPERM`) is
stolen.

- **Writer lock** `writer.lock`: taken around a mutation's commit phase
  (`spec/mutate` §4 step 5) and checkpoint ingests; a waiter polls every
  25 ms up to 5 s, then fails `WriterLockTimeout` naming the holder pid;
  released by unlinking. A lock held by a **live** process is never stolen,
  however old (§9: the reference stole after 30 s).
- **Watch lease** `watch.lock`: held by a live watcher for its lifetime;
  `try_acquire` returns nothing when a live holder exists; `live(dir)` is
  the probe one-shot commands use to skip the freshness sweep.

## 8. Fixtures

Three case shapes:

- **`pure.json`**: `{ name, fn: "render_config_flags" | "deep_merge" |
  "select_repo" | "sweep_plan", args, expect }` — `render_config_flags`
  (config → argv), `deep_merge(base, over)`, `select_repo(repos: [{ slug,
  root_path }], cwd, slug?)` → slug or `{ error, candidates }`,
  `sweep_plan(cache: [{ path, mtime_ns, size, hash }], disk: [{ path,
  mtime_ns, size, content }])` → `{ candidates, changed, deletions,
  refreshed }` (the §4.3 decisions as a pure function over a snapshot; both
  implementations expose it behind a seam so the sweep's I/O is not in the
  fixture).
- **`registry.json`**: observation-style scripts (fresh database, fixture
  minter) with steps `ensure_repo { slug, root? }`, `ensure_adapter`,
  `create_source`, `delete_source`, `attach`, `detach`, `settings { scope:
  "workspace" | <slug>, set }`, `resolve_settings { repo? }`; `expect.steps`
  records each result (ids, resolved objects, or `{ error }`), and the
  projection is `repos`, `adapters`, `sources`, `attachments`,
  `sync_state`, `workspace_settings`, plus `repos_status` fields that need
  no disk (`docs`, `blocks`, `commits`, `open_edges`, `unconverged`).
- **`checkpoint.json`**: scripts over an in-memory filesystem (`disk` steps
  set `{ path, content, mtime_ns }` — a safe-integer JSON number; `rm`
  steps remove; the walk is insertion order), on a sourceless repo `rp_0`,
  with `sweep { ts, git_head? }`, `checkpoint { ts, paths, git_head? }`,
  `drift`, `recover { ts }`, `rebuild_stats` steps; `expect.steps` records
  each result (`checkpoint_id`, buckets, counters — `scanned`,
  `candidates`, `changed`), and the projection adds `checkpoints` (`{ id,
  ts, files (parsed), git_head }` by `ts` then insertion) and `file_stats`
  (`{ path, mtime_ns, size, hash }` by path) to the `spec/store` §9.4
  tables; the store's §8 invariants hold after every ingesting step.
  Registry results are `{ repo }`, `{ source }`, `{}`, `{ settings }` or
  `{ error: "unique" | "foreign_key" | "repo_not_found" }`; `attach`/`detach`
  take ids; `repos_status` is projected as an array in slug order.

The adapter protocol (§5) and the coordinator (§6) are pinned by
`protocol.json`, two case kinds:

- `kind: "adapter"` — `{ name, transcript: [{ dir: "in" | "out", line }],
  expect }`: the runner spawns a scripted fake adapter (the reference's
  `corpus/sync/fake-adapter.mjs`, fed the transcript through the source's
  `env`) that plays every `in` line and logs every line it receives; each
  `out` line is both the instruction (the runner parses its `method`/`params`
  and calls the source) and the assertion (the log must equal the `out`
  lines byte for byte). `expect` = `{ capabilities: { identity,
  write_through, watch }, results: [per out], events: [<event>] }` or
  `{ error: "invalid_handshake" | "exited" | "spawn" }`; an adapter error
  response is recorded as `{ error: <message> }`. `events` are the
  unsolicited event lines the watch listener received, in order, as parsed
  JSON — `{"event": "ready"}` or `{"event": "batch", "paths": [...]}` (1.2;
  before it, `[[paths]]`). **Ordering (1.2).** The runner issues an `out`
  request only after every `in` line before it in the transcript has been
  delivered: the response is awaited by the call itself, and before the
  next request the runner waits (bounded, a shortfall is a failure) until
  the listener has received as many events as there are `in` event lines
  inside a **live watch window** — after a `watch` request and before the
  next `unwatch` request — that precede that `out` entry (an event line
  after `unwatch` is dropped by the engine, whose listener is gone before
  the request goes out, and is not waited for either) — so an event the
  adapter emits between a response and the next request is never lost to
  the runner sending `unwatch` first (§9: `watch-events-unwatch` was
  timing-dependent in both runners). Event lines before a `watch` request
  are dropped by the engine (`event-before-watch-is-dropped`) and are not
  waited for.
- `kind: "coordinator"` — `{ name, source: { write_through }, page_limit?,
  steps, expect }` with steps `source { set | rm }`, `engine { ts, create |
  import | delete | observe }`, `sync_in { ts }`, `reconcile { ts, paths }`,
  `sync_out { cursor? }`; each outcome records the summary and the **calls**
  made — `[{ engine: "observe_many" | "observe_delete" | "changes_since" |
  "read_doc", … }, { source: "enumerate" | "fetch" | "write" | "remove", … }]`
  — against a recording in-process engine client (which injects the step's
  `ts` and the `page_limit`) and an in-memory source; the projection adds
  `files`, `docs [{ doc_id, path, deleted }]` and `commits [{ commit_id, seq,
  origin, actor }]`.

**Generation.** Two runners, each rewriting only its own cases under
`SYNC_SPEC_UPDATE=1`: `packages/core/corpus/sync/spec.test.ts` (pure,
registry, checkpoint, adapter cases) and `packages/sync/corpus/sync/spec.test.ts`
(coordinator cases — the coordinator lives in `@omgbase/sync`). The update
also rewrites `out` lines from the engine's actual requests. **Allowlist
(Rust).** `crates/omgbase-sync/tests/spec-passing.txt`, `SYNC_SPEC_UPDATE=1`.

## 9. Reference oddities surfaced while specifying, and decisions

- **Fixed — the stat cache lost precision.** The reference read
  `file_stats.mtime_ns` as a JavaScript number, so a real nanosecond stamp
  rounded and **every file was a candidate on every sweep** (re-hashed each
  time; nothing was re-ingested thanks to the hash check). Read as a 64-bit
  integer now.
- **Fixed — the handshake accepted any protocol.** Only unparsable JSON
  failed; `protocol: 1` is now required (`protocol::handshake-wrong-protocol`).
- **Pinned — one request in flight.** The reference discards a response whose
  id is not the awaited one, so interleaved responses to concurrent requests
  would hang; every caller awaits each call.
- **Fixed (1.1) — a rebuild of `file_stats` hid a pending edit** from the
  next sweep and from drift, because it recorded the disk hash of every
  walked file as known; `omg source add` rebuilds right after its sweep, so
  an edit landing between the two vanished until the file changed again.
  A rebuild now records only files matching their live doc
  (`checkpoint::rebuild-stats-keeps-a-pending-edit-visible`).
- **Pinned — a rebuild cannot make the sweep notice a deletion.** The sweep
  finds deletions as cached paths missing from the snapshot, and a rebuild
  records only walked files, so a live doc whose file vanished before the
  rebuild has no row and the next sweep does not tombstone it; only drift
  (`deleted`) and recovery (`missing`) see it
  (`checkpoint::rebuild-stats-after-a-deletion-leaves-no-row`). Unchanged
  by 1.1.
- **Pinned — `create_source` mints before it fails**, so a UNIQUE or FK
  failure consumes an id (`registry::source-name-taken`).
- **Pinned — an array settings blob passes the object check** and is
  returned as is; fixtures set objects only.
- **Fixed — the walk order is bytewise per directory.** This spec first
  said "unsorted, as `readdir` yields"; Node's `readdir` in fact sorts every
  directory listing (libuv), while Rust's yields raw OS order, so the two
  engines would have swept in different orders (batch order decides
  `checkpoints.files`, commit `seq` and minted ids). The rule is bytewise
  per directory; both in-memory fixture filesystems sort the same way.
- **Fixed — the writer lock stole from a live holder.** The reference also
  stole a lock whose record was older than 30 s even when the holder pid was
  alive; a live writer's lock is now never stolen (a hung holder is
  reported by `WriterLockTimeout` with its pid).
- **Port notes.** Pid liveness is `kill(pid, 0)` (`EPERM` counts as alive),
  so the locks are Unix-only as built; containment in repo selection is by
  path components in the port (the reference's `relative()` prefix test would
  reject a directory literally named `..x`); the port's `close` gives an
  adapter stdin EOF, then SIGTERM, then SIGKILL with grace periods, where
  the reference sends SIGTERM at once.
- **Pinned — recovery ingests one document at a time**, so a block moved
  between two files while the engine was down is `deleted` + `inserted`
  (the pool may still resurrect it), whereas the sweep would have carried
  it as a move.
- **Pinned — `attach_source` for a `borne` source re-mints every block**
  (no resolver) although the design says a borne source skips the matcher
  and maps `sourceId` to identity; no borne adapter exists.
- **Pinned — `sync_state` is inert.** Only `delete_source` touches it.
- **Pinned — the fs source's env is empty and `$VAR` indirection does not
  exist**; `env` values are used literally.
- **Pinned — `repos_status.root_path` is the caller's argument or `""`**,
  never the derived root.
- **Pinned — the coordinator's `sync_out` exports `api` and `import`
  commits alike** and re-reads each revision's document by path at export
  time (a later commit's bytes may be exported under an earlier digest).
- **Fixed (1.2) — `watch` acknowledged before the adapter was ready.** The
  fs adapter answered `watch` at once while chokidar was still scanning, so
  an edit right after startup could be lost by either host (both swept, then
  watched). §5 puts `{"event": "ready"}` on the wire
  (`protocol::watch-ready-then-events`), and both hosts now `watch`, wait
  for `ready`, then run the priming sweep, then report live; an adapter that
  never reports is tolerated after host patience (30 s) with a warning.
- **Fixed (1.2) — two rules for `adapters.command` on the `fs` adapter.**
  The reference launched its bundled bin and ignored the row, the port ran
  the row's command (`omgbase-fs-adapter`) or `$OMGBASE_FS_ADAPTER`. One rule
  now (§5): the row is registry data, the launcher is the host's, and
  `$OMGBASE_FS_ADAPTER` overrides it in both.
- **Fixed (1.2) — `protocol::watch-events-unwatch` was timing-dependent** in
  both runners: the engine's `unwatch` could go out before the reader thread
  had routed the batch lines that followed the `watch` response, so the
  events were dropped as post-watch strays about one run in five. §8 pins
  the runner's ordering (wait for the events a transcript promises before
  the next request); `events` records parsed event objects, `ready` among
  them.
- **Open — what a second host still needs from §6/§7.** The writer lock's
  scope around a priming sweep or an embed drain, the error a lock timeout
  produces at the MCP boundary (the catch-all in both), `git_head` null on
  watcher/sweep checkpoints, and multi-connection SQLite busy handling (both
  engines: WAL + a 5 s busy timeout) are unpinned.
- **Pinned — lock stealing.** A lock file with an unparsable body has no
  pid and is treated as stale.

## Decisions

- 2026-09-26, sync 1.0 specified as built. The last spec before the MCP/CLI
  binary: with it, every table of `schema.sql` has an owner spec.
- 2026-09-26, sync 1.1: a `file_stats` rebuild records only files whose bytes
  match their live doc (least surprising: a cache rebuild must not change
  what the next sweep does).
- 2026-09-27, sync 1.3: no protocol or procedure change — the crate line
  moved to 1.3 with the Rust `McpEngineClient` (JSON-RPC over stdio and
  Streamable HTTP, the second implementation of the §6 engine client, listed
  in the table above), and a crate's `major.minor` tracks this file, so the
  spec moves with it. Recorded by the release tool's spec-tracking check.
- 2026-09-26, sync 1.2: a readiness event on the adapter wire, hosts wait
  for it before the priming sweep and the "live" report; the built-in `fs`
  adapter is launched by the host (`$OMGBASE_FS_ADAPTER` override in both),
  never from the registry row; the protocol runner waits for promised
  events before its next request. The protocol number stays 1: an adapter
  without `ready` still works (least surprising: an additive event, a
  bounded wait).
