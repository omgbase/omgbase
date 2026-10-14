# repo-explorer — browse an omgbase repository, end to end, over ten tools

A Lit demo that lets a person walk a repository the way an agent does: the
tree on the left, a document rendered as Markdown (every block an anchor that
shows its id on hover) with its properties as a table, its backlinks and
outlinks, its history with a client-side diff against any revision, a live
strip of commits as they land, a query console for OQX, and — last — a
frontmatter edit previewed with `plan` and committed with `execute`.

It is built against the **minimal tools profile** — `omg mcp --tools minimal`,
exactly `query`, `query_syntax`, `docs_read`, `docs_tree`, `blocks_resolve`,
`changes_since`, `plan`, `execute`, `apply`, `version` — and `pnpm dev` serves
that profile by default, so the page proves itself against it. Everything it
shows comes from those ten (the table under [Works on the minimal
profile](#works-on-the-minimal-profile) names the tool behind each feature);
`tools/list` is read on connect and the one tool beyond the ten the page ever
uses is `repos`, for a repository picker when a full server lists it.

**Requires omgbase surface ≥ 4.7** (the current `omg`): the `revisions` query
target and `docs_read { at }` arrived there. The page calls `version` on
connect, shows `surface 4.7 · minimal` in the header, and refuses an older
server with *this demo needs omgbase surface ≥ 4.7 … — the server reports 4.6*.

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

Every feature, the tool it calls and the exact OQX it sends. `<path>` is the
open document's `/`-rooted path, `<id>` its `d_…` id (both from `docs_read`),
`<rev>` a revision id from the history list. A `repo` argument is added only
when a repository was picked (which needs `repos`); on the minimal profile
nothing names one and the server's default repository is browsed.

| feature | tool(s) | call |
| --- | --- | --- |
| connect: the surface gate, the profile label | `version`, `tools/list` | `version {}` → `specs.surface` (≥ 4.7), `profile`; the listing decides whether a picker is offered |
| repository tree (left pane) | `docs_tree` | `{ depth: 1 }` for the root, `{ path: "/processes/", depth: 1 }` per folder as it opens, `{ …, cursor }` while a level is truncated; `dir` rows carry `docs` for the badge, `total` the header's counts |
| document view | `docs_read` | `{ path \| id, include_ids: true }` → `raw` (rendered as Markdown by markdown-it, or shown raw), `properties.frontmatter / inline / computed` (the property table), `ids` + `parents` + `hashes` (the block anchors, below) |
| backlinks | `query` | `select path, block_id, provenance, field, anchor from links where dst_path == "<path>"` |
| outlinks | `query` | `select dst_path, dst_id, dst_kind, uri, provenance, field, anchor from links where path == "<path>"` |
| wikilinks naming the document | `query` | `select path, block_id, provenance, field, anchor from links where dst_id == "phantom:<stem>"` (`<stem>` = the file name without its extension; see feedback 10) |
| a `[[wikilink]]` clicked | `query` | `select path from docs where path.endsWith("/<name>.md")` |
| query console | `query`, `query_syntax` | the textarea's text with `limit: 50`, then `{ …, cursor }` for "more"; `query_syntax {}` once, for the drawer |
| an `id` cell clicked | `query` | `select path from blocks where id == "b_…"` (nodes/links likewise), `select path, doc_id from revisions where rev == "r_…"` — then the document opens (a `d_…` id needs no query) |
| history (per document) | `query` | `select rev, seq, ts, origin, actor, reason, hash, is_current, doc_id from revisions where doc_id == "<id>" order by seq desc` |
| time travel + diff | `docs_read` | `{ id: "<id>", at: "<rev>" }` → `raw`; the unified diff against the current body is computed in the browser (`src/lib/diff.ts`) |
| deleted documents | `query` | `select rev, seq, ts, origin, actor, reason, hash, is_current, doc_id from revisions where doc == null order by ts desc, seq desc` |
| live feed (the strip) | `changes_since` | `{ limit: 1 }` once for `head`, then `{ cursor, limit: 50 }` every N seconds (default 3) |
| frontmatter edit | `plan`, `execute` | `plan { effects: [{ op: "set", target: "<path>", field: "frontmatter.<k>", value }], diffs: true }` → `preview.summary` + `preview.diffs`; on confirm `execute { plan_id, effects, reason }` (the digest form, the same effects) |

Not used, on either profile: `docs_history`, `docs_diff_unified`,
`docs_read_at`, `docs_list`, `docs_set_meta`, `apply`, `blocks_resolve` — the
same code path runs under `--tools minimal` and `--tools full`.
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

### What the minimal profile made awkward (product feedback)

Things a client has to work around on the ten tools, each found while building
this page against `omg mcp --tools minimal`:

1. **No `repos`.** There is no way to learn which repositories the server
   holds or which one is the default; the page browses "the default repo" and
   can only offer a picker when a full catalog lists `repos`. A `version` that
   named the default repository's slug (it already reports the profile) would
   let a minimal client at least say which repository it is looking at.
2. **A deleted document is listable but not readable.** `from revisions where
   doc == null` lists a deleted document's revisions (history is history), but
   `docs_read { id | path, at }` is `doc_missing` for a document that is not
   live — on every profile (`docs_read_at` has the same locator rule). The
   "deleted documents" pane therefore shows the revision rows and says why the
   body cannot be fetched. Letting `at` reach a tombstoned document's revision
   (the bytes exist in the Merkle tree) would close this.
3. **`order by` disables the cursor.** `from revisions where doc_id == …
   order by seq desc` — the natural history query — returns the top `limit`
   with `truncated: true, cursor: null`; the console's "more" button cannot page
   it, and the history pane caps at 200 revisions (`fetchAllRevisions` pages the
   default order and sorts client-side when more are needed). A keyset cursor
   over the `order by` columns, or at least `offset` paging advertised in the
   footer, would make ordered lists pageable.
4. **Block spans are not in `docs_read`.** `include_ids` gives ids, parents and
   hashes — enough to *verify* an anchor, but the client has to re-parse the
   Markdown and pair trees to *place* one. A `spans` map (block id → byte or
   line range in `raw`) next to `hashes` would make the anchors exact without
   a parser on the client, and would also make the hash verification
   unnecessary.
5. **A quoted paragraph's `raw` is not its source bytes** (the first line loses
   its `> ` marker, continuation lines keep theirs). Harmless for CAS, but
   anyone hashing the source to find a block hits it; worth a line in
   `spec/format`.
6. **No `properties` at a past revision.** `docs_read { at }` returns `raw` only
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
    `/substances/salt.md`: the link row has `dst_path: null`, `dst_kind:
    "document"`, `dst_id: "phantom:salt"`, so `from links where dst_path ==
    "/substances/salt.md"` returns nothing and salt's backlinks read 0 in the
    links tab. The page lists them anyway under "wikilinks naming [[salt]]"
    with `where dst_id == "phantom:salt"` — but that is a client guessing the
    engine's phantom naming. Resolving a bare wikilink to the unique document
    whose file name matches (the Obsidian rule), or at least a `dst_name`
    field, would make wikilink backlinks first-class.

## What it does

The data path is MCP only — `@modelcontextprotocol/sdk`'s client over the
Streamable HTTP transport at the same-origin `/mcp`; nothing imports
`@omgbase/core`. On load:

1. `GET /whoami` — the proxy's mode and sign-in state (header label; the
   sign-in wait).
2. `version` → the surface (refused under 4.7) and the profile for the header;
   `tools/list` → the capabilities (`src/lib/tools.ts`): a banner names any of
   the ten that is missing and the feature it takes away; `repos` → the picker,
   only when listed.
3. `docs_tree {}` → the root level; folders load on first open and remember
   their state; opening a document reveals its folders.
4. The URL hash is the state — `#doc=/processes/calcination.md`,
   `&rev=r_7&tab=history`, `&block=b_12`, `#deleted` — so a document, a
   revision of it, or the deleted list is a link one can reload or share.
5. A document: `docs_read { include_ids: true }`; the body rendered (or raw,
   persisted), the properties as a table, the two `links` queries, the
   `revisions` query; a `[[wikilink]]` resolved by one query, a `/`-rooted or
   relative link opened in place, an external one in a new tab.
6. The strip: `changes_since` from the repo's `head`, polled; new digests are
   prepended (newest first, deduped by commit, capped at 50) and the folders
   they touched are refreshed; a change to the open document reloads it.
7. The console: ⌘/Ctrl+Enter runs; the result's keys are the columns (`id`,
   `path` first), an `id`/`path` cell opens the thing it names, `hints` is the
   yellow bar, an error shows the engine's code, message, `data.hint` and
   `data.fix`; "more" follows the keyset cursor; the footer says why an ordered
   query cannot page; "syntax" opens `query_syntax` in a drawer.
8. A frontmatter edit (when `plan` and `execute` are listed): a key and a value
   (read the YAML way: `true`, `3`, `"text"`, `[a, b]` as JSON, else text) →
   `plan { …, diffs: true }` → the summary and the before/after diff in a
   confirm strip → `execute { plan_id, effects }` → the Receipt's commit and
   summary; `plan_mismatch` / `stale_plan` drop the pending plan and show the
   engine's `fix`.

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
  strip), `links-panel`, `query-console` (textarea, table, hints, errors, the
  syntax drawer), `history-panel` (the revision list, unified diff or side by
  side), `feed-strip`.
- `src/lib/mcp-client.ts` — `OmgClient` (one tool call, the JSON-text envelope,
  session recovery, `unknown tool` → `OmgError("unknown_tool")`), the `Caller`
  interface every feature module takes, `fetchWhoAmI`, `repoArg`.
- `src/lib/tools.ts` — `MINIMAL_TOOLS`, `capabilities`, the missing-tools banner.
- `src/lib/tree.ts` — `docs_tree` shapes, `fetchLevel` (follows the cursor), labels.
- `src/lib/document.ts` — `docs_read` / `docs_read { at }` shapes, `fetchDocument`,
  `fetchDocumentAt`, `propertyRows`, `splitFrontmatter`.
- `src/lib/markdown.ts` — markdown-it (no raw HTML, images named not fetched,
  wikilinks, doc links marked), `mdBlockTree`, `pairBlocks`, `candidateRaws`,
  `verifyAnchors` (sha256 via WebCrypto), `renderBody`, `anchorsSummary`.
- `src/lib/links.ts`, `src/lib/history.ts`, `src/lib/feed.ts`, `src/lib/writes.ts`,
  `src/lib/console.ts`, `src/lib/query.ts` — the queries, shapes and calls per
  feature (the table above), each pure where it can be.
- `src/lib/diff.ts` — Myers' O(ND) line diff with `docs_diff_unified`'s tie rule
  and hunk format, `unifiedDiff`, `diffStats`.
- `src/lib/route.ts` — the hash route; `src/lib/paths.ts` — paths, the hit
  envelope, the ≥ 4.7 gate; `src/lib/effect.ts` — the signals `effect` helper.
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
  the route, the client's session recovery and `unknown tool` mapping, the dev
  arguments and the stand-in — 90 tests, no live server.

## Verified against the real stack

Over a scratch workspace built from the alchemy corpus with
`scripts/dev-workspace.mjs`, webdevproxy started exactly as `pnpm dev` starts
it (the minimal stand-in as `omg`), and the browser-side client over Streamable
HTTP: `tools/list` returned the ten; `version` said `surface 4.7`, `profile
minimal`; the root level listed `/index.md` and six folders (`total` 19 docs,
315 blocks — one document had been deleted through `apply` to populate the
deleted list); `/processes/calcination.md` rendered with 20 of 20 blocks
anchored and verified (315 of 315 over all 19 documents); its backlinks were
the five documents that link to it and its one outlink the dangling
`[[salt]]` (`dst_path: null`, `dst_id: phantom:salt`); `from revisions where
doc_id == …` listed its one revision and `docs_read { at }` of it diffed empty
against the current body; the deleted list showed `/texts/mutus-liber.md` with
its two revisions; `select titel from docs` came back with the `title` hint;
`select target from links` with the `filter_invalid` naming the fields;
`query_syntax` with the reference; `plan` previewed `set frontmatter.verified =
false in /processes/calcination.md` with the file diff; `execute` committed it
(`changes_since` then showed `api(agent:mcp): /processes/calcination.md — 20
edited`); executing the same plan again was `plan_mismatch` with the engine's
`fix`; `repos` was `unknown tool`. The page itself was loaded in headless
Chrome against `pnpm dev` (see the commit message for what rendered).
