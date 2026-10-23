import { describe, expect, it } from "vitest";
import { devArgs } from "../scripts/dev-args.mjs";
import { OMG, WORKSPACE } from "../scripts/dev-workspace.mjs";

const REMOTE = "https://mcp.example.com/omg";

describe("devArgs", () => {
  it("defaults to the sample workspace served by the monorepo's omg on 8787 and keeps Vite's flags in rest", () => {
    const o = devArgs(["--open", "--host"], {});
    expect(o).toMatchObject({ local: WORKSPACE, omg: OMG, remote: null, port: 8787, path: "/mcp", idleSeconds: 3600, proxyOnly: false, logout: false, rest: ["--open", "--host"] });
    // the local sample is served under the MINIMAL catalog unless told otherwise; a remote serves its own
    expect(o.tools).toBe("minimal");
    expect(devArgs(["--tools", "full"], {}).tools).toBe("full");
    expect(devArgs(["--repo", "notes"], {})).toMatchObject({ repo: "notes", tools: "minimal" });
    expect(devArgs(["--remote", REMOTE], {}).tools).toBeNull();
  });
  it("names a remote instead of the workspace, spells --workspace as the proxy's --local, and strips --proxy-only", () => {
    const r = devArgs(["--remote", REMOTE, "--port", "9000", "--no-browser", "--token-file", "/t.json", "--open"], {});
    expect(r).toMatchObject({ remote: REMOTE, local: null, port: 9000, noBrowser: true, tokenFile: "/t.json", rest: ["--open"] });
    expect(devArgs(["--workspace", "/elsewhere"], {}).local).toBe("/elsewhere");
    expect(devArgs(["--workspace=/elsewhere"], {}).local).toBe("/elsewhere");
    expect(devArgs(["--proxy-only"], {})).toMatchObject({ proxyOnly: true, rest: [] });
    expect(devArgs(["--omg", "/x/omg.js"], {}).omg).toBe("/x/omg.js");
    expect(devArgs(["--logout"], {}).logout).toBe(true);
  });
  it("honours the webdevproxy env and falls back to the older GRAPH_UI_* names", () => {
    expect(devArgs([], { WEBDEVPROXY_REMOTE: ` ${REMOTE} `, WEBDEVPROXY_PORT: "8800" })).toMatchObject({ remote: REMOTE, local: null, port: 8800 });
    expect(devArgs([], { GRAPH_UI_REMOTE: REMOTE, GRAPH_UI_MCP_PORT: "8801", GRAPH_UI_TOKEN_FILE: "/env.json", GRAPH_UI_NO_BROWSER: "1" }))
      .toMatchObject({ remote: REMOTE, port: 8801, tokenFile: "/env.json", noBrowser: true });
    // The current name wins over the legacy one; a flag wins over both.
    expect(devArgs([], { GRAPH_UI_REMOTE: "https://old.example.com/omg", WEBDEVPROXY_REMOTE: REMOTE }).remote).toBe(REMOTE);
    expect(devArgs(["--remote", "https://flag.example.com/omg"], { WEBDEVPROXY_REMOTE: REMOTE }).remote).toBe("https://flag.example.com/omg");
    expect(devArgs([], { WEBDEVPROXY_OMG: "/env/omg" }).omg).toBe("/env/omg");
  });
});
