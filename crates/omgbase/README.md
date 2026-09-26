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

## License

MIT.
