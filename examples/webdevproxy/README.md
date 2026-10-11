# webdevproxy — a development-only local web proxy for MCP servers

A small Node program (no build step) that lets the browser demos in this
repository — [`graph-ui`](../graph-ui/README.md), [`live-tail`](../live-tail/README.md)
— reach an **omgbase MCP server** from a Vite dev server without any CORS or
OAuth setup on the server side. The page talks to `localhost`; the proxy talks
to the server. It is **private, unpublished and not for production**: it
listens on `127.0.0.1` only, holds your bearer tokens, and allows exactly the
browser origins a dev setup needs.

Two modes, one flag each:

| mode | flag | what the proxy does |
| --- | --- | --- |
| **local** | `--local <workspace-dir>` | spawns one `omg mcp -C <dir>` child (stdio) per browser session and relays JSON-RPC verbatim |
| **remote** | `--remote <mcp-url>` | opens one upstream Streamable HTTP session per browser session at a remote gateway and is **itself the OAuth client** — a native app with a loopback redirect, dynamic client registration, PKCE and a refresh token kept in a `0600` file; the browser never sees the gateway or the identity provider |

Either way the browser side is the standard MCP **Streamable HTTP** transport
(`@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`) on
`http://127.0.0.1:8787/mcp`, with CORS for `http://localhost:*` and
`http://127.0.0.1:*` (`--origin` adds more) and `Mcp-Session-Id` exposed. The
stdio shape is the same as [usergenic/stdio-mcp-to-http](https://github.com/usergenic/stdio-mcp-to-http),
which could not be reused because it is not on npm and sends no CORS headers.

## Usage

```
webdevproxy --local <workspace-dir> [--omg <omg entry or binary>]
webdevproxy --remote <mcp-url> [--no-browser] [--token-file <file>]
webdevproxy --logout [--remote <mcp-url>] [--token-file <file>]
```

| flag | meaning |
| --- | --- |
| `--local <dir>` | spawn `omg mcp -C <dir>` per browser session |
| `--omg <path>` | the omg CLI: a `.js` entry (run with the current `node`) or a binary; default `WEBDEVPROXY_OMG`, else the monorepo's `packages/cli/dist/src/main.js` when it exists, else `omg` on `PATH` |
| `--remote <url>` | relay to a remote MCP endpoint (`http(s)`); the proxy signs in |
| `--port <n>` | listen on `127.0.0.1:<n>` (default `8787`; `0` = an ephemeral port, for tests) |
| `--path <p>` | the MCP endpoint path (default `/mcp`); `GET /whoami` is always served |
| `--idle <seconds>` | close a browser session **and its upstream** (the `omg mcp` child, or the remote session) after this long without a request (default `3600`; `0` = never). A page that comes back later gets `404 unknown session` on its next POST and must `initialize` again — see [Session recovery](#session-recovery) |
| `--origin <origin>` | allow this browser origin too (repeatable; `*` wildcards a port: `http://app.local:*`) |
| `--no-browser` | print the sign-in URL instead of opening a browser (over SSH) |
| `--token-file <file>` | where the remote's tokens live (default below) |
| `--logout` | delete the token file(s) and exit |
| `--help` | the usage text |

Environment fallbacks: `WEBDEVPROXY_LOCAL`, `WEBDEVPROXY_OMG`, `WEBDEVPROXY_REMOTE`,
`WEBDEVPROXY_PORT`, `WEBDEVPROXY_PATH`, `WEBDEVPROXY_ORIGIN` (comma-separated),
`WEBDEVPROXY_TOKEN_FILE`, `WEBDEVPROXY_NO_BROWSER`. A flag wins over its variable.

`--local` and `--remote` are exclusive; one of them is required (except with
`--logout`/`--help`). The listener binds `127.0.0.1` and nothing else.

### `GET /whoami`

The proxy describes itself for a page's status line:

```json
{
  "mode": "remote",
  "upstream": "https://mcp.example.com/omg",
  "identity": { "email": "brendan@example.com", "name": null, "subject": "auth0|…" },
  "auth": { "state": "ok", "issuer": "https://example.us.auth0.com/" },
  "tokenFile": "/home/me/.config/omgbase-webdevproxy/0123456789abcdef.json",
  "sessions": [{ "id": "<browser Mcp-Session-Id>", "upstream": "<gateway session id or omg mcp pid>" }]
}
```

In local mode `mode` is `"local"`, `upstream` is `omg mcp -C <dir>`, `identity`
and `tokenFile` are `null` and `auth` is `{ "state": "none" }`. `auth.state` is
`"waiting"` while the sign-in is open in your browser (with
`authorizationUrl`), `"error"` with `error` when it failed, `"ok"` when tokens
are in hand, `"unknown"` before the first upstream request. The type is
`WhoAmI` in [`index.d.ts`](./index.d.ts); the demos poll it while `waiting`.

### The remote sign-in

On start in remote mode the proxy sends the gateway one unauthenticated
`initialize`, follows the `401`'s `WWW-Authenticate: Bearer resource_metadata=…`
to the protected-resource metadata (RFC 9728) and the issuer's metadata
(RFC 8414 / OIDC), registers a public client (RFC 7591, PKCE, loopback redirect
URIs `http://127.0.0.1:<ephemeral>/callback` and `http://localhost:<port>/callback`),
prints the authorization URL and opens your browser once:

```
[webdevproxy] sign-in required for https://mcp.example.com/omg
[webdevproxy] issuer: https://example.us.auth0.com/
[webdevproxy] open this URL in your browser if it does not open by itself:
[webdevproxy]   https://example.us.auth0.com/authorize?response_type=code&client_id=…
[webdevproxy] waiting for the sign-in to finish (listening on http://127.0.0.1:51763/callback)…
```

Consent lands on the loopback listener, the code is exchanged, and from then on
every browser session gets its own upstream session with the bearer added per
request; a `401` later is answered with a silent refresh (`offline_access`), and
only a rejected refresh re-runs the browser flow.

**Token files** live at `~/.config/omgbase-webdevproxy/<sha256 of the normalized
server URL, 16 hex>.json` (`$XDG_CONFIG_HOME` honoured; `--token-file` /
`WEBDEVPROXY_TOKEN_FILE` override), mode `0600`, shaped
`{ serverUrl, redirectPort, clientInformation, tokens, tokensSavedAt, codeVerifier?, state?, discovery }`.
A file the graph-ui demo's former bridge wrote under `~/.config/omgbase-graph-ui/`
for the same server is **copied into place on the first start** (never
overwriting, the old file left alone), so an existing sign-in survives the
move. Nothing in the file is ever logged.

`webdevproxy --logout --remote <url>` deletes that server's file (and the
legacy copy); `webdevproxy --logout` alone deletes every file under both
directories.

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
all. `startProxy` resolves once listening with `{ url, port, path, mode,
whoami(), ready, close() }` (`ready` settles when the remote sign-in or refresh
attempted at startup is done; it never rejects). `logout(options)` is the
`--logout` behaviour as a function. Everything else the package exports
(`RemoteAuth`, `FileOAuthProvider`, `SessionTable`, the token-file helpers, the
CORS rules) is in [`index.d.ts`](./index.d.ts).

## Tests

`pnpm --filter webdevproxy test` — vitest over the argument parsing, the CORS
rules, the session table (injected timers), the token files and the legacy
migration (a fake loopback sign-in), the Vite entries, and the proxy end to end
over a fake `omg mcp` (`test/fixtures/fake-omg.mjs`) on an ephemeral port: a
browser-shaped SDK client connects, each session gets its own child, `/whoami`
describes them, a `DELETE` ends the upstream, the CORS and 404 answers hold.
No network.
