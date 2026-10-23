# webdevproxy — a development-only local web proxy for MCP servers

A small Node program (no build step) that lets the browser demos in this
repository — [`graph-ui`](../graph-ui/README.md), [`live-tail`](../live-tail/README.md),
[`repo-explorer`](../repo-explorer/README.md) — reach an **omgbase MCP server**
from a Vite dev server without any CORS or OAuth setup on the server side. The
page talks to `localhost`; the proxy talks to the server. It is **private,
unpublished and not for production**: it listens on `127.0.0.1` only, holds
your bearer tokens, and allows exactly the browser origins a dev setup needs.

The proxy is **spelling-agnostic**: it relays JSON-RPC messages verbatim in
both directions (`src/proxy.mjs` hands each message to the upstream transport
and each answer back unchanged — no tool-name or argument allowlist, no
rewriting of result keys or error bodies), so a surface 5.0 server's
`_`-prefixed engine names (`_id`, `_path`, `_raw`, …), its `filter_invalid`
refusal of a bare `path` argument and the `data.fix` it carries reach the page
exactly as `omg mcp` wrote them. Nothing in the proxy knows which tools exist;
only the `initialize` result is inspected, for the protocol version the
upstream negotiated.

Two modes, one flag each:

| mode | flag | what the proxy does |
| --- | --- | --- |
| **local** | `--local <workspace-dir>` | spawns one `omg mcp -C <dir>` child (stdio) per browser session and relays JSON-RPC verbatim |
| **remote** | `--remote <mcp-url>` | opens one upstream Streamable HTTP session per browser session at a remote gateway and is **itself the OAuth client** — a native app with a loopback redirect, dynamic client registration (or one pre-registered public client, [`--client-id`](#a-pre-registered-client---client-id)), PKCE and a refresh token kept in a `0600` file; the browser never sees the gateway or the identity provider |

Either way the browser side is the standard MCP **Streamable HTTP** transport
(`@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`) on
`http://127.0.0.1:8787/mcp`, with CORS for `http://localhost:*` and
`http://127.0.0.1:*` (`--origin` adds more) and `Mcp-Session-Id` exposed. The
stdio shape is the same as [usergenic/stdio-mcp-to-http](https://github.com/usergenic/stdio-mcp-to-http),
which could not be reused because it is not on npm and sends no CORS headers.

## Usage

```
webdevproxy --local <workspace-dir> [--omg <omg entry or binary>]
webdevproxy --remote <mcp-url> [--client-id <id> [--callback-port <n>]] [--reset-client] [--no-browser] [--token-file <file>]
webdevproxy --logout [--remote <mcp-url>] [--token-file <file>]
```

| flag | meaning |
| --- | --- |
| `--local <dir>` | spawn `omg mcp -C <dir>` per browser session |
| `--repo <slug>` | the repository: in local mode `omg mcp --repo <slug>` makes it the server's default; every mode reports it on `/whoami` (`repo`), so a page whose server offers no `repos` tool — the minimal profile — knows which `repo` argument to send (`WEBDEVPROXY_REPO`) |
| `--tools <profile>` | the catalog profile the local `omg mcp` serves, `full` or `minimal` (`omg mcp --tools`; default: the workspace's `mcp.tools` setting, else full); reported on `/whoami` (`tools`). Local mode only (`WEBDEVPROXY_TOOLS`) |
| `--omg <path>` | the omg CLI: a `.js` entry (run with the current `node`) or a binary; default `WEBDEVPROXY_OMG`, else the monorepo's `packages/cli/dist/src/main.js` when it exists, else `omg` on `PATH` |
| `--remote <url>` | relay to a remote MCP endpoint (`http(s)`); the proxy signs in |
| `--client-id <id>` | present this **pre-registered public client** to the issuer instead of registering one dynamically — one application for every run, so an issuer that caps registrations (Auth0's `too_many_entities`) never fills up; the id is configuration, not state (`--logout` and `l` keep it). Settings the application needs: [below](#a-pre-registered-client---client-id) |
| `--callback-port <n>` | bind the sign-in loopback listener to this port, so the `redirect_uri` is exactly `http://127.0.0.1:<n>/callback`. Default: an ephemeral port — but **`8790` with `--client-id`**, because the application's allowed callback URL must name the port (Auth0 accepts no port wildcard). A fixed port that is taken is a start-up error naming this flag, never a silent switch to another port |
| `--reset-client` | forget the client registration stored for the remote (and the tokens issued to it) and register anew at start-up — the flag for a gateway whose sign-in page says **Unknown client** (it registers clients itself and was restarted with a fresh state directory). The proxy normally notices that by itself ([below](#unknown-client)); this is the explicit way, the `r` key its no-restart twin |
| `--port <n>` | listen on `127.0.0.1:<n>` (default `8787`; `0` = an ephemeral port, for tests) |
| `--path <p>` | the MCP endpoint path (default `/mcp`); `GET /whoami` is always served |
| `--idle <seconds>` | close a browser session **and its upstream** (the `omg mcp` child, or the remote session) after this long without a request (default `3600`; `0` = never). A page that comes back later gets `404 unknown session` on its next POST and must `initialize` again — see [Session recovery](#session-recovery) |
| `--origin <origin>` | allow this browser origin too (repeatable; `*` wildcards a port: `http://app.local:*`) |
| `--no-browser` | print the sign-in URL instead of opening a browser (over SSH) |
| `--token-file <file>` | where the remote's tokens live (default below) |
| `--logout` | delete the token file(s) and exit |
| `--help` | the usage text |

Environment fallbacks: `WEBDEVPROXY_LOCAL`, `WEBDEVPROXY_OMG`, `WEBDEVPROXY_REMOTE`,
`WEBDEVPROXY_CLIENT_ID`, `WEBDEVPROXY_CALLBACK_PORT`, `WEBDEVPROXY_PORT`, `WEBDEVPROXY_PATH`,
`WEBDEVPROXY_ORIGIN` (comma-separated), `WEBDEVPROXY_TOKEN_FILE`, `WEBDEVPROXY_NO_BROWSER`.
A flag wins over its variable.

`--local` and `--remote` are exclusive; one of them is required (except with
`--logout`/`--help`). The listener binds `127.0.0.1` and nothing else.

### `GET /whoami`

The proxy describes itself for a page's status line:

```json
{
  "mode": "remote",
  "upstream": "https://mcp.example.com/omg",
  "identity": { "email": "brendan@example.com", "name": null, "subject": "auth0|…" },
  "auth": { "state": "ok", "issuer": "https://example.us.auth0.com/", "recovered": true, "recoveredAt": "2026-10-12T19:04:11.512Z", "client": { "source": "registered", "id": "aBc123…" } },
  "tokenFile": "/home/me/.config/omgbase-webdevproxy/0123456789abcdef.json",
  "sessions": [{ "id": "<browser Mcp-Session-Id>", "upstream": "<gateway session id or omg mcp pid>" }]
}
```

In local mode `mode` is `"local"`, `upstream` is `omg mcp -C <dir>`, `identity`
and `tokenFile` are `null` and `auth` is `{ "state": "none" }`. `auth.state` is
`"waiting"` while the sign-in is open in your browser (with
`authorizationUrl` — the demos render it as a link, for a browser that did not
open by itself), `"error"` with `error` when it failed, `"ok"` when tokens are
in hand, `"unknown"` before the first upstream request. `recovered: true` (with
`recoveredAt`) is on an `"ok"` the proxy reached by replacing a stored sign-in
the issuer had rejected with a fresh one, by itself (below) — a page can say
"signed in again" rather than nothing. `client` says which OAuth client the
proxy presents: `{ "source": "configured", "id" }` with [`--client-id`](#a-pre-registered-client---client-id),
else `{ "source": "registered", "id" }` — the file's dynamic registration, `id`
`null` before the first one (client ids are public). The type is `WhoAmI` in
[`index.d.ts`](./index.d.ts); the demos poll it while `waiting`.

### The remote sign-in

On start in remote mode the proxy sends the gateway one unauthenticated
`initialize`, follows the `401`'s `WWW-Authenticate: Bearer resource_metadata=…`
to the protected-resource metadata (RFC 9728) and the issuer's metadata
(RFC 8414 / OIDC), registers a public client (RFC 7591, PKCE, loopback redirect
URIs `http://127.0.0.1:<ephemeral>/callback` and `http://localhost:<port>/callback`),
prints the authorization URL and opens your browser once:

```
[webdevproxy] no client registration for https://mcp.example.com/omg yet — one is registered with the issuer at the first sign-in
[webdevproxy] registered client abc123 with https://example.us.auth0.com/ for https://mcp.example.com/omg
[webdevproxy] sign-in required for https://mcp.example.com/omg
[webdevproxy] issuer: https://example.us.auth0.com/
[webdevproxy] open this URL in your browser if it does not open by itself:
[webdevproxy]   https://example.us.auth0.com/authorize?response_type=code&client_id=…
[webdevproxy] waiting for the sign-in to finish (listening on http://127.0.0.1:51763/callback)…
```

Consent lands on the loopback listener, the code is exchanged, and from then on
every browser session gets its own upstream session with the bearer added per
request; a `401` later is answered with a silent refresh (`offline_access`).

The registration is kept in the token file **with the issuer it was made with**
(`clientIssuer`) and the loopback port its `redirect_uris` name; a later start
says which client it presents — `presenting the client registration abc123 for
https://mcp.example.com/omg (registered with https://example.us.auth0.com/)` —
and reuses that port when it is free. A registration made with another
authorization server (the gateway changed its identity provider), or whose
redirect URIs do not name the port the proxy could bind, is dropped and the
client registered anew rather than presented to an issuer that would refuse it.

**When the stored sign-in is dead** — the gateway or its identity provider was
reset or upgraded, the refresh token or the client registration revoked — the
proxy recovers by itself, once per `401` round, at start-up (the probe) as well
as later:

| the issuer answers the refresh with | the proxy clears | then |
| --- | --- | --- |
| `invalid_grant`, any other OAuth error, or a bare `400`/`401` from the token endpoint | `tokens` (and the cached `discovery`) | rediscovers from the `401`'s `WWW-Authenticate` and opens the browser again |
| `invalid_client` / `unauthorized_client`, or a `400`/`401` from the registration endpoint | everything (`clientInformation`, `tokens`, `discovery`) | re-registers the client, then the browser — except with [`--client-id`](#a-pre-registered-client---client-id), where a rejected id is a configuration error reported as such, never a registration |
| something that is not an OAuth answer at all (a `404` page: the token endpoint moved) while working from cached metadata, or a registration refused with another status on cached metadata | `discovery` only | rediscovers and retries the refresh — silently when the refresh token is still good |
| **before** asking the issuer: the file has tokens but no `clientInformation` (a lost registration — not with `--client-id`, where no registration is needed), or tokens without a `refresh_token` | `tokens` (and `discovery`) | logs `stored sign-in for <url> has no client registration; registering and signing in again` (or `… has no refresh token; signing in again`), registers if needed, opens the browser |
| **before the browser opens** with a registration this round did not make (no tokens at all — the state after `a`, or a gateway reset between the registration and the consent — or a refresh refused for another reason): the proxy asks the token endpoint whether it still knows the client (one refresh request with a bogus token, `client_id` alone) and it answers `invalid_client` / `unauthorized_client` | everything | registers anew and opens the browser as the **new** client, in the same round — `stored sign-in for <url> was rejected (the client registration <id> is unknown to <issuer> (invalid_client: the gateway was reset or started with a fresh state directory)); signing in again`. Any other answer (`invalid_grant` = the client is known; a 5xx; no OAuth body) is no verdict: the browser flow goes ahead as before |
| at start-up: the registration was made with another authorization server than discovery now names (`clientIssuer`), or its `redirect_uris` do not name the loopback port the proxy bound | `clientInformation` | registers with the issuer the server names now, on our port — `the client registration <id> for <url> was made with <old issuer>, not <issuer> — registering anew` / `… names <uris>, not <our redirect URL> — registering anew` |

It logs one line, `[webdevproxy] stored sign-in for <url> was rejected (<reason>);
signing in again` (`stored issuer metadata for <url> is stale (…); rediscovering`
for the last row), then the usual sign-in lines; `/whoami` reports
`recovered: true`. (A registration without tokens is the normal state between
the first registration and consent; nothing is said.) Only when the fresh sign-in
**also** fails (you declined, the code exchange failed, the issuer refuses to
register the client) does `auth.state` become `"error"` — with a message that is
never empty: the SDK's error for an issuer answer without `error_description` has
none, so the proxy says where it was and what the issuer's body said (`the issuer
refused to register the client (HTTP 403: Forbidden: You reached the limit of
entities of this type for this tenant. (too_many_entities)); the issuer's
application limit is full — delete stale auto-registered clients in the tenant's
dashboard, then press a + Enter` — Auth0 caps dynamic registrations per tenant;
a registration is never dropped for a token-side failure, so the cap fills only
with lost files) — and that is never
retried by itself: the next `401` is one more browser flow, no refresh, so a
broken issuer costs one browser tab per request round, not a loop. A failure
inside the browser flow is never mistaken for a dead credential. Concurrent
`401`s share the one sign-in.

<a id="unknown-client"></a>
**"Unknown client"** on the gateway's sign-in page (`This client is not
registered with the gateway. MCP clients register automatically; if the gateway
was restarted with a fresh state directory, reconnect from the client to
register again. client_id: …`) means exactly that: the `client_id` the proxy
presented is a registration the gateway's state no longer holds. That page is
the authorization server's — it never redirects back to the loopback (RFC 6749
§4.1.2.1), so without the check in the row above the proxy would sit in
`waiting` for a sign-in that cannot finish. With it, the proxy drops the dead
registration and registers anew before the browser opens; if you still see the
page (the token endpoint did not say `invalid_client`), press **`r` + Enter**
in the proxy's terminal — or restart it with **`--reset-client`**, or run
`webdevproxy --logout --remote <url>` — and the next sign-in is as a fresh
client. Both drop the registration and its tokens for this server only, nothing
else. With `--client-id` there is no registration to drop: a rejected fixed id
is a configuration error, and when the issuer advertises a `registration_endpoint`
the message says so — `the issuer advertises a registration endpoint — drop
--client-id / WEBDEVPROXY_CLIENT_ID and the proxy registers a client by itself`.

### A pre-registered client (`--client-id`)

Every MCP client that signs in to a gateway through dynamic registration (RFC
7591) — Claude Code, the inspector, this proxy — creates **one more
application** at the identity provider, and nothing ever deletes them. Auth0
caps applications per tenant, and a full tenant answers every registration
with `403 too_many_entities` (the error above). `--client-id <id>` (or
`WEBDEVPROXY_CLIENT_ID=<id>`; the flag wins) makes the proxy present **one
application you created by hand** instead:

```sh
webdevproxy --remote https://mcp.example.com/omg --client-id aBc123…
# the sign-in redirect is then exactly http://127.0.0.1:8790/callback (--callback-port <n> to change it)
```

- **No registration, ever.** The provider's `clientInformation()` answers
  `{ client_id: <id>, token_endpoint_auth_method: "none" }` whatever the token
  file holds, so the SDK skips registration and goes straight to the PKCE
  authorization request as that client; the registration endpoint is never
  called — not on the first run, not on a refresh, not when a dead refresh
  token sends it back to the browser, not after `a`, `l` or `--logout`. The
  start-up log says `using the configured client id <id> (no dynamic
  registration)` and `sign-in callback fixed at http://127.0.0.1:8790/callback —
  the application's allowed callback URL`.
- **The id is configuration, not state.** It is never written to the token
  file (`saveClientInformation` stores nothing; the file is
  `{ serverUrl, redirectPort, tokens, tokensSavedAt, codeVerifier?, state?, discovery }`),
  `invalidateCredentials("all")` drops the tokens and the discovery and keeps
  it, `l` and `--logout` drop the tokens and present it again, and a
  `clientInformation` a run *without* the flag left in the file is neither
  presented nor touched (drop the flag and that registration is back). Tokens
  without a `clientInformation` are a whole sign-in, not a half-state: the
  refresh runs silently.
- **A rejected id is a configuration error, not a dead credential.** When the
  token endpoint answers the refresh or the code exchange with
  `invalid_client` / `unauthorized_client` (the id is wrong, or the application
  was deleted), `auth.state` becomes `"error"` with `the configured client id
  <id> was rejected by the issuer (invalid_client) — check WEBDEVPROXY_CLIENT_ID
  / --client-id against the tenant's application` (plus `; the issuer advertises
  a registration endpoint — drop --client-id / WEBDEVPROXY_CLIENT_ID and the
  proxy registers a client by itself` when its metadata has one) — the proxy
  does **not** fall back to registering a client (that would defeat the point)
  and opens no browser tab; the next `401` round tries the same id again. A
  configured id is never put through the pre-browser check either: there is
  nothing the proxy could repair.
- **One exact redirect URI, on a fixed port.** The authorization request and
  the code exchange carry exactly one `redirect_uri`,
  `http://127.0.0.1:<port>/callback` (the `localhost` twin and the list
  `redirect_uris` are only ever sent in a registration, which does not happen
  here). Auth0 compares it verbatim to the application's *Allowed Callback
  URLs* and **rejects a port wildcard** in that list (`http://127.0.0.1:*/callback`
  is "invalid"), so the loopback port cannot be ephemeral: with `--client-id`
  it defaults to **`8790`** (`--callback-port <n>` / `WEBDEVPROXY_CALLBACK_PORT`
  for another; clear of the demos' proxy ports 8787 and 8788). If that port is
  taken the proxy refuses to start — `callback port 8790 is in use — the
  sign-in redirect must be exactly http://127.0.0.1:8790/callback (the
  application's allowed callback URL), so another port will not do; free the
  port, or pick one with --callback-port <n> / WEBDEVPROXY_CALLBACK_PORT and
  allow http://127.0.0.1:<n>/callback on the application` — rather than
  silently drift to a port the tenant does not allow.

**The Auth0 application**, exactly: *Applications → Create Application*, type
**Native** (a public client; a Regular Web / SPA / M2M type is wrong); in
*Settings → Advanced → Grant Types* tick **Authorization Code** and **Refresh
Token** (nothing else is needed); *Credentials → Authentication Methods*:
**None** (no client secret is ever sent; the proxy authenticates the token
request with `client_id` alone, PKCE S256 does the rest); *Allowed Callback
URLs*: exactly one entry, `http://127.0.0.1:8790/callback` — or
`http://127.0.0.1:<n>/callback` for the `--callback-port <n>` you run with
(the wildcard form `http://127.0.0.1:*/callback` is **rejected** by the form,
"one or more callback URLs are invalid", and the `localhost` form is not
needed: the proxy never sends it); no *Allowed Web Origins*, *Logout URLs* or
CORS entries (the browser never talks to Auth0). Copy the *Client ID* into
`--client-id`. The application must be authorized for the gateway's API (the
audience the gateway's protected-resource metadata names) the same way the
dynamically registered ones were.

**Keys.** When the proxy runs from `webdevproxy` on a terminal (stdin a TTY —
never under the demos' `scripts/dev.mjs` or in CI), it prints
`press a + Enter to (re)open the sign-in in your browser, r + Enter to forget
this server's client registration and register anew (the gateway's page says
"Unknown client"), l + Enter to forget this server's tokens and sign in fresh,
q + Enter to quit` whenever the sign-in is `waiting` or has failed. `a` re-opens
a waiting sign-in and prints its URL again (for a session over SSH: copy it), or
— when none is waiting — drops the tokens, keeps the client registration (the
pre-browser check still replaces one the issuer has forgotten) and starts a
fresh authorization; `r` is `--reset-client` without a restart (the registration
and its tokens go, a new client is registered); `l` is `--logout` for this
server without a restart (the client is registered anew); `q` closes every
session and exits `0`. A sign-in still pending is superseded, not reported as
failed.

**Token files** live at `~/.config/omgbase-webdevproxy/<sha256 of the normalized
server URL, 16 hex>.json` (`$XDG_CONFIG_HOME` honoured; `--token-file` /
`WEBDEVPROXY_TOKEN_FILE` override), mode `0600`, shaped
`{ serverUrl, redirectPort, clientInformation, clientIssuer, tokens, tokensSavedAt, codeVerifier?, state?, discovery }`
(`clientIssuer` is the authorization server the registration was made with; no
`clientInformation` with `--client-id`: the id is configuration).
A file the graph-ui demo's former bridge wrote under `~/.config/omgbase-graph-ui/`
for the same server is **copied into place on the first start** (never
overwriting, the old file left alone), so an existing sign-in survives the
move. Nothing in the file is ever logged.

`webdevproxy --logout --remote <url>` deletes that server's file (and the
legacy copy); `webdevproxy --logout` alone deletes every file under both
directories. Since the proxy replaces a rejected sign-in by itself, `--logout`
is for switching accounts or servers, not for repairing one.

### Session recovery

Streamable HTTP sessions are the proxy's: each browser `Mcp-Session-Id` maps to
one upstream (an `omg mcp` child, or a gateway session). A session is closed
after `--idle` seconds without a request, and every session is gone when the
proxy restarts. A page that still holds its old id then gets, on its next POST,

```
HTTP 404
{"jsonrpc":"2.0","error":{"code":-32000,"message":"unknown session (expired or the proxy restarted) — send initialize again"},"id":null}
```

— `404` is the transport spec's signal to start over with `initialize`; the
`-32000` code is kept for clients matching on it. The SDK's browser client does
not re-initialize by itself, so the demos do: their `OmgClient` recognizes a
lost session (`isSessionLost`), opens a fresh session against the same URL,
retries the call once, and only a second failure reaches the user (graph-ui:
`src/lib/mcp-client.ts`; live-tail: the same). Idle is `3600` s by default so a
tab left open through a lunch break normally finds its session still there.

## Using it from a demo

`scripts/dev.mjs` in a demo starts the proxy in-process and then Vite, exporting
the proxy's port and path so a non-default `--port` needs no config change:

```js
import { startProxy, parseArgs } from "webdevproxy";

const options = parseArgs();                       // the proxy's flags; `rest` is what goes to Vite
const proxy = await startProxy({ ...options, local: options.remote ? null : ".dev-workspace" });
spawn(process.execPath, ["node_modules/vite/bin/vite.js", ...options.rest], {
  env: { ...process.env, WEBDEVPROXY_PORT: String(proxy.port), WEBDEVPROXY_PATH: proxy.path },
});
```

and `vite.config.ts` sends the page's same-origin `/mcp` and `/whoami` to it:

```ts
import { viteProxy } from "webdevproxy";
export default defineConfig({ server: { proxy: viteProxy() } });
```

so the app's server URL is just `/mcp` and the browser never needs CORS at
all. `startProxy` resolves once listening with `{ url, port, path, mode, remote,
whoami(), ready, close() }` (`ready` settles when the remote sign-in or refresh
attempted at startup is done; it never rejects; `remote` is the `RemoteAuth` in
remote mode, which `startPrompt({ remote, proxy })` — the terminal keys — takes;
`startProxy` itself never reads stdin; `openBrowser` replaces the system
browser). `logout(options)` is the
`--logout` behaviour as a function. Everything else the package exports
(`RemoteAuth`, `FileOAuthProvider`, `SessionTable`, the token-file helpers, the
CORS rules) is in [`index.d.ts`](./index.d.ts).

## Tests

`pnpm --filter webdevproxy test` — vitest over the argument parsing, the CORS
rules, the session table (injected timers), the token files and the legacy
migration (a fake loopback sign-in), the Vite entries, the proxy end to end
over a fake `omg mcp` (`test/fixtures/fake-omg.mjs`) on an ephemeral port (a
browser-shaped SDK client connects, each session gets its own child, `/whoami`
describes them, a `DELETE` ends the upstream, the CORS and 404 answers hold),
and the remote sign-in over a fake gateway + issuer on another ephemeral port
(`test/fixtures/fake-gateway.ts`: the 401, RFC 9728/8414 metadata, RFC 7591
registration, code exchange and refresh, a "browser" that answers the loopback
itself) — the first run, every recovery row above, the bounded failure, a stale
file at start-up through `startProxy`, `--logout`, the terminal keys from a
fake stdin, a stored registration the gateway no longer knows
(`test/unknown-client.test.ts`: the pre-browser check finds it and the client is
registered anew before any browser tab — at start-up, through `startProxy` and
after `a`; a known one passes; the check is fail-open; `r`, `--reset-client`;
a registration kept with its issuer and its redirect URIs; the start-up and
registration log lines), and `--client-id` over a `fixedClient` whose allowed callbacks are
one exact callback URL (`test/configured-client.test.ts`: zero registrations
across first run, refresh, dead-refresh recovery, `a`, `l` and `--logout`;
exactly the fixed `redirect_uri` and a secret-less token request; the
`invalid_client` message with no fall-back; the id kept through
`invalidateCredentials("all")`; the default callback port `8790` and a taken
fixed port's start-up error; flag over env over absent). No network, no real
browser.
