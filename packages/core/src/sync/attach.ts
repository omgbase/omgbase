import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { walkMarkdown } from "./fs-util.js";

// In-process filesystem attach (sync/). Routes every file through the
// reconciling resolver so identity threads AND edges are extracted on the
// initial walk. This is the synchronous one-shot ingest fast-path used by the
// CLI (omg init/attach) and tests; live watching goes through the external
// adapter seam (13-sync-plugins). core/attach stays the resolver-less primitive.

export interface AttachResult {
  repoId: string;
  fileCount: number;
  allConverged: boolean;
}

/** Attach a filesystem directory as a repo: create it + ingest all Markdown. */
export function attachRepo(store: Store, slug: string, rootPath: string): AttachResult {
  const repoId = ensureRepo(store, slug, rootPath);
  const files = walkMarkdown(rootPath);
  const ts = new Date().toISOString();
  let allConverged = true;
  for (const rel of files) {
    const content = readFileSync(join(rootPath, rel), "utf8");
    const res = ingestFile(store, repoId, rel, content, {
      ts,
      resolveIds: makeReconcilingResolver(store, repoId, { ts, path: rel }),
    });
    if (!res.converged) allConverged = false;
  }
  return { repoId, fileCount: files.length, allConverged };
}
