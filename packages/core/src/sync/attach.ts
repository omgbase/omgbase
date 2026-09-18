import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { walkMarkdown } from "./fs-util.js";

// ingestDirectory: the reconciling one-shot walk that ingests a directory's
// Markdown into a repo, threading block identity AND extracting edges on the
// initial pass (every file routes through the reconciling resolver). It is a
// library/test convenience — the live paths reconcile through the single
// `observeOne` primitive (freshness sweep / watcher / the `observe` MCP tool),
// and the CLI's `omg source add` uses the freshness sweep. `core/attach.ts` holds
// the resolver-less repo-identity primitive (`ensureRepo`).

export interface IngestDirResult {
  repoId: string;
  fileCount: number;
  allConverged: boolean;
}

/**
 * Ingest a directory as a repo: create/reuse the repo (registering its fs
 * source) + ingest all Markdown, reconciling identity and extracting edges.
 * `files` (repo-relative paths) may be supplied by a caller that already walked
 * the tree, to avoid walking twice; omit it to walk here.
 */
export function ingestDirectory(store: Store, slug: string, rootPath: string, files?: string[]): IngestDirResult {
  const repoId = ensureRepo(store, slug, rootPath);
  const walked = files ?? walkMarkdown(rootPath);
  const ts = new Date().toISOString();
  let allConverged = true;
  for (const rel of walked) {
    const content = readFileSync(join(rootPath, rel), "utf8");
    const res = ingestFile(store, repoId, rel, content, {
      ts,
      resolveIds: makeReconcilingResolver(store, repoId, { ts, path: rel }),
    });
    if (!res.converged) allConverged = false;
  }
  return { repoId, fileCount: walked.length, allConverged };
}
