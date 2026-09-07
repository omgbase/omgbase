import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import type { SyncSource, SourceCapabilities, SourceEntry, SourceItem, SourceWatch, WatchOptions } from "./plugin.js";

// Filesystem sync source (13-sync-plugins §7). The one place node:fs lives for
// the sync layer: enumerate = walk the tree for *.md, fetch = read+stat, watch =
// chokidar debounced to quiescence, write/remove = the file-first write
// protocol. Its cheap change-token (`revision`) is "mtime_ns:size" — a stat, no
// read — which is the filesystem's private implementation of the §3.1 revision
// comparison (the file_stats cache in freshness.ts is the durable form).

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

function revisionOf(abs: string): string {
  const st = statSync(abs, { bigint: true });
  return `${st.mtimeNs}:${st.size}`;
}

export class FilesystemSource implements SyncSource {
  constructor(private rootPath: string) {}

  capabilities(): SourceCapabilities {
    return { identity: "inferred", writeThrough: true };
  }

  *enumerate(): Iterable<SourceEntry> {
    for (const path of walkMarkdown(this.rootPath)) {
      yield { path, revision: revisionOf(join(this.rootPath, path)) };
    }
  }

  fetch(path: string): SourceItem | null {
    const abs = join(this.rootPath, path);
    if (!existsSync(abs)) return null;
    return { path, revision: revisionOf(abs), content: readFileSync(abs, "utf8") };
  }

  watch(opts: WatchOptions): SourceWatch {
    const debounceMs = opts.debounceMs ?? 750;
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;

    // Pull and clear the pending set (no delivery). Both the timer and a manual
    // flush use this; only the timer forwards to onBatch, so flush() can hand
    // the paths back to the caller without a double delivery.
    const drain = (): string[] => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending.size === 0) return [];
      const paths = [...pending];
      pending.clear();
      return paths;
    };
    const deliver = (): void => {
      const paths = drain();
      if (paths.length > 0) opts.onBatch(paths);
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(deliver, debounceMs);
    };

    const watcher: FSWatcher = chokidar.watch(this.rootPath, {
      ignored: (p: string) => /(^|[/\\])(\.omgbase|\.git|node_modules)([/\\]|$)/.test(p),
      ignoreInitial: true,
      persistent: true,
    });
    const onEvent = (abs: string): void => {
      if (!abs.endsWith(".md")) return;
      pending.add(relative(this.rootPath, abs).split(sep).join("/"));
      schedule();
    };
    watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);

    return {
      flush: drain,
      async stop() {
        if (timer) { clearTimeout(timer); timer = null; }
        await watcher.close();
      },
    };
  }

  write(path: string, content: string): void {
    const abs = join(this.rootPath, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  remove(path: string): void {
    const abs = join(this.rootPath, path);
    rmSync(abs, { force: true });
  }
}
