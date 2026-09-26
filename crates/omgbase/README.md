# omgbase

The `omgbase` binary: a versioned, addressable graph layer over authored
Markdown, served to agents as an MCP tool catalog. Rust, over
[`omgbase-surface`](../omgbase-surface/README.md).

```text
omgbase mcp [--workspace DIR] [--repo SLUG]   serve the tool catalog over MCP stdio
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
`{ error, message, data?, retriable }` (`spec/surface` §4).

Thin by design: there is no business logic here beyond argument parsing and
the transport loop.

## Conformance seams and the interop harness

Two environment variables are the test seams of `spec/surface` §7.1, for
cross-engine conformance runs only (never set them in production):

- `OMGBASE_SPEC_MINTER=sequential` installs the fixture id minter
  (`d_0, d_1, …`, each prefix counting from 0, fresh at process start) for
  the workspace and the store; any other value is a startup error.
- `OMGBASE_SPEC_CLOCK=<RFC 3339>` makes that instant "now" for every commit
  a tool stamps (stored as UTC milliseconds, `…Z`; a `±HH:MM` offset is
  converted).

Both are announced on stderr. `tests/interop.rs` is the §7 harness: every
case of `spec/surface/cases/interop.json` for every `(writer, reader)` in
`{typescript, rust}²`, both engines as child processes over MCP stdio. The
TypeScript peer is `$OMGBASE_TS_MCP` or `node
<repo>/packages/cli/dist/src/main.js` (`pnpm build`); `OMGBASE_INTEROP=skip`
skips the pairs that need it.

## License

MIT.
