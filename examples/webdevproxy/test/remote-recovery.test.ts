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
import { RemoteAuth, loopbackRedirectUrls, readTokenFile, writeTokenFile } from "../src/remote-auth.mjs";
import { logout, startProxy } from "../src/proxy.mjs";
import { FakeGateway, type FakeBrowser } from "./fixtures/fake-gateway.ts";

let dir: string;
let gw: FakeGateway;
let logs: string[];
let ra: RemoteAuth | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-recovery-"));
  gw = await FakeGateway.start();
  logs = [];
  ra = null;
});
afterEach(async () => {
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

/** A RemoteAuth over the fake gateway, signed in once through the fake user's browser. */
async function signedIn(browser: FakeBrowser = gw.browser()) {
  ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start();
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
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 2, register: 1, metadata: 4 }); // rediscovered, not re-registered
    expect(browser.opened).toHaveLength(2);
    const stored = readTokenFile(file())!;
    expect(stored.clientInformation).toMatchObject({ client_id: "client-1" });
    expect(stored.tokens?.refresh_token).not.toBe("rt-3");
    expect(gw.accessTokens.has(String(stored.tokens!.access_token))).toBe(true);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
    expect(logs.join("\n")).toMatch(/^signed in again to /m);
    // Settled: the next request neither refreshes nor opens a browser.
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(gw.hits.refresh).toBe(1);
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
    expect(gw.hits).toMatchObject({ refresh: 1, register: 1, exchange: 2 });
    expect(browser.opened).toHaveLength(2);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_request: refresh tokens were reset); signing in again`);
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-1" });
  });

  it("a registration the issuer refuses with another code (HTTP 400) drops everything and tries once more, then reports the error", async () => {
    const { ra, fetch } = await signedIn();
    gw.revokeClients();
    gw.registerResponse = { status: 400, body: { error: "invalid_client_metadata", error_description: "loopback clients are closed" } };
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow(/loopback clients are closed/);
    expect(ra.status).toMatchObject({ state: "error", error: "loopback clients are closed" });
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
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 2, register: 1 });
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
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 1 });
    expect(browser.opened).toHaveLength(2); // the first sign-in, and this one — a declined consent is not retried by itself
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
    expect(logs.join("\n")).toMatch(/sign-in failed \(issuer .*\): access_denied: the user declined/);
    // The next 401 round is one more browser flow, and no refresh: the dead token is gone from the file.
    expect(readTokenFile(file())!.tokens).toBeUndefined();
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow(/access_denied/);
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 1 });
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
    expect(gw.hits.refresh).toBe(1);
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
    ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log, openBrowser: browser }).start();
    await ra.ensure();
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer, recovered: true });
    expect(browser.opened).toHaveLength(1);
    expect(gw.hits).toMatchObject({ refresh: 1, exchange: 1, register: 0 });
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-stale" });
    expect(readTokenFile(file())!.tokens?.refresh_token).not.toBe("rt-dead");
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
  });

  it("(d) through startProxy: `ready` settles signed in, /whoami says recovered, and a browser session works", async () => {
    staleFile();
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser });
    try {
      await proxy.ready;
      expect(proxy.remote).toBeInstanceOf(RemoteAuth);
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, recovered: true, recoveredAt: expect.any(String) as unknown as string });
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
      await proxy.ready;
      expect(proxy.whoami().auth).toEqual({ state: "error", issuer: gw.issuer, error: "access_denied: the user declined" });
      expect(gw.hits).toMatchObject({ refresh: 1, exchange: 0 });
    } finally {
      await proxy.close();
    }
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
