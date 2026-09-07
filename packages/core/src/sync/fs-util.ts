import { readdirSync, statSync } from "node:fs";
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
