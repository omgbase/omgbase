import { describe, expect, it } from "vitest";
import { parseBridgeArgs } from "../scripts/dev-mcp.mjs";

describe("parseBridgeArgs", () => {
  it("defaults to the local sample on 8787 and keeps Vite's flags in rest", () => {
    const o = parseBridgeArgs(["--open", "--host"], {});
    expect(o).toMatchObject({ port: 8787, path: "/mcp", idleSeconds: 600, remote: null, logout: false, noBrowser: false, tokenFile: null, rest: ["--open", "--host"] });
  });
  it("consumes the bridge's flags (including --port) and honours the env fallbacks", () => {
    const o = parseBridgeArgs(["--remote", "https://host/omg", "--port", "9000", "--no-browser", "--token-file", "/t.json", "--open"], {});
    expect(o).toMatchObject({ remote: "https://host/omg", port: 9000, noBrowser: true, tokenFile: "/t.json", rest: ["--open"] });
    const e = parseBridgeArgs([], { GRAPH_UI_REMOTE: " https://env/omg ", GRAPH_UI_MCP_PORT: "8800", GRAPH_UI_TOKEN_FILE: "/env.json", GRAPH_UI_NO_BROWSER: "1" });
    expect(e).toMatchObject({ remote: "https://env/omg", port: 8800, tokenFile: "/env.json", noBrowser: true });
    expect(parseBridgeArgs(["--remote", "https://flag/omg"], { GRAPH_UI_REMOTE: "https://env/omg" }).remote).toBe("https://flag/omg");
    expect(parseBridgeArgs(["--logout"], {}).logout).toBe(true);
  });
});
