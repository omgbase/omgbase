# omgbase — Operation Surface Map (the Rosetta stone)

> **One operation, three registers.** omgbase exposes one set of engine
> operations through three surfaces — the **library** (`@omgbase/core` functions),
> the **`omg` CLI** (human/script verbs), and the **MCP server** (agent tools).
> They are not three APIs; they are three *renderings* of one operation catalog
> (ADR-012: the CLI and MCP are thin clients over the same library). This table is
> the authoritative correspondence. Each surface keeps its idiom — terse CLI verbs
> + pipes, descriptive MCP tool names + rich schemas, camelCase library fns — but
> every non-exception operation has exactly one entry in each column (a bijection
> over the core set). Where names drifted gratuitously we align them; where a
> surface is genuinely missing a member, we add it.
>
> **Why it matters:** the CLI's global `--server` flag runs a command against a
> remote engine over MCP by calling the tool in its row and rendering the
> identically-shaped result. `--server` can only be *complete* — feel exactly like
> local — if every remote-capable CLI command has a corresponding tool. This map
> is the checklist for that; see **`--server` coverage** below for current state.
>
> **Spec:** the MCP column — and the read/history operations behind it — is
> pinned language-neutrally by `spec/surface/README.md` §2–§4 and the fixtures
> under `spec/surface/cases/` (`reads.json` drives every read tool through the
> built server). A Rust `omgbase` binary that passes them serves the same catalog.

## Naming principle

- **Same operation ⇒ corresponding names**, mechanically relatable across surfaces
  — not necessarily identical strings.
- **CLI**: shortest correct human verb (`cat`, `rm`, `mv`, `log`). Composes with
  pipes; every list emits ids, every mutator reads ids from stdin.
- **MCP**: descriptive, discoverable tool name, usually `noun_verb` (`docs_read`,
  `links_retarget`), with a rich Zod schema + a self-teaching description.
- **library**: `camelCase` function (`docsRead`, `linksRetarget`).
- **Mutations are never a backdoor.** Every write — CLI verb or MCP tool — expands
  to the audited six-op `apply` kernel + named macros. There is no raw-kernel
  escape hatch, by design.

## Core operations (the shared vernacular)

Legend: `--server` = is this CLI command remote-capable? ✅ wired · ▫️ planned · 🔒 inherently local (watcher/process state, no meaningful remote form) · — n/a (exception / no CLI verb).

### Orient & read

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Query (OQX) | `oqxRun` | `query` / `q` | `query` | ✅ |
| Query syntax help | — | (help text) | `query_syntax` | — |
| Document outline | `docsOutline` | `outline` / `ol` | `docs_outline` | ✅ |
| Read whole document | `docsRead` | `cat` (doc) | `docs_read` | ✅ |
| Read many documents | `docsReadMany` | — | `docs_read_many` | — |
| Hydrate a block | `nodesGet` | `cat`/`show` (block; the CLI dispatches on the ref's shape — `b_` → `blocks_read`, `n_` → `nodes_block_read`, else `docs_read`) | `blocks_read` | ✅ `cat` · ▫️ `show` |
| Hydrate a node's block | `resolveRef` + `nodesGet` | `cat`/`show` (an `n_` ref) | `nodes_block_read` | ✅ `cat` · ▫️ `show` |
| Hydrate many blocks | `nodesGetMany` | — | `blocks_read_many` | — |
| Metadata card | `nodesGet`(full)+`docLinks`+`docProps` | `show` | `blocks_read` (block) / `docs_read` (document; `{ kind: "document", … }` composed client-side) | ▫️ |
| Find / rank | `resolveThing`/`textSearch` | `find` | `blocks_resolve` (+`blocks_search`) | ✅ |
| List documents (paged) | `docsList` | `ls` (walks every page) | **`docs_list`** | ✅ |
| Repo shape (dir tree + totals) | `docsTree` | — | **`docs_tree`** | — |
| Graph neighborhood | `graphNeighborhood` | (`query … follow`) | `graph` | — |
| Run an OQX fence | `oqxRun` | `run` | `query` | ▫️ |

### History

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Commit feed | `changesSince` | `log` | `changes_since` | ✅ |
| Block biography | `historyNode` | `hist` | `blocks_history` | ✅ |
| Diff two revisions | `diffBlocks`/`diffUnified` | `diff` (`--blocks`) | **`docs_diff_unified`** + `docs_diff` (block-grain) | ✅ |
| Read doc at a revision | `readDocumentAtRevision` | (`cat --rev` ✳️) | `docs_read { at }` (`docs_read_at` is its sugar, surface 4.7) | ▫️ |
| Per-document version list | `docHistory` | — | `docs_history`; as rows: `query` over the `revisions` target (surface 4.7) | — |

### Links

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Surface stale links | `linksStale` | `links` | `links_stale` | ▫️ |
| Retarget one link | `linksRetarget` | `retarget` | `links_retarget` | ✅ |
| Repair many links | `linksRepair` | (`retarget` batch) | `links_repair` | ▫️ |

### Mutate (all expand to `apply` + macros)

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Apply a changeset | `apply` | `apply` | `apply` | ✅ |
| Plan an effect request (frozen plan, writes nothing) | `planEffects` | `apply -f <{ effects }> --dry-run` (`--json` prints the Plan) | `plan` | ✅ |
| Execute a frozen plan | `executePlan` / `executeByDigest` | `execute (-f plan.json \| -)` (the plan form) | `execute` | ✅ |
| Apply effects one-shot (plan + execute, one tx) | `applyEffects` | `apply -f <{ effects }>` | `apply { effects }` | ✅ |
| Insert a block | `apply` ops | `insert` | `blocks_insert` | ✅ |
| Update a block (CAS) | `apply` ops | `update` (b_ target) | `blocks_update` | ✅ |
| Move block(s) | `apply` ops | `move` | `blocks_move` | ✅ |
| Remove block(s) | `apply` ops | `rm` (blocks) | `blocks_remove` | ✅ |
| Split a block | `apply` ops | `split` | `blocks_split` | ✅ |
| Merge blocks | `apply` ops | `merge` | `blocks_merge` | ✅ |
| Complete tasks | `tasksComplete` | `done` | `blocks_check` | ✅ |
| Append to a doc / into a block | `docsAppend`/`sectionsAppend` | `append` (block) | `docs_append { section? }` / `blocks_append` | ✅ |
| Set a node property | `nodeSet` | `node set` | `nodes_set` | ✅ |
| Whole-document update | `docsUpdate`/`planUpdate` | `update` (`--dry-run` plans) | `docs_update` (`dry_run: true` is the plan-only call; `docs_plan_update` removed in 3.0) | ✅ |
| Edit a block in `$EDITOR` (CAS pinned) | `apply` ops | `edit` | `blocks_update` (same op as `update` on a `b_` target) | 🔒 local (spawns `$EDITOR`; not in `REMOTE_OK`) |

### Document lifecycle

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Create a document | `docsCreate` | `new` | `docs_create` | ✅ |
| Move / rename | `docsMove` | `mv` | `docs_move` | ✅ |
| Delete (tombstone) | `docsDelete` | `rm --doc` | `docs_delete` | ✅ |
| Patch frontmatter | `docsSetMeta` | `meta` | `docs_set_meta` | ✅ |

### Status

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| List repos | `Workspace.repos` | `repos` | `repos` | ▫️ |
| Repo counts + drift | `reposStatus` | `status` | `repos_status` | ▫️ |
| Watcher/sync state | `syncStatus` | `status` | `sync_status` | 🔒 local |
| Which engine + versions | `versionInfo` | `version` | `version` | ✅ |

### Sync ingest primitives (the file↔DB direction)

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Observe file bytes | `observeFile` | (driven by `sync`) | `observe` | — |
| Observe a batch | `observeMany` | (driven by `sync`) | `observe_many` | — |
| Observe a deletion | `observeDelete` | (driven by `sync`) | `observe_delete` | — |

## Exception set (surface-specific by nature — small and principled)

These legitimately live on one surface; they are **not** part of the shared
vernacular and `--server` does not apply.

- **Bootstrap / local workspace + process:** `omg init` (creates the local
  `.omgbase/`), `omg source *` (registers/binds local sources), `omg sync` /
  `omg sync --watch` (drives the local reconcile loop — its *engine-side*
  primitives `observe*` **are** in the catalog), `omg mcp` (starts the server).
- **Admin / maintenance:** `omg rebuild-index`, `omg gc`, `omg doctor`,
  `omg embed`, `omg config`, and (cli 4.6) `omg history plan | export |
  attach | detach | list` — history retention writes segment files under the
  workspace, takes the writer lock and is driven by a policy and a
  directory (`spec/store` §7.1); the catalog's whole trace of it is the
  `revisions.archived` attribute and the `revision_archived` error
  (`spec/surface` 4.9). Server-operator ops; no MCP tools.
- **Surface-intrinsic:** `omg shell` (a CLI session; `shell --server` runs each
  *line* remotely, but the session construct itself is CLI-only), `omg help`,
  `omg --version` (the one-line form; the full `omg version` verb IS in the
  catalog above — it renders the `version` tool, remotely with `--server`).

## `--server` coverage (state)

**Shipped** — reads, the full doc lifecycle, **all block-level mutation**, tasks,
append, `node set`, whole-document `update`, `retarget`, `apply` (both inputs:
`{ ops }` and `{ effects }`), `execute`, `sync`, and `shell` are wired end-to-end. Remote writes flow through the server → `apply` →
write-through to the served repo's tree; local and remote produce byte-identical
files for the same inputs (verified per-op). The block sugar is backed by
**`blocks_insert`/`blocks_update`/`blocks_move`/`blocks_remove`/`blocks_split`/
`blocks_merge`** — ref-accepting peers of the `apply` primitive that resolve refs
and pin CAS **server-side**, so a remote client needs no local store. The read
gap tools are in place too: `cat` picks **`docs_read`** / **`blocks_read`** /
**`nodes_block_read`** by the ref's shape (ids carry their kind; the polymorphic
`read_ref` was removed in 3.0),
**`docs_list`** (backs `ls`), **`docs_diff_unified`** (backs `diff`), and
`find`→`blocks_resolve`.

**Deferred (`▫️`)** — a few remaining reads: `show` (the metadata card's links and
merged properties), `run` (OQX-fence fetch+run), `links` (→`links_stale`), `repos`
(→`repos`), and the optional `cat --rev`→`docs_read_at` time-travel verb.

**Inherently local (`🔒`)** — `status`'s watcher/sync-process state,
`node props` (an editability lookup with no remote tool), and `edit` (it spawns
the local `$EDITOR`; the update it produces is the same `blocks_update` op that
`update <b_…>` sends remotely) are about the local process, so `--server`
rejects them with a clear message. Everything that
represents a real engine operation now has a remote path.

## Drift to align (`⚠️`, register-only differences — document, optionally rename)

`log`↔`changes_since`, `hist`↔`blocks_history`, `new/mv/rm/meta`↔`docs_*`. These are
fine as different registers of the same operation **as long as this table is the
source of truth**; renaming is optional polish, not required for coherence.

## Invariant (drift guard)

Over the non-exception set, the map is a **bijection**: every core CLI command has
exactly one MCP tool and vice versa. A test can assert this (CLI `REMOTE_OK` ⊆ tools
present; no orphan core tool without a CLI verb). Keep this file updated in the same
change that adds or renames an operation on any surface.
