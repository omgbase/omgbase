# graph-ui — an OQX query as a graph

A Lit demo that runs an OQX query against an omgbase repository (over MCP) and
draws the result as a graph — the drawing is the shared `<omg-graph>` element of
[`@omgbase/elements`](../../packages/elements/README.md) (cards, obstacle-aware
curved edges, pins, zoom and pan), this demo supplying the query, the
relationships, the layout and the edge editing around it (see [The
renderer](#the-renderer-omg-graph)). The relationships the query *talks about* are read
off the parsed query by reflection and offered as **candidates**, each with two
roles the user can override:

- **edge** — draw this relationship between the shown documents;
- **layout** — lay the graph out along this relationship (a layered DAG layout,
  so `before`/`after` frontmatter reads as a timeline). No axis → force layout.
  The layout *algorithm* can also be chosen outright — see [Layouts](#layouts).

Two fields that are one sequence read from both ends — `before` and `after` —
are also offered as one combined **pair** candidate, `before/after`, whose edges
all point earlier → later whichever end authored them; it is the default axis
when present, so a repository that writes only `after` still lays out as a
timeline (see [Inverse pairs](#inverse-pairs-beforeafter-is-one-sequence)).

The fields the query *projects* are read off it the same way and offered in a
second panel, **cards**, where each projected field can be **shown** on the
node cards and one of them is the card's **label** — see [Choosing what a card
shows](#choosing-what-a-card-shows).

The graph is also a place to **find, create and connect** documents: a ⌘K
palette (`<omg-palette>`) puts any document on the canvas by path or title, runs
the page's actions and creates documents; a drag from a selected node's ⟶
handle connects it (`<omg-relation-picker>` asks which field, or a body link),
and a selected edge's ✕ severs it. Every write — those and the ⌘-click toggles —
is a command on [`@omgbase/client`](../../packages/client/README.md)'s
`CommandLog`, so ⌘Z / ⇧⌘Z undo and redo them against the repository's current
state — see [Find, create, connect](#find-create-connect).

It is also a probe of the reflection API being built next door: whatever the
UI wanted and could not get from `@omgbase/oqx`'s public `parse` or omgbase's
MCP tools is listed under [Gaps](#gaps-found-in-the-public-api).

**Requires omgbase surface ≥ 3.0** (the current `omg` speaks 5.0): the page
calls the `version` tool on connect, shows the surface in the header (`· surface
5.0`), refuses an older server with *this demo needs omgbase surface ≥ 3.0 — the
server reports 2.0*, and spells the engine names the way the connected server
does — `_path`/`_title`/`_in_links`/`{ _id | _path }` from 5.0 ("underscore =
engine"), the bare `path`/`title`/`in_links`/`{ id | path }` on a 3.x/4.x
server (see [Server version](#server-version)).

## Try it against a remote omgbase

```sh
pnpm install                                                  # at the repository root; no `pnpm build` needed for this path
pnpm --filter graph-ui dev --remote https://mcp.example.com/omg
```

(`WEBDEVPROXY_REMOTE=<mcp-url>` is the same as `--remote`.) Add `--client-id
<id>` (or `WEBDEVPROXY_CLIENT_ID=<id>`) to present one pre-registered public
client instead of registering a new one per run — the fix for an Auth0 tenant
whose application cap is full; the sign-in callback is then exactly
`http://127.0.0.1:8790/callback` (`--callback-port <n>` to change it), and the
application's settings are in the
[webdevproxy README](../webdevproxy/README.md#a-pre-registered-client---client-id). Open
<http://localhost:5173>; the page talks to the bridge either way and the
*MCP settings* mode **follows the bridge**: when `GET /whoami` says `mode:
"remote"` the header reads `via local proxy → <upstream host>` with the
identity the bridge signed in as, and the setting is switched to *via local
proxy* (persisted); a bridge serving the sample switches it back to *local
sample*. Only *direct* is yours to choose and is never overridden.

**First run against a real repository.** The sample's default query walks
`/timeline/kickoff.md`, which your repository does not have, so the page does
not use it there: once connected it probes `/timeline/kickoff.md` with one
`limit 1` query (`lib/starter-query.ts`; the server offers no `repos` tool
under the minimal profile, so the repository is a *designation* — see
[Data access](#data-access) — not something the page lists); any repository that is not the sample gets the
**starter** instead — while the editor still holds a preset (the sample default
or the starter itself), never a query you edited:

```oqx
docs {
  select _path, _title
  order by _updated_at desc
  limit 40
}
```

(every preset is spelled for the connected server: `docs { select path, title …
order by updated_at desc … }` against a 3.x/4.x one). The starter has no `follow`, so the
picker offers the builtin link graph — `_out_links` (links, drawn by default)
and `_in_links` (backlinks), named for the document's link relations the edges
come from (`doc.out_links` / `doc.in_links` under the 4.x names) — and a force
layout; under the editor a second suggestion shows the timeline walk rooted at
the first shown document (`docs { select _path, _title, before, after where
_path == "/…" follow distinct refs(before), _in_links { from _doc where
^_path in list(after) } }`) with a *use this query* button. When any query
matches nothing, the graph area says so instead of drawing an empty canvas:
*the query matched nothing in repo notes*, the first `where` clause as
written, and — when the query compares `_path` with a
literal that is not in the repository (each literal is probed with the same
`limit 1` query) — `/timeline/kickoff.md is not in repo notes`, with a *show
recent documents* button (the starter) and a *keep the last graph when a query
matches nothing* checkbox (off by default: an empty result clears the graph so
it is never mistaken for a stale one; on, the previous graph stays and the
panel becomes a banner). The footer repeats it (`0 rows · matched nothing —
/timeline/kickoff.md is not in this repo`). While the query or the edge fetch
has been in flight for more than 300 ms a *running the query…* / *fetching
edges and laying out…* pill shows at the top of the graph area.

**What happens on the first run.** The dev bridge is the
[`webdevproxy`](../webdevproxy/README.md) workspace package — a development-only
local web proxy for MCP servers, started by `scripts/dev.mjs` with `startProxy`
(and wired into Vite with `viteProxy()`) — and it is itself the OAuth client. It sends the gateway one unauthenticated `initialize`,
gets the `401` with `WWW-Authenticate: Bearer resource_metadata=…`, follows it
to the protected-resource metadata and the issuer's metadata, registers a
public client (dynamic client registration, PKCE, loopback redirect URIs
`http://127.0.0.1:<ephemeral port>/callback` and `http://localhost:<port>/callback`),
prints the authorization URL and opens your browser **once**:

```
[webdevproxy] sign-in required for https://mcp.example.com/omg
[webdevproxy] issuer: https://dev-….us.auth0.com/
[webdevproxy] open this URL in your browser if it does not open by itself:
[webdevproxy]   https://dev-….us.auth0.com/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A51763%2Fcallback&scope=offline_access&prompt=consent&resource=https%3A%2F%2Fmcp.example.com%2Fomg
[webdevproxy] waiting for the sign-in to finish (listening on http://127.0.0.1:51763/callback)…
```

Meanwhile the page's status line says *waiting for sign-in in your browser*
(it polls the bridge's `GET /whoami`). Consent lands on the loopback listener,
the bridge exchanges the code, and the page connects by itself. From then on
every browser session gets its own upstream session at the gateway, JSON-RPC is
relayed verbatim both ways, and the browser sees the remote's own
capabilities and tool list.

**Where the tokens live.** `~/.config/omgbase-webdevproxy/<sha256 of the url, 16 hex>.json`
(`$XDG_CONFIG_HOME` honoured; `WEBDEVPROXY_TOKEN_FILE=<path>` or `--token-file`
override; a sign-in made by this demo's former bridge under
`~/.config/omgbase-graph-ui/` is copied into place on the first start, so
nothing is lost), mode `0600`, shaped
`{ serverUrl, redirectPort, clientInformation, tokens, tokensSavedAt, codeVerifier?, state?, discovery }`.
Later runs need no browser: the access token is refreshed with the refresh
token (`offline_access`) whenever the gateway answers `401`, and only if the
refresh is rejected does the browser flow run again. Nothing in the file is ever
logged.

**Logging out.** `pnpm --filter graph-ui logout` (= `webdevproxy --logout`)
deletes every token file under both config dirs; `pnpm --filter graph-ui logout
--remote <url>` deletes just that server's. `--no-browser` (or
`WEBDEVPROXY_NO_BROWSER=1`) prints the URL without launching anything — handy
over SSH.

**When the session expires.** The proxy closes a browser session (and its
upstream) after `--idle` seconds without a request (default 3600), and forgets
every session when it restarts; the page's next request then gets a `404` with
`-32000 unknown session (expired or the proxy restarted) — send initialize
again`. The shared client handles that by itself (`@omgbase/client`'s
`OmgClient`, `isSessionLost`): it opens a fresh MCP session against the same
URL, retries the call once and lets the page note *session expired at the
server — reconnected* in the status line (`onSessionLost`); only a second
failure is shown as an error.

**Why no CORS or Auth0 setup is needed.** The browser never talks to the
gateway or to Auth0: it talks to `localhost` (same origin, via Vite's proxy at
`/mcp`), and the bridge — a Node process, not a web origin — is the OAuth
client. That makes it a *native app* with a loopback redirect (RFC 8252),
exactly what Claude Code does when you add this gateway as an MCP server, and
the gateway already accepts that. Nothing about the gateway's
`allowed_origins`/CORS or Auth0's *Allowed Web Origins* is involved; the
direct browser path below still needs both.

**What it relies on at the gateway.** (host-my-mcp + Auth0 as deployed; any
MCP-conformant gateway with these three behaves the same.)

- `401` on an unauthenticated request with `WWW-Authenticate: Bearer
  resource_metadata="https://host/.well-known/oauth-protected-resource/omg"`,
  and that document naming `authorization_servers` (the Auth0 issuer) and
  `scopes_supported`;
- the issuer's metadata advertising a `registration_endpoint` and accepting
  **dynamic client registration without credentials** (Auth0's
  `/oidc/register`; the created app is a third-party application with
  `token_endpoint_auth_method: none` and the two loopback redirect URIs);
- `offline_access` in `scopes_supported`, so a refresh token comes back
  (the SDK adds `prompt=consent` for it). With only `offline_access`
  advertised there is no `id_token`; the identity the bridge reports on
  `/whoami` then comes from the access token's claims (`sub`, plus whatever the
  tenant adds).

## Run it

```sh
pnpm install && pnpm build          # at the repository root (the demo spawns the built `omg`)
pnpm --filter graph-ui dev          # copies ./sample into .dev-workspace/sample and indexes it, starts the MCP proxy (omg mcp --tools minimal), starts Vite
pnpm --filter graph-ui dev --repo notes      # the repository to query: `omg mcp --repo notes` locally, and the page sends `repo: "notes"`
pnpm --filter graph-ui dev --tools full      # serve every tool instead of the minimal catalog (the page needs only the minimal one)
```

Open <http://localhost:5173>. Vite proxies `/mcp` and `/whoami` to the bridge
(port 8787, `--port`/`WEBDEVPROXY_PORT`; `viteProxy()` in `vite.config.ts` reads
the port the dev script exports), so the page's default server URL is just
`/mcp` and *MCP settings* starts in **local sample** mode (the bridge reports
`mode: "local"`). In the sample workspace — the `sample` slug with
`/timeline/kickoff.md` present — the default query walks the sample's release
timeline from `kickoff.md` both ways — back through each document's own
`before`, forward through the documents whose `after` names it (any other
repository starts with the generic starter instead — see [First run against a
real repository](#try-it-against-a-remote-omgbase)):

```oqx
docs {
  select _path, _title, phase, before, after
  where _path == "/timeline/kickoff.md"
  follow distinct refs(before), _in_links { from _doc where ^_path in list(after) }
  order by $ordinal
}
```

(the 5.0 spelling — `_`-prefixed names are the engine's, bare ones the
author's; against a 3.x/4.x server the same walk reads `docs { select path,
title, … where path == … follow distinct refs(before), in_links { from doc
where ^path in list(after) } … }`, and the page swaps the preset to whichever
the server speaks).

**Why `refs()`.** `before` holds document *references* — strings like
`/timeline/alpha.md` — not documents. `follow before` walks the strings, and
the server refuses that (`filter_invalid`: "a hit must be a document, block,
node or edge row — the query reached a string …"). `refs(before)` resolves
each reference (`/`-rooted or bare path, or a `d_` id; dangling ones dropped)
to the live document, so it is the `follow` destination that means "the
documents `before` names". The editor says so under the query whenever a
destination is a bare field.

**Why `_in_links { from _doc … }` for the backward hop.** The engine has
no `refs⁻¹`: there is no function giving "the documents whose `after` names
me". But a `/`-rooted frontmatter reference *is extracted as an edge*
(`spec/graph` §3.1, `provenance: frontmatter`), so the frontier's backlinks —
its `_in_links` rows, each re-rooted to its source document by `from _doc` —
already contain every document whose `after` — or any other field, or a body
link — points at it. The destination block narrows those to the ones whose
`after` really says so (`^_path in list(after)`: `^` is the frontier row, whose
path is `/`-rooted like the authored reference; `list()` makes a scalar and a
list read alike). It is an indexed lookup per frontier row, unlike the
full-scan fallback, which still works:

```oqx
follow refs(before), ^docs { after.contains(^_path) }
```

(`^docs` is the root `docs` collection seen from inside the block.)

### Server version

The demo is written against omgbase **surface 5.0** (`spec/surface`,
"underscore = engine"): every path a query or a tool returns is `/`-rooted and
every path a tool accepts tolerates both forms (§1 "Paths"); in the language an
engine-provided name is `_`-prefixed — `_path`, `_id`, `_title`, `_updated_at`,
`_raw`, `_hash`, `_tags` — and a bare name is the user's authored key, so an
authored `path:` or `title:` key is just `path` / `title` (`_title` being the
computed title; `_data.<k>` / `_frontmatter.<k>` reach a key by source), while
`$` belongs to OQX alone (`$it`, `$key`, `$depth`, …; §1.2); the link rows are
the `links` collection (`links { … }`, `^links`; a document's `_out_links` /
`_in_links`, a link's `_dst` / `_doc`; §1.1); a `docs_*` tool addresses its
document by `_id` or `_path` (§4 "Arguments"); a hit is `{ _id, _path,
...projection }` and a row surfacing as a value `{ _id, _path }` (§1.4). A
3.x/4.x server spells every one of these bare (`path`, `title`, `out_links`,
`doc.out_links`, `from dst`/`from doc`, `{ id }`/`{ path }`, `{ id, path, … }`).

On connect the page calls the `version` tool once and reads `specs.surface`
(`"major.minor"`) into the `serverSurface` signal, shown in the header (`·
surface 5.0`). A server reporting an older surface — or none, which a server
without the `version` tool is — is refused before anything else runs, with the
status line reading *error: this demo needs omgbase surface ≥ 3.0 — the server
reports 2.0* and the settings panel open (`surfaceProblem`, `src/lib/paths.ts`).
From 3.0 up the surface also picks the **spelling** (`namesFor(surface)` →
`NAMES_5` at major ≥ 5, else `NAMES_4`; an `EngineNames` record): everything
the page GENERATES — the preset queries (`defaultQuery(names)`,
`starterQuery(names)`, `timelineStarter(…, names)`, `existsQuery(…, names)`),
the edge queries (`edgeQueries(…, names)`), the document arguments
(`docLocator(doc, names)`) and the builtin candidate names
(`inferCandidates(…, names)`) — takes it, while everything it READS or
CLASSIFIES accepts both spellings (`hitId`/`hitPath`/`rowRef`,
`isEngineAttribute`, the `_`-or-bare relation names in `candidates.ts` and
`hints.ts`, every reader in `shapes.ts`). A preset in the editor is respelled
when the server changes (`chooseQuery(current, repo, names)`); a user's edit is
never touched. There is no compatibility layer for surfaces before 3.0. The
helpers:

| | |
| --- | --- |
| `surfaceOf(versionResult)` / `surfaceMajor(s)` / `surfaceProblem(s)` | `specs.surface` (null when absent), its major, and the gate's message (null when the server is fine) |
| `EngineNames` / `NAMES_5` / `NAMES_4` / `namesFor(surface)` | the server's spelling of the engine names: `_`-prefixed from 5.0, bare before (the native 5.0 one while unknown) |
| `rooted(p)` / `unrooted(p)` / `samePath(a, b)` | the two path forms (idempotent) and equality modulo the leading slash |
| `docLocator(doc, names)` | the document argument: `{ _id }` for a `d_…` id, else `{ _path }` (`{ id }`/`{ path }` under the 4.x names) |
| `hitId(hit)` / `hitPath(hit)` / `rowRef(v)` | a query hit's identity (`_id`/`_path`, then `id`/`path`), and a row that surfaced as a value (rooted, else null) |
| `HIT_ENVELOPE_KEYS` / `DOC_ATTRIBUTES` / `isEngineAttribute(n)` | the envelope in both spellings (none is a projectable field); the bare 4.x docs attributes; "an engine attribute, in either spelling" (`_`-prefixed, or one of the 4.x names) |

and every other tool result goes through its sibling `src/lib/shapes.ts`, which
takes either spelling and normalises to one internal shape with rooted paths:
`graphEdgeRows(result)` / `edgeOf(e)` / `docOf(d)` for the `graph` tool's
`links[]` and documents (this demo fetches edges through `query`, not `graph`,
so these are for a consumer that does), `docReadOf(r)` for `docs_read` and
`docOpOf(r)` for a document write's Receipt (`docs_set_meta`, `docs_create`, … are
sugar over `apply`): `{ plan_id, commit, revisions: [{ _id, _path, _hash }],
committed, summary }` — the first revision is the document written.

Nodes are keyed by the rooted path, and the edge fetch roots the rows'
`_path`/`_dst_path` before matching them to the shown nodes while spelling its
`_path == "…"` literals rooted. The default query and the starter are presets
swapped only while the editor still holds a preset, never a user's edit. The
value form of an edited field is inferred from the field's existing values
(leading slash or not), never from `_path`. The page never stores a cursor
(`queryAll` follows one within a single call). One hint under the editor
catches the stale idiom: a `"/" + ^_path` (or `"/" + _path`, `"/" + _dst_path`;
the bare spellings too) in the query gets "`_path` is already `/`-rooted; use
`^_path`". A literal (`_path == "a.md"`) is never flagged: the server roots it.

Try: `docs { select _path, _title, before where phase == "experiment" || phase == "plan" }`
(no `follow` — the candidates are *inferred* from the projected path-valued
fields, and the three `loop-*` notes trigger the cycle banner); `follow
_out_links { from _dst }` for the link graph; `order by phase` for a
sequence axis; `follow before` to
see the hint and the server's error (with the `refs()` fix) in the status line.

Scripts: `dev [--remote <url>]` (all of it; the proxy's flags — `--port 8787`,
`--path /mcp`, `--idle 3600`, `--origin <o>`, `--omg <path>`, `--remote <url>`,
`--client-id <id>`, `--callback-port <n>`, `--no-browser`, `--token-file <f>`, plus this demo's `--workspace <dir>` for the
proxy's `--local` — are consumed by `scripts/dev-args.mjs`, anything else goes
to Vite; `GRAPH_UI_*` variables from earlier runs still work as fallbacks for
their `WEBDEVPROXY_*` names), `dev:workspace [--force]` (just the workspace),
`dev:mcp [same flags]` (just the proxy, = `dev --proxy-only`), `logout
[--remote <url>]` (= `webdevproxy --logout`), `build` (`tsc --noEmit` + `vite
build`), `test` (vitest over the pure modules — the candidates, the edges, the
graph model, the toggle commands, the relation kinds, the loose nodes, the
palette actions — and the dev script's arguments; the client's session recovery
is tested in [`packages/client`](../../packages/client/README.md), the proxy's
own behaviour in [`examples/webdevproxy`](../webdevproxy/README.md)), `lint`.

### Data access

The browser only ever speaks MCP, through the shared
[`@omgbase/client`](../../packages/client/README.md) (`OmgClient`:
`@modelcontextprotocol/sdk`'s `Client` over the **Streamable HTTP** transport,
with this page's OAuth provider attached for direct mode and the `repo`
designation passed per call), calling `version` (once, for the surface),
`query` (every read: rows, edges, the sample probe, the palette's find, a loose
node's row) and, for the writes ([editing edges](#editing-edges), [Find, create,
connect](#find-create-connect)), `docs_read` and `apply` (plus `tools/list` to
see whether `apply` is offered). Those are all in omgbase's **minimal tool profile**
(`omg mcp --tools minimal`: `query`, `query_syntax`, `docs_read`, `docs_tree`,
`blocks_resolve`, `changes_since`, `plan`, `execute`, `apply`, `version`), which
is what `pnpm dev` serves the sample under, so the demo stays honest about
needing nothing else. Nothing imports `@omgbase/core`.

**Which repository.** The minimal profile has no `repos` tool, so the page never
lists repositories: it sends a *designation* as the `repo` argument of every
call — the header field (persisted), else `?repo=<slug>` in the page URL, else
the repository the bridge was started for (`pnpm dev --repo <slug>` → `omg mcp
--repo <slug>` locally, and `/whoami` reports `repo` in every mode), else nothing
(the server's default repo). The header says which (`repo notes · surface 5.1`,
or `default repo · …`); an unknown slug is the server's `repo_not_found` error.

The *MCP settings* panel offers three ways to reach a server:

- **local sample** — the proxy (`webdevproxy --local .dev-workspace`) spawns
  `omg mcp -C .dev-workspace` (stdio) per MCP session and relays JSON-RPC to a
  `StreamableHTTPServerTransport` on `127.0.0.1:8787/mcp`, with CORS headers
  for loopback origins (`Mcp-Session-Id` exposed). It is the same shape as
  [usergenic/stdio-mcp-to-http](https://github.com/usergenic/stdio-mcp-to-http);
  that proxy is not on npm and sends no CORS headers, so the browser could not
  use it directly.
- **via local proxy** — the same proxy started with `--remote <mcp-url>`:
  one upstream `StreamableHTTPClientTransport` session per browser session,
  the bridge holding the OAuth tokens (see [Try it against a remote
  omgbase](#try-it-against-a-remote-omgbase)). The panel shows the upstream URL
  and the identity the bridge reports on `GET /whoami` (`{ mode, upstream,
  identity, auth: { state, issuer, authorizationUrl?, error? }, tokenFile,
  sessions }`). *local sample* and *via local proxy* are the same bridge, so
  the page sets whichever the bridge reports (`lib/connection.ts`:
  `modeForBridge`, `headerLabel`) rather than warning about a mismatch;
  picking the other one just asks the bridge again.
- **direct** — for hosted deployments: the page connects to the remote itself
  and the *browser* is the OAuth client. This needs CORS on the gateway and web
  origins in Auth0 — see [Direct mode: the browser as the OAuth
  client](#direct-mode-the-browser-as-the-oauth-client-for-hosted-deployments).

The proxy's session table maps each browser-facing `Mcp-Session-Id` to its
upstream (`omg mcp` pid, or the gateway's session id); a browser `DELETE` ends
the upstream session too, and sessions idle for `--idle` seconds are closed
(the page then re-initializes on its own — see [When the session
expires](#try-it-against-a-remote-omgbase)).

### Direct mode: the browser as the OAuth client (for hosted deployments)

When the page is served from a real origin (or you want to exercise the
browser flow), pick **direct**, enter the remote URL and press **connect**. The first
request answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`; the
SDK's `StreamableHTTPClientTransport` then runs the flow through
`src/lib/oauth.ts`'s `BrowserOAuthProvider`:

1. **Discovery** — the `resource_metadata` URL (else
   `/.well-known/oauth-protected-resource/omg`, then the origin's) gives the
   protected-resource metadata: `authorization_servers` (the Auth0 issuer) and
   `scopes_supported`; the issuer's RFC 8414 / OpenID metadata gives the
   endpoints. The result is persisted (`saveDiscoveryState`) so the redirect
   round trip does not rediscover.
2. **Dynamic client registration** — no client id is configured: the SDK
   `POST`s the provider's `clientMetadata` (a public client,
   `token_endpoint_auth_method: none`, `authorization_code` + `refresh_token`,
   this page as the only redirect URI) to the tenant's
   `registration_endpoint` and the provider stores the `client_id`.
3. **Authorization Code + PKCE** — S256 challenge, `state`, `resource=<server
   url>` (RFC 8707), `scope` = the `WWW-Authenticate` scope, else the resource's
   `scopes_supported` (which includes `offline_access`, so a refresh token is
   issued; the SDK adds `prompt=consent` for it). The provider saves the
   verifier and `state`, remembers which server the round trip is for
   (`omgbase-graph-ui.oauth.pending`), and navigates away.
4. **Callback** — the page is its own redirect URI (`location.origin +
   pathname`). On load with `?code=…&state=…` the app checks `state`, calls
   `transport.finishAuth(code)` (code → tokens, saved per server URL under
   `omgbase-graph-ui.oauth.<origin><path>`), strips the query string, and
   reconnects; the query text was persisted all along, so the graph comes back.
5. **Refresh and re-auth** — tokens are sent as `Authorization: Bearer`; on a
   `401` the SDK refreshes with the refresh token and retries; if the refresh
   fails it invalidates the tokens and re-runs the flow (step 3 again, without
   re-registering).

The header and settings panel show the identity when the `id_token` (or a JWT
access token) carries an `email` claim; **disconnect** forgets the tokens and
client registration for that server. The local bridge never answers `401`, so
it stays auth-free; the same provider is attached but inert.

**What the gateway must allow for a browser origin.** A page at
`http://localhost:5173` is a cross-origin client, so host-my-mcp must:

- list the dev origin in `listen.allowed_origins` in its YAML;
- answer the CORS preflight: `OPTIONS` → `204` with
  `Access-Control-Allow-Origin: http://localhost:5173` (or the origin echoed),
  `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Mcp-Session-Id,
  Mcp-Protocol-Version` (plus `Accept`, `Last-Event-ID`);
- send `Access-Control-Allow-Origin` on every response — including the `401`,
  or the browser hides `WWW-Authenticate` and discovery cannot start — and
  `Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate`;
- serve `/.well-known/oauth-protected-resource/omg` with CORS too (it is read
  by the page). Auth0's `/.well-known/openid-configuration`, `/oidc/register`
  and `/oauth/token` already allow any origin.

**Auth0 setup.** Dynamic client registration creates a third-party
application per browser profile; for the SPA PKCE exchange to work the tenant
must allow it: enable *Dynamic Application Registration* (and *promote the
connection to domain level* so the new app can use it), and the registered app
needs the dev origin in **Allowed Web Origins** and this page's URL
(`http://localhost:5173/`) in **Allowed Callback URLs** — DCR only submits
`redirect_uris`, so check the created application after the first sign-in.
Requesting `offline_access` needs *Allow Offline Access* on the API that the
`resource` maps to.

**Edges** are fetched with generated OQX over the link rows:

```oqx
links {
  select src: _path, dst: _dst_path
  where _field == "after" && _provenance == "frontmatter"
    && (_path == "/timeline/kickoff.md" || _path == "/timeline/alpha.md" || …)
}
```

in chunks of 40 paths, then filtered client-side to edges whose both ends are
shown (bare `path`/`dst_path`/`field`/`provenance` against a 3.x/4.x server —
`edgeQueries(candidate, paths, names)`). OQX has no array literal (`_path in
[...]` is a lex error) and `in` only takes a lifted set or a range, hence the
disjunction. The nested alternative (`docs { select _path, out: _out_links {
select dst: _dst_path, _field } where … }`) also works against the
engine; the flat rows were simpler to merge across chunks and page with the
tool's cursor. An edge is a link row read source → destination, `_path` →
`_dst_path` (the paths of `_doc_id` and `_dst_id`; `_dst` is the destination
document row itself). Links (`_out_links`) and backlinks (`_in_links`) use the
same query with `_provenance == "link"`; backlinks are the same rows reversed. A
sequence candidate (an `order by` key) needs no fetch — its edges are
consecutive result rows.

## The elements

| Element | Properties | Events |
| --- | --- | --- |
| `<oqx-query-editor>` | `value` (source), `highlights` (`Span[]`, code points), `debounce` | `query-change` `{ source, query: Query \| null, error: { message, offset, stage } \| null }` |
| `<oqx-relationship-picker>` | `candidates: Candidate[]`, `overrides: Overrides`, `editable: Record<name, Editability>`, `armed: string \| null`, `edgeCounts: Record<name, number>`, `nodeCount`; getter `view`; `reset()`, `arm(name \| null)`, `setAxis(name \| null)` | `view-change` `{ view: { edges: string[], layout: { axis, direction }, projection }, overrides }`, `candidate-hover` `{ candidate \| null }`, `armed-change` `{ candidate \| null }` |
| `<oqx-projection-picker>` | `fields: ProjectedField[]`, `defaults: ProjectionChoice`, `overrides: ProjectionOverrides`; getter `projection`; `reset()` | `projection-change` `{ label: string \| null, shown: string[], overrides }`, `field-hover` `{ field \| null }` |
| `<oqx-graph-pane>` | `nodes: GraphNode[]` (`label` = the fallback title line, `row` = the projected row, `loose` for a guest node), `view: View` (`edges`, `layout` = `{ axis, direction, algorithm }`, `projection`), `candidates`, `fetchEdges: (candidate, paths) => Promise<GraphEdge[]>`, `selected`, `armed: Candidate \| null`, `writable: string[]`, `pending: PendingEdge[]`, `labelFit: "truncate" \| "wrap" \| "expand"` (attribute `label-fit`), `canWrite` (the connector and the edge's ✕ are offered), `edgeStyle` (attribute `edge-style`), `edgeGeneration` (bump to re-fetch the edges); method `fit()` | `node-select` `{ node \| null }`, `edge-toggle` `{ candidate, from, to, present }`, `graph-state` `{ edges, cycles, layout, busy, error, axisEdges, edgeCounts }`, `axis-request` `{ axis }`, `algorithm-request` `{ algorithm }`, `label-fit-change` `{ labelFit }`, `edge-style-change` `{ edgeStyle }`, `connect-request` `{ from, to, anchor, edges }`, `connect-empty` `{ from, anchor, edges }`, `edge-delete` `{ edge }` |

### The renderer: `<omg-graph>`

`<oqx-graph-pane>` (`src/elements/oqx-graph-pane.ts`) owns this demo's graph
MODEL and wraps the shared renderer. The model is `src/lib/graph-view.ts`
(`computeGraph`): fetch the wanted relationships' edges through the page's
`fetchEdges` (cached per relationship and node set), count them per
relationship, find the axis's loops, and lay out — with elkjs for `layered`,
`stress`, `radial`, `tree` and `grid` (`src/lib/layout-elk.ts`), or not at all
for `force`, which is now the element's own live d3-force simulation (nodes
repel, drawn edges pull, cards keep apart by their measured size). The same
module turns the model into the element's view model: `viewNodes` (one
`GraphViewNode { id: path, row, pinned, tooltip }` per hit), `viewEdges` (one
`GraphViewEdge` per drawn edge, keyed by the STORED edge `rel src→dst`, drawn
the relationship's way round, `color` from the picker's palette so each
relationship keeps its swatch, `writable` from the editability, `pending` for
in-flight toggles and the hover preview), `positionsOf` (elk's corners as card
centres for the element's `layout="fixed"`) and `routesOf` (elk's orthogonal
routes for the axis edges, re-keyed by edge, handed to the element's `routes`
so the timeline keeps its bent edges while every other edge is one of the
element's obstacle-aware curves). The pane adds the chrome around the canvas —
the relationship legend, the loop note, the empty-axis note, the edit banner,
the edge-style legend — and maps the element's events back: `graph-select` →
`node-select`, `graph-edge-toggle` → `edge-toggle` (the candidate's direction
says which document owns the edge; `present` is read off the model),
`graph-hover` / `graph-edge-hover` → the ⌘-click preview, `graph-pin` /
`graph-unpin` → session pins (a card you drag stays put until unpinned, under
every layout), `graph-label-fit` → `label-fit-change`, `graph-edge-style` →
`edge-style-change`, and — with `canWrite` — `graph-connect` /
`graph-connect-empty` → `connect-request` / `connect-empty` (the two paths, the
drop point and the drawn STORED edges, so the page's relation picker can read its
kinds off them) and `graph-edge-delete` → `edge-delete` (the stored edge behind
the element's key). The element runs with `auto-fit` (the picture stays fitted —
on resize, after a new layout, while the simulation settles — until you pan or
zoom; the toolbar's **fit** / `f` hands the camera back), `edgeToggle` (⌘-click)
and `canWrite` whenever the server offers `apply` (the connector handle on a
selected card, `c`, the ✕ on a selected edge).

**Cards.** The element's `renderCard` hook is fed `cardTextFor(node,
view.projection)`: the label field's value (else the de-rooted path) as the
title line and one keyed line `{ key, text }` per shown field, which the
element draws as `key: value` with the key dimmer and, when the line must be
cut to the card's width, keeps the key whole. elk needs the sizes before it
places anything, so the pane sizes each card with the element's own `sizeCard`
and `canvasMeasure` under the same label fit — the numbers the element draws
with, so edges attach to the card border. The view-model adapters and the
model are unit-tested without a DOM (`test/graph-view.test.ts`, the elk ones
through the real elkjs); the element's own geometry (routing, label fit,
templates) is tested in `packages/elements`.

What moved out of this demo and into the shared packages: the SVG renderer
(`oqx-graph.ts`), the card formatting and sizing (`cards.ts`, `card-size.ts` —
now the element's `formatValue` / `sizeCard` / `wrapLabel` / `canvasMeasure`),
the pan/zoom math (`viewport.ts`) and the synchronous force layout
(`layout-force.ts`) into `<omg-graph>`; the MCP client (`mcp-client.ts`'s
`OmgClient`, its session recovery, the envelope and `OmgError`) into
`@omgbase/client`, whose `CommandLog`, `attachRelationCommand`,
`detachRelationCommand` and `createDocumentCommand` replaced this demo's
`applyFrontmatter` / `PerKeyQueue` write path (the log serializes every write
and gives each a compensating undo); the find / action / create palette into
`<omg-palette>` and its pure model; the connector's "which relation" question
into `<omg-relation-picker>`. What the packages gained for it: `routes`,
`auto-fit`, `GraphViewEdge.color`, keyed `CardLine`s, the hover events,
`graph-label-fit` and `graph-edge-style` on the element; `createHint` on the
palette; `listPathFields` beside `relationKinds` in the client. What stayed
here, and why: the candidate inference and editability rules (they read this
query's AST), the form-aware toggle for fields the shared commands cannot
express (`lib/mutations.ts` `formToggleCommand` — see [Editing
edges](#editing-edges)), the loose-node model (`lib/loose.ts`), the mapping of
this demo's drawn edges onto relation kinds (`lib/relations.ts`) and the
palette's action list (`lib/palette-actions.ts`).

### The page chrome (Shoelace)

The page is a [Shoelace](https://shoelace.style) `<sl-split-panel>` — the side
panel on the start side, the graph on the end side, `--min: 320px` / `--max:
calc(100% - 360px)` so neither pane can be squeezed shut; the divider's
`position` (percent) is persisted. The side panel is a stack of
`<sl-details>` sections — **query**, **relationships**, **cards**, **MCP
settings** — each with a one-line summary of its state (rows, drawn
relationships and axis, card fields, connection mode) and its `open` state
persisted; the settings section also opens itself on a connection error or a
pending sign-in. Shoelace is imported per component
(`@shoelace-style/shoelace/dist/components/{details,split-panel}/*.js`) plus
`themes/light.css`; the chevron is a `library="system"` icon inlined in the
bundle, so no `setBasePath` and no icon assets are needed. Shoelace is Lit-built
and registers its own `sl-*` tags, so it sits inside our shadow roots without
collisions; the `--sl-*` tokens are set on `:root` by the theme and inherited
through every shadow root. `<omg-graph>` watches its own size with a
`ResizeObserver` and, under `auto-fit`, keeps the picture fitted on every pane
resize until you pan or zoom (**fit** in its toolbar, or `f`, fits again). The persisted
UI record is `omgbase-graph-ui.ui`: `{ keepLastGraph, labelFit, sections: {
query, relationships, projection, settings }, splitPosition }`.

The graph's bottom-left legend lists the drawn relationships by colour (the
axis marked); while the modifier is held in edit mode a second legend,
bottom-right, names the three edge styles — *will add* (blue dashed), *will
remove* (red dashed), *writing…* (the in-flight dashed edge). The element's own
toolbar sits top-right: curved / straight edges, the label fit, **fit**, **1:1**.

**Arrows follow the direction.** An edge is *stored* owner → target (`src` →
`dst`: `alpha.after ∋ prototype` is `alpha → prototype`) and *drawn* the way its
relationship's direction says (`orientEdge`, `src/lib/edges.ts`): `forward`
keeps the stored orientation, `backward` flips it so the arrowhead lands on the
owner. The axis uses the direction chosen in the picker; every other drawn
relationship uses its own default (`after` is backward, so beside a `before`
axis its arrows point earlier → later too). The same oriented edges feed elk,
so the layout flows left → right the way the arrowheads point: toggling the
direction select flips the arrows *and* the flow, never one without the other.
Tooltips and edits still speak the stored orientation (`alpha -[after]->
prototype` is the file that changes).

**An axis with no edges here.** When the chosen axis has zero edges among the
shown documents (a field the result does not author between its rows — the
single `before` of a repository that writes only `after`), the picker and the
graph both say so — *`before` has no edges here — nothing to order by* — with
one-click buttons for the relationships that do have edges (the axis's own
pair first, with the count) and for *no axis (force)*. The counts come from the
graph (`graph-state.edgeCounts`: edges among the shown nodes per relationship it
fetched — the drawn ones, the axis, and a pair's members); the graph's banner
raises `axis-request` and the page hands it to the picker's `setAxis`.

**Force layout** (*no axis — force-directed (nodes repel, edges pull)*): the
element's live d3-force simulation (`forceConfig` in `@omgbase/elements/graph`
— `forceManyBody` repels, `forceLink` pulls along the drawn edges,
`forceCollide` keeps cards apart by their covering radius, a weak pull toward
the origin), settling in view with the camera following under `auto-fit`; a
dragged card is pinned where you drop it (`u` or the ✕ unpins). With nothing
drawn the graph says *no edges drawn — nodes only repel; pick a relationship to
connect them*.

The editor's status area also carries the hints from `src/lib/hints.ts` (see
[Inference rules](#inference-rules-srclibcandidatests)).

`src/app.ts` composes them with `@lit-labs/signals`:
`source → ast → rows → candidates → view` and, beside it,
`ast + rows → projection → view.projection`; the graph pane does
`view → edges → layout` with the fetcher the page hands it, over cards sized
from `view.projection` (`src/lib/graph-view.ts`), and `<omg-graph>` draws. The page owns what
sits around the graph: the empty-state panel (`src/lib/empty-state.ts` — the
first `where` as text, the `_path == "…"` literals, which of them the
repository lacks, the words) and the delayed loading pill; the preset query
and the sample-or-not decision are `src/lib/starter-query.ts`; the mode and
header label that follow the bridge are `src/lib/connection.ts`. Edge edits flow
the other way: `edge-toggle` → `src/lib/edit.ts` (the plan) →
`src/lib/mutations.ts` (`toggleCommand` on the `CommandLog`) → the edges
re-fetched (or the query re-run — see [Find, create, connect](#find-create-connect)).

## Layouts

The picker's footer has a **layout** select beside **direction**. `auto` is what
the page always did: *layered* along the axis relationship, or *force* when
there is no axis. The others are chosen outright (`src/lib/view.ts`
`LAYOUT_ALGORITHMS`; `src/lib/layout-elk.ts` `elkOptions`):

| layout | what it is | needs an axis | edges |
| --- | --- | --- | --- |
| `layered` | elk layered: a left-to-right order along the axis; loops are broken and reported | yes | the axis's edges routed by elk (orthogonal, via the element's `routes`); every other drawn edge an obstacle-aware curve |
| `force` | d3-force (the element's live simulation): nodes repel, drawn edges pull | no | obstacle-aware curves |
| `stress` | elk stress: distance follows graph distance — a good general picture, and the one for graphs with loops | no | obstacle-aware curves |
| `radial` | elk radial: rings around a root — suits a walk from one document | no | obstacle-aware curves |
| `tree` | elk mrtree: a tidy tree | no | obstacle-aware curves |
| `grid` | elk rectpacking: a compact grid of cards | no | obstacle-aware curves |

(The element's toolbar can switch every curve to a straight segment.)

Only `layered` reads the axis and the **direction** control; the rest place the
nodes from *every* drawn relationship. `layered` with no axis to layer along is
`force`. Choosing an axis (the **layout** radio in the table) means layering
along it, so it clears a pinned algorithm. The overlay names the layout in
effect.

`radial` and `tree` are built for trees, so they are handed a **spanning forest**
of the drawn edges (breadth-first from whatever nothing points at; `spanningForest`
in `layout-elk.ts`) — the page still draws every edge. Radial arranges rings
around *one* root, so when the forest has several trees (or isolated nodes) a
hidden centre node joins them and is dropped from the result. An elk algorithm
that throws falls back to `force`, with a quiet note. `test/layout-elk.test.ts`
runs every algorithm through the real elkjs on loops, isolated nodes, no edges
and a single node and requires that no two nodes end up in the same place.

**The loop note.** The layered layout needs an order, so when the axis relationship
has loops among the shown documents (`A → B → A`) elk breaks them, drawing a few
edges against the flow, and the graph says so in a compact note: how many
documents are in how many loops, buttons to switch to the **stress** or **force**
layout (neither needs an order), **which ones?** to list the members (names,
capped; the full path in the tooltip — a loop is a *set* of documents that reach
each other, not an ordered path, so it is never joined with arrows), and **✕** to
dismiss it for those loops (a different set of loops shows it again). It appears
only under the layered layout.

## Choosing what a card shows

A node card has a **label** line (its title) and, under it, one `key: value`
line per **shown** field. Which fields are on offer is read off the query by
reflection (`src/lib/projection.ts`) — **the query is the contract**: the
panel lists exactly the `select` items, so adding a field to `select` adds it
to the panel (and removing one drops it, along with any choice made about it).

**Reflection rules.** Each `select` item, in order, keyed by the name the row
carries (the alias, or a navigation's last segment):

- an engine attribute (`_path`, `_title`, `_id`, `_updated_at`, … —
  `spec/surface` §1.2, the `_` prefix; the bare 4.x `path`, `title`, … read
  the same; aliased or not), or one of OQX's own `$`-names (`$depth`,
  `$ordinal`), is an **intrinsic**;
- any other scalar item — a frontmatter field, a navigation (`meta.slug` →
  `slug`), an aliased expression (`n: size(before)`) — is a **field**;
- a `collect` / `first` / `single` block (`jobs: jobs { … }`) is
  **nested** and renders as `n items`;
- under `values` the row is one unnamed value — a single **values** field;
- an empty projection (`docs { where … }`, "the row itself") has no items to
  read, so the fields are the keys the returned rows actually carry, in
  first-seen order (badge *from rows*), kinded by their values.

**Shaping cards from the query: `card:`.** The title line's template (the
element's template language, `cardTemplateFor` in `src/lib/graph-view.ts`) is
`{card|<label field>}`: a row that carries a bare **`card`** key — projected
(`select card`) or, since OQX 0.27 lets an alias shadow a field, computed —
drives the title with no settings, and the chosen label field stands in when it
is absent:

```oqx
docs { select _path, _title, card: _title + " · " + phase, before, after … }
```

`card` is a bare alias on purpose: a `_`-name is the engine's (an unknown one
is the hard error `filter_invalid`) and a `$`-name is the language's (it cannot
be authored or aliased), so a row key the apps look for lives in the user's
namespace — absent when the query does not name it, never a property of the
engine. `<omg-graph>` itself has no such concept (its default template is
`{_title}`); the convention is this demo's.

**Defaults.** The label is the first of `_title` (the computed title
attribute; a 4.x server's `title`), `name` that is projected; otherwise the card
is labelled with the de-rooted document path, which is always offered as the
**fallback** row. Only the label is shown by default — scalars other than the
label start **off**, so cards stay as small as they were until a field is asked
for. The starter query (`select _path, _title …`) therefore shows the title
alone; the sample timeline (`select _path, _title, phase, before, after`) shows
`_title` with `phase`, `before` and `after` unchecked.

**The panel.** One row per field with a *show* checkbox and a *label* radio
(exactly one — a field or the path). The label field is always shown (its
checkbox is on and disabled: it *is* the title line); switching the label to
another field keeps the old one as a line, so nothing vanishes by surprise. An
overridden row's name is dotted-underlined and says in its tooltip what the
inferred default was; *reset to inferred* clears every override. Hovering a
row highlights its `select` item in the editor.

**Values on cards** (`cardTextFor`, `src/lib/graph-view.ts`, over the
element's `formatValue`): strings as they are, numbers and booleans as text,
arrays as `a, b, c`, a list of records as `n items`, a record as `{…}`, an
absent value as `—`, an empty list as `[]` — never a JSON wall. Long values are
truncated with `…` to the card's width (the key is kept whole); the card's
tooltip carries the path and every shown value in full. The card's width and
height follow the shown lines, and the layout (elk or force) runs over those
sizes, so changing the projection re-lays the graph out and edges keep
attaching to the card border.

**Label fit.** Long labels are cut by default; the **label fit** select under
the field list (persisted with the other UI settings as `labelFit`; the
element's toolbar has the same select and the two stay in sync) says how a
card fits its title line, in the element's three modes (`sizeCard`,
`@omgbase/elements/graph`):
**truncate** — one line ending in `…` at the card's width, the original cards,
so a saved view does not jump; **wrap** — the label wraps onto several lines
within the card's width (greedy on spaces, an over-long word broken by
characters), the card growing by a line each up to four, the last line then
ending in a measured-in `…`; **expand** — the card widens to fit the whole
label on one line, up to 480 px, and wraps as above past that. The shown
`key: value` lines keep their one-line treatment and the card's height still
counts them. Labels are *measured*, not estimated: each label is measured with
a 2D canvas in the card's font (`600 12px system-ui`, the same string as the
element's label rule, cached per string), the layout (elk's per-node
`width`/`height`, force's covering radius) runs over the measured sizes, and
the SVG draws the wrapped lines as one `<text>` with a `<tspan>` per line — so
edges attach to the card's actual bounds. The measure is injected
(`sizeCard(text, fit, measure)`), so the wrapping is unit-tested with a fixed
width per character (in `packages/elements`); without a canvas it falls back
to the per-character estimate.

**The view record.** The projection's overrides live beside the relationship
overrides (`src/lib/view.ts`): the resolved view is
`{ edges, layout: { axis, direction }, projection: { label, shown } }`, so a
saved view is `{ query, edges, layout, projection }`. A choice naming a field
the query no longer projects is dropped on resolve, as a vanished candidate's
is; a pinned label that vanished falls back to the inferred one.

**Pan and zoom.** The element's: the wheel zooms about the pointer (the content
under the cursor stays put; a trackpad pinch zooms faster), a drag on the canvas
pans, a drag on a card moves and pins it, `+`/`-`/`0` zoom and `f` fits; the
toolbar has **fit** and **1:1**. Under `auto-fit` the view follows the graph
until you take it.

## Editing edges

Relationships stored in frontmatter can be edited from the graph.

**The gesture.** Click a node to select it; in the picker's **edit** column arm
a relationship (one at a time — arming also draws it); then **⌘-click**
(Ctrl-click off macOS) another node to toggle that relationship between the
two: the edge is added if absent and removed if present. ⌘-clicking a drawn edge
of a writable relationship removes it. A dashed edge shows the write in flight;
on failure it reverts and the error is shown.

**Seeing what a click will do.** The graph tracks whether the modifier is held
(`keydown`/`keyup` on the window, the pointer's own `metaKey`/`ctrlKey` on
every move so a key pressed before the pointer arrived still counts; reset when
the window blurs or the tab hides). Holding it with a node selected and a
relationship armed puts the graph in *edit mode*: nodes get a crosshair, the
selected node a dashed blue "source" ring, and the "editing `after`" banner
turns blue and says what a click does ("⌘-click a node to add or remove
`after` between it and `timeline/alpha.md`"). Hovering another node then draws
a **preview** of the toggle — the owner's edge to the referenced document, the
right way round for the relationship's direction — in one of two styles:
*will add* (the edge is absent: a blue dashed curve, `+ after` on hover) or
*will remove* (the edge is drawn: it turns red and dashed), and the banner
names the concrete action and the file whose field changes. Hovering a drawn
edge of a writable relationship with the modifier held previews its removal
the same way. Hovering the selected node, empty canvas, or a read-only edge
shows nothing, and ⌘-clicking empty canvas does nothing. With the modifier held
but no selection or no armed relationship the banner shows a quiet hint
instead. Pending (in-flight) edges keep the relationship's colour (dashed and
faded) so they are never mistaken for a preview; while in edit mode a small
legend in the bottom-right corner names the three (*will add*, *will remove*,
*writing…*). The decision — which edge, add or remove, who owns it — is
`previewFor` in `src/lib/preview.ts`, unit-tested without a DOM; the preview
reaches the element as a `pending` edge (`viewEdges`, `src/lib/graph-view.ts`),
driven by the element's `graph-hover` / `graph-edge-hover` events.

**Which file changes.** The edge is written where the relationship is stored —
the document whose frontmatter field names the other one — and the inverse
field is never touched. For a *forward* candidate (`before`) that is the
selected document (`selected.before` gains the target); for a *backward* one
(`after`, drawn target → selected) it is the clicked document (`target.after`
gains the selected one). By default a one-line strip shows the file, the field
and the new value before anything is written (`write /timeline/beta.md · set
after: […] via apply (expecting revision r_…)?`); untick *confirm before writing* to skip it.

**What gets written.** The field's current value comes from one `docs_read` of
the owner (never from the result row — so a toggle never clobbers values the
query did not select, and the write is always pinned to a revision). A scalar
field is set to the reference (or unset on remove); a list is appended to /
filtered, order preserved, duplicates (by identity, in any spelling) dropped; a
list that loses its last member is unset (the *emptied list* setting can keep
`[]` instead). The write is ONE command on `@omgbase/client`'s `CommandLog`
(`src/lib/mutations.ts` `toggleCommand`): in the common case — the field holds
a list (or nothing yet) of `/`-rooted `.md` paths and an emptied list is unset
(`sharedCommandFits`) — it IS the shared `attachRelationCommand` /
`detachRelationCommand`, exactly what repo-explorer's connector and edge ✕ run;
the cases the shared commands cannot express keep this demo's form-aware
builder, `formToggleCommand` over `lib/edit.ts`'s `planToggle`: a field spelled
in another **form** (bare `timeline/beta.md`, `timeline/beta` without `.md`, or
doc ids `d_…` — the shared commands write rooted paths and would mix forms,
which this demo refuses), a **scalar** field (an `owner` is replaced, not turned
into a list as the additive attach would), and the *emptied list → keep `[]`*
setting. Both follow the same contract: the owner is re-read inside the command
(a redo gets fresh preconditions; a stale belief is a `noop`, not a wrong write),
the effect is `{ op: "set" | "unset", target: { kind: "document", _path },
field: "_frontmatter.<field>", value, expect: { revision } }` — a document that
changed in between fails `stale_plan` ("document … is at revision r_…, not
r_…; re-plan") instead of being overwritten (the message says so and the graph
refreshes) — answered with the Receipt `{ plan_id, commit, revisions: [{ _id,
_path, _hash }], committed, summary }`; the compensation re-reads the owner and
REFUSES unless the field still holds exactly what the write produced (someone
else's edit is never undone). The log serializes every write, so two quick
toggles cannot race. Then the edges are re-fetched — or the query re-run; see
[Find, create, connect](#find-create-connect) for the rule.

The shared commands spell the document `{ _path }` and the field
`_frontmatter.<key>` — surface 5.0's names — so **edge writes need a 5.0+
server**; against a 3.x/4.x server (which spells `{ path }`) every
relationship is read-only with the reason *edge writes need omgbase surface ≥
5.0 … the server reports 4.x*. Reads keep both spellings (see [Server
version](#server-version)).

**Value form.** New references are spelled the way the field already spells
them, inferred from its values across the rows: leading `/` or not, `.md` or
not, path or doc id (`d_…`). A field with no values yet borrows the dominant
form among all reference fields in the rows, else `/path.md`; whether it
becomes a list or a scalar follows the same inference (ties → list). A field
whose existing values disagree (`/a.md` next to `b.md`) is refused with a
message until they agree. The values are the author's — `/`-rooted in these
repositories — whatever form the row's own `_path` takes.

**Writable or not.** Writable candidates are exactly the frontmatter relations
whose sampled values are document references (a `/`-rooted repo path, a bare
repo path, or a doc id — scalar or list). The rest show *read-only* with a
reason: `_out_links` / `_in_links` ("links live in the body"), an `order by` key
("derived from order by …"), an inverse pair ("edit `before` or `after`
directly"), a frontmatter field holding something else ("values are not
document references"), or a server that does not offer the tool. While a
relationship is armed its row shows `writes /path.md` — the form new references
take (the field's existing spelling: `/`-rooted or bare, with or without `.md`,
or doc ids; the tooltip says where the form came from and that a field mixing
forms is refused).

**Gateway allowlist.** Through a gateway (proxy or direct mode) the gateway's
tool allowlist must include `apply` (and `docs_read`, used when the
field was not projected) — both in the minimal profile. The page lists the
server's tools on connect and shows every relationship read-only when `apply` is
missing; a refusal at write time is reported with the same hint.

**Limits.** ⌘-click toggles edit frontmatter fields only; a body link is
authored and severed through the connector and the edge's ✕ ([Find, create,
connect](#find-create-connect)), and derived sequences, pairs and projected
relationships are read-only everywhere. Nested property paths (`meta.rel`) are not edited. Edits are per
document: the inverse relation (e.g. `before` when you edit `after`) is not
maintained — the engine has no field definitions declaring inverses. In the
local sample the writes land in `.dev-workspace/sample/` (a copy of `sample/`
made by `dev:workspace`; `pnpm --filter graph-ui dev:workspace --force` resets
it). Try the scalar path with `docs { select _path, _title, owner where
_path.startsWith("/timeline/") || _path.startsWith("/people/") }` (`owner` is a
scalar `/people/….md`) and the list path with the default query's `after`.

## Find, create, connect

The graph view can look documents up, create them and connect them — through
the shared layers `examples/repo-explorer` uses, not a copy:
[`@omgbase/elements`](../../packages/elements/README.md)' `<omg-palette>` and
`<omg-relation-picker>` for the asking, [`@omgbase/client`](../../packages/client/README.md)'s
commands for the writing.

**The palette (⌘K / Ctrl+K, or the header's ⌘K button).** Type to **find** a
document by path or title (`findQuery`: a regex `and` of the terms over `_path`
and `_title`, one `query` per keystroke debounced in the element, the hits
ranked title-prefix first); Enter puts it on the canvas and selects it —
the node it already has, or a **loose node** (below) when the query did not
show it. `>` lists this page's **actions** (`src/lib/palette-actions.ts`,
filtered fuzzily): *run the query again*, *fit the graph to the view*, *new
document…*, *undo: …* / *redo: …* (with the log's own labels), *lay out: force
/ stress / radial / tree / grid / auto* (the picker's layout select), *label fit:
wrap / expand / truncate*, *edges: straight / curved* (the element's toolbar
button, kept in step through `graph-edge-style`), *edit `after` edges* / *stop
editing `after`* (arm or disarm a writable relationship for ⌘-click toggles),
*confirm every edge edit before writing* / *write edge edits without
confirming*, *show recent documents* (the starter) and *reconnect*. `+path` (or
`new path`, or a find that matches nothing) **creates** the document — one
`apply { create }` as `createDocumentCommand` on the log, a title heading from
the file name, `path_taken` when something is already there — and adds it to
the graph as a loose node: the query may not match it, and the create row's
hint says so (*a new document with a title heading, added to the graph as a
loose node*). A bare name lands in the selected node's folder, else at `/`.
In **pick** mode (the connector's empty drop, below) Enter hands the chosen or
created document back as the destination instead.

**Loose nodes** (`src/lib/loose.ts`). A document on the canvas that is not one
of the query's rows — found, created, or picked as a connector's destination —
is fetched with one `docs { select _id, _path, _title, <the projected plain
fields> where _path == "…" }` of its own, so its card reads like the others',
flagged `loose` (the selection panel shows a *loose* badge; the tooltip ends
with *not in the query's result*), and kept until the query re-runs: the query
is the contract for what is on the canvas, a loose node is a guest. Edges to
and from it are fetched like any other's (the edge queries name every shown
node), so connecting a query row to a found document draws the new edge.

**The connector.** With a node selected, drag its ⟶ handle (or ⌘-drag the
card, or press `c` and steer with the arrows) onto another card: the pane
reports `connect-request` and `<omg-relation-picker>` opens at the drop point
asking WHICH relation `from → to` is — the rows are the frontmatter fields the
drawn edges already use (by frequency, with their counts), then this query's
other frontmatter relationships, then the source's own path-valued fields (one
`docs_read` of it — `listPathFields`), then *a link in the body*, and *new
field…* for a name of your own (`src/lib/relations.ts` `connectorKinds` over the
client's `relationKinds`). Picking a row is the whole gesture: ONE additive
`attachRelationCommand` on the log (the list gains the destination, a scalar
path becomes a list, nothing is replaced; *already related* fails before
writing), drawn as a pending dashed edge meanwhile; a field the view did not
draw yet is switched on so the edge appears; a field that is no relationship of
this query is written but not drawn, and the message says so. Dropping on open
canvas opens the palette in pick mode (*connect /a.md to…*): find or create the
destination, it joins the canvas as a loose node, then the picker.

**Deleting an edge.** Click an edge to select it, then its ✕ or Delete /
Backspace: `detachRelationCommand` — the frontmatter field without the
destination (unset when that empties it), or a body link's block removed by its
hash (a link candidate's edge rows carry `block: _block_id` for this; a
backlinks edge is the stored link flipped, so the document holding it is the
edge's `dst`). A derived edge is not deletable from the graph and the message
says why: a pair's (`before/after` — draw `before` or `after` and delete that
edge), an `order by` sequence's, a projected relationship's.

**Undo and redo.** Every write above and every ⌘-click toggle is an entry on
one session-local `CommandLog`; ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y off macOS; outside a
text field — inside the query editor they stay the editor's), the header's
↶ undo / ↷ redo buttons (their tooltips name the entry) and the palette's
*undo: …* / *redo: …* actions run it. An undo is a NEW forward write computed
against the repository's current state — the field restored pinned to the
current revision, a created document removed, a removed link's block
re-inserted at the end of the document — and is **refused** when what the
command wrote has moved on (someone else edited the field, the created
document was edited), with the reason shown and nothing overwritten. The log
is in memory only; connecting to a different server clears it.

**After a write.** With loose nodes on the canvas only the edges are re-fetched
(the pane drops its edge cache — `edgeGeneration`), so the guests survive; with
none the query re-runs as before (rows, candidates and edges all fresh). The
optimistic dashed edge clears when the pane reports a settled layout either way.
The query also re-runs when you edit it or ask the palette to.

## Inference rules (`src/lib/candidates.ts`)

The one module that reads the AST — every body of it: the top-level clauses
and, through the generic `visit` walk (`spec/oqx/AST.md` §5), every nested
block (a select item's value, a where-position directive, a `flatten` block, a
destination block), since OQX 0.26 allows `follow` in each. When omgbase ships
a `query_analyze` tool returning candidates with roles, the page feeds that
into the picker and this module becomes the fallback.

1. **`follow` destinations.** `refs(<field>)` (and `refs(^<field>)`) names the
   frontmatter relation `<field>` with direction *forward* — the frontier row
   owns the field and names its successors; it is the same candidate a bare
   `follow <field>` would give (same name and kind, merged with the inferred one
   from the rows, written the same way), now meaning the documents. The link
   graph is walked through the link rows — `follow _out_links { from
   _dst }` = links (`_dst` is a link's destination document), `follow _in_links
   { from _doc }` = backlinks with direction *backward* (`_doc` its
   source); the receiver names the relation, as written (`_out_links`,
   `$it._in_links`; the 4.x `out_links`, `doc.out_links`, `$it.in_links` read
   the same). Any other plain relation is a frontmatter relation — flagged by
   the editor's hint, since it follows the strings. Any **destination block**
   (`^docs { where … }`, `_in_links { from _doc where … }`,
   `refs(before) { … }`) is read first through its receiver —
   `refs(<field>)` names `<field>`, *forward* — then through its correlated
   `where`: a bare property of the candidate row compared against an outer
   reference (`^_path in list(after)`, `after.contains(^_path)`) names the
   relation `after` with direction *backward* (the edge is stored on the
   successor and points at the frontier); an outer property (`_path in ^before`)
   names `before`, *forward*; a `refs()` receiver of a nested directive follows
   the same two cases (`refs(after) exists { _path == ^^_path }` → `after`
   *backward*, `refs(^before) exists { … }` → `before` *forward*); a `_field ==
   "x"` / `_predicate == "x"` literal under `_in_links` / `_out_links` /
   `^links` (the bare `field`/`predicate` under `doc.in_links` on 4.x) names `x`
   (*forward* for in_links, *backward* for out_links). A link-row block whose
   `where` correlates with the frontier that way — the default query's
   `_in_links { from _doc where ^_path in list(after) }` — *means* that
   relation, so the whole backlink graph is not offered beside it; an
   uncorrelated filter (`_in_links { from _doc where phase == "x" }`)
   keeps the walk as the candidate.
2. **`order by` keys** that are not `$`-intrinsics become *sequence*
   candidates (edges = consecutive rows; `desc` → backward).
3. **Inferred from rows**: a projected field whose values are a doc path or a
   list of doc paths (`*.md`, optionally `/`-rooted). Names in a small
   "looks-backward" vocabulary (`after`, `prev`, `parent`, `depends_on`, …)
   default to *backward*.
4. **Builtin**: a query without a `follow` always gets the authored link graph
   to choose from — `_out_links` (links) and `_in_links` (backlinks), named for
   the document's link relations the edges are fetched from, in the connected
   server's spelling (`doc.out_links` / `doc.in_links` under the 4.x names) — so
   a query that projects no relationship (the starter) still has edges to draw.
   A `follow _out_links { from _dst }` is the follow candidate itself,
   not a second entry.

5. **Inverse pairs** — see the next section: two frontmatter candidates that are
   one sequence read from both ends get a combined candidate (`before/after`,
   kind `sequence`, source `pair`) inserted just before its first member.
6. **Nested bodies** (source `nested`). Every `follow` below the top level is
   read by rule 1 verbatim — the per-row reach `reach: ^docs count { where
   _path == ^_path follow distinct 0^docs { where ^_path in list(after) depth
   4 } }` names `after`, *backward*; the nested backlinks walk `n: _in_links
   count { follow _in_links { from _doc } }` names `_in_links`; a `before`
   walk inside a where-position lifting `collect` names `before` — and so is
   the **receiver** of a nested directive *where relevant*: when it names a
   document relationship — the link rows (`n: _in_links count` → `_in_links`;
   `desc: _out_links { from _dst follow … }` → `_out_links`), `refs(<field>)`
   (`where refs(after) exists { … }` → `after`, *forward*: the row's own field
   names the documents) or a root block (`^docs` / `0^docs { where … }`), read
   through its correlated `where` exactly as a destination block is. A receiver
   that is not a relationship — a list field (`tags`), `entries(x)`, `rows`, a
   plain name (`jobs`) — names nothing, whatever its body does. Scoping: inside
   a block the root collection is **not** `^docs` (that is the enclosing row, a
   document with no `docs` property) but `0^docs` (absolute; the parser
   desugars it to an `outer` whose `levels` is the block's depth) or `^^docs`
   — an `outer` naming a root collection is the root scan whatever its
   `levels`. A correlation with the frontier is an outer read exactly **one**
   scope out of the block (`^_path`); a deeper reference (`1^_path` or
   `^^_path` from the block) reaches an enclosing row and names no walk
   relation. Each mention keeps its span (hovering the row highlights it) and
   the candidate says where it sits — the select item's alias (`inside reach`),
   `where`, `flatten`, `order by`.
7. **Projected relationships** (a flag on rules 1/3, `projected`). Since oqx 0.27
   a `select` alias is visible to `follow`, so the relationship a walk follows
   may exist only in the query: `docs { select _path, calls: ^docs { select
   target values where origin == ^_path } where … follow refs(calls) }` follows
   a `calls` that no document stores. `parse` returns the AST *before* alias
   resolution, so rule 1 still reads `refs(calls)` as the candidate `calls`; a
   frontmatter candidate whose name is a top-level select alias — not a bare
   read of the stored field of the same name (`select before`) — is marked
   `projected` (whether the walk is `follow refs(calls)` over a list of paths or
   the bare `follow calls` over the projected rows themselves). There are no link rows behind it, so its edges are not fetched
   with `links { … }`: they are read off the shown rows' own values
   (`edgesFromValues` in `src/lib/edges.ts` — a path, a list of paths, or rows
   that surfaced as values; only edges between shown nodes, never a self-edge),
   oriented as a field is (owner → named). It is drawn and laid out like any
   `follow` candidate and is **read-only** in [Editing
   edges](#editing-edges): nothing is stored to rewrite. Only the top-level
   `select` is read; an alias inside a nested body stays a nested mention.

Defaults: a pair is drawn and its members are not; otherwise every `follow`
candidate is drawn; inferred fields are drawn only when the query has no
`follow`; the builtin `_out_links` is drawn only when nothing else is (no
`follow`, no inferred field); `_in_links` and sequences are never drawn by
default. A candidate whose only source is `nested` is listed but not drawn and
never the axis; one mentioned both at the top level and nested keeps the
top-level defaults, and the builtin rule looks at the top-level `follow`
alone (a nested walk does not switch the link graph off). The layout axis is the first pair, else the first `follow` candidate,
else the first sequence key, else the first inferred field (timeline words
first), else none (force) — a builtin is never the axis. Overrides live beside
the view (`src/lib/view.ts`), as the projection's do ([Choosing what a card
shows](#choosing-what-a-card-shows)); an override naming a vanished candidate
is dropped.

### Inverse pairs: `before`/`after` is one sequence

`before` and `after` are one relation read from both ends: `kickoff.before ∋
design-review` and `design-review.after ∋ kickoff` say the same thing. A
repository usually authors only one of them (Brendan's writes `after` on 8 of
27 documents and `before` on none), so laying out along `before` there had no
edges. The picker therefore offers the **pair** as a candidate of its own,
`before/after`:

- **Detection** (`detectPairs`, `src/lib/candidates.ts`). *By name*: both
  fields of a sequence pair are frontmatter candidates — `before`/`after`,
  `prev`/`next`, `previous`/`next`, `predecessor`/`successor` (only sequence
  vocabulary; `parent`/`children` is a tree, not an order). *By data*
  (`reciprocal`): for any two frontmatter candidates left over, the rows show
  `A.x ∋ B` and `B.y ∋ A` at least once and never `A.x ∋ B` together with
  `A.y ∋ B` (two relations pointing the same way — `owner` and `see_also` — are
  not inverses). Each field is in at most one pair; a field never pairs with
  itself; a one-way reference or a target outside the rows proves nothing.
- **Edges** (`pairEdges`, `src/lib/edges.ts`): the union of both fields' edges
  normalised to ONE direction, earlier → later. The pair records which member is
  `forward` (its stored edge owner → target already runs earlier → later:
  `before`) and which is `backward` (`after`, whose edges are flipped). A fact
  authored from both ends yields one edge; the pair's own direction toggle then
  flips every arrow at once.
- **Defaults.** The pair is drawn and is the layout axis; the member fields stay
  listed (so you can draw or lay out along one alone) but are not drawn by
  default and remain the writable ones — the pair is read-only in the editing
  sense ("edit `before` or `after` directly"). Hovering the pair lights both
  members in the picker and both their spans in the editor; its row reads
  `before/after = before ∪ after⁻¹`.

The engine has no field definitions yet; when a repository can declare
`inverse_of` (and a direction) on a field, that is the source of truth for both
the pairing and which end is earlier, and this name-and-reciprocity detection
becomes the fallback — see [Gaps](#gaps-found-in-the-public-api).

**Hints and server errors** (`src/lib/hints.ts`, `src/lib/errors.ts`). The same
AST reading drives the non-blocking messages. Under the editor: when a `follow`
destination is a bare frontmatter-looking field (not `refs(…)`, not a block,
not `out_links`/`in_links`/`children`/`subsections`/`dst`/`$it.…`), the
status area adds "`before` holds document references; `follow refs(before)`
walks the documents (a bare field follows the strings)" and dot-underlines the
destination; the query still runs. The path-form hint ([Server
version](#server-version)) appears the same way. In the footer: the server's
`filter_invalid` ("a hit must be a document, block, node or edge row — the
query reached a string ("/timeline/beta.md"); … use refs(<field>)") is shown
with its remedy made concrete from the AST — `try follow refs(before)` — or the
engine's own `refs(<field>)` when no bare destination names the field.

## Gaps found in the public API

- ~~**Paths disagree with frontmatter paths.**~~ Fixed in surface 2.0: the
  row's path is `/`-rooted like an authored reference, so `^_path in
  list(after)` needs no `"/" +`.
- **No inverse of `refs()`.** `refs(before)` walks forward; "the documents whose
  `after` names me" has no function and is spelled as a backlink block
  (`_in_links { from _doc where ^_path in list(after) }`) — correct because
  frontmatter references are edges, but a `referrers(after)` (or a field
  definition with `inverse_of`) would make the backward hop as short as the
  forward one.
- ~~**`follow <frontmatter list>` yields junk rows.**~~ Fixed in surface 1.5: a
  hit that is not a store row is a `filter_invalid` naming the value and
  `refs(<field>)`; `refs(x)` resolves the references. The demo shows the hint
  before the run and the error after it.
- **`select frontmatter` leaks the lazy handle** (`{ docId, source }`) rather
  than the bag; `entries(frontmatter) { k: $key, v: $it }` is the way
  to read it, which no UI would guess.
- **No candidate/role reflection.** Everything in `candidates.ts` is the UI
  re-deriving what the engine knows (which relations a `follow` walks, which
  direction a destination block's correlation runs, which fields hold doc
  paths). `query_analyze` should return candidates with `edge`/`layout`
  defaults and their spans.
- **No edge-set query by node set.** The edge fetch spells the node set as a
  40-way `||`; an array literal, `in` over a literal list, or a `query` tool
  argument binding (`${paths}`-style values, which the TS `oqx` tag already
  has) would remove the chunking.
- **No field-definition direction.** Whether `after` points to the past or the
  future is a vocabulary guess here; a field definition (`inverse_of`,
  `direction`) in the repository would settle it.
- **Error offsets are prose.** `OqxError` carries the position in its message
  (`(at offset N)` from the parser, `at N` from the lexer) in code points; the
  editor regex-parses both. A structured `offset`/`span` on the error would be
  kinder to tools.
- **`@omgbase/fs-adapter` crashes on `EPIPE`** when its parent `omg mcp` exits
  (noise in the bridge log, not a UI gap).
- ~~**No CAS on `docs_set_meta`.**~~ Closed by writing through `apply`: a
  `set`/`unset` effect takes `expect: { revision }`, so a document that changed
  since it was read fails `stale_plan`. Still open: there is no
  server-side list toggle (`add`/`remove` a member), so the client reads the
  whole value, edits it, and writes it back — and a value taken from the result
  row carries no revision to expect.
- **No `repos` in the minimal profile.** The page cannot list repositories, so
  the repository is a designation it is told (`--repo`, the header field,
  `?repo=`); a wrong slug is only discovered as `repo_not_found` on the first
  call. A `version`-sized "which repo am I on" answer (the root row's `_id`
  and slug) would let the page confirm it.
- **No inverse-field knowledge.** Editing `after` does not maintain `before`;
  a field definition with `inverse_of` would let the UI (or the engine) keep both
  — and would replace the pair detection in `candidates.ts` (vocabulary plus
  reciprocal rows) with a declaration.
- **An empty projection is not "the row itself".** `docs { where … }` with no
  `select` returns hits carrying only the envelope (`_id` and `_path`), so the
  cards panel's *from rows* fallback has nothing to
  offer; the frontmatter has to be named in `select` to reach a card (a
  `select *`, or hits that carry the frontmatter bag when nothing is projected,
  would make the empty projection mean what it says).
- **Projected-but-absent is indistinguishable from not projected** in a hit:
  a document without `after` yields a row without the key, so whether a row's
  value is authoritative has to be read off the AST (`projectedFields`).

## Sample data

`sample/` is a 20-document project notebook: a release timeline authored through
`before`/`after` frontmatter (`/`-rooted paths — only `/`-rooted strings and
`[[wikilinks]]` become frontmatter edges, see `spec/graph` §3.1), two branches
(`docs-draft`, `security-audit`) that rejoin at `launch`, a deliberate three-note
cycle (`loop-a` → `loop-b` → `loop-c` → `loop-a`), `owner` relations into
`people/`, `see_also` under `topics/`, and ordinary Markdown links.

## Verified headlessly

Shared commands (2026-10-24; the TS `omg` at surface 5.1, the proxy started by
`dev.mjs --proxy-only --no-browser --port 8794` over the sample — `omg mcp -C
.dev-workspace --tools minimal` — and a Node script running the page's writes
through the built `@omgbase/client` and `@omgbase/elements/palette`, exactly as
`app.ts` does): `capabilities` reported `typescript · surface 5.1 · minimal ·
canWrite`; `attachRelationCommand` `/timeline/loop-a.md → /timeline/beta.md` in
`after` committed (`after: ["/timeline/beta.md"]`, the `links { … _field ==
"after" }` edge row present); the same attach again was `failed` with *already
related* and nothing applied; `detachRelationCommand` committed and the edge
row was gone; `undo` of the detach (a compensating `apply`) brought `after`
back, `undo` of the attach restored the file byte for byte; the body link:
attach inserted `[Beta](/timeline/beta.md)` (the edge row carried `block:
b_…`), detach by that block id removed it, undo re-inserted it (a new block id,
as documented), a second detach cleaned up — leaving one trailing blank line
from the insert / remove cycle, the only residue; `createDocumentCommand`
`/scratch/live-palette-test.md` wrote `# Live palette test\n` and its undo
left `doc_missing`; `findQuery("loop")` found the three `loop-*` notes. The
browser flow was not re-driven for this change; the workspace was reset with
`dev:workspace --force` afterwards.

Minimal profile (2026-10-23; the TS `omg` at surface 5.1 / `omgbase` 0.26.2,
the proxy started by `dev.mjs --proxy-only --repo sample` — so `omg mcp -C
.dev-workspace --repo sample --tools minimal` — and a Node script issuing the
page's exact MCP calls against it): `/whoami` reported `repo: "sample", tools:
"minimal"`; `tools/list` was the ten minimal tools (no `repos`, no
`docs_set_meta`); `version` answered `surface 5.1`, `profile minimal`; the
default query returned 9 rows with `repo: "sample"`; `docs_read` of `loop-a.md`
gave its `rev`; `apply { effects: [{ op: "set", target: { kind: "document",
_path }, field: "_frontmatter.after", value, expect: { revision } }] }`
committed (Receipt `revisions[0]._path = /timeline/loop-a.md`); the same effect
replayed with the now-stale revision was refused `stale_plan` ("document … is
at revision r_…, not r_…; re-plan"); `unset` with the fresh revision restored
the file; a `repos` call was `unknown tool`; `repo: "nope"` was
`repo_not_found`. The browser flow itself was not re-driven for this change.

Surface 5.0 (2026-10-20; the TS `omg` at surface 5.0 / `omgbase` 0.26.1; Chrome
`--headless=new` over CDP, the dev flow as documented — `dev:workspace --force`,
`dev:mcp` on 8787, `dev:vite` on 5173 — plus a Node script issuing the page's
exact MCP calls against the same proxy): the header read `local sample · /mcp ·
1 repo · surface 5.0`; the default query (`_in_links collect { from _doc where
^_path in list(after) }`) returned 9 rows as `{ _id, _path, _title, phase,
before, after }`, the picker inferred `before/after` (drawn, axis) + `before` +
`after`, the cards panel listed `_path`/`_title` as intrinsics with `_title` the
label, and the graph drew 9 cards with 10 `before/after` edges (`9 nodes · 10
edges · elk`); the starter (`select _path, _title … order by _updated_at desc`)
drew 20 cards with 22 `_out_links` edges under a force layout; `follow before`
raised the `refs()` hint and the server's hit-rule error; arming `after` and
⌘-clicking `loop-a` from `beta` wrote `after: ["/timeline/beta.md"]` into
`.dev-workspace/sample/timeline/loop-a.md` through `docs_set_meta { _path, set }`
(the Receipt carried `revisions: [{ _id, _path, _hash }]`), and the graph
re-ran. The same calls spelled the 4.x way were refused by the server
(`docs_read { path }` → `filter_invalid` with `data.fix = { _path }`), while a
4.x-spelled *query* (`select path, title … where path == "…"`) is not an error
on 5.0 — `path` is an authored key there — and matched nothing, which the empty
state reported. No console errors (Lit's dev-mode warning only).

Earlier runs:

After the pre-3.0 compatibility branches were removed (Chrome `--headless=new`
over CDP on free ports — proxy 18961, Vite 15961 — against the current build):
the page connected with the header `local sample · /mcp · 1 repo · surface
3.0`, the default query (`in_links collect { from doc where ^path in
list(after) }` for the backward hop) returned 9 rows, the picker inferred
`before/after` + `before` + `after`, and the graph drew 9 cards with 10 edges
along `before/after` (`layout: before/after (forward, 10 edges)`); the editor's
status read `OQX ok`. No console errors (Lit's dev-mode warning only).
