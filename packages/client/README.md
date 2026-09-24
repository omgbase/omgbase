# @omgbase/client

**Private placeholder — not published, not functional.**

`@omgbase/client` is reserved for a thin remote MCP client for omgbase: a small library that lets a program drive a remote or headless omgbase engine over the Model Context Protocol (calling the same `query`, `docs_*`, `blocks_*`, `observe*` tools an agent uses) without linking the full engine. Its implementation is deferred until omgbase has its own HTTP serving transport.

## What exists today

Almost nothing, honestly:

- `package.json` — `"private": true`, version `0.0.0`, no dependencies, `test` and `lint` scripts that just echo.
- `src/index.ts` — two comment lines and no exports.

Building the package produces an empty module. Nothing in the monorepo imports it.

## Use `omg --server` instead

The working remote path today is the CLI's global `--server <cmd|url>` flag, implemented in `packages/cli/src/cmd/_remote.ts` on top of `@omgbase/sync`'s `connectStdioEngine` / `connectHttpEngine`. It connects to a remote engine as an MCP client — over stdio to a spawned `omg mcp -C /path` command, or over Streamable HTTP to an `http(s)` URL (extra headers via `-H "Name: value"`) — and runs the same commands (`ls`, `cat`, `query`, `done`, `sync`, `shell`, …) against it with identically shaped results. See the [CLI README](../cli/README.md#remote-mode) and `docs/surface-map.md`.

If you need a programmatic remote client now, `@omgbase/sync` exposes the `McpEngineClient` used by `--server`; when that seam settles, it is the likely seed for this package.

## License

MIT
