import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Store } from "./store/store.js";
import { mintId } from "./ids.js";
import { ingestFile } from "./ingest.js";

// omg attach (07 task 1.4): register a working tree as a repo and ingest every
// Markdown file. Paths stored repo-relative, canonical (no leading slash,
// forward slashes).

export interface AttachResult {
  repoId: string;
  slug: string;
  fileCount: number;
  blockCount: number;
  /** true iff every ingested file converged (file_hash == rendered_hash). */
  allConverged: boolean;
}

function canonicalPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

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

/** Create (or reuse) a repo row for `slug`, returning its id. A repo owns
 *  identity + history, NOT a filesystem (ADR-014): when `rootPath` is given it is
 *  registered as an `fs` source + attachment (the durable "where its bytes come
 *  from"), not stored on the repo. Pass null for a sourceless/headless repo. */
export function ensureRepo(store: Store, slug: string, rootPath: string | null = null): string {
  const existing = store.db.prepare("SELECT repo_id FROM repos WHERE slug = ?").get(slug) as
    | { repo_id: string }
    | undefined;
  if (existing) return existing.repo_id;
  const repoId = mintId("rp");
  store.db.prepare("INSERT INTO repos (repo_id, slug) VALUES (?, ?)").run(repoId, slug);
  if (rootPath) registerFsSource(store, repoId, slug, rootPath);
  return repoId;
}

/** Register (idempotently) an `fs` source at `root` and attach it to a repo.
 *  Inline raw SQL — kept here rather than calling sync/sources to avoid a
 *  core→sync import cycle; the source shape matches sync/sources exactly. */
function registerFsSource(store: Store, repoId: string, slug: string, root: string): void {
  const db = store.db;
  db.prepare("INSERT OR IGNORE INTO adapters (name, command, args) VALUES ('fs', 'omgbase-fs-adapter', '[]')").run();
  const name = `${slug}-fs`;
  let source = db.prepare("SELECT source_id FROM sources WHERE name = ?").get(name) as { source_id: string } | undefined;
  if (!source) {
    const sourceId = mintId("src");
    db.prepare("INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?, ?, 'fs', ?, '{}')").run(sourceId, name, JSON.stringify({ root }));
    source = { source_id: sourceId };
  }
  db.prepare("INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?, ?)").run(repoId, source.source_id);
}

/** Attach a directory: create repo + ingest all Markdown files. */
export function attachDirectory(store: Store, slug: string, rootPath: string): AttachResult {
  const repoId = ensureRepo(store, slug, rootPath);
  const files = walkMarkdown(rootPath);
  let blockCount = 0;
  let allConverged = true;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const result = ingestFile(store, repoId, canonicalPath(rootPath, file), content);
    blockCount += result.blockCount;
    if (!result.converged) allConverged = false;
  }
  return { repoId, slug, fileCount: files.length, blockCount, allConverged };
}
