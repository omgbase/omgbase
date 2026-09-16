<!-- recital include: ./_fragments/attached-alchemy-shell.md -->

# The interactive shell

`omg shell` opens a **persistent session**: the workspace stays open and each
command's result becomes addressable — the interactive analogue of shell pipes.
Rows of the last displayed collection are `@1`, `@2`, …; a named snapshot is
`@name = …` (then read it back as `@name`); `@_` is the previous result.

> The blocks below are one real session — recital launches `omg shell` and drives
> the live REPL, so the `$ ` lines are typed at your shell and the `omg>` lines at
> the shell's prompt, with state carrying from one to the next exactly as it would
> for you at a terminal. Block ids print as themselves; the engine mints fresh
> ones each run.

## Start a session, address a row, act on it

Launch `omg shell`, query the February lab note's open tasks — the session
remembers the result — then complete the first one **by its row number** rather
than copy-pasting an id:

```console
$ omg shell
omg> query 'from blocks where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md"'
  2 rows — address with @1..@2
b_assay01  lab/2026-02-notes.md
b_write02  lab/2026-02-notes.md
omg> done @1
  1 row — address with @1..@1
  ok committed · 1 document touched
b_assay01
omg> query 'from blocks where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md"'
  1 row — address with @1..@1
b_write02  lab/2026-02-notes.md
```

`done @1` resolved `@1` to the first row's block and completed it in one commit;
the re-run shows only the task that's left.

## Name a result, then leave

Still in the same session: `@name = <command>` runs the command quietly and binds
a **snapshot** of its typed result; `bindings` lists what's held. Bindings are
ephemeral — a snapshot taken now, not a live query, and gone when the shell
exits, which `exit` (or Ctrl-D) does, dropping you back at your shell:

```console
omg> @open = query 'from blocks where type == "task" && !attrs.checked'
  @open = 17 rows
omg> bindings
@open  17 rows
omg> exit
```

Opaque omgbase ids remain the durable identity underneath these ephemeral `@`
handles.
