import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Shared filesystem walk for the in-process one-shot/reconcile paths (attach,
// checkpoint, freshness). This is NOT the live watcher — chokidar lives only in
// the external @omgbase/fs-adapter (13-sync-plugins). node:fs (a builtin) reads
// are retained here for the one-shot ingest/freshness fast-path.

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
