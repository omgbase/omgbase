<!-- recital include: ./_fragments/attached-alchemy.md -->

<!-- recital bind: { done1: { type: block_id, text: "b_as1y4cr" } } -->

# Editing & history

omgbase edits are **structured mutations**, not text patches. Every change goes
through the kernel, updates the Markdown file *and* the database together, and
lands as a versioned commit you can inspect and reverse. This walkthrough
completes some open lab tasks and then reads the history back.

> Starts from an already-attached `alchemy` repo (see
> [getting-started.md](./getting-started.md)).

## Find the open work

The February lab note has a checklist — two items done, two still open. `omg cat`
shows the raw Markdown checkboxes:

```console
$ omg cat lab/2026-02-notes.md | grep '^- \['
- [x] Four recrystallization cycles with weights
- [x] Note crystal quality per cycle
- [ ] Assay cycle 1 and cycle 4 crops for iron
- [ ] Write the plateau result up for the coagulation note
```

A query counts the open ones directly — a task is a projected node, and
`attrs.checked` is false while it's open:

```console
$ omg query '$repo.blocks count { where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md" }'
2
```

## Complete them — the pipe *is* the changeset

The idiom: a query emits the target block ids with `--ids`, and `omg done -`
reads them from stdin and completes them. The pipe is the changeset boundary —
`done` gathers every id into **one atomic commit** (here, one document touched).
It echoes the ids it changed:

```console
$ omg query 'from blocks where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md"' --ids | omg done -
  ok committed · 1 document touched
b_as1y4cr
b_wp3t2ax
```

The Markdown file on disk is now updated — all four items are checked — and no
open tasks remain:

```console
$ omg cat lab/2026-02-notes.md | grep '^- \['
- [x] Four recrystallization cycles with weights
- [x] Note crystal quality per cycle
- [x] Assay cycle 1 and cycle 4 crops for iron
- [x] Write the plateau result up for the coagulation note
$ omg query '$repo.blocks count { where type == "task" && !attrs.checked && $path == "lab/2026-02-notes.md" }'
0
```

## Read the history back

Every block has a biography. `omg hist` shows a block's revisions newest-first —
this task was first created when the note was ingested (commit `#3`), then
`edited` just now when we completed it (commit `#19`). The trailing value is the
commit timestamp:

```console
$ omg hist b_as1y4cr
#19 edited (1.00) api 2026-09-15T14:23:41.512Z
#3 inserted observed 2026-09-15T14:23:40.088Z
```

`omg log` is the workspace-wide commit stream. The initial `attach` recorded one
`observed` commit per ingested file; `-n 3` shows the first three (truncation is
reported on stderr, and is not an error):

```console
$ omg log -n 3
#1 observed observed: index.md — 31 inserted
#2 observed observed: lab/2026-01-notes.md — 28 inserted
#3 observed observed: lab/2026-02-notes.md — 23 inserted
… truncated; continue with --cursor 3
```

Because the file and database moved together under one commit, the change is
fully reversible — `omg done <ids> --undo` unchecks them, and the file follows.
