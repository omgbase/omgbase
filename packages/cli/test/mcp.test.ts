import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync, spawnSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `omg mcp` over stdio (11 §5.8; CLI-B gate: mcp drives the tool surface over
// stdio). Spawns the built binary, speaks JSON-RPC over stdin/stdout, and
// asserts the handshake, tool listing, tool calls, clean-stdout invariant, and
// graceful shutdown on stdin EOF.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

// Minimal line-delimited JSON-RPC client over a child's stdio.
class RpcClient {
  private buf = "";
  private id = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  nonJsonStdout: string[] = [];

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.nonJsonStdout.push(line);
          continue;
        }
        const rid = msg.id as number | undefined;
        if (rid != null && this.pending.has(rid)) {
          this.pending.get(rid)!(msg);
          this.pending.delete(rid);
        }
      }
    });
  }

  send(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.id++;
    const p = new Promise<Record<string, unknown>>((res) => this.pending.set(id, res));
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }
  notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-mcp-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    join(vault, "hub.md"),
    ["# Hub", "", "Intro.", "", "## Tasks", "", "- [ ] a task", "- [x] done task", ""].join("\n"),
  );
  execFileSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  execFileSync("node", [BIN, "-C", vault, "source", "add", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("omg mcp (stdio)", () => {
  it("handshakes, lists tools, answers calls, keeps stdout clean, and exits on EOF", async () => {
    const child = spawn("node", [BIN, "-C", vault, "mcp", "--no-watch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    }) as ChildProcessWithoutNullStreams;
    const rpc = new RpcClient(child);

    const init = await rpc.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    const serverInfo = (init.result as { serverInfo?: { name?: string } })?.serverInfo;
    expect(serverInfo?.name).toBe("omgbase");
    rpc.notify("notifications/initialized", {});

    const tools = await rpc.send("tools/list", {});
    const names = ((tools.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
    expect(names).toContain("docs_outline");
    expect(names).toContain("query");

    const outline = await rpc.send("tools/call", { name: "docs_outline", arguments: { _path: "hub.md" } });
    const oc = (outline.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
    expect(oc.isError).toBeFalsy();
    expect(oc.content?.[0]?.text ?? "").toContain("Hub");

    // 5.0 "underscore = engine" (spec/surface §4 "Arguments"): a bare `path` names no
    // argument — no tolerance; the error carries the same call respelled as `fix`.
    const bare = await rpc.send("tools/call", { name: "docs_outline", arguments: { path: "hub.md" } });
    const bc = (bare.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
    expect(bc.isError).toBe(true);
    const be = JSON.parse(bc.content?.[0]?.text ?? "{}") as { error?: string; message?: string; data?: { hint?: string; fix?: string } };
    expect(be.error).toBe("filter_invalid");
    expect(be.message).toContain("`path` is not an argument — the engine field is `_path` (the bare namespace is the user's); pass `_path`");
    expect(be.data?.hint).toBe("arguments");
    expect(be.data?.fix).toBe(JSON.stringify({ _path: "hub.md" }));

    const q = await rpc.send("tools/call", { name: "query", arguments: { query: 'from blocks where _type == "task"' } });
    const qc = (q.result as { content?: { text?: string }[] }) ?? {};
    const body = JSON.parse(qc.content?.[0]?.text ?? "{}") as { hits?: unknown[] };
    expect(body.hits).toHaveLength(2);

    // stdout carried only protocol JSON — no stray human output.
    expect(rpc.nonJsonStdout).toEqual([]);

    // stdin EOF → graceful shutdown.
    const exitCode = await new Promise<number>((res) => {
      child.on("exit", (code) => res(code ?? -1));
      child.stdin.end();
      setTimeout(() => {
        child.kill("SIGKILL");
        res(-99);
      }, 4000);
    });
    expect(exitCode).toBe(0);
  }, 15000);
});

describe("omg mcp — multi-repo (per-call `repo` slug, ADR-014)", () => {
  let mdir: string;
  let ws: string;
  beforeAll(() => {
    mdir = mkdtempSync(join(tmpdir(), "omg-mcp-multi-"));
    ws = join(mdir, "ws");
    mkdirSync(join(ws, "alpha"), { recursive: true });
    mkdirSync(join(ws, "beta"), { recursive: true });
    writeFileSync(join(ws, "alpha", "a.md"), "# AlphaDoc\n");
    writeFileSync(join(ws, "beta", "b.md"), "# BetaDoc\n");
    const env = { ...process.env, NO_COLOR: "1" };
    execFileSync("node", [BIN, "init", ws, "--yes", "--no-embedder"], { encoding: "utf8", env });
    execFileSync("node", [BIN, "-C", join(ws, "alpha"), "source", "add", ".", "--repo", "alpha", "-y"], { encoding: "utf8", env });
    execFileSync("node", [BIN, "-C", join(ws, "beta"), "source", "add", ".", "--repo", "beta", "-y"], { encoding: "utf8", env });
  });
  afterAll(() => rmSync(mdir, { recursive: true, force: true }));

  it("defaults to the bound repo, targets others by slug, lists repos, errors on unknown", async () => {
    // Bind alpha as the default (cwd under alpha's root).
    const child = spawn("node", [BIN, "-C", join(ws, "alpha"), "mcp", "--no-watch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    }) as ChildProcessWithoutNullStreams;
    const rpc = new RpcClient(child);
    await rpc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    rpc.notify("notifications/initialized", {});

    const paths = async (args: Record<string, unknown>): Promise<string[]> => {
      const res = await rpc.send("tools/call", { name: "query", arguments: { query: "from docs", ...args } });
      const c = (res.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
      if (c.isError) return ["<error>"];
      return ((JSON.parse(c.content?.[0]?.text ?? "{}") as { hits?: { _path?: string }[] }).hits ?? []).map((h) => h._path ?? "");
    };

    // No repo → the bound default (alpha).
    expect(await paths({})).toEqual(["/a.md"]);
    // repo: "beta" → the other repo in the same workspace DB.
    expect(await paths({ repo: "beta" })).toEqual(["/b.md"]);
    // repo: "alpha" explicitly → alpha.
    expect(await paths({ repo: "alpha" })).toEqual(["/a.md"]);

    // `repos` lists both.
    const reposRes = await rpc.send("tools/call", { name: "repos", arguments: {} });
    const reposBody = JSON.parse(((reposRes.result as { content?: { text?: string }[] }).content?.[0]?.text) ?? "{}") as { repos?: { slug: string; hasSource: boolean }[] };
    expect((reposBody.repos ?? []).map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
    expect((reposBody.repos ?? []).every((r) => r.hasSource)).toBe(true);

    // Unknown slug → a loud repo_not_found (isError), not a silent empty.
    const bad = await rpc.send("tools/call", { name: "query", arguments: { query: "from docs", repo: "nope" } });
    expect((bad.result as { isError?: boolean }).isError).toBe(true);

    await new Promise<number>((res) => {
      child.on("exit", (code) => res(code ?? -1));
      child.stdin.end();
      setTimeout(() => { child.kill("SIGKILL"); res(-99); }, 4000);
    });
  }, 15000);
});

describe("omg mcp — configured-but-broken embedder (degrade loudly)", () => {
  let bdir: string;
  let bvault: string;
  beforeAll(() => {
    bdir = mkdtempSync(join(tmpdir(), "omg-mcp-badembed-"));
    bvault = join(bdir, "vault");
    mkdirSync(bvault, { recursive: true });
    writeFileSync(join(bvault, "doc.md"), "# Doc\n\nHello world.\n");
    const env = { ...process.env, NO_COLOR: "1" };
    execFileSync("node", [BIN, "init", bvault, "--yes", "--no-embedder"], { encoding: "utf8", env });
    execFileSync("node", [BIN, "-C", bvault, "source", "add", ".", "-y"], { encoding: "utf8", env });
    // Point the embedder at a command that cannot spawn — the "nonfunctional
    // embedder" case. It is configured (so NOT provider_unavailable) but broken.
    execFileSync("node", [BIN, "-C", bvault, "config", "set", "embedding.provider", "omg-no-such-embedder-xyz"], { encoding: "utf8", env });
  });
  afterAll(() => rmSync(bdir, { recursive: true, force: true }));

  it("starts serving, warns loudly on stderr, and fails semantic access with capability_unavailable { state: unavailable }", async () => {
    const child = spawn("node", [BIN, "-C", bvault, "mcp", "--no-watch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    }) as ChildProcessWithoutNullStreams;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const rpc = new RpcClient(child);

    // Server still comes up despite the broken embedder (degraded, not dead).
    const init = await rpc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe("omgbase");
    rpc.notify("notifications/initialized", {});

    // A non-semantic query works fine — the embedder is irrelevant to it.
    const plain = await rpc.send("tools/call", { name: "query", arguments: { query: "from docs" } });
    expect((plain.result as { isError?: boolean }).isError).toBeFalsy();

    // A semantic query fails LOUDLY and SPECIFICALLY (modular-core Phase 2):
    // `capability_unavailable { capability: semantic, state: unavailable }`,
    // retriable, naming the provider — not the misleading provider_unavailable
    // (which means "no provider configured").
    const sem = await rpc.send("tools/call", { name: "query", arguments: { query: 'from docs where semantic("hello") > 0.1' } });
    const sc = (sem.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
    expect(sc.isError).toBe(true);
    const body = JSON.parse(sc.content?.[0]?.text ?? "{}") as { error?: string; message?: string; retriable?: boolean; data?: { capability?: string; state?: string; provider?: string } };
    expect(body.error).toBe("capability_unavailable");
    expect(body.retriable).toBe(true);
    expect(body.data).toMatchObject({ capability: "semantic", state: "unavailable", provider: "omg-no-such-embedder-xyz" });
    expect(body.message ?? "").toContain("omg-no-such-embedder-xyz");
    // `version` reports the state.
    const ver = await rpc.send("tools/call", { name: "version", arguments: {} });
    const vbody = JSON.parse(((ver.result as { content?: { text?: string }[] }).content?.[0]?.text) ?? "{}") as { capabilities?: { semantic?: { state?: string } } };
    expect(vbody.capabilities?.semantic?.state).toBe("unavailable");

    // Startup complained loudly on stderr (never on stdout — protocol channel).
    expect(stderr).toContain("EMBEDDER NONFUNCTIONAL");
    expect(stderr).toContain("omg-no-such-embedder-xyz");
    expect(rpc.nonJsonStdout).toEqual([]);

    await new Promise<number>((res) => {
      child.on("exit", (code) => res(code ?? -1));
      child.stdin.end();
      setTimeout(() => { child.kill("SIGKILL"); res(-99); }, 4000);
    });
  }, 15000);
});

// The workspace writer lock at the tool boundary (spec/sync §7; the Rust
// `omgbase mcp` does the same): a write tool holds `.omgbase/writer.lock` for
// its call and releases it; a lock a live foreign holder keeps fails the write
// with the engine's catch-all envelope after the wait — shortened here by the
// `OMGBASE_WRITER_LOCK_TIMEOUT_MS` seam both binaries read, so the test does
// not sit out the spec's 5 s.
describe("omg mcp — the workspace writer lock (spec/sync §7)", () => {
  it("a write tool takes and releases writer.lock; a held lock fails it as repo_not_found within the seam's wait; reads are unaffected", async () => {
    const lockFile = join(vault, ".omgbase", "writer.lock");
    const child = spawn("node", [BIN, "-C", vault, "mcp", "--no-watch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", OMGBASE_WRITER_LOCK_TIMEOUT_MS: "150" },
    }) as ChildProcessWithoutNullStreams;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const rpc = new RpcClient(child);
    await rpc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    rpc.notify("notifications/initialized", {});
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc.send("tools/call", { name, arguments: args });
      const rc = (r.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
      return { isError: rc.isError ?? false, body: JSON.parse(rc.content?.[0]?.text ?? "{}") as Record<string, unknown> };
    };

    // A write succeeds and leaves no lock behind.
    const created = await call("docs_create", { path: "locked/a.md", markdown: "# A\n" });
    expect(created.isError).toBe(false);
    expect((created.body.revisions as { _path: string }[])[0]!._path).toBe("/locked/a.md"); // the Receipt (4.0)
    expect(existsSync(lockFile)).toBe(false);

    // A live foreign holder: this vitest process's pid is alive, so the child
    // can neither steal nor re-enter the record.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const t0 = Date.now();
    const blocked = await call("docs_create", { path: "locked/b.md", markdown: "# B\n" });
    const waited = Date.now() - t0;
    expect(blocked.isError).toBe(true);
    expect(blocked.body.error).toBe("repo_not_found");
    expect(blocked.body.message).toMatch(/could not acquire writer lock .*writer\.lock \(held by pid \d+\)/);
    expect(waited).toBeLessThan(3000); // the seam, not the spec's 5 s
    expect(existsSync(join(vault, "locked", "b.md"))).toBe(false);
    // A plan waits too (`plan` is a write tool for the lock's purposes; Rust `is_write_tool` counts it).
    const dry = await call("plan", { effects: [{ op: "create", path: "locked/b.md", markdown: "# B\n" }] });
    expect(dry.isError).toBe(true);
    expect(dry.body.error).toBe("repo_not_found");
    // Reads never touch the lock.
    const read = await call("docs_read", { _path: "locked/a.md" });
    expect(read.isError).toBe(false);
    // The holder's record is intact (never stolen); once it is gone the write lands.
    expect(JSON.parse(readFileSyncUtf8(lockFile)).pid).toBe(process.pid);
    unlinkSync(lockFile);
    const after = await call("docs_create", { path: "locked/b.md", markdown: "# B\n" });
    expect(after.isError).toBe(false);
    expect(existsSync(lockFile)).toBe(false);

    expect(rpc.nonJsonStdout).toEqual([]);
    const exitCode = await new Promise<number>((res) => {
      child.on("exit", (code) => res(code ?? -1));
      child.stdin.end();
      setTimeout(() => { child.kill("SIGKILL"); res(-99); }, 4000);
    });
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/test seam: writer lock waits 150 ms \(OMGBASE_WRITER_LOCK_TIMEOUT_MS\)/);
  }, 20000);

  it("an invalid OMGBASE_WRITER_LOCK_TIMEOUT_MS is a usage error (exit 2), as on the Rust binary", () => {
    const res = spawnSync("node", [BIN, "-C", vault, "ls"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", OMGBASE_WRITER_LOCK_TIMEOUT_MS: "soon" } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/OMGBASE_WRITER_LOCK_TIMEOUT_MS="soon": not a number of milliseconds/);
    // Empty is unset.
    const ok = spawnSync("node", [BIN, "-C", vault, "ls"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", OMGBASE_WRITER_LOCK_TIMEOUT_MS: "" } });
    expect(ok.status).toBe(0);
  });
});

function readFileSyncUtf8(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:fs") as typeof import("node:fs")).readFileSync(path, "utf8");
}

describe("omg mcp --tools (spec/surface §4 \"Profiles\", spec/cli `mcp` 4.2)", () => {
  it("--tools minimal lists the ten tools, refuses a hidden one with `unknown tool <name>` (-32602), and version says minimal", async () => {
    const child = spawn("node", [BIN, "-C", vault, "mcp", "--no-watch", "--tools", "minimal"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    }) as ChildProcessWithoutNullStreams;
    const rpc = new RpcClient(child);
    await rpc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    rpc.notify("notifications/initialized", {});
    const tools = await rpc.send("tools/list", {});
    const names = ((tools.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["docs_read", "docs_tree", "query_syntax", "query", "blocks_resolve", "apply", "plan", "execute", "changes_since", "version"]);
    const hidden = await rpc.send("tools/call", { name: "blocks_insert", arguments: { to: "hub.md", markdown: "x" } });
    expect(hidden.error).toEqual({ code: -32602, message: "unknown tool blocks_insert" });
    const v = await rpc.send("tools/call", { name: "version", arguments: {} });
    const body = JSON.parse(((v.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "{}") as { profile?: string };
    expect(body.profile).toBe("minimal");
    expect(rpc.nonJsonStdout).toEqual([]);
    const exitCode = await new Promise<number>((res) => {
      child.on("exit", (code) => res(code ?? -1));
      child.stdin.end();
      setTimeout(() => { child.kill("SIGKILL"); res(-99); }, 4000);
    });
    expect(exitCode).toBe(0);
  }, 15000);

  it("--tools with an unknown profile is the usage error, exit 2", () => {
    const r = spawnSync("node", [BIN, "-C", vault, "mcp", "--no-watch", "--tools", "lite"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: --tools must be one of full|minimal (got "lite")');
    expect(r.stdout).toBe("");
  });

  it("the mcp.tools workspace setting selects the profile; the flag wins over it", async () => {
    execFileSync("node", [BIN, "-C", vault, "config", "set", "mcp.tools", "minimal"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    try {
      const count = async (extra: string[]): Promise<number> => {
        const child = spawn("node", [BIN, "-C", vault, "mcp", "--no-watch", ...extra], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } }) as ChildProcessWithoutNullStreams;
        const rpc = new RpcClient(child);
        await rpc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
        rpc.notify("notifications/initialized", {});
        const tools = await rpc.send("tools/list", {});
        const n = ((tools.result as { tools?: { name: string }[] })?.tools ?? []).length;
        await new Promise<void>((res) => { child.on("exit", () => res()); child.stdin.end(); setTimeout(() => { child.kill("SIGKILL"); res(); }, 4000); });
        return n;
      };
      expect(await count([])).toBe(10);
      expect(await count(["--tools", "full"])).toBeGreaterThan(10);
    } finally {
      execFileSync("node", [BIN, "-C", vault, "config", "set", "mcp.tools", "full"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    }
  }, 30000);
});
