# omgbase-fs-adapter

The filesystem sync adapter of omgbase as a Rust binary: a second
implementation of the `fs` adapter of `spec/sync` §5, wire-compatible with
the reference `@omgbase/fs-adapter` (npm), so an `omgbase mcp` install needs
no Node.

```text
omgbase-fs-adapter --root <dir> [--ext <suffix>]... [--debounce-ms <n>]
```

A host (`omgbase mcp`, `omg mcp`, `omg sync --watch`) spawns it and speaks
newline-delimited JSON over its stdio (stdout is the protocol, stderr the
logs):

- handshake: `{"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}`
- `enumerate` — the walk of §4.2 (every file under `--root` whose name ends
  with one of the `--ext` suffixes, default `.md`, skipping `.omgbase`,
  `.git` and `node_modules`; each directory's entries in bytewise order,
  depth-first) with `revision = "<mtime_ns>:<size>"`
- `fetch` — the file's UTF-8 content, `null` when absent
- `write` — atomic temp file + rename, parent directories created
- `remove` — unlink if present
- `watch` → `{"ok":true}`, then `{"event":"ready"}`, then unsolicited
  `{"event":"batch","paths":[…]}` lines: repo-relative `/`-joined paths of
  the files that changed, coalesced until the tree has been quiet for
  `--debounce-ms` (default 750)
- `unwatch` → `{"ok":true}` and the feed stops; stdin EOF exits 0

The `omgbase` binary finds it as `omgbase-fs-adapter` on `PATH`, or as
`$OMGBASE_FS_ADAPTER` (a command line) when that is set — the same variable
points the TypeScript engine at it.

The watcher is [`notify`](https://crates.io/crates/notify); the debouncing is
the reference's: every event adds the changed paths to a set and restarts a
timer, the set is flushed as one batch once the timer runs out. A directory
that appears or vanishes as a whole (a folder moved into or out of the tree)
is expanded to the matching files under it, which the operating system's
event stream does not report one by one.
