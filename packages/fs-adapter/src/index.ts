import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";

// @omgbase/fs-adapter — the filesystem sync source (13-sync-plugins §7), a
// standalone process the engine spawns and speaks the stdio protocol to (see
// bin.ts). It owns chokidar + all node:fs access for live sync, so omgbase core
// carries no filesystem-watch dependency. This module is the transport-free
// core (enumerate/fetch/write/remove/watch over a root); bin.ts wraps it in the
// NDJSON protocol.

/** Absolute path to this package's bin.js — lets a sibling package spawn the
 *  adapter (`node <binPath> --root …`) without a global install. */
export function fsAdapterBinPath(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.url));
}

export interface FsEntry {
  path: string;
  revision: string;
}
export interface FsItem extends FsEntry {
  content: string;
}

const IGNORED_DIRS = new Set([".omgbase", ".git", "node_modules"]);
const isIgnored = (p: string): boolean => /(^|[/\\])(\.omgbase|\.git|node_modules)([/\\]|$)/.test(p);

/** cheap change-token: mtime_ns:size (a stat, no read) — 13 §5.1. */
function revisionOf(abs: string): string {
  const st = statSync(abs, { bigint: true });
  return `${st.mtimeNs}:${st.size}`;
}

export interface FsAdapterOptions {
  root: string;
  /** file extensions to include (default: [".md"]). */
  ext?: string[];
  /** chokidar debounce to quiescence in ms (default 750). */
  debounceMs?: number;
}

export class FsAdapter {
  private readonly root: string;
  private readonly ext: string[];
  private readonly debounceMs: number;

  constructor(opts: FsAdapterOptions) {
    this.root = opts.root;
    this.ext = opts.ext && opts.ext.length ? opts.ext : [".md"];
    this.debounceMs = opts.debounceMs ?? 750;
  }

  capabilities(): { identity: "inferred"; writeThrough: true; watch: true } {
    return { identity: "inferred", writeThrough: true, watch: true };
  }

  private matches(path: string): boolean {
    return this.ext.some((e) => path.endsWith(e));
  }

  private walk(): string[] {
    const out: string[] = [];
    const recur = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (IGNORED_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) recur(full);
        else if (this.matches(entry)) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    recur(this.root);
    return out;
  }

  enumerate(): FsEntry[] {
    return this.walk().map((path) => ({ path, revision: revisionOf(join(this.root, path)) }));
  }

  fetch(path: string): FsItem | null {
    const abs = join(this.root, path);
    if (!existsSync(abs)) return null;
    return { path, revision: revisionOf(abs), content: readFileSync(abs, "utf8") };
  }

  write(path: string, content: string): void {
    const abs = join(this.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  remove(path: string): void {
    rmSync(join(this.root, path), { force: true });
  }

  /** Watch the tree; deliver debounced batches of repo-relative changed paths. */
  watch(onBatch: (paths: string[]) => void): { stop(): Promise<void> } {
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending.size === 0) return;
      const paths = [...pending];
      pending.clear();
      onBatch(paths);
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, this.debounceMs);
    };
    const watcher: FSWatcher = chokidar.watch(this.root, {
      ignored: (p: string) => isIgnored(p),
      ignoreInitial: true,
      persistent: true,
    });
    const onEvent = (abs: string): void => {
      if (!this.matches(abs)) return;
      pending.add(relative(this.root, abs).split(sep).join("/"));
      schedule();
    };
    watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);
    return {
      async stop() {
        if (timer) { clearTimeout(timer); timer = null; }
        await watcher.close();
      },
    };
  }
}
