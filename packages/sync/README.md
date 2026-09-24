# @omgbase/sync

The standalone **store-to-store synchronizer** for [omgbase](https://github.com/omgbase/omgbase) (ADR-014), shipped as the `omgbase-sync` binary and as a library. It mirrors an external store — today a filesystem directory via `@omgbase/fs-adapter`, in principle anything speaking the source-adapter stdio protocol — into an omgbase repo, and optionally exports engine-authored changes back out.

The design has one load-bearing idea: **omgbase is just another peer behind its MCP interface.** A `Coordinator` moves whole-file bytes between a `SyncSource` (the adapter) and an `EngineClient` (the omgbase side). The `EngineClient` seam has two implementations — `InProcessEngineClient` (direct `Store`, used by tests and library callers) and `McpEngineClient` (a Model Context Protocol client over stdio or Streamable HTTP) — and the coordinator is identical against both. It contains **no reconciliation logic**: block identity, echo gating, conflict flagging and commits stay in the engine and are reached through the `observe*` tools.

## When to use it vs `omg sync`

`omg sync` is one verb with three modes (`packages/cli/src/cmd/sync.ts`):

| Command | What runs | Uses this package? |
|---|---|---|
| `omg sync` | in-process `freshnessSweep` (disk → local DB) | no |
| `omg sync --watch` | in-process `Watcher` over the spawned fs adapter, local DB | no |
| `omg sync --server "<cmd>" [--root d] [--out] [--watch]` | `runFsMirror()` from `@omgbase/sync`, driving a remote engine over MCP | **yes** |

`omg sync --server … --root X` and `omgbase-sync --root X` are the same code path (`runFsMirror`). Reach for `omgbase-sync` when the machine holding the files does not have (or want) the full `omg` CLI, or when the engine is **headless**: a server with no working tree, whose repo has zero attached sources and whose DB is the content authority. Every other `omg` command with `--server` uses the `McpEngineClient` exported here too (`packages/cli/src/cmd/_remote.ts`).

## The `omgbase-sync` bin

```
usage: omgbase-sync --root <dir> [--server "<cmd>"] [--out] [--watch]
  --root <dir>     filesystem directory to mirror (required)
  --server <cmd>   MCP server command to spawn (default: omg mcp -C <root>)
  --out            also export engine-authored changes back to the directory
  --watch          stay live and mirror edits as they land
```

```bash
omgbase-sync --root ./vault                                    # one sync in (fs → engine)
omgbase-sync --root ./vault --out                              # … plus export engine-authored changes to disk
omgbase-sync --root ./vault --watch                            # stay live until Ctrl-C
omgbase-sync --root ./vault --server "omg mcp -C /srv/notes"   # a different server command
```

What it does, in order: spawn `--server` (split on whitespace) as a stdio MCP server and connect as client `omgbase-sync`; spawn the bundled fs adapter (`node <fs-adapter bin> --root <dir>`); `syncIn()`; if `--out`, `syncOut()`; if `--watch`, `watchIn()` until SIGINT/SIGTERM. Progress goes to stderr, prefixed `[omgbase-sync]`; a fatal error exits 1. Two limits worth knowing: the bin's `--server` is always a **command to spawn** (an `http(s)` URL is only handled by the library's `connectHttpEngine` and the CLI's `_remote.ts`, not by `runFsMirror`), and there is no repo flag — tool calls carry no `repo`, so they land on the server's default repo (the one `omg mcp -C <dir>` was started for). Note that the default `omg mcp -C <root>` requires `<root>` to be inside an initialized workspace.

## The MCP tools it drives

All registered in `packages/core/src/mcp/server.ts`; every one takes an optional `repo` slug.

- **`observe_many({files:[{path,content}]})`** → one result per file: `{docId, path, rev, commitId, converged, echo, conflicted, dispositions}`. Bytes are committed as an **observed**-origin revision (a write *around* the engine, as a human edit is recorded) with block identity threaded by the reconciler. If `sha256(content)` already equals the doc's stored `file_hash`, it is an **echo**: `echo:true`, `rev:null`, no commit. Bytes containing git conflict markers are still ingested and flagged `conflicted:true`. The batch shares one timestamp and one resurrection-pool sweep. (`observe` is the single-file form; the coordinator uses the batch.)
- **`observe_delete({path})`** → `{docId, path, deleted}`. Tombstones the live doc as an observed deletion (blocks pooled for resurrection, no file removed). Idempotent.
- **`changes_since({cursor?, origin?, limit?})`** → `{digests, cursor, truncated, head}`. The repo-wide commit feed after a commit `seq`; each digest is `{commit, seq, ts, origin, actor, summary, revisions:[{doc, path, contentHash}]}` where `contentHash` is the hex of that revision's rendered file hash — enough for a client to tell "changed vs echo" without a follow-up read. `head` is the repo's current max seq (cursor > head means the cursor came from another repo).
- **`docs_read({path})`** — used by `readDoc()` in the export direction to get a doc's current byte-exact content.

### Loop safety and echo suppression

A round-trip source → engine → source → engine terminates because the engine's echo gate makes ingest idempotent: re-observing bytes the engine already holds produces no commit. `syncOut()` adds a coarse filter on top — it **skips every `observed`-origin digest**, since those came from a source and there is nothing to push back — leaving only `api`/`import` (engine-authored) changes to write out. The `contentHash` in the feed and in `readDoc()` is carried for finer per-path suppression but the v1 coordinator does not yet compare it; the durable per-path hash store (`sync_state`) is the deferred piece below.

## The identity rule

**A repo owns identity and history, not a filesystem.** A directory is *one attached `fs` source* (`omg source add`), never the repo's essence; block ids live in the DB and never in files. Because the DB already holds a byte-exact representation of every document (`docs_read` reconstructs the file), a server can run with no working tree at all — a **sourceless / headless** repo, created via the library (`ensureRepo(store, slug, null)`), where mutations commit to the DB and skip the file write. Getting bytes in and out of such a repo is precisely this package's job: `observe*` in, `changes_since` + `docs_read` out.

## Library API

Exports from `src/index.ts`:

- `Coordinator` — `syncIn()`, `reconcile(paths)`, `syncOut(cursor?)`, `watchIn({onSummary, onError})`; result types `SyncInSummary` (`ingested`, `suppressed`, `conflicted`, `deleted`) and `SyncOutSummary` (`cursor`, `written`, `removed`).
- `EngineClient` (interface: `observeMany`, `observeDelete`, `changesSince`, `readDoc`, `close`), `ChangesPage`, `DocBytes`, `InProcessEngineClient`.
- `McpEngineClient` (also exposes `callTool(name, args)` for arbitrary tools), `connectStdioEngine({command, args, env})`, `connectHttpEngine({url, headers})` — the HTTP form uses the URL verbatim (a secret base path authenticates by itself) and sends `headers` on every request.
- `runFsMirror(opts)`, `FsMirrorOptions` — what the bin and `omg sync --server` call.

```ts
import { Coordinator, InProcessEngineClient, connectStdioEngine, connectHttpEngine } from "@omgbase/sync";
import { createExternalSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import { execPath } from "node:process";

const source = await createExternalSource({ command: execPath, args: [fsAdapterBinPath(), "--root", "/path/to/vault"] });

const engine = new InProcessEngineClient(store, repoId);                                  // local Store …
// const engine = await connectStdioEngine({ command: "omg", args: ["mcp", "-C", "/srv/notes"] });   // … or spawned server
// const engine = await connectHttpEngine({ url: "https://host/k/<secret>/mcp", headers: { Authorization: "Bearer …" } });

const coord = new Coordinator(engine, source);
const inSummary = await coord.syncIn();            // source → engine (full scope, echo-suppressed)
const { cursor } = await coord.syncOut();          // engine → source (engine-authored changes only)
const sub = await coord.watchIn({ onSummary: (s) => console.log(s) });   // null if the source can't watch
// later: await sub?.stop(); await source.close(); await engine.close();
```

Any object implementing `SyncSource` from `@omgbase/core` works as the source — the tests use an in-memory one — so a non-filesystem store needs no adapter process to be exercised.

## Cursors, checkpoints, and what is deferred

- `syncIn()` / `reconcile()` need no cursor: the source reports paths, the engine echo-gates. On the local in-process path the engine also records a `checkpoints` row per batch; over MCP the server commits, the client keeps nothing.
- `syncOut(cursor?)` walks `changes_since` from `cursor` (default 0 — i.e. the whole history on a fresh start), paging while `truncated`, and returns the last `seq` as the new cursor. **The cursor is per-session**: neither the bin nor `runFsMirror` persists it, and `watchIn()` is inbound-only, so a long-running mirror does not stream engine-authored changes out. Persisting the export cursor (and per-path revision) in the reserved `sync_state` table is the deferred follow-up recorded in `docs/sync-service-design.md` §9 Stage 4 "Deferred".
- A push feed (`subscribe`, via MCP resource-update notifications) is also deferred; polling `changes_since` is the supported way to notice engine-side changes.

## License

MIT — see [LICENSE](./LICENSE).
