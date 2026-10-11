# live-tail — the change feed, as it happens

A small Lit demo of omgbase's **change feed**. It connects to an omgbase MCP
server, shows the most recently updated documents with the unified diff of each
one's latest change, and then polls `changes_since` with a cursor, prepending
every commit as it lands — timestamp, origin/actor, the server's one-line
summary, and for each revision the document's path and its unified diff.

Edit a file in the repository (or change it through the MCP tools or the `omg`
CLI) while the page is open and the commit appears at the top within the poll
interval, open, with the diff of what changed.

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
`overflow-wrap: anywhere`), **pause/resume**, and the **filter** field below
the header (Enter, leaving the field, a 600 ms pause in typing, or the clear
button apply it).

## What it does

The data path is MCP only — `@modelcontextprotocol/sdk`'s client over the
Streamable HTTP transport at the same-origin `/mcp` (Vite proxies it to the
dev proxy); nothing imports `@omgbase/core`. On load:

1. `GET /whoami` — the proxy's mode and sign-in state (header label; the
   sign-in wait).
2. `version` → the surface version for the header (a server without the tool
   is 1.x); `repos` → the repository picker (the choice is persisted).
3. **Recently updated** — `select $path, $title, $updated_at from docs order by
   $updated_at desc limit 25`; for each hit `docs_history { doc }` gives the
   version list and the last two versions are diffed with `diff_unified
   { doc, from_rev, to_rev }`; a document with one version is **created** and
   `docs_read_at { doc, rev }` shows its content. Four documents at a time; the
   first three cards start open, the rest open on click.
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

**pause** stops the polling (the cursor is kept); **resume** polls at once, so
everything committed meanwhile arrives in one page. The pill says `live · N s`,
`paused`, `filter invalid — showing everything`, or the connection state;
errors show in a banner above the feed.

### The filter

The field is the recent query as one CodeMirror 6 editor with OQX highlighting
(`@omgbase/oqx-syntax`). Idle with no filter it is the plain two-line query,
dimmed:

```
select $path, $title, $updated_at from docs
order by $updated_at desc limit 25
```

Click into it (anywhere) and a `where ` line opens between the two with the
caret right after the keyword, in the hole:

```
select $path, $title, $updated_at from docs
where ⟨hole⟩
order by $updated_at desc limit 25
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
- **The feed**: for every poll that brings digests, ONE query asks which of
  their documents the filter admits — `select $path from docs where
  (<filter>) and ($path == "/a.md" or $path == "/b.md" …)` (`matchQuery`;
  OQX has no array literal, so the path equalities are or-ed, each
  JSON-quoted; hits read through `hitPath` under either envelope). Revisions
  of admitted documents stay, the rest are dropped (`partitionByFilter`); a
  digest left without revisions — including one that had none, a deletion or a
  move, whose documents are no longer in `docs` to be evaluated — is not shown
  but counted: a muted `3 changes hidden by the filter` under the feed heading.
  The count resets when the filter changes.
- Changing the filter keeps the feed's cursor — the filter is a view over what
  arrives, not a position in the log — and leaves the entries already on
  screen as they are: it applies to the recent list and to what arrives from
  now on.

**Both hit shapes.** The server may be surface 2.x (`{ id, path, … }` hits) or
3.0 (`{ $id, $path, … }`); `lib/paths.ts` reads a hit's identity through
`hitId`/`hitPath`, which accept both, and every path is shown `/`-rooted.
Tool envelopes (`docs_history`, `diff_unified`, `changes_since`) are the same
under both.

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
- `src/lib/feed.ts` — the pure parts: `startCursor`/`advanceCursor`,
  `entryFromDigest`/`prependDigests`/`byline`, `latestPair`/`pairForCommit`,
  `recentQuery`/`frameFor`/`recentFromHits`, the filter's
  `matchQuery`/`digestPaths`/`partitionByFilter`/`filterStateAfter`/`hiddenLine`,
  `diffLineKind`/`diffStats`/`formatTime`/`pollMs`.
- `src/lib/hole.ts` — the hole as CodeMirror state (`holeField`, `holeOnly`,
  `mapHole`, `changesInside`, `insertsNewline`, `reframe`/`reframeSpec`,
  `holeText`, `holeState`); only `@codemirror/state`, so it is tested with
  plain `EditorState`s.
- `src/lib/paths.ts` — `surfaceOf`, `hitId`, `hitPath`, `rooted`.
- `src/lib/mcp-client.ts` — `OmgClient` (the tool calls, the JSON-text envelope,
  session recovery), `fetchWhoAmI`.
- `scripts/dev.mjs`, `scripts/dev-args.mjs`, `scripts/dev-workspace.mjs` —
  the proxy + Vite dev script and the sample workspace.
- `test/` — vitest over the pure parts, the hole's transaction filter, the dev
  arguments and the client's session recovery (a fake transport; 40 tests).

## Verified headlessly

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
$updated_at desc limit 25` — two lines, no `where`; focusing it opened the
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
