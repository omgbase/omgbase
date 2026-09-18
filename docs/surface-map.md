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
> is the checklist for that (`✳️` = the gap to close).

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

Legend: `--server` = is this CLI command remote-capable? ✅ wired · ▫️ planned · — n/a (exception).

### Orient & read

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Query (OQX) | `oqxRun` | `query` / `q` | `query` | ✅ |
| Query syntax help | — | (help text) | `query_syntax` | — |
| Document outline | `docsOutline` | `outline` / `ol` | `docs_outline` | ✅ |
| Read any ref → bytes | `resolveRef`+`docsRead`/`nodesGet` | `cat` | **`read_ref`** ✳️ | ▫️ |
| Read whole document | `docsRead` | `cat` (doc) | `docs_read` | ▫️ |
| Read many documents | `docsReadMany` | — | `docs_get_many` | — |
| Hydrate a block | `nodesGet` | `cat`/`show` (block) | `nodes_get` | ▫️ |
| Hydrate many blocks | `nodesGetMany` | — | `nodes_get_many` | — |
| Metadata card | `nodesGet`(full)+`docLinks`+`docProps` | `show` | **`read_ref`** (kind=card) ✳️ | ▫️ |
| Find / rank | `resolveThing`/`textSearch` | `find` | `resolve` (+`text_search`) | ▫️ |
| List documents | (store query) | `ls` | **`docs_list`** ✳️ | ▫️ |
| Graph neighborhood | `graphNeighborhood` | (`query … follow`) | `graph` | — |
| Run an OQX fence | `oqxRun` | `run` | `query` | ▫️ |

### History

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Commit feed | `changesSince` | `log` | `changes_since` | ▫️ |
| Block biography | `historyNode` | `hist` | `history_node` | ✅ |
| Diff two revisions | `diffBlocks`/`diffUnified` | `diff` | `diff` (block-grain) + **`diff_unified`** ✳️ | ▫️ |
| Read doc at a revision | `readDocumentAtRevision` | (`cat --rev` ✳️) | `docs_read_at` | ▫️ |
| Per-document version list | `docHistory` | — | `docs_history` | — |

### Links

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Surface stale links | `linksStale` | `links` | `links_stale` | ▫️ |
| Retarget one link | `linksRetarget` | `retarget` | `links_retarget` | ▫️ |
| Repair many links | `linksRepair` | (`retarget` batch) | `links_repair` | ▫️ |

### Mutate (all expand to `apply` + macros)

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Apply a changeset | `apply` | `apply` | `apply` | ▫️ |
| Insert / move / split / merge / edit a block | `apply` ops | `insert`/`move`/`split`/`merge`/`edit` | `apply` | ▫️ |
| Complete tasks | `tasksComplete` | `done` | `tasks_complete` | ▫️ |
| Append to a doc / section | `docsAppend`/`sectionsAppend` | `append` | `docs_append` / `sections_append` | ▫️ |
| Set a node property | `nodeSet` | `node set` | `node_set` | ▫️ |
| Whole-document update | `docsUpdate`/`planUpdate` | `update` | `docs_update` / `docs_plan_update` | ▫️ |

### Document lifecycle

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| Create a document | `docsCreate` | `new` | `docs_create` | ▫️ |
| Move / rename | `docsMove` | `mv` | `docs_move` | ▫️ |
| Delete (tombstone) | `docsDelete` | `rm --doc` | `docs_delete` | ▫️ |
| Patch frontmatter | `docsSetMeta` | `meta` | `docs_set_meta` | ▫️ |

### Status

| Operation | library | `omg` CLI | MCP tool | `--server` |
|---|---|---|---|---|
| List repos | `Workspace.repos` | `repos` | `repos` | ▫️ |
| Repo counts + drift | `reposStatus` | `status` | `repos_status` | ▫️ |
| Watcher/sync state | `syncStatus` | `status` | `sync_status` | ▫️ |

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

## Gaps to close (`✳️`) so `--server` feels local

1. **`read_ref { ref, resolution? }`** — polymorphic read: classify a ref
   (doc/block/locator) server-side via `resolveRef` and return doc bytes or a
   block/card with a `kind` discriminator. Unblocks `cat` and `show` over MCP
   (today they dispatch with a *local* `resolveRef`, which a remote client has
   no tool for).
2. **`docs_list { path_glob?, limit? }`** — the `ls` operation (docs + block
   counts). (`query 'from docs'` is close but omits the block-count/among columns
   `ls` renders.)
3. **`diff_unified { doc, from_rev?, to_rev? }`** (or a `grain` arg on `diff`) —
   the CLI renders *line-unified* text; the current `diff` tool returns
   *block-grain* entries. Pick one; recommend adding the unified variant so `omg
   diff --server` matches local output.
4. **`find`** — align `omg find` onto `resolve` (hybrid ranker); reconcile the
   result shapes so the CLI renderer is reused.
5. (Optional) **`cat --rev`** — a CLI verb for time-travel read, mapping to
   `docs_read_at`.

## Drift to align (`⚠️`, register-only differences — document, optionally rename)

`log`↔`changes_since`, `hist`↔`history_node`, `new/mv/rm/meta`↔`docs_*`. These are
fine as different registers of the same operation **as long as this table is the
source of truth**; renaming is optional polish, not required for coherence.

## Invariant (drift guard)

Over the non-exception set, the map is a **bijection**: every core CLI command has
exactly one MCP tool and vice versa. A test can assert this (CLI `REMOTE_OK` ⊆ tools
present; no orphan core tool without a CLI verb). Keep this file updated in the same
change that adds or renames an operation on any surface.
