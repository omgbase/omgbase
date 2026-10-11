# live-tail — the change feed, as it happens

A small Lit demo of omgbase's **change feed**. It connects to an omgbase MCP
server, shows the most recently updated documents with the unified diff of each
one's latest change, and then polls `changes_since` with a cursor, prepending
every commit as it lands — timestamp, origin/actor, the server's one-line
summary, and for each revision the document's path and its unified diff.

Edit a file in the repository (or change it through the MCP tools or the `omg`
CLI) while the page is open and the commit appears at the top within the poll
interval, open, with the diff of what changed.

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
`paused`, or the connection state; errors show in a banner above the feed.

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

- `src/app.ts` — the one element (`<live-tail-app>`, Lit 3 + `@lit-labs/signals`,
  Shoelace `<sl-details>` for the collapsible diffs): connect, the recent view,
  the poll loop, pause/resume, rendering.
- `src/lib/feed.ts` — the pure parts: `startCursor`/`advanceCursor`,
  `entryFromDigest`/`prependDigests`/`byline`, `latestPair`/`pairForCommit`,
  `RECENT_QUERY`/`recentFromHits`, `diffLineKind`/`diffStats`/`formatTime`/`pollMs`.
- `src/lib/paths.ts` — `surfaceOf`, `hitId`, `hitPath`, `rooted`.
- `src/lib/mcp-client.ts` — `OmgClient` (the tool calls, the JSON-text envelope,
  session recovery), `fetchWhoAmI`.
- `scripts/dev.mjs`, `scripts/dev-args.mjs`, `scripts/dev-workspace.mjs` —
  the proxy + Vite dev script and the sample workspace.
- `test/` — vitest over the pure parts, the dev arguments and the client's
  session recovery (a fake transport; 23 tests).

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
