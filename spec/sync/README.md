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
(`embedding.*` — `spec/search` §5; `feed.*` and `identity.claims_retain_days`
— `spec/store` §7.3–§7.4; `recovery.alert_after_minutes` — `spec/store`
§5.8, the age in minutes past which a pending materialization raises the
`materialization_backlog` alert, default 10, a non-negative number, anything
else the default). **Since store 17.0 (slice 3e-ii) a settings write
re-derives the repository's `semantic` manifest row** (`spec/store` §3.1
`capabilities`: `enabled` iff `embedding.provider` resolves) — the
workspace layer's write every repository's, a repo's write its own, in the
same transaction — until the Phase 4 `embed` verbs own the row.

## 4. Checkpoints and the filesystem fast path

### 4.1 The batch and the status row (4.0)

Every batch observed through the filesystem fast path or the adapter driver
updates the repository's **status row** of `sync_state` — `(repo_id,
source_id = '', path = '')`, reserved (`spec/store` §3.1; D4: the
`checkpoints` table of 3.x collapsed into it): `last_batch_ts` = the batch
timestamp, `last_batch_id` = the batch's **`batch_id`** — the first
committing member's commit id, which every member's feed row carries
(`spec/store` §5.4 step 5); NULL when nothing committed — and
`last_batch_files` = the member count; and the resurrection pool is swept at
`ts` (`spec/store` §5.5) — the row and the sweep in one transaction (2.1; 2.0
ran them as two autocommits). The result is `{ batch_id, ingested,
suppressed (echoes), deleted (gone members that had a live doc), conflicted,
failed }` in batch order — `failed` (4.1, store 17.1 Phase 4a) the paths of
the members rolled back because their history capture threw (`spec/store`
§5.4 step 15, resolution 18): nothing of such a member landed, the
`capture_failed` alert stands, the member is not counted as ingested, and
the next sweep retries it. **No `cp` is minted**: the batch's identity is the feed's
`batch_id`, so a consumer of `changes_since` groups an observed batch's
commits by it (what a history strategy needs from batches, D4). The 3.x
`files` and `git_head` columns are gone (D9: written by every sweep, read by
no production path).

`process_checkpoint(repo, root, paths, ts)`: read each path under the root
(`null` when the file is absent), `observe_batch` (`spec/store` §5), write
the status row.

**Gone members and pending rows (2.2).** A member absent from the disk whose
path has a pending `write`/`rename` materialization row (`spec/store` §5.7
— the api path committed and still owes the file) is **not** tombstoned:
`observe_batch` returns `{ deleted: false }` for it, nothing is minted, the
row stays for the materializer (the member counts toward
`last_batch_files` like any other). A `remove` row is
confirmed by the absence and dropped. A present member with a pending row
is settled by the store's gate rule (bytes the row names → echo; anything
else → the file wins), not by this layer.

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

0. **Materialize** (2.2): replay every pending materialization row of the
   repo through the filesystem doc store (`spec/store` §5.7
   `materialize_pending`) before looking at the disk, so a file a crashed or
   refused api write left behind the database is brought to its committed
   revision rather than read back as a human edit; the paths cleared are
   reported as `materialized`. A materialized file is a candidate below (its
   stat moved) that echo-suppresses: its bytes are the ones the store holds.
1. **Candidates**: paths not in the cache, or whose `(mtime_ns, size)`
   differs from the cache. **Deletions**: cached paths not on disk.
2. For each candidate, hash its bytes. If the hash differs from the cached
   hash (or there is no cache row) it is **changed**; otherwise only the
   cache's `(mtime_ns, size)` is refreshed (a touch without an edit costs a
   hash, never an ingest).
3. `process_checkpoint(changed ++ deletions)` as one batch.
4. Refresh the cache for every changed path (`record_file_stat`: `INSERT …
   ON CONFLICT DO UPDATE` with the fresh stat and the hash; a path that
   vanished meanwhile deletes its row) and delete the rows of the deletions
   — except a `failed` member's (4.1): it was rolled back and stays a
   candidate for the next sweep.

5. **Legacy repair** (4.4; `spec/store` §5.11): when the repository's
   `legacy_bytes` alert is **active** after step 3, re-derive the
   repository's legacy set — the live documents whose rows do not reproduce
   their `file_hash` (`spec/store` §3.4 step 17 (16); a member step 3 just
   ingested reproduces by construction) — and for each one whose file is
   present and hashes to `file_hash`, run the repair of `spec/store` §5.11:
   the file's parse must have the rows' exact shape, types and `raw`s, then
   the separator columns alone are rewritten from it; no commit, no head,
   no feed row, no `updated_at`. A document whose file is absent, whose
   bytes differ from `file_hash` (it moved on between the plan and now), or
   whose parse differs from its rows stays in the set. Then the alert
   follows the remainder — refreshed with the new count and sample, or
   cleared when none is left. The repaired paths are reported as
   `repaired` (bytewise path order). A sweep without an active alert skips
   the step entirely: the check is a pass over the repository's bytes.
6. **Provider checkpoint** (4.5; `spec/store` §5.12): when the repository's
   history is kept by an attached provider (`capabilities.history.config.
   provider` = `git`) and its row is `enabled`, run the provider's checkpoint
   worker once — the feed rows this sweep and every write since the last run
   appended become commits. Best effort: a provider that is not attached or
   cannot run (`git` not on PATH) raises `history_provider_unavailable` and
   is skipped; the sweep itself never fails for it and the rows wait for the
   next run. A native repository has no step 6.

Result: the batch result plus `{ scanned, candidates, changed:
ingested or deleted or conflicted or failed or repaired non-empty, materialized, repaired }`; a sweep with nothing to do
still writes the status row (`batch_id` NULL). `file_stats` is derived: a
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

**Recovery** (startup): step 0 as the sweep's — replay the pending
materialization rows (`materialized`, 2.2), the recorded intent of a write
the process did not finish (`spec/store` 17.0 §5.7: the row itself carries
the head it renders and the engine's own prior bytes, so the replay reads no
history table); then for every live doc, a missing file is `missing`; a file
whose hash differs from the document's `file_hash` (the bytes its head
renders to — through 16.x the current revision's `rendered_hash`) is
re-ingested as an observed commit (one document at a time, not a batch — §9)
and listed `healed`, and a pending row step 0 kept at that path (foreign
bytes) goes with the heal: the file won. Recovery writes no status row
and does not refresh `file_stats` (the next sweep re-hashes the healed file
and echo-suppresses it). Recovery does not run the legacy repair (step 5
above): a legacy document's file hashes to `file_hash`, so recovery sees
nothing to heal; the sweep owns the repair.

### 4.4 Status (4.0)

`repos_status(repo, root?)`: counts of live docs, live blocks, the **feed's
position** `feed: { epoch, oldest, head }` (`spec/store` §3.1 — in place of
the 3.x `commits` count), open edges; `disk` = the drift counts with
`checked: true` when a root was supplied, else zeros with `checked: false`.
`unconverged` is gone (D9, resolution 4: `file_hash` is the head's hash by
construction, so it was identically zero; `disk.changed` is the signal).
`sync_status`: `epoch`, `oldest`, `head` (the feed's; `last_commit_seq`
through 3.x), `last_batch: { ts, batch_id, files } | null` (the status row of
§4.1; `last_checkpoint` through 3.x), `convergent` = `checked && no drift` —
never green on an unverified disk — and `capabilities` as `version` reports
them (`spec/surface` §4). On the wire the keys are the reference's camelCase
(`lastBatch.batchId`, `diskChecked`).

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
- The engine's **change feed**, `changes_since(cursor = 0, epoch?, limit =
  50, origin?)`, is `spec/surface` §3 (6.0): the core's feed
  (`spec/store` §3.1 `feed`/`feed_entries`), each digest `{ commit, seq, ts,
  origin, actor, batch_id, plan_id?, summary, revisions: [{ _id, _path,
  _hash, kind, from_path? }] }`, the page `{ digests, cursor, epoch, oldest,
  head, truncated }`. **The cursor is `(epoch, seq)`**: a consumer stores
  both and sends both (the 3.x cursor was the bare `seq`; through 2.x the
  revision was `{ id, path, hash }`, before 2.0 `{ doc, path, content_hash
  }`). A consumer with **no stored cursor** sends `cursor = 0`: served while
  the feed still begins at 1, `expired_cursor` once it has been pruned to
  `oldest ≥ 2` (`spec/surface` §3; store 17.0, 2026-10-26 — a first-time
  consumer must not silently miss the deletions the pruned rows carried), so
  it bootstraps by the rescan below instead of being served from `oldest`.
  `summary` is a human line the fixtures do not pin and the coordinator
  never reads.
- **Expired cursor → rescan (4.0, D7).** On `expired_cursor { epoch, oldest,
  head }` the consumer runs the **rescan procedure**:
  1. Record `S = head` and `E = epoch` from the error (the server's current
     position).
  2. Page the server's live documents (`docs_list`, `limit`/`cursor`, with
     `_hash`: `query` `docs { select _id, _path, _hash }` on the minimal
     profile) into a set `L` of `(id, path, hash)`.
  3. **Reconcile the id set**: for every `(id, path, hash)` in `L` whose
     `hash` differs from the consumer's copy, pull the bytes
     (`docs_read`/`read_doc`) and apply them at `path`; a consumer-side path
     whose id is in `L` under another path is a move; **absence from `L` is
     deletion** — every consumer-side document whose id is not in `L` is
     removed.
  4. Resume `changes_since(cursor = S, epoch = E)`. The feed's retention
     floor (`spec/store` §7.4: ≥ 10 days and ≥ 10 000 entries) is the
     **bootstrap lease**: a rescan that completes within it resumes without
     a second expiry; one that does not repeats from step 1. No server-side
     lease object exists in this round (resolution 2: retention never waits
     on a consumer).
  The reference's coordinator (`rescan()`) applies step 3 by path — a source
  speaks paths, not ids — so a moved document is a write at the new path and
  a removal of the old one, and runs the procedure at most once per
  `sync_out` call (a second expiry is the caller's retry).
- **The `$git` cursor row (4.5, store 17.5 Phase 6a; `spec/store` §5.12).**
  The git history provider's checkpoint worker is a consumer of this feed
  like any other: its cursor is one reserved row of `sync_state` per
  repository, `(repo_id, '$git', '')` — a sentinel source id like the
  semantic watermark's `$semantic`, never a minted `src_` id — with
  `revision` the branch tip's sha and `cursor` the JSON `{ epoch, seq }` it
  covers. The row is a CACHE of the tip's `omgbase-seq` trailer: the worker
  resumes from the trailer, writes the row after every commit, and a crash
  between the two leaves the row behind the tip, which the next run reads
  past; `history purge` deletes it. An `expired_cursor` is its rescan — one
  snapshot commit at the head (§5.12), the procedure above applied by a
  consumer that keeps the current tree rather than a copy.
- **The sync base.** A client of the feed keeps its own base — the `(epoch,
  seq)` it last applied and the hashes it last saw; the server promises
  nothing beyond the feed's retention floor. Optional history supplies no
  unlimited common ancestor: a client that falls behind the floor rescans
  and, where its own copy diverged meanwhile, surfaces the divergence as a
  conflict in its own terms — the server's current state wins the feed, the
  client's edits are the client's to re-apply. A server-side lease (a
  snapshot pinned for a named client beyond the floor) is a later addition
  and is not specified here.
- `sync_out(cursor = 0, epoch?)`: page the engine's `changes_since(cursor,
  epoch)`; for every digest **whose origin is not `observed`** and every
  document in it, by `kind`: `created`/`changed`/`moved` → read the doc and
  `write` its bytes at `_path` (a `moved` also `remove`s `from_path`);
  `deleted` → `remove` (a path is removed at most once per call: a
  tombstoned document's earlier digests and its own all name it); a document
  that no longer reads is removed; follow `truncated` pages, passing the
  page's `epoch` along; return the final `cursor` and `epoch` (and
  `rescanned: true` when the procedure above ran). A source without `write`
  exports nothing and returns the cursor unchanged. Loop safety: the
  engine's echo gate makes a written file that comes back an echo, and
  observed commits are never exported.
- `watch_in`: subscribe when the source can watch; each batch runs
  `reconcile`.

## 7. Locks

Both are advisory lock files under `.omgbase/`, created with exclusive
`O_EXCL` semantics, holding `{"pid": <holder>, ...}` as JSON; a lock whose
holder pid is no longer alive (signal 0 fails with anything but `EPERM`) is
stolen.

- **Writer lock** `writer.lock`: taken by **every host around every
  write, once, at the host's outermost write boundary, for the write's
  whole duration** (since 2.1; 2.0 said "around a mutation's commit phase
  and checkpoint ingests", which left the MCP tool call and the CLI verb
  to each engine). The boundaries are: an MCP write tool call (the 21
  write tools of `spec/surface` §4, dry runs included, so a document move
  and its follow-up inbound-link retarget are one holding); a CLI write
  verb run against a local workspace (`--server` does not lock locally —
  the remote server does); every checkpoint ingest — the watcher's priming
  sweep and per-batch checkpoints, a one-shot command's pre-verb freshness
  sweep and a one-shot `sync` (§4.3, §6). Inside one holding the engine
  takes no second lock:
  the commit phase of `spec/mutate` §4 step 5 runs under the boundary's
  lock, never its own. A waiter polls every 25 ms up to 5 s, then fails
  `WriterLockTimeout` naming the holder pid; at the MCP boundary that
  failure is the tool's error envelope; released by unlinking. A lock
  held by a **live** process is never stolen, however old (§9: the
  reference stole after 30 s).
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
  projection is `repos` (4.0: with `epoch`), `adapters`, `sources`,
  `attachments`, `sync_state` (4.0: with the three status columns),
  `workspace_settings`, plus `repos_status` fields that need
  no disk (`docs`, `blocks`, `feed: { epoch, oldest, head }`, `open_edges`;
  4.0 — `commits`/`unconverged` through 3.x).
- **`checkpoint.json`**: scripts over an in-memory filesystem (`disk` steps
  set `{ path, content, mtime_ns }` — a safe-integer JSON number; `rm`
  steps remove; the walk is insertion order), on a sourceless repo `rp_0`,
  with `sweep { ts }`, `checkpoint { ts, paths }` (4.0: no `git_head`),
  `drift`, `recover { ts }`, `rebuild_stats` steps, and (4.4) `sql {
  statements }` (raw SQL executed on the store in order — the device that
  plants a state the production paths never write: a legacy document's NULL
  separators, a dropped `file_stats` row; outcome `{}`), `legacy_bytes { ts
  }` (the fidelity check of `spec/store` §5.11 re-derived and the
  `legacy_bytes` alert written to match at `ts`; outcome `{ docs, sample }`
  — the count and the first 20 ids) and `alerts {}` (the repository's active
  alerts as the channel lists them; outcome `{ active: [{ code, severity,
  message, since, detail? }] }`); `expect.steps` records
  each result (`batch_id` — 4.0, `checkpoint_id` through 3.x — buckets,
  counters — `scanned`, `candidates`, `changed`; a `sweep` outcome carries
  `repaired` **only when non-empty**, 4.4), and the projection adds
  `sync_state` (4.0: the repo's rows by (`source_id`, `path`) as `{
  source_id, path, revision, cursor, last_batch_ts, last_batch_id,
  last_batch_files }` — the status row among them; `checkpoints` through
  3.x) and `file_stats` (`{ path, mtime_ns, size, hash }` by path) to the
  `spec/store` §9.4 tables (which include `feed`/`feed_entries` since store
  17.0); the store's §8 invariants hold after every ingesting step.
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
  import | delete | observe | gc { retain_days, retain_entries } }` (`gc`:
  the repository's `feed.*` settings written, then the default sweep at `ts`
  — `spec/store` §7.4; outcome `{ feed_pruned }`), `sync_in { ts }`,
  `reconcile { ts, paths }`,
  `sync_out { cursor?, epoch? }`; each outcome records the summary (a
  `sync_out`'s `{ cursor, epoch, written, removed, rescanned? }`, 4.0) and
  the **calls** made — `[{ engine: "observe_many" | "observe_delete" |
  "changes_since" (with `cursor` and, when the coordinator sent one, `epoch`)
  | "list_docs" | "read_doc", … }, { source: "enumerate" | "fetch" | "write"
  | "remove", … }]` — against a recording in-process engine client (which
  injects the step's `ts` and the `page_limit`) and an in-memory source; the
  projection adds `files`, `docs [{ doc_id, path, deleted }]` and `commits
  [{ commit_id, seq, origin, actor }]` — read from the **feed** (4.0; the
  recorder's `commits` is its twin). `protocol::sync-out-expired-cursor-
  rescans` pins the rescan; `protocol::sync-out-cursor-0-on-a-pruned-feed-
  rescans` pins the bootstrap of a consumer with no stored cursor over a
  pruned feed (the deletion the pruned rows carried reaches the source only
  through the rescan).

**The runs without the history module (4.2; generalised 4.3 — `spec/store`
§9.6, `OMGBASE_CAPABILITIES=core|semantic`; modular-core Phase 4b/5a).** The
checkpoint runner must be able to run the SAME scripts on a composition
without the history module and compare them; the semantic module plays no
part in this spec, so `history` compares as `full`. The rule, mirrored by
both runners: (1) nothing is skipped — every step of
`checkpoint.json` (`disk`, `rm`, `sweep`, `checkpoint`, `drift`, `recover`,
`rebuild_stats`) is the core's, and `pure.json`, `registry.json` and the
`adapter` cases of `protocol.json` touch no history table, so they run
unchanged; (2) a checkpoint case's `expect` is compared with its history
tables EMPTIED — `commits`, `revisions`, `blobs`, `tree_nodes`,
`dispositions`, `block_changes`, `archives` are `[]` on both sides — while
the step outcomes (the batch id, the buckets, the counters), the core
tables (`docs`, `feed`, `feed_entries`, `blocks`, `resurrection_pool`,
`sections`, `pending_materializations`), `sync_state` and `file_stats` are
compared as recorded (a repository born `disabled` writes the same feed,
heads and claims; the projection carries no `id_claims`); (3) the store's
invariants are the core's alone (`spec/store` §9.6); (4) the runner reports
how many cases it compared this way; (5) `SYNC_SPEC_UPDATE` is refused under
the override — the fixtures are the full composition's; (6) the runner prints
one ledger line `[sync spec] composition=<name>: compared=<n> mapped=<n>
skipped=<n>` (4.3) that `pnpm conformance` collects; (7) the fifth
composition `git` (4.5, `spec/store` §9.6) has no native module and
compares exactly as `core` — no sync fixture drives the git provider (the
sweep's step 6 is a no-op on a native repository). The reference:
`packages/core/corpus/sync/spec.test.ts` (`coreModeCheckpointExpect`); the
coordinator cases of `@omgbase/sync`'s runner read the feed, never a history
table, and need no mapping.

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
- **Pinned (2.1) — the writer lock's scope.** Both engines now take the
  lock once per write at the outermost boundary (§7): the reference's
  `omg mcp` took none (it relied on in-process serialization, which a
  concurrent CLI writer or the other engine defeats) and locked a document
  move's rename and its inbound retarget separately, with a gap; the Rust
  CLI's local write verbs took none; both engines ran a one-shot command's
  pre-verb freshness sweep unlocked. The reference's lock is re-entrant
  within a process (a nested acquisition is a no-op; the outermost holder
  releases) so a boundary lock and a library-level `omgbaseDir` can
  coexist; the Rust lock is not, and its hosts nest nothing. The priming
  sweep is under the lock in both.
- **Open — what a second host still needs from §6/§7.** The scope of an
  embed drain, the exact error code a lock timeout produces at the MCP
  boundary (today the catch-all in both engines), `git_head` null on
  watcher/sweep checkpoints, and multi-connection SQLite busy handling (both
  engines: WAL + a 5 s busy timeout) are unpinned.
- **Pinned — lock stealing.** A lock file with an unparsable body has no
  pid and is treated as stale.

## Decisions

- 2026-10-26, sync 4.5 (store 17.5 Phase 6a of `docs/modular-core/` — the
  git history provider): the freshness sweep's **step 6** runs the attached
  provider's checkpoint worker (§4.3); the **`$git` cursor row** of
  `sync_state` (§6) — a sentinel source id beside `$semantic`, the tip sha and
  `{ epoch, seq }`, a cache of the branch tip's trailer. A procedure added, no
  stored row's meaning changed: a minor. The checkpoint runner's ledger (§8)
  gains the fifth composition `git`, compared like `core` (no native module).
- 2026-10-26, sync 4.4 (store 17.4 Phase 5a-ii of `docs/modular-core/`):
  **the sweep repairs legacy bytes.** The freshness sweep gains step 5
  (§4.3) and its result `repaired`: while the repository's `legacy_bytes`
  alert is active — the migration qualification found a real 16.x
  workspace whose rows, imported before block trivia was stored, did not
  reproduce their files (`spec/store` §5.11) — the sweep re-derives the
  legacy set and rewrites the separator columns of every document whose
  file is present and hashes to `file_hash`, minting nothing; a missing
  file leaves its document listed, a diverged file is the ordinary
  re-ingest. Decided here: the repair is the SWEEP's (the operator's `omg
  sync` after migrating, the runbook's step), not recovery's (recovery sees
  nothing to heal) and not the open's (the open names, it does not read
  files); the gate is the active alert, so a healthy repository's sweep
  never pays the pass over its bytes; `repaired` is projected in a `sweep`
  outcome only when non-empty, so the 19 existing checkpoint fixtures do
  not move. New steps for the fixtures: `sql` (the device `spec/cli` §8
  already had), `legacy_bytes`, `alerts`; three new `checkpoint::legacy-
  bytes-*` cases. A result member added: a minor.
- 2026-10-26, sync 4.3 (store 17.3 Phase 5a of `docs/modular-core/`): **the
  four compositions.** The §8 rule is keyed on the absent history module
  (`core`, `semantic`: 19 checkpoint cases mapped; `history`: as `full`) and
  the runner prints the ledger line. Three checkpoint fixtures moved by the
  store's D2 step two alone (`checkpoint::delete-tombstones-and-pools`,
  `drift-counts`, `recover-heals-diverged-and-lists-missing`: a tombstoned
  document's `blocks` rows are gone — `spec/store` §5.6).
- 2026-10-26, sync 4.2 (store 17.2 Phase 4b of `docs/modular-core/`): **the
  core-only run** (§8) — the checkpoint cases compare with the history tables
  emptied under `OMGBASE_CAPABILITIES=core`; no case or outcome moved (the
  4a gate had excluded `corpus/sync` because its runner lacked the mapping).
- 2026-10-26, sync 4.1 (store 17.1 Phase 4a of `docs/modular-core/`,
  resolution 18): the batch result and the sweep result gain **`failed`** —
  the members a throwing recorder rolled back (§4.1, §4.3); `sync_status.
  capabilities` follows `version`'s 6.1 shape (`spec/surface` §4). A
  `writer_requires` refusal (`spec/store` §5.4 step 0) is checked once per
  batch before any member commits, outside the member transactions, so the
  `writer_refused` alert survives it; the batch commits nothing.
- 2026-10-25, sync 4.0 (store 17.0 slice 3d — `docs/modular-core/` D4, D7;
  the contracts `phase-1-contracts.md` §1.6, §4.1–§4.5, §7 resolutions 4,
  6, 7): **`checkpoints` leaves; the feed cursor gains `epoch`.** The batch's
  record is the reserved status row of `sync_state` — `(repo_id, '', '')`
  with `last_batch_ts`, `last_batch_id`, `last_batch_files` — so a
  sourceless repository (every `checkpoint.json` fixture) has one too
  (resolution 7; the alternative was three columns on `repos`); its id is
  the feed's `batch_id`, the first committing member's commit id (resolution
  6 — no new prefix; `cp` is retired), and the result is `{ batch_id,
  ingested, suppressed, deleted, conflicted }`; `files`/`git_head` are gone
  (D9). `repos_status` reports the feed's `{ epoch, oldest, head }` and drops
  `unconverged` (resolution 4); `sync_status` reports `epoch`/`oldest`/
  `head`, `last_batch` and `capabilities`. The coordinator's cursor is
  `(epoch, seq)`; `expired_cursor` runs the rescan procedure (§6) and the
  sync base is stated. A stored row's meaning changes (`sync_state` carries
  the status) and the engine interface's cursor gains a member: a major.
  Fixtures: `checkpoint.json` projects `sync_state` instead of `checkpoints`
  and its step results carry `batch_id`; `registry.json`'s `repos` gain
  `epoch` and `repos_status` the feed; `protocol.json`'s `sync_out`
  summaries carry `epoch` (a paged walk passes it along) and
  `sync-out-expired-cursor-rescans` is new. The Rust `omgbase-sync` follows
  in a separate round; until it lands its spec runner is red by design.
- 2026-10-20, sync 3.0 (`spec/surface` 5.0 "underscore = engine"): a
  change-feed revision is `{ _id, _path, _hash }` (§6). The surface's row
  rule became one rule for every record kind — a bare name is user-authored,
  an underscore-prefixed name is engine-provided — and a `changes_since`
  revision is a `revisions` row rendered, so it takes the row's engine
  names; the digest's own keys (`commit`, `seq`, `ts`, `origin`, `actor`,
  `summary`) describe a commit and stay bare, as do `cursor`, `head` and
  `truncated`. The §6 engine clients (`@omgbase/sync`'s coordinator and
  `McpEngineClient`) read `_id`/`_path`/`_hash` off a revision; the adapter
  protocol (`protocol: 1`), the registry, the sweep, the checkpoints and the
  lock files are untouched. A key of the engine interface changed in
  spelling: a major, as 2.0 was. Fixtures: every `changes_since` revision
  re-keyed, nothing else. The Rust `omgbase-sync` follows in a separate
  round; until it lands its spec runner is red by design.
- 2026-10-12, sync 2.2: the freshness sweep and recovery gain step 0 —
  replay the api path's pending materialization rows (`spec/store` 14.0
  §5.7) before reading the disk — and a gone member whose path has a pending
  `write`/`rename` row is not tombstoned (§4.1, §4.3). The sweep is the
  production recovery point for a crash between an api commit and its file
  half (the priming sweep at `omg mcp` start, the pre-verb sweep of every
  CLI write); without step 0 it would read the stale file as a human revert.
  Procedure change, no fixture movement beyond the store projection's new
  `pending_materializations: []` key; a minor.
- 2026-10-12, sync 2.1: the writer lock's scope is pinned (§7, §9 "Pinned
  (2.1)") — every host, once, at its outermost write boundary, for the whole
  write, checkpoint ingests included — and a checkpoint's row + pool sweep
  are one transaction (§4.1). Procedure/decision-rule changes; no lock-file
  or row format change, so a minor.
- 2026-10-11, sync 2.0 (surface 3.0 batch 3): a change-feed revision is
  `{ id, path, hash }` — bare, because `spec/surface` §1.2's final rule gives
  omgbase no `$` names (`$` is OQX's); the entry below described the `$id`/
  `$path`/`$hash` interim spelling of the same unshipped 2.0 line. The §6
  engine clients read the bare keys. Fixtures: re-keyed again, nothing else.
- 2026-10-11, sync 2.0: a change-feed revision is `{ $id, $path, $hash }`
  (`spec/surface` §1.2, 3.0 — the row rule: `$` marks the engine-provided
  names that contend with user names, a result key carrying a row attribute
  is spelled as that attribute; `{ doc, path, content_hash }` before,
  `contentHash` on the wire). The §6 engine client reads the new keys in
  both implementations (`@omgbase/sync`'s `McpEngineClient`,
  `omgbase-sync::McpEngineClient`); the adapter protocol, the registry, the
  sweep and the checkpoints are untouched (`protocol: 1` stays). A key of the
  engine interface changed in spelling: a major.
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
