import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Watch lease (11 §3.4). `omg watch` / `omg mcp`'s in-process watcher holds an
// advisory lock on <workspace>/.omgbase/watch.lock for its lifetime. Liveness is
// the lock itself: try-acquire non-blocking; acquirable ⇒ no live watcher. No
// heartbeats, no PID files beyond this record, no stale-lease sweeper. Commands
// probe it to skip the freshness sweep; `omg status` reports live/none.
//
// Implemented with the same O_EXCL + pid-liveness substitution as the writer
// lock (Node exposes no flock; no new deps — 11 §8). Held open until release().

const LEASE_NAME = "watch.lock";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolderPid(leasePath: string): number | null {
  try {
    return (JSON.parse(readFileSync(leasePath, "utf8")) as { pid?: number }).pid ?? null;
  } catch {
    return null;
  }
}

/** True if a live watcher currently holds the lease. */
export function watchLeaseLive(omgbaseDir: string): boolean {
  const leasePath = join(omgbaseDir, LEASE_NAME);
  if (!existsSync(leasePath)) return false;
  const pid = readHolderPid(leasePath);
  return pid != null && pidAlive(pid);
}

export class WatchLease {
  private held = false;
  private readonly leasePath: string;

  private constructor(omgbaseDir: string) {
    this.leasePath = join(omgbaseDir, LEASE_NAME);
  }

  /**
   * Try to take the lease. Returns a held lease, or null if a live watcher
   * already holds it. A lease whose holder pid is dead is stolen.
   */
  static tryAcquire(omgbaseDir: string): WatchLease | null {
    mkdirSync(omgbaseDir, { recursive: true });
    const lease = new WatchLease(omgbaseDir);
    if (lease.take()) return lease;
    return null;
  }

  private take(): boolean {
    try {
      const fd = openSync(this.leasePath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      this.held = true;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readHolderPid(this.leasePath);
      if (pid == null || !pidAlive(pid)) {
        try {
          unlinkSync(this.leasePath);
        } catch {
          return false;
        }
        return this.take();
      }
      return false;
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (existsSync(this.leasePath)) unlinkSync(this.leasePath);
    } catch {
      /* best-effort */
    }
  }
}
