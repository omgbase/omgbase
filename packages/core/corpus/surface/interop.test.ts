// The cross-engine interop harness (spec/surface README §7): one database, two
// engines. For every case of spec/surface/cases/interop.json and every
// (writer, reader) pair in {ts, rust}²:
//
//   1. a fresh temp dir W gets the suite's corpus as files and a database at
//      W/.omgbase/omgbase.db bootstrapped by THIS engine (`ensureRepo("fixture", W)`
//      under the fixture minter; no documents) — §7.2 step 1;
//   2. the writer is spawned as an MCP server over stdio on W under the §7.1
//      seams, `observe_many` seeds the corpus (bytewise path order), the case's
//      `writes` run, the writer is closed (stdin EOF) and waited for — step 2;
//   3. the reader is spawned the same way, `reads` run, it is closed — step 3;
//   4. both recorded sequences must equal `expect` — step 4.
//
// Outcomes are recorded as reads.json records them (`toReadOutcome`) plus the
// `<workspace>` path rewrite of §7.3. The two same-engine pairs prove each engine
// against the committed expectation over stdio; the two cross pairs are the
// interop gate. SURFACE_SPEC_UPDATE=1 regenerates `expect` from the ts→ts pair
// (and re-embeds the corpus). A missing peer fails its pairs with the build
// command; OMGBASE_INTEROP=skip turns that into a skip (§7.4).
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, withIdMinter } from "../../src/core/ids.js";
import {
  CORPUS_TS, FIXTURE_REPO_SLUG, cmpBytes, deepEqualTol, describeChange, readCorpusFromDisk, sortKeys, toReadOutcome, validateFixtureFile,
  type InteropCall, type InteropCase, type InteropSuite, type ReadOutcome, type ToolResult,
} from "./fixture.js";

// packages/core/corpus/surface → repo root is four levels up.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SPEC_FILE = join(REPO_ROOT, "spec", "surface", "cases", "interop.json");
const TS_MAIN = join(REPO_ROOT, "packages", "cli", "dist", "src", "main.js");

const UPDATE = (() => {
  const v = process.env.SURFACE_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();
const SKIP_MISSING = process.env.OMGBASE_INTEROP === "skip";

/** Nothing projected is floating point except search scores; compare within 1e-9. */
const EPS = 1e-9;

// Generous: a peer is a cold process (Node + better-sqlite3, or a debug Rust
// binary) observing 20 documents and answering dozens of calls.
const CONNECT_MS = 60_000;
const CALL_MS = 60_000;
const EXIT_MS = 15_000;
const TEST_MS = 10 * 60_000;

// ---- peers (§7.4) --------------------------------------------------------------

type Engine = "ts" | "rust";

interface Peer {
  engine: Engine;
  /** the executable to spawn (may be a path that does not exist — `available` says) */
  command: string;
  args(workspace: string): string[];
  available: boolean;
  /** the command that builds it, for the failure message */
  build: string;
}

function rustBinary(): string | null {
  const fromEnv = process.env.OMGBASE_RUST_BIN;
  if (fromEnv) return fromEnv;
  for (const rel of ["target/debug/omgbase", "target/release/omgbase"]) {
    const p = join(REPO_ROOT, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

const PEERS: Record<Engine, Peer> = {
  ts: {
    engine: "ts",
    command: process.execPath,
    args: (W) => [TS_MAIN, "mcp", "-C", W, "--no-watch"],
    available: existsSync(TS_MAIN),
    build: "pnpm build",
  },
  rust: (() => {
    const bin = rustBinary();
    return {
      engine: "rust",
      command: bin ?? join(REPO_ROOT, "target", "debug", "omgbase"),
      args: (W) => ["mcp", "--workspace", W, "--no-watch"],
      available: bin !== null && existsSync(bin),
      build: "cargo build -p omgbase",
    };
  })(),
};

const PAIRS: [Engine, Engine][] = [["ts", "ts"], ["ts", "rust"], ["rust", "ts"], ["rust", "rust"]];

// ---- a child-process stdio transport --------------------------------------------

/**
 * An MCP client transport over a child process's stdin/stdout — the SDK's
 * `StdioClientTransport` with the process lifetime made explicit: stderr is
 * captured (shown on failure only), `shutdown()` sends stdin EOF and waits for
 * the exit (§7.2: "closed (stdin EOF) and the harness waits for it to exit"),
 * escalating to SIGKILL after a grace period so a hung peer never outlives the
 * test.
 */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | null = null;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private eofSent = false;
  private readonly stderrChunks: string[] = [];
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error("ChildTransport already started");
    const child = spawn(this.command, this.args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exited = new Promise((res) => child.once("close", (code, signal) => res({ code, signal })));
    void this.exited.then(() => this.onclose?.());
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (e) {
        this.onerror?.(e as Error);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => this.stderrChunks.push(s));
    child.stdin!.on("error", (e) => this.onerror?.(e));
    await new Promise<void>((res, rej) => {
      child.once("spawn", () => res());
      child.once("error", (e) => rej(new Error(`spawn ${this.command}: ${e.message}`)));
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((res, rej) => {
      const stdin = this.child?.stdin;
      if (!stdin || this.eofSent) {
        rej(new Error("not connected"));
        return;
      }
      if (stdin.write(serializeMessage(message))) res();
      else stdin.once("drain", () => res());
    });
  }

  /** stdin EOF (the SDK `Client.close()` path lands here too). */
  async close(): Promise<void> {
    if (this.child && !this.eofSent) {
      this.eofSent = true;
      this.child.stdin!.end();
    }
  }

  /** EOF, then wait up to `graceMs` for the exit; SIGKILL when it does not come. */
  async shutdown(graceMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; forced: boolean }> {
    const child = this.child;
    if (!child || !this.exited) return { code: null, signal: null, forced: false };
    await this.close();
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      this.exited.then((r) => ({ ...r, forced: false })),
      new Promise<null>((res) => { timer = setTimeout(() => res(null), graceMs); }),
    ]);
    clearTimeout(timer);
    if (graceful) return graceful;
    child.kill("SIGKILL");
    const r = await this.exited;
    return { ...r, forced: true };
  }

  stderrText(): string {
    return this.stderrChunks.join("");
  }
}

// ---- one server session (§7.2 steps 2–3) --------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** §7.3: every string equal to W, or beginning with `W/`, has that prefix replaced by `<workspace>`. */
function rewriteWorkspace(v: unknown, W: string): unknown {
  if (typeof v === "string") {
    if (v === W) return "<workspace>";
    if (v.startsWith(W + "/")) return "<workspace>" + v.slice(W.length);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => rewriteWorkspace(x, W));
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = rewriteWorkspace(x, W);
    return out;
  }
  return v;
}

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

interface Session {
  outcomes: ReadOutcome[];
  stderr: string;
}

/**
 * Spawn `peer` on `W` under `env`, call every `calls` entry in order recording
 * the outcomes (§7.3), then close it (stdin EOF) and wait for a clean exit.
 * Any failure — spawn, timeout, protocol error, a non-zero exit — throws with
 * the peer's stderr appended; the child never survives the call.
 */
async function session(peer: Peer, W: string, env: NodeJS.ProcessEnv, calls: InteropCall[]): Promise<Session> {
  const transport = new ChildTransport(peer.command, peer.args(W), env);
  const client = new Client({ name: "surface-interop", version: "0" });
  const outcomes: ReadOutcome[] = [];
  let failure: unknown = null;
  try {
    await withTimeout(client.connect(transport), CONNECT_MS, `${peer.engine}: connect`);
    for (const call of calls) {
      const r = await withTimeout(client.callTool({ name: call.tool, arguments: call.args }), CALL_MS, `${peer.engine}: ${call.tool}`);
      outcomes.push(rewriteWorkspace(toReadOutcome(call.tool, r as ToolResult), W));
    }
  } catch (e) {
    failure = e;
  }
  const exit = await transport.shutdown(EXIT_MS);
  await client.close().catch(() => { /* already down */ });
  const stderr = transport.stderrText();
  const tail = `\n--- ${peer.engine} peer stderr ---\n${clip(stderr)}`;
  if (failure) throw new Error(`${peer.engine} peer: ${(failure as Error).message ?? String(failure)}${tail}`);
  if (exit.forced) throw new Error(`${peer.engine} peer did not exit within ${EXIT_MS} ms of stdin EOF (killed)${tail}`);
  if (exit.code !== 0) throw new Error(`${peer.engine} peer exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}${tail}`);
  return { outcomes, stderr };
}

// ---- one case (§7.2) --------------------------------------------------------------------

type InteropCaseInput = Omit<InteropCase, "expect"> & { expect?: InteropCase["expect"] };

interface CaseRun {
  writes: ReadOutcome[];
  reads: ReadOutcome[];
  stderr: { writer: string; reader: string };
}

/** §7.2 step 1: `W/.omgbase/omgbase.db` with repo `rp_0` (slug `fixture`) attached to the `fs` source `fixture-fs` (`src_0`) at W; no documents. */
function bootstrap(W: string): void {
  withIdMinter(sequentialMinter(), () => {
    const store = new Store({ path: join(W, ".omgbase", "omgbase.db") });
    try {
      ensureRepo(store, FIXTURE_REPO_SLUG, W);
    } finally {
      store.close();
    }
  });
}

/**
 * The seeding `observe_many` is not part of `expect` (one outcome per authored
 * write); it is checked instead: one outcome per file, in order, minting
 * `d_0, d_1, …` (README §6/§7.2: `d_0` is `index.md`), none an echo.
 */
function checkSeed(outcome: unknown, paths: string[], engine: Engine): void {
  const bad = (why: string): never => {
    throw new Error(`${engine} writer: the seeding observe_many ${why}\n${clip(JSON.stringify(outcome), 2000)}`);
  };
  if (!Array.isArray(outcome)) return bad("did not return an array");
  if (outcome.length !== paths.length) return bad(`returned ${outcome.length} outcomes for ${paths.length} files`);
  outcome.forEach((o: unknown, i: number) => {
    const rec = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
    if (rec.path !== paths[i]) bad(`outcome ${i} is for ${JSON.stringify(rec.path)}, expected ${paths[i]}`);
    if (rec.docId !== `d_${i}`) bad(`outcome ${i} minted ${JSON.stringify(rec.docId)}, expected d_${i} (is the minter seam active?)`);
    if (rec.echo !== false) bad(`outcome ${i} has echo ${JSON.stringify(rec.echo)}`);
  });
}

async function runCase(corpus: Record<string, string>, c: InteropCaseInput, writer: Peer, reader: Peer): Promise<CaseRun> {
  // realpath: macOS's tmpdir is a symlink, and a peer may report either spelling.
  const W = mkdtempSync(join(realpathSync(tmpdir()), "omgbase-interop-"));
  try {
    const paths = Object.keys(corpus).sort(cmpBytes);
    for (const p of paths) {
      const abs = join(W, p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, corpus[p]!);
    }
    bootstrap(W);
    const env: NodeJS.ProcessEnv = { ...process.env, OMGBASE_SPEC_MINTER: "sequential", OMGBASE_SPEC_CLOCK: c.ts ?? CORPUS_TS };
    const seed: InteropCall = { tool: "observe_many", args: { files: paths.map((path) => ({ path, content: corpus[path]! })) } };
    const w = await session(writer, W, env, [seed, ...(c.writes ?? [])]);
    checkSeed(w.outcomes[0], paths, writer.engine);
    const r = await session(reader, W, env, c.reads);
    return { writes: w.outcomes.slice(1), reads: r.outcomes, stderr: { writer: w.stderr, reader: r.stderr } };
  } finally {
    rmSync(W, { recursive: true, force: true });
  }
}

// ---- loading + regeneration ------------------------------------------------------------

const text = readFileSync(SPEC_FILE, "utf8");
const suite = JSON.parse(text) as InteropSuite;
const shapeProblems = validateFixtureFile("interop.json", suite, { requireExpect: !UPDATE });

/** Rewrite every case's `expect` from the ts→ts pair (and the corpus from disk); returns the change report. */
async function regenerate(): Promise<string[]> {
  const report: string[] = [];
  const before = suite.cases.map((c) => ({ ...c }));
  suite.corpus = readCorpusFromDisk();
  for (const c of suite.cases) {
    try {
      const run = await runCase(suite.corpus, c, PEERS.ts, PEERS.ts);
      (c as { expect: unknown }).expect = { writes: run.writes, reads: run.reads };
    } catch (e) {
      report.push(`  ! interop::${c.name}: ${String((e as Error).message ?? e).split("\n")[0]} (expect left as it was)`);
    }
  }
  // Assigning an existing key keeps its position; a missing `expect` lands last.
  const json = JSON.stringify(suite, null, 2) + "\n";
  const changed = json !== text;
  if (changed) writeFileSync(SPEC_FILE, json);
  report.push(`interop.json: ${suite.cases.length} cases${changed ? "" : " (unchanged)"}`);
  report.push(...describeChange("interop", before, suite.cases));
  return report;
}

if (UPDATE) {
  if (shapeProblems.length > 0) {
    process.stderr.write(`[surface interop] interop.json NOT regenerated — shape problems:\n${shapeProblems.map((p) => `  ! ${p}`).join("\n")}\n`);
  } else if (!PEERS.ts.available) {
    process.stderr.write(`[surface interop] interop.json NOT regenerated — the reference peer is missing (${PEERS.ts.build})\n`);
  } else {
    const report = await regenerate();
    process.stderr.write(`[surface interop] regenerated expectations in ${SPEC_FILE}\n${report.join("\n")}\n`);
  }
}

// ---- registration ----------------------------------------------------------------------

describe("surface interop (spec/surface §7, cases/interop.json)", () => {
  it("interop.json is well-formed", () => {
    expect(shapeProblems).toEqual([]);
  });

  it("interop.json embeds the alchemy corpus exactly as it is on disk (README §6)", () => {
    expect(suite.corpus).toEqual(readCorpusFromDisk());
  });

  const cases = shapeProblems.length === 0 ? suite.cases : [];
  for (const c of cases) {
    for (const [w, r] of PAIRS) {
      const name = `interop::${c.name} [${w}→${r}]`;
      const missing = [...new Set([w, r])].filter((e) => !PEERS[e].available);
      if (missing.length > 0 && SKIP_MISSING) {
        it.skip(`${name} — skipped: ${missing.map((e) => `${e} peer not built (${PEERS[e].build})`).join("; ")} [OMGBASE_INTEROP=skip]`, () => {});
        continue;
      }
      it(name, async () => {
        for (const e of missing) {
          throw new Error(`${e} peer not found (${e === "rust" ? "$OMGBASE_RUST_BIN, target/debug/omgbase or target/release/omgbase" : TS_MAIN}): build it with \`${PEERS[e].build}\`, or set OMGBASE_INTEROP=skip`);
        }
        const run = await runCase(suite.corpus, c, PEERS[w], PEERS[r]);
        const context = (): string => `\n--- writer (${w}) stderr ---\n${clip(run.stderr.writer, 3000)}\n--- reader (${r}) stderr ---\n${clip(run.stderr.reader, 3000)}`;
        const dw = deepEqualTol(run.writes, c.expect.writes, EPS);
        if (dw !== null) expect(sortKeys(run.writes), `writes: ${dw}${context()}`).toEqual(sortKeys(c.expect.writes));
        const dr = deepEqualTol(run.reads, c.expect.reads, EPS);
        if (dr !== null) expect(sortKeys(run.reads), `reads: ${dr}${context()}`).toEqual(sortKeys(c.expect.reads));
      }, TEST_MS);
    }
  }
});
