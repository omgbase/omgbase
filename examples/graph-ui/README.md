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
pnpm --filter graph-ui dev --remote https://mcp.example.com/omg
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
[mcp-bridge] sign-in required for https://mcp.example.com/omg
[mcp-bridge] issuer: https://dev-….us.auth0.com/
[mcp-bridge] open this URL in your browser if it does not open by itself:
[mcp-bridge]   https://dev-….us.auth0.com/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2F127.0.0.1%3A51763%2Fcallback&scope=offline_access&prompt=consent&resource=https%3A%2F%2Fmcp.example.com%2Fomg
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
pnpm --filter graph-ui dev          # copies ./sample into .dev-workspace/sample and indexes it, starts the MCP bridge, starts Vite
```

Open <http://localhost:5173>. Vite proxies `/mcp` and `/whoami` to the bridge
(port 8787, `GRAPH_UI_MCP_PORT`), so the page's default server URL is just
`/mcp` and *MCP settings* starts in **local sample** mode. The default query walks the sample's release
timeline from `kickoff.md` both ways — back through each document's own
`before`, forward through the documents whose `after` names it:

```oqx
select $path, title, phase, before, after
from docs
where $path == "/timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ^$path in list(after) }
order by $ordinal
```

(That is the query for a surface-2.0 server; against a 1.x server the page
shows `where $path == "timeline/kickoff.md"` and `("/" + ^$path) in list(after)`
instead — see [Server versions](#server-versions).)

**Why `refs()`.** `before` holds document *references* — strings like
`/timeline/alpha.md` — not documents. `follow before` walks the strings, and
since surface 1.5 the server refuses that (`filter_invalid`: "a hit must be a
document, block, node or edge row — the query reached a string …"; before 1.5
it rendered a junk `{ id: "undefined", path: "" }` hit, which this demo drew
as a phantom node). `refs(before)` resolves each reference (`/`-rooted or bare
path, or a `d_` id; dangling ones dropped) to the live document, so it is the
`follow` destination that means "the documents `before` names". The editor
says so under the query whenever a destination is a bare field.

**Why `$it.in` for the backward hop.** The engine has no `refs⁻¹`: there is no
function giving "the documents whose `after` names me". But a `/`-rooted
frontmatter reference *is extracted as an edge* (`spec/graph` §3.1,
`provenance: frontmatter`), so the frontier's backlinks (`$it.in`, the same
relation as `doc.in`) already contain every document whose `after` — or any
other field, or a body link — points at it. The destination block narrows those
to the ones whose `after` really says so (`^$path in list(after)`; `list()`
makes a scalar and a list read alike). It is an indexed lookup per frontier
row, unlike the full-scan fallback, which still works:

```oqx
follow refs(before), ^docs collect { where after.contains(^$path) }
```

(`^docs` is the root `docs` collection seen from inside the block; `$repo.docs`
spells the same thing.) The comparison works because, since surface 2.0,
`$path` is `/`-rooted like the authored reference it is compared with; on a
1.x server `$path` is bare (`timeline/kickoff.md`) and the same block reads
`("/" + ^$path) in list(after)` — the next section.

### Server versions

The omgbase surface changed its path form in 2.0 (`spec/surface` §1 "Paths"):
every path a query or a tool **returns** is `/`-rooted (`$path`, `$dst_path`,
a hit's `path`, `docs_read`'s `path`, …), every path a tool **accepts**
tolerates both forms, and a string literal compared with `$path` by `==` (or
passed to `startsWith`) is rooted before evaluation, so `$path == "a.md"` and
`$path == "/a.md"` both match. A 1.x server (surface 1.5 is what Brendan's
remote gateway runs today) returns the storage form — `timeline/kickoff.md` —
and matches only a bare literal. Authored frontmatter references are
`/`-rooted on both (that is what the repositories hold; only a `/`-rooted
string becomes a graph edge), so correlating the current row with a reference
is `"/" + ^$path` on 1.x and plain `^$path` on 2.0. The keyset cursor also
changed shape and a 1.x cursor is refused by 2.0.

The demo works against both. On connect it calls the `version` tool once and
reads `specs.surface` (`"major.minor"`); a server without the tool is taken
as `1.x`. The result is the `serverSurface` signal, shown in the header
(`· surface 2.0`), and everything path-shaped goes through the adapter
`src/lib/paths.ts`:

| | |
| --- | --- |
| `rooted(p)` / `unrooted(p)` | the two forms (idempotent) |
| `samePath(a, b)` | equal modulo the leading slash |
| `pathExpr(surface, ref = "$path")` | the OQX that yields the rooted path of `ref`: `$path` on ≥ 2.0, `"/" + $path` before (`pathOperand` parenthesizes the latter) |
| `serverPath(surface, p)` | a `$path == "…"` literal in the server's form: bare on 1.x, rooted on 2.0 |
| `docArg(surface, doc)` | a tool's `doc` argument: a path is de-rooted for 1.x; an id passes through |
| `surfaceOf(versionResult)` | `specs.surface`, else `"1.x"` |

Nodes are keyed by the rooted path whatever the server returned, so a 1.x hit
and a 2.0 hit for one document share a key, and the edge fetch roots the rows'
`$path`/`$dst_path` before matching them to the shown nodes while spelling its
`$path == "…"` literals in the server's form. The default query is generated
from `pathExpr` for the connected server and swapped when the version changes
with the connection — only while the editor still holds a default (any
version's, or an earlier one), never a user's edit. Candidate inference reads
`"/" + ^$path` and bare `^$path` alike as the correlation idiom. The value
form of an edited field is still inferred from the field's existing values
(leading slash or not), never from `$path`. The page never stores a cursor
(`queryAll` follows one within a single call), so nothing is left to discard on
a version change. Two hints under the editor catch the mismatch: on a 2.0
server a `"/" + ^$path` (or `"/" + $path`) in the query gets "`$path` is
already `/`-rooted on this server; use `^$path`"; on a 1.x server a bare
`^$path` compared directly with a property (`^$path in list(after)`,
`after.contains(^$path)`) gets "this server's `$path` has no leading slash; use
`"/" + ^$path`". A literal (`$path == "a.md"`) is never flagged.

Try: `select $path, title, before from docs where phase == "experiment" || phase == "plan"`
(no `follow` — the candidates are *inferred* from the projected path-valued
fields, and the three `loop-*` notes trigger the cycle banner); `follow doc.out`
for the link graph; `order by phase` for a sequence axis; `follow before` to
see the hint and the server's error (with the `refs()` fix) in the status line.

Scripts: `dev [--remote <url>]` (all of it; the bridge's flags are consumed,
anything else goes to Vite), `dev:workspace [--force]` (just the workspace),
`dev:mcp [--port 8787] [--path /mcp] [--idle 600] [--workspace <dir>]
[--remote <url>] [--no-browser] [--token-file <f>]` (just the bridge),
`logout [--remote <url>]`, `build` (`tsc --noEmit` + `vite build`), `test`
(vitest over the pure modules and the bridge's helpers), `lint`.

### Data access

The browser only ever speaks MCP: `@modelcontextprotocol/sdk`'s `Client` over
the **Streamable HTTP** transport, calling the `repos` and `query` tools (plus
`tools/list`, `docs_read` and `docs_set_meta` for [editing edges](#editing-edges)).
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
  && ($path == "/timeline/kickoff.md" || $path == "/timeline/alpha.md" || …)
```

in chunks of 40 paths (the literals bare against a 1.x server — see [Server
versions](#server-versions)), then filtered client-side to edges whose both
ends are shown. OQX has no array literal (`$path in [...]` is a lex error) and `in` only
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
| `<oqx-query-editor>` | `value` (source), `highlights` (`Span[]`, code points), `serverSurface` (`"major.minor" \| "1.x" \| null`, for the path-form hints), `debounce` | `query-change` `{ source, query: Query \| null, error: { message, offset, stage } \| null }` |
| `<oqx-relationship-picker>` | `candidates: Candidate[]`, `overrides: Overrides`, `editable: Record<name, Editability>`, `armed: string \| null`; getter `view`; `reset()`, `arm(name \| null)` | `view-change` `{ view: { edges: string[], layout: { axis, direction } }, overrides }`, `candidate-hover` `{ candidate \| null }`, `armed-change` `{ candidate \| null }` |
| `<oqx-graph>` | `nodes: GraphNode[]`, `view: View`, `candidates`, `fetchEdges: (candidate, paths) => Promise<GraphEdge[]>`, `selected`, `armed: Candidate \| null`, `writable: string[]`, `pending: PendingEdge[]` | `node-select` `{ node \| null }`, `edge-toggle` `{ candidate, from, to, present }`, `graph-state` `{ edges, cycles, layout, busy, error }` |

The graph's bottom-left legend lists the drawn relationships by colour (the
axis marked); while the modifier is held in edit mode a second legend,
bottom-right, names the three edge styles — *will add* (blue dashed), *will
remove* (red dashed), *writing…* (the in-flight dashed edge).

The editor's status area also carries the hints from `src/lib/hints.ts` (see
[Inference rules](#inference-rules-srclibcandidatests)).

`src/app.ts` composes them with `@lit-labs/signals`:
`source → ast → rows → candidates → view`, and the graph element does
`view → edges → layout` with the fetcher the page hands it. Edge edits flow
the other way: `edge-toggle` → `src/lib/edit.ts` (the plan) →
`src/lib/mutations.ts` (`docs_set_meta`) → re-run the query.

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
*will add* (the edge is absent: a blue dashed line, marching and pulsing,
labelled `+ after`) or *will remove* (the edge is drawn: it is overlaid in red
with the same pulse and a `remove after` label), and the banner names the
concrete action and the file whose field changes. Hovering a drawn edge of a
writable relationship with the modifier held previews its removal the same way.
Hovering the selected node, empty canvas, or a read-only edge shows nothing,
and ⌘-clicking empty canvas does nothing. With the modifier held but no
selection or no armed relationship the banner shows a quiet hint instead.
Pending (in-flight) edges keep their own static dashed style in the
relationship's colour so they are never mistaken for a preview; while in edit
mode a small legend in the bottom-right corner names the three (*will add*,
*will remove*, *writing…*). Under `prefers-reduced-motion` the previews are
static dashed lines. The decision — which edge, add or remove, who owns it — is
`previewFor` in `src/lib/preview.ts`, unit-tested without a DOM.

**Which file changes.** The edge is written where the relationship is stored —
the document whose frontmatter field names the other one — and the inverse
field is never touched. For a *forward* candidate (`before`) that is the
selected document (`selected.before` gains the target); for a *backward* one
(`after`, drawn target → selected) it is the clicked document (`target.after`
gains the selected one). By default a one-line strip shows the file, the field
and the new value before anything is written (`write /timeline/beta.md · set
after: […] via docs_set_meta?`); untick *confirm before writing* to skip it.

**What gets written.** The field's current value comes from the result row when
the query projected the field under its own name (`select … after`), else from
`docs_read` of the owner, so a toggle never clobbers values the query did not
select. A scalar field is set to the reference (or unset on remove); a list is
appended to / filtered, order preserved, duplicates (by identity, in any
spelling) dropped; a list that loses its last member is unset (the *emptied
list* setting can keep `[]` instead). The call is `docs_set_meta { doc, set: {
field: value } }` or `{ unset: [field] }`; writes to one document are queued so
two quick toggles cannot race (there is no CAS on `docs_set_meta`). Then the
query re-runs and the edges are refetched.

**Value form.** New references are spelled the way the field already spells
them, inferred from its values across the rows: leading `/` or not, `.md` or
not, path or doc id (`d_…`). A field with no values yet borrows the dominant
form among all reference fields in the rows, else `/path.md`; whether it
becomes a list or a scalar follows the same inference (ties → list). A field
whose existing values disagree (`/a.md` next to `b.md`) is refused with a
message until they agree. The server's path form plays no part in this: the
values are the author's, `/`-rooted in these repositories whether `$path` comes
back bare (surface 1.x) or rooted (2.0).

**Writable or not.** Writable candidates are exactly the frontmatter relations
whose sampled values are document references (a `/`-rooted repo path, a bare
repo path, or a doc id — scalar or list). The rest show *read-only* with a
reason: `doc.out` / `doc.in` ("links live in the body"), an `order by` key
("derived from order by …"), a frontmatter field holding something else
("values are not document references"), or a server that does not offer the
tool.

**Gateway allowlist.** Through a gateway (proxy or direct mode) the gateway's
tool allowlist must include `docs_set_meta` (and `docs_read`, used when the
field was not projected). The page lists the server's tools on connect and
shows every relationship read-only when `docs_set_meta` is missing; a refusal at
write time is reported with the same hint.

**Limits.** Body links (`doc.out`, `doc.in`) and derived sequences are
read-only. Nested property paths (`meta.rel`) are not edited. Edits are per
document: the inverse relation (e.g. `before` when you edit `after`) is not
maintained — the engine has no field definitions declaring inverses. In the
local sample the writes land in `.dev-workspace/sample/` (a copy of `sample/`
made by `dev:workspace`; `pnpm --filter graph-ui dev:workspace --force` resets
it). Try the scalar path with `select $path, title, owner from docs where
$path.startsWith("/timeline/") || $path.startsWith("/people/")` (`owner` is a
scalar `/people/….md`; drop the leading slashes against a 1.x server) and the
list path with the default query's `after`.

## Inference rules (`src/lib/candidates.ts`)

The one module that reads the AST. When omgbase ships a `query_analyze` tool
returning candidates with roles, the page feeds that into the picker and this
module becomes the fallback.

1. **`follow` destinations.** `refs(<field>)` (and `refs(^<field>)`) names the
   frontmatter relation `<field>` with direction *forward* — the frontier row
   owns the field and names its successors; it is the same candidate a bare
   `follow <field>` would give (same name and kind, merged with the inferred one
   from the rows, written the same way), now meaning the documents. A plain
   relation is itself a candidate (`doc.out` / `out` / `$it.out` = links,
   `doc.in` / `in` / `$it.in` = backlinks with direction *backward*, any other
   bare name = a frontmatter relation — flagged by the editor's hint, since it
   follows the strings). A **destination block** (`$repo.docs collect { where
   … }`, `^docs collect { … }`, `$it.in collect { … }`, `refs(before) collect {
   … }`) is read first through its receiver — `refs(<field>)` names `<field>`,
   *forward* — then through its correlated `where`: a bare property of the
   candidate row compared against an outer reference (`^$path in list(after)`,
   `after.contains(^$path)`, or the 1.x spellings `("/" + ^$path) in
   list(after)`, `after.contains("/" + ^$path)`) names the relation `after` with
   direction *backward* (the edge is stored on the successor and points at the
   frontier); an outer property (`$path in ^before`) names `before`,
   *forward*; a `refs()` receiver of a nested directive follows the same two
   cases (`refs(after) exists { where $path == ^^$path }` → `after` *backward*,
   `refs(^before) exists { … }` → `before` *forward*); a `src_field == "x"` /
   `predicate == "x"` literal under `doc.in_edges` / `doc.out_edges` / `edges`
   names `x` (*forward* for in_edges, *backward* for out_edges).
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

**Hints and server errors** (`src/lib/hints.ts`, `src/lib/errors.ts`). The same
AST reading drives the non-blocking messages. Under the editor: when a `follow`
destination is a bare frontmatter-looking field (not `refs(…)`, not a block,
not `doc.out`/`doc.in`/`in`/`out`/`children`/`subsections`/`$it.…`), the
status area adds "`before` holds document references; `follow refs(before)`
walks the documents (a bare field follows the strings)" and dot-underlines the
destination; the query still runs. The two path-form hints ([Server
versions](#server-versions)) appear the same way once the server's version is
known. In the footer: the server's surface-1.5
`filter_invalid` ("a hit must be a document, block, node or edge row — the
query reached a string ("/timeline/beta.md"); … use refs(<field>)") is shown
with its remedy made concrete from the AST — `try follow refs(before)` — or the
engine's own `refs(<field>)` when no bare destination names the field.

## Gaps found in the public API

- ~~**Paths disagree with frontmatter paths.**~~ Fixed in surface 2.0: `$path`
  is `/`-rooted like an authored reference, so `^$path in list(after)` needs
  no `"/" +`; the demo keeps the 1.x spelling for 1.x servers ([Server
  versions](#server-versions)).
- **No inverse of `refs()`.** `refs(before)` walks forward; "the documents whose
  `after` names me" has no function and is spelled as a backlink block
  (`$it.in collect { where ^$path in list(after) }`) — correct because
  frontmatter references are edges, but a `referrers(after)` (or a field
  definition with `inverse_of`) would make the backward hop as short as the
  forward one.
- ~~**`follow <frontmatter list>` yields junk rows.**~~ Fixed in surface 1.5: a
  hit that is not a store row is a `filter_invalid` naming the value and
  `refs(<field>)`; `refs(x)` resolves the references. The demo shows the hint
  before the run and the error after it.
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
- **No CAS on `docs_set_meta`.** The patch is merged into whatever the file
  holds when it lands; the UI serializes its own writes per document but cannot
  detect a concurrent edit (an `expect: { rev }` like the block ops' `expect`
  would). There is also no server-side list toggle (`add`/`remove` a member),
  so the client reads the whole value, edits it, and writes it back.
- **No inverse-field knowledge.** Editing `after` does not maintain `before`;
  a field definition with `inverse_of` would let the UI (or the engine) keep both.
- **Projected-but-absent is indistinguishable from not projected** in a hit:
  a document without `after` yields a row without the key, so whether a row's
  value is authoritative has to be read off the AST (`projectedFields`).

## Sample data

`sample/` is a 20-document project notebook: a release timeline authored through
`before`/`after` frontmatter (`/`-rooted paths — only `/`-rooted strings and
`[[wikilinks]]` become frontmatter edges, see `spec/graph` §3.1; the references
stay rooted whatever surface version serves them), two branches
(`docs-draft`, `security-audit`) that rejoin at `launch`, a deliberate three-note
cycle (`loop-a` → `loop-b` → `loop-c` → `loop-a`), `owner` relations into
`people/`, `see_also` under `topics/`, and ordinary Markdown links.
