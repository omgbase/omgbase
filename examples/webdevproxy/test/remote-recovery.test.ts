// The remote sign-in against a fake gateway + issuer (test/fixtures/fake-gateway.ts):
// the first run, and every way a stored sign-in can be dead — the issuer rejects
// the refresh token (`invalid_grant`), the client registration (`invalid_client`),
// with an error the SDK does not recover from by itself, with a bare 401, or the
// token endpoint moved — recovers by itself: the dead part of the file goes,
// the browser flow runs again, the request succeeds, /whoami says `recovered`.
// A failing browser flow ends in `error` after a bounded number of token
// requests; a stale file at start-up follows the same path; --logout still works.
// No real browser: the fake user answers the loopback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RemoteAuth, TOO_MANY_ENTITIES_HINT, loopbackRedirectUrls, readTokenFile, writeTokenFile } from "../src/remote-auth.mjs";
import { logout, startProxy } from "../src/proxy.mjs";
import { FakeGateway, type FakeBrowser } from "./fixtures/fake-gateway.ts";

let dir: string;
let gw: FakeGateway;
let logs: string[];
let ra: RemoteAuth | null;
/** Every status any RemoteAuth of the test went through; an `error` without a message is a bug (afterEach). */
let statuses: RemoteAuth["status"][];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-recovery-"));
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
const initialize = () => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
});

const track = (r: RemoteAuth) => { r.onStatus((s) => statuses.push(s)); return r; };

/** A RemoteAuth over the fake gateway, signed in once through the fake user's browser. */
async function signedIn(browser: FakeBrowser = gw.browser()) {
  ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
  await ra.ensure();
  expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
  expect(browser.opened).toHaveLength(1);
  expect(gw.hits).toMatchObject({ register: 1, exchange: 1, refresh: 0 });
  logs.length = 0;
  return { ra, browser, fetch: ra.fetchWithAuth() };
}

describe("the first run", () => {
  it("discovers from the 401, registers a public client, opens the browser once and keeps the tokens in the file", async () => {
    const { ra, browser, fetch } = await signedIn();
    const stored = readTokenFile(file())!;
    expect(stored.clientInformation).toMatchObject({ client_id: "client-1", token_endpoint_auth_method: "none", redirect_uris: loopbackRedirectUrls(ra.loopback!.port) });
    expect(stored.tokens).toMatchObject({ access_token: "at-3", refresh_token: "rt-3" });
    expect(stored.discovery).toMatchObject({ authorizationServerUrl: gw.issuer });
    expect(new URL(browser.opened[0]!).searchParams.get("client_id")).toBe("client-1");
    expect(gw.hits.metadata).toBe(2);
    expect(ra.recoveredAt).toBeUndefined();
    const res = await fetch(gw.serverUrl, initialize());
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    expect(gw.hits.mcp).toBe(2); // the probe and this one
  });
});

describe("recovery from a dead stored sign-in", () => {
  it("(a) a refresh token the issuer rejects (invalid_grant): the tokens and the cached discovery go, the browser flow runs again, the request succeeds, recovered", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.revokeTokens();
    const res = await fetch(gw.serverUrl, initialize());
    expect(res.status).toBe(200);
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer, recovered: true, recoveredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string });
    // rediscovered, not re-registered; the second refresh is the pre-browser check of the stored registration (answered invalid_grant: the client is known)
    expect(gw.hits).toMatchObject({ refresh: 2, exchange: 2, register: 1, metadata: 4 });
    expect(browser.opened).toHaveLength(2);
    const stored = readTokenFile(file())!;
    expect(stored.clientInformation).toMatchObject({ client_id: "client-1" });
    expect(stored.tokens?.refresh_token).not.toBe("rt-3");
    expect(gw.accessTokens.has(String(stored.tokens!.access_token))).toBe(true);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
    expect(logs.join("\n")).toMatch(/^signed in again to /m);
    // Settled: the next request neither refreshes nor opens a browser.
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(gw.hits.refresh).toBe(2);
    expect(browser.opened).toHaveLength(2);
  });

  it("(b) a client registration the issuer no longer knows (invalid_client): the registration goes too and the client is registered anew", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.revokeClients();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(gw.hits).toMatchObject({ refresh: 1, register: 2, exchange: 2 });
    expect(browser.opened).toHaveLength(2);
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: expect.stringMatching(/^client-(?!1$)/) as unknown as string });
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_client: unknown client); signing in again`);
  });

  it("a refusal the SDK does not recover from by itself (invalid_request, HTTP 400) still counts as a dead refresh token", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.revokeTokens();
    gw.refreshResponse = { status: 400, body: { error: "invalid_request", error_description: "refresh tokens were reset" } };
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(gw.hits).toMatchObject({ refresh: 2, register: 1, exchange: 2 }); // + the pre-browser check, which the scripted invalid_request leaves undecided
    expect(browser.opened).toHaveLength(2);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_request: refresh tokens were reset); signing in again`);
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-1" });
  });

  it("a registration refused on cached metadata with a status that is not 400/401 is rediscovered once, then final", async () => {
    const { ra, fetch } = await signedIn();
    gw.revokeClients();
    gw.registerResponse = { status: 403, body: { error: "access_denied" } };
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow();
    expect(ra.status).toEqual({ state: "error", issuer: gw.issuer, error: "the issuer refused to register the client (HTTP 403: access_denied)" });
    // refresh → invalid_client → the SDK drops all (discovery too) and rediscovers → registers (refused) → ours: fresh metadata already, no second pass.
    expect(gw.hits).toMatchObject({ refresh: 1, register: 2, metadata: 4 });
    expect(logs.join("\n")).not.toMatch(/is stale/);
  });

  it("a registration the issuer refuses with another code (HTTP 400) drops everything and tries once more, then reports the error", async () => {
    const { ra, fetch } = await signedIn();
    gw.revokeClients();
    gw.registerResponse = { status: 400, body: { error: "invalid_client_metadata", error_description: "loopback clients are closed" } };
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow(/loopback clients are closed/);
    expect(ra.status).toMatchObject({ state: "error", error: "the issuer refused to register the client (HTTP 400: invalid_client_metadata: loopback clients are closed)" });
    // The SDK's own retry (invalid_client → all) registered once and failed; ours registered once more and failed: bounded.
    expect(gw.hits).toMatchObject({ refresh: 1, register: 3 });
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_client_metadata: loopback clients are closed); signing in again`);
    expect(readTokenFile(file())!.clientInformation).toBeUndefined();
  });

  it("a token endpoint answering a bare 401 (no OAuth body) is a dead token too", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.refreshResponse = { status: 401, body: "nope", contentType: "text/plain" };
    gw.revokeTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(gw.hits).toMatchObject({ refresh: 2, exchange: 2, register: 1 }); // a bare 401 to the pre-browser check is no verdict either: the registration stays
    expect(browser.opened).toHaveLength(2);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (HTTP 401 from the token endpoint); signing in again`);
  });

  it("a moved token endpoint (stale cached issuer metadata) is rediscovered and the refresh retried silently — no browser", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.moveTokenEndpoint();
    gw.expireAccessTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer }); // a silent refresh is not a re-sign-in
    expect(browser.opened).toHaveLength(1);
    expect(gw.hits).toMatchObject({ notFound: 1, refresh: 1, exchange: 1, register: 1, metadata: 4 });
    expect(readTokenFile(file())!.discovery).toMatchObject({ authorizationServerMetadata: { token_endpoint: `${gw.base}/issuer/v2/token` } });
    expect(logs).toContain(`stored issuer metadata for ${gw.serverUrl} is stale (the stored token endpoint answered HTTP 404 to the refresh); rediscovering`);
    expect(logs.join("\n")).not.toMatch(/was rejected/);
  });

  it("(c) a browser flow that also fails ends in `error` with the message — no loop, a bounded number of token requests", async () => {
    const { ra, browser, fetch } = await signedIn();
    browser.mode = "decline";
    gw.revokeTokens();
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow(/access_denied: the user declined/);
    expect(ra.status).toEqual({ state: "error", issuer: gw.issuer, error: "access_denied: the user declined" });
    expect(ra.recoveredAt).toBeUndefined();
    expect(gw.hits).toMatchObject({ refresh: 2, exchange: 1 }); // the dead refresh + the pre-browser check
    expect(browser.opened).toHaveLength(2); // the first sign-in, and this one — a declined consent is not retried by itself
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
    expect(logs.join("\n")).toMatch(/sign-in failed \(issuer .*\): access_denied: the user declined/);
    // The next 401 round is one more browser flow, and no refresh: the dead token is gone from the file.
    expect(readTokenFile(file())!.tokens).toBeUndefined();
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow(/access_denied/);
    expect(gw.hits).toMatchObject({ refresh: 3, exchange: 1 }); // one pre-browser check per browser round, no refresh of a token that is gone
    expect(browser.opened).toHaveLength(3);
    // The user relents: the round after that signs in.
    browser.mode = "consent";
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok" });
  });

  it("an expired access token with a good refresh token is a silent refresh — no browser, not a recovery", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.expireAccessTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(browser.opened).toHaveLength(1);
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 1, metadata: 2 });
    expect(logs).toEqual([`signed in to ${gw.serverUrl} (tokens in ${file()})`]);
  });

  it("concurrent 401s share one sign-in", async () => {
    const { browser, fetch } = await signedIn();
    gw.revokeTokens();
    const results = await Promise.all([1, 2, 3].map(() => fetch(gw.serverUrl, initialize())));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(gw.hits.refresh).toBe(2); // one dead refresh, one pre-browser check — not three of each
    expect(browser.opened).toHaveLength(2);
  });
});

describe("a stale file at start-up", () => {
  /** What a previous proxy left behind: a client the issuer still knows, tokens it has forgotten, the issuer's metadata. */
  function staleFile(port = 4242) {
    gw.clients.add("client-stale");
    writeTokenFile(file(), {
      serverUrl: gw.serverUrl,
      redirectPort: port,
      clientInformation: { client_id: "client-stale", redirect_uris: loopbackRedirectUrls(port), token_endpoint_auth_method: "none" },
      tokens: { access_token: "at-dead", token_type: "Bearer", refresh_token: "rt-dead" },
      tokensSavedAt: 1,
      discovery: { authorizationServerUrl: gw.issuer, resourceMetadataUrl: `${gw.base}/.well-known/oauth-protected-resource/omg` },
    });
  }

  it("(d) RemoteAuth.ensure() goes through the same recovery: the dead token is replaced by a fresh browser sign-in", async () => {
    staleFile();
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer, recovered: true });
    expect(browser.opened).toHaveLength(1);
    expect(gw.hits).toMatchObject({ refresh: 2, exchange: 1, register: 0 }); // the dead refresh, then the pre-browser check (known: invalid_grant)
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-stale" });
    expect(readTokenFile(file())!.tokens?.refresh_token).not.toBe("rt-dead");
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
  });

  it("(d) through startProxy: `ready` settles signed in, /whoami says recovered, and a browser session works", async () => {
    staleFile();
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.remote).toBeInstanceOf(RemoteAuth);
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, recovered: true, recoveredAt: expect.any(String) as unknown as string, client: { source: "registered", id: "client-stale" } });
      expect(browser.opened).toHaveLength(1);
      expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
      const transport = new StreamableHTTPClientTransport(new URL(proxy.url));
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(transport as unknown as Transport);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping"]);
        expect(proxy.whoami().sessions).toEqual([{ id: transport.sessionId, upstream: expect.stringMatching(/^s-\d+$/) as unknown as string }]);
      } finally {
        await transport.terminateSession().catch(() => undefined);
        await client.close();
      }
    } finally {
      await proxy.close();
    }
  });

  it("the ready promise never rejects: a start-up sign-in the user declines leaves state `error` and the proxy up", async () => {
    staleFile();
    const browser = gw.browser("decline");
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.whoami().auth).toEqual({ state: "error", issuer: gw.issuer, error: "access_denied: the user declined", client: { source: "registered", id: "client-stale" } });
      expect(gw.hits).toMatchObject({ refresh: 2, exchange: 0 });
    } finally {
      await proxy.close();
    }
  });
});

describe("half-states of the file", () => {
  /** Exactly the file found on a real machine: tokens with a refresh token, discovery, a PKCE verifier — and no client registration. */
  function fileWithoutRegistration(port = 4242) {
    writeTokenFile(file(), {
      codeVerifier: "stale-verifier",
      discovery: {
        authorizationServerUrl: gw.issuer,
        resourceMetadataUrl: `${gw.base}/.well-known/oauth-protected-resource/omg`,
        resourceMetadata: { resource: gw.serverUrl, authorization_servers: [gw.issuer] },
        authorizationServerMetadata: { issuer: gw.issuer, authorization_endpoint: `${gw.issuer}/authorize`, token_endpoint: `${gw.base}/issuer/token`, registration_endpoint: `${gw.issuer}/register`, response_types_supported: ["code"] },
      },
      redirectPort: port,
      serverUrl: gw.serverUrl,
      tokens: { access_token: "at-orphan", token_type: "Bearer", refresh_token: "rt-orphan", expires_in: 3600 },
      tokensSavedAt: 1,
    });
    expect(Object.keys(readTokenFile(file())!).sort()).toEqual(["codeVerifier", "discovery", "redirectPort", "serverUrl", "tokens", "tokensSavedAt"]);
  }

  it("tokens without a client registration at start-up: the tokens go up front, the client is registered, the browser opens, recovered", async () => {
    fileWithoutRegistration();
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer, recovered: true });
    expect(browser.opened).toHaveLength(1);
    expect(gw.hits).toMatchObject({ register: 1, refresh: 0, exchange: 1 }); // never a refresh without a client id (nor a pre-browser check: the registration is this pass's)
    expect(logs[0]).toBe(`no client registration for ${gw.serverUrl} yet — one is registered with the issuer at the first sign-in`);
    expect(logs[1]).toBe(`stored sign-in for ${gw.serverUrl} has no client registration; registering and signing in again`);
    const stored = readTokenFile(file())!;
    expect(stored.clientInformation).toMatchObject({ client_id: expect.any(String) as unknown as string });
    expect(stored.tokens?.refresh_token).not.toBe("rt-orphan");
  });

  it("the same shape met in a 401 round recovers the same way", async () => {
    const { ra, browser, fetch } = await signedIn();
    ra.provider!.patch({ clientInformation: undefined });
    gw.expireAccessTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(browser.opened).toHaveLength(2);
    expect(gw.hits).toMatchObject({ register: 2, refresh: 0, exchange: 2 });
    expect(logs[0]).toBe(`stored sign-in for ${gw.serverUrl} has no client registration; registering and signing in again`);
  });

  it("tokens without a refresh token are expired: the browser opens, recovered; a registration without tokens is simply the first run", async () => {
    gw.clients.add("client-stale");
    writeTokenFile(file(), { serverUrl: gw.serverUrl, clientInformation: { client_id: "client-stale", redirect_uris: loopbackRedirectUrls(4242) }, tokens: { access_token: "at-only", token_type: "Bearer" }, discovery: { authorizationServerUrl: gw.issuer } });
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toMatchObject({ state: "ok", recovered: true });
    expect(gw.hits).toMatchObject({ register: 0, refresh: 1, exchange: 1 }); // the refresh is the pre-browser check of client-stale
    expect(logs[0]).toBe(`presenting the client registration client-stale for ${gw.serverUrl}`);
    expect(logs[1]).toBe(`stored sign-in for ${gw.serverUrl} has no refresh token; signing in again`);
    await ra.close();
    // Registration only (the first registration happened, no consent yet): no half-state message, not a recovery.
    logs.length = 0;
    writeTokenFile(file(), { serverUrl: gw.serverUrl, clientInformation: { client_id: "client-stale", redirect_uris: loopbackRedirectUrls(4242) }, discovery: { authorizationServerUrl: gw.issuer } });
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(logs.join("\n")).not.toMatch(/stored sign-in/);
  });

  it("an issuer answer without error_description (the SDK's error then has an empty message) still yields a message in `error`", async () => {
    fileWithoutRegistration();
    gw.registerResponse = { status: 403, body: { error: "access_denied" } };
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start());
    await expect(ra.ensure()).rejects.toThrow();
    expect(ra.status).toEqual({ state: "error", issuer: gw.issuer, error: "the issuer refused to register the client (HTTP 403: access_denied)" });
    expect(browser.opened).toHaveLength(0);
    // Dropping the orphaned tokens dropped the cached discovery with them, so the registration already ran on fresh metadata: refused once, final.
    expect(gw.hits).toMatchObject({ register: 1, refresh: 0, metadata: 2 });
    expect(logs[1]).toBe(`stored sign-in for ${gw.serverUrl} has no client registration; registering and signing in again`);
    expect(logs.join("\n")).not.toMatch(/is stale/);
    expect(logs.at(-1)).toBe(`sign-in failed (issuer ${gw.issuer}): the issuer refused to register the client (HTTP 403: access_denied)`);
    // Once the issuer registers again, the next 401 round signs in.
    gw.registerResponse = null;
    expect((await ra.fetchWithAuth()(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok" });
  });

  it("Auth0's capped tenant (HTTP 403 too_many_entities, which the SDK turns into an empty ServerError) is named, with the hint, in /whoami and the log", async () => {
    fileWithoutRegistration();
    gw.registerResponse = { status: 403, body: { error: "Forbidden", message: "You reached the limit of entities of this type for this tenant.", errorCode: "too_many_entities" } };
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      const expected = `the issuer refused to register the client (HTTP 403: Forbidden: You reached the limit of entities of this type for this tenant. (too_many_entities)); ${TOO_MANY_ENTITIES_HINT}`;
      expect(proxy.whoami().auth).toEqual({ state: "error", issuer: gw.issuer, error: expected, client: { source: "registered", id: null } }); // no registration yet: the issuer refused it
      expect(logs.at(-1)).toBe(`sign-in failed (issuer ${gw.issuer}): ${expected}`);
      expect(browser.opened).toHaveLength(0);
      expect(gw.hits).toMatchObject({ register: 1, refresh: 0 });
      // The tenant is cleaned up; the user presses a.
      gw.registerResponse = null;
      await proxy.remote!.reauthorize();
      expect(proxy.whoami().auth).toMatchObject({ state: "ok" });
      expect(gw.hits).toMatchObject({ register: 2, exchange: 1 });
    } finally {
      await proxy.close();
    }
  });

  it("a registration refused with a message but no OAuth code still names what the issuer said", async () => {
    fileWithoutRegistration();
    gw.registerResponse = { status: 429, body: { message: "slow down" } };
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: gw.browser() }).start());
    await expect(ra.ensure()).rejects.toThrow();
    expect(ra.status.error).toBe("the issuer refused to register the client (HTTP 429: slow down)");
  });

  it("failureMessage never returns an empty string", () => {
    const r = new RemoteAuth({ serverUrl: gw.serverUrl, file: file() });
    expect(r.failureMessage(new Error(""))).toBe("authorization failed before the issuer was contacted (stored credential unusable)");
    expect(r.failureMessage(undefined)).toMatch(/^authorization failed/);
    expect(r.failureMessage("")).toMatch(/^authorization failed/);
    expect(r.failureMessage(new Error("real"))).toBe("real");
    r.phase = "browser";
    r.lastResult = "REDIRECT";
    expect(r.failureMessage(new TypeError(""))).toBe("authorization failed in the browser flow (TypeError); auth() returned REDIRECT");
  });
});

describe("registration conservation", () => {
  it("a dead refresh token with a valid registration never re-registers — across every token-side failure and the half-state audit", async () => {
    const { ra, browser, fetch } = await signedIn();
    const registration = JSON.stringify(readTokenFile(file())!.clientInformation);
    const rounds: (() => void)[] = [
      () => gw.revokeTokens(),                                                                                          // invalid_grant
      () => { gw.revokeTokens(); gw.refreshResponse = { status: 400, body: { error: "invalid_request" } }; },           // another code, no description
      () => { gw.revokeTokens(); gw.refreshResponse = { status: 401, body: "nope", contentType: "text/plain" }; },     // bare 401
      () => { gw.expireAccessTokens(); ra.provider!.patch({ tokens: { access_token: "at-only", token_type: "Bearer" } }); }, // no refresh token
      () => { gw.moveTokenEndpoint(); gw.expireAccessTokens(); },                                                      // stale metadata
    ];
    for (const [i, round] of rounds.entries()) {
      gw.refreshResponse = null;
      round();
      expect((await fetch(gw.serverUrl, initialize())).status, `round ${i}`).toBe(200);
      expect(ra.status.state, `round ${i}`).toBe("ok");
      expect(gw.hits.register, `round ${i}`).toBe(1);
      expect(JSON.stringify(readTokenFile(file())!.clientInformation), `round ${i}`).toBe(registration);
    }
    expect(browser.opened).toHaveLength(5); // the first sign-in + one per round except the silent rediscovery
    expect(logs.join("\n")).not.toMatch(/registering/);
  });

  it("the half-state audit on a file with a registration drops tokens only", async () => {
    gw.clients.add("client-kept");
    writeTokenFile(file(), { serverUrl: gw.serverUrl, clientInformation: { client_id: "client-kept", redirect_uris: loopbackRedirectUrls(4242) }, tokens: { access_token: "at", token_type: "Bearer" }, discovery: { authorizationServerUrl: gw.issuer } });
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: gw.browser() }).start());
    await ra.ensure();
    expect(gw.hits.register).toBe(0);
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-kept" });
  });
});

describe("--logout", () => {
  it("(e) deletes the file; the next request registers and signs in afresh (not a recovery)", async () => {
    const { ra, browser, fetch } = await signedIn();
    expect(ra.logout()).toBe(true);
    expect(existsSync(file())).toBe(false);
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(gw.hits).toMatchObject({ register: 2, exchange: 2, refresh: 0 });
    expect(browser.opened).toHaveLength(2);
    expect(logs.join("\n")).not.toMatch(/was rejected/);
    // The CLI's function over the same file.
    const messages: string[] = [];
    expect(logout({ remote: gw.serverUrl, tokenFile: file() }, (m) => messages.push(m))).toEqual([file()]);
    expect(existsSync(file())).toBe(false);
  });
});
