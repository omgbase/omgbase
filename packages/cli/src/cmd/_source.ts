import { execPath } from "node:process";
import { createExternalSource, type SyncSource } from "@omgbase/core";
import { fsAdapterBinPath } from "@omgbase/fs-adapter";
import type { Cli } from "../context.js";

// Resolve a repo's live sync source(s) for `omg watch`/`omg mcp` (sync-plugins).
// v1: a filesystem repo (one with a root_path) is served by spawning the
// @omgbase/fs-adapter process — chokidar lives there, not in the engine. The
// adapter/source/attachment tables (schema v9) will drive multi-source repos in
// a follow-up; today we synthesize the fs source from the repo's root_path so
// the existing single-fs-repo UX is unchanged while the transport is external.

/** Build the live filesystem SyncSource for a repo, or null if it has no root. */
export async function openFsSource(repo: { rootPath: string | null }): Promise<SyncSource | null> {
  if (!repo.rootPath) return null;
  // Spawn `node <fs-adapter/bin.js> --root <path>` so we don't need a global
  // install of the adapter binary; execPath is the current node.
  return createExternalSource({
    command: execPath,
    args: [fsAdapterBinPath(), "--root", repo.rootPath],
  });
}

/** Convenience: log which source is serving a repo (stderr; stdout is protocol on mcp). */
export function describeSource(cli: Cli, repo: { slug: string; rootPath: string | null }): void {
  if (repo.rootPath) cli.io.err(cli.style.dim(`  source: filesystem via omgbase-fs-adapter (${repo.rootPath})`));
  else cli.io.err(cli.style.dim(`  source: none (sourceless repo — sync is a no-op)`));
}
