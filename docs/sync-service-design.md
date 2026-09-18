# Design: `@omgbase/sync` — a standalone store-to-store synchronizer

> **Status: IMPLEMENTED (ADR-014).** All six stages have landed on branch
> `multi-repo-story` (see §9). This file is retained as the design rationale +
> stage record; the as-built surface lives in `docs/sync-plugins.md`,
> `docs/mcp-api.md`, `docs/data-model.md`, and the code (ground truth).
>
> **CLI surface (follow-up, done):** there is one sync verb — `omg sync`
> (one-shot local), `omg sync --watch` (live local; the former `omg watch` is
> gone), and `omg sync --server <cmd>` (remote over MCP, via the Coordinator).
> `--server` is a **global** flag (`context.REMOTE_OK`) so any command can adopt
> remote mode over time (roadmap: reads, `shell`); today only `sync` implements
> it. `omgbase-sync` is now a thin wrapper over the shared `runFsMirror` — i.e.
> `omg sync --server … --root X` ≡ `omgbase-sync --root X`.
>
> Not yet done: the optional `subscribe` (D1), durable export-cursor persistence,
> and per-command remote (`--server`) support beyond `sync`.

## 1. Motivation

Today "sync" is three things fused together and living *inside* `packages/core`,
reached in-process against the `Store`:

- the **reconciliation driver** (`sync/driver.ts` `reconcileChanges`) — the loop
  that fetches bytes from a source, runs the echo gate, and commits non-echoes;
- the **filesystem binding**, expressed as `repos.root_path` (a column), which
  the write path (`mutate/apply.ts`), freshness (`sync/freshness.ts`), repo
  selection (`sync/workspace.ts`), and the watcher (`cli/cmd/mcp.ts`) all read;
- **`attach`** (three overlapping impls: `core/attach.ts`, `sync/attach.ts`,
  `sync/driver.ts attachSource`) = "create a repo row + one-shot ingest a folder".

Two forces make this want to split out:

1. **Remote / headless servers.** A remote `omg mcp` over HTTP does not have (or
   want) a local working tree. It only needs the DB — which *already* holds a
   byte-exact representation of every file (blocks' retained raw bytes + trivia +
   frontmatter blob; `docsRead`/`renderDoc` reconstruct the file byte-for-byte,
   asserted by the convergence invariant, ADR-004). The filesystem is one
   *optional* peer, not an intrinsic property of a repo.
2. **Multi-source repos.** The schema already reserves `adapters`/`sources`/
   `attachments`/`sync_state` (schema v9) for a repo that syncs with *several*
   external stores (fs, git, S3, another omgbase). `root_path` is the v1
   shortcut that predates wiring those tables.

The move: reify sync as its own service that **treats omgbase as one peer behind
its MCP interface** and each external store as another peer behind the existing
source-adapter protocol. Reconciliation logic stays engine-owned (ADR-003); the
service is a coordinator, not a second reconciler.

## 2. The model after this change

```
                 ┌─────────────────────────────────────────┐
                 │            @omgbase/sync (service)        │
                 │  coordinator loop + per-path echo/hash    │
                 │  bookkeeping; NO opset/identity logic     │
                 └───────▲───────────────────────▲───────────┘
        MCP (HTTP/stdio) │                       │ source-adapter NDJSON
                         │                       │ (existing external-source.ts protocol)
              ┌──────────┴─────────┐   ┌─────────┴──────────┐
              │  omgbase repo      │   │  external store    │
              │  (DB = canonical   │   │  fs / git / S3 /   │
              │  identity+history) │   │  another omgbase   │
              └────────────────────┘   └────────────────────┘
```

- **Repo** = identity + history in the DB (canonical). Owns no filesystem.
- **Source** = an external store the repo reconciles with. A filesystem folder is
  *a* source (the `fs` adapter), not the repo's essence.
- **`attach`** = sugar: create repo + register an `fs` source at a path + attach +
  run an initial sync.
- **`root_path`** = derived read-through of the attached `fs` source's root during
  migration; **removed** at the end (ADR-014 final stage).
- A **DB-canonical / remote repo** simply has zero attached sources → nothing to
  write through to → `apply`'s file-write step is a no-op (see §5). This is the
  canonicality inversion for headless deployments: with no file, the DB is the
  content authority; export to a real FS/git is then the sync service's job.

The engine keeps ADR-003/004: it owns the echo gate *for in-process sources*, and
exposes reconciliation over MCP via `docs_update` (identity-preserving whole-doc
update = plan + apply) and a new `observe` tool (observed-origin ingest). The
service never threads block identity itself.

## 3. Schema sketch

**No new tables are required for v1** — the reserved v9 tables are the seam. What
changes is *wiring* and, later, a column removal.

Existing (schema v9), reused as-is:

```sql
adapters(name PK, command, args)                         -- name → external command
sources(source_id PK, name UNIQUE, adapter→adapters, config, env)
attachments(repo_id→repos, source_id→sources, PK(repo_id,source_id))  -- m:n
sync_state(repo_id, source_id, path, revision, cursor,   -- engine-owned per-path
           PK(repo_id,source_id,path))                   -- change tracking; path='' = cursor row
```

Changes across the migration:

- **v13 (structural, additive):** seed a built-in `fs` adapter row
  (`command = <node> <fs-adapter/bin.js>`); teach source resolution to read
  `sources`/`attachments` instead of synthesizing from `root_path`
  (`cli/cmd/_source.ts openFsSource`). `root_path` still populated + read.
- **v14 (fs binding moves):** `attach` writes a `sources` row (`config.root`) +
  `attachments` row. `root_path` becomes a **derived** convenience — computed as
  the repo's attached `fs` source's `config.root`, not stored/authoritative.
- **v15 (breaking, LAST):** drop `repos.root_path`. SQLite has no
  `DROP COLUMN` in old versions we target → table-rebuild migration
  (create `repos_new`, copy, swap) done programmatically in `store.ts` (same
  pattern as v11's `documents`→`docs` rename).

`commits.origin` already admits `'observed'` and `changes_since` already filters
by origin — **no schema change** for the observe tool.

## 4. New / changed MCP surface

The pull side is nearly complete already: `changes_since` (cursor feed),
`docs_read` / `docs_read_at` (exact bytes), `docs_history` (`contentHash`). Gaps:

### 4.1 `observe` (NEW — the real write-side gap)

```
observe(path: string, content: string, source?: string)
  → { doc, path, rev, disposition_summary, converged }
```

Ingests whole-file bytes for `path` as an **observed-origin** commit (a write
*around* the engine — the sync service is mirroring an external edit), threading
block identity via the reconciling resolver. Contrast `docs_update`, which is
**api-origin** (a write *through* the engine, agent intent). Both go through the
same reconcile+commit machinery; only `origin` (and thus the change-feed
semantics + matcher path) differ. Idempotent: bytes whose hash equals the current
`file_hash` are an echo → no commit (`converged: true`, empty disposition).
Deletion mirror = existing `docs_delete`.

Rationale: without this, a sync service can only push `api` commits, which
corrupts the change feed's origin signal and mislabels human edits as agent
intent. `origin` is load-bearing for loop prevention (§6).

### 4.2 `changes_since` — enrich digests with `contentHash`

Add per-revision `contentHash` (hex of `rendered_hash`) to each digest's
`revisions[]` so a puller can decide "changed vs echo" without a follow-up
`docs_read`/`docs_history` round-trip. Purely additive to the payload.

### 4.3 `subscribe` (NEW — optional, low-latency; poll works without it)

A streaming variant of `changes_since`: the server pushes commit digests as they
land (MCP notifications / SSE on the HTTP transport; long-poll on stdio). v1 MAY
ship poll-only (`changes_since` + client interval) and add `subscribe` when
latency matters. The watcher already produces the events in-process
(`onCheckpoint`); this exposes them to MCP clients.

## 5. `apply` file-write via a `DocStore` seam — **AS-BUILT (Stage 2)**

`mutate/apply.ts` and `mutate/docs.ts` called `node:fs` directly (`join(rootPath,
path)`, `readFileSync`, `writeFileSync`+`rename`, `existsSync`, `unlinkSync`) plus
the freshness stat-cache (`recordFileStat` / `file_stats`). These are now behind
`mutate/doc-store.ts` `DocStore`, keyed on repo-relative paths (the store joins
its root internally):

```ts
interface DocStore {
  exists(path): boolean;
  read(path): string | null;                 // for the file-CAS check
  write(path, bytes): void;                   // atomic tmp+rename, mkdir -p
  rename(from, to): void;
  remove(path): void;
  recordStat(store, repoId, path, bytes): void;  // freshness cache (fs-mtime concern)
  clearStat(store, repoId, path): void;
}
```

Implementations: `FsDocStore(root)` (today's behavior exactly), `NullDocStore`
(headless DB-canonical repo — every fs op is a no-op; the DB *is* the artifact).
`ApplyRequest`/`DocOpContext` gained an optional `docStore?` and made `rootPath?`
optional; when `docStore` is absent it defaults to `FsDocStore(rootPath)` via
`resolveDocStore`, so **every existing caller is unchanged** and the filesystem
path is byte-for-byte identical. Headless callers pass a `NullDocStore` and no
`rootPath`. The freshness `recordStat`/`clearStat` calls stay gated on
`omgbaseDir` exactly as before. This is the same seam `root_path` removal needs.

## 6. Loop prevention & origin semantics

The echo gate currently lives inside the in-process driver (`file_hash ==
sha256(bytes)` → suppress, `driver.ts:66`). Over MCP the *service* must own the
equivalent, because it is now the loop:

- Track a per-path content hash (this is exactly what `sync_state.revision` is
  for). On a pulled change, compare to what it last wrote to the other peer;
  equal ⇒ suppress (don't write back).
- Use `origin` as a coarse filter: an fs-export coordinator ignores commits it
  itself produced via `observe` (observed-origin from that source) — but origin
  alone is insufficient for bidirectional peer sync, so per-path hash
  reconciliation via `sync_state` remains the real guard.

## 7. `driver.ts` → MCP-client refactor, call-by-call

Current `reconcileChanges(store, repoId, source, changes)` reaches the Store
directly. The MCP-client version keeps the *shape* of the loop but swaps every
store touch for an MCP tool call. Mapping:

| `driver.ts` today | in-process call | `@omgbase/sync` over MCP |
| --- | --- | --- |
| look up existing doc + `file_hash` for a path | `SELECT doc_id,file_hash FROM docs …` | `changes_since` digest `contentHash` (§4.2), or `docs_history({doc})` `contentHash`; cache in `sync_state` |
| fetch source bytes | `source.fetch(path)` | unchanged — same adapter protocol |
| echo gate (`file_hash.equals(diskHash)`) | in-loop compare | client-side compare vs cached `sync_state.revision` (§6) |
| member left scope (delete) | `tombstoneObservedDeletion(...)` | `docs_delete(doc)` |
| conflict markers → ingest opaque + flag | `ingestFile(...)` + `UPDATE docs SET conflicted=1` | `observe(path, content)`; conflict flag stays engine-side (observe detects markers) |
| normal changed member → ingest observed | `ingestFile(store, repoId, path, content, {resolveIds: reconciling})` | **`observe(path, content, source)`** (§4.1) — identity threading stays server-side |
| checkpoint row | `INSERT INTO checkpoints …` | server writes it inside `observe`/batch; client advances its `sync_state` cursor |
| resurrection sweep | `sweepResurrectionPool(...)` | server-side, inside the observe/commit path |
| `attachSource` initial walk | `source.enumerate()` + per-file `ingestFile` | `source.enumerate()` + per-file `observe` (or a batched `observe_many`) |
| export direction (DB → source) | (today only the in-proc watcher via `source.write`) | poll `changes_since`/`subscribe` → `docs_read` → `source.write(path, bytes)` |

Net: the loop, the adapter protocol, and the echo-gate *concept* survive intact;
what moves is the data access (Store → MCP tools) and the ownership of the echo
bookkeeping (engine → coordinator, backed by `sync_state`). The clever
identity/opset work never leaves the engine — it is reached through `observe` /
`docs_update`.

## 8. `attach` is gone — `omg source add <dir>` is the one way in

There is no top-level `attach`/`ingest`/`load` verb. `omg source add <dir>` is how
content enters, and it decomposes into:

```
omg source add ./foo [--slug s] [--name n]
  ≡  ensureRepo(slug)                       # repo identity (no auto source when null)
   + ensureFsAdapter + createSource(<slug>-fs, fs, {root: abs}) + attach
   + freshnessSweep(repo, abs)              # the initial sync — the SAME reconcile
                                            #   (observeOne) every later sync uses
```

The initial ingest is just the new source's first sync — not a distinct code path
(the old `attachRepo` private `ingestFile` walk — since renamed `ingestDirectory`
and kept only as a library/test helper — is no longer on the CLI path).
"attach" survives only as the source-binding verb (`omg source attach <name>`,
for an existing source). A sourceless (headless, DB-canonical) repo is created
via the library (`ensureRepo(store, slug, null)`); the CLI has no verb that makes
one, since `source add` always registers a source. Rationale: "attach"/"ingest"/
"load" all mislead — the durable thing is a *source*, added once and synced;
`import` already owns one-shot loading.

## 9. Staged migration plan (order of implementation)

Additive → structural → breaking. Every stage ends green on `pnpm build && pnpm test`.

1. **Stage 1 — additive MCP surface (no behavior change). ✅ DONE.**
   `observe` tool + `changes_since` `contentHash` enrichment. New tests.
   Nothing existing changes. (`subscribe` deferred — open question §10.)
2. **Stage 2 — `DocStore` seam in `apply` + `docs` ops. ✅ DONE.** `mutate/
   doc-store.ts` (`DocStore`, `FsDocStore`, `NullDocStore`); `apply`/`docs` ops
   route their fs + freshness-cache calls through it; optional `docStore?` +
   optional `rootPath?`, defaulting to `FsDocStore(rootPath)`. Behavior-preserving
   (all existing callers untouched); headless path proven by a `NullDocStore`
   test. See §5.
3. **Stage 3 — wire the source tables. ✅ DONE.** `sync/sources.ts` registry
   CRUD (`ensureAdapter`/`createSource`/`attachSourceToRepo`/`sourcesForRepo`/
   `renderConfigFlags`, `src_` id prefix); `cli/cmd/source.ts` (`omg source
   list/add/attach/detach/rm`); `_source.ts` renamed `openFsSource`→
   `openRepoSource(store, repo)`, which resolves the repo's fs source from the
   registry and **falls back to `root_path`** when none is registered. `attach`
   still writes `root_path` (Stage 5 makes it populate the registry). `Store` is
   now exported from core. FK on `sources.adapter` is enforced, so the built-in
   `fs` adapter row is seeded (`ensureFsAdapter`) before an fs source is created.
4. **Stage 4 — `@omgbase/sync` package.**
   - ✅ **D2 done** — `checkpoint.ts processCheckpoint` and `driver.ts
     reconcileChanges` now both route through the single `observeOne` primitive
     (`sync/observe.ts`); the echo/conflict/reconcile algorithm has one
     implementation. Behavior-preserving (all sync tests green).
   - ✅ **D3 done** — `observe_many` MCP tool + `observeMany` core, sharing
     `observeOne`.
   - ✅ **`@omgbase/sync` package done** — `packages/sync`: `EngineClient` seam
     (`InProcessEngineClient` for local/tests; `McpEngineClient` +
     `connectStdioEngine` for remote over MCP), `Coordinator` (`syncIn` /
     `reconcile(paths)` / `syncOut` / `watchIn`), and the `omgbase-sync` bin
     (spawns `omg mcp`, mirrors an fs directory). `observe_delete` tool +
     `observeDelete` core added (recommendation a). syncOut skips observed-origin
     commits (loop safety, recommendation c) and relies on the idempotent echo
     gate; cursor is per-session in v1 (recommendation b). Coordinator tests +
     end-to-end MCP-transport smoke verified.
   - ✅ **CLI unified (follow-up)** — one `omg sync` verb: local one-shot,
     `--watch` (live local; `omg watch` removed), and `--server <cmd>` (remote via
     the Coordinator, the global `--server` flag). `omgbase-sync` reduced to a
     thin wrapper over the shared `runFsMirror`.
   - ⏳ **Deferred** — durable export-cursor persistence; `subscribe` (D1);
     `--server` support for commands beyond `sync` (roadmap: reads, `shell`).
5. **Stage 5 — `attach` populates the registry. ✅ DONE.** Source registration
   now lives in `ensureRepo` itself: given a `rootPath` it seeds the `fs` adapter
   + creates+attaches an `<slug>-fs` source (idempotent). So *every* attach entry
   point (`core/attach.ts`, `sync/attach.ts`, the CLI) registers the source
   through one place — the fs-binding duplication that mattered is gone (two thin
   walk+ingest wrappers remain, but both funnel through `ensureRepo`).
6. **Stage 6 — remove `root_path`. ✅ DONE.** Schema v13 drops the column
   (`ALTER TABLE repos DROP COLUMN`, in a transaction) and migrates each existing
   `root_path` into an `fs` source + attachment. `RepoRow.rootPath` is now
   **derived** from the attached fs source (`Workspace.repos()` + `reposStatus`);
   it is `string | null` (null = sourceless/headless). The ~117 `repo.rootPath`
   *consumers* were unaffected; only 3 direct-SQL sites + a handful of CLI
   null-guards changed. `ensureRepo` no longer writes the column. Verified: a
   dedicated v12→v13 migration test, the full suite (780 core tests), and an
   end-to-end CLI smoke (derived rootPath + headless no-op).

## 10. Decisions (resolved 2026-09-17)

- **D1 — `subscribe`: poll-only in v1.** `changes_since(cursor)` on an interval is
  correct and simple; local change volume is low and the MCP hop is not a concern.
  When latency matters, add `subscribe` as **MCP resource-update notifications**
  (NOT a streaming tool — tools are request/response): expose the change feed as a
  resource, client `resources/subscribe`s, the server emits a payload-less
  `notifications/resources/updated` on commit, and the client pulls via
  `changes_since`. Works on stdio and Streamable-HTTP (SSE) transports.
- **D2 — one reconcile path; drift lives in the algorithm, not the transport.** The
  real drift risk is the duplicated reconcile logic in `checkpoint.ts` vs
  `driver.ts`; collapse both onto the single `observeFile` primitive (Stage 1) so
  there is exactly one implementation. `@omgbase/sync` is then the single
  coordinator. Local `watch`/`mcp` call `observeFile` in-process (shared primitive,
  so no behavior drift — and no awkward self-MCP-loop); remote uses the `observe`
  tool. (Revisit if a single-transport-everything policy is later preferred.)
- **D3 — add `observe_many`.** Batch form beside single `observe`; both loop the
  same `observeFile` primitive (one ts + one resurrection sweep + one writer-lock
  acquisition for the batch). Non-batch `observe` stays.
- **D4 — ADR-010 untouched.** Multi-engine identity is raised ONLY by omgbase↔
  omgbase *peer* sync where both sides mint independent opaque `b_` ids (IDs live
  in the DB, never in files — ADR-002); for *mirrors* that "should" share identity,
  the (deferred) path is the reserved `borne` source-identity capability + an
  identity-exchange protocol. The v1 target (filesystem ↔ omgbase) is one engine,
  one identity space, and never raises it. Aggregating genuinely-different (non-
  mirror) sources expects no shared identity. So: no supersession now; revisit
  ADR-010 only if omgbase↔omgbase mirror sync with shared block identity is pursued.
