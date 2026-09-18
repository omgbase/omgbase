import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { findDoc, findDocByRef } from "../core/read/reader.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import { newCommit } from "../core/store/writers.js";
import { ftsDeleteDoc } from "../core/store/fts.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { MutationError } from "./tree.js";

// Document-level operations (06 §API: docs_create/move/delete/set_meta; 11 §5.6
// new/mv/rm --doc/meta). These live in the library so both the CLI and the MCP
// server share one implementation (§1: the CLI holds no business logic). Each
// follows apply()'s file-first protocol: write bytes to disk, then ingest the
// rendered bytes as the commit — under the workspace writer flock when a
// workspace dir is given.

export interface DocOpContext {
  repoId: string;
  /** Working-tree root for the default filesystem write target. Omit only when
   *  supplying an explicit `docStore` (e.g. a headless NullDocStore). */
  rootPath?: string;
  /** Write target (ADR-014 §5); defaults to a filesystem store at `rootPath`. */
  docStore?: DocStore;
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

  const docStore = resolveDocStore(ctx);
  return underLock(ctx, () => {
    if (docStore.exists(rel)) throw new MutationError("path_taken", `file already exists on disk at ${rel}`);
    docStore.write(rel, content);
    const ts = new Date().toISOString();
    const res = ingestFile(store, ctx.repoId, rel, content, { ts, origin: "import", resolveIds: makeReconcilingResolver(store, ctx.repoId, { ts, path: rel }) });
    if (ctx.omgbaseDir) docStore.recordStat(store, ctx.repoId, rel, content);
    return { docId: res.docId, path: rel, committed: true };
  });
}

/** docs_move: rename a document to a new path (identity preserved). */
export function docsMove(store: Store, ctx: DocOpContext, docRef: string, toPath: string): DocOpResult {
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);
  const toRel = canonical(toPath);
  if (findDoc(store, { repoId: ctx.repoId, path: toRel })) throw new MutationError("path_taken", `a document already exists at ${toRel}`);

  const docStore = resolveDocStore(ctx);
  return underLock(ctx, () => {
    if (docStore.exists(toRel)) throw new MutationError("path_taken", `file already exists on disk at ${toRel}`);
    const content = docStore.read(info.path) ?? "";
    if (docStore.exists(info.path)) docStore.rename(info.path, toRel);
    else docStore.write(toRel, content);

    const ts = new Date().toISOString();
    store.write((db) => {
      // Update the document row's path + its open revisions' path pointer, and
      // record an api commit noting the move.
      const commit = newCommit(db, { repoId: ctx.repoId, ts, origin: "api", actor: ctx.actor ?? null, reason: `move ${info.path} -> ${toRel}` });
      db.prepare("UPDATE docs SET path = ? WHERE doc_id = ?").run(toRel, info.docId);
      db.prepare("UPDATE revisions SET path = ? WHERE doc_id = ? AND rev_id = ?").run(toRel, info.docId, info.currentRev);
      void commit;
    });
    if (ctx.omgbaseDir) {
      docStore.clearStat(store, ctx.repoId, info.path); // drop the old path's row
      docStore.recordStat(store, ctx.repoId, toRel, content);
    }
    return { docId: info.docId, path: toRel, committed: true };
  });
}

/** docs_delete: mark a document deleted and remove its file (resurrection-poolable). */
export function docsDelete(store: Store, ctx: DocOpContext, docRef: string): DocOpResult {
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  const docStore = resolveDocStore(ctx);
  return underLock(ctx, () => {
    const ts = new Date().toISOString();
    store.write((db) => {
      const commit = newCommit(db, { repoId: ctx.repoId, ts, origin: "api", actor: ctx.actor ?? null, reason: `delete ${info.path}` });
      // Tombstone the document and its live blocks; FTS rows drop with the blocks.
      ftsDeleteDoc(db, info.docId);
      db.prepare("UPDATE blocks SET deleted_commit = ? WHERE doc_id = ? AND deleted_commit IS NULL").run(commit.commitId, info.docId);
      db.prepare("UPDATE docs SET deleted_commit = ? WHERE doc_id = ?").run(commit.commitId, info.docId);
    });
    docStore.remove(info.path);
    if (ctx.omgbaseDir) docStore.clearStat(store, ctx.repoId, info.path);
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
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);

  const docStore = resolveDocStore(ctx);
  return underLock(ctx, () => {
    const original = docStore.read(info.path) ?? "";
    const { frontmatter, body } = splitFrontmatter(original);
    const merged: Record<string, unknown> = { ...frontmatter, ...(patch.set ?? {}) };
    for (const k of patch.unset ?? []) delete merged[k];
    const content = composeFile(body, merged);

    docStore.write(info.path, content);
    const ts = new Date().toISOString();
    const res = ingestFile(store, ctx.repoId, info.path, content, { ts, origin: "import", resolveIds: makeReconcilingResolver(store, ctx.repoId, { ts, path: info.path }) });
    if (ctx.omgbaseDir) docStore.recordStat(store, ctx.repoId, info.path, content);
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
