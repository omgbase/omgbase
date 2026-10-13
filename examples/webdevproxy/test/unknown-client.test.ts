// A stored client registration the gateway no longer knows — "Unknown client"
// on its sign-in page. A gateway that registers clients itself (RFC 7591) and
// keeps them in a state directory forgets them all when restarted with a fresh
// one; the proxy's file still holds the old `client_id`, and the SDK presents
// whatever `clientInformation()` answers. With tokens in the file the refresh
// gets `invalid_client` and the SDK re-registers by itself; WITHOUT tokens (the
// state after `a`, or a reset between the registration and the consent) nothing
// reaches the token endpoint: the browser lands on the gateway's error page,
// which never redirects to the loopback, and the proxy waits forever.
//
// So, before a browser round trip with a registration this pass did not make,
// the proxy asks the token endpoint whether it still knows the client
// (`verifyRegistration`), and an unknown one is dropped and registered anew in
// the same round. Plus the explicit ways out — the `r` key and `--reset-client`
// — a registration kept with its issuer (`clientIssuer`), the redirect-URI
// check at start-up, and the start-up/registration log lines.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { USAGE, parseArgs } from "../src/args.mjs";
import { PROMPT_HINT, startPrompt } from "../src/prompt.mjs";
import { startProxy } from "../src/proxy.mjs";
import {
  CLIENT_UNKNOWN, REGISTER_INSTEAD_HINT, REGISTRATION_CHECK_TOKEN, RemoteAuth, clientUnknown, loopbackRedirectUrls, readTokenFile, registeredPort, registrationAllows, writeTokenFile,
} from "../src/remote-auth.mjs";
import { FakeGateway, type FakeBrowser, until } from "./fixtures/fake-gateway.ts";

let dir: string;
let gw: FakeGateway;
let logs: string[];
let ra: RemoteAuth | null;
let statuses: RemoteAuth["status"][];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-unknown-client-"));
  gw = await FakeGateway.start();
  logs = [];
  ra = null;
  statuses = [];
});
afterEach(async () => {
  for (const s of statuses) if (s.state === "error") expect(s.error).toMatch(/\S/);
  await ra?.close();
  await gw.close();
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "tokens.json");
const log = (m: string) => logs.push(m);
const track = (r: RemoteAuth) => { r.onStatus((s) => statuses.push(s)); return r; };
const initialize = () => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
});
/** A loopback port nothing listens on right now (bound once, released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}
const discovery = () => ({
  authorizationServerUrl: gw.issuer,
  resourceMetadataUrl: `${gw.base}/.well-known/oauth-protected-resource/omg`,
  resourceMetadata: { resource: gw.serverUrl, authorization_servers: [gw.issuer] },
  authorizationServerMetadata: { issuer: gw.issuer, authorization_endpoint: `${gw.issuer}/authorize`, token_endpoint: `${gw.base}/issuer/token`, registration_endpoint: `${gw.issuer}/register`, response_types_supported: ["code"] },
});
/**
 * The file found on a real machine: a registration (made with this issuer, naming a loopback port),
 * cached discovery, a PKCE verifier and state from a sign-in that never came back — and no tokens.
 * `known` puts the client in the gateway's state; without it, the gateway was reset since.
 */
function registrationOnly(clientId: string, port: number, { known = false, issuer = gw.issuer as string | undefined } = {}) {
  if (known) gw.clients.add(clientId);
  writeTokenFile(file(), {
    serverUrl: gw.serverUrl,
    redirectPort: port,
    clientInformation: { client_id: clientId, client_name: "omgbase webdevproxy (local dev proxy)", redirect_uris: loopbackRedirectUrls(port), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] },
    ...(issuer ? { clientIssuer: issuer } : {}),
    codeVerifier: "stale-verifier",
    state: "stale-state",
    discovery: discovery(),
  });
}
const signedIn = async (browser: FakeBrowser = gw.browser()) => {
  ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
  await ra.ensure();
  expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
  expect(gw.hits).toMatchObject({ register: 1, exchange: 1, refresh: 0 }); // a registration made in this pass is not checked
  logs.length = 0;
  return { ra, browser, fetch: ra.fetchWithAuth() };
};

describe("a stored registration the gateway no longer knows (no tokens: the authorize page would say \"Unknown client\")", () => {
  it("at start-up: the token endpoint is asked first, the stale registration is dropped and a new client registered — the browser opens once, never with the old id; recovered", async () => {
    const port = await freePort();
    registrationOnly("client-forgotten", port);
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    expect(logs).toEqual([`presenting the client registration client-forgotten for ${gw.serverUrl} (registered with ${gw.issuer})`]);
    expect(ra.loopback!.port).toBe(port); // the registration's own port, free: reused
    await ra.ensure();
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer, recovered: true });
    expect(browser.opened).toHaveLength(1);
    expect(new URL(browser.opened[0]!).searchParams.get("client_id")).toMatch(/^client-\d+$/);
    // One check (a refresh with the bogus token, as client-forgotten), one registration, one exchange.
    expect(gw.hits).toMatchObject({ refresh: 1, register: 1, exchange: 1 });
    expect(gw.tokenRequests[0]).toEqual({ grant: "refresh_token", clientId: "client-forgotten", auth: "none", redirectUri: null });
    const reason = clientUnknown("client-forgotten", gw.issuer, "invalid_client");
    expect(reason).toBe(`the client registration client-forgotten is unknown to ${gw.issuer} (invalid_client: the gateway was reset or started with a fresh state directory)`);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (${reason}); signing in again`);
    expect(logs).toContain(`registered client ${ra.client().id} with ${gw.issuer} for ${gw.serverUrl}`);
    const stored = readTokenFile(file())!;
    expect(stored.clientInformation).toMatchObject({ client_id: ra.client().id });
    expect(stored.clientIssuer).toBe(gw.issuer);
    expect(stored.tokens).toMatchObject({ refresh_token: expect.any(String) as unknown as string });
    expect(stored.state).toBeUndefined();
    // Settled: a request goes through without a browser or a check.
    expect((await ra.fetchWithAuth()(gw.serverUrl, initialize())).status).toBe(200);
    expect(gw.hits).toMatchObject({ refresh: 1, register: 1 });
  });

  it("through startProxy: `ready` settles signed in and /whoami names the new client", async () => {
    registrationOnly("client-forgotten", await freePort());
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, recovered: true, recoveredAt: expect.any(String) as unknown as string, client: { source: "registered", id: expect.stringMatching(/^client-\d+$/) as unknown as string } });
      expect(browser.opened).toHaveLength(1);
      expect(gw.hits).toMatchObject({ refresh: 1, register: 1, exchange: 1 });
    } finally {
      await proxy.close();
    }
  });

  it("the same with the bogus-token check sent as the registered client: the body carries the check token, never a real one", async () => {
    registrationOnly("client-forgotten", await freePort());
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      if (init?.body instanceof URLSearchParams) seen.push(init.body.toString());
      return fetch(input, init);
    };
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, fetch: spy, openBrowser: gw.browser() }).start());
    await ra.ensure();
    expect(seen[0]).toBe(new URLSearchParams({ grant_type: "refresh_token", refresh_token: REGISTRATION_CHECK_TOKEN, client_id: "client-forgotten" }).toString());
    expect(REGISTRATION_CHECK_TOKEN).toBe("webdevproxy-registration-check");
  });

  it("`a` with a registration the gateway has since forgotten re-registers instead of opening the error page", async () => {
    const { ra, browser } = await signedIn();
    gw.revokeClients(); // the gateway restarted with a fresh state directory
    await ra.reauthorize(); // the user's `a`: drop the tokens, sign in again
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(browser.opened).toHaveLength(2);
    expect(new URL(browser.opened[1]!).searchParams.get("client_id")).not.toBe("client-1");
    expect(gw.hits).toMatchObject({ refresh: 1, register: 2, exchange: 2 });
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: expect.stringMatching(/^client-(?!1$)/) as unknown as string });
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (${clientUnknown("client-1", gw.issuer, "invalid_client")}); signing in again`);
  });

  it("a registration the gateway still knows passes the check (invalid_grant) and is kept: no re-registration, one browser tab", async () => {
    const port = await freePort();
    registrationOnly("client-kept", port, { known: true });
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer }); // registration-only is the normal first-run state: not a recovery
    expect(gw.hits).toMatchObject({ refresh: 1, register: 0, exchange: 1 });
    expect(new URL(browser.opened[0]!).searchParams.get("client_id")).toBe("client-kept");
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-kept" });
    expect(logs.join("\n")).not.toMatch(/was rejected|registering/);
  });

  it("the check is fail-open: a token endpoint that answers 5xx, a non-OAuth body or nothing usable teaches nothing and the browser flow goes ahead", async () => {
    registrationOnly("client-kept", await freePort(), { known: true });
    gw.refreshResponse = { status: 503, body: "<h1>maintenance</h1>", contentType: "text/html" };
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(gw.hits).toMatchObject({ refresh: 1, register: 0, exchange: 1 });
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-kept" });
    // No token endpoint in the cached metadata: nothing to ask.
    await ra.close();
    ra = null;
    const r = new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser });
    await r.start();
    r.provider!.patch({ discovery: { authorizationServerUrl: gw.issuer } });
    await expect(r.verifyRegistration()).resolves.toBeUndefined();
    // And the verdict itself, for the record.
    r.provider!.patch({ discovery: discovery() });
    gw.refreshResponse = null;
    gw.clients.delete("client-kept");
    await expect(r.verifyRegistration()).rejects.toMatchObject({ name: CLIENT_UNKNOWN, message: clientUnknown("client-kept", gw.issuer, "invalid_client") });
    expect(r.deadCredential(Object.assign(new Error("x"), { name: CLIENT_UNKNOWN }))).toEqual({ scope: "all", reason: "x" });
    await r.close();
  });

  it("a configured --client-id is never checked (nothing to repair) — but a rejection of it names the way out when the issuer registers clients", async () => {
    const port = await freePort();
    gw.fixedClient("fixed-app", port);
    writeTokenFile(file(), { serverUrl: gw.serverUrl, tokens: { access_token: "at-dead", token_type: "Bearer", refresh_token: "rt-dead" }, discovery: discovery() });
    gw.clients.delete("fixed-app");
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: "fixed-app", callbackPort: port, log, openBrowser: browser }).start());
    await expect(ra.ensure()).rejects.toThrow();
    expect(ra.status.error).toBe(`the configured client id fixed-app was rejected by the issuer (invalid_client) — check WEBDEVPROXY_CLIENT_ID / --client-id against the tenant's application; ${REGISTER_INSTEAD_HINT}`);
    expect(gw.hits).toMatchObject({ refresh: 1, register: 0 });
    expect(browser.opened).toHaveLength(0);
    // `r` with a configured id: nothing to forget; the tokens go, the hint is logged, no registration.
    logs.length = 0;
    gw.clients.add("fixed-app");
    await ra.reauthorize({ resetClient: true });
    expect(logs[0]).toBe(`the client id fixed-app is configured (--client-id / WEBDEVPROXY_CLIENT_ID), not registered — r has no registration to forget; dropping the tokens instead (${REGISTER_INSTEAD_HINT})`);
    expect(ra.status).toMatchObject({ state: "ok" });
    expect(gw.hits.register).toBe(0);
  });
});

describe("the explicit ways out", () => {
  it("`r`: forgets the client registration and its tokens, registers anew — also while a sign-in is waiting, and from the terminal", async () => {
    const { ra, browser } = await signedIn();
    await ra.reauthorize({ resetClient: true });
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer }); // by hand: not a recovery
    expect(gw.hits).toMatchObject({ register: 2, exchange: 2, refresh: 0 });
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: expect.stringMatching(/^client-(?!1$)/) as unknown as string });
    expect(logs[0]).toBe(`forgetting the client registration client-1 for ${gw.serverUrl} (r) — registering anew`);
    // While waiting (the browser hangs on the error page), `r` from the terminal supersedes the pending sign-in.
    browser.mode = "hang";
    void ra.reauthorize().catch(() => undefined);
    await until(() => ra.status.state === "waiting");
    browser.mode = "consent";
    const input = new PassThrough();
    const prompt = startPrompt({ remote: ra, proxy: { close: async () => {} }, input, log, exit: () => {} });
    try {
      input.write("r\n");
      await until(() => gw.hits.exchange === 3 && ra.inflight === null);
    } finally {
      prompt.close();
    }
    expect(ra.status).toMatchObject({ state: "ok" });
    expect(gw.hits.register).toBe(3);
    expect(logs.join("\n")).not.toMatch(/sign-in failed/);
    expect(PROMPT_HINT).toContain("r + Enter to forget this server's client registration and register anew");
    expect(PROMPT_HINT).toContain("Unknown client");
  });

  it("--reset-client: parsed, in USAGE, and at start-up the stored registration goes before anything is presented", async () => {
    expect(parseArgs(["--reset-client", "--remote", gw.serverUrl], {}).resetClient).toBe(true);
    expect(parseArgs([], {}).resetClient).toBe(false);
    expect(USAGE).toMatch(/--reset-client/);
    expect(USAGE).toMatch(/Unknown client/);
    expect(USAGE).toMatch(/^\s+r\s+forget this server's client registration/m);
    const port = await freePort();
    registrationOnly("client-forgotten", port);
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), resetClient: true, port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      expect(proxy.remote!.resetClient).toBe(true);
      expect(proxy.remote!.loopback!.port).not.toBe(port); // a registration being dropped pins no port
      await proxy.ready;
      expect(logs).toContain(`forgetting the client registration client-forgotten for ${gw.serverUrl} (--reset-client) — registering anew`);
      expect(logs).toContain(`no client registration for ${gw.serverUrl} yet — one is registered with the issuer at the first sign-in`);
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, client: { source: "registered", id: expect.stringMatching(/^client-\d+$/) as unknown as string } });
      expect(gw.hits).toMatchObject({ refresh: 0, register: 1, exchange: 1 }); // nothing to check: the registration is this pass's
      expect(gw.tokenRequests.map((t) => t.clientId)).not.toContain("client-forgotten");
    } finally {
      await proxy.close();
    }
    // Without a registration to forget it says so and goes on.
    logs.length = 0;
    writeTokenFile(file(), { serverUrl: gw.serverUrl });
    const again = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), resetClient: true, log }).start();
    expect(logs[0]).toBe(`no client registration for ${gw.serverUrl} to forget (--reset-client) — registering`);
    await again.close();
  });
});

describe("a registration is kept with its issuer and its redirect URIs", () => {
  it("made with another authorization server (the gateway changed its identity provider): dropped, not presented, registered anew with the new one", async () => {
    const port = await freePort();
    registrationOnly("client-elsewhere", port, { known: true, issuer: "https://old-idp.example.com/" });
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    expect(logs[0]).toBe(`presenting the client registration client-elsewhere for ${gw.serverUrl} (registered with https://old-idp.example.com/)`);
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(logs).toContain(`the client registration client-elsewhere for ${gw.serverUrl} was made with https://old-idp.example.com/, not ${gw.issuer} — registering anew`);
    expect(gw.hits).toMatchObject({ refresh: 0, register: 1, exchange: 1 }); // dropped before any check
    expect(new URL(browser.opened[0]!).searchParams.get("client_id")).not.toBe("client-elsewhere");
    expect(readTokenFile(file())!).toMatchObject({ clientInformation: { client_id: ra.client().id }, clientIssuer: gw.issuer });
  });

  it("the same issuer a trailing slash apart, or a file from before `clientIssuer`, is kept", async () => {
    const port = await freePort();
    registrationOnly("client-kept", port, { known: true, issuer: `${gw.issuer}/` });
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: gw.browser() }).start());
    await ra.ensure();
    expect(gw.hits.register).toBe(0);
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-kept" });
    await ra.close();
    registrationOnly("client-kept", port, { known: true, issuer: undefined });
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: gw.browser() }).start());
    await ra.ensure();
    expect(gw.hits.register).toBe(0);
    expect(logs.join("\n")).not.toMatch(/was made with/);
  });

  it("the loopback port comes from the registration's redirect URIs, not a `redirectPort` a --client-id run rewrote; URIs that do not name our port mean a new registration", async () => {
    const registeredAt = await freePort();
    const rewritten = await freePort();
    gw.clients.add("client-ports");
    writeTokenFile(file(), { serverUrl: gw.serverUrl, redirectPort: rewritten, clientInformation: { client_id: "client-ports", redirect_uris: loopbackRedirectUrls(registeredAt), token_endpoint_auth_method: "none" }, clientIssuer: gw.issuer, discovery: discovery() });
    ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log }).start();
    expect(ra.loopback!.port).toBe(registeredAt);
    expect(readTokenFile(file())!).toMatchObject({ redirectPort: registeredAt, clientInformation: { client_id: "client-ports" } });
    await ra.close();
    // The registration's port taken: an ephemeral one, and the registration (whose URIs the issuer would refuse) goes.
    const holder = await occupy(registeredAt);
    try {
      logs.length = 0;
      ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log }).start();
      expect(ra.loopback!.port).not.toBe(registeredAt);
      expect(logs[0]).toBe(`the client registration client-ports names ${loopbackRedirectUrls(registeredAt).join(", ")}, not ${ra.loopback!.redirectUrl} (port ${registeredAt} is busy) — registering anew`);
      expect(readTokenFile(file())!.clientInformation).toBeUndefined();
      expect(readTokenFile(file())!.clientIssuer).toBeUndefined();
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
    // A registration without redirect URIs (an older file) is given the benefit of the doubt.
    expect(registeredPort({ client_id: "x" })).toBeUndefined();
    expect(registeredPort({ redirect_uris: ["not a url", "http://127.0.0.1:4242/callback"] })).toBe(4242);
    expect(registrationAllows({ client_id: "x" }, "http://127.0.0.1:1/callback")).toBe(true);
    expect(registrationAllows({ redirect_uris: loopbackRedirectUrls(4242) }, "http://127.0.0.1:4242/callback")).toBe(true);
    expect(registrationAllows({ redirect_uris: loopbackRedirectUrls(4242) }, "http://127.0.0.1:4243/callback")).toBe(false);
  });

  it("an invalid_client at the code exchange (the registration disowned mid-flow) is named with what to do", () => {
    const r = new RemoteAuth({ serverUrl: gw.serverUrl, file: file() });
    r.phase = "browser";
    r.observed.rejection = { endpoint: "token", status: 401, grant: "authorization_code", code: "invalid_client", description: "unknown client_id" };
    expect(r.failureMessage(new Error("Existing OAuth client information is required when exchanging an authorization code")))
      .toBe("the issuer rejected the client registration at the code exchange (invalid_client: unknown client_id); it has been dropped — press a + Enter (or restart the proxy) to register anew and sign in");
  });
});
