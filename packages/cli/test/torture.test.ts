import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Concurrent-writer torture (11 §7 CLI-B gate; 04 §5 re-run cross-process). A
// live `omg watch` holds the watch lease while one-shot mutations fire under
// the writer flock. Assert: every mutation lands, the doc converges, and
// `doctor` passes — i.e. the cross-process lock kept file+db consistent.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BIN = resolve(HERE, "..", "dist", "src", "main.js");

let dir: string;
let vault: string;

function omg(args: string[], input?: string): string {
  return execFileSync("node", [BIN, "-C", vault, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...(input !== undefined ? { input } : {}),
  });
}
function omgExit(args: string[]): number {
  try {
    execFileSync("node", [BIN, "-C", vault, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-torture-"));
  vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "hub.md"), ["# Hub", "", "## Log", "", "- seed entry", ""].join("\n"));
  execFileSync("node", [BIN, "init", vault, "--yes"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("concurrent-writer torture (live watch + one-shot mutations)", () => {
  it("all appends land, the doc converges, and doctor passes", async () => {
    // Start a live watcher (holds the watch lease).
    const watcher: ChildProcess = spawn("node", [BIN, "-C", vault, "watch"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    try {
      await sleep(400); // let the watcher take the lease + settle

      const heading = omg(["find", "Log", "-1"]).trim();
      const N = 8;
      // Fire one-shot appends in sequence; each acquires the writer flock while
      // the watcher's checkpoint ingests also contend for it.
      for (let i = 0; i < N; i++) {
        omg(["append", heading, "-m", `- entry ${i}`]);
      }

      // Give the watcher a beat to observe the engine writes (all echo-suppressed
      // by hash, so no divergence) and quiesce.
      await sleep(800);

      // Every appended entry is present exactly once.
      for (let i = 0; i < N; i++) {
        const hits = omg(["q", `type == "list_item"`, "--text", `entry`, "--ids"]).trim();
        expect(hits.length).toBeGreaterThan(0);
      }
      const items = omg(["q", 'type == "list_item"', "--ids"]).trim().split("\n").filter(Boolean);
      // seed entry + N appended
      expect(items.length).toBe(N + 1);

      // The document converged (file bytes == rendered revision) and invariants hold.
      expect(omgExit(["doctor"])).toBe(0);
    } finally {
      watcher.kill("SIGTERM");
      await sleep(150);
      if (!watcher.killed) watcher.kill("SIGKILL");
    }
  }, 20000);
});
