import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { recordFileStat } from "../sync/freshness.js";

// DocStore seam (ADR-014 §5). The mutation write path (apply / docs ops) is
// "write-through to the file" (ADR-004): render → write bytes → re-ingest. That
// file write is the ONLY thing coupling a mutation to a local disk. This seam
// abstracts the write target keyed on repo-relative paths so the same kernel can
// serve a filesystem-backed repo (FsDocStore, today's behavior) or a headless,
// DB-canonical repo with no working tree (NullDocStore, where the DB *is* the
// artifact and the file write is a no-op). All paths are repo-relative canonical
// (docs.path); the store joins its root internally.
//
// The freshness stat-cache (file_stats) is a filesystem-mtime concern, so it
// lives behind the store too: recordStat/clearStat are meaningful only for a
// filesystem repo and no-op otherwise. Callers still gate these on a real
// workspace (omgbaseDir) exactly as before.

export interface DocStore {
  /** Does a file exist at repo-relative `path`? */
  exists(path: string): boolean;
  /** Current bytes at `path`, or null if absent. */
  read(path: string): string | null;
  /** Atomically write `bytes` to `path` (mkdir -p parents; temp file + rename). */
  write(path: string, bytes: string): void;
  /** Rename `from` → `to` (mkdir -p the destination's parents). */
  rename(from: string, to: string): void;
  /** Remove `path` if present. */
  remove(path: string): void;
  /** Refresh the freshness stat-cache row for `path` after writing `bytes`. */
  recordStat(store: Store, repoId: string, path: string, bytes: string): void;
  /** Drop the freshness stat-cache row for `path`. */
  clearStat(store: Store, repoId: string, path: string): void;
}

/** Filesystem-backed DocStore rooted at a working-tree directory (v1 default). */
export class FsDocStore implements DocStore {
  constructor(private readonly root: string) {}
  private abs(path: string): string {
    return join(this.root, path);
  }
  exists(path: string): boolean {
    return existsSync(this.abs(path));
  }
  read(path: string): string | null {
    const abs = this.abs(path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }
  write(path: string, bytes: string): void {
    const abs = this.abs(path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.omgtmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  }
  rename(from: string, to: string): void {
    const toAbs = this.abs(to);
    mkdirSync(dirname(toAbs), { recursive: true });
    renameSync(this.abs(from), toAbs);
  }
  remove(path: string): void {
    const abs = this.abs(path);
    if (existsSync(abs)) unlinkSync(abs);
  }
  recordStat(store: Store, repoId: string, path: string, bytes: string): void {
    recordFileStat(store, repoId, path, this.abs(path), sha256(bytes));
  }
  clearStat(store: Store, repoId: string, path: string): void {
    store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(repoId, path);
  }
}

/** Headless DocStore: no working tree. The DB is the canonical artifact, so the
 *  file write is a no-op and there is no on-disk state to CAS against or stat. */
export class NullDocStore implements DocStore {
  exists(): boolean {
    return false;
  }
  read(): string | null {
    return null;
  }
  write(): void {}
  rename(): void {}
  remove(): void {}
  recordStat(): void {}
  clearStat(): void {}
}

/** The write target for a mutation: an explicit DocStore, else a filesystem
 *  store rooted at `rootPath`. Throws if neither is supplied (a caller must name
 *  one or the other — a filesystem repo passes rootPath; a headless repo passes
 *  a NullDocStore). */
export function resolveDocStore(req: { docStore?: DocStore; rootPath?: string }): DocStore {
  if (req.docStore) return req.docStore;
  if (req.rootPath != null) return new FsDocStore(req.rootPath);
  throw new Error("mutation requires a rootPath or an explicit docStore");
}
