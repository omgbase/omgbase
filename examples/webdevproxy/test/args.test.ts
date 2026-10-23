import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, MONOREPO_OMG, defaultOmg, omgCommand, parseArgs, validateArgs, USAGE } from "../src/args.mjs";

const REMOTE = "https://mcp.example.com/omg";

describe("parseArgs", () => {
  it("defaults: 8787, /mcp, 3600 s idle, nothing to proxy, foreign flags kept in rest", () => {
    const o = parseArgs(["--open", "--host"], {});
    expect(o).toMatchObject({ local: null, remote: null, clientId: null, port: DEFAULT_PORT, path: "/mcp", idleSeconds: 3600, origins: [], tokenFile: null, noBrowser: false, logout: false, help: false, rest: ["--open", "--host"] });
    expect(validateArgs(o)).toMatch(/nothing to proxy/);
  });

  it("consumes its own flags (both `--k v` and `--k=v`) and leaves Vite's", () => {
    const o = parseArgs(["--remote", REMOTE, "--port=9000", "--no-browser", "--token-file", "/t.json", "--origin", "http://app.local:3000", "--origin=http://other:*", "--open", "--idle", "30", "--client-id", "app-1"], {});
    expect(o).toMatchObject({ remote: REMOTE, port: 9000, noBrowser: true, tokenFile: "/t.json", idleSeconds: 30, origins: ["http://app.local:3000", "http://other:*"], clientId: "app-1", rest: ["--open"] });
    expect(parseArgs(["--client-id=app-2"], {}).clientId).toBe("app-2");
    expect(validateArgs(o)).toBeNull();
  });

  it("resolves --local to an absolute path and reads the env fallbacks", () => {
    const o = parseArgs(["--local", "ws"], { WEBDEVPROXY_OMG: "/x/omg" });
    expect(o.local).toMatch(/\/ws$/);
    expect(o.local!.startsWith("/")).toBe(true);
    expect(o.omg).toBe("/x/omg");
    const e = parseArgs([], { WEBDEVPROXY_REMOTE: ` ${REMOTE} `, WEBDEVPROXY_PORT: "8800", WEBDEVPROXY_PATH: "/x", WEBDEVPROXY_TOKEN_FILE: "/env.json", WEBDEVPROXY_NO_BROWSER: "1", WEBDEVPROXY_ORIGIN: "http://a:1, http://b:*" });
    expect(e).toMatchObject({ remote: REMOTE, port: 8800, path: "/x", tokenFile: "/env.json", noBrowser: true, origins: ["http://a:1", "http://b:*"] });
    expect(parseArgs(["--remote", "https://flag.example.com/omg"], { WEBDEVPROXY_REMOTE: REMOTE }).remote).toBe("https://flag.example.com/omg");
    // --client-id: the flag over WEBDEVPROXY_CLIENT_ID over nothing (= dynamic registration).
    expect(parseArgs([], { WEBDEVPROXY_CLIENT_ID: " env-app " }).clientId).toBe("env-app");
    expect(parseArgs(["--client-id", "flag-app"], { WEBDEVPROXY_CLIENT_ID: "env-app" }).clientId).toBe("flag-app");
    expect(parseArgs([], { WEBDEVPROXY_CLIENT_ID: "  " }).clientId).toBeNull();
    expect(parseArgs(["--callback-port", "9123"], { WEBDEVPROXY_CALLBACK_PORT: "9124" }).callbackPort).toBe(9123);
    expect(parseArgs([], { WEBDEVPROXY_CALLBACK_PORT: "9124" }).callbackPort).toBe(9124);
    expect(parseArgs([], {}).callbackPort).toBeNull();
    expect(parseArgs(["--logout"], {}).logout).toBe(true);
    expect(parseArgs(["--help"], {}).help).toBe(true);
  });

  it("--repo and --tools: the repository and the catalog profile of the local `omg mcp`, reported on /whoami", () => {
    const o = parseArgs(["--local", "ws", "--repo", "notes", "--tools", "minimal"], {});
    expect(o).toMatchObject({ repo: "notes", tools: "minimal" });
    expect(validateArgs(o)).toBeNull();
    expect(parseArgs([], { WEBDEVPROXY_REPO: " env-repo ", WEBDEVPROXY_TOOLS: "full" })).toMatchObject({ repo: "env-repo", tools: "full" });
    expect(parseArgs(["--local", "ws"], {})).toMatchObject({ repo: null, tools: null });
    expect(validateArgs(parseArgs(["--local", "ws", "--tools", "tiny"], {}))).toMatch(/--tools must be one of full\|minimal/);
    // a remote serves its own profile; the repo still travels to the page
    expect(validateArgs(parseArgs(["--remote", REMOTE, "--tools", "minimal"], {}))).toMatch(/--tools applies to the local/);
    expect(validateArgs(parseArgs(["--remote", REMOTE, "--repo", "notes"], {}))).toBeNull();
  });
});

describe("validateArgs", () => {
  it("refuses both modes at once, a non-URL remote, a bad port or path", () => {
    expect(validateArgs(parseArgs(["--local", "a", "--remote", REMOTE], {}))).toMatch(/exclusive/);
    expect(validateArgs(parseArgs(["--remote", "not a url"], {}))).toMatch(/http\(s\) URL/);
    expect(validateArgs(parseArgs(["--remote", "ftp://x/omg"], {}))).toMatch(/http\(s\) URL/);
    expect(validateArgs(parseArgs(["--local", "a", "--port", "70000"], {}))).toMatch(/--port/);
    expect(validateArgs(parseArgs(["--local", "a", "--port", "abc"], {}))).toMatch(/--port/);
    expect(validateArgs(parseArgs(["--local", "a", "--path", "mcp"], {}))).toMatch(/--path/);
    expect(validateArgs(parseArgs(["--local", "a", "--idle", "-1"], {}))).toMatch(/--idle/);
    expect(validateArgs(parseArgs(["--local", "a", "--callback-port", "0"], {}))).toMatch(/--callback-port/);
    expect(validateArgs(parseArgs(["--local", "a", "--callback-port", "70000"], {}))).toMatch(/--callback-port/);
    expect(validateArgs(parseArgs(["--local", "a", "--port", "0"], {}))).toBeNull(); // 0 = ephemeral, for tests
    // --logout and --help need no mode.
    expect(validateArgs(parseArgs(["--logout"], {}))).toBeNull();
    expect(validateArgs(parseArgs(["--help"], {}))).toBeNull();
  });
});

describe("omg", () => {
  it("runs a .js entry with node and anything else as a binary", () => {
    expect(omgCommand("/repo/packages/cli/dist/src/main.js")).toEqual({ command: process.execPath, args: ["/repo/packages/cli/dist/src/main.js"] });
    expect(omgCommand("/usr/local/bin/omgbase")).toEqual({ command: "/usr/local/bin/omgbase", args: [] });
    expect(omgCommand("omg")).toEqual({ command: "omg", args: [] });
  });
  it("defaults to the env, else the monorepo build when present, else `omg` on PATH", () => {
    expect(defaultOmg({ WEBDEVPROXY_OMG: "/x" }, () => true)).toBe("/x");
    expect(defaultOmg({}, () => true)).toBe(MONOREPO_OMG);
    expect(MONOREPO_OMG).toMatch(/packages\/cli\/dist\/src\/main\.js$/);
    expect(defaultOmg({}, () => false)).toBe("omg");
  });
});

describe("USAGE", () => {
  it("warns that the proxy is dev-only and loopback-bound", () => {
    expect(USAGE).toMatch(/dev-only; do not expose beyond localhost/);
    expect(USAGE).toMatch(/127\.0\.0\.1/);
    expect(USAGE).not.toMatch(/0\.0\.0\.0/);
    expect(USAGE).toMatch(/--client-id <id>/);
    expect(USAGE).toMatch(/WEBDEVPROXY_CLIENT_ID/);
    expect(USAGE).toMatch(/--callback-port <n>/);
    expect(USAGE).toMatch(/WEBDEVPROXY_CALLBACK_PORT/);
    expect(USAGE).toMatch(/http:\/\/127\.0\.0\.1:<callback\s+port>\/callback/);
    expect(USAGE).not.toMatch(/\*\/callback/); // Auth0 rejects a port wildcard; never suggest one
  });
});
