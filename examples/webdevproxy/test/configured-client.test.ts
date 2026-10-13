// `--client-id` / WEBDEVPROXY_CLIENT_ID: one pre-registered public client
// instead of a dynamic registration per run (an issuer that caps registrations
// — Auth0's `too_many_entities` — never fills up). Over the fake gateway with a
// `fixedClient` whose one allowed callback URL is exact (Auth0 accepts no port
// wildcard), so the loopback port is fixed (`--callback-port`, default 8790
// under `--client-id`): the registration endpoint is never hit — first run,
// refresh, dead-refresh recovery, `a`, `l`; the id is config, not state (kept
// through `invalidateCredentials("all")`, `l` and `--logout`; never written to
// the file); a token endpoint that rejects the id is a configuration error with
// a precise message, never a fall-back to registration; a taken fixed port is a
// clear start-up error, never another port; flag over env over absent.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { InvalidClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { DEFAULT_CALLBACK_PORT, parseArgs, validateArgs } from "../src/args.mjs";
import { startPrompt } from "../src/prompt.mjs";
import { logout, startProxy } from "../src/proxy.mjs";
import { CONFIGURED_CLIENT_REJECTED, FileOAuthProvider, RemoteAuth, callbackPortInUse, configuredClientRejected, loopbackRedirectUrls, readTokenFile, writeTokenFile } from "../src/remote-auth.mjs";
import { FakeGateway, type FakeBrowser, until } from "./fixtures/fake-gateway.ts";

const CLIENT = "fixed-native-app";

/** A loopback port nothing listens on right now (bound once, released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}
/** Hold a port (something else is listening on it). */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

let dir: string;
let gw: FakeGateway;
/** This test's fixed callback port — the one URL the fixed application allows. */
let port: number;
let logs: string[];
let ra: RemoteAuth | null;
let statuses: RemoteAuth["status"][];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-client-id-"));
  gw = await FakeGateway.start();
  port = await freePort();
  gw.fixedClient(CLIENT, port);
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
const callback = () => `http://127.0.0.1:${port}/callback`;
const REJECTED = `the configured client id ${CLIENT} was rejected by the issuer (invalid_client) — check WEBDEVPROXY_CLIENT_ID / --client-id against the tenant's application`;

/** Signed in once as the configured client: no registration, one browser tab, one code exchange. */
async function signedIn(browser: FakeBrowser = gw.browser()) {
  ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT, callbackPort: port, log, openBrowser: browser }).start());
  await ra.ensure();
  expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
  expect(browser.opened).toHaveLength(1);
  expect(gw.hits).toMatchObject({ register: 0, exchange: 1, refresh: 0 });
  expect(logs[0]).toBe(`using the configured client id ${CLIENT} (no dynamic registration)`);
  expect(logs[1]).toBe(`sign-in callback fixed at ${callback()} — the application's allowed callback URL`);
  logs.length = 0;
  return { ra, browser, fetch: ra.fetchWithAuth() };
}

describe("--client-id: a pre-registered public client", () => {
  it("first run: no registration, a PKCE authorization as the configured client with exactly one redirect_uri — the fixed loopback URL — a public code exchange, tokens in the file without a registration, /whoami says configured", async () => {
    const browser = gw.browser();
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), clientId: CLIENT, callbackPort: port, port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, client: { source: "configured", id: CLIENT } });
      expect(proxy.remote!.clientId).toBe(CLIENT);
      expect(proxy.remote!.callbackPort).toBe(port);
      expect(proxy.remote!.loopback!.port).toBe(port);
      expect(logs).toContain(`using the configured client id ${CLIENT} (no dynamic registration)`);
      expect(logs).toContain(`sign-in callback fixed at ${callback()} — the application's allowed callback URL`);
      expect(gw.hits).toMatchObject({ register: 0, exchange: 1, refresh: 0, metadata: 2 });
      // The authorization request: the configured id, PKCE, exactly one redirect_uri — the application's allowed URL, verbatim (the fake compares exactly, as Auth0 does).
      expect(browser.opened).toHaveLength(1);
      const u = new URL(browser.opened[0]!);
      expect(u.pathname).toBe("/issuer/authorize");
      expect(u.searchParams.get("client_id")).toBe(CLIENT);
      expect(u.searchParams.get("response_type")).toBe("code");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("code_challenge")).toMatch(/\S/);
      expect(u.searchParams.getAll("redirect_uri")).toEqual([callback()]);
      expect(callback()).toBe(loopbackRedirectUrls(port)[0]); // the 127.0.0.1 form, never the localhost twin
      // The code exchange authenticated as a public client — `client_id` in the form, no secret, no Basic header — with the same redirect_uri.
      expect(gw.tokenRequests).toEqual([{ grant: "authorization_code", clientId: CLIENT, auth: "none", redirectUri: callback() }]);
      // The file: tokens and discovery, no `clientInformation` (the id is configuration, not state).
      const stored = readTokenFile(file())!;
      expect(Object.keys(stored)).not.toContain("clientInformation");
      expect(stored.discovery).toMatchObject({ authorizationServerUrl: gw.issuer });
      expect(stored.tokens).toMatchObject({ access_token: expect.any(String) as unknown as string, refresh_token: expect.any(String) as unknown as string });
      // And it works: an authenticated request reaches the gateway.
      const res = await proxy.remote!.fetchWithAuth()(gw.serverUrl, initialize());
      expect(res.status).toBe(200);
    } finally {
      await proxy.close();
    }
  });

  it("the registration endpoint is never hit: first run, a silent refresh, a dead-refresh recovery with the same id, `a`, and `l` from the terminal", async () => {
    const { ra, browser, fetch } = await signedIn();
    // A silent refresh.
    gw.expireAccessTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(gw.hits).toMatchObject({ register: 0, refresh: 1, exchange: 1 });
    expect(browser.opened).toHaveLength(1);
    // A dead refresh token: the browser flow again, as the same client.
    gw.revokeTokens();
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer, recovered: true });
    expect(browser.opened).toHaveLength(2);
    expect(new URL(browser.opened[1]!).searchParams.get("client_id")).toBe(CLIENT);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} was rejected (invalid_grant: unknown refresh token); signing in again`);
    expect(gw.hits).toMatchObject({ register: 0, refresh: 2, exchange: 2 });
    // `a` (drop the tokens, sign in afresh) and `l` (forget the file, sign in fresh) over the terminal keys: the id survives both.
    const input = new PassThrough();
    const prompt = startPrompt({ remote: ra, proxy: { close: async () => {} }, input, log, exit: () => {} });
    try {
      input.write("a\n");
      await until(() => gw.hits.exchange === 3 && ra.inflight === null);
      input.write("l\n");
      await until(() => gw.hits.exchange === 4 && ra.inflight === null);
    } finally {
      prompt.close();
    }
    expect(ra.status).toMatchObject({ state: "ok", issuer: gw.issuer });
    expect(logs.join("\n")).toMatch(/^forgetting the tokens for .* — signing in fresh$/m);
    expect(browser.opened).toHaveLength(4);
    expect(gw.hits.register).toBe(0);
    expect(gw.tokenRequests).toHaveLength(6);
    expect(gw.tokenRequests.every((t) => t.clientId === CLIENT && t.auth === "none")).toBe(true);
    for (const url of browser.opened) {
      expect(new URL(url).searchParams.get("client_id")).toBe(CLIENT);
      expect(new URL(url).searchParams.get("redirect_uri")).toBe(callback());
    }
    expect(ra.client()).toEqual({ source: "configured", id: CLIENT });
    expect(readTokenFile(file())!.clientInformation).toBeUndefined();
    expect(logs.join("\n")).not.toMatch(/registering/);
  });

  it("`--logout` deletes the file; the next run presents the same configured id — still no registration", async () => {
    const { ra, browser, fetch } = await signedIn();
    expect(logout({ remote: gw.serverUrl, tokenFile: file() }, log)).toEqual([file()]);
    expect(ra.logout()).toBe(false); // already gone
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(browser.opened).toHaveLength(2);
    expect(gw.hits).toMatchObject({ register: 0, exchange: 2, refresh: 0 });
    expect(ra.client()).toEqual({ source: "configured", id: CLIENT });
  });
});

describe("the token endpoint rejects the configured id", () => {
  it("invalid_client on the refresh (the id is wrong or deleted on the tenant): the exact message, no registration attempt, no browser tab", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.clients.delete(CLIENT); // deleted in the tenant's dashboard
    gw.expireAccessTokens();
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow();
    expect(ra.status).toEqual({ state: "error", issuer: gw.issuer, error: REJECTED });
    expect(REJECTED).toBe(configuredClientRejected(CLIENT));
    expect(logs.at(-1)).toBe(`sign-in failed (issuer ${gw.issuer}): ${REJECTED}`);
    expect(logs.join("\n")).not.toMatch(/stored sign-in .* was rejected|registering/);
    // The SDK's own answer to invalid_client — drop everything, register — did not happen: zero registrations, the browser never opened again.
    expect(gw.hits).toMatchObject({ register: 0, refresh: 1, exchange: 1 });
    expect(browser.opened).toHaveLength(1);
    // The dead tokens are gone (the SDK's `invalidateCredentials("all")`), the id is not in the file to lose.
    expect(readTokenFile(file())!.tokens).toBeUndefined();
    expect(ra.client()).toEqual({ source: "configured", id: CLIENT });
    expect(ra.provider!.clientInformation()).toEqual({ client_id: CLIENT, token_endpoint_auth_method: "none" });
    // Once the application exists again in the tenant, the next 401 round signs in — as that id, no registration.
    gw.clients.add(CLIENT);
    expect((await fetch(gw.serverUrl, initialize())).status).toBe(200);
    expect(ra.status).toMatchObject({ state: "ok" });
    expect(gw.hits.register).toBe(0);
    expect(new URL(browser.opened[1]!).searchParams.get("client_id")).toBe(CLIENT);
  });

  it("unauthorized_client is the same configuration error, named with its code", async () => {
    const { ra, browser, fetch } = await signedIn();
    gw.expireAccessTokens();
    gw.refreshResponse = { status: 400, body: { error: "unauthorized_client", error_description: "grant not allowed" } };
    await expect(fetch(gw.serverUrl, initialize())).rejects.toThrow();
    expect(ra.status).toEqual({ state: "error", issuer: gw.issuer, error: configuredClientRejected(CLIENT, "unauthorized_client") });
    expect(ra.status.error).toMatch(/\(unauthorized_client\) — check WEBDEVPROXY_CLIENT_ID/);
    expect(gw.hits).toMatchObject({ register: 0, refresh: 1 });
    expect(browser.opened).toHaveLength(1);
  });

  it("through startProxy: /whoami carries the message and the configured client; the error is not retried by itself", async () => {
    const browser = gw.browser();
    writeTokenFile(file(), { serverUrl: gw.serverUrl, tokens: { access_token: "at-dead", token_type: "Bearer", refresh_token: "rt-dead" }, discovery: { authorizationServerUrl: gw.issuer } });
    gw.clients.delete(CLIENT);
    const proxy = await startProxy({ remote: gw.serverUrl, tokenFile: file(), clientId: CLIENT, callbackPort: port, port: 0, log, openBrowser: browser });
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.whoami().auth).toEqual({ state: "error", issuer: gw.issuer, error: REJECTED, client: { source: "configured", id: CLIENT } });
      expect(browser.opened).toHaveLength(0);
      expect(gw.hits).toMatchObject({ register: 0, refresh: 1 });
    } finally {
      await proxy.close();
    }
  });

  it("failureMessage names the configured id for an invalid_client from the code exchange too, and deadCredential never calls it dead", () => {
    const r = new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT });
    r.phase = "browser";
    expect(r.failureMessage(new InvalidClientError("unknown client"))).toBe(REJECTED);
    expect(r.deadCredential(new InvalidClientError("unknown client"))).toBeNull();
    const tagged = Object.assign(new Error(REJECTED), { name: CONFIGURED_CLIENT_REJECTED });
    expect(r.failureMessage(tagged)).toBe(REJECTED);
    expect(r.deadCredential(tagged)).toBeNull();
    // Without a configured id the same error is a dead registration (today's behaviour).
    const dynamic = new RemoteAuth({ serverUrl: gw.serverUrl, file: file() });
    expect(dynamic.deadCredential(new InvalidClientError("unknown client"))).toEqual({ scope: "all", reason: "unknown client" });
    expect(dynamic.failureMessage(new InvalidClientError("unknown client"))).toBe("unknown client");
  });
});

describe("the id is configuration, not state", () => {
  it("tokens without a `clientInformation` are whole: a silent refresh at start-up, no half-state message, no browser", async () => {
    gw.refreshTokens.add("rt-fixed");
    writeTokenFile(file(), { serverUrl: gw.serverUrl, tokens: { access_token: "at-expired", token_type: "Bearer", refresh_token: "rt-fixed" }, tokensSavedAt: 1, discovery: { authorizationServerUrl: gw.issuer } });
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT, callbackPort: port, log, openBrowser: browser }).start());
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer }); // not a recovery
    expect(browser.opened).toHaveLength(0);
    expect(gw.hits).toMatchObject({ register: 0, refresh: 1, exchange: 0 });
    expect(gw.tokenRequests).toEqual([{ grant: "refresh_token", clientId: CLIENT, auth: "none", redirectUri: null }]);
    expect(logs.join("\n")).not.toMatch(/stored sign-in/);
    expect(readTokenFile(file())!.tokens?.refresh_token).not.toBe("rt-fixed"); // rotated
    // Tokens without a refresh token are still expired, with or without a configured id.
    ra.provider!.patch({ tokens: { access_token: "at-only", token_type: "Bearer" } });
    gw.expireAccessTokens();
    expect((await ra.fetchWithAuth()(gw.serverUrl, initialize())).status).toBe(200);
    expect(logs).toContain(`stored sign-in for ${gw.serverUrl} has no refresh token; signing in again`);
    expect(gw.hits.register).toBe(0);
  });

  it("the provider: clientInformation() is the configured public client whatever the file says, saveClientInformation stores nothing, invalidateCredentials keeps the id — all drops tokens + discovery, client nothing", () => {
    const p = new FileOAuthProvider({ serverUrl: gw.serverUrl, file: file(), redirectUrls: loopbackRedirectUrls(4242), clientId: CLIENT });
    expect(p.clientInformation()).toEqual({ client_id: CLIENT, token_endpoint_auth_method: "none" });
    expect(p.clientInformation()).not.toHaveProperty("client_secret");
    p.saveClientInformation({ client_id: "from-the-sdk", client_secret: "never" });
    expect(readTokenFile(file())).toBeNull(); // nothing written
    p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
    p.saveDiscoveryState({ authorizationServerUrl: gw.issuer });
    p.saveCodeVerifier("v");
    p.invalidateCredentials("client");
    expect(p.clientInformation()).toEqual({ client_id: CLIENT, token_endpoint_auth_method: "none" });
    expect(p.tokens()?.refresh_token).toBe("r");
    p.invalidateCredentials("all");
    expect(p.clientInformation()).toEqual({ client_id: CLIENT, token_endpoint_auth_method: "none" });
    expect(readTokenFile(file())).toEqual({ serverUrl: gw.serverUrl });
    // The same metadata a dynamic registration would have sent is still what the client is (for the README's settings).
    expect(p.clientMetadata).toMatchObject({ token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    // An empty id means "register", as today.
    expect(new FileOAuthProvider({ serverUrl: gw.serverUrl, file: file(), redirectUrls: loopbackRedirectUrls(4242), clientId: "" }).clientInformation()).toBeUndefined();
  });

  it("a registration a run without the flag left in the file is neither presented nor touched; its port gives way to the fixed callback port", async () => {
    gw.clients.add("client-old");
    writeTokenFile(file(), { serverUrl: gw.serverUrl, redirectPort: 1, clientInformation: { client_id: "client-old", redirect_uris: loopbackRedirectUrls(1), token_endpoint_auth_method: "none" }, discovery: { authorizationServerUrl: gw.issuer } });
    const browser = gw.browser();
    ra = track(await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT, callbackPort: port, log, openBrowser: browser }).start());
    expect(ra.loopback!.port).toBe(port);
    expect(readTokenFile(file())!.redirectPort).toBe(port);
    await ra.ensure();
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(new URL(browser.opened[0]!).searchParams.get("client_id")).toBe(CLIENT);
    expect(gw.hits).toMatchObject({ register: 0, exchange: 1 });
    expect(readTokenFile(file())!.clientInformation).toEqual({ client_id: "client-old", redirect_uris: loopbackRedirectUrls(1), token_endpoint_auth_method: "none" });
    expect(ra.client()).toEqual({ source: "configured", id: CLIENT });
    // The SDK's "all" on a rejected id leaves it alone too.
    ra.provider!.invalidateCredentials("all");
    expect(readTokenFile(file())!.clientInformation).toMatchObject({ client_id: "client-old" });
    expect(logs.join("\n")).not.toMatch(/re-registering/);
  });
});

describe("precedence and surfacing", () => {
  it("flag over env over absent — through parseArgs and startProxy; absent is today's dynamic registration with `source: registered`", async () => {
    expect(parseArgs(["--client-id", "flag-app"], { WEBDEVPROXY_CLIENT_ID: "env-app" }).clientId).toBe("flag-app");
    expect(parseArgs([], { WEBDEVPROXY_CLIENT_ID: "env-app" }).clientId).toBe("env-app");
    expect(parseArgs([], {}).clientId).toBeNull();
    // The environment variable through startProxy.
    const browser = gw.browser();
    const viaEnv = await startProxy({ remote: gw.serverUrl, tokenFile: file(), port: 0, log, openBrowser: browser, env: { WEBDEVPROXY_CLIENT_ID: CLIENT, WEBDEVPROXY_CALLBACK_PORT: String(port) } });
    try {
      track(viaEnv.remote!);
      await viaEnv.ready;
      expect(viaEnv.whoami().auth.client).toEqual({ source: "configured", id: CLIENT });
      expect(gw.hits).toMatchObject({ register: 0, exchange: 1 });
    } finally {
      await viaEnv.close();
    }
    // The flags over the variables (the callback port too: the fake application allows only the flag's URL).
    const flagPort = await freePort();
    gw.fixedClient("flag-app", flagPort);
    const viaFlag = await startProxy({ remote: gw.serverUrl, tokenFile: join(dir, "flag.json"), port: 0, log, openBrowser: browser, env: { WEBDEVPROXY_CLIENT_ID: CLIENT, WEBDEVPROXY_CALLBACK_PORT: String(port) }, argv: ["--client-id", "flag-app", "--callback-port", String(flagPort)] });
    try {
      track(viaFlag.remote!);
      await viaFlag.ready;
      expect(viaFlag.whoami().auth.client).toEqual({ source: "configured", id: "flag-app" });
      expect(viaFlag.remote!.callbackPort).toBe(flagPort);
      expect(new URL(browser.opened[1]!).searchParams.get("client_id")).toBe("flag-app");
      expect(new URL(browser.opened[1]!).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${flagPort}/callback`);
      expect(gw.hits).toMatchObject({ register: 0, exchange: 2 });
    } finally {
      await viaFlag.close();
    }
    // Neither: a dynamic registration, as before, and /whoami says so (`id` null until the issuer answers).
    logs.length = 0;
    const dynamic = await startProxy({ remote: gw.serverUrl, tokenFile: join(dir, "dynamic.json"), port: 0, log, openBrowser: browser, env: {} });
    try {
      track(dynamic.remote!);
      await dynamic.ready;
      expect(dynamic.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, client: { source: "registered", id: expect.stringMatching(/^client-\d+$/) as unknown as string } });
      expect(dynamic.remote!.callbackPort).toBeNull(); // ephemeral, as today
      expect(dynamic.remote!.loopback!.port).not.toBe(DEFAULT_CALLBACK_PORT);
      expect(gw.hits).toMatchObject({ register: 1, exchange: 3 });
      expect(readTokenFile(join(dir, "dynamic.json"))!.clientInformation).toMatchObject({ client_id: dynamic.whoami().auth.client!.id });
      expect(logs.join("\n")).not.toMatch(/using the configured client id/);
    } finally {
      await dynamic.close();
    }
    // Before any registration: `registered` with no id yet.
    const fresh = new RemoteAuth({ serverUrl: gw.serverUrl, file: join(dir, "none.json") });
    expect(fresh.client()).toEqual({ source: "registered", id: null });
  });
});

describe("the callback port", () => {
  it("defaults: ephemeral without --client-id, the fixed DEFAULT_CALLBACK_PORT with it, an explicit --callback-port over both; validateArgs bounds it", () => {
    expect(DEFAULT_CALLBACK_PORT).toBe(8790);
    expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file() }).callbackPort).toBeNull();
    expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT }).callbackPort).toBe(DEFAULT_CALLBACK_PORT);
    expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT, callbackPort: 9123 }).callbackPort).toBe(9123);
    expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), callbackPort: 9123 }).callbackPort).toBe(9123); // a fixed port for a dynamic registration too
    expect(parseArgs(["--callback-port", "9123"], { WEBDEVPROXY_CALLBACK_PORT: "9124" }).callbackPort).toBe(9123);
    expect(parseArgs([], { WEBDEVPROXY_CALLBACK_PORT: "9124" }).callbackPort).toBe(9124);
    expect(parseArgs([], {}).callbackPort).toBeNull();
    expect(validateArgs(parseArgs(["--local", "a", "--callback-port", "0"], {}))).toMatch(/--callback-port must be 1\.\.65535/);
    expect(validateArgs(parseArgs(["--local", "a", "--callback-port", "x"], {}))).toMatch(/--callback-port/);
    expect(validateArgs(parseArgs(["--remote", gw.serverUrl, "--client-id", CLIENT, "--callback-port", "8790"], {}))).toBeNull();
  });

  it("--client-id without --callback-port binds the well-known port and sends exactly http://127.0.0.1:8790/callback (or, when this machine has it taken, fails naming the flag)", async () => {
    const DEFAULT = "default-port-app";
    gw.fixedClient(DEFAULT, DEFAULT_CALLBACK_PORT);
    const browser = gw.browser();
    const run = () => startProxy({ remote: gw.serverUrl, tokenFile: join(dir, "default.json"), clientId: DEFAULT, port: 0, log, openBrowser: browser });
    let probe: Server | null = null;
    try { probe = await occupy(DEFAULT_CALLBACK_PORT); } catch { probe = null; }
    if (probe) {
      // Something on this machine owns 8790 right now: the proxy must refuse to start rather than drift to another port.
      await new Promise<void>((r) => probe!.close(() => r()));
      const holder = await occupy(DEFAULT_CALLBACK_PORT).catch(() => null);
      if (!holder) return; // raced; nothing to assert either way
      try {
        await expect(run()).rejects.toThrow(callbackPortInUse(DEFAULT_CALLBACK_PORT));
      } finally {
        await new Promise<void>((r) => holder.close(() => r()));
      }
      // Free again: the default binds.
    }
    const proxy = await run();
    try {
      track(proxy.remote!);
      await proxy.ready;
      expect(proxy.remote!.callbackPort).toBe(DEFAULT_CALLBACK_PORT);
      expect(proxy.remote!.loopback!.redirectUrl).toBe(`http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`);
      expect(proxy.whoami().auth).toEqual({ state: "ok", issuer: gw.issuer, client: { source: "configured", id: DEFAULT } });
      expect(new URL(browser.opened[0]!).searchParams.getAll("redirect_uri")).toEqual([`http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`]);
      expect(gw.tokenRequests.at(-1)).toEqual({ grant: "authorization_code", clientId: DEFAULT, auth: "none", redirectUri: `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback` });
      expect(logs).toContain(`sign-in callback fixed at http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback — the application's allowed callback URL`);
      expect(gw.hits.register).toBe(0);
    } finally {
      await proxy.close();
    }
  });

  it("a fixed callback port that is taken is a clear start-up error naming the flag — never another port (RemoteAuth.start and startProxy alike)", async () => {
    const holder = await occupy(port);
    try {
      const expected = callbackPortInUse(port);
      expect(expected).toBe(`callback port ${port} is in use — the sign-in redirect must be exactly http://127.0.0.1:${port}/callback (the application's allowed callback URL), so another port will not do; free the port, or pick one with --callback-port <n> / WEBDEVPROXY_CALLBACK_PORT and allow http://127.0.0.1:<n>/callback on the application`);
      await expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), clientId: CLIENT, callbackPort: port, log }).start()).rejects.toThrow(expected);
      await expect(startProxy({ remote: gw.serverUrl, tokenFile: file(), clientId: CLIENT, callbackPort: port, port: 0, log })).rejects.toThrow(expected);
      // An explicit --callback-port without --client-id is just as strict.
      await expect(new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), callbackPort: port, log }).start()).rejects.toThrow(expected);
      expect(logs.join("\n")).not.toMatch(/sign-in callback fixed|is busy/);
      // Whereas a registered client's remembered port (no fixed port asked for) still gives way to an ephemeral one and re-registers, as today.
      writeTokenFile(file(), { serverUrl: gw.serverUrl, redirectPort: port, clientInformation: { client_id: "client-old", redirect_uris: loopbackRedirectUrls(port) } });
      ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: file(), log }).start();
      expect(ra.loopback!.port).not.toBe(port);
      expect(logs).toContain(`loopback port ${port} is busy — using ${ra.loopback!.port} and re-registering the client`);
      expect(readTokenFile(file())!.clientInformation).toBeUndefined();
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });
});
