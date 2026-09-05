import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWriterLock, writerLockFree, WriterLockTimeout } from "./writer-lock.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function omgbaseDir(): string {
  dir = mkdtempSync(join(tmpdir(), "omg-lock-"));
  return join(dir, ".omgbase");
}

describe("withWriterLock", () => {
  it("runs fn and releases the lock", () => {
    const d = omgbaseDir();
    const out = withWriterLock(d, () => 42);
    expect(out).toBe(42);
    expect(writerLockFree(d)).toBe(true);
    expect(existsSync(join(d, "writer.lock"))).toBe(false);
  });

  it("releases the lock even when fn throws", () => {
    const d = omgbaseDir();
    expect(() => withWriterLock(d, () => { throw new Error("boom"); })).toThrow("boom");
    expect(writerLockFree(d)).toBe(true);
  });

  it("serializes: reports not-free while held", () => {
    const d = omgbaseDir();
    withWriterLock(d, () => {
      expect(writerLockFree(d)).toBe(false);
    });
    expect(writerLockFree(d)).toBe(true);
  });

  it("times out if a live foreign holder never releases", () => {
    const d = omgbaseDir();
    // Simulate a live holder: our own pid, fresh timestamp — pidAlive() is true,
    // so the lock is neither dead nor stale and cannot be stolen.
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(() => withWriterLock(d, () => 1, { timeoutMs: 100, pollMs: 10 })).toThrow(WriterLockTimeout);
  });

  it("steals a stale lock held by a dead pid", () => {
    const d = omgbaseDir();
    mkdirSync(d, { recursive: true });
    // pid 1 is init; process.kill(1,0) throws EPERM (alive-but-not-ours), so use
    // a very high pid unlikely to exist to represent a dead holder.
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: 2_000_000_000, ts: Date.now() }));
    const out = withWriterLock(d, () => "stolen", { timeoutMs: 500 });
    expect(out).toBe("stolen");
  });
});
