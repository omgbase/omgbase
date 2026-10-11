import { describe, expect, it } from "vitest";
import { viteProxy } from "../src/vite.mjs";

describe("viteProxy", () => {
  it("proxies /mcp and /whoami to the loopback proxy on 8787 by default", () => {
    expect(viteProxy({ env: {} })).toEqual({
      "/mcp": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/whoami": { target: "http://127.0.0.1:8787", changeOrigin: false },
    });
  });
  it("takes the port and path from options, else from the env the dev script exports", () => {
    expect(viteProxy({ port: 9000, path: "/omg", env: {} })).toEqual({
      "/omg": { target: "http://127.0.0.1:9000", changeOrigin: false },
      "/whoami": { target: "http://127.0.0.1:9000", changeOrigin: false },
    });
    expect(viteProxy({ env: { WEBDEVPROXY_PORT: "8790", WEBDEVPROXY_PATH: "/m" } })).toEqual({
      "/m": { target: "http://127.0.0.1:8790", changeOrigin: false },
      "/whoami": { target: "http://127.0.0.1:8790", changeOrigin: false },
    });
    expect(viteProxy({ port: "8791", env: { WEBDEVPROXY_PORT: "1" } })["/mcp"]!.target).toBe("http://127.0.0.1:8791");
  });
});
