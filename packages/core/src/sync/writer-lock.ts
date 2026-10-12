import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

// Cross-process writer lock (11 §3.2). The write protocol's per-repo writer
// mutex (04 §6 step 1) generalizes to an advisory lock on
// <workspace>/.omgbase/writer.lock, held for steps 2–7. All writers — one-shot
// CLI mutations, watcher checkpoint ingests, `omg mcp` applies — acquire it.
//
// Node core exposes no flock(2), and the design forbids new runtime deps (11
// §8). We implement the same advisory contract with an O_EXCL lockfile: exclusive
// creation is atomic on local filesystems, the holder writes its pid for
// liveness, and a lock whose pid is dead (or whose body does not parse) is
// stolen — never one whose holder is alive, however old the record (spec/sync
// §7; no daemon, no lease sweeper — the same "probe by trying" spirit as the
// watch lease in §3.4). This is an as-built substitution for flock; the
// file-CAS + ingest-and-replay behavior in the write protocol is unchanged.

const LOCK_NAME = "writer.lock";

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
    // Lock exists: steal it only if the holder is dead or the record is unreadable.
    const holderPid = readHolderPid(lockPath);
    if (holderPid == null || !pidAlive(holderPid)) {
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

// Blocking sleep between polls. Writers hold the lock only for the brief
// file-CAS + ingest window, so contention waits are short, and the lock API
// stays synchronous like the rest of the write path. `Atomics.wait` parks the
// thread in the kernel for `ms` — unlike a `Date.now()` spin it burns no CPU,
// which matters precisely when several writers contend on a loaded machine
// (each spinning waiter would otherwise steal cycles from the lock holder).
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

// Re-entrancy (one acquire per host write, spec/sync §7). The lock is a
// per-PROCESS claim — the record names a pid and liveness is the pid's — so a
// second `withWriterLock` on the same directory from the holder must not poll
// against itself (it would see its own live pid and time out). The process
// keeps a depth per lock path: the first entry acquires the file, nested
// entries run their fn directly, and the exit that brings the depth back to
// zero releases. Nesting happens by design — a tool-boundary lock around a
// whole MCP call (`mcp/server.ts`) encloses the kernel's own commit-phase lock
// (`mutate/apply.ts`), and a watcher checkpoint may run while a verb holds the
// lock — and since the file is one claim per process, the depth also lets an
// async holder (a checkpoint awaiting the adapter) and a tool call interleave
// on the event loop without either releasing the other's claim. Cross-process
// semantics are unchanged: a foreign live holder is waited for, never stolen.
const held = new Map<string, number>();

// The depth is keyed by the directory's real path, so two spellings of one
// workspace (relative/absolute, a symlinked tree) are one claim; a directory
// that does not exist yet (a probe before the first write) keys by its resolved path.
function lockPathOf(omgbaseDir: string): string {
  let dir: string;
  try {
    dir = realpathSync.native(omgbaseDir);
  } catch {
    dir = resolve(omgbaseDir);
  }
  return join(dir, LOCK_NAME);
}

// Process-wide defaults for the wait (spec/sync §7: 5 s, polled every 25 ms).
// A host may override them for the whole process — the CLI's
// `OMGBASE_WRITER_LOCK_TIMEOUT_MS` test seam does, so a verb's kernel-level lock
// and `omg mcp`'s tool-boundary lock shorten together, like the Rust binary's.
// Per-call `opts` still win.
let defaults: Required<WriterLockOptions> = { timeoutMs: 5000, pollMs: 25 };

/** Override the process-wide wait defaults (a test seam; the poll never outlasts the timeout). */
export function setWriterLockDefaults(opts: WriterLockOptions): void {
  const timeoutMs = opts.timeoutMs ?? 5000;
  defaults = { timeoutMs, pollMs: Math.min(opts.pollMs ?? 25, timeoutMs) };
}

/** The process-wide wait defaults in force. */
export function writerLockDefaults(): Required<WriterLockOptions> {
  return { ...defaults };
}

function acquire(lockPath: string, opts: WriterLockOptions): void {
  const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
  const pollMs = opts.pollMs ?? defaults.pollMs;
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) throw new WriterLockTimeout(lockPath, readHolderPid(lockPath));
    sleepSync(pollMs);
  }
}

function release(lockPath: string): void {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    /* best-effort release */
  }
}

/** Enter the lock: acquire the file at depth 0, otherwise just deepen. */
function enter(omgbaseDir: string, opts: WriterLockOptions): string {
  mkdirSync(omgbaseDir, { recursive: true });
  const lockPath = lockPathOf(omgbaseDir);
  const depth = held.get(lockPath) ?? 0;
  if (depth === 0) acquire(lockPath, opts);
  held.set(lockPath, depth + 1);
  return lockPath;
}

/** Leave the lock: shallow, and release the file when the depth reaches 0. */
function exit(lockPath: string): void {
  const depth = (held.get(lockPath) ?? 1) - 1;
  if (depth > 0) {
    held.set(lockPath, depth);
    return;
  }
  held.delete(lockPath);
  release(lockPath);
}

/**
 * Run fn while holding the workspace writer lock. Blocks (polling) until the
 * lock is free or the timeout elapses, then releases the lock even if fn throws.
 * Re-entrant within the process: a nested call on the same directory runs fn
 * directly and the outermost exit releases.
 */
export function withWriterLock<T>(omgbaseDir: string, fn: () => T, opts: WriterLockOptions = {}): T {
  const lockPath = enter(omgbaseDir, opts);
  try {
    return fn();
  } finally {
    exit(lockPath);
  }
}

/**
 * The async form: the lock is held until the promise `fn` returns settles (a
 * sync `withWriterLock` around an async fn would release at the first await).
 * Acquisition still polls synchronously — the wait is the same bounded
 * contention window as the sync form's. Same re-entrancy.
 */
export async function withWriterLockAsync<T>(omgbaseDir: string, fn: () => Promise<T>, opts: WriterLockOptions = {}): Promise<T> {
  const lockPath = enter(omgbaseDir, opts);
  try {
    return await fn();
  } finally {
    exit(lockPath);
  }
}

/** True while THIS process holds the lock (at any depth) — a test seam for "ran under the lock". */
export function writerLockHeld(omgbaseDir: string): boolean {
  return (held.get(lockPathOf(omgbaseDir)) ?? 0) > 0;
}

/** True if no live writer holds the lock (probe without acquiring). */
export function writerLockFree(omgbaseDir: string): boolean {
  const lockPath = join(omgbaseDir, LOCK_NAME);
  if (!existsSync(lockPath)) return true;
  const pid = readHolderPid(lockPath);
  return pid == null || !pidAlive(pid);
}
