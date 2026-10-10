import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileOAuthProvider, configDir, deleteTokenFile, listTokenFiles, loopbackRedirectUrls, parseLoopbackCallback, readTokenFile,
  serverUrlHash, startLoopback, tokenFilePath, writeTokenFile,
} from "../scripts/lib/remote-auth.mjs";
import { normalizeServerUrl } from "../src/lib/oauth-shared.mjs";

const SERVER = "https://mcp.example.com/omg";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "graph-ui-auth-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("token file path", () => {
  it("hashes the normalized server URL (trailing slash and case of the host do not matter)", () => {
    expect(serverUrlHash(SERVER)).toMatch(/^[0-9a-f]{16}$/);
    expect(serverUrlHash(`${SERVER}/`)).toBe(serverUrlHash(SERVER));
    expect(serverUrlHash("https://MCP.example.com/omg")).toBe(serverUrlHash(SERVER));
    expect(serverUrlHash("https://mcp.example.com/other")).not.toBe(serverUrlHash(SERVER));
    expect(normalizeServerUrl(`${SERVER}/`)).toBe(SERVER);
  });
  it("lives under $XDG_CONFIG_HOME or ~/.config, unless GRAPH_UI_TOKEN_FILE overrides it", () => {
    expect(configDir({ HOME: "/home/u" })).toBe("/home/u/.config/omgbase-graph-ui");
    expect(configDir({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/omgbase-graph-ui");
    expect(tokenFilePath(SERVER, { env: { HOME: "/home/u" } })).toBe(`/home/u/.config/omgbase-graph-ui/${serverUrlHash(SERVER)}.json`);
    expect(tokenFilePath(SERVER, { env: { HOME: "/home/u", GRAPH_UI_TOKEN_FILE: "/tmp/t.json" } })).toBe("/tmp/t.json");
    expect(tokenFilePath(SERVER, { env: {}, dir })).toBe(join(dir, `${serverUrlHash(SERVER)}.json`));
  });
});

describe("token file round trip", () => {
  it("writes 0600, reads back, lists and deletes", () => {
    const file = join(dir, "nested", "t.json");
    expect(readTokenFile(file)).toBeNull();
    const data = { serverUrl: SERVER, clientInformation: { client_id: "cid" }, tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" }, codeVerifier: "v" };
    writeTokenFile(file, data);
    expect(readTokenFile(file)).toEqual(data);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('"serverUrl"');
    expect(listTokenFiles(join(dir, "nested"))).toEqual([file]);
    expect(deleteTokenFile(file)).toBe(true);
    expect(deleteTokenFile(file)).toBe(false);
    expect(readTokenFile(file)).toBeNull();
    expect(listTokenFiles(join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("loopback redirect", () => {
  it("names 127.0.0.1 first and localhost second", () => {
    expect(loopbackRedirectUrls(51763)).toEqual(["http://127.0.0.1:51763/callback", "http://localhost:51763/callback"]);
  });
  it("parses the callback: code with matching state, errors, mismatches, other paths", () => {
    expect(parseLoopbackCallback("/callback?code=abc&state=st", "st")).toEqual({ kind: "code", code: "abc" });
    expect(parseLoopbackCallback("/callback?code=abc&state=st", undefined)).toEqual({ kind: "code", code: "abc" });
    expect(parseLoopbackCallback("/callback?code=abc&state=other", "st")).toMatchObject({ kind: "mismatch", status: 400, message: expect.stringMatching(/state mismatch/) });
    expect(parseLoopbackCallback("/callback?error=access_denied&state=other", "st")).toMatchObject({ kind: "mismatch" }); // a stray error does not cancel the real sign-in
    expect(parseLoopbackCallback("/callback?error=access_denied&error_description=nope&state=st", "st")).toEqual({ kind: "error", status: 400, message: "access_denied: nope" });
    expect(parseLoopbackCallback("/callback?state=st", "st")).toMatchObject({ kind: "error", status: 400 });
    expect(parseLoopbackCallback("/favicon.ico", "st")).toMatchObject({ kind: "ignore", status: 404 });
  });
  it("binds an ephemeral port, hands the code to the waiter, and answers the browser", async () => {
    const lb = await startLoopback({ port: 0 });
    try {
      expect(lb.port).toBeGreaterThan(0);
      expect(lb.redirectUrl).toBe(`http://127.0.0.1:${lb.port}/callback`);
      // Nothing pending yet: the listener says so rather than swallowing a code.
      expect((await fetch(`${lb.redirectUrl}?code=x&state=y`)).status).toBe(409);
      expect((await fetch(`http://127.0.0.1:${lb.port}/nope`)).status).toBe(404);
      const waiting = lb.waitForCallback("st");
      const res = await fetch(`${lb.redirectUrl}?code=the-code&state=st`);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/Signed in/);
      await expect(waiting).resolves.toEqual({ code: "the-code" });
      // A wrong state is answered but does not consume the pending sign-in; a declined consent does.
      const second = lb.waitForCallback("st2");
      const stray = await fetch(`${lb.redirectUrl}?code=c&state=wrong`);
      expect(stray.status).toBe(400);
      expect(await stray.text()).toMatch(/still waiting/);
      const failing = expect(second).rejects.toThrow(/access_denied/);
      const declined = await fetch(`${lb.redirectUrl}?error=access_denied&state=st2`);
      expect(declined.status).toBe(400);
      await failing;
    } finally {
      await lb.close();
    }
  });
});

describe("FileOAuthProvider", () => {
  it("is a public client with loopback redirect URIs and persists everything to the file", async () => {
    const file = join(dir, "p.json");
    const logs: string[] = [];
    const opened: string[] = [];
    const p = new FileOAuthProvider({
      serverUrl: SERVER, file, redirectUrls: loopbackRedirectUrls(4242), log: (m: string) => logs.push(m),
      openBrowser: async (u: string) => { opened.push(u); return true; },
    });
    expect(p.redirectUrl).toBe("http://127.0.0.1:4242/callback");
    expect(p.clientMetadata).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: loopbackRedirectUrls(4242), grant_types: ["authorization_code", "refresh_token"] });
    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    p.saveClientInformation({ client_id: "cid" });
    p.saveCodeVerifier("verifier");
    p.saveDiscoveryState({ authorizationServerUrl: "https://issuer.example/" });
    const state = p.state();
    p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
    const again = new FileOAuthProvider({ serverUrl: SERVER, file, redirectUrls: loopbackRedirectUrls(4242) });
    expect(again.clientInformation()).toEqual({ client_id: "cid" });
    expect(again.codeVerifier()).toBe("verifier");
    expect(again.tokens()?.refresh_token).toBe("r");
    expect(again.discoveryState()).toEqual({ authorizationServerUrl: "https://issuer.example/" });
    expect(readTokenFile(file)).toMatchObject({ serverUrl: SERVER, state, clientInformation: { client_id: "cid" }, codeVerifier: "verifier" });
    expect(typeof readTokenFile(file)?.tokensSavedAt).toBe("number");

    await p.redirectToAuthorization(new URL("https://issuer.example/authorize?state=" + state));
    expect(opened).toEqual([`https://issuer.example/authorize?state=${state}`]);
    expect(p.pending).toEqual({ url: `https://issuer.example/authorize?state=${state}`, state });
    expect(logs.join("\n")).toMatch(/sign-in required/);
    expect(logs.join("\n")).toMatch(/issuer: https:\/\/issuer.example\//);
    expect(logs.join("\n")).not.toMatch(/"a"|verifier/); // never the secrets

    p.invalidateCredentials("tokens");
    expect(again.tokens()).toBeUndefined();
    expect(again.clientInformation()).toEqual({ client_id: "cid" });
    p.invalidateCredentials("all");
    expect(readTokenFile(file)).toEqual({ serverUrl: SERVER });
    expect(() => again.codeVerifier()).toThrow(/code verifier/);
  });
});
