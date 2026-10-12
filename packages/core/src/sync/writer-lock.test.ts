import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWriterLock, withWriterLockAsync, writerLockFree, writerLockHeld, setWriterLockDefaults, writerLockDefaults, WriterLockTimeout } from "./writer-lock.js";

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
    // Simulate a live holder: our own pid — pidAlive() is true, so the lock
    // cannot be stolen.
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(() => withWriterLock(d, () => 1, { timeoutMs: 100, pollMs: 10 })).toThrow(WriterLockTimeout);
  });

  it("never steals a live holder's lock, however old its record (spec/sync §7)", () => {
    const d = omgbaseDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() - 3_600_000 }));
    expect(() => withWriterLock(d, () => 1, { timeoutMs: 100, pollMs: 10 })).toThrow(WriterLockTimeout);
    expect(writerLockFree(d)).toBe(false);
  });

  it("steals a lock whose body does not parse (spec/sync §9)", () => {
    const d = omgbaseDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), "not json");
    expect(withWriterLock(d, () => "stolen", { timeoutMs: 500 })).toBe("stolen");
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

describe("withWriterLock re-entrancy (one acquire per host write)", () => {
  it("a nested call on the same dir runs fn under the outer acquire; only the outermost exit releases", () => {
    const d = omgbaseDir();
    expect(writerLockHeld(d)).toBe(false);
    const inodes: number[] = [];
    const out = withWriterLock(d, () => {
      expect(writerLockHeld(d)).toBe(true);
      inodes.push(statSync(join(d, "writer.lock")).ino);
      // The inner call must not poll against our own live pid (it would wait
      // the full timeout and throw): a tight timeout proves it never waits.
      const inner = withWriterLock(d, () => {
        expect(writerLockHeld(d)).toBe(true);
        inodes.push(statSync(join(d, "writer.lock")).ino);
        return withWriterLock(d, () => "deep", { timeoutMs: 1, pollMs: 1 });
      }, { timeoutMs: 1, pollMs: 1 });
      // Leaving the inner levels did not release the file.
      expect(writerLockHeld(d)).toBe(true);
      expect(existsSync(join(d, "writer.lock"))).toBe(true);
      expect(writerLockFree(d)).toBe(false);
      return inner;
    });
    expect(out).toBe("deep");
    expect(inodes[0]).toBe(inodes[1]); // the same lock file throughout: one acquire
    expect(writerLockHeld(d)).toBe(false);
    expect(writerLockFree(d)).toBe(true);
    expect(existsSync(join(d, "writer.lock"))).toBe(false);
  });

  it("an inner throw unwinds the depth without releasing the outer hold", () => {
    const d = omgbaseDir();
    withWriterLock(d, () => {
      expect(() => withWriterLock(d, () => { throw new Error("inner"); })).toThrow("inner");
      expect(writerLockHeld(d)).toBe(true);
      expect(existsSync(join(d, "writer.lock"))).toBe(true);
    });
    expect(writerLockHeld(d)).toBe(false);
    expect(existsSync(join(d, "writer.lock"))).toBe(false);
  });

  it("the dir is keyed by its resolved path (relative and absolute spellings are one lock)", () => {
    const d = omgbaseDir();
    const cwd = process.cwd();
    process.chdir(dir!);
    try {
      withWriterLock(d, () => {
        expect(writerLockHeld(".omgbase")).toBe(true);
        expect(withWriterLock(".omgbase", () => "same", { timeoutMs: 1 })).toBe("same");
      });
    } finally {
      process.chdir(cwd);
    }
    expect(writerLockFree(d)).toBe(true);
  });

  it("re-entrancy is per process: a foreign live holder is still waited for", () => {
    const d = omgbaseDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    // Not in this process's held set (written by hand, "another process" with a
    // live pid), so it is not re-entered — it is waited for and times out.
    expect(writerLockHeld(d)).toBe(false);
    expect(() => withWriterLock(d, () => 1, { timeoutMs: 60, pollMs: 10 })).toThrow(WriterLockTimeout);
  });

  it("withWriterLockAsync holds the lock across awaits and releases when the promise settles", async () => {
    const d = omgbaseDir();
    let seenHeldAfterAwait = false;
    const p = withWriterLockAsync(d, async () => {
      expect(writerLockHeld(d)).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      seenHeldAfterAwait = writerLockHeld(d) && existsSync(join(d, "writer.lock"));
      // A sync re-entry from the same process while the async hold is live.
      expect(withWriterLock(d, () => "nested", { timeoutMs: 1 })).toBe("nested");
      expect(existsSync(join(d, "writer.lock"))).toBe(true);
      return "async";
    });
    expect(writerLockHeld(d)).toBe(true); // acquired synchronously, before the first await
    await expect(p).resolves.toBe("async");
    expect(seenHeldAfterAwait).toBe(true);
    expect(writerLockHeld(d)).toBe(false);
    expect(existsSync(join(d, "writer.lock"))).toBe(false);
  });

  it("withWriterLockAsync releases on rejection too", async () => {
    const d = omgbaseDir();
    await expect(withWriterLockAsync(d, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(writerLockHeld(d)).toBe(false);
    expect(writerLockFree(d)).toBe(true);
  });
});

describe("writer lock defaults (the process-wide seam the CLI's OMGBASE_WRITER_LOCK_TIMEOUT_MS installs)", () => {
  afterEach(() => setWriterLockDefaults({}));

  it("spec/sync §7's defaults: 5 s, polled every 25 ms", () => {
    expect(writerLockDefaults()).toEqual({ timeoutMs: 5000, pollMs: 25 });
  });

  it("an override shortens every lock the process takes; the poll never outlasts the timeout; per-call opts still win", () => {
    setWriterLockDefaults({ timeoutMs: 60 });
    expect(writerLockDefaults()).toEqual({ timeoutMs: 60, pollMs: 25 });
    setWriterLockDefaults({ timeoutMs: 10 });
    expect(writerLockDefaults()).toEqual({ timeoutMs: 10, pollMs: 10 });
    const d = omgbaseDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "writer.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const t0 = Date.now();
    expect(() => withWriterLock(d, () => 1)).toThrow(WriterLockTimeout); // no per-call opts: the override's 10 ms
    expect(Date.now() - t0).toBeLessThan(1000);
    const t1 = Date.now();
    expect(() => withWriterLock(d, () => 1, { timeoutMs: 120, pollMs: 10 })).toThrow(WriterLockTimeout);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(100); // the per-call wait, not the default
  });
});
