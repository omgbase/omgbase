import { describe, expect, it } from "vitest";
import { fetchBridgeInfo, whoamiUrl } from "../src/lib/bridge-info.ts";
import { absoluteServerUrl, serverUrlFor } from "../src/lib/mcp-client.ts";

describe("server URLs", () => {
  it("resolves the relative bridge path against the page and leaves absolute URLs alone", () => {
    expect(absoluteServerUrl("/mcp", "http://localhost:5173/")).toBe("http://localhost:5173/mcp");
    expect(absoluteServerUrl("http://localhost:8787/mcp", "http://localhost:5173/")).toBe("http://localhost:8787/mcp");
    expect(serverUrlFor({ mode: "local", bridgeUrl: "/mcp", directUrl: "https://host/omg" }, "http://localhost:5173/")).toBe("http://localhost:5173/mcp");
    expect(serverUrlFor({ mode: "proxy", bridgeUrl: "/mcp", directUrl: "https://host/omg" }, "http://localhost:5173/")).toBe("http://localhost:5173/mcp");
    expect(serverUrlFor({ mode: "direct", bridgeUrl: "/mcp", directUrl: "https://host/omg" }, "http://localhost:5173/")).toBe("https://host/omg");
    expect(() => serverUrlFor({ mode: "direct", bridgeUrl: "/mcp", directUrl: "" }, "http://localhost:5173/")).not.toThrow(); // resolves to the page itself; the app treats it as "enter a URL"
  });
  it("derives /whoami on the bridge's origin", () => {
    expect(whoamiUrl("/mcp", "http://localhost:5173/")).toBe("http://localhost:5173/whoami");
    expect(whoamiUrl("http://localhost:8787/mcp?x=1")).toBe("http://localhost:8787/whoami");
  });
  it("fetches and decodes the bridge's self-description", async () => {
    const info = { mode: "remote", upstream: "https://host/omg", identity: null, auth: { state: "waiting" }, tokenFile: "/t.json", sessions: [] };
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify(info), { status: 200 }); }) as typeof fetch;
    await expect(fetchBridgeInfo("http://localhost:8787/mcp", fetchFn)).resolves.toEqual(info);
    expect(calls).toEqual(["http://localhost:8787/whoami"]);
    const failing = (async () => new Response("nope", { status: 502 })) as typeof fetch;
    await expect(fetchBridgeInfo("http://localhost:8787/mcp", failing)).rejects.toThrow(/HTTP 502/);
  });
});
