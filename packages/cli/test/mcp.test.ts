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
  execFileSync("node", [BIN, "-C", vault, "attach", ".", "-y"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
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
