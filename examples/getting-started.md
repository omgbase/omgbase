<!-- recital include: ./_fragments/fresh-workspace.md -->

# Getting started with the `omg` CLI

omgbase is a graph layer over a directory of Markdown files. The files stay the
human source of truth; an embedded SQLite database (kept in `.omgbase/`) owns
identity, history, and the derived indexes you query. This walkthrough takes a
small corpus of alchemy notes from a bare directory to a queryable workspace.

> Every command below is executed for real when this file is tested — the
> outputs are what the CLI actually prints. The working directory is a throwaway
> temp folder seeded with a copy of the corpus, so nothing here touches your
> machine.

## The corpus

Eighteen interlinked Markdown documents — substances, processes, practitioners,
texts, and dated lab notes:

```console
$ find . -type f | sort
./index.md
./lab/2026-01-notes.md
./lab/2026-02-notes.md
./practitioners/jabir-ibn-hayyan.md
./practitioners/maria-prophetissa.md
./practitioners/newton.md
./practitioners/paracelsus.md
./processes/calcination.md
./processes/coagulation.md
./processes/dissolution.md
./processes/magnum-opus.md
./substances/mercury.md
./substances/philosophers-stone.md
./substances/prima-materia.md
./substances/salt.md
./substances/sulphur.md
./texts/emerald-tablet.md
./texts/mutus-liber.md
```

## `omg init` — create the workspace

`init` creates the `.omgbase/` workspace (the database) in the current
directory. It deliberately ingests **nothing**: pointing at a directory and
absorbing whatever happens to live there is a separate, consent-gated step.

```console
$ omg init . --yes --no-embedder
  not inside a git repo — no .gitignore needed for .omgbase/
  omgbase  >  initialized
  ----------------------------------------
  ok workspace  /private/var/folders/m7/8x2p9q1n4t7b/T/tmp.k9Xq2ZaR7v
  next: omg attach . to ingest a directory of files as a repo
```

(`--yes` accepts the prompts non-interactively; `--no-embedder` skips semantic
search setup, which needs an external embedder we don't need here.)

## `omg attach` — ingest the files

`attach` is the consent step: it ingests a directory's Markdown into a **repo**.
We name it `alchemy` with `--slug`; `-y` skips the "ingest N files?" prompt.

```console
$ omg attach . -y --slug alchemy
  * attached alchemy  /private/var/folders/m7/8x2p9q1n4t7b/T/tmp.k9Xq2ZaR7v  18 files
```

## Orient yourself

`omg repos` lists what's attached — slug, root path, and the document/block
counts the engine derived:

```console
$ omg repos
  * alchemy  /private/var/folders/m7/8x2p9q1n4t7b/T/tmp.k9Xq2ZaR7v  18 docs  314 blocks
```

`omg status` is the "where am I" command: the same counts plus sync/watch state.
Here 89 edges were extracted from the links between documents, everything is
converged (the files match the database), and no watcher is running (reads still
stay fresh — see below).

```console
$ omg status
  omgbase  >  alchemy
  /private/var/folders/m7/8x2p9q1n4t7b/T/tmp.k9Xq2ZaR7v
  ----------------------------------------
  [D] docs  18            watcher o none
  [B] blocks  314         synced  ok converged
  * commits  18           queue   empty
  > edges  89             commit# 18
```

## Read a document

`omg ls` lists the live documents with block counts:

```console
$ omg ls
index.md                            31 blocks  0s ago
lab/2026-01-notes.md                28 blocks  0s ago
lab/2026-02-notes.md                23 blocks  0s ago
practitioners/jabir-ibn-hayyan.md   13 blocks  0s ago
practitioners/maria-prophetissa.md  13 blocks  0s ago
practitioners/newton.md             14 blocks  0s ago
practitioners/paracelsus.md         16 blocks  0s ago
processes/calcination.md            20 blocks  0s ago
processes/coagulation.md            14 blocks  0s ago
processes/dissolution.md            15 blocks  0s ago
processes/magnum-opus.md            22 blocks  0s ago
substances/mercury.md               17 blocks  0s ago
substances/philosophers-stone.md    21 blocks  0s ago
substances/prima-materia.md         14 blocks  0s ago
substances/salt.md                  20 blocks  0s ago
substances/sulphur.md                8 blocks  0s ago
texts/emerald-tablet.md             13 blocks  0s ago
texts/mutus-liber.md                12 blocks  0s ago
```

`omg cat` prints a document's exact bytes — frontmatter and all — so it composes
cleanly with `grep`, `head`, and friends:

```console
$ omg cat substances/sulphur.md | head -9
---
type: substance
slug: sulphur
layer: canon
tradition: western
element: sulphur
tags: [substance, tria-prima]
verified: true
---
```

You now have a queryable workspace. From here:

- **[oqx-tutorial/](./oqx-tutorial/README.md)** — the OQX query language, end to end.
- **[search-and-navigation.md](./search-and-navigation.md)** — search, outlines, and the link graph.
- **[editing-and-history.md](./editing-and-history.md)** — safe edits and history.
- **[interactive-shell.md](./interactive-shell.md)** — the `omg shell` persistent session.
