import { writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { findDoc } from "../core/read/reader.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import { newCommit } from "../core/store/writers.js";
import { ftsDeleteDoc } from "../core/store/fts.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { recordFileStat } from "../sync/freshness.js";
import { MutationError } from "./tree.js";

// Document-level operations (06 §API: docs_create/move/delete/set_meta; 11 §5.6
// new/mv/rm --doc/meta). These live in the library so both the CLI and the MCP
// server share one implementation (§1: the CLI holds no business logic). Each
// follows apply()'s file-first protocol: write bytes to disk, then ingest the
// rendered bytes as the commit — under the workspace writer flock when a
// workspace dir is given.

export interface DocOpContext {
  repoId: string;
  rootPath: string;
  /** workspace .omgbase/ dir; when set, the write runs under the writer flock. */
  omgbaseDir?: string;
  actor?: string;
}

export interface DocOpResult {
  docId: string;
  path: string;
  committed: boolean;
}

function underLock<T>(ctx: DocOpContext, fn: () => T): T {
  return ctx.omgbaseDir ? withWriterLock(ctx.omgbaseDir, fn) : fn();
}

function canonical(path: string): string {
  return path.replace(/^\/+/, "").split("\\").join("/");
}

// Compose a full document's bytes from optional frontmatter + body markdown.
function composeFile(markdown: string, frontmatter?: Record<string, unknown>): string {
  const body = markdown.endsWith("\n") || markdown.length === 0 ? markdown : markdown + "\n";
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYaml(frontmatter).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

/** docs_create: create a new document from complete file bytes (frontmatter incl.). */
export function docsCreate(store: Store, ctx: DocOpContext, path: string, markdown: string, frontmatter?: Record<string, unknown>): DocOpResult {
  const rel = canonical(path);
  const existing = findDoc(store, { repoId: ctx.repoId, path: rel });
  if (existing) throw new MutationError("path_taken", `document already exists at ${rel}`);
  const content = composeFile(markdown, frontmatter);

  return underLock(ctx, () => {
    const abs = join(ctx.rootPath, rel);
    if (existsSync(abs)) throw new MutationError("path_taken", `file already exists on disk at ${rel}`);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.omgtmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
    const ts = new Date().toISOString();
    const res = ingestFile(store, ctx.repoId, rel, content, { ts, origin: "import", resolveIds: makeReconcilingResolver(store, ctx.repoId, { ts }) });
    if (ctx.omgbaseDir) recordFileStat(store, ctx.repoId, rel, abs, sha256(content));
    return { docId: res.docId, path: rel, committed: true };
  });
}

/** docs_move: rename a document to a new path (identity preserved). */
export function docsMove(store: Store, ctx: DocOpContext, docRef: string, toPath: string): DocOpResult {
  const info = findDoc(store, docRef.startsWith("d_") ? { docId: docRef } : { repoId: ctx.repoId, path: docRef });
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);
  const toRel = canonical(toPath);
  if (findDoc(store, { repoId: ctx.repoId, path: toRel })) throw new MutationError("path_taken", `a document already exists at ${toRel}`);

  return underLock(ctx, () => {
    const fromAbs = join(ctx.rootPath, info.path);
    const toAbs = join(ctx.rootPath, toRel);
    if (existsSync(toAbs)) throw new MutationError("path_taken", `file already exists on disk at ${toRel}`);
    const content = existsSync(fromAbs) ? readFileSync(fromAbs, "utf8") : "";
    mkdirSync(dirname(toAbs), { recursive: true });
    if (existsSync(fromAbs)) renameSync(fromAbs, toAbs);
    else writeFileSync(toAbs, content);

    const ts = new Date().toISOString();
    store.write((db) => {
      // Update the document row's path + its open revisions' path pointer, and
      // record an api commit noting the move.
      const commit = newCommit(db, { repoId: ctx.repoId, ts, origin: "api", actor: ctx.actor ?? null, reason: `move ${info.path} -> ${toRel}` });
      db.prepare("UPDATE documents SET path = ? WHERE doc_id = ?").run(toRel, info.docId);
      db.prepare("UPDATE revisions SET path = ? WHERE doc_id = ? AND rev_id = ?").run(toRel, info.docId, info.currentRev);
      void commit;
    });
    if (ctx.omgbaseDir) {
      recordFileStat(store, ctx.repoId, info.path, fromAbs, sha256("")); // clears the old row
      recordFileStat(store, ctx.repoId, toRel, toAbs, sha256(content));
    }
    return { docId: info.docId, path: toRel, committed: true };
  });
}

/** docs_delete: mark a document deleted and remove its file (resurrection-poolable). */
export function docsDelete(store: Store, ctx: DocOpContext, docRef: string): DocOpResult {
  const info = findDoc(store, docRef.startsWith("d_") ? { docId: docRef } : { repoId: ctx.repoId, path: docRef });
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  return underLock(ctx, () => {
    const abs = join(ctx.rootPath, info.path);
    const ts = new Date().toISOString();
    store.write((db) => {
      const commit = newCommit(db, { repoId: ctx.repoId, ts, origin: "api", actor: ctx.actor ?? null, reason: `delete ${info.path}` });
      // Tombstone the document and its live blocks; FTS rows drop with the blocks.
      ftsDeleteDoc(db, info.docId);
      db.prepare("UPDATE blocks SET deleted_commit = ? WHERE doc_id = ? AND deleted_commit IS NULL").run(commit.commitId, info.docId);
      db.prepare("UPDATE documents SET deleted_commit = ? WHERE doc_id = ?").run(commit.commitId, info.docId);
    });
    if (existsSync(abs)) unlinkSync(abs);
    if (ctx.omgbaseDir) store.db.prepare("DELETE FROM file_stats WHERE repo_id = ? AND path = ?").run(ctx.repoId, info.path);
    return { docId: info.docId, path: info.path, committed: true };
  });
}

/** docs_set_meta: surgical frontmatter patch (set/unset keys), re-ingested. */
export function docsSetMeta(
  store: Store,
  ctx: DocOpContext,
  docRef: string,
  patch: { set?: Record<string, unknown>; unset?: string[] },
): DocOpResult {
  const info = findDoc(store, docRef.startsWith("d_") ? { docId: docRef } : { repoId: ctx.repoId, path: docRef });
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  return underLock(ctx, () => {
    const abs = join(ctx.rootPath, info.path);
    const original = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const { frontmatter, body } = splitFrontmatter(original);
    const merged: Record<string, unknown> = { ...frontmatter, ...(patch.set ?? {}) };
    for (const k of patch.unset ?? []) delete merged[k];
    const content = composeFile(body, merged);

    const tmp = `${abs}.omgtmp`;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
    const ts = new Date().toISOString();
    const res = ingestFile(store, ctx.repoId, info.path, content, { ts, origin: "import", resolveIds: makeReconcilingResolver(store, ctx.repoId, { ts }) });
    if (ctx.omgbaseDir) recordFileStat(store, ctx.repoId, info.path, abs, sha256(content));
    return { docId: res.docId, path: info.path, committed: true };
  });
}

// Split a file's bytes into (frontmatter object, body markdown). Missing or
// malformed frontmatter yields an empty object and the whole content as body.
function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
  } catch {
    /* malformed → empty */
  }
  return { frontmatter: fm, body: content.slice(m[0].length) };
}
