# live-tail — the change feed, as it happens

A small Lit demo of omgbase's **change feed**. It connects to an omgbase MCP
server, shows the most recently updated documents with the unified diff of each
one's latest change, and then polls `changes_since` with a cursor, prepending
every commit as it lands — timestamp, origin/actor, the server's one-line
summary, and for each revision the document's title, its `/`-rooted path and its unified diff.

Edit a file in the repository (or change it through the MCP tools or the `omg`
CLI) while the page is open and the commit appears at the top within the poll
interval, open, with the diff of what changed.

A **markdown** switch turns every diff from the plain unified text into
rendered Markdown — real bullets, headings, tables and code blocks — with the
removed elements on red and the added ones on green, and the construct a hunk
starts inside of (a fence, a nested list, a table) kept whole, because the
view renders the two revisions' full text rather than the excerpt (see "The
markdown view").

An **OQX filter** at the top narrows both: the field shows the recent query
itself with its `where` predicate as the one editable hole, so `status ==
"active"` there limits the recent list to the active documents and, from then
on, the feed to changes of documents the predicate admits.

## Run it

```sh
pnpm install && pnpm build          # at the repository root (the demo spawns the built `omg`)
pnpm --filter live-tail dev         # copies ./sample into .dev-workspace/sample and indexes it, starts the MCP proxy, starts Vite
```

Open <http://localhost:5174>. Then, in another terminal:

```sh
omg -C examples/live-tail/.dev-workspace meta notes/alpha.md --set status=done
```

and watch the commit arrive (or edit `.dev-workspace/sample/notes/alpha.md` in
an editor — the workspace's filesystem source picks it up).

Against a remote omgbase instead:

```sh
pnpm --filter live-tail dev --remote https://mcp.example.com/omg
```

The proxy (the [`webdevproxy`](../webdevproxy/README.md) workspace package)
signs in for you — the page says *waiting for sign-in in your browser* while
it polls `GET /whoami` — and the header reads `via local proxy → <host> ·
<identity>`. `WEBDEVPROXY_REMOTE=<url>` is the same as `--remote`;
`--no-browser`, `--token-file`, `--port` (default 8788, one above graph-ui's so
both demos can run), `--path`, `--idle` and `--origin` are the proxy's flags
(consumed by `scripts/dev-args.mjs`; anything else goes to Vite);
`pnpm --filter live-tail logout` forgets the tokens.

Scripts: `dev [--remote <url>]`, `dev:workspace [--force]` (just the
workspace), `dev:mcp` (just the proxy, = `dev --proxy-only`), `logout`,
`build`, `typecheck`, `test`, `lint`.

Controls (all persisted in `localStorage`): the **repo** picker, **every N s**
(the poll interval), **wrap** (word-wrap in every diff view — off is
`white-space: pre` with a horizontal scroll, on is `pre-wrap` +
`overflow-wrap: anywhere`; in the markdown view it applies to the code
blocks), **markdown** (the diff view: off — the default — is the plain unified
text, on is rendered Markdown; `omgbase-live-tail.view` = `text` | `markdown`),
**pause/resume**, and the **filter** field below the header (Enter, leaving the
field, a 600 ms pause in typing, or the clear button apply it).

## What it does

The data path is MCP only — `@modelcontextprotocol/sdk`'s client over the
Streamable HTTP transport at the same-origin `/mcp` (Vite proxies it to the
dev proxy); nothing imports `@omgbase/core`. On load:

1. `GET /whoami` — the proxy's mode and sign-in state (header label; the
   sign-in wait).
2. `version` → the surface version for the header (a server without the tool
   is 1.x); `repos` → the repository picker (the choice is persisted).
3. **Recently updated** — `select path, title, updated_at from docs order by
   updated_at desc limit 25` (the attributes spelled for the server: bare on
   3.0, `$path`/`$title`/`$updated_at` on 2.x — `lib/paths.ts` `attr`); for
   each hit `docs_history { id | path }` gives
   the version list and the last two versions are diffed with `diff_unified
   { doc_id | doc_path, from_rev, to_rev }`; a document with one version is
   **created** and `docs_read_at { id | path, rev }` gives its content (the
   argument names are 3.0's — `spec/surface` §4 "Arguments"; a 2.x server gets
   `doc`, `lib/paths.ts` `docLocator`/`docForeign`), shown as a pure-addition
   diff (`createdDiff`: one `@@ -0,0 +1,N @@` hunk, every line `+`, so
   frontmatter fences and dash bullets are green, not subtractions; `+N −0`).
   Four documents at a time; the first three cards start open, the rest open
   on click.
4. **The feed** — one `changes_since { repo, limit: 1 }` for the repo's `head`,
   which is the starting cursor (what happened before the page opened is the
   recent view's business). Then every N seconds (default 2, editable,
   persisted) `changes_since { repo, cursor }`; the page's `cursor` becomes
   the next cursor (a cursor beyond `head` is another repo's: the feed restarts
   from `head` and says so), `truncated` pages are followed immediately, and
   the digests are prepended newest-first, deduped by commit. A digest's
   revisions are diffed the same way as the recent cards, but against **that
   commit's** revision (`pairForCommit`: the version whose `commit` matches,
   against its predecessor); a digest with no revisions (a deletion, a move)
   shows its summary alone. New entries arrive open, so their diffs are fetched
   at once; anything collapsed is fetched when shown.

### The cards

Both kinds — a recent document, a feed entry — are one card (`recentCard` /
`entryCard` → `Card`, rendered by one `renderCard`): an `<sl-details>` whose
summary bar *is* the header, carrying every value exactly once and no filler
words (no "latest change", no "created" badge, no digest summary line):

```
09:05:07  Alpha  /notes/alpha.md   seq 6 · c_761p702   api   +1 −0
```

— the update's time (a recent document's `updated_at`, a digest's `ts`;
`HH:MM:SS` today, else `YYYY-MM-DD HH:MM`), `title` prominent, `path`
secondary (the path alone when the title is null or the same), the change's
`seq` and commit id (a recent card takes them, with the actor, from
`docs_history`'s latest version, fetched anyway for the diff pair), who made
it (`origin · actor`, or one of them when the actor already carries the
origin), and the lines `+N −M` (`+N −0` for a created document, whose hunk
header says the rest). The server's digest `summary` (`api(?): /notes/alpha.md
— 2 inserted`) restates origin, path and a count and is not shown — except for
a digest **without revisions** (a deletion, a move), where it is the only
statement of what happened and becomes the card's note. A digest touching
several documents keeps the digest's values and the **total** `+N −M` in the
header and gives each document a slim row (title/path and its own stats) above
its diff. `cardFields(card)` lists everything a card shows, flat, and a test
asserts no value appears twice. The chevron alone signals that a card opens.

**pause** stops the polling (the cursor is kept); **resume** polls at once, so
everything committed meanwhile arrives in one page. The pill says `live · N s`,
`paused`, `filter invalid — showing everything`, or the connection state;
errors show in a banner above the feed.

### The markdown view

With **markdown** on, each card's body is a `<unified-markdown-diff>`
(`src/elements/unified-markdown-diff.ts`) instead of the `<pre>`: the diff
rendered as Markdown, removed elements on red, added on green, context neutral.
Both card kinds go through the one `renderBody`, so the recent documents and
the feed entries switch together; the switch is persisted
(`diffViewOf`/`loadDiffView`/`saveDiffView` in `lib/feed.ts`).

The problem the element solves: a hunk is an excerpt and may start in the
middle of a construct — inside a fenced code block (its lines would render as
prose), at a nested list item (the indentation context is gone), at a table
row (a row without the header and alignment rows is not a table). Rendering
the hunk's lines as Markdown would break all three. So the element does not
render the excerpt. When the markdown view is on, the page fetches both
revisions' full text — `docs_read_at { id | path, rev }` for `diff_unified`'s
`from` and `to` (a created document already has its content: the before side
is empty) — and `lib/markdown-diff.ts` renders the **documents**, using the
hunks only to decide what to show and how to colour it:

1. `parseUnified` reads the hunks; `alignRows` lays the two texts side by side
   as one sequence of rows — every line of either revision, `ctx` / `del` /
   `add`, with its old and/or new line number and the hunk it came from. Lines
   are counted the way `diff_unified` counts them (`raw.split("\n")`, so a
   trailing newline is an empty last line; `createdDiff`'s count without it is
   accepted too); texts that do not match the diff fall back to the excerpt.
2. markdown-it parses each revision; its block tokens carry `map` (source line
   ranges), from which `blockTree` builds containers (lists, items,
   blockquotes) with children and leaves (paragraphs, headings, fences,
   tables, a YAML `frontmatter` block of its own — a small block rule, so
   `---` + `title: …` is not a thematic break and a setext heading). A block's
   lines give it a span of rows.
3. The two trees are merged level by level. Blocks of the two sides whose row
   spans overlap form one **cluster** — the before and after versions of one
   element — and the rule for a cluster is:
   - **unchanged** (every row `ctx`): rendered once, neutral; a container only
     partly inside the hunk shows just the children the hunk touches;
   - **changed, one container on each side of the same kind** (list ↔ list,
     item ↔ item, blockquote ↔ blockquote): the container keeps its chrome
     (`<ul>`, `<li>`, `<blockquote>`, an `<ol>`'s `start` adjusted for elided
     items) and the rule recurses into the children — so in a list only the
     items that changed are coloured, inside the nesting they live in;
   - **changed, one verbatim block on each side** — a fenced code block, an
     indented code block, the frontmatter — whose fence lines did not change:
     rendered once as that code block (with its language) with the **lines**
     coloured individually, removed red, added green, the rest neutral. Code
     and YAML lines are independent, and `status: active` → `status: done`
     should read as one line, not as two copies of the frontmatter;
   - **changed, one table on each side** whose header and alignment rows did
     not change: rendered once as one table — the header once, the body
     **rows** coloured individually, so a changed cell is its row red then
     green, and an added or removed row is one coloured row. A table always
     comes with its header and alignment rows, never as a bare row;
   - **any other change** — a paragraph with one changed word, a heading, an
     item whose own text changed, a fence whose info string changed, a table
     whose header or alignment row changed, a paragraph split in two — is
     rendered **whole, twice**: every before block of the cluster on the
     removed (red) side, then every after block on the added (green) side.
     Nothing inside a rendered element is coloured a line at a time except
     code lines and table rows.
4. Only clusters that touch a hunk's rows are shown — the diff's own three
   lines of context decide the extent — and the rest of the document, and the
   rest of a container's children, is elided with a `⋯` gap marker: **one**
   marker per elision, however many blocks or nesting levels it spans. The
   merge emits a gap per level, so an elided container's tail followed by an
   elided sibling, or the elided leading items of three nested lists, would be
   two or three `⋯` in a row; `coalesceGaps` keeps one per run of consecutive
   gaps — the shallowest, so it sits outside the list chrome — and drops a
   container left with nothing to show. No marker leads the document when its
   first block is shown or trails it when its last block is, and none sits
   between two shown clusters adjacent in the source (two hunks whose context
   meets). The marker itself is one short muted line with two pixels of
   padding and no margins: vertical space in the feed is at a premium.
5. The HTML is markdown-it's own renderer over the original tokens (a
   container's open/close tokens around its rendered children, a leaf's token
   slice), `data-kind="add|del"` on the coloured pieces (`<li data-kind>` for
   items, `<tr data-kind>` for table rows, `<span class="line">` in a code
   block, a wrapping `<div class="piece">` otherwise). Sanitised: `html: false` (raw HTML is escaped), images
   are named (`[image: alt]`) rather than fetched, `javascript:` and friends
   are not links (markdown-it's `validateLink`).

Until both texts are in (or when they do not match the diff) the element
renders the hunks alone and says so in a muted line — the known-broken case,
kept as the fallback. **Why markdown-it**: one small, maintained dependency
(v15, its own types, no transitive surprises) whose block tokens carry source
line ranges natively, whose renderer can be driven over a partial token array
(so a list's chrome can be emitted around substituted children), with GFM
tables built in and `html: false` as a one-line sanitiser; `marked` exposes
only `raw` per token, and the micromark/mdast route is five packages for the
same information.

### The filter

The field is the recent query as one CodeMirror 6 editor with OQX highlighting
(`@omgbase/oqx-syntax`). Idle with no filter it is the plain two-line query,
dimmed:

```
select path, title, updated_at from docs
order by updated_at desc limit 25
```

(against a 2.x server the frame reads `select $path, $title, $updated_at …` —
the element's `surface` property respells it when the connection says). Click
into it (anywhere) and a `where ` line opens between the two with the caret
right after the keyword, in the hole:

```
select path, title, updated_at from docs
where ⟨hole⟩
order by updated_at desc limit 25
```

Lines 1 and 3 and the `where ` are the frame — read-only and dimmed; the hole
is the only text that takes typing (it has a faint background; empty, it shows
`status == "active"` as a placeholder). The `where` line stays while there is
a filter, and while the field is focused with an empty hole (the caret needs
somewhere to be); leaving the field with an empty hole — after clearing it,
say — removes it again. Enter applies, Escape leaves.

The frame is enforced, not just styled: an `EditorState.transactionFilter`
(`lib/hole.ts`) drops any transaction whose changes touch text outside the
hole (`iterChangedRanges` against a `StateField` range that grows and shrinks
with the edits inside it), one that would insert a line break, and any change
at all while there is no `where` line; and it moves a selection that lands in
the frame to the nearest end of the hole, so a click anywhere puts the caret
where typing works. The two frame modes are swapped by one whole-document
transaction carrying a `reframe` StateEffect (`reframeSpec`), from the focus
and blur handlers and when a new value arrives from outside; `frameFor(filter,
{ editing })` is the pure text + hole + mode for all four states.

What is sent is `recentQuery(filter)` (`lib/feed.ts`): the same tokens on one
line, `select … from docs where <filter> order by …`; with an empty hole the
`where` clause is omitted (an empty `where` would not parse), which is also
why the idle frame has no `where` line — in every state the text on screen is
the query sent, modulo line breaks. The brace form `from docs { … }` is not
OQX (the parser rejects `{` after the target), which is why the frame uses
`where`.

- **The recent list** is that query: it re-runs whenever the filter changes.
  This is also how the filter is validated — a `filter_invalid` answer puts
  the server's message under the field in red, keeps the list already on
  screen, and sets the pill to `filter invalid — showing everything`; until
  the filter is fixed nothing is hidden. Fixing it re-runs the list and
  resumes filtering.
- **The feed**: every poll that brings digests runs ONE lookup query over the
  documents they touch — `select path, title from docs where (path ==
  "/a.md" or path == "/b.md" …)` (`matchQuery`, in the server's spelling; OQX
  has no array literal, so the path equalities are or-ed, each JSON-quoted;
  hits read through `hitPath`). Its titles are the cards' titles
  (`titlesByPath`: each change shows the title prominent and the `/`-rooted
  path secondary, like the recent list; a document the lookup does not return
  — deleted, moved away, no title — shows the path alone). With a filter the
  query is prefixed `(<filter>) and`, so the same hits say which documents
  it admits: revisions of those stay, the rest are dropped (`partitionByFilter`); a
  digest left without revisions — including one that had none, a deletion or a
  move, whose documents are no longer in `docs` to be evaluated — is not shown
  but counted: a muted `3 changes hidden by the filter` under the feed heading.
  The count resets when the filter changes.
- Changing the filter keeps the feed's cursor — the filter is a view over what
  arrives, not a position in the log — and leaves the entries already on
  screen as they are: it applies to the recent list and to what arrives from
  now on.

**Both generations.** The server may be surface 2.x (`docs_history`
`docId`/`path`/`ts`/`contentHash`, `changes_since` revisions `{ doc, path,
contentHash }`, `docs_read_at` `content`, `diff_unified` `{ doc, path, … }`,
`docs_list` `{ path, blocks, ts }`; `$path`/`$title`/`$updated_at` in the
language) or 3.0, where every tool spells a row the way the language does and
the language's attributes are bare (`id`/`path`/`updated_at`/`hash`/`raw`
everywhere — `spec/surface` §1.2; `$` belongs to OQX alone). A query hit is
`{ id, path, … }` on both. `lib/paths.ts` reads identity through
`hitId`/`hitPath` and spells the generated queries with `attr`, `lib/shapes.ts`
reads each tool result (`changesOf`, `docVersionsOf`, `unifiedOf`, `readAtOf`)
by the server's `specs.surface` (an unknown version reads as 2.x), and every
path is shown `/`-rooted.

**Session recovery.** The proxy forgets a session after `--idle` seconds
(default 3600) or when it restarts and answers the next POST with `404`
`-32000 unknown session (expired or the proxy restarted) — send initialize
again`; `lib/mcp-client.ts` (`isSessionLost`) opens a fresh session against the
same URL and retries the call once, noting *session expired at the server —
reconnected* in the header; only a second failure is shown.

## Layout

- `src/app.ts` — the page element (`<live-tail-app>`, Lit 3 + `@lit-labs/signals`,
  Shoelace `<sl-details>` for the collapsible diffs, `<sl-switch>` for wrap):
  connect, the recent view, the poll loop and the filter's match query,
  pause/resume, rendering.
- `src/elements/oqx-framed-filter.ts` — `<oqx-framed-filter>`: the CodeMirror 6
  editor with OQX highlighting and the editable hole (events `filter-input`,
  `filter-change`; the setup follows graph-ui's `oqx-query-editor`).
- `src/elements/unified-markdown-diff.ts` — `<unified-markdown-diff>`: the
  markdown view of one diff (properties `diff`, `oldText`, `newText`, `wrap`;
  `before`/`after` would shadow `Element.before()`/`after()`), styles for the
  rendered Markdown and the red/green pieces and lines.
- `src/lib/markdown-diff.ts` — the pure part of that view: `parseUnified`,
  `splitLines`/`dropTrailingEmpty`, `consistent`, `sidesFromHunks`,
  `alignRows`, the markdown-it instance (`markdown()`: frontmatter rule,
  images named not fetched), `blockTree`, `markdownDiff` (the pieces: block /
  container / verbatim / table / gap), `coalesceGaps` (one `⋯` per run of
  consecutive gaps), `renderPieces`/`renderMarkdownDiff`, `describePieces`
  (the flat description the tests assert).
- `src/lib/feed.ts` — the pure parts: `startCursor`/`advanceCursor`,
  `entryFromDigest`/`prependDigests`/`byline`, `latestPair`/`pairForCommit`,
  `recentQuery`/`frameFor`/`recentFromHits`, the poll's lookup
  `matchQuery`/`digestPaths`/`titlesByPath`, the filter's
  `partitionByFilter`/`filterStateAfter`/`hiddenLine`,
  `latestChange`/`recentCard`/`entryCard`/`cardFields`/`sumStats`/`formatStats` (the card),
  `createdDiff`/`diffLineKind`/`diffStats`/`formatTime`/`pollMs`, the diff view's
  persistence `diffViewOf`/`loadDiffView`/`saveDiffView`.
- `src/lib/hole.ts` — the hole as CodeMirror state (`holeField`, `holeOnly`,
  `mapHole`, `changesInside`, `insertsNewline`, `reframe`/`reframeSpec`,
  `holeText`, `holeState`); only `@codemirror/state`, so it is tested with
  plain `EditorState`s.
- `src/lib/paths.ts` — `surfaceOf`, `surfaceMajor`, `hitId`, `hitPath`,
  `attr`/`bareAttributes`, `docLocator`/`docForeign`, `rooted`.
- `src/lib/shapes.ts` — the tool results under both generations, read by the
  server's `specs.surface` into the one shape `feed.ts` keeps: `changesOf`
  (`revisionOf`/`digestOf`), `docVersionsOf` (`versionOf`), `unifiedOf`,
  `readAtOf`, `surface3`.
- `src/lib/mcp-client.ts` — `OmgClient` (the tool calls, the JSON-text envelope,
  session recovery), `fetchWhoAmI`.
- `scripts/dev.mjs`, `scripts/dev-args.mjs`, `scripts/dev-workspace.mjs` —
  the proxy + Vite dev script and the sample workspace.
- `test/` — vitest over the pure parts, the hole's transaction filter, the dev
  arguments, the client's session recovery (a fake transport) and the markdown
  diff (`markdown-diff.test.ts`: the hunk parser and row alignment, both line
  counts, the block tree, hunk → block context for a fence, a nested list, a
  table cell (one table, the row twice), rows added/removed, a table header or
  alignment change (the table twice), a heading, a paragraph, the frontmatter,
  a blockquote, an indented code block and a fence inside a list item, a
  created document, an `<ol>`'s numbering, the excerpt fallback,
  sanitisation, and the gap markers — `coalesceGaps` on a synthetic tree,
  consecutive elided runs above and below a change rendering one `⋯`, none
  at an edge whose block is shown or for a created document, none between
  two shown clusters adjacent in the source and exactly one when blocks are
  skipped between two hunks; the view's persistence in `feed.test.ts`; 89
  tests).

## Verified headlessly

One `⋯` per elision (Chrome `--headless=new` over CDP, proxy 18931, Vite
15931, a temporary workspace, the markdown view on): `alpha.md` rewritten with
`omg update -f` as a document with two intro paragraphs, a list whose `build`
item holds six nested items, three middle paragraphs, a `## Notes` heading, a
quote and a tail paragraph (all green, no marker); then the sixth nested item
and the tail paragraph changed in one commit → the card's visible sequence was
`⋯ text ⋯ text`: ONE marker above the list for the document's head, `gather`,
`build`'s own text and the first two nested items (four nesting levels of
elision; HEAD's renderer gave this edit five markers, four of them in a row),
one between `Middle paragraph A.` and the quote, none after the tail
paragraph (the last block is shown), no `<li class="gap">`, each marker 16 px
tall; then a mid-list item and the first intro paragraph changed → `text ⋯
text ⋯`: none above the shown frontmatter, one for the `## Steps` heading +
`gather` + the list's own leading gap, one trailing. Over all eight card
bodies: 4 markers, 0 adjacent pairs. No console errors (Lit's dev-mode
warning only).

The markdown view (Chrome `--headless=new` over CDP, proxy 18811, Vite 15811,
a temporary workspace): five cards in the plain view by default (`view` not
stored, the switch off); rewriting `alpha.md` with a nested list, a fence and a
table arrived in the feed in 2 s; a real click on the switch's input turned it
on and stored `omgbase-live-tail.view = markdown`; the entry rendered a
`<table>`, a `<pre><code>`, `ul li ul li` and six green pieces with computed
backgrounds `rgb(230, 255, 237)` (add) / `rgb(255, 238, 240)` (del) over a
transparent body, with no "excerpt" note (both revisions were in). Then: one
table **cell** changed → ONE table with the `name status` header once and the
body rows `ctx:alpha active` / `del:beta active` / `add:beta done`, the two
coloured rows with the same backgrounds, no stray `<pre>`; one **fence line**
changed → ONE `language-js` code block with the lines
`ctx:const a = 1;` / `del:const b = 2;` / `add:const b = 22;` coloured
individually; `omg meta notes/alpha.md --set status=done` → ONE yaml block
with `ctx:title: Alpha` / `del:status: active` / `add:status: done` and no
`<hr>`; the recent cards used the view too (alpha's latest change as that yaml
block, the created documents all green). Switch off → the `<pre>`s back and
`view = text`; on again + reload → still on, diffs rendered. No console
errors (Lit's dev-mode warning only).

Surface 3.0 batch 2 (the argument names — `docs_history { id | path }`,
`diff_unified { doc_id | doc_path }`, `docs_read_at { id | path, rev }`, chosen
by the server's version): the same headless run passed against the current
build (proxy 18902, Vite 15902; `surface 3.0`) and against a `surface-2.0` omg
built from its tag into a temporary worktree (proxy 18904, Vite 15904;
`surface 2.0`, the `doc` spelling): five cards; `omg meta notes/alpha.md --set
status=done` arrived at the top in under 1.1 s with `-status: active` /
`+status: done`; the persisted filter `status == "active"` narrowed the
recent list to `/notes/beta.md` and a change to `notes/gamma.md` read `1 change
hidden by the filter`. No console errors on either server.

Earlier runs:

Chrome (`--headless=new`) driven over CDP against the sample workspace on free
ports (proxy 18798, Vite 15184): the page connected (`local · omg mcp -C …
· surface 3.0`, `1 repo`), listed the five sample documents newest-first with
`created` and their content; `omg -C .dev-workspace meta notes/alpha.md --set
status=done` produced a digest at the top within 2 s (`api · seq 6`, summary
`api(?): /notes/alpha.md`, diff `-status: active` / `+status: done`, `+1 −1`);
`omg new notes/epsilon.md -f …` produced a second digest above it (`seq 7`,
`created`, the new file's content); **pause**, a third change, 3.5 s of
nothing, **resume** → the third digest arrived on top. No console errors.

The filter, the same way (proxy 18797, Vite 15183, a fresh sample workspace):
the idle field read `select $path, $title, $updated_at from docs` / `order by
$updated_at desc limit 25` (the attribute spelling of that build; a 3.0 build
reads `select path, title, updated_at …`) — two lines, no `where`; focusing it opened the
`where ` line with the caret at offset 50, right after the keyword, and the
placeholder in the empty hole; blurring with the hole empty went back to two
lines, as did focus + Escape; a real click on the idle frame's `order by` line
opened the `where` line with the caret in the hole and one real keystroke
landed there (`where x`). `status == "active"` typed into the hole + Enter →
the recent list went from the five documents to `/notes/alpha.md`,
`/notes/beta.md`, the filter persisted, and blurring kept the three lines.
Transactions inserting at offset 0, appending ` offset 1`, backspacing into
the frame, replacing the whole document and inserting a newline all left the
text unchanged, while an insertion at the hole's end landed; a caret placed at
offset 2 (line 1) snapped to the hole's start and two real keystrokes landed
there; a real Enter kept three lines and applied. `omg
meta notes/alpha.md --set x=1` + `omg meta notes/gamma.md --set x=1` → one
entry (`api(?): /notes/alpha.md`, `+x: 1`) and `1 change hidden by the filter`.
`status ==` → the field turned red with the server's `unexpected 'by' after
\`where\` — expected follow/order by/limit/offset (at offset 66)`, the pill
`filter invalid — showing everything`, the two cards kept; a gamma change then
arrived unfiltered (2 entries, no hidden line). The clear button → the empty
hole with its placeholder (the field stays focused, three lines), all five
documents back, the pill `live · 2 s`, the hidden count gone; leaving the
field → two lines. **wrap** flipped every diff `<pre>`'s computed
`white-space` `pre` → `pre-wrap` (`overflow-wrap: anywhere`) and back,
persisted as `omgbase-live-tail.wrap`; after a reload the filter and wrap were
still in effect (three lines, idle, the filter in the hole). No console errors.
