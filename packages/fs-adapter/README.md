# @omgbase/fs-adapter

The filesystem **source adapter** for [omgbase](https://github.com/omgbase/omgbase), shipped as the `omgbase-fs-adapter` binary. It is a small standalone process that enumerates, reads, watches (via [chokidar](https://github.com/paulmillr/chokidar)) and writes a directory tree, and talks to the engine over newline-delimited JSON on stdin/stdout. It exists so that `@omgbase/core` carries no filesystem-watch dependency: chokidar lives here, and the engine sees the directory only as a `SyncSource` behind a pipe (`packages/core/src/sync/plugin.ts`).

The adapter transports bytes and reports membership — nothing more. Content hashing, echo suppression, block-identity reconciliation, commits and the convergence check all stay in the engine, so a crashing adapter can stall a repo's freshness but can never corrupt identity or history.

## How omgbase uses it

`omg source add <dir>` registers the built-in `fs` adapter row (`adapters.name = "fs"`, `command = "omgbase-fs-adapter"`) and creates a source named `<slug>-fs` with `config = { root: <abs dir> }` attached to the repo. From then on, whenever the engine needs a *live* source it spawns this package:

- `omg sync --watch` and `omg mcp` call `openRepoSource()` (`packages/cli/src/cmd/_source.ts`), which finds the repo's attached `fs` source and spawns `process.execPath` (the running `node`) with `[fsAdapterBinPath(), ...renderConfigFlags(config)]` — i.e. `node …/fs-adapter/dist/src/bin.js --root <root>`. The bundled bin is used rather than the `omgbase-fs-adapter` on `PATH`, so a source never pins a stale install.
- `omgbase-sync` / `omg sync --server …` (`packages/sync/src/mirror.ts`) spawn it the same way for the directory being mirrored.
- The one-shot paths (`omg sync` without `--watch`, the initial ingest in `source add`, the freshness sweep before every read) do **not** spawn it: they read disk directly with `node:fs` (`sync/freshness.ts`, `sync/checkpoint.ts`). Both paths funnel into the same `observeOne` reconcile primitive.

Only the built-in `fs` adapter has a launcher in the CLI today; `spawnSource()` throws for any other adapter name. Custom adapters are reachable through the library (`createExternalSource`, below).

## Options

```
omgbase-fs-adapter --root <dir> [--ext .md --ext .markdown] [--debounce-ms 750]
```

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | required (exit 2 without it) | directory to serve; all paths are relative to it, `/`-separated |
| `--ext <suffix>` | `.md` | file suffix to include; repeatable |
| `--debounce-ms <n>` | `750` | quiet period before a watch batch is flushed |

Ignore rules are fixed: any path segment named `.omgbase`, `.git` or `node_modules` is skipped during both the walk and the watch. The engine renders `sources.config` keys into these flags one-to-one (`{ root }` → `--root <root>`; a `true` boolean becomes a bare `--flag`), so extra config keys would reach the adapter unchanged.

The `revision` token is `"<mtimeNs>:<size>"` from a single `stat` — a cheap "did it change?" hint. The engine never trusts it for correctness; it hashes fetched bytes itself.

## The stdio protocol

stdout carries protocol JSON only, one object per line; logs go to stderr (the engine inherits the adapter's stderr). Core's side is `createExternalSource()` in `packages/core/src/sync/external-source.ts`. This is a real session against a two-file tree:

```
→ (adapter, on start)  {"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}
← {"id":1,"method":"enumerate"}
→ {"id":1,"result":{"entries":[{"path":"a.md","revision":"1790231028265345104:4"},{"path":"sub/b.md","revision":"1790231028265462062:4"}]}}
← {"id":2,"method":"fetch","params":{"path":"a.md"}}
→ {"id":2,"result":{"item":{"path":"a.md","revision":"1790231028265345104:4","content":"# A\n"}}}
← {"id":3,"method":"fetch","params":{"path":"nope.md"}}
→ {"id":3,"result":{"item":null}}                       ← null = left the scope (a delete)
← {"id":4,"method":"write","params":{"path":"new/d.md","content":"# D\n"}}
→ {"id":4,"result":{"ok":true}}                         ← mkdir -p, then write
← {"id":5,"method":"remove","params":{"path":"new/d.md"}}
→ {"id":5,"result":{"ok":true}}
← {"id":6,"method":"watch"}
→ {"id":6,"result":{"ok":true}}
→ {"event":"batch","paths":["a.md","c.md"]}             ← unsolicited, debounced, while watching
← {"id":7,"method":"unwatch"}
→ {"id":7,"result":{"ok":true}}
← {"id":8,"method":"bogus"}
→ {"id":8,"error":"unknown method: bogus"}
```

Rules the engine relies on:

- **Handshake first.** Exactly one line, `protocol: 1` plus `capabilities`. Core coerces `identity` to `"inferred"` unless it is exactly `"borne"`, and only exposes `watch()` / `write()` / `remove()` when the corresponding capability is true. A non-JSON first line is a hard `invalid handshake` error.
- **Requests carry an `id`**; the response echoes it. Core matches by `id` and skips lines belonging to other in-flight calls. Non-JSON stdout is surfaced as a failed call rather than a hang. A malformed request line gets `{"error":"invalid request JSON: …"}` with no `id`.
- **`enumerate` is the full scope** every time. There is no incremental cursor method; change discovery is either the `watch` stream or a re-`enumerate`.
- **Batch events** are the only server-initiated messages, and only after `watch`. Debouncing lives here, not in the engine. Batches are keyed by path only; the engine `fetch`es each one (null ⇒ tombstone as an observed deletion).
- **Shutdown**: the engine ends stdin and sends SIGTERM. On stdin EOF the adapter stops any watcher and exits 0.

## Library use

The transport-free core is exported for in-process use:

```ts
import { FsAdapter, fsAdapterBinPath } from "@omgbase/fs-adapter";

const fs = new FsAdapter({ root: "/path/to/vault", ext: [".md"], debounceMs: 750 });
fs.capabilities();              // { identity: "inferred", writeThrough: true, watch: true }
fs.enumerate();                 // [{ path, revision }]
fs.fetch("notes/a.md");         // { path, revision, content } | null
fs.write("new/d.md", "# D\n");  // creates parent dirs
fs.remove("new/d.md");
const sub = fs.watch((paths) => console.log("changed", paths));
await sub.stop();

fsAdapterBinPath();             // absolute path to this package's bin.js, for spawning
```

To drive the adapter *process* from the engine side:

```ts
import { createExternalSource } from "@omgbase/core";
import { execPath } from "node:process";
const source = await createExternalSource({ command: execPath, args: [fsAdapterBinPath(), "--root", "/path/to/vault"] });
await source.enumerate(); await source.fetch("a.md"); await source.close();
```

## Writing your own adapter

Any executable that follows the session above is a source adapter — in any language. Emit the handshake line, answer `enumerate`/`fetch` (and `write`/`remove` if you claim `writeThrough`, `watch`/`unwatch` if you claim `watch`), echo ids, keep stdout clean, exit on stdin EOF. `path` is the repo-relative storage key; `revision` is any cheap change token (blob SHA, ETag, `updated_at`). A source with stable upstream ids may set `identity: "borne"` and a per-entry `sourceId`; core accepts the flag but ships only the `inferred` reconcile path today. Connect it with `createExternalSource({ command, args, env })` as shown — `env` is merged over `process.env`, which is where secrets belong rather than argv. The full contract is in `docs/sync-plugins.md`; the code (`bin.ts` here, `external-source.ts` in core) wins where they differ.

## License

MIT — see [LICENSE](./LICENSE).
