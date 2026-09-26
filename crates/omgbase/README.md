# omgbase

The `omgbase` binary: a versioned, addressable graph layer over authored
Markdown, served to agents as an MCP tool catalog. Rust, over
[`omgbase-surface`](../omgbase-surface/README.md).

```text
omgbase mcp [--workspace DIR] [--repo SLUG] [--no-watch]   serve the tool catalog over MCP stdio
omgbase --version
```

`omgbase mcp` locates the workspace (`--workspace`, `$OMGBASE_WORKSPACE`, or
the nearest `.omgbase/` walking up from the current directory —
`spec/sync` §1), selects the default repo (`--repo`, the only repo, or the
one whose root contains the current directory), wires the embedding
provider named by the repo's `embedding.*` settings when it can be spawned
(otherwise `semantic()` fails `semantic_unavailable`), and speaks
newline-delimited JSON-RPC 2.0 on stdin/stdout: `initialize`, `tools/list`,
`tools/call`, `ping`. Every tool result is one text content item holding
JSON; an error result carries `isError: true` and the envelope
`{ error, message, data?, retriable }` (`spec/surface` §4). stdout is the
protocol channel; every diagnostic goes to stderr.

Thin by design: there is no business logic here beyond argument parsing,
the transport loop and the two long-lived helpers below, which mirror the
reference `omg mcp`.

## The watcher

Unless `--no-watch` is given, the server tries to take the workspace's
watch lease (`.omgbase/watch.lock`, `spec/sync` §7). When another live
watcher holds it (`omg watch`, another `mcp`) it serves without one and says
so (`watcher elsewhere`). Otherwise, for a repo with an `fs` root, it runs
one priming freshness sweep (§4.3) so the session starts fresh, spawns the
repo's registered adapter (the `fs` source's `omgbase-fs-adapter --root
<dir>`, §5), and reconciles every batch of the adapter's watch stream into a
checkpoint (§6 `reconcile_changes`), logging `[watch] checkpoint: +N -M`.

**The adapter must be installed.** The registry's command is the
`omgbase-fs-adapter` bin of `@omgbase/fs-adapter` (`npm i -g
@omgbase/fs-adapter`, or any way that puts it on `PATH`). `OMGBASE_FS_ADAPTER`
overrides the command line — e.g. `node
/path/to/omgbase/packages/fs-adapter/dist/src/bin.js` from a checkout after
`pnpm build`. When the adapter cannot be started (not found, bad handshake,
no `watch` capability) the server degrades to `no watch (adapter
unavailable)` with a clear stderr line, releases the lease and serves; the
priming sweep has already run by then.

The MCP loop is synchronous on stdin and owns the surface's store; the
watch stream arrives on another thread that owns its **own** store
connection over the same SQLite file (WAL) and takes the workspace writer
lock (`.omgbase/writer.lock`) around each checkpoint — the same lock the
loop takes around every tool that can commit (`Surface::is_write_tool`), so a
checkpoint and a write never interleave inside one commit, in this process
or across processes. Every connection carries a 5 s busy timeout for the
read-over-commit overlaps SQLite serializes itself.

## The embed drain

When a provider is configured and live, a background drainer keeps
embeddings timely (`spec/search` §2.6): every successful non-dry-run write
tool call and every watcher checkpoint that ingested or deleted something
schedules a drain; the drainer thread debounces 500 ms, runs one drain at a
time (blocks first, then documents — `build_embed_tasks` → `embed_process`
→ `build_doc_embed_tasks` → `embed_process_docs`), re-runs once more when a
schedule arrived mid-drain, and logs `[mcp] embedded N block(s)`. Errors go
to stderr and are never fatal (the next schedule retries). The thread owns
its own store connection and its **own** provider instance (a second spawn
of the configured command); the main thread's provider serves `semantic()`
queries only. With no provider configured there is no thread.

## Shutdown

stdin EOF, `SIGINT` or `SIGTERM`: stop the watcher (unwatch, close the
adapter, join the thread), release the lease, flush the drainer (a final
drain if anything is pending) and close it, then drop the surface (which
kills its provider process), exit 0.

## Conformance seams and the interop harness

Two environment variables are the test seams of `spec/surface` §7.1, for
cross-engine conformance runs only (never set them in production):

- `OMGBASE_SPEC_MINTER=sequential` installs the fixture id minter
  (`d_0, d_1, …`, each prefix counting from 0, fresh at process start and
  shared by every thread of the process) for the workspace and the store;
  any other value is a startup error.
- `OMGBASE_SPEC_CLOCK=<RFC 3339>` makes that instant "now" for every commit
  a tool or the watcher stamps (stored as UTC milliseconds, `…Z`; a `±HH:MM`
  offset is converted).

Both are announced on stderr. `tests/interop.rs` is the §7 harness: every
case of `spec/surface/cases/interop.json` for every `(writer, reader)` in
`{typescript, rust}²`, both engines as child processes over MCP stdio, both
with `--no-watch` (the seed is the harness's `observe_many`, not a priming
sweep). The TypeScript peer is `$OMGBASE_TS_MCP` or `node
<repo>/packages/cli/dist/src/main.js` (`pnpm build`); `OMGBASE_INTEROP=skip`
skips the pairs that need it. `tests/mcp_watch.rs` drives the binary as a
process: `--no-watch`, the adapter-unavailable degradation, the lease, a
`SIGTERM` shutdown, and — when `node` and `packages/fs-adapter/dist` exist
— a watched run where a file written under the workspace reads back through
the server.

## License

MIT.
