import { describe, expect, it } from "vitest";
import { LIVE_TAIL_PORT, devArgs } from "../scripts/dev-args.mjs";
import { OMG, WORKSPACE } from "../scripts/dev-workspace.mjs";

const REMOTE = "https://mcp.example.com/omg";

describe("devArgs", () => {
  it("defaults to the sample workspace, the monorepo's omg and port 8788, keeping Vite's flags in rest", () => {
    expect(LIVE_TAIL_PORT).toBe(8788);
    expect(devArgs(["--open"], {})).toMatchObject({ local: WORKSPACE, omg: OMG, remote: null, port: 8788, path: "/mcp", proxyOnly: false, rest: ["--open"] });
  });
  it("takes a remote instead of the workspace, an explicit port, and strips --proxy-only", () => {
    expect(devArgs(["--remote", REMOTE, "--port", "9100", "--proxy-only"], {})).toMatchObject({ remote: REMOTE, local: null, port: 9100, proxyOnly: true, rest: [] });
    expect(devArgs([], { WEBDEVPROXY_PORT: "9101" }).port).toBe(9101);
    expect(devArgs(["--local", "/elsewhere"], {}).local).toBe("/elsewhere");
    expect(devArgs(["--omg", "/x/omg.js"], {}).omg).toBe("/x/omg.js");
    expect(devArgs([], { WEBDEVPROXY_OMG: "/env/omg" }).omg).toBe("/env/omg");
  });
});
