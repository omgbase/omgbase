# omgbase — Sync Adapters (External Source Reconciliation)

**Status:** normative design, `proposed`. As-built: an interim *in-process* `SyncSource` seam shipped first (commit `2850b28`); this document supersedes it with the **external-adapter** model — adapters are separate processes speaking a stdio protocol, exactly as embedders are (`05 §6`). The `@omgbase/fs-adapter` package is the first adapter.
**Depends on:** `01-architecture.md` §6 (checkpoints), `03-reconciliation-spec.md` §8 (sync pipeline placement), `02-data-model.md` §3 (repos), `11-cli.md` §3.3 (freshness sweep, watch lease). **Parallels:** `05-graph-and-query.md` §6 + `packages/core/src/search/external.ts` (the embedder external-process pattern this mirrors).

---

## 1. Purpose

`sync` in omgbase is **reconciliation between an external source scope and an omgbase repo**, not "read files from disk." The filesystem is one source; git, GitHub, and Linear are others. Sources are **external processes** — an adapter can be written in any language, ships its own dependencies (chokidar, `@octokit`, the Linear SDK), and is swapped by config alone. The engine core carries **no source implementation and no filesystem-watch dependency**.

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

## 2. Four entities

The model separates *what a repo is* from *where its bytes come from* and *how that source is invoked*.

| Entity | Scope | Is | Example |
|---|---|---|---|
| **adapter** | workspace | a named mapping to a **command** | `fs → omgbase-fs-adapter` |
| **source** | workspace | a named `{ adapter, config }` — pure configuration | `product-fs → { adapter: fs, config: { root: ~/src/product } }` |
| **repo** | workspace | a namespace / authority / versioning boundary | `product` |
| **attachment** | — | a **many-to-many** join of repo ↔ source | `product ⇄ product-fs` |

Consequences of this factoring (all deliberate):

- **Repos exist without sources.** A bare repo is a valid, first-class state (§7). `omg repo create` makes one; content can be authored into it via `apply` with nothing to sync.
- **A repo may have multiple sources.** Attaching many is allowed; the engine does not forbid it. Adapters *warn or refuse* combinations they know are incoherent (e.g. two Linear scopes into one repo), but the user owns the general case.
- **A source may feed multiple repos.** Revision/cursor state is therefore per **attachment**, not per source (§6).
- **The source holds config as data, not a command string.** The adapter owns *how to invoke*; the source owns *what to point at*. This keeps source rows clean and is what makes a future single-adapter-process-multiplexing-many-sources possible (§8).

## 3. Adapters, sources, and how a command is built

An **adapter** row maps a name to a command (and optional fixed args): `fs → omgbase-fs-adapter`. A **source** names an adapter and carries structured `config`. To run a source the engine:

1. looks up the source's adapter → base command;
2. renders `config` into flags (§3.1) and appends them;
3. spawns the process and speaks the protocol (§4).

`@omgbase/fs-adapter` (bin **`omgbase-fs-adapter`**) is the blessed default the CLI ships with; `omg init` seeds an `fs` adapter row pointing at it (§7). Other adapters are declared with `omg adapter add <name> --command <cmd>`.

### 3.1 config → argv mapping

Deterministic and mechanical (no adapter-declared flag schema in v1):

- scalar `{root: "~/x"}` → `--root ~/x`
- array `{include: ["**/*.md","**/*.mdx"]}` → `--include **/*.md --include **/*.mdx`
- boolean `true` → bare `--flag`; `false` → omitted
- keys are kebab-cased: `{maxDepth: 5}` → `--max-depth 5`

### 3.2 secrets are env, never argv

A token on the command line leaks into `ps`/process listings. Config carries a reserved **`env`** map delivered through the spawn environment, not argv:

```jsonc
{ "adapter": "github", "config": { "owner": "acme", "repo": "product" },
  "env": { "GITHUB_TOKEN": "$GH_TOKEN" } }   // "$X" resolves from the engine's env at spawn
```

fs needs none of this; the seam exists from v1 so GitHub/Linear drop in without a redesign.

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
| `enumerate` | `{ cursor? }` | `{ entries: [{ path, revision, sourceId? }], cursor? }` |
| `fetch` | `{ path }` | `{ item: { path, revision, content } \| null }` |
| `write` | `{ path, content }` | `{ ok: true }` *(writeThrough only)* |
| `remove` | `{ path }` | `{ ok: true }` *(writeThrough only)* |
| `changes_since` | `{ cursor }` | `{ entries: [{ path, revision }], cursor }` *(poll sources)* |

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

`revision` answers "did this member change, cheaply?" It drives the first of two echo-suppression layers:

- filesystem: `"mtime_ns:size"` (a stat, no read).
- git: the blob SHA. GitHub/Linear: `updated_at` / version / ETag.

The engine persists the **last-observed** revision per attachment+path (§6) and skips unchanged members without a `fetch`. The **authoritative** second layer is still engine-side: `sha256(content)` vs the stored `file_hash` guarantees convergence even if a token is coarse or lies.

### 5.2 inferred vs borne identity

- **`inferred`** — anonymous bytes; block continuity is inferred by the reconciler (`03`): the probabilistic matcher, dispositions, the ≥0.995 precision gate. Filesystem and raw-git-blob adapters are `inferred`. This is the *only* reason that machinery runs.
- **`borne`** — stable upstream ids (Linear UUIDs, GitHub node ids) delivered as `sourceId`; the engine maps `sourceId → identity` deterministically and **skips the matcher** (running it would be wrong). *v1 status:* the driver has one path (`inferred`); the `borne` branch is defined so the reconcile call is written conditionally, but no `borne` adapter ships yet.

## 6. Persistent sync state (engine-owned)

Because adapters are spawned fresh and are stateless across runs, the **engine** owns durable sync state, keyed per **attachment** so one source feeding two repos tracks each independently:

- last-observed `revision` per `(attachment, path)` — replaces the filesystem `file_stats` cache, generalized.
- last `cursor` per attachment — for poll/webhook sources (`changes_since`).
- optional `sourceId ↔ path` map per attachment — for `borne` sources whose locator ≠ storage path.

The adapter reports *current* revisions; the engine remembers *last-seen*. This is a cleaner split than the interim design (which let the fs source own its mtime cache).

## 7. Repo & source lifecycle

```text
omg init [dir]                     # workspace only: .omgbase/ + db. Seeds the `fs` adapter.
                                   #   offers .gitignore if dir is inside a git tree (manners, not sync).
                                   #   ends by suggesting `omg repo create` / `omg attach`.
omg adapter add <name> --command <cmd>      # register an adapter
omg adapter list
omg source create <name> --adapter <a> [--k v …]   # a configured source (config from flags)
omg source list
omg repo create <name>             # bare repo, no source
omg repo attach <repo> --source <source>    # the many-to-many join; runs the initial reconcile
omg repo detach <repo> --source <source>    # disconnect; repo + content remain
omg repo list                      # (supersedes `omg repos`)
omg attach <path> [--name <n>]     # SUGAR: source create (fs) + repo create + repo attach, one breath
```

- **Workspace ≠ repo.** `.omgbase/` defines the workspace; it does not sync the dir it lives in and defines no repo. A workspace can sit in a git root, a notes dir, or `$HOME`.
- **Workspace discovery:** `--workspace` flag wins; else `OMGBASE_WORKSPACE` env; else walk up from cwd for `.omgbase/` (the default). No global default dir.
- **Sourceless / native repo:** a repo with no attachment. The **database is authoritative for content** (no external bytes, no write-back). `apply` works; it writes blocks/revisions with nothing to materialize. `sync`/`watch` are no-ops. Convergence is vacuous (no file to converge against). This inverts the filesystem canonicality of `01` correction #5 for that repo, deliberately.
- **`sync`/`watch`/`mcp` gain no source flags.** They resolve the repo, read its attachments, spawn the adapters, and reconcile. The source is a durable property of the attachment, never a per-invocation choice.

## 8. Multiplexing (future capability, not v1)

Because a source's config is structured data (not a baked command string), a future adapter can advertise `multiplex: true` and receive several source configs over the handshake instead of one via argv — one process serving many sources (many watched roots, one chokidar; many Linear scopes, one client). v1 is one process per attachment. The protocol keeps this additive by carrying source config in a handshake message path, not *only* in argv.

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
| Durable revision/cursor state (per attachment) | **engine** |
| Format decomposition (bytes → blocks) — a *different* axis | **engine** (format adapter) |

**Format adapters and source adapters are orthogonal.** A source adapter transports bytes; a format adapter (`markdown`/`yaml`/`json`, in-process, per-block, hot path) decomposes them. A Linear issue arrives via the `linear` *source* adapter and its markdown `description` is decomposed by the markdown *format* adapter. The word "adapter" is qualified whenever ambiguous.

## 11. Multi-repo is the payoff

One workspace DB holds many repos (`02 §3`); now each can be backed by a different adapter (or none). The prize is **cross-repo edges** — a Linear issue → a GitHub PR → a markdown doc in one OQX `follow`. That needs a cross-repo query surface, which today's `query(store, repoId, …)` hard-scopes against and the MCP server binds one repo per session. Cross-repo query is out of scope here (a query/MCP change, not a sync change) but is the reason this seam matters.

## 12. Invariants (unchanged)

The `README.md` invariants hold regardless of adapter. Convergence (`sha256(file) == rendered_hash`) is engine-checked after every ingest; identity dispositions are stamped only on the `inferred` path; commits/dispositions are append-only. An adapter can only *report* changes and *transport* bytes — it can never write a commit, mint identity, or bypass the convergence check. A crashing or malicious adapter can corrupt neither identity nor history; at worst it stalls its own repo's freshness.
