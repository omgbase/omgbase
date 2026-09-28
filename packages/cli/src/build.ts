import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, type HostInfo } from "@omgbase/core";

// What this binary knows about itself (spec/cli §2.5 `--version`, §6 `version`):
// its package version and the build's git revision + time.

/**
 * `--version` prints THIS package's version (spec/cli §2.5), read from the
 * nearest `package.json` named `omgbase` above the running module (the source
 * tree and the built `dist/src/` sit at different depths). The engine's own
 * `VERSION` is the fallback only if the package file cannot be found.
 */
export function cliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "omgbase" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return VERSION;
    dir = parent;
  }
}

export interface BuildInfo {
  commit: string | null;
  built: string | null;
}

/**
 * `dist/build-info.json`, written by `pnpm build` (`scripts/build-info.mjs`):
 * `{ commit: "<short sha>" | null, built: "<RFC 3339>" }`. It sits one level
 * above this module's directory (`dist/src/` → `dist/`), so a source-tree run
 * (vitest over `src/`) looks for `packages/cli/build-info.json`, finds nothing,
 * and reports nulls — the same answer a build outside a git checkout gives.
 */
export function buildInfo(): BuildInfo {
  const path = new URL("../build-info.json", import.meta.url);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { commit?: unknown; built?: unknown };
    return {
      commit: typeof raw.commit === "string" ? raw.commit : null,
      built: typeof raw.built === "string" ? raw.built : null,
    };
  } catch {
    return { commit: null, built: null };
  }
}

/** The `HostInfo` this binary hands the engine's `version` tool (`omg mcp`) and verb (`omg version`). */
export function hostInfo(): HostInfo {
  const { commit, built } = buildInfo();
  return { version: cliVersion(), commit, built, resolveFrom: import.meta.url };
}
