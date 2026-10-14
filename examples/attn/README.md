# attn — what has your attention right now?

attn is a hyper-low-friction attention app built around one question. You
declare an **Intent** — "Calcine the salt", "Talk with Natalie", "Enjoy
lunch" — and put it in **Focus**. An intent is not a task: it may never be
done, it is simply what has your attention, and exactly one is in focus at a
time (or none). Switching focus never edits the intents; it moves a pointer and
appends a line to the day's **Stream**, from which the durations fall out.
`interrupt` switches but remembers the displaced intent on a return stack;
`back` resumes it. A **Cue** is something to come back to mind under relevant
circumstances — a trigger plus a payload ("When I'm working on the Opus,
reconsider the athanor heat") — and a cue never steals focus; it is offered.

This is a prototype of attn built **directly on an omgbase repository** rather
than its own database, to test the hypothesis that the whole thing is
documents: intents and cues are Markdown files with frontmatter, the current
focus is one pointer document, the history is append-only, and "what should
resurface" is a computed OQX view. It is a Lit page over `omg mcp --tools
minimal` (ten tools), after [`repo-explorer`](../repo-explorer/README.md)'s
conventions; everything under `/attn/` of an ordinary workspace, so it could
later sit inside a notes repository without a second store.

## The storage model

Everything lives under one folder, all Markdown with frontmatter (a plain
`.yaml` file does not project properties in omgbase today):

```yaml
# /attn/intents/<slug>.md — the declaration; the title is the H1
---
type: intent
status: active          # active (retained, available for attention — NOT "in focus") | released
tags: [fire, laboratory]
project: magnum-opus    # optional
---
# Calcine the salt
Third firing of the sea salt in the athanor. …

# /attn/cues/<slug>.md — the trigger and the payload (the body)
---
type: cue
intent: /attn/intents/calcine-the-salt.md     # the intent the cue belongs to
trigger: focus                                # focus | time | query
status: active                                # active | dismissed
when: 'project == "magnum-opus" and "fire" in tags'   # focus: an OQX predicate over the newly focused intent's row
# at: '2026-10-13T16:00:00Z'                           # time: fires when the client clock passes it
---
# Reconsider the athanor heat
When the fire is lit again: …                 # trigger: query carries its OQX in a ```oqx fence here instead

# /attn/current.md — the Focus pointer: one document, rewritten by every switch
---
type: attn-state
focused: /attn/intents/calcine-the-salt.md    # or null
since: '2026-10-13T15:02:00.000Z'
return_stack:                                 # what interrupt displaced, top last
  - /attn/intents/distil-the-dew.md
---

# /attn/stream/YYYY-MM-DD.md — the Stream: the append-only daily log (UTC days)
---
type: attn-stream
date: '2026-10-13'
---
# 2026-10-13
- 09:30:12Z → /attn/intents/distil-the-dew.md (switch)
- 15:02:00Z → /attn/intents/calcine-the-salt.md (interrupt)
- 17:05:00Z → none (stop)
```

Old stream lines are never rewritten; the Stream is reconstructed from them
(each line's time is the previous episode's end; today's open episode runs to
the clock). v1 has no corrections — a `- correct …` line would be the shape,
and the parser already skips lines it does not know.

**Every mutation is one `apply`** with several effects, so it is atomic. A
focus switch (the pointer exists, today's stream document exists):

```json
[
  { "op": "insert", "into": "/attn/stream/2026-10-13.md", "at": "end", "markdown": "- 16:10:00Z → /attn/intents/enjoy-lunch.md (switch)" },
  { "op": "set", "target": "/attn/current.md", "field": "frontmatter.focused", "value": "/attn/intents/enjoy-lunch.md", "expect": { "revision": "r_35bctb5" } },
  { "op": "set", "target": "/attn/current.md", "field": "frontmatter.since", "value": "2026-10-13T16:10:00.000Z" }
]
```

`interrupt` adds `set frontmatter.return_stack = [...stack, displaced]` and
writes `(interrupt)`; `back` sets `focused` to the top, pops it, `(back)`;
`stop` sets `focused: null`, `(stop)`. When the day has no stream document yet
the first two effects are its `create` and an `insert` into `$new.0`; when the
workspace never focused anything the pointer's `set`s become one `create`.
Declaring a new intent and focusing it is one call too:

```json
[
  { "op": "create", "path": "/attn/stream/2026-10-14.md", "markdown": "# 2026-10-14\n", "frontmatter": { "type": "attn-stream", "date": "2026-10-14" } },
  { "op": "insert", "into": "$new.0", "at": "end", "markdown": "- 08:00:00Z → /attn/intents/talk-with-natalie.md (switch)" },
  { "op": "create", "path": "/attn/intents/talk-with-natalie.md", "markdown": "# Talk with Natalie\n", "frontmatter": { "type": "intent", "status": "active", "tags": ["people"] } },
  { "op": "set", "target": "/attn/current.md", "field": "frontmatter.focused", "value": "/attn/intents/talk-with-natalie.md", "expect": { "revision": "r_35bctb5" } },
  { "op": "set", "target": "/attn/current.md", "field": "frontmatter.since", "value": "2026-10-14T08:00:00.000Z" }
]
```

The stream effects come first so that a created stream day is always `$new.0`
(a created document's blocks take the symbols after it, so the second create's
symbol would otherwise depend on the first's block count). **CAS**: the
pointer's first `set` carries `expect.revision` = the pointer's `rev` as last
read (`docs_read`), so two devices cannot both switch blindly — the second is
`stale_plan` with the current revision in `data.current` and a `data.fix` (the
same request re-pinned); the page shows the error and the fix and reloads the
pointer rather than taking the fix, because taking it would silently overwrite
the other device's switch.

## Works on the minimal profile

`pnpm dev` serves `omg mcp --tools minimal` by default (`query`,
`query_syntax`, `docs_read`, `docs_tree`, `blocks_resolve`, `changes_since`,
`plan`, `execute`, `apply`, `version`). Every feature and the exact call:

| feature | tool(s) | call |
| --- | --- | --- |
| connect: the surface gate (≥ 4.4), the profile label | `version`, `tools/list` | `version {}` → `specs.surface`, `profile`; the listing decides whether a repo picker is offered (`repos`, the one tool beyond the ten, only when listed) |
| the focus bar: the pointer (and the CAS token) | `docs_read` | `{ path: "/attn/current.md" }` → `properties.frontmatter.focused / since / return_stack`, `rev`; `doc_missing` = never focused anything |
| the intents, focused first — the **virtual `#focus`** | `query` | `select path, title, status, tags, project, updated_at, focus: ^docs first { select since where path == "/attn/current.md" and focused == ^path } from docs where type == "intent" and path.startsWith("/attn/intents/")` — `focus` is `{ since }` on the focused row, null on every other; no intent is ever tagged |
| the one intent in focus (the where-form of the same join) | `query` | `select path, title, status, tags from docs where type == "intent" and status == "active" and ^docs exists { where path == "/attn/current.md" and focused == ^path }` |
| the cues | `query` | `select path, title, intent, trigger, status, when, at, raw from docs where type == "cue" and path.startsWith("/attn/cues/")` (the ```oqx fence and the text are read from `raw`) |
| a `trigger: focus` cue, on every focus change | `query` (one per cue) | `docs exists { where path == "<focused>" and (<when>) }` → `exists`; a predicate that does not parse is the engine's `filter_invalid` (`data.hint: "OQX"`), shown under the feed per cue, never a crash |
| a `trigger: time` cue | — | `at` ≤ the client clock, on open and every 30 s (OQX has no `now()`: the client injects the clock) |
| a `trigger: query` cue, after each poll | `query` | the fence as given, every page (`limit: 500`, the cursor followed); the hit ids diffed against a checkpoint in `localStorage`; ids entering fire the cue, the first run only takes the checkpoint |
| the Stream: the days | `docs_tree` | `{ path: "/attn/stream/", depth: 1 }` (+ `cursor` while truncated) → the `doc` entries' dates, newest first |
| the Stream: one day | `docs_read` | `{ path: "/attn/stream/<day>.md" }` → `raw` parsed line by line; episodes, durations and `#tag` totals computed in the browser |
| switch / interrupt / back / stop / declare + focus | `apply` | the effect lists above, `reason: "attn switch"` etc.; `stale_plan` → the fix shown, the pointer reloaded; `path_taken` (another window created the stream day first) → the days reloaded and one retry |
| release / reactivate an intent | `apply` | `{ effects: [{ op: "set", target: "<intent>", field: "frontmatter.status", value: "released" \| "active" }] }` |
| dismiss a cue | `apply` | `{ effects: [{ op: "set", target: "<cue>", field: "frontmatter.status", value: "dismissed" }] }` (snooze is app-local) |
| a new cue (the "when …" picker) | `plan`, `execute` | `plan { effects: [{ op: "create", path: "/attn/cues/<slug>.md", markdown, frontmatter }], diffs: true }` → the summary and the file to be created; `execute { plan_id, effects }` |
| live: other windows and the CLI | `changes_since` | `{ limit: 1 }` once for `head`, then `{ cursor, limit: 50 }` every 3 s; a digest touching `/attn/` reloads everything and re-runs the cue engine |

Not used: `blocks_resolve`, `query_syntax` (linked from the cue editor's help),
and nothing beyond the ten but `repos`. `test/minimal-profile.test.ts` runs
every data path above against a scripted server that lists exactly the ten and
refuses every other name, and asserts the tools asked for.

## Run it

```sh
pnpm install && pnpm build        # at the repository root (the demo spawns the built `omg`)
pnpm --filter attn dev            # copies corpus/ into .dev-workspace/attn, indexes it,
                                  # starts the MCP proxy with `omg mcp --tools minimal`, starts Vite
```

Open <http://localhost:5176>. The sample is **a week in the life of Mireille
Vautrin, an alchemist** (`corpus/attn/`: nine intents — two released — six
cues covering the three triggers, the pointer with one intent on the return
stack, and two days of stream logs). The copy under `.dev-workspace/attn` is
the repo's source, so every switch lands there, not in the checked-in sample
(`pnpm --filter attn dev:workspace --force` resets it). On open you should see
"Take the salt off the fire" fire (its time has passed), and switching to
"Calcine the salt" fires "Reconsider the athanor heat".

```sh
pnpm --filter attn dev --full                               # the same workspace, the whole catalog
pnpm --filter attn dev --remote https://mcp.example.com/omg     # a real server (your notes); the proxy signs in for you
omg -C examples/attn/.dev-workspace query 'select focused, since from docs where path == "/attn/current.md"'
```

The proxy is the [`webdevproxy`](../webdevproxy/README.md) workspace package;
the page talks to the same-origin `/mcp`, the proxy to `omg mcp` over stdio (or
a remote gateway). `--tools minimal` is not a proxy flag, so
`scripts/omg-minimal.mjs` is the `omg` it spawns by default (`--full` hands it
the build itself). Port **8791** (graph-ui 8787, live-tail 8788, repo-explorer
8789). Scripts: `dev [--full] [--remote <url>]`, `dev:workspace [--force]`,
`dev:mcp`, `logout`, `build`, `typecheck`, `test`, `lint`.

Keys in the bar: **Enter** declares the text as a new intent and focuses it
(`#tags` in the text become `tags`; a text equal to an active intent's title
resumes it instead); **Shift+Enter** does the same as an interrupt; **⌃/⌘R**
opens the chooser over the active intents (most recently focused first; Enter
resumes, Shift+Enter interrupts, Tab loads the text for editing, Esc closes);
`back` appears while the return stack is non-empty and names the target;
`stop` clears the focus.

## What the prototype learned

Concrete friction with omgbase for this kind of app, each met while building
the page against `omg mcp --tools minimal`:

1. **Atomic multi-document writes work** — a declare is three documents in one
   `apply`, one commit, and the Receipt's `summary` reads like the intent. But
   **`$new.n` counts a created document's blocks too** (`$new.0` the stream
   day, `$new.1`–`$new.3` its heading and the inserted list item, `$new.4` the
   intent), so the symbol of the second created document depends on how many
   blocks the first parsed into. The app orders its effects so the only
   `$new.n` it addresses is `$new.0`; a request-named symbol (`create { as:
   "stream" }` → `into: "$stream"`) would remove the fragility.
2. **CAS across two documents needs a read the query cannot give.** The
   pointer's guard is `expect.revision`, and the only way to learn the
   pointer's `rev` is `docs_read` — a `docs` query row has no `rev` /
   `current_rev` attribute (the `revisions` target is a second query), so every
   switch is `docs_read` + `apply`, and the Receipt returns the new `hash` but
   not the new `rev`, so the next switch has to re-read again. A `rev` on docs
   rows (and in Receipt `revisions[]`) would let one query feed both the UI and
   the guard, and `expect.hash` would let the hash a Receipt already returns
   serve as the token.
3. **`stale_plan`'s `fix` is the wrong move for a pointer.** The fix re-pins
   `expect.revision` to the current revision — mechanically "retry", but for a
   focus pointer that means overwriting the switch the other device just made.
   The page shows the fix and does not take it. A `fix` is a literal call by
   spec; for a guard failure the useful artefact is the *current value* of the
   contested document (`data.current` has the revision and hash, not the
   frontmatter), so the client can show what changed.
4. **No `now()`** is fine for the client (time cues and the elapsed clock are
   local) but it means a cue's stored OQX cannot be time-relative: "intents not
   focused for three days" needs the client to splice an ISO literal into the
   fence before running it. Bindings on the `query` tool (`{ query, bindings:
   { now } }`) would let a stored query stay a stored query.
5. **YAML files do not project properties**, so the pointer is a Markdown file
   with frontmatter and a one-sentence body. Also: `set frontmatter.since`
   re-composes the frontmatter and writes the ISO string **unquoted**
   (`since: 2026-10-13T16:10:00.000Z`) where the author had quoted it, and a
   `create` with `frontmatter: { date: "2026-10-14" }` writes `date: 2026-10-14`
   likewise; omgbase (YAML 1.2 core) reads both back as strings, but a YAML
   1.1 reader (and many editors) would read a timestamp and a date. A set that keeps the authored quoting
   style — or always quotes strings that look like other scalars — would be
   safer for files other tools read too.
6. **`exists` is not a projection.** The natural spelling of the virtual
   `#focus` — `focus: ^docs exists { … }` — is refused ("projection 'focus'
   must use collect/first/single"); `first { select since where … }` is
   accepted and turned out better (it yields the pointer's `since` for the
   focused row). The message said exactly what to do, which is the point of
   the error design — noted because a boolean projection is a common want.
7. **Appending a line to a list is not quite a line append.** `insert { at:
   "end" }` on a document whose last block is a list adds a new top-level
   list separated by a blank line; CommonMark reads the file as one loose list,
   so the stream renders fine, but the file alternates blank lines after the
   first app-written line. Appending *into* the existing list needs its block
   id (an extra query per switch). A log of one line per event is a common
   shape; an `insert` that joins a trailing list would make it a one-effect
   append.
8. **Cue evaluation is one query per cue.** A `when` predicate is data (in the
   cue document), and OQX cannot evaluate a stored predicate string, so the
   focus engine runs `docs exists { … and (<when>) }` once per active focus
   cue on every switch — fine for tens, a round-trip per cue nonetheless. An
   `eval`-like `where oqx(when)` would be dangerous; a batched `query_many`
   on the minimal profile would do.
9. **Delivery state is per browser by design**, so two windows each fire a
   cue once; a shared "seen" would cost a document write per firing. For
   query cues a server-side "ids that entered since cursor N" (a `changes_since`
   for a query's membership) would move the checkpoint to the engine.
10. **The day boundary is UTC** in the stream (so two devices in two zones
    write one file), which puts a late evening into tomorrow's file for a
    reader in the Americas; the page labels times `Z`. A per-user day start
    would be an app setting, not a storage change.
11. **Five round trips to open** (pointer, intents, cues, stream days, one
    day) on the minimal profile — `docs_read_many` is not in the ten, and the
    pointer must be `docs_read` for its `rev` anyway (see 2). Acceptable; a
    `rev` on query rows would make it three.

What worked without comment: a bare path as an effect target, `set` with a
`null` value to clear `focused`, `set` of a list value for `return_stack`,
`path_taken` on a racing create, `changes_since` as the only sync primitive,
and the engine's error envelope carrying `hint: "OQX"` for a user-typed
predicate so the app can blame the cue, not itself.

## Layout

- `src/app.ts` — the page element (`<attn-app>`, Lit 3 + `@lit-labs/signals`): connect, load, the cue engine, the poll loop, the writes.
- `src/elements/` — `focus-bar` (the title, the live elapsed time, the input, the chooser, back/stop), `cue-feed` (fired cues with focus/snooze/dismiss; predicate errors), `intents-panel` (focused first, release/reactivate, each intent's cues, the cue editor with `plan` → `execute`), `stream-view` (episodes, `#tag` totals, the date picker).
- `src/lib/model.ts` — the paths under `/attn/`, the declaration line (`#tags`), slugs, the UTC clock helpers.
- `src/lib/pointer.ts` — the Focus pointer (`docs_read`, the CAS token, the episode key).
- `src/lib/intents.ts` — the intents query with the virtual `#focus`, the chooser's ranking.
- `src/lib/writes.ts` — the effect lists (switch / interrupt / back / stop / declare / cue), `apply`, `plan` → `execute`, the Receipt.
- `src/lib/stream.ts` — stream lines → transitions → episodes with durations; days via `docs_tree`.
- `src/lib/cues.ts` — the cue shapes, the three evaluations, the app-local `Delivery` (fired once per cue per episode, snooze, checkpoints).
- `src/lib/feed.ts` — `changes_since` polling; `src/lib/mcp-client.ts`, `tools.ts`, `paths.ts`, `query.ts`, `effect.ts` — after repo-explorer's.
- `scripts/` — `dev.mjs`, `dev-args.mjs`, `dev-workspace.mjs` (the sample workspace), `omg-minimal.mjs` (the `--tools minimal` stand-in).
- `corpus/attn/` — the sample.
- `test/` — vitest over the pure parts and the data paths through a scripted MCP server (`test/scripted.ts`, which refuses anything outside the ten): the exact `apply` payloads for switch / interrupt / back / stop / declare (with and without a stream day, with and without a pointer), stream reconstruction and durations (open, day-end, carried), tag parsing and slugs, cue evaluation (the predicate wrapping, a `filter_invalid` per cue, time, the query delta with its checkpoint), the dedupe and snooze, the intents query and chooser, the pointer, the client's session recovery, the dev arguments, and `minimal-profile.test.ts` — 57 tests, no live server.

## Verified against the real stack

Over `.dev-workspace` built from the sample by `scripts/dev-workspace.mjs`,
webdevproxy started exactly as `pnpm dev` starts it (the minimal stand-in as
`omg`), and the app's own `OmgClient` over Streamable HTTP: `tools/list` was
the ten; `version` said `surface 4.7`, `profile minimal`; `repos` was `unknown
tool`; the pointer read `focused: calcine-the-salt`, one intent on the stack;
the intents query returned nine rows with `focus: { since }` on the one in
focus; the cues query the six. Declaring "Sweep the laboratory floor
#household #rest" committed three documents in one `apply` (`create
/attn/stream/2026-10-14.md`, `insert` into it, `create` the intent, the two
pointer `set`s — `new_ids` `$new.0` the stream day, `$new.4` the intent);
"The letter is overdue" (`"rest" in tags`) fired for it and the two Opus cues
did not; the query cue's delta showed the new intent entering. Switching to
"Calcine the salt" fired "Reconsider the athanor heat" and nothing else;
`interrupt` to "Write to Nicolas" pushed the stack to two, `back` popped it
and refocused the salt. A switch carrying a stale `expect.revision` was
`stale_plan` with `data.current.revision` and the re-pinned `fix`. The stream
of the day read back as the transitions in order with the open episode running
to the clock, and `changes_since` listed each commit. In a second pass `stop`
set `focused: null` (the stack kept), a cue with a deliberately broken
predicate was created through `plan { diffs: true }` → `execute` (the preview
showed the file to be written), executing the same plan again was
`path_taken` (a create-only plan fails on its path, as `spec/mutate` §11.7
says), the broken predicate came back as `filter_invalid (OQX)` for that cue
alone while the other cues evaluated, and `dismiss` and `release` committed
their one `set` each. The page itself was not loaded in a browser in that run
(the proxy was driven headless by `OmgClient`); the scripted tests cover the
elements' logic.
