import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "./spawn.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The workspace writer lock around a one-shot command (spec/sync §7): the
// pre-verb freshness sweep and `omg sync` are checkpoint ingests, so they run
// under `.omgbase/writer.lock` — a live foreign holder makes them wait and then
// fail as the engine's catch-all error (exit 1), the same envelope a write tool
// returns; `--stale` skips the sweep and so never contends. The wait is
// shortened by the `OMGBASE_WRITER_LOCK_TIMEOUT_MS` seam (the Rust binary reads
// the same variable) so the suite does not sit out the spec's 5 s.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;
let lockFile: string;
const ENV = { ...process.env, NO_COLOR: "1", OMGBASE_WRITER_LOCK_TIMEOUT_MS: "150" };

function omg(args: string[], env: NodeJS.ProcessEnv = ENV) {
  return spawnSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", env });
}
/** A live foreign holder: this vitest process's pid is alive, so the child can neither steal nor re-enter it. */
function holdLock(): void {
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-cli-lock-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "hub.md"), "# Hub\n\nIntro.\n");
  expect(spawnSync("node", [BIN, "init", vault, "--yes", "--no-embedder"], { encoding: "utf8", env: ENV }).status).toBe(0);
  expect(omg(["source", "add", ".", "-y"]).status).toBe(0);
  lockFile = join(vault, ".omgbase", "writer.lock");
});
afterEach(() => { if (existsSync(lockFile)) unlinkSync(lockFile); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("one-shot commands and the workspace writer lock (spec/sync §7)", () => {
  it("the pre-verb freshness sweep contends with a held lock: the command fails as repo_not_found within the seam's wait", () => {
    holdLock();
    const t0 = Date.now();
    const res = omg(["ls"]);
    expect(Date.now() - t0).toBeLessThan(4000); // the seam's 150 ms + node startup, not 5 s
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/error\[repo_not_found\]: could not acquire writer lock .*writer\.lock \(held by pid \d+\)/);
    // The holder's record was waited for, never stolen.
    expect(JSON.parse(readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
    // The same in machine mode: the envelope on stderr.
    const json = omg(["--json", "ls"]);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stderr.trim().split("\n").pop()!)).toMatchObject({ error: "repo_not_found", retriable: false });
  });

  it("--stale skips the sweep and so never contends; a read then succeeds under a held lock", () => {
    holdLock();
    const res = omg(["--stale", "ls"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("hub.md");
  });

  it("a one-shot `omg sync` is a checkpoint ingest: it contends too, and runs once the lock is free", () => {
    holdLock();
    const blocked = omg(["sync"]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/error\[repo_not_found\]: could not acquire writer lock/);
    unlinkSync(lockFile);
    writeFileSync(join(vault, "fresh.md"), "# Fresh\n");
    const swept = omg(["--json", "sync"]);
    expect(swept.status).toBe(0);
    expect(JSON.parse(swept.stdout) as { ingested: string[] }).toMatchObject({ ingested: ["/fresh.md"] });
    expect(existsSync(lockFile)).toBe(false); // released
  });

  it("the sweep's lock and a verb's own write lock are one claim: a write verb runs under the default wait once the lock is free", () => {
    // No holder: the sweep takes and releases the lock, then the verb's kernel
    // write re-takes it (re-entrancy covers the nested case inside one call).
    const res = omg(["new", "note.md", "-m", "# Note\n"], { ...process.env, NO_COLOR: "1" });
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(vault, "note.md"))).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });
});
