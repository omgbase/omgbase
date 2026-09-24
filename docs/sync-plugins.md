# omgbase — Sync Adapters (External Source Reconciliation)

**Status:** as-built (verified 2026-09-23). The **external-adapter** model is what ships — adapters are separate processes speaking a stdio protocol, exactly as embedders are (`05 §6`); the earlier interim *in-process* `SyncSource` seam (commit `2850b28`) was superseded by it. The `@omgbase/fs-adapter` package is the first adapter; the source registry (§2) is wired and `omg source` is its UI (ADR-014, all stages done).
**Depends on:** `architecture.md` §6 (checkpoints), `reconciliation-spec.md` §8 (sync pipeline placement), `data-model.md` §3 (repos), `cli.md` §3.3 (freshness sweep, watch lease). **Parallels:** `graph-and-query.md` §6 + `packages/core/src/search/external.ts` (the embedder external-process pattern this mirrors).

---

## 1. Purpose

`sync` in omgbase is **reconciliation between an external source scope and an omgbase repo**, not "read files from disk." The filesystem is one source; git, GitHub, and Linear are others. Sources are **external processes** — an adapter can be written in any language, ships its own dependencies (chokidar, `@octokit`, the Linear SDK), and is swapped without touching the engine core. The engine core carries **no source implementation and no filesystem-watch dependency** (chokidar lives in `@omgbase/fs-adapter`, not core).

```text
external source scope
        ↓
  adapter process   ← spawned; stdio protocol (§4); any language
        ↓  (stdio)
   omgbase engine   ← reconciliation, identity, history, commits, convergence
        ↓
   omgbase repo
```

This is the same architecture decision as the embedder: a capability the core must not vendor becomes a separate process behind a stdio contract. See `05 §6` — "a fake local provider is worse than useless." For sync the driver is dependency isolation and language independence: a GitHub adapter should not force `@octokit` into the engine.

## 2. Source registry (wired — ADR-014 Stage 3)

The workspace-level registry separates *what a repo is* from *where its bytes come from*: **adapters** (a name → external command), **sources** (a named `{ adapter, config, env }`), **attachments** (a many-to-many join of repo ⇄ source), and per-attachment **sync_state** (revision/cursor tracking). All four tables exist in the schema (v9, `core/store/schema.ts`). As of ADR-014 Stage 3 the first three are **wired**: `core/src/sync/sources.ts` is the CRUD surface (`ensureAdapter`, `createSource`, `attachSourceToRepo`, `sourcesForRepo`, `renderConfigFlags`) and `omg source list/add/attach/detach/rm` (`cli/src/cmd/source.ts`) is the UI. `sync_state` is still unused: Stage 4 (`@omgbase/sync`) is done, but its coordinator keeps the export cursor per-session; durable cursor persistence into `sync_state` is the deferred follow-up (`sync-service-design.md` §9, Stage 4 "Deferred").

Source resolution reads the **registry**: `omg sync --watch` / `omg mcp` call `openRepoSource(store, repo)` (`cli/src/cmd/_source.ts`), which finds the repo's attached `fs` source and spawns `@omgbase/fs-adapter` (bin **`omgbase-fs-adapter`**) with `renderConfigFlags(config)` (`{ root }` → `--root <root>`). A repo with no attached fs source is **sourceless** and its `sync`/`watch` is a no-op (§7). `attach` (via `ensureRepo`) registers the `fs` source, and `RepoRow.rootPath` is **derived** from it — the `repos.root_path` column was dropped in schema v13 (ADR-014 Stage 6). (`omg sync`'s freshness fast-path uses that derived `rootPath`; it shares the single `observeOne` reconcile primitive with the watcher and the `observe` MCP tool — ADR-014 D2.)

## 3. Invoking an adapter (as-built)

The engine spawns an adapter as a child process and speaks the stdio protocol (§4) to it. The in-engine spawn seam (`createExternalSource`, `sync/external-source.ts`) takes a `command`, a pre-rendered `args` array, and an optional `env` map merged over `process.env`. The *config → argv* mapping is built and is the only way a source's `config` reaches an adapter: `renderConfigFlags(config)` (`sync/sources.ts`) turns each `{ key: value }` of the stored JSON config into `--key <String(value)>` (a `true` boolean is a bare `--key`, `false`/`null`/`undefined` are skipped) — so the registered `fs` source's `{ root }` becomes `[<fs-adapter bin>, "--root", <root>]`, and `openRepoSource` (`cli/src/cmd/_source.ts`) spawns the current `node` binary with exactly that. A source's stored `env` map (§2) is passed straight through as the spawn's extra `env` when non-empty (merged over `process.env`); the built-in `fs` source stores none. What is **not** built: `$VAR` substitution / secret indirection inside that `env` map (values are used literally), and a launcher for any adapter other than the built-in `fs` one (`spawnSource` throws for others).

## 4. The stdio protocol

Newline-delimited JSON over the adapter's stdin/stdout, mirroring the embedder (`packages/core/src/search/external.ts`). **stdout is the protocol channel; stderr is logs/progress only, never protocol.** Requests carry a monotonic `id`; responses echo it (interleaving tolerated). The one extension beyond the embedder's strict request/response is a **server-initiated stream** for `watch`.

### 4.1 Handshake

On spawn the adapter writes exactly one line describing itself:

```json
{"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}
```

- `identity: "inferred" | "borne"` — does the source carry stable per-member identity (§5)?
- `writeThrough: boolean` — can the engine push its own mutations back?
- `watch: boolean` — can the adapter stream a change feed, or is it poll-only (engine re-`enumerate`s)?

### 4.2 Request / response methods

Engine → adapter (`{"id":n,"method":...,"params":...}`), adapter → engine (`{"id":n,"result":...}` or `{"id":n,"error":"..."}`):

| method | params | result |
|---|---|---|
| `enumerate` | — | `{ entries: [{ path, revision, sourceId? }] }` |
| `fetch` | `{ path }` | `{ item: { path, revision, content } \| null }` |
| `write` | `{ path, content }` | `{ ok: true }` *(writeThrough only)* |
| `remove` | `{ path }` | `{ ok: true }` *(writeThrough only)* |

There is no cursor/`changes_since` incremental-poll method in the built protocol: `enumerate` always returns the full current scope, and change discovery is either the push `watch` stream (§4.3) or a re-`enumerate`.

- **`path`** is the repo-relative storage key (`docs.path`).
- **`revision`** is the source's cheap change-token (§5.1).
- **`sourceId`** is the source's own locator when it differs from `path` (defaults to `path`; §5.2).
- **`content`** is the bytes the engine ingests. The engine hashes them itself.

### 4.3 The watch stream

If `capabilities.watch`, the engine sends `{"id":n,"method":"watch"}` and the adapter thereafter emits **unsolicited** batch events until the engine cancels:

```json
{"event":"batch","paths":["notes/a.md","notes/b.md"]}
```

Batching/debouncing to quiescence happens **adapter-side** (this is where chokidar lives). The engine cancels with `{"id":m,"method":"unwatch"}` and expects the adapter to stop emitting and exit cleanly on stdin EOF / SIGTERM.

## 5. Identity and the `revision` token

### 5.1 revision is the pivot

`revision` answers "did this member change, cheaply?" — a `SourceEntry.revision` string carried on every `enumerate`/`fetch` (`sync/plugin.ts`). The fs adapter emits `"mtime_ns:size"` (a stat, no read; `fs-adapter/src/index.ts`); a git adapter would use the blob SHA, GitHub/Linear an `updated_at`/version/ETag.

Echo suppression is engine-side. The **authoritative** layer is always the same: after `fetch`, the driver hashes the bytes and compares `sha256(content)` to the doc's stored `file_hash`; an equal hash is an echo and produces no commit (`sync/driver.ts`, `reconcileChanges`). A cheap first layer exists only for the filesystem fast-path: the CLI freshness sweep persists `(mtime_ns, size, hash)` in the derived **`file_stats`** cache and skips files whose stat is unchanged without re-reading them (`sync/freshness.ts`; `11 §3.3`). The external `reconcileChanges` driver keeps no per-source revision cache today — it re-`fetch`es each reported change and leans on the content-hash gate; the per-attachment `sync_state` table that would generalize `file_stats` across sources is reserved but inert (§6).

### 5.2 inferred vs borne identity

- **`inferred`** — anonymous bytes; block continuity is inferred by the reconciler (`03`): the probabilistic matcher, dispositions, the ≥0.995 precision gate. Filesystem and raw-git-blob adapters are `inferred`. This is the *only* reason that machinery runs.
- **`borne`** — stable upstream ids (Linear UUIDs, GitHub node ids) delivered as `sourceId`; the engine maps `sourceId → identity` deterministically and **skips the matcher** (running it would be wrong). *v1 status:* the driver has one path (`inferred`); the `borne` branch is defined so the reconcile call is written conditionally, but no `borne` adapter ships yet.

## 6. Persistent sync state (engine-owned)

Adapters are spawned fresh and stateless across runs, so durable change-tracking is the **engine's** job. Today that state is the filesystem **`file_stats`** cache — `(repo_id, path) → (mtime_ns, size, hash)` (`core/store/schema.ts`, written by `sync/freshness.ts`). It is derived and rebuildable (a full re-stat regenerates it via `rebuildFileStats`) and lets the freshness sweep skip unchanged files cheaply; the durable convergence signal remains `docs.file_hash`.

The reserved (inert) `sync_state` table generalizes this per **attachment** — a last-observed `revision` per `(attachment, path)`, an attachment-level poll/webhook `cursor`, and an optional `sourceId ↔ path` map for `borne` sources — so one source feeding two repos could track each independently. Nothing reads or writes `sync_state` yet; the filesystem fast-path owns `file_stats` directly, exactly as the interim in-process design did.

## 7. Repo & source lifecycle

The shipped verbs are minimal — `omg init` / `omg repos` (`cli/src/cmd/bootstrap.ts`) and `omg source add/list/attach/detach/rm` (`cli/src/cmd/source.ts`, the registry UI of §2). There is no `omg adapter …` verb (the `fs` adapter row is seeded implicitly) and no separate `omg repo create/attach/…` family — `omg source add` is the attach. What exists:

```text
omg init [dir]                  # workspace only: create .omgbase/ + db (does NOT ingest).
                                #   offers a .gitignore entry if dir is inside a git tree;
                                #   ends by suggesting `omg source add .`.
omg source add <dir> [--slug <s>] [--name <n>]
                                # point a (new or current) repo at a filesystem dir: create
                                #   the repo, register + attach an <slug>-fs source, and run
                                #   the initial sync (freshnessSweep). prompts before
                                #   ingesting; -y skips the prompt.
omg repos                       # list the workspace's repos (slug, root path, doc/block counts).
```

- **Workspace ≠ repo.** `.omgbase/` defines the workspace; `omg init` does not ingest or define a repo. A workspace can sit in a git root, a notes dir, or `$HOME`.
- **Workspace discovery:** `--workspace` flag wins; else `OMGBASE_WORKSPACE` env; else walk up from cwd for `.omgbase/` (the default). No global default dir.
- **Sourceless / headless repo:** a repo with no attached source. The **database is authoritative for content** (no external bytes, no write-back). `apply` works (with a `NullDocStore` — the file write is a no-op); `sync`/`watch` are no-ops; convergence is vacuous. Reachable through the library (`ensureRepo(store, slug, null)`); `omg source add` always registers an fs source, so the CLI never creates one.
- **`omg sync` (incl. `--watch`) / `omg mcp` take no source flags.** They resolve the repo and spawn its attached fs source's adapter (§2). The source is a durable property of the repo, never a per-invocation choice. (Remote sync uses the global `--server` flag, not a source flag.)

## 8. Multiplexing (future capability, not v1)

**Not built.** Once the source registry (§2) exists and a source's config is structured data, a future adapter could advertise `multiplex: true` and receive several source configs over the handshake instead of one via argv — one process serving many sources (many watched roots, one chokidar; many Linear scopes, one client). Today the engine spawns one adapter process per repo. The protocol keeps this path additive by allowing source config in a handshake message rather than *only* in argv.

## 9. The async consequence

An in-process `fetch()` returns bytes synchronously; over a pipe it is a round-trip. Therefore `SyncSource.enumerate`/`fetch` and the driver (`reconcileChanges`/`attachSource`/`Watcher`) are **async**. This ripples into the previously-synchronous freshness sweep the CLI router runs before every one-shot command (`11 §3.3`, `main.ts`): that sweep, and the commands that depend on it, become async. This is unavoidable once *any* source is external and is the main revision to the interim in-process seam.

## 10. Engine vs adapter ownership

| Concern | Owner |
|---|---|
| Enumerate scope · transport bytes · change feed · `revision` token | **adapter** |
| Debounce/batch of the watch feed | **adapter** |
| Content-hash echo suppression (`sha256` vs `file_hash`) | **engine** |
| Reconciliation / block identity (when `inferred`) | **engine** |
| Commit boundaries · checkpoint row · convergence check | **engine** |
| Durable change-detection state (`file_stats`, per repo; per-attachment `sync_state` reserved) | **engine** |
| Format decomposition (bytes → blocks) — a *different* axis | **engine** (format adapter) |

**Format adapters and source adapters are orthogonal.** A source adapter transports bytes; a format adapter (`markdown`/`yaml`/`json`, in-process, per-block, hot path) decomposes them. A Linear issue arrives via the `linear` *source* adapter and its markdown `description` is decomposed by the markdown *format* adapter. The word "adapter" is qualified whenever ambiguous.

## 11. Multi-repo is the payoff

One workspace DB holds many repos (`02 §3`) — each backed by its attached fs source(s) or sourceless; backing a repo with a different adapter is the deferred registry (§2). The MCP surface is now **multi-repo**: every tool takes an optional `repo` slug (ADR-014), so a client can address any repo in the workspace over one connection (the `repos` tool lists them). Still out of scope: a single query that spans repos in one `follow` (cross-repo edges — a Linear issue → a GitHub PR → a markdown doc); each `query` is still scoped to one repo. That's a query-engine change, not a sync change, but it's the reason this seam matters.

## 12. Invariants (unchanged)

The `README.md` invariants hold regardless of adapter. Convergence (`sha256(file) == rendered_hash`) is engine-checked after every ingest; identity dispositions are stamped only on the `inferred` path; commits/dispositions are append-only. An adapter can only *report* changes and *transport* bytes — it can never write a commit, mint identity, or bypass the convergence check. A crashing or malicious adapter can corrupt neither identity nor history; at worst it stalls its own repo's freshness.
