# repo-explorer — browse an omgbase repository, end to end, over ten tools

A Lit demo that lets a person walk a repository the way an agent does: the
tree on the left, a document rendered as Markdown (every block an anchor that
shows its id on hover) with its properties as a table, its backlinks and
outlinks, its history with a client-side diff against any revision, a live
strip of commits as they land, a query console for OQX in a collapsible drawer
(⌘J), a keyboard-first palette (⌘K: find a document by path or title, run an
action, `+path` creates one), a frontmatter edit previewed with `plan` and
committed with `execute`, task checkboxes that write back (a click is one
`apply` pinned to the block's hash), and a **graph** tab: the document's
neighbourhood over the `links` collection, expanded node by node, with drag to
pin, spring settling on unpin, and a ⌘-drag connector that writes a relation —
into a frontmatter field or as a body link, the user's choice, never the
page's. Every write is a command on the shared `@omgbase/client` `CommandLog`:
undo / redo (⌘Z / ⇧⌘Z) is a compensating `apply` computed against the
repository's CURRENT state and refused when what the command wrote moved on.

It is built against the **minimal tools profile** — `omg mcp --tools minimal`,
exactly `query`, `query_syntax`, `docs_read`, `docs_tree`, `blocks_resolve`,
`changes_since`, `plan`, `execute`, `apply`, `version` — and `pnpm dev` serves
that profile by default, so the page proves itself against it. Everything it
shows comes from those ten (the table under [Works on the minimal
profile](#works-on-the-minimal-profile) names the tool behind each feature);
`tools/list` is read on connect and the one tool beyond the ten the page ever
uses is `repos`, for a repository picker when a full server lists it. The
repository is otherwise a **designation**, as in graph-ui: the header field
(persisted; `?repo=<slug>` in the page URL seeds it), else the one the proxy was
started for (`pnpm dev --repo <slug>`, reported on `/whoami`), else the server's
default — sent as the `repo` argument of every repo-scoped call.

**Requires omgbase surface ≥ 5.0** (the current `omg`): surface 5.0's
"underscore = engine" rule — on every record a bare name is the user's and an
engine-provided one is `_`-prefixed (`_id`, `_path`, `_title`, `_doc_id`, …), a
`docs_*` tool is addressed by `_id`/`_path` with no tolerance for the bare
spelling, and an effect's field is `_frontmatter.<k>` — is what every query and
call below speaks, so a 4.x server cannot serve this page (its `path` arguments
are gone and `_path` is unknown there). The page calls `version` on connect,
shows `surface 5.0 · minimal` in the header, and refuses an older server with
*this demo needs omgbase surface ≥ 5.0 … — the server reports 4.11*. (The
`revisions` target and `docs_read { at }` it also leans on arrived in 4.7.)

## Run it

```sh
pnpm install && pnpm build             # at the repository root (the demo spawns the built `omg`)
pnpm --filter repo-explorer dev        # copies the alchemy corpus into .dev-workspace/alchemy, indexes it,
                                       # starts the MCP proxy with `omg mcp --tools minimal`, starts Vite
```

Open <http://localhost:5175>. The sample is the **alchemy corpus**
(`packages/core/corpus/oqx/fixtures/alchemy`, the twenty documents every spec
fixture and tutorial in this repository uses); the copy under
`.dev-workspace/alchemy` is the repo's source, so a frontmatter edit made in
the page lands there, not in the checked-in fixtures (`pnpm --filter
repo-explorer dev:workspace --force` resets it).

```sh
pnpm --filter repo-explorer dev --full                              # the same workspace, the whole catalog (a repo picker appears)
pnpm --filter repo-explorer dev --remote https://mcp.example.com/omg    # a remote omg MCP; the proxy signs in for you
omg -C examples/repo-explorer/.dev-workspace meta processes/calcination.md --set verified=false   # watch the strip
```

The proxy is the [`webdevproxy`](../webdevproxy/README.md) workspace package:
the page talks to the same-origin `/mcp` (Vite proxies it), the proxy talks to
`omg mcp` over stdio — or, with `--remote`, to a gateway it signed in to (the
page says *waiting for sign-in in your browser* while it polls `GET /whoami`,
and the header reads `via local proxy → <host> · <identity>`). `WEBDEVPROXY_REMOTE=<url>`
is the same as `--remote`; `--no-browser`, `--token-file`, `--client-id`,
`--callback-port`, `--port` (default **8789** — graph-ui 8787, live-tail 8788,
so the three demos run side by side), `--path`, `--idle` and `--origin` are the
proxy's flags (consumed by `scripts/dev-args.mjs`; anything else goes to
Vite); `pnpm --filter repo-explorer logout` forgets the tokens.

`--tools minimal` is not a webdevproxy flag: the proxy spawns its `--omg` entry
as `omg mcp -C <dir>`, so `scripts/omg-minimal.mjs` is the `omg` it spawns by
default — a stand-in that runs the monorepo's build with `--tools minimal`
appended to an `mcp` call (`--full` hands the proxy the build itself; `--omg`
or `WEBDEVPROXY_OMG` win over both).

Scripts: `dev [--full] [--remote <url>]`, `dev:workspace [--force]`, `dev:mcp`
(the proxy alone, = `dev --proxy-only`), `logout`, `build`, `typecheck`,
`test`, `lint`.

## Works on the minimal profile

Every feature, the tool it calls and the exact OQX it sends — in surface 5.0's
spelling: a row attribute is `_`-prefixed in a query, in an argument and in a
result (`_id`, `_path`, `_raw`, `_title`, `_dst_path`, `_rev`, …); a role keeps
its bare name (`docs_tree`'s `path` prefix, `rev`, `at`, `include_ids`, `ids`,
`cursor`, `limit`; a digest's `commit`/`seq`); an authored key is bare (`layer`,
`tags`, `verified`). `<path>` is the open document's `/`-rooted path, `<id>` its
`d_…` id (both from `docs_read`'s `_path`/`_id`), `<rev>` a revision id from
the history list. A `repo` argument is added when a repository is designated
(the header field, `?repo=`, the proxy's `--repo`, or the `repos` picker on a
full server); with none, nothing names one and the server's default repository
is browsed.

| feature | tool(s) | call |
| --- | --- | --- |
| connect: the surface gate, the profile label | `version`, `tools/list` | `version {}` → `specs.surface` (≥ 5.0), `profile`; the listing decides whether a picker is offered |
| repository tree (left pane) | `docs_tree` | `{ depth: 1, files: true }` for the root, `{ path: "/processes/", depth: 1, files: true }` per folder as it opens (`path` is a prefix — a role, bare; `files: true` because the pane lists documents — since surface 5.1 the default page is the directory rollup alone), `{ …, cursor }` while a level is truncated; entries are directory rows `{ _path (ending /), docs, blocks }` — `docs` for the badge — or document rows `{ _id, _path, blocks }`; `total` the header's counts, `files_here` the documents at the prefix itself |
| document view | `docs_read` | `{ _path \| _id, include_ids: true }` → `_raw` (rendered as Markdown by markdown-it, or shown raw), `properties.frontmatter / inline / computed` (the property table; the computed title is `computed._title`), `ids` + `parents` + `hashes` (the block anchors, below) |
| backlinks | `query` | `links { select _path, _block_id, _provenance, _field, _anchor where _dst_path == "<path>" }` |
| outlinks | `query` | `links { select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor where _path == "<path>" }` |
| wikilinks naming the document | `query` | `links { select _path, _block_id, _provenance, _field, _anchor where _dst_id == "phantom:<stem>" }` (`<stem>` = the file name without its extension; see feedback 10) |
| a `[[wikilink]]` clicked | `query` | `docs { select _path where _path.endsWith("/<name>.md") }` |
| query console | `query`, `query_syntax` | the textarea's text with `limit: 50`, then `{ …, cursor }` for "more"; `query_syntax {}` once, for the drawer; the starter is `docs { select _title, layer, tags order by _path }` |
| palette: find (⌘K) | `query` | `docs { select _id, _path, _title where (_path ~* "<term>" or _title ~* "<term>") and (…) order by _path limit 20 }` — one group per whitespace-separated term, regex-escaped (the OQX baseline treats `/` and `-` as metacharacters too) and JSON-quoted; empty text lists the first 20 by path; the hits are ranked in the browser (title prefix > title contains > path segment prefix > path contains) |
| palette: create (`+path`, or the suggestion when nothing matches) | `apply`, then `docs_read` | `apply { effects: [{ op: "create", path: "<path>", markdown: "# <Title>\n" }], reason: "create document" }` → the Receipt; `docs_read { _path }` for the created bytes and `rev` (the undo's guard); a bare name lands in the open document's folder, `.md` is appended; `path_taken` → *a document (or a file) already exists at …* |
| graph tab: the neighbourhood | `query` | the two `links` queries above for the expanded document, then one `docs { select _path, _title where _path in ("/a.md", "/b.md") }` for the titles the model lacks; 12 neighbours per direction, the rest a "+k more" badge; ⊕ expands a node (the same two queries) |
| graph tab: a connector dropped on a document | `docs_read`, then `apply` | `docs_read { _path: <from> }` → the source's frontmatter → the chooser: every list field of paths (*append*), every scalar path field (*turn into a list* or *replace*, said plainly), *a new list field* (named by the user), *a body link*; then ONE `apply` — `{ op: "set", target: "<from>", field: "_frontmatter.<field>", value: [...], expect: { revision: "<rev>" } }` or `{ op: "insert", into: "<from>", at: "end", markdown: "[<title>](<to>)" }` — then the source re-read and its neighbourhood rebuilt |
| graph tab: a connector dropped on open canvas | (the palette) | the palette in pick mode (*connect /a.md to…*): a document picked, or created as above, then the chooser |
| an `_id` cell clicked | `query` | `blocks { select _path where _id == "b_…" }` (nodes/links likewise), `revisions { select _path, _doc_id where _rev == "r_…" }` — then the document opens (a `d_…` id needs no query) |
| history (per document) | `query` | `revisions { select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id where _doc_id == "<id>" order by _seq desc }` |
| time travel + diff | `docs_read` | `{ _id: "<id>", at: "<rev>" }` → `_raw`; the unified diff against the current body is computed in the browser (`src/lib/diff.ts`) |
| deleted documents | `query` | `revisions { select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id where _doc == null order by _ts desc, _seq desc }` |
| live feed (the strip) | `changes_since` | `{ limit: 1 }` once for `head`, then `{ cursor, limit: 50 }` every N seconds (default 3); a digest's `revisions` are `[{ _id, _path, _hash }]` |
| frontmatter edit | `plan`, `execute` | `plan { effects: [{ op: "set", target: "<path>", field: "_frontmatter.<k>", value }], diffs: true }` → `preview.summary` + `preview.diffs` (+ `preview.revisions[{ _id, _path, _hash }]`); on confirm `execute { plan_id, effects, reason }` (the digest form, the same effects) → the Receipt's `revisions[{ _id, _path, _hash }]` |
| task checkbox (toggle) | `apply`, then `docs_read` | `apply { effects: [{ op: "set", target: { kind: "block", _id: "<block id>" }, field: "_attrs.checked", value: true \| false, expect: { content_hash: "<hashes[id] from the read>" } }], reason }` — ONE call, the CAS from `include_ids` — → the Receipt; then `docs_read { _path, include_ids: true }` again so the rendering and the hashes are the truth. A wrong hash is `stale_expectation` (`data.current._hash`), a document that moved between plan and commit `stale_plan`: the page re-reads and says *the document changed since it was read — refreshed; try again* |
| undo / redo (session-local, every write) | `query` / `docs_read`, `apply` | the shared `CommandLog`'s compensation, re-checked against the CURRENT state: a task toggle re-reads the block's `_hash` (`blocks { select _hash where _id == "b_…" }`) and is refused unless it is the one the toggle left, else `apply { set _attrs.checked back, expect: { content_hash } }`; a frontmatter edit, a relation or a created document re-reads the document (`docs_read`) and is refused unless the key / field / bytes still hold what the command wrote, else `set`/`unset` the previous value pinned to the current `revision`, `remove` the block by its `content_hash`, or `remove` the document; a pin or an expansion restores the model |

Not used, on either profile: `docs_history`, `docs_diff_unified`,
`docs_read_at`, `docs_list`, `docs_set_meta`, `blocks_check`, `blocks_update`,
`blocks_resolve` — the same code path runs under `--tools minimal` and
`--tools full`. `apply` is used where a click is its own confirmation — a task
toggle, a create from the palette, a relation the chooser confirmed, every
undo — one guarded effect each; a frontmatter edit goes through `plan` →
`execute` for its preview, and its commit is a log entry too.
`test/minimal-profile.test.ts` runs every data path above against a scripted
server that lists exactly the ten and refuses every other name, and asserts the
tools asked for; the real stack was also driven end to end (below).

### Block anchors

`docs_read { include_ids: true }` returns the block ids in pre-order with a
`parents` map and a `hashes` map, but no spans. markdown-it's block tokens carry
source line ranges. The two trees are the same block model — a top-level
CommonMark block is a top-level omgbase block, a list's items are its children,
a list item's own text *is* the item (it has no paragraph child in the store) —
so `src/lib/markdown.ts` pairs them positionally level by level and gives every
rendered block `id="b_…"` and `data-block` (hover a block for its id; `#doc=…&block=b_…`
scrolls to it). Each pairing is then **verified**: a block's hash is the sha256
of its raw source and the raw is the token's lines (trailing blank lines
dropped), so a candidate that hashes to the stored hash is certain and one that
does not is shown marked `data-verified="false"`; a level whose counts disagree
gets no anchors rather than a guess. On the alchemy corpus every one of the
315 blocks of the 19 live documents pairs and verifies — after allowing for one
format-layer quirk: the raw of a paragraph nested in a blockquote keeps the `>`
marker on its continuation lines but not on its first line (`"One becomes
two…\n> fourth."`), so that form is a second candidate.

### Task checkboxes

markdown-it renders `- [ ] x` as the text `[ ] x`; a core rule in
`src/lib/markdown.ts` (`taskList`, after `inline`) recognises the GFM marker —
`[ ]`, `[x]` or `[X]` followed by whitespace at the start of a list item's
first paragraph, the rule remark gives the engine, so the store types the same
items `task` — strips it from the text and renders `<li class="task"><input
type="checkbox" class="task-check" data-block="b_…" [checked]> …</li>`
(`html: false` stays: the input is the page's own token, not parsed HTML; a
link `[x](…)`, a marker without a space, or `[ ]` in a paragraph is not a
task). The checked state comes from the marker, which the store's
`_attrs.checked` agrees with.

The marker rule and the pairing are independent: the rule marks the item, the
pairing (above) gives the `<li>` its `data-block` and verdict, and the box is
**enabled only when both hold** — the item's anchor is verified
(`data-verified="true"`, so `hashes[id]` is certainly this item's CAS token)
and the server lists `apply`. Otherwise the box is rendered `disabled` with the
reason as its `title`: *read-only: this server does not list `apply`*; *this
item has no block anchor (its level did not pair with the store's ids)* — a
list whose item count disagrees with the store's children, or a document read
without ids; *this item's block could not be verified against the store*. Any
list item the pairing cannot place or verify therefore renders as a task you
can see but not toggle, never as a guess; the anchors line counts them (*3
tasks (1 not editable — hover the box)*).

A `change` on an enabled box emits `task-toggle { blockId, checked,
contentHash }` (the hash from the document's `blockIds.hashes`) and the page
sends ONE `apply` with `{ op: "set", target: { kind: "block", _id }, field:
"_attrs.checked", value, expect: { content_hash } }`. While it is in flight the
box keeps the state the user gave it, disabled; on success the document is
re-read (`docs_read { include_ids: true }`) and re-rendered — the new hashes
land and the rendering is the truth, the property table, history and links
refresh as they do after a frontmatter edit, the folder's counts reload. On
`stale_expectation` / `stale_plan` / `plan_mismatch` the page re-reads (the box
falls back to the rendering's state) and says *the document changed since it
was read — refreshed; try again*.

**Undo** (the `undo` / `redo` buttons by the title; ⌘Z / ⇧⌘Z, Ctrl on other
platforms, while the document view has focus and the key did not land in a
text field; also `>undo` in the palette) is compensation, not history
rewriting. A toggle runs as `@omgbase/client`'s `taskCheckCommand` on the
page's `CommandLog` (in memory, cleared on a repo switch), which remembers the
block's hash before and after the write. Undoing it re-reads the block's
CURRENT hash and **refuses** unless it is exactly the one the toggle left —
someone else wrote the block since, and an undo would overwrite their change —
else sends a new `apply` setting the attr back with `expect: { content_hash }`
of that hash. Redo re-reads the same way. A refused entry stays applied, off
the undo path, with its reason shown (*undo refused — block b_… changed since
(hash …, expected …); nothing was overwritten*). The same log holds the
frontmatter edits (`frontmatterPlanCommand`, `src/lib/writes.ts`: the confirmed
plan commits in the digest form; the undo restores the key's previous value —
or unsets a key the edit created — pinned to the document's current revision,
refused when the key no longer holds what the edit wrote), the created
documents (`createDocumentCommand`, `src/lib/create.ts`: removed on undo unless
edited since), the relations (`attachRelationCommand`, `src/lib/relations.ts`)
and the graph's pins and expansions (local commands: restore the model).

### What the minimal profile made awkward (product feedback)

Things a client has to work around on the ten tools, each found while building
this page against `omg mcp --tools minimal`:

1. **No `repos`.** There is no way to learn which repositories the server
   holds or which one is the default; the page browses "the default repo" and
   can only offer a picker when a full catalog lists `repos`. A `version` that
   named the default repository's slug (it already reports the profile) would
   let a minimal client at least say which repository it is looking at.
2. **A deleted document is listable but not readable.** `revisions { _doc ==
   null }` lists a deleted document's revisions (history is history), but
   `docs_read { _id | _path, at }` is `doc_missing` for a document that is not
   live — on every profile (`docs_read_at` has the same locator rule). The
   "deleted documents" pane therefore shows the revision rows and says why the
   body cannot be fetched. Letting `at` reach a tombstoned document's revision
   (the bytes exist in the Merkle tree) would close this.
3. **`order by` disables the cursor.** `revisions { _doc_id == … order by
   _seq desc }` — the natural history query — returns the top `limit`
   with `truncated: true, cursor: null`; the console's "more" button cannot page
   it, and the history pane caps at 200 revisions (`fetchAllRevisions` pages the
   default order and sorts client-side when more are needed). A keyset cursor
   over the `order by` columns, or at least `offset` paging advertised in the
   footer, would make ordered lists pageable.
4. **Block spans are not in `docs_read`.** `include_ids` gives ids, parents and
   hashes — enough to *verify* an anchor, but the client has to re-parse the
   Markdown and pair trees to *place* one. A `spans` map (block id → byte or
   line range in `_raw`) next to `hashes` would make the anchors exact without
   a parser on the client, and would also make the hash verification
   unnecessary.
5. **A quoted paragraph's `_raw` is not its source bytes** (the first line loses
   its `> ` marker, continuation lines keep theirs). Harmless for CAS, but
   anyone hashing the source to find a block hits it; worth a line in
   `spec/format`.
6. **No `properties` at a past revision.** `docs_read { at }` returns `_raw` only
   (documented, 4.7); the history pane shows the diff of the whole file, which
   covers the frontmatter, so nothing is lost — but a client wanting the
   property table "as of" must parse YAML itself.
7. **`blocks_resolve` has no reach from a browser without a search box.** It is
   in the ten for agents; this page did not need it (every lookup it wanted
   was a `query`). Not a problem — noted so the "every feature works on
   minimal" claim is read right: seven of the ten were needed.
8. **A sugar tool's absence is a JSON-RPC error, not a tool result.** `repos`
   on a minimal server is `-32602 unknown tool repos` thrown by the SDK; the
   client maps it to an `OmgError("unknown_tool")` so it reads like the other
   envelopes. Fine by the spec; mentioned because a client that only handles
   `isError` results will see an exception here.
9. **The `fix` is a string of canonical JSON** (`plan_mismatch` carries
   `data.fix: "{\"effects\":[…]}"`). Rendering it verbatim is right for an
   agent; a browser client would like it as an object (or both) to offer a
   "re-plan with this" button without parsing.
10. **A bare `[[wikilink]]` is not a backlink.** `[[salt]]` in `index.md`,
    `calcination.md`, `mercury.md` and `sulphur.md` does not resolve to
    `/substances/salt.md`: the link row has `_dst_path: null`, `_dst_kind:
    "document"`, `_dst_id: "phantom:salt"`, so `links { _dst_path ==
    "/substances/salt.md" }` returns nothing and salt's backlinks read 0 in the
    links tab. The page lists them anyway under "wikilinks naming [[salt]]"
    with `where _dst_id == "phantom:salt"` — but that is a client guessing the
    engine's phantom naming. Resolving a bare wikilink to the unique document
    whose file name matches (the Obsidian rule), or at least a `_dst_name`
    field, would make wikilink backlinks first-class.
11. **The Receipt names the document's new hash, not the block's.** After a
    task toggle the Receipt's `revisions[{ _id, _path, _hash }]` carries the
    FILE hash; the next CAS token for that block — its new `content_hash` — is
    only learnable by `docs_read { include_ids }` again. This page re-reads
    anyway (to re-render from the truth), but a client that only wants to keep
    toggling, or to arm an undo, needs the touched blocks' new hashes in the
    Receipt (`blocks: [{ _id, _hash }]`, say). Found while recording
    `hashAfter` for the undo log.
12. **Three codes mean "it moved on".** A wrong `expect.content_hash` under
    `apply` is the kernel's `stale_expectation` (with `data.current._hash` —
    enough to retry blind, which this page deliberately does not do); a
    document that changed between the plan and the commit inside the same
    `apply` is `stale_plan`; the digest form of `execute` is `plan_mismatch`.
    All three are retriable and mean the same thing to a checkbox; a client has
    to know all three. The spec documents each where it arises; one line
    listing them together (or one `retriable` family name) would help.
13. **`apply` has no preview; `plan` + `execute` is two round trips.** A
    checkbox is the one write where a click is its own confirmation, so one
    `apply` is right — but the page shows nothing of what the engine will do
    until the Receipt's `summary` (*check task b_… in /processes/calcination.md*)
    arrives. That summary is good; it would be worth having BEFORE the write
    without paying for `plan { diffs: true }` — a `plan { effects }` with no
    diffs is already cheap, so this is a note, not a complaint.

## What it does

The data path is MCP only — `@modelcontextprotocol/sdk`'s client over the
Streamable HTTP transport at the same-origin `/mcp`; nothing imports
`@omgbase/core`. On load:

1. `GET /whoami` — the proxy's mode and sign-in state (header label; the
   sign-in wait).
2. `version` → the surface (refused under 5.0) and the profile for the header;
   `tools/list` → the capabilities (`src/lib/tools.ts`): a banner names any of
   the ten that is missing and the feature it takes away; `repos` → the picker,
   only when listed.
3. `docs_tree {}` → the root level; folders load on first open and remember
   their state; opening a document reveals its folders.
4. The URL hash is the state — `#doc=/processes/calcination.md`,
   `&rev=r_7&tab=history`, `&tab=graph`, `&block=b_12`, `#deleted` — so a
   document, a revision of it, its graph, or the deleted list is a link one can
   reload or share.
5. A document: `docs_read { include_ids: true }`; the body rendered (or raw,
   persisted), the properties as a table, the two `links` queries, the
   `revisions` query; a `[[wikilink]]` resolved by one query, a `/`-rooted or
   relative link opened in place, an external one in a new tab.
6. The strip: `changes_since` from the repo's `head`, polled; new digests are
   prepended (newest first, deduped by commit, capped at 50) and the folders
   they touched are refreshed; a change to the open document reloads it.
7. The console, a drawer under the main pane (⌘J, or its bar; closed it is one
   line — the last result's count and the query; open it is a resizable
   vertical split, both persisted; running a query opens it): ⌘/Ctrl+Enter
   runs; the result's keys are the columns (`_id`,
   `_path` first — the envelope; a bare `id`/`path` is an authored key and an
   ordinary column), an `_id`/`_path` cell opens the thing it names, `hints` is the
   yellow bar, an error shows the engine's code, message, `data.hint` and
   `data.fix`; "more" follows the keyset cursor; the footer says why an ordered
   query cannot page; "syntax" opens `query_syntax` in a drawer.
8. A frontmatter edit (when `plan` and `execute` are listed): a key and a value
   (read the YAML way: `true`, `3`, `"text"`, `[a, b]` as JSON, else text) →
   `plan { …, diffs: true }` → the summary and the before/after diff in a
   confirm strip → `execute { plan_id, effects }` → the Receipt's commit and
   summary; `plan_mismatch` / `stale_plan` drop the pending plan and show the
   engine's `fix`.
9. A task checkbox (when `apply` is listed and the item's anchor verified):
   one `apply { set _attrs.checked, expect: { content_hash } }` → the Receipt's
   commit and summary → the document re-read and re-rendered; `undo` / `redo`
   (buttons, ⌘Z / ⇧⌘Z) compensate the last command after re-checking the
   repository's state, refusing when it changed (see [Task
   checkboxes](#task-checkboxes)).
10. The palette (⌘K, or the header's `⌘K`): typing finds documents (one
   `query` per keystroke, debounced; ↑↓ move, ⏎ opens, ⇥ completes the path,
   esc closes), `>` lists the page's actions (console, run the query, new
   document, deleted documents, the strip, reconnect, undo/redo with their
   labels, raw/rendered, the open document's tabs), `+path` (or the *create
   /…* suggestion when nothing matches) creates a document — a bare name lands
   in the open document's folder — and opens it. The graph's connector uses
   the same palette in *pick* mode to find or create a destination.
11. The graph tab: the open document's neighbourhood (`src/lib/graph.ts`, a
   renderer-neutral model: nodes by path, edges keyed by source, destination
   and field/block, provenance `frontmatter` / `body` / `external`), laid out
   by d3-force in `<graph-pane>`. Drag repositions and pins on drop (one log
   entry per drag); `u`, Backspace or the ✕ unpins and the node eases back
   (synchronous under `prefers-reduced-motion`); ⊕ or `e` expands a node (12
   per direction, "+k more" otherwise; an undoable query command); arrows move
   the selection, ⏎ opens, `f` fits. ⌘-drag (or `c`, or the connect button)
   from a node is a connector: on a document it opens the chooser — where the
   relation is written is always the user's call — on open canvas the palette
   picks or creates the destination first. Edges show their provenance on
   hover (the frontmatter field, the block of a body link, the URL of an
   external one); rendered edges are not writable by dragging.

**Session recovery.** The proxy forgets a session after `--idle` seconds or
when it restarts and answers the next POST with `404 -32000 unknown session`;
`src/lib/mcp-client.ts` (`isSessionLost`) opens a fresh session and retries the
call once, noting *session expired at the server — reconnected* in the header.

## Layout

- `src/app.ts` — the page element (`<repo-explorer-app>`, Lit 3 + `@lit-labs/signals`,
  Shoelace `<sl-split-panel>` / `<sl-tab-group>`): connect, the route, the
  loaders, the poll loop, the write flow.
- `src/elements/` — `repo-tree` (folders, badges), `doc-view` (properties,
  rendered/raw body, the anchors line, the frontmatter editor and confirm
  strip, the task checkboxes' `change` → `task-toggle`, the undo/redo buttons
  and ⌘Z → `log-undo` / `log-redo`), `links-panel`, `query-console` (textarea,
  table, hints, errors, the syntax drawer), `history-panel` (the revision list,
  unified diff or side by side), `feed-strip`, `command-palette` (the overlay:
  combobox + listbox, the keys, pick mode), `graph-pane` (SVG + d3-force: cards,
  arrows, pins, the connector, the keyboard).
- `src/lib/mcp-client.ts` — the shared `@omgbase/client` re-exported
  (`OmgClient`: one tool call, the JSON-text envelope, session recovery,
  `unknown tool` → `OmgError("unknown_tool")`), plus this page's own: the
  `Caller` interface every feature module takes, `applyArgs` / `applyEffects`,
  `fetchWhoAmI`, `repoArg`.
- `src/lib/tasks.ts` — the task marker, `setCheckedEffect` (the CAS-pinned
  `set _attrs.checked`), `taskDisabledReason`, the moved-on codes; pure. The
  toggle's command is `@omgbase/client`'s `taskCheckCommand`.
- `src/lib/palette.ts` — the palette's input modes, the find query, ranking,
  action matching, `newDocumentPath`, the cursor; `src/lib/create.ts` —
  `createDocumentCommand`, `defaultMarkdown`, `creationError`.
- `src/lib/graph.ts` — the graph model (`withNeighborhood`, pins, titles,
  provenance text, the geometry helpers); `src/lib/graph-commands.ts` — pin /
  unpin / expand as local commands; `src/lib/relations.ts` — `relationChoices`,
  `describeRelation`, `attachRelationCommand` (frontmatter kinds guarded by the
  revision, the body link by the inserted block's hash).
- `src/lib/tools.ts` — `MINIMAL_TOOLS`, `capabilities`, the missing-tools banner.
- `src/lib/tree.ts` — `docs_tree` shapes, `fetchLevel` (follows the cursor), labels.
- `src/lib/document.ts` — `docs_read` / `docs_read { at }` shapes, `fetchDocument`,
  `fetchDocumentAt`, `propertyRows`, `splitFrontmatter`.
- `src/lib/markdown.ts` — markdown-it (no raw HTML, images named not fetched,
  wikilinks, doc links marked, the task-list rule and checkbox renderer),
  `mdBlockTree`, `pairBlocks`, `candidateRaws`, `verifyAnchors` (sha256 via
  WebCrypto), `renderBody` (gates each box by its anchor's verdict and
  `canApply`), `anchorsSummary`.
- `src/lib/links.ts`, `src/lib/history.ts`, `src/lib/feed.ts`, `src/lib/writes.ts`,
  `src/lib/console.ts`, `src/lib/query.ts` — the queries, shapes and calls per
  feature (the table above), each pure where it can be; `writes.ts` also holds
  `frontmatterPlanCommand` (the confirmed plan as a log entry).
- `src/lib/diff.ts` — Myers' O(ND) line diff with `docs_diff_unified`'s tie rule
  and hunk format, `unifiedDiff`, `diffStats`.
- `src/lib/route.ts` — the hash route; `src/lib/paths.ts` — paths, the hit
  envelope (`_id`/`_path`), the `docs_*` locator (`{ _id } | { _path }`), the
  ≥ 5.0 gate; `src/lib/effect.ts` — the signals `effect` helper.
- `scripts/dev.mjs`, `dev-args.mjs`, `dev-workspace.mjs`, `omg-minimal.mjs` —
  the proxy + Vite dev script, the alchemy workspace, the `--tools minimal` stand-in.
- `test/` — vitest over the pure parts and the data paths through a scripted
  MCP server (`test/scripted.ts`: answers from a table, records calls, refuses
  anything outside the ten like the real minimal server): the surface gate,
  capabilities, the tree (paging), document shapes and the property table,
  the block trees / pairing / hash verification / rendering, the link queries
  and targets, the console (columns, cells, scalars, paging, errors with `fix`,
  the shortcut), history (queries, grouping deleted documents), the diff
  (edit scripts, hunks, the alchemy frontmatter edit), the feed (cursor,
  entries, cap), writes (effects, value parsing, plan → execute, `plan_mismatch`),
  tasks (the marker, the CAS-pinned effect, the gate reasons, the moved-on
  codes; task items rendered enabled / disabled / nested / not-a-task), the
  frontmatter plan command (the digest-form execute, the restore, the refusal),
  the palette (modes, the find query's escaping, ranking tiers, action
  matching, `newDocumentPath`, the cursor) and the create command, the graph
  model (bounds, dedup, pins, the titles query), the pin/unpin/expand commands
  through a real `CommandLog` (coalescing), the relations (the choices over
  frontmatter shapes, each write's exact effect and guard, every refusal), the
  geometry, the route, the dev arguments and the stand-in — 181 tests, no live
  server. The client's session recovery and `unknown tool` mapping are tested
  in `packages/client`.

## Verified against the real stack

Recorded against **surface 5.0** (`omg` 0.26.1, the TypeScript engine; the
proxy was also run in front of the Rust `omgbase` binary for `docs_read`,
`query` and the argument refusal, with byte-identical envelopes). Over a scratch
workspace built from the alchemy corpus with `scripts/dev-workspace.mjs`,
webdevproxy started exactly as `pnpm dev` starts it (`pnpm dev:mcp`: the
minimal stand-in as `omg`), and the page's own `src/lib` modules driven from
Node through `OmgClient` over Streamable HTTP, every call in the table above
was made once against the live server:

- `tools/list` returned exactly the ten; `version` said `specs.surface
  "5.0"`, `profile "minimal"`, `engine "typescript"` — the gate passed.
- `docs_tree {}` listed `/index.md` and six folders (`total` 20 docs, 327
  blocks); `{ path: "/processes/", depth: 1 }` four `doc` rows, each
  `{ _id, _path, kind, docs, blocks, _updated_at }` — exactly those keys.
  (Surface 5.1 changed the page: the default is the directory rollup —
  `{ _path, docs, blocks }` rows plus `files_here` — and the pane now asks
  `files: true` to list the documents as `{ _id, _path, blocks }`.)
- `docs_read { _path: "/processes/calcination.md", include_ids: true }`
  returned `{ _id, _path, rev, properties, _raw, ids, hashes, parents }`,
  `properties.computed` = `{ _title: "Calcination" }`, seven frontmatter keys
  and two inline fields in the table; `{ _id }` read the same document; 20 of
  20 blocks anchored and hash-verified. `docs_read { path: … }` (the 4.x
  spelling) was refused: `filter_invalid` — "`path` is not an argument — the
  engine field is `_path` (the bare namespace is the user's); pass `_path`",
  `data.hint "arguments"`, `data.fix "{\"_path\":\"/processes/calcination.md\"}"`.
- the links queries: five backlinks (`/index.md`, `/lab/2026-01-notes.md`,
  `/processes/magnum-opus.md`, `/substances/prima-materia.md`,
  `/substances/salt.md`) and one outlink, the dangling `[[salt]]` (`_dst_path:
  null`, `_dst_kind: "document"`, `_dst_id: "phantom:salt"`); salt's "wikilinks
  naming" list had six documents by `_dst_id == "phantom:salt"` while its
  `_dst_path` backlinks were 0 (feedback 10 holds); `[[salt]]` resolved to
  `/substances/salt.md`.
- `from revisions where _doc_id == …` listed the one `observed` revision
  (`_rev`, `_seq`, `_hash`, `_is_current: true`, `_doc_id`); `docs_read { _id,
  at }` returned its `_raw` (`renderedHashMatch: true`) and diffed empty
  against the current body; `locatorQuery` found a block's `_path` and a
  revision's `_path` + `_doc_id`.
- the console: the starter query's columns were `_id, _path, _title, layer,
  tags`; `select titel from docs` came back with the hint "did you mean
  `title`?", `select title from docs where path == "/index.md"` (4.x) with
  zero hits and "no document … carries a property `path`; did you mean
  `_path`?"; `select target from links` was `filter_invalid` naming the
  thirteen link engine names (`hint: "OQX"`); `query_syntax` returned the
  reference (37 KB, `_title` in it); `repos` was `unknown tool` →
  `OmgError("unknown_tool")`.
- `changes_since { limit: 1 }` gave `head 20`; `plan { set
  _frontmatter.verified = false, diffs: true }` previewed `set
  _frontmatter.verified = false in /processes/calcination.md` with the
  before/after bytes and `preview.revisions[{ _id, _path, _hash }]`; `execute
  { plan_id, effects, reason }` committed `c_gb0tfmb` with the same revision
  triple; `changes_since { cursor: 20 }` then showed one digest `api(agent:mcp):
  /processes/calcination.md` with `revisions: [{ _id, _path, _hash }]`; the
  re-read had `frontmatter.verified: false` and a second revision (`api ·
  agent:mcp`, the reason); executing the same plan again was `plan_mismatch`
  with `data.fix` = the effects as canonical JSON.
- `apply { remove /texts/mutus-liber.md }` populated the deleted list: `from
  revisions where _doc == null` showed the document's one revision, `docs_read
  { _id, at }` of it was `doc_missing` (feedback 2 holds), the deletion's
  digest had `revisions: []` and the summary `deleted /texts/mutus-liber.md`,
  and the root `total` dropped to 19 docs / 315 blocks.

The page itself was then loaded in headless Chrome against Vite + the same
proxy and read through the DevTools protocol: the header `surface 5.0 ·
minimal · default repo`, no missing-tools banner, the tree with its badges
(`19 docs · 315 blocks`, `texts/ 1 doc`), `/processes/calcination.md` titled
*Calcination* with 20 anchored and verified blocks, the history tab's two rows
(`api · agent:mcp … current`, `observed`), `backlinks (5)` / `outlinks (1)`,
the feed strip watching from `seq 22`, and four console runs — the starter
query as the columns `_id, _path, _title, layer, tags`; `select title, path
from docs` as `_id, _path, title` (the corpus authors a `title:` key) with the
yellow hint bar "did you mean `_path`?"; `select target from links` as the red
`filter_invalid` block with the engine names and `(OQX)`; `from revisions
where _doc == null` as `_id, _path, _rev, _seq, _doc_id` naming the deleted
document. `/substances/salt.md`'s properties table (seven frontmatter keys
with their edit buttons, three inline, `computed _title Salt`) and its links
tab (`backlinks (0)`, `outlinks (4)` with two dangling, `wikilinks naming
[[salt]] (6)`) rendered as the table above says; no page errors.

**Task checkboxes (2026-10-23, surface 5.1, `omg` 0.26.1, TypeScript engine,
the same `pnpm dev:mcp` proxy on the minimal profile).** The page's own
modules (`fetchDocument`, `renderBody`, `setCheckedEffect`, `applyEffects`,
`compensation`, `afterCompensation`) driven from Node through `OmgClient`
over Streamable HTTP, issuing exactly the calls a click issues, against the
workspace copy of `/processes/calcination.md`:

- `tools/list` → the ten, `apply` among them; `version` → `5.1`, `minimal`.
  `docs_read { _path, include_ids: true }`: 20 anchored, 0 unverified, `tasks
  { total: 3, editable: 3 }`; the unchecked *Repeat with copper…* item is
  `b_7sk8zb8`, hash `486941ab0289…`, rendered `<input type="checkbox"
  class="task-check" data-block="b_7sk8zb8">`; the file line `- [ ] Repeat
  with copper and record the colour sequence`.
- **toggle** — ONE `apply { effects: [{ op: "set", target: { kind: "block",
  _id: "b_7sk8zb8" }, field: "_attrs.checked", value: true, expect: {
  content_hash: "486941ab…" } }], reason: "repo-explorer task toggle" }` →
  Receipt `commit c_9r9q65k`, `committed: true`, `summary ["check task
  b_7sk8zb8 in /processes/calcination.md"]`, `revisions [{ _id, _path, _hash
  219a3c1f… }]` (the document's hash — feedback 11). The re-read: a new `rev`,
  the block's hash `486941ab0289… → 1eb8129bae27…`, still 0 unverified, the
  box rendered `checked`; the file line now `- [x] Repeat with copper…`.
- **a second toggle with the OLD hash** — `apply { …, value: false, expect: {
  content_hash: "486941ab…" } }` was refused: `stale_expectation` — *content
  hash mismatch*, `retriable: true`, `data.current._hash 1eb8129bae27…` (the
  hash the first toggle left); `isMovedOn` true; the file unchanged.
- **undo** — the fresh read's hash equalled the record's `hashAfter`, so
  `compensation` produced `{ op: "set", …, value: false, expect: {
  content_hash: "1eb8129bae27…" } }`; `apply { …, reason: "repo-explorer task
  undo" }` → `commit c_rfp6e14`, `summary ["uncheck task b_7sk8zb8 in
  /processes/calcination.md"]`; the block's hash was `486941ab0289…` again —
  byte-identical to the original — and the file line `- [ ] Repeat with
  copper…`; the log moved the record to the redo stack (done 0, undone 1).
- **redo** (expecting `hashBefore`) → `c_r9xbcy4`, `[x]` again. Then an
  **outside edit** of the same block (`apply { set markdown "- [x] Repeat with
  copper … (done 2026-10-23)" }`, `c_q5gpfv9`) and an **undo attempt**: the
  current hash `c9174f8ae369…` ≠ `hashAfter 1eb8129bae27…` → refused, no
  write: *cannot undo: block b_7sk8zb8 in /processes/calcination.md changed
  since the toggle (expected hash 1eb8129bae27…, now c9174f8ae369…) — not
  overwriting someone else's edit*. The block was then restored to its
  original markdown (`c_ymppqf1`; hash `== original: true`, the file line
  back to `- [ ] Repeat with copper and record the colour sequence`).

So: one `apply` per toggle, the file changes, the re-read carries the new hash,
a toggle against a stale hash is refused by the engine, undo restores the
exact bytes, and an undo after someone else's edit is refused by the page
before anything is sent.
