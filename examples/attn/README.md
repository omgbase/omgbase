# attn — what has your attention right now?

attn is a hyper-low-friction attention app built around one question. You
declare an **Intent** — "Calcine the salt", "Talk with Natalie", "Enjoy
lunch" — and may put it in **Focus**. An intent is not a task: it may never be
done, it is simply what has your attention, and exactly one is in focus at a
time (or none). **Focus is a position; the intent is the declaration**:
switching focus never edits the intents, it rewrites one pointer document.
`interrupt` switches but remembers the displaced intent on a return stack;
`back` resumes it. A **Cue** is something to come back to mind under relevant
circumstances — one entry of its intent's `cues` list, a condition and nothing
more ("when a work of the Opus is focused, the dew should come to mind") — and
a cue never steals focus; it lifts its intent into the feed's **Cued** section.

This is a prototype of attn built **directly on an omgbase repository** rather
than its own database, to test the hypothesis that the whole thing is
documents: intents are Markdown files with frontmatter that own their cue
definitions, the current focus is one pointer document, the history is the
pointer's own revisions, and "what should resurface" is a computed view. It is
a Lit page over `omg mcp --tools minimal` (ten tools), after
[`repo-explorer`](../repo-explorer/README.md)'s conventions; everything under
`/attn/` of an ordinary workspace, so it could later sit inside a notes
repository without a second store. The model follows the design note's revised
layout (embedded cues, a dated intent path, a pointer that is the only thing a
switch writes).

## The storage model

Two kinds of document, both Markdown with frontmatter (a plain `.yaml` file
projects its top-level mapping as properties since properties 1.2, but the
`set _frontmatter.<key>` effects every switch is made of are Markdown-only —
on a `.yaml` document they are refused with `type_mismatch`, so the pointer
stays a `.md`):

```yaml
# /attn/focus.md — the Focus pointer: one document, rewritten by every switch
---
type: /terms/types/attn-state.md
layer: draft
focused_intent: /attn/intents/2026/10/2026-10-12-calcine-the-salt.md   # or null
since: "2026-10-13T15:02:00.000Z"
return_stack:                                  # what interrupt displaced, top last (an extra field;
  - /attn/intents/2026/10/2026-10-09-distil-the-dew.md                  #  suspend/defer are left open by the note)
---
# Current focus
This document records attn's current focus, shared across every client: … Switching focus
updates this pointer, never the intent; …

# /attn/intents/YYYY/MM/YYYY-MM-DD-<short-name>.md — one Intent, named for the day it was declared
---
type: /terms/types/intent.md
layer: draft
status: active            # active (retained, available for attention — NOT "in focus") | released
title: Distil the May dew
tags: [aqua, laboratory]
project: /projects/magnum-opus.md             # optional
cues:                                         # optional — the intent's cues, value objects, not documents
  - id: when-the-opus-is-focused              # intent-local, stable
    on: focus
    query: |
      from docs
      where project == "/projects/magnum-opus.md" and status == "active"
  - id: review-tomorrow
    on: time
    at: "2026-10-15T09:00:00Z"
  - id: new-rest-intents
    on: query-enter
    query: |
      from docs
      where type == "/terms/types/intent.md" and "rest" in tags
---
# Distil the May dew
Twelve flasks gathered from the linen sheets at dawn. …
```

Editing never renames an intent (the date is the declaration date). There is
no `/attn/cues/` and no stream log: **a cue is one entry of its intent's `cues`
list**, and **the history is the pointer's revisions** (below).

### Cues — the `on` variants and their semantics

| `on` | definition | matches when |
| --- | --- | --- |
| `focus` | `query` — a whole OQX query over `docs` | the **newly focused intent is a member of the query's result set**: the query is run as authored (every page) and the focused intent's path (or id) is looked for among the hits |
| `time` | `at` — an ISO timestamp | `at` ≤ now, by the client clock (OQX has no `now()`); checked on open and every 30 s |
| `query-enter` | `query` | ids **entering** the query's membership set since the last checkpoint |
| `query-exit` | `query` | ids **leaving** it |

The checkpoint of an enter/exit cue is keyed by intent path + cue id and kept
in `localStorage`; the first evaluation baselines silently (nothing fires). A
matching cue makes its intent eligible for the **Cued** section with a one-line
"why now" (the cue id and kind); it never changes focus and never writes
anything. A firing is deduplicated per (intent, cue id, focus episode) for
focus cues, per `at` for time cues, per entering/leaving id for enter/exit
cues; snooze is quiet until the next focus boundary. All of that is app-local
(`Delivery` in `src/lib/cues.ts`) — a released intent's cues do not fire.

### Writes — every mutation one `apply`, atomic

**Switching focus writes `/attn/focus.md` only.** A switch, with the pointer
as last read at `r_35bctb5`:

```json
[
  { "op": "set", "target": "/attn/focus.md", "field": "_frontmatter.focused_intent", "value": "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md", "expect": { "revision": "r_35bctb5" } },
  { "op": "set", "target": "/attn/focus.md", "field": "_frontmatter.since", "value": "2026-10-13T16:10:00.000Z" }
]
```

(Names follow surface 5.0's rule, "underscore = engine": the field is
`_frontmatter.<key>` — the handle is the engine's, the key under it attn's own
— a bare rooted path is the document target, and `expect.revision` is a role.)
`interrupt` adds `{ "op": "set", "target": "/attn/focus.md", "field": "_frontmatter.return_stack", "value": [...stack, displaced] }`;
`back` sets `focused_intent` to the top of the stack and pops it; `stop` sets
`focused_intent: null` (the stack is kept). When the workspace never focused
anything the pointer's `set`s become one `create` of `/attn/focus.md`. **Add
Intent** (Enter) is one `create` and nothing else — the pointer is not
touched; **add + focus** (⌘/⌃Enter, or Shift+Enter as an interrupt) is the
create plus the pointer, one request:

```json
[
  { "op": "create", "path": "/attn/intents/2026/10/2026-10-14-talk-with-natalie.md", "markdown": "# Talk with Natalie\n", "frontmatter": { "type": "/terms/types/intent.md", "layer": "draft", "status": "active", "title": "Talk with Natalie", "tags": ["people"] } },
  { "op": "set", "target": "/attn/focus.md", "field": "_frontmatter.focused_intent", "value": "/attn/intents/2026/10/2026-10-14-talk-with-natalie.md", "expect": { "revision": "r_35bctb5" } },
  { "op": "set", "target": "/attn/focus.md", "field": "_frontmatter.since", "value": "2026-10-14T08:00:00.000Z" }
]
```

**Define a cue** is `set _frontmatter.cues` with the intent's **whole list**
(every query given a trailing newline so the engine composes a `query: |`
block), previewed with `plan { diffs: true }` and committed with `execute`;
removing a cue is the same `set` with the list minus it (`unset
_frontmatter.cues` when none remain):

```json
[{ "op": "set", "target": "/attn/intents/2026/10/2026-10-08-enjoy-lunch.md", "field": "_frontmatter.cues", "value": [
  { "id": "after-the-salt", "on": "focus", "query": "from docs\nwhere \"fire\" in tags\n" },
  { "id": "review-tomorrow", "on": "time", "at": "2026-10-15T09:00:00Z" }
] }]
```

Release / reactivate is `set _frontmatter.status = "released" | "active"`;
editing an intent is `set content` of the whole document (a textarea over its
`_raw`) — the one edit that legitimately moves its `_updated_at`.

**CAS**: the pointer's first `set` carries `expect.revision` = the pointer's
`rev` as last read (`docs_read`), so two devices cannot both switch blindly —
the second is `stale_plan` with the current revision in `data.current` and a
`data.fix` (the same request re-pinned); the page shows the error and the fix
and reloads the pointer rather than taking the fix, because taking it would
silently overwrite the other device's switch.

### The feed

The feed is a list of intent documents, never of cue firings:

- **Cued** — the active intents a cue lifted, each once however many cues
  matched, with its "why now" lines; above everything else.
- **Recent** — the other active intents, **most recently edited first**
  (`order by _updated_at desc`): a genuinely edited intent rises, a newly added
  one lands on top. Focusing an intent does **not** change its `_updated_at`
  (only the pointer is written — `test/intents.test.ts` asserts it).
- The **current focus** is in the bar, never sorted into the feed.
- **Released** intents are hidden behind a toggle, with reactivate.

### The Stream — reconstructed from the pointer's revisions

Nothing is logged on a switch. The sequence of pointer states **is** the
episode history, and the open episode's start is the current `since`:

```
select _rev, _seq, _ts from revisions where _path == "/attn/focus.md" order by _seq
docs_read { _path: "/attn/focus.md", at: <rev> }       — per revision not yet cached → _raw → focused_intent / since / return_stack
```

Each state's `since` is when the switch happened (the client clock at the
switch), the next state's `since` ends the episode, the last runs to the clock;
the kind of a transition is inferred from the stack (grown → `interrupt`,
shrunk → `back`, focus null → `stop`, else `switch`). Revisions are immutable,
so every state is cached by its `rev` and only new revisions are read. This is
**reconstruction, not a stream of transition rows**: a switch made and unmade
between two reads leaves no trace, a revision that changed something else is
skipped, and precise time tracking would record transitions separately — the
design note's position, left for later.

## Works on the minimal profile

`pnpm dev` serves `omg mcp --tools minimal` by default (`query`,
`query_syntax`, `docs_read`, `docs_tree`, `blocks_resolve`, `changes_since`,
`plan`, `execute`, `apply`, `version`). Every feature and the exact call:

| feature | tool(s) | call |
| --- | --- | --- |
| connect: the surface gate (≥ 5.0), the profile label | `version`, `tools/list` | `version {}` → `specs.surface`, `profile`; the listing decides whether a repo picker is offered (`repos`, the one tool beyond the ten, only when listed) |
| the focus bar: the pointer (and the CAS token) | `docs_read` | `{ _path: "/attn/focus.md" }` → `properties.frontmatter.focused_intent / since / return_stack`, `rev`, `_id`; `doc_missing` = never focused anything |
| the feed: every intent with its cues, most recently edited first, the **virtual `#focus`** | `query` | `select _path, title, status, tags, project, _updated_at, cues, focus: ^docs first { select since where _path == "/attn/focus.md" and focused_intent == ^_path } from docs where type == "/terms/types/intent.md" and _path.startsWith("/attn/intents/") order by _updated_at desc` — `focus` is `{ since }` on the focused row, null on every other; no intent is ever tagged. `_path` / `_updated_at` are the engine's names; `title`, `tags`, `status`, `project`, `cues`, `focused_intent` are attn's frontmatter keys (bare — an intent always carries an authored `title`, so the bare key is the one meant, not the computed `_title`) |
| the one intent in focus (the where-form of the same join) | `query` | `select _path, title, status, tags from docs where type == "/terms/types/intent.md" and status == "active" and ^docs exists { where _path == "/attn/focus.md" and focused_intent == ^_path }` |
| an `on: focus` cue, on every focus change | `query` (one per cue) | the cue's `query` **as authored**, every page; matched when the focused intent's `_path` (or `_id`) is among the hits; a query that does not parse is the engine's `filter_invalid` (`data.hint: "OQX"`), shown under the feed per cue, never a crash |
| an `on: time` cue | — | `at` ≤ the client clock, on open and every 30 s |
| an `on: query-enter` / `query-exit` cue, after each poll | `query` | the cue's `query` as authored, every page (`limit: 500`, the cursor followed); the hit ids diffed against the checkpoint in `localStorage`; ids entering (or leaving) fire the cue, the first run only takes the checkpoint |
| the Stream: the pointer's history | `query`, `docs_read` | `select _rev, _seq, _ts from revisions where _path == "/attn/focus.md" order by _seq`, then `{ _path: "/attn/focus.md", at: "<rev>" }` per revision not cached → `_raw`; episodes, durations and `#tag` totals computed in the browser; the day picker over the days the history covers |
| switch / interrupt / back / stop / add / add + focus | `apply` | the effect lists above, `reason: "attn switch"` etc.; the Receipt's `revisions[{ _id, _path, _hash }]`; `stale_plan` → the fix shown, the pointer reloaded |
| release / reactivate / edit / remove a cue | `apply` | one `set _frontmatter.status`, one `set content`, one `set _frontmatter.cues` (the list minus the cue) |
| define a cue | `plan`, `execute` | `plan { effects: [{ op: "set", target: "<intent>", field: "_frontmatter.cues", value: [...] }], diffs: true }` → the summary and the document after; `execute { plan_id, effects }` |
| the intent editor | `docs_read` | `{ _path: "<intent>" }` → `_raw` into the textarea |
| live: other windows and the CLI | `changes_since` | `{ limit: 1 }` once for `head`, then `{ cursor, limit: 50 }` every 3 s; a digest touching `/attn/` reloads everything and re-runs the cue engine |

Not used: `blocks_resolve`, `docs_tree`, `query_syntax` (linked from the cue
editor's help), and nothing beyond the ten but `repos`.
`test/minimal-profile.test.ts` runs every data path above against a scripted
server that lists exactly the ten and refuses every other name, and asserts the
tools asked for (`apply`, `changes_since`, `docs_read`, `execute`, `plan`,
`query`).

## Run it

```sh
pnpm install && pnpm build        # at the repository root (the demo spawns the built `omg`)
pnpm --filter attn dev            # copies corpus/ into .dev-workspace/attn, indexes it, seeds the
                                  # pointer's history, starts the MCP proxy with `omg mcp --tools minimal`, starts Vite
```

Open <http://localhost:5176>. The sample is **a week in the life of Mireille
Vautrin, an alchemist** (`corpus/attn/`: `focus.md`, `index.md`, and nine
intents under `intents/2026/10/` — two released — carrying seven cues between
them: two `on: focus` (the dew when any work of the Opus is focused; the letter
when a `rest`-tagged intent is), three `on: time` (two already due, one next
Sunday), one `query-enter` (a new active intent) and one `query-exit` (an Opus
intent released). Because the Stream is reconstructed from the pointer's
revisions, `scripts/dev-workspace.mjs` makes **six focus switches after the
ingest, through the engine** — the app's own effect builders
(`src/lib/writes.ts`, imported directly by the Node script) fed to `omg apply`
exactly as the page feeds `apply`: the dew, lunch as an interrupt, back, the
letter as an interrupt, back, the salt — at three to half an hour before the
build, so the Stream shows a day of episodes on first open. The copy under
`.dev-workspace/attn` is the repo's source, so every switch lands there, not in
the checked-in sample (`pnpm --filter attn dev:workspace --force` resets and
re-seeds it). On open you should see "Distil the May dew" (its focus cue: the
salt is a work of the Opus) and "Tend the garden" (a due time cue) in **Cued**.

```sh
pnpm --filter attn dev --full                               # the same workspace, the whole catalog
pnpm --filter attn dev --remote https://mcp.example.com/omg     # a real server (your notes); the proxy signs in for you
omg -C examples/attn/.dev-workspace query 'select focused_intent, since from docs where _path == "/attn/focus.md"'
omg -C examples/attn/.dev-workspace query 'select _rev, _seq, _ts from revisions where _path == "/attn/focus.md" order by _seq'
```

The proxy is the [`webdevproxy`](../webdevproxy/README.md) workspace package;
the page talks to the same-origin `/mcp`, the proxy to `omg mcp` over stdio (or
a remote gateway). `--tools minimal` is not a proxy flag, so
`scripts/omg-minimal.mjs` is the `omg` it spawns by default (`--full` hands it
the build itself). Port **8791** (graph-ui 8787, live-tail 8788, repo-explorer
8789). Scripts: `dev [--full] [--remote <url>]`, `dev:workspace [--force]`,
`dev:mcp`, `logout`, `build`, `typecheck`, `test`, `lint`.

Keys in the bar: **Enter** adds the text as a new intent — it lands at the top
of the feed, the focus is untouched (`#tags` in the text become `tags`; a text
equal to an active intent's title is noted, not duplicated); **⌘/⌃+Enter**
adds and focuses it; **Shift+Enter** adds and focuses it as an interrupt;
**⌃/⌘R** opens the chooser over the active intents (most recently focused
first; Enter resumes, Shift+Enter interrupts, Tab loads the text for editing,
Esc closes); `back` appears while the return stack is non-empty and names the
target; `stop` clears the focus. In the feed every row offers focus / cue… /
edit / release (a cued row also snooze); each intent's cues are listed under
it with remove.

## What the prototype learned

Concrete friction with omgbase for this kind of app, each met while building
the page against `omg mcp --tools minimal` — refreshed for the revised model
(the first build's items about the stream log and cue documents are moot):

1. **`set _frontmatter.cues` of a list of maps round-trips.** The engine
   composes it as block YAML with the keys in the order given, and a query
   string ending in a newline becomes a `query: |` block scalar — the authored
   multi-line shape survives a `set` (verified on disk). But the whole
   frontmatter is re-composed: a flow list `tags: [fire, laboratory]` comes
   back as a block list, and quoted scalars lose their quotes (the pointer's
   `since: "…"` and a cue's `at: "…"` are written bare; YAML 1.2 reads both
   back as strings, a 1.1 reader reads a timestamp). A set that keeps the
   authored style would be safer for files other tools read too.
2. **A list of maps projects wrapped once.** `select cues` returns
   `[[{…}, {…}]]` where `select tags` returns `["fire", "laboratory"]` —
   the multi-valued projection collects the one list value into a list. The
   app reads both shapes (`cuesOf`); a consistent rule for nested lists would
   remove the guess.
3. **History from `revisions` + `docs_read { at }` costs one round trip per
   revision**: a `query` for the revision list plus a `docs_read` per revision
   (7 revisions → 8 calls on first open; the cache makes later loads 1 + the
   new revisions). `docs_read { at }` carries `_raw` and no `properties`, so the
   pointer's frontmatter at a revision is read from the bytes by a small
   grammar (`frontmatterOf`), not by the engine. A `select _raw` over the
   `revisions` target (or `properties` as of a revision) would make the whole
   history one query.
4. **Reconstruction is not a log.** Two switches between two reads collapse to
   one state, a revision that changed another field is skipped, and the kind
   (`interrupt` / `back`) is inferred from the stack — right for this
   prototype, and exactly the note's reason to record transitions separately
   when precise tracking matters.
5. **CAS across a read and a write needs `docs_read`.** The pointer's guard is
   `expect.revision`, and the only way to learn its `rev` is `docs_read` — a
   `docs` query row has no `rev`, and the Receipt returns the new `_hash` but
   not the new `rev`, so every switch is `docs_read` + `apply`. A `_rev` on
   docs rows (and in Receipt `revisions[]`), or `expect.hash`, would let one
   query feed both the feed and the guard.
6. **`stale_plan`'s `fix` is the wrong move for a pointer.** The fix re-pins
   `expect.revision` to the current revision — for a focus pointer that means
   overwriting the switch the other device just made. The page shows the fix
   and does not take it; the useful artefact for a guard failure is the
   *current value* of the contested document, not a retry.
7. **Focus cues are one query per cue per switch**, each run in full as
   authored (every page) only to test one membership. Fine for tens of cues; a
   `query_many` on the minimal profile, or a bound `where … and _path == $focused`
   the client could append without parsing the user's query, would do it in one.
8. **No `now()`** keeps time cues client-side (fine) but means a cue's stored
   OQX cannot be time-relative; bindings on `query` (`{ query, bindings: {
   now } }`) would let a stored query stay a stored query.
9. **An exit cue cannot name what left.** The id that left the membership set
   is no longer a hit, so the "why now" shows a `d_…` id unless the client
   kept the paths in its checkpoint — a small cost moved to the app.
10. **Delivery state is per browser by design**, so two windows each lift a
    cue once; a shared "seen" would cost a document write per firing.
11. **`_updated_at` is the feed's order, and it tells the truth**: focusing is
    a pointer write, so the focused intent did not move (asserted on the real
    stack); defining or removing a cue does move it, as the note accepts. But
    an ingest stamps every document with the same `_updated_at`, so a freshly
    attached corpus orders by title until something is edited.
12. **Three round trips to open** (pointer, feed, revisions) plus one
    `docs_read` per uncached revision. `docs_read_many` is not in the ten, and
    the pointer must be `docs_read` for its `rev` anyway (5).

What worked without comment: a bare path as an effect target, `set` with a
`null` value to clear `focused_intent`, `set` of a list value for
`return_stack`, `unset` to drop an empty `cues`, `create` + pointer `set`s as
one commit, the `revisions` target's `order by _seq`, `changes_since` as the
only sync primitive, and the error envelope's `hint: "OQX"` for a user-typed
cue query so the app can blame the cue, not itself.

13. **Surface 5.0's "underscore = engine" rule suits a frontmatter-heavy app.**
    attn's own keys — `focused_intent`, `since`, `return_stack`, `status`,
    `title`, `tags`, `project`, `cues` — are bare everywhere (a query, a `set`
    field's key, a `create`'s `frontmatter`) and can never collide with an
    engine attribute; what the engine provides reads as what it is (`_path`,
    `_updated_at`, `_rev`, `_raw`). The one thing to watch: a 5.0 server has
    no tolerance for the 4.x spellings (`docs_read { path }` is refused with
    the corrected call in `data.fix`), so the surface gate is exact about the
    major (`REQUIRED_SURFACE = "5.0"`), and `title` in the feed query is
    deliberately the authored key — every intent carries one — where `_title`
    would be the computed title (the H1 when no key is authored).

## Layout

- `src/app.ts` — the page element (`<attn-app>`, Lit 3 + `@lit-labs/signals`): connect, load, the cue engine, the poll loop, the writes.
- `src/elements/` — `focus-bar` (the title, the live elapsed time, the input, the chooser, back/stop), `intent-feed` (Cued / Recent / Released, each intent's cues, the cue editor with `plan` → `execute`, the intent editor over `_raw`), `stream-view` (episodes, `#tag` totals, the day picker).
- `src/lib/model.ts` — the paths under `/attn/`, the type paths, the declaration line (`#tags`), slugs and dated intent paths, the clock, the small frontmatter reader for past revisions.
- `src/lib/pointer.ts` — the Focus pointer (`docs_read`, the CAS token, the episode key).
- `src/lib/intents.ts` — the feed query with the virtual `#focus` and the cues, the feed's sections (the Cued lift), the chooser's ranking, the status / content edits.
- `src/lib/cues.ts` — the cue shape and `cuesOf`, `setCuesEffect`, the four evaluations (membership, time, enter, exit), the app-local `Delivery`.
- `src/lib/writes.ts` — the effect lists (switch / interrupt / back / stop / add / add + focus), `apply`, `plan` → `execute`, the Receipt.
- `src/lib/history.ts` — the pointer's revisions → states → transitions → episodes with durations; the cache.
- `src/lib/feed.ts` — `changes_since` polling; `src/lib/mcp-client.ts`, `tools.ts`, `paths.ts`, `query.ts`, `effect.ts` — after repo-explorer's.
- `scripts/` — `dev.mjs`, `dev-args.mjs`, `dev-workspace.mjs` (the sample workspace + the seeded history), `omg-minimal.mjs` (the `--tools minimal` stand-in).
- `corpus/attn/` — the sample.
- `test/` — vitest over the pure parts and the data paths through a scripted MCP server (`test/scripted.ts`, which refuses anything outside the ten): the exact `apply` payloads for switch / add / add + focus / interrupt / back / stop / define-cue / remove-cue / release / edit, the stale CAS, plan → execute; cues (reading the list, the membership test, time, enter / exit with checkpoints, dedupe and snooze); the stream from a scripted `revisions` + `docs_read { at }` sequence (kinds, episodes, a day's clip, the cache); the feed order and the Cued lift; the `_updated_at`-unchanged assertion; the pointer, the chooser, the client's session recovery, the dev arguments, and `minimal-profile.test.ts` — 62 tests, no live server.

## Verified against the real stack

Over `.dev-workspace` built and seeded by `scripts/dev-workspace.mjs` (the six
switches go through `omg apply`, the pointer's CAS token through `omg --json
show` → `pointerOf`), and `omg mcp -C … --tools minimal` on stdio driven
through the app's own lib modules (a Caller decoding the envelope as
`OmgClient.call` does), **on both engines** — the TypeScript `omg` (0.25.0)
and the Rust `omgbase` (0.26.1), each reporting `surface 5.0`, `profile
minimal`; the two runs were call-for-call identical. `tools/list` was the ten.
The pointer (`docs_read { _path }`) read the salt in focus with the dew on the
stack, `rev` and `_id` in hand; the feed query returned the nine intents with
their `cues` lists, the authored `title` and `tags`, and `focus: { since }` on
exactly the one in focus; the where-form of the join returned that one row.
The cue engine matched "Distil the May dew"'s `on: focus` query (run as
authored, the salt among its hits by `_path`) and not the letter's; the three
`on: time` cues were due by the clock; the enter / exit cues baselined (7
active intents; 3 active works of the Opus). The history read **7 revisions in
8 calls** (one `revisions` query, seven `docs_read { _path, at }` → `_raw`),
with switch / interrupt / back inferred from the stack. Adding "Sweep the
laboratory floor #household #rest" was one `create` (Receipt `revisions[{ _id,
_path, _hash }]`, `new_ids.$new.0` the document) that put it at the top of the
feed and made the enter cue fire for it; switching to it wrote `/attn/focus.md`
only (one revision in the Receipt, `set _frontmatter.focused_intent` / `since`
in the summary), made "when-resting" match and "when-the-opus-is-focused" not,
and **every other intent's `_updated_at` was unchanged**. `interrupt` to the
letter pushed the stack to two, `back` popped it; a switch carrying the stale
`rev` was `stale_plan` with `data.current.revision` and the re-pinned `fix`;
`stop` set `focused_intent: null` and kept the stack. A focus cue and a
deliberately broken enter cue were added to "Enjoy lunch" through `plan {
diffs: true }` (the preview showed the `cues:` block with the `query: |`
scalars; `preview.revisions[{ _id, _path, _hash }]`) → `execute { plan_id,
effects }`; the list read back intact, the new focus cue matched the salt, the
broken one was `filter_invalid (OQX)` for that cue alone, `remove` committed
the list minus it and `unset _frontmatter.cues` cleared the last. Releasing the
salt made the `query-exit` cue fire (by id — the row had left), reactivate put
it back; `set content` moved the edited intent to the top; add + focus
committed the intent and the pointer in one `apply` (two revisions); the
history reloaded 12 revisions in 6 calls (the cache). A 4.x `docs_read { path
}` was `filter_invalid` with the `_path` spelling in `data.fix` — the gate's
reason. `pnpm dev:mcp` then served the same workspace through webdevproxy
(`/whoami` said local; over `/mcp` `initialize` answered, `tools/list` was the
ten and `docs_read { _path: "/attn/focus.md" }` returned the pointer). The page itself
was not loaded in a browser in that run; the scripted tests cover the
elements' logic.
