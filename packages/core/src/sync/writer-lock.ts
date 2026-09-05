import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Cross-process writer lock (11 §3.2). The write protocol's per-repo writer
// mutex (04 §6 step 1) generalizes to an advisory lock on
// <workspace>/.omgbase/writer.lock, held for steps 2–7. All writers — one-shot
// CLI mutations, watcher checkpoint ingests, `omg mcp` applies — acquire it.
//
// Node core exposes no flock(2), and the design forbids new runtime deps (11
// §8). We implement the same advisory contract with an O_EXCL lockfile: exclusive
// creation is atomic on local filesystems, the holder writes its pid for
// liveness, and a lock whose pid is dead is stolen (no daemon, no lease sweeper —
// the same "probe by trying" spirit as the watch lease in §3.4). This is an
// as-built substitution for flock; the file-CAS + ingest-and-replay behavior in
// the write protocol is unchanged.

const LOCK_NAME = "writer.lock";
const STALE_MS = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WriterLockOptions {
  /** Max time to wait for the lock before throwing (ms). Default 5000. */
  timeoutMs?: number;
  /** Poll interval while waiting (ms). Default 25. */
  pollMs?: number;
}

export class WriterLockTimeout extends Error {
  constructor(lockPath: string, holderPid: number | null) {
    super(`could not acquire writer lock ${lockPath} (held by pid ${holderPid ?? "?"})`);
    this.name = "WriterLockTimeout";
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Lock exists: steal it if the holder is dead or the record is stale.
    let holderPid: number | null = null;
    let ts = 0;
    try {
      const rec = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; ts?: number };
      holderPid = rec.pid ?? null;
      ts = rec.ts ?? 0;
    } catch {
      // Unreadable/partial lock record — treat as stale.
    }
    const dead = holderPid != null && !pidAlive(holderPid);
    const stale = Date.now() - ts > STALE_MS;
    if (dead || stale) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* someone else stole it first; fall through to retry */
      }
      return tryAcquire(lockPath);
    }
    return false;
  }
}

function readHolderPid(lockPath: string): number | null {
  try {
    return (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid ?? null;
  } catch {
    return null;
  }
}

// Busy-wait with a blocking sleep between polls. Writers hold the lock only for
// the brief file-CAS + ingest window, so contention waits are short; a sync
// spin keeps the lock API synchronous like the rest of the write path.
function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Run fn while holding the workspace writer lock. Blocks (polling) until the
 * lock is free or the timeout elapses, then releases the lock even if fn throws.
 */
export function withWriterLock<T>(omgbaseDir: string, fn: () => T, opts: WriterLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 25;
  mkdirSync(omgbaseDir, { recursive: true });
  const lockPath = join(omgbaseDir, LOCK_NAME);

  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) throw new WriterLockTimeout(lockPath, readHolderPid(lockPath));
    sleepSync(pollMs);
  }
  try {
    return fn();
  } finally {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* best-effort release */
    }
  }
}

/** True if no live writer holds the lock (probe without acquiring). */
export function writerLockFree(omgbaseDir: string): boolean {
  const lockPath = join(omgbaseDir, LOCK_NAME);
  if (!existsSync(lockPath)) return true;
  const pid = readHolderPid(lockPath);
  return pid == null || !pidAlive(pid);
}
