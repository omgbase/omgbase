import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";

// Full-featured attach (sync/): like core attachDirectory but routes every file
// through the reconciling resolver, so identity threads AND edges are extracted
// on the initial walk. core/attach stays the resolver-less primitive; this is
// the one the CLI/engine should use.

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".omgbase" || entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

export interface AttachResult {
  repoId: string;
  fileCount: number;
  allConverged: boolean;
}

export function attachRepo(store: Store, slug: string, rootPath: string): AttachResult {
  const repoId = ensureRepo(store, slug, rootPath);
  const files = walkMarkdown(rootPath);
  const ts = new Date().toISOString();
  let allConverged = true;
  for (const file of files) {
    const rel = relative(rootPath, file).split(sep).join("/");
    const content = readFileSync(file, "utf8");
    const res = ingestFile(store, repoId, rel, content, { ts, resolveIds: makeReconcilingResolver(store, repoId, { ts }) });
    if (!res.converged) allConverged = false;
  }
  return { repoId, fileCount: files.length, allConverged };
}
