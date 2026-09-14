# omgbase — Sync Adapters (External Source Reconciliation)

**Status:** normative design, `proposed`. As-built: an interim *in-process* `SyncSource` seam shipped first (commit `2850b28`); this document supersedes it with the **external-adapter** model — adapters are separate processes speaking a stdio protocol, exactly as embedders are (`05 §6`). The `@omgbase/fs-adapter` package is the first adapter.
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

## 2. Reserved registry (schema only, not yet wired)

A future workspace-level registry is meant to separate *what a repo is* from *where its bytes come from*: **adapters** (a name → external command), **sources** (a named `{ adapter, config }`), **attachments** (a many-to-many join of repo ⇄ source), and per-attachment **sync_state** (revision/cursor tracking). All four tables exist in the schema (v9, `core/store/schema.ts`) but are **inert — nothing in the engine reads or writes them.** They reserve the shape a multi-source workspace will need (a source feeding many repos, a repo backed by many sources, bare/sourceless repos); none of that factoring is wired.

As-built there is no registry lookup. A repo's filesystem source is synthesized directly from the repo's `root_path`: `omg watch` / `omg mcp` / `omg sync` call `openFsSource` (`cli/src/cmd/_source.ts`), which spawns `@omgbase/fs-adapter` (bin **`omgbase-fs-adapter`**) with `--root <root_path>`. A repo with no `root_path` is **sourceless** and its `sync`/`watch` is a no-op (§7). One repo, at most one filesystem source, today.

## 3. Invoking an adapter (as-built)

The engine spawns an adapter as a child process and speaks the stdio protocol (§4) to it. The in-engine spawn seam (`createExternalSource`, `sync/external-source.ts`) takes a `command`, a pre-rendered `args` array, and an optional `env` map merged over `process.env`; for the fs source these are the current `node` binary, `[<fs-adapter bin>, "--root", <root_path>]`, and no extra env. A declarative *config → argv* mapping (structured source config rendered into flags) and *secrets-as-env* resolution (a reserved `env` map with `$VAR` substitution kept off the command line) are part of the deferred registry design and are **not** built.

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

The shipped verbs are minimal — there are no `omg adapter …`, `omg source …`, or `omg repo create/attach/detach/list` commands (those belong to the deferred registry, §2). What exists (`cli/src/cmd/bootstrap.ts`):

```text
omg init [dir]                  # workspace only: create .omgbase/ + db (does NOT ingest).
                                #   offers a .gitignore entry if dir is inside a git tree;
                                #   ends by suggesting `omg attach .`.
omg attach <path> [--slug <s>]  # create a filesystem repo from a directory, ingest its
                                #   Markdown (sets the repo's root_path), rebuild file_stats.
                                #   prompts before ingesting; -y skips the prompt.
omg repos                       # list the workspace's repos (slug, root path, doc/block counts).
```

- **Workspace ≠ repo.** `.omgbase/` defines the workspace; `omg init` does not ingest or define a repo. A workspace can sit in a git root, a notes dir, or `$HOME`.
- **Workspace discovery:** `--workspace` flag wins; else `OMGBASE_WORKSPACE` env; else walk up from cwd for `.omgbase/` (the default). No global default dir.
- **Sourceless / native repo:** a repo with no `root_path`. The **database is authoritative for content** (no external bytes, no write-back). `apply` works; `sync`/`watch` are no-ops; convergence is vacuous. This state is reachable through the library/`apply`; the CLI has no verb that creates one (`omg attach` always sets a `root_path`).
- **`sync`/`watch`/`mcp` take no source flags.** They resolve the repo, read its `root_path`, and spawn the fs adapter (§2). The source is a durable property of the repo, never a per-invocation choice.

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

One workspace DB holds many repos (`02 §3`) — today each is filesystem-backed from its `root_path` or sourceless; backing a repo with a different adapter is the deferred registry (§2). The prize is **cross-repo edges** — a Linear issue → a GitHub PR → a markdown doc in one OQX `follow`. That needs a cross-repo query surface, which today's `query(store, repoId, …)` hard-scopes against and the MCP server binds one repo per session. Cross-repo query is out of scope here (a query/MCP change, not a sync change) but is the reason this seam matters.

## 12. Invariants (unchanged)

The `README.md` invariants hold regardless of adapter. Convergence (`sha256(file) == rendered_hash`) is engine-checked after every ingest; identity dispositions are stamped only on the `inferred` path; commits/dispositions are append-only. An adapter can only *report* changes and *transport* bytes — it can never write a commit, mint identity, or bypass the convergence check. A crashing or malicious adapter can corrupt neither identity nor history; at worst it stalls its own repo's freshness.
