import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

    const outline = await rpc.send("tools/call", { name: "docs_outline", arguments: { path: "hub.md" } });
    const oc = (outline.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
    expect(oc.isError).toBeFalsy();
    expect(oc.content?.[0]?.text ?? "").toContain("Hub");

    const q = await rpc.send("tools/call", { name: "query", arguments: { query: 'from blocks where type == "task"' } });
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
    execFileSync("node", [BIN, "-C", join(ws, "alpha"), "source", "add", ".", "--slug", "alpha", "-y"], { encoding: "utf8", env });
    execFileSync("node", [BIN, "-C", join(ws, "beta"), "source", "add", ".", "--slug", "beta", "-y"], { encoding: "utf8", env });
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
      return ((JSON.parse(c.content?.[0]?.text ?? "{}") as { hits?: { path?: string }[] }).hits ?? []).map((h) => h.path ?? "");
    };

    // No repo → the bound default (alpha).
    expect(await paths({})).toEqual(["a.md"]);
    // repo: "beta" → the other repo in the same workspace DB.
    expect(await paths({ repo: "beta" })).toEqual(["b.md"]);
    // repo: "alpha" explicitly → alpha.
    expect(await paths({ repo: "alpha" })).toEqual(["a.md"]);

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
    // embedder" case. It is configured (so NOT semantic_unavailable) but broken.
    execFileSync("node", [BIN, "-C", bvault, "config", "set", "embedding.provider", "omg-no-such-embedder-xyz"], { encoding: "utf8", env });
  });
  afterAll(() => rmSync(bdir, { recursive: true, force: true }));

  it("starts serving, warns loudly on stderr, and fails semantic access with embedder_failed", async () => {
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

    // A semantic query fails LOUDLY and SPECIFICALLY: embedder_failed, not the
    // misleading semantic_unavailable (which means "no provider configured").
    const sem = await rpc.send("tools/call", { name: "query", arguments: { query: 'from docs where semantic("hello") > 0.1' } });
    const sc = (sem.result as { content?: { text?: string }[]; isError?: boolean }) ?? {};
    expect(sc.isError).toBe(true);
    const body = JSON.parse(sc.content?.[0]?.text ?? "{}") as { error?: string; message?: string };
    expect(body.error).toBe("embedder_failed");
    expect(body.message ?? "").toContain("omg-no-such-embedder-xyz");

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
