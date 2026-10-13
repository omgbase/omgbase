// The terminal keys of remote mode (src/prompt.mjs), driven from a fake stdin
// over the fake gateway: `a` re-opens a waiting sign-in or drops the tokens and
// signs in afresh, `l` forgets the file first, `q` closes and exits 0, the hint
// appears when the sign-in state turns waiting or error.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { PROMPT_HINT, startPrompt } from "../src/prompt.mjs";
import { RemoteAuth, readTokenFile } from "../src/remote-auth.mjs";
import { FakeGateway, type FakeBrowser, until } from "./fixtures/fake-gateway.ts";

let dir: string;
let gw: FakeGateway;
let logs: string[];
let ra: RemoteAuth;
let browser: FakeBrowser;
let input: PassThrough;
let prompt: { close(): void } | null;
const exits: number[] = [];
let closed = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "webdevproxy-prompt-"));
  gw = await FakeGateway.start();
  logs = [];
  exits.length = 0;
  closed = 0;
  browser = gw.browser();
  ra = await new RemoteAuth({ serverUrl: gw.serverUrl, file: join(dir, "t.json"), log: (m) => logs.push(m), openBrowser: browser }).start();
  await ra.ensure();
  expect(ra.status.state).toBe("ok");
  logs.length = 0;
  input = new PassThrough();
  prompt = null;
});
afterEach(async () => {
  prompt?.close();
  await ra.close();
  await gw.close();
  rmSync(dir, { recursive: true, force: true });
});

const attach = () => {
  prompt = startPrompt({ remote: ra, proxy: { close: async () => { closed++; } }, input, log: (m) => logs.push(m), exit: (code) => exits.push(code) });
  return prompt;
};
const settled = () => ra.inflight === null;

describe("startPrompt", () => {
  it("a: drops the tokens (the client registration stays), signs in afresh; the hint is printed while waiting", async () => {
    attach();
    const clientId = readTokenFile(ra.file)!.clientInformation!.client_id;
    input.write("a\n");
    await until(() => gw.hits.exchange === 2 && settled());
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer }); // by hand, not a recovery
    expect(browser.opened).toHaveLength(2);
    expect(gw.hits).toMatchObject({ register: 1, refresh: 1 }); // the one refresh is the pre-browser check that the issuer still knows the registration
    expect(readTokenFile(ra.file)!.clientInformation!.client_id).toBe(clientId);
    expect(logs[0]).toMatch(/^dropping the tokens for /);
    expect(logs.filter((l) => l === PROMPT_HINT)).toHaveLength(1);
    expect(logs.indexOf(PROMPT_HINT)).toBeGreaterThan(logs.findIndex((l) => l.startsWith("sign-in required")));
    expect(logs.join("\n")).not.toMatch(/was rejected/);
  });

  it("a while a sign-in is waiting re-opens the same URL and prints it again, without starting over", async () => {
    attach();
    browser.mode = "hang";
    input.write("a\n");
    await until(() => ra.status.state === "waiting");
    const url = ra.status.authorizationUrl!;
    expect(browser.opened).toHaveLength(2);
    input.write("a\n");
    await until(() => browser.opened.length === 3);
    expect(browser.opened[2]).toBe(url);
    expect(logs).toContain("open this URL in your browser to finish the sign-in:");
    expect(logs).toContain(`  ${url}`);
    expect(ra.status.state).toBe("waiting");
    expect(gw.hits.exchange).toBe(1);
    // The user finishes in the browser: the pending sign-in completes.
    const u = new URL(url);
    await fetch(`${u.searchParams.get("redirect_uri")}?code=${gw.mintCode(u.searchParams.get("client_id")!)}&state=${u.searchParams.get("state")}`);
    await until(() => ra.status.state === "ok" && settled());
    expect(gw.hits.exchange).toBe(2);
  });

  it("l: deletes the token file first, then registers and signs in fresh — also while a sign-in is waiting", async () => {
    attach();
    browser.mode = "hang";
    input.write("a\n");
    await until(() => ra.status.state === "waiting");
    browser.mode = "consent";
    input.write("l\n");
    await until(() => gw.hits.exchange === 2 && settled());
    expect(ra.status).toEqual({ state: "ok", issuer: gw.issuer });
    expect(gw.hits.register).toBe(2);
    expect(readTokenFile(ra.file)!.clientInformation!.client_id).not.toBe("client-1");
    expect(logs.join("\n")).toMatch(/^forgetting the tokens for .* — signing in fresh$/m);
    expect(logs.join("\n")).not.toMatch(/sign-in failed/); // the superseded sign-in is not a failure
  });

  it("a from `error` on a file with tokens but no client registration (the issuer refused the registration once) signs in again", async () => {
    ra.provider!.patch({ clientInformation: undefined });
    gw.expireAccessTokens();
    gw.registerResponse = { status: 403, body: { error: "access_denied" } };
    await ra.ensure().catch(() => undefined);
    expect(ra.status.state).toBe("error");
    expect(ra.status.error).toBe("the issuer refused to register the client (HTTP 403: access_denied)");
    expect(Object.keys(readTokenFile(ra.file)!)).not.toContain("clientInformation");
    gw.registerResponse = null;
    logs.length = 0;
    attach();
    expect(logs).toEqual([PROMPT_HINT]); // the state is error on attach
    input.write("a\n");
    await until(() => ra.status.state === "ok" && settled());
    expect(gw.hits.exchange).toBe(2);
    expect(readTokenFile(ra.file)!.clientInformation).toMatchObject({ client_id: expect.any(String) as unknown as string });
    expect(logs.filter((l) => l === PROMPT_HINT)).toHaveLength(2); // once on attach, once while waiting
  });

  it("q: closes the proxy and exits 0; later keys are ignored", async () => {
    attach();
    input.write("q\n");
    await until(() => exits.length === 1);
    expect(exits).toEqual([0]);
    expect(closed).toBe(1);
    input.write("a\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(browser.opened).toHaveLength(1);
  });

  it("an unknown key repeats the hint; blank lines are ignored; the hint is printed on attach when the state is already error", async () => {
    ra.setStatus({ state: "error", issuer: gw.issuer, error: "boom" });
    attach();
    expect(logs).toEqual([PROMPT_HINT]);
    input.write("\n");
    input.write("x\n");
    await until(() => logs.length === 2);
    expect(logs[1]).toBe(`unknown key "x" — ${PROMPT_HINT}`);
    expect(browser.opened).toHaveLength(1);
  });

  it("close() detaches: no more hints, no more keys", async () => {
    const p = attach();
    p.close();
    prompt = null;
    ra.setStatus({ state: "error", issuer: gw.issuer, error: "boom" });
    input.write("a\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(logs).toEqual([]);
    expect(existsSync(ra.file)).toBe(true);
  });
});
