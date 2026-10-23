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
the history list. A `repo` argument is added only when a repository was picked
(which needs `repos`); on the minimal profile nothing names one and the
server's default repository is browsed.

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
| an `_id` cell clicked | `query` | `blocks { select _path where _id == "b_…" }` (nodes/links likewise), `revisions { select _path, _doc_id where _rev == "r_…" }` — then the document opens (a `d_…` id needs no query) |
| history (per document) | `query` | `revisions { select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id where _doc_id == "<id>" order by _seq desc }` |
| time travel + diff | `docs_read` | `{ _id: "<id>", at: "<rev>" }` → `_raw`; the unified diff against the current body is computed in the browser (`src/lib/diff.ts`) |
| deleted documents | `query` | `revisions { select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id where _doc == null order by _ts desc, _seq desc }` |
| live feed (the strip) | `changes_since` | `{ limit: 1 }` once for `head`, then `{ cursor, limit: 50 }` every N seconds (default 3); a digest's `revisions` are `[{ _id, _path, _hash }]` |
| frontmatter edit | `plan`, `execute` | `plan { effects: [{ op: "set", target: "<path>", field: "_frontmatter.<k>", value }], diffs: true }` → `preview.summary` + `preview.diffs` (+ `preview.revisions[{ _id, _path, _hash }]`); on confirm `execute { plan_id, effects, reason }` (the digest form, the same effects) → the Receipt's `revisions[{ _id, _path, _hash }]` |

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
   `&rev=r_7&tab=history`, `&block=b_12`, `#deleted` — so a document, a
   revision of it, or the deleted list is a link one can reload or share.
5. A document: `docs_read { include_ids: true }`; the body rendered (or raw,
   persisted), the properties as a table, the two `links` queries, the
   `revisions` query; a `[[wikilink]]` resolved by one query, a `/`-rooted or
   relative link opened in place, an external one in a new tab.
6. The strip: `changes_since` from the repo's `head`, polled; new digests are
   prepended (newest first, deduped by commit, capped at 50) and the folders
   they touched are refreshed; a change to the open document reloads it.
7. The console: ⌘/Ctrl+Enter runs; the result's keys are the columns (`_id`,
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
  the route, the client's session recovery and `unknown tool` mapping, the dev
  arguments and the stand-in — 91 tests, no live server.

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
