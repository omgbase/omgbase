# graph-ui — an OQX query as a graph

A Lit demo that runs an OQX query against an omgbase repository (over MCP) and
draws the result as a graph. The relationships the query *talks about* are read
off the parsed query by reflection and offered as **candidates**, each with two
roles the user can override:

- **edge** — draw this relationship between the shown documents;
- **layout** — lay the graph out along this relationship (a layered DAG layout,
  so `before`/`after` frontmatter reads as a timeline). No axis → force layout.

It is also a probe of the reflection API being built next door: whatever the
UI wanted and could not get from `@omgbase/oqx`'s public `parse` or omgbase's
MCP tools is listed under [Gaps](#gaps-found-in-the-public-api).

## Try it against a remote omgbase

```sh
pnpm install                                                  # at the repository root; no `pnpm build` needed for this path
pnpm --filter graph-ui dev --remote https://hmm-ph.zocomputer.io/omg
```

(`GRAPH_UI_REMOTE=<mcp-url>` is the same as `--remote`.) Open
<http://localhost:5173> and pick **via local proxy** in *MCP settings* (the
page defaults to the bridge either way).

**What happens on the first run.** The dev bridge (`scripts/dev-mcp.mjs`) is
itself the OAuth client. It sends the gateway one unauthenticated `initialize`,
gets the `401` with `WWW-Authenticate: Bearer resource_metadata=…`, follows it
to the protected-resource metadata and the issuer's metadata, registers a
public client (dynamic client registration, PKCE, loopback redirect URIs
`http://127.0.0.1:<ephemeral port>/callback` and `http://localhost:<port>/callback`),
prints the authorization URL and opens your browser **once**:

```
[mcp-bridge] sign-in required for https://hmm-ph.zocomputer.io/omg
[mcp-bridge] issuer: https://dev-….us.auth0.com/
[mcp-bridge] open this URL in your browser if it does not open by itself:
[mcp-bridge]   https://dev-….us.auth0.com/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A51763%2Fcallback&scope=offline_access&prompt=consent&resource=https%3A%2F%2Fhmm-ph.zocomputer.io%2Fomg
[mcp-bridge] waiting for the sign-in to finish (listening on http://127.0.0.1:51763/callback)…
```

Meanwhile the page's status line says *waiting for sign-in in your browser*
(it polls the bridge's `GET /whoami`). Consent lands on the loopback listener,
the bridge exchanges the code, and the page connects by itself. From then on
every browser session gets its own upstream session at the gateway, JSON-RPC is
relayed verbatim both ways, and the browser sees the remote's own
capabilities and tool list.

**Where the tokens live.** `~/.config/omgbase-graph-ui/<sha256 of the url, 16 hex>.json`
(`$XDG_CONFIG_HOME` honoured; `GRAPH_UI_TOKEN_FILE=<path>` or `--token-file`
override), mode `0600`, shaped
`{ serverUrl, redirectPort, clientInformation, tokens, tokensSavedAt, codeVerifier?, state?, discovery }`.
Later runs need no browser: the access token is refreshed with the refresh
token (`offline_access`) whenever the gateway answers `401`, and only if the
refresh is rejected does the browser flow run again. Nothing in the file is ever
logged.

**Logging out.** `pnpm --filter graph-ui logout` deletes every token file under
the config dir; `pnpm --filter graph-ui logout --remote <url>` deletes just that
server's. `--no-browser` (or `GRAPH_UI_NO_BROWSER=1`) prints the URL without
launching anything — handy over SSH.

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
pnpm --filter graph-ui dev          # builds ./sample into .dev-workspace, starts the MCP bridge, starts Vite
```

Open <http://localhost:5173>. Vite proxies `/mcp` and `/whoami` to the bridge
(port 8787, `GRAPH_UI_MCP_PORT`), so the page's default server URL is just
`/mcp` and *MCP settings* starts in **local sample** mode. The default query walks the sample's release
timeline from `kickoff.md` through `after`:

```oqx
select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow $repo.docs collect { where after.contains("/" + ^$path) }
order by $ordinal
```

Try: `select $path, title, before from docs where phase == "experiment" || phase == "plan"`
(no `follow` — the candidates are *inferred* from the projected path-valued
fields, and the three `loop-*` notes trigger the cycle banner); `follow doc.out`
for the link graph; `order by phase` for a sequence axis.

Scripts: `dev [--remote <url>]` (all of it; the bridge's flags are consumed,
anything else goes to Vite), `dev:workspace [--force]` (just the workspace),
`dev:mcp [--port 8787] [--path /mcp] [--idle 600] [--workspace <dir>]
[--remote <url>] [--no-browser] [--token-file <f>]` (just the bridge),
`logout [--remote <url>]`, `build` (`tsc --noEmit` + `vite build`), `test`
(vitest over the pure modules and the bridge's helpers), `lint`.

### Data access

The browser only ever speaks MCP: `@modelcontextprotocol/sdk`'s `Client` over
the **Streamable HTTP** transport, calling the `repos` and `query` tools.
Nothing imports `@omgbase/core`.

The *MCP settings* panel offers three ways to reach a server:

- **local sample** — `scripts/dev-mcp.mjs` spawns `omg mcp -C .dev-workspace`
  (stdio) per MCP session and relays JSON-RPC to a
  `StreamableHTTPServerTransport` on `localhost:8787/mcp`, with CORS headers
  (`Mcp-Session-Id` exposed). It is the same shape as
  [usergenic/stdio-mcp-to-http](https://github.com/usergenic/stdio-mcp-to-http);
  that proxy is not on npm and sends no CORS headers, so the browser could not
  use it directly.
- **via local proxy** — the same bridge started with `--remote <mcp-url>`:
  one upstream `StreamableHTTPClientTransport` session per browser session,
  the bridge holding the OAuth tokens (see [Try it against a remote
  omgbase](#try-it-against-a-remote-omgbase)). The panel shows the upstream URL
  and the identity the bridge reports on `GET /whoami` (`{ mode, upstream,
  identity, auth: { state, issuer, authorizationUrl?, error? }, tokenFile,
  sessions }`), and warns when the bridge is actually serving the local sample.
- **direct** — for hosted deployments: the page connects to the remote itself
  and the *browser* is the OAuth client. This needs CORS on the gateway and web
  origins in Auth0 — see [Direct mode: the browser as the OAuth
  client](#direct-mode-the-browser-as-the-oauth-client-for-hosted-deployments).

The bridge's session table maps each browser-facing `Mcp-Session-Id` to its
upstream (`omg mcp` pid, or the gateway's session id); a browser `DELETE` ends
the upstream session too, and sessions idle for `--idle` seconds are closed.

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

**Edges** are fetched with generated OQX over the `edges` target:

```oqx
select src: $path, dst: $dst_path from edges
where src_field == "after" && provenance == "frontmatter"
  && ($path == "timeline/kickoff.md" || $path == "timeline/alpha.md" || …)
```

in chunks of 40 paths, then filtered client-side to edges whose both ends are
shown. OQX has no array literal (`$path in [...]` is a lex error) and `in` only
takes a lifted set or a range, hence the disjunction. The nested alternative
(`select $path, out: doc.out_edges collect { select dst: $dst_path, src_field }
from docs where …`) also works against the engine; the flat rows were simpler to
merge across chunks and page with the tool's cursor. Links (`doc.out`) and
backlinks (`doc.in`) use the same query with `provenance == "link"`; backlinks
are the same rows reversed. A sequence candidate (an `order by` key) needs no
fetch — its edges are consecutive result rows.

## The elements

| Element | Properties | Events |
| --- | --- | --- |
| `<oqx-query-editor>` | `value` (source), `highlights` (`Span[]`, code points), `debounce` | `query-change` `{ source, query: Query \| null, error: { message, offset, stage } \| null }` |
| `<oqx-relationship-picker>` | `candidates: Candidate[]`, `overrides: Overrides`; getter `view`; `reset()` | `view-change` `{ view: { edges: string[], layout: { axis, direction } }, overrides }`, `candidate-hover` `{ candidate \| null }` |
| `<oqx-graph>` | `nodes: GraphNode[]`, `view: View`, `candidates`, `fetchEdges: (candidate, paths) => Promise<GraphEdge[]>`, `selected` | `node-select` `{ node \| null }`, `graph-state` `{ edges, cycles, layout, busy, error }` |

`src/app.ts` composes them with `@lit-labs/signals`:
`source → ast → rows → candidates → view`, and the graph element does
`view → edges → layout` with the fetcher the page hands it.

## Inference rules (`src/lib/candidates.ts`)

The one module that reads the AST. When omgbase ships a `query_analyze` tool
returning candidates with roles, the page feeds that into the picker and this
module becomes the fallback.

1. **`follow` destinations.** A plain relation is itself a candidate (`doc.out`
   = links, `doc.in` = backlinks with direction *backward*, a bare name = a
   frontmatter relation). A **destination block** (`$repo.docs collect { where … }`)
   is read through its correlated `where`: a bare property of the candidate row
   compared against an outer reference (`after.contains("/" + ^$path)`) names
   the relation `after` with direction *backward* (the edge is stored on the
   successor and points at the frontier); an outer property (`("/" + $path) in
   ^before`) names `before`, *forward*; a `src_field == "x"` / `predicate ==
   "x"` literal under `doc.in_edges` / `doc.out_edges` / `edges` names `x`
   (*forward* for in_edges, *backward* for out_edges).
2. **`order by` keys** that are not `$`-intrinsics become *sequence*
   candidates (edges = consecutive rows; `desc` → backward).
3. **Inferred from rows**: a projected field whose values are a doc path or a
   list of doc paths (`*.md`, optionally `/`-rooted). Names in a small
   "looks-backward" vocabulary (`after`, `prev`, `parent`, `depends_on`, …)
   default to *backward*.

Defaults: every `follow` candidate is drawn; inferred fields are drawn only
when the query has no `follow`; sequences are never drawn by default. The layout
axis is the first `follow` candidate, else the first sequence key, else the
first inferred field (timeline words first), else none. Overrides live beside
the view (`src/lib/view.ts`); an override naming a vanished candidate is dropped.

## Gaps found in the public API

- **Paths disagree with frontmatter paths.** `$path` is `timeline/kickoff.md`
  while a `/`-rooted frontmatter value is `/timeline/kickoff.md`, so the
  natural `after.contains(^$path)` matches nothing; the demo writes
  `"/" + ^$path`. A normalised comparison (or a `$root_path` intrinsic) would
  make destination blocks over frontmatter relations idiomatic.
- **`follow <frontmatter list>` yields junk rows.** `follow before` over a list
  of path strings produces a row with `id: "undefined"` and an empty path
  instead of an error or a resolution to documents.
- **`select frontmatter` leaks the lazy handle** (`{ docId, source }`) rather
  than the bag; `entries(frontmatter) collect { k: $key, v: $it }` is the way
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

## Sample data

`sample/` is a 20-document project notebook: a release timeline authored through
`before`/`after` frontmatter (`/`-rooted paths — only `/`-rooted strings and
`[[wikilinks]]` become frontmatter edges, see `spec/graph` §3.1), two branches
(`docs-draft`, `security-audit`) that rejoin at `launch`, a deliberate three-note
cycle (`loop-a` → `loop-b` → `loop-c` → `loop-a`), `owner` relations into
`people/`, `see_also` under `topics/`, and ordinary Markdown links.
