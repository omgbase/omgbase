import { describe, expect, it } from "vitest";
import { OMG_MINIMAL, REPO_EXPLORER_PORT, devArgs } from "../scripts/dev-args.mjs";
import { OMG, WORKSPACE } from "../scripts/dev-workspace.mjs";
import { minimalArgv } from "../scripts/omg-minimal.mjs";

const REMOTE = "https://mcp.example.com/omg";

describe("devArgs", () => {
  it("defaults to the alchemy workspace served MINIMAL (the omg stand-in), port 8789, Vite's flags in rest", () => {
    expect(REPO_EXPLORER_PORT).toBe(8789);
    expect(devArgs(["--open"], {})).toMatchObject({ local: WORKSPACE, omg: OMG_MINIMAL, remote: null, port: 8789, path: "/mcp", proxyOnly: false, profile: "minimal", rest: ["--open"] });
  });
  it("--full serves the whole catalog with the monorepo's omg; --omg or WEBDEVPROXY_OMG wins over both", () => {
    expect(devArgs(["--full"], {})).toMatchObject({ omg: OMG, profile: "full", rest: [] });
    expect(devArgs(["--omg", "/x/omg.js"], {}).omg).toBe("/x/omg.js");
    expect(devArgs([], { WEBDEVPROXY_OMG: "/env/omg" }).omg).toBe("/env/omg");
  });
  it("takes a remote instead of the workspace, an explicit port, and strips --proxy-only", () => {
    expect(devArgs(["--remote", REMOTE, "--port", "9100", "--proxy-only"], {})).toMatchObject({ remote: REMOTE, local: null, port: 9100, proxyOnly: true, rest: [] });
    expect(devArgs([], { WEBDEVPROXY_PORT: "9101" }).port).toBe(9101);
    expect(devArgs(["--local", "/elsewhere"], {}).local).toBe("/elsewhere");
  });
});

describe("the minimal stand-in", () => {
  it("appends --tools minimal to an mcp call that names no profile, and nothing else", () => {
    expect(minimalArgv(["mcp", "-C", "/ws"])).toEqual(["mcp", "-C", "/ws", "--tools", "minimal"]);
    expect(minimalArgv(["mcp", "-C", "/ws", "--tools", "full"])).toEqual(["mcp", "-C", "/ws", "--tools", "full"]);
    expect(minimalArgv(["mcp", "--tools=full"])).toEqual(["mcp", "--tools=full"]);
    expect(minimalArgv(["version"])).toEqual(["version"]);
  });
});
