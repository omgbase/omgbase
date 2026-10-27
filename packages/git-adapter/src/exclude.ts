import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// The user's own repository is never touched — except for ONE line in its
// `.git/info/exclude` (never `.gitignore`, a tracked file): `.omgbase/`, so the
// engine's bare repository and database are not offered to the user's `git
// add`. A worktree's `.git` is a FILE (`gitdir: <path>`); the exclude file
// then lives under the pointed-to directory (a worktree's `info/` is the common
// dir's; `git rev-parse --git-path info/exclude` would say the same, but no git
// is spawned on the user's repository).

export const EXCLUDE_LINE = ".omgbase/";

/** The `.git/info/exclude` path of a repository rooted at `root`, or null when `root/.git` does not exist. */
export function excludeFileFor(root: string): string | null {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(root, m[1]!.trim());
    // A linked worktree's gitdir is `<common>/worktrees/<name>`; `info/` is the common dir's.
    const common = join(gitDir, "commondir");
    if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
  }
  return join(gitDir, "info", "exclude");
}

/** Ensure `.omgbase/` is listed in the user's `.git/info/exclude`; returns what was done. */
export function ensureExcluded(root: string): "absent" | "present" | "added" {
  const file = excludeFileFor(root);
  if (file === null) return "absent";
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === EXCLUDE_LINE || l.trim() === ".omgbase")) return "present";
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
  return "added";
}
