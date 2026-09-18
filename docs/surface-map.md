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

Legend: `--server` = is this CLI command remote-capable? ✅ wired · ▫️ planned · 🔒 local by design (builds ops via the local store — ref resolution / CAS / a working tree — so it does not go remote) · — n/a (exception / no CLI verb).

### Orient & read

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Query (OQX) | `oqxRun` | `query` / `q` | `query` | ✅ |
| Query syntax help | — | (help text) | `query_syntax` | — |
| Document outline | `docsOutline` | `outline` / `ol` | `docs_outline` | ✅ |
| Read any ref → bytes | `resolveRef`+`docsRead`/`nodesGet` | `cat` | **`read_ref`** | ✅ |
| Read whole document | `docsRead` | `cat` (doc) | `docs_read` | ✅ (via `read_ref`) |
| Read many documents | `docsReadMany` | — | `docs_get_many` | — |
| Hydrate a block | `nodesGet` | `cat`/`show` (block) | `nodes_get` | ✅ `cat` · ▫️ `show` |
| Hydrate many blocks | `nodesGetMany` | — | `nodes_get_many` | — |
| Metadata card | `nodesGet`(full)+`docLinks`+`docProps` | `show` | **`read_ref`** (kind=card) | ▫️ |
| Find / rank | `resolveThing`/`textSearch` | `find` | `resolve` (+`text_search`) | ✅ |
| List documents | (store query) | `ls` | **`docs_list`** | ✅ |
| Graph neighborhood | `graphNeighborhood` | (`query … follow`) | `graph` | — |
| Run an OQX fence | `oqxRun` | `run` | `query` | ▫️ |

### History

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Commit feed | `changesSince` | `log` | `changes_since` | ✅ |
| Block biography | `historyNode` | `hist` | `history_node` | ✅ |
| Diff two revisions | `diffBlocks`/`diffUnified` | `diff` | `diff` (block-grain) + **`diff_unified`** | ✅ |
| Read doc at a revision | `readDocumentAtRevision` | (`cat --rev` ✳️) | `docs_read_at` | ▫️ |
| Per-document version list | `docHistory` | — | `docs_history` | — |

### Links

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Surface stale links | `linksStale` | `links` | `links_stale` | ▫️ |
| Retarget one link | `linksRetarget` | `retarget` | `links_retarget` | ✅ |
| Repair many links | `linksRepair` | (`retarget` batch) | `links_repair` | ▫️ |

### Mutate (all expand to `apply` + macros)

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Apply a changeset | `apply` | `apply` | `apply` | 🔒 local |
| Insert / move / split / merge / edit a block | `apply` ops | `insert`/`move`/`split`/`merge`/`edit` | `apply` | 🔒 local |
| Complete tasks | `tasksComplete` | `done` | `tasks_complete` | 🔒 local |
| Append to a doc / section | `docsAppend`/`sectionsAppend` | `append` | `docs_append` / `sections_append` | 🔒 local |
| Set a node property | `nodeSet` | `node set` | `node_set` | 🔒 local |
| Whole-document update | `docsUpdate`/`planUpdate` | `update` | `docs_update` / `docs_plan_update` | ✅ |

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
  `omg embed`, `omg config`, `omg import`. Server-operator ops; no MCP tools.
- **Surface-intrinsic:** `omg shell` (a CLI session; `shell --server` runs each
  *line* remotely, but the session construct itself is CLI-only), `omg help`,
  `omg --version`.

## `--server` coverage (state)

**Shipped** — the reads, doc-lifecycle, whole-document `update`, `retarget`,
`sync`, and `shell` rows are wired end-to-end (remote writes flow through the
server → `apply` → write-through to the served repo's tree). The gap tools that
unblocked the reads are in place: **`read_ref`** (polymorphic doc/block/card read
via server-side `resolveRef`, backs `cat`), **`docs_list`** (backs `ls`),
**`diff_unified`** (line-unified text, backs `diff`), and `find`→`resolve`
alignment.

**Deferred (`▫️`)** — mostly-local reads that still want a remote path: `show`
(metadata card via `read_ref` kind=card), `run` (OQX-fence fetch+run), `links`
(→`links_stale`), `repos`/`status` (→`repos`/`repos_status`), and the optional
`cat --rev`→`docs_read_at` time-travel verb.

**Local by design (`🔒`)** — block-level sugar (`apply`, `insert`/`move`/`split`/
`merge`/`edit`, `done`, `append`, `node set`) resolves refs and pins CAS hashes
against the *local* store before building kernel ops; and `status`'s watcher
state is inherently about the local process. These stay local: `--server` rejects
them per-command with a clear message rather than pretending. A remote equivalent
would need high-level tools that resolve refs + CAS entirely server-side — a
future step, not a coherence gap.

## Drift to align (`⚠️`, register-only differences — document, optionally rename)

`log`↔`changes_since`, `hist`↔`history_node`, `new/mv/rm/meta`↔`docs_*`. These are
fine as different registers of the same operation **as long as this table is the
source of truth**; renaming is optional polish, not required for coherence.

## Invariant (drift guard)

Over the non-exception set, the map is a **bijection**: every core CLI command has
exactly one MCP tool and vice versa. A test can assert this (CLI `REMOTE_OK` ⊆ tools
present; no orphan core tool without a CLI verb). Keep this file updated in the same
change that adds or renames an operation on any surface.
