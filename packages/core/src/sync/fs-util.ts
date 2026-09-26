import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Shared filesystem walk for the in-process one-shot/reconcile paths (attach,
// checkpoint, freshness). This is NOT the live watcher — chokidar lives only in
// the external @omgbase/fs-adapter (sync-plugins). node:fs (a builtin) reads
// are retained here for the one-shot ingest/freshness fast-path.
//
// `SyncFs` is the seam those paths read the filesystem through (spec/sync §4,
// §8): the sweep, the checkpoint and recovery take an optional `fs` and default
// to `nodeFs`, so a conformance runner can supply an in-memory filesystem with
// explicit `mtime_ns` and the fixtures stay free of real I/O.

const IGNORED_DIRS = new Set([".omgbase", ".git", "node_modules"]);

/** Walk `root` for *.md files, returning repo-relative canonical paths. */
export function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const recur = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) recur(full);
      else if (entry.endsWith(".md")) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  recur(root);
  return out;
}

/** The two stat fields the freshness cache keys on (spec/sync §4.3). */
export interface FileStat {
  mtimeNs: bigint;
  size: number;
}

/**
 * The filesystem as the sync paths see it — a walk, a stat and a read, all
 * keyed by (root, repo-relative path). `nodeFs` is the production default.
 */
export interface SyncFs {
  /** spec/sync §4.2: every `*.md` under `root`, repo-relative, `/` separators, readdir order, depth-first. */
  walk(root: string): string[];
  /** `(mtime_ns, size)` of `root/path`, or null when the file is absent. */
  stat(root: string, path: string): FileStat | null;
  /** The UTF-8 bytes of `root/path`, or null when the file is absent. */
  read(root: string, path: string): string | null;
}

/** The `node:fs` filesystem. */
export const nodeFs: SyncFs = {
  walk: walkMarkdown,
  stat(root, path) {
    const st = statSync(join(root, path), { bigint: true, throwIfNoEntry: false });
    return st ? { mtimeNs: st.mtimeNs, size: Number(st.size) } : null;
  },
  read(root, path) {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
};

/**
 * Async variant of {@link walkMarkdown}: identical result, but yields to the
 * event loop between directories and invokes `onFound(count)` as matches
 * accumulate. This lets a caller drive a live progress counter (e.g. beside an
 * interactive prompt) while the scan runs. `signal` lets the caller stop early
 * once a decision has been made — the partial result is still returned.
 */
export async function walkMarkdownAsync(
  root: string,
  onFound?: (count: number) => void,
  signal?: { aborted: boolean },
): Promise<string[]> {
  const out: string[] = [];
  const recur = async (dir: string): Promise<void> => {
    if (signal?.aborted) return;
    for (const entry of await readdir(dir)) {
      if (signal?.aborted) return;
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if ((await stat(full)).isDirectory()) await recur(full);
      else if (entry.endsWith(".md")) {
        out.push(relative(root, full).split(sep).join("/"));
        onFound?.(out.length);
      }
    }
  };
  await recur(root);
  return out;
}
