import { describe, expect, it } from "vitest";
import {
  BrowserOAuthProvider, authorizationServerMetadataUrls, authorizationUrl, callbackParams, codeChallenge, decodeJwtClaims,
  discover, identityFromTokens, parseWwwAuthenticate, protectedResourceMetadataUrls, storageKey, type StorageLike,
} from "../src/lib/oauth.ts";

const SERVER = "https://mcp.example.com/omg";
const ISSUER = "https://example.us.auth0.com/";

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64(JSON.stringify({ alg: "RS256" }))}.${b64(JSON.stringify(claims))}.sig`;
}

describe("parseWwwAuthenticate", () => {
  it("reads scheme, resource_metadata, scope and error (quoted or bare)", () => {
    const h = `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/omg", scope="openid email offline_access", error=invalid_token`;
    expect(parseWwwAuthenticate(h)).toEqual({
      scheme: "Bearer",
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/omg",
      scope: "openid email offline_access",
      error: "invalid_token",
    });
  });
  it("tolerates a missing header and a bare scheme", () => {
    expect(parseWwwAuthenticate(null).scheme).toBeNull();
    expect(parseWwwAuthenticate("Bearer")).toEqual({ scheme: "Bearer", resourceMetadataUrl: null, scope: null, error: null });
  });
});

describe("metadata URLs", () => {
  it("derives the path-aware protected-resource URL first, then the origin's", () => {
    expect(protectedResourceMetadataUrls(SERVER)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/omg",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(protectedResourceMetadataUrls("http://localhost:8787/")).toEqual(["http://localhost:8787/.well-known/oauth-protected-resource"]);
  });
  it("tries RFC 8414 then OpenID discovery for the issuer", () => {
    expect(authorizationServerMetadataUrls(ISSUER)).toEqual([
      "https://example.us.auth0.com/.well-known/oauth-authorization-server",
      "https://example.us.auth0.com/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataUrls("https://idp.example/tenant/a")).toEqual([
      "https://idp.example/.well-known/oauth-authorization-server/tenant/a",
      "https://idp.example/.well-known/openid-configuration/tenant/a",
      "https://idp.example/tenant/a/.well-known/openid-configuration",
    ]);
  });
});

describe("discover", () => {
  const prm = { resource: SERVER, authorization_servers: [ISSUER], scopes_supported: ["openid", "email", "offline_access"] };
  const asMeta = {
    issuer: ISSUER, authorization_endpoint: `${ISSUER}authorize`, token_endpoint: `${ISSUER}oauth/token`,
    registration_endpoint: `${ISSUER}oidc/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
  };
  const fetchMock = (routes: Record<string, unknown>, calls: string[] = []) => async (url: string): Promise<Response> => {
    calls.push(url);
    return url in routes ? new Response(JSON.stringify(routes[url]), { status: 200 }) : new Response("nope", { status: 404 });
  };

  it("follows WWW-Authenticate → protected resource → the issuer's OpenID metadata", async () => {
    const calls: string[] = [];
    const fetch = fetchMock({
      "https://mcp.example.com/.well-known/oauth-protected-resource/omg": prm,
      "https://example.us.auth0.com/.well-known/openid-configuration": asMeta,
    }, calls);
    const d = await discover(SERVER, { fetch, wwwAuthenticate: `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/omg"` });
    expect(d.authorizationServerUrl).toBe(ISSUER);
    expect(d.authorizationServer.registration_endpoint).toBe(`${ISSUER}oidc/register`);
    expect(d.scope).toBe("openid email offline_access");
    expect(d.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource/omg");
    // RFC 8414 was tried before OpenID discovery.
    expect(calls).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/omg",
      "https://example.us.auth0.com/.well-known/oauth-authorization-server",
      "https://example.us.auth0.com/.well-known/openid-configuration",
    ]);
  });

  it("without a header, probes the well-known locations and prefers the header's scope", async () => {
    const fetch = fetchMock({
      "https://mcp.example.com/.well-known/oauth-protected-resource": prm,
      "https://example.us.auth0.com/.well-known/oauth-authorization-server": asMeta,
    });
    const d = await discover(SERVER, { fetch });
    expect(d.resourceMetadataUrl).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(d.scope).toBe("openid email offline_access");
    const d2 = await discover(SERVER, { fetch, wwwAuthenticate: parseWwwAuthenticate('Bearer scope="openid"') });
    expect(d2.scope).toBe("openid");
  });

  it("falls back to the server's own origin as the issuer, and fails loudly when nothing is there", async () => {
    const fetch = fetchMock({ "https://mcp.example.com/.well-known/openid-configuration": asMeta });
    const d = await discover(SERVER, { fetch });
    expect(d.authorizationServerUrl).toBe("https://mcp.example.com");
    expect(d.resource).toBeNull();
    await expect(discover(SERVER, { fetch: fetchMock({}) })).rejects.toThrow(/no authorization server metadata/);
  });
});

describe("PKCE + authorization URL", () => {
  it("computes the RFC 7636 appendix B challenge", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("builds the code request with resource and consent for offline_access", () => {
    const url = authorizationUrl({ authorization_endpoint: `${ISSUER}authorize` }, {
      clientId: "abc", redirectUri: "http://localhost:5173/", codeChallenge: "ch", state: "st",
      scope: "openid email offline_access", resource: SERVER,
    });
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe(`${ISSUER}authorize`);
    expect(Object.fromEntries(q)).toEqual({
      response_type: "code", client_id: "abc", redirect_uri: "http://localhost:5173/", code_challenge: "ch",
      code_challenge_method: "S256", state: "st", scope: "openid email offline_access", resource: SERVER, prompt: "consent",
    });
    expect(authorizationUrl({ authorization_endpoint: `${ISSUER}authorize` }, { clientId: "a", redirectUri: "r", codeChallenge: "c", state: "s" }).searchParams.has("prompt")).toBe(false);
  });
  it("reads the callback", () => {
    expect(callbackParams("http://localhost:5173/?code=xyz&state=st")).toEqual({ code: "xyz", state: "st", error: null, errorDescription: null });
    expect(callbackParams("http://localhost:5173/?error=access_denied&error_description=nope").error).toBe("access_denied");
  });
});

describe("identity", () => {
  it("decodes claims and prefers the id_token", () => {
    expect(decodeJwtClaims(jwt({ sub: "auth0|1", email: "b@example.com" }))).toEqual({ sub: "auth0|1", email: "b@example.com" });
    expect(decodeJwtClaims("not.a.jwt.really")).toBeNull();
    expect(identityFromTokens({ access_token: jwt({ sub: "x" }), token_type: "Bearer", id_token: jwt({ sub: "auth0|1", email: "b@example.com", name: "Brendan" }) }))
      .toEqual({ email: "b@example.com", name: "Brendan", subject: "auth0|1" });
    expect(identityFromTokens({ access_token: "opaque", token_type: "Bearer" })).toBeNull();
  });
});

describe("BrowserOAuthProvider", () => {
  it("persists client info, tokens, verifier, state and discovery per server URL", () => {
    const storage = memoryStorage();
    const navigated: string[] = [];
    let before = 0;
    const p = new BrowserOAuthProvider(SERVER, { redirectUrl: "http://localhost:5173/", storage, navigate: (u) => navigated.push(u.href), onBeforeRedirect: () => before++ });
    expect(p.key).toBe(storageKey(SERVER));
    expect(storageKey(`${SERVER}/`)).toBe(p.key);
    expect(p.clientInformation()).toBeUndefined();
    expect(p.clientMetadata).toMatchObject({ redirect_uris: ["http://localhost:5173/"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    p.saveClientInformation({ client_id: "cid" });
    p.saveCodeVerifier("v");
    p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r", id_token: jwt({ email: "b@example.com" }) });
    p.saveDiscoveryState({ authorizationServerUrl: ISSUER });
    const s = p.state();
    const again = new BrowserOAuthProvider(SERVER, { redirectUrl: "http://localhost:5173/", storage });
    expect(again.clientInformation()).toEqual({ client_id: "cid" });
    expect(again.codeVerifier()).toBe("v");
    expect(again.tokens()?.refresh_token).toBe("r");
    expect(again.discoveryState()).toEqual({ authorizationServerUrl: ISSUER });
    expect(again.identity()?.email).toBe("b@example.com");
    expect(again.consumeState()).toBe(s);
    expect(again.consumeState()).toBeUndefined();
    p.redirectToAuthorization(new URL(`${ISSUER}authorize?x=1`));
    expect(navigated).toEqual([`${ISSUER}authorize?x=1`]);
    expect(before).toBe(1);
    p.invalidateCredentials("tokens");
    expect(again.tokens()).toBeUndefined();
    expect(again.clientInformation()).toEqual({ client_id: "cid" });
    p.clear();
    expect(storage.map.size).toBe(0);
    expect(() => again.codeVerifier()).toThrow(/code verifier/);
  });
});
