import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { findDoc, findDocByRef } from "../core/read/reader.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import { newCommit } from "../core/store/writers.js";
import { ftsDeleteDoc } from "../core/store/fts.js";
import { adoptPhantoms, rebuildDocEdges } from "../core/store/edges.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { inboundLinksTo, retargetLinksInRaw, type InboundLink } from "../graph/inbound-links.js";
import { apply, type Op } from "./apply.js";
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

export interface DocMoveOptions {
  /**
   * Also rewrite the inbound links that named the OLD path so they point at the
   * new one — a destination-aware rewrite (anchors, link text, titles, and code
   * spans preserved; absolute/relative style kept) applied as a CAS-checked
   * `update` per source block in one follow-up api changeset. Frontmatter-level
   * relations are not rewritten (reported in `dangling`).
   */
  retargetInbound?: boolean;
}

export interface DocMoveResult extends DocOpResult {
  /**
   * Inbound links still pointing at the OLD path after this call — the source
   * blocks `links_stale` will now report (empty when `retargetInbound` rewrote
   * them all). Computed from the open edge index before the move.
   */
  dangling: InboundLink[];
  /** With `retargetInbound`: the source blocks rewritten and the docs re-ingested. */
  retargeted: { blocks: string[]; docs: string[] } | null;
}

function dirOf(path: string): string {
  return path.replace(/[^/]*$/, "");
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

/**
 * docs_move: rename a document to a new path (identity preserved). The edge
 * index follows the path, not the identity: links written against the OLD path
 * now dangle (their open edges are re-pointed at `phantom:<old>`, exactly what
 * re-extracting the source would produce, so `links_stale` sees them), and
 * phantom edges already written against the NEW path are adopted. The result
 * lists the dangling inbound links; `retargetInbound` rewrites them.
 */
export function docsMove(store: Store, ctx: DocOpContext, docRef: string, toPath: string, opts: DocMoveOptions = {}): DocMoveResult {
  const info = findDocByRef(store, ctx.repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `no document ${docRef}`);
  const toRel = canonical(toPath);
  if (findDoc(store, { repoId: ctx.repoId, path: toRel })) throw new MutationError("path_taken", `a document already exists at ${toRel}`);

  // Who links here BY PATH, as written — before the path changes.
  const inbound = inboundLinksTo(store, ctx.repoId, info.docId, info.path);

  const docStore = resolveDocStore(ctx);
  const moved = underLock(ctx, () => {
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

      // Edge index. Every open edge from ANOTHER doc into this one resolved
      // via the old path, so it dangles now → re-point it at the old path's
      // phantom (in place, mirroring adoptPhantoms). A self-doc edge dangles
      // only when the link names the path (`[x](/old.md#H)`); a pure fragment
      // (`#H`) resolves to the doc regardless of path and is left alone — the
      // inbound scan distinguishes them from the raw.
      const phantom = `phantom:${info.path}`;
      const affected = new Set<string>();
      const others = db.prepare("SELECT DISTINCT src_doc FROM edges WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").all(info.docId, info.docId) as { src_doc: string }[];
      for (const r of others) affected.add(r.src_doc);
      db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").run(phantom, info.docId, info.docId);
      const selfEdge = db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc = ? AND src_block = ? AND anchor IS ?");
      for (const l of inbound) {
        if (l.doc !== info.docId || l.block === null) continue;
        selfEdge.run(phantom, info.docId, info.docId, l.block, l.anchor);
        affected.add(info.docId);
      }
      for (const d of affected) rebuildDocEdges(db, d);
      // Links already written against the NEW path resolve to this doc now.
      adoptPhantoms(db, toRel, info.docId);
    });
    if (ctx.omgbaseDir) {
      docStore.clearStat(store, ctx.repoId, info.path); // drop the old path's row
      docStore.recordStat(store, ctx.repoId, toRel, content);
    }
    return { docId: info.docId, path: toRel, committed: true };
  });

  if (!opts.retargetInbound || inbound.length === 0) return { ...moved, dangling: inbound, retargeted: null };

  // Rewrite the dangling links block by block (one coalesced update per block,
  // CAS on the block's current hash) and apply as one changeset; the re-ingest
  // re-extracts each source doc, whose links now resolve to the moved doc.
  const byBlock = new Map<string, InboundLink>();
  for (const l of inbound) if (l.block !== null && !byBlock.has(l.block)) byBlock.set(l.block, l);
  // A container's raw includes its children's raw, so a link inside a list item
  // is reported for BOTH the list and the item. Rewrite the deepest block only:
  // updating the container would re-parse (and re-identify) its children, and
  // the child's update alone already changes the container's rendered raw.
  const parentOf = store.db.prepare("SELECT parent_block FROM blocks WHERE block_id = ? AND deleted_commit IS NULL");
  const containers = new Set<string>();
  for (const blockId of byBlock.keys()) {
    let cur: string | null = blockId;
    while (cur) {
      const row = parentOf.get(cur) as { parent_block: string | null } | undefined;
      cur = row?.parent_block ?? null;
      if (cur && byBlock.has(cur)) containers.add(cur);
    }
  }
  for (const c of containers) byBlock.delete(c);
  const ops: Op[] = [];
  const blocks: string[] = [];
  const docs = new Set<string>();
  const readBlock = store.db.prepare("SELECT bl.raw_hash, b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.block_id = ? AND bl.deleted_commit IS NULL");
  for (const [blockId, src] of byBlock) {
    const row = readBlock.get(blockId) as { raw_hash: Buffer; bytes: Buffer } | undefined;
    if (!row) continue;
    // Match against the directory the link was RESOLVED in (the source's path at
    // extraction time); write relative forms against the source's CURRENT
    // directory — they differ only for links inside the moved doc itself.
    const writeDir = src.doc === info.docId ? dirOf(toRel) : dirOf(src.path);
    const newRaw = retargetLinksInRaw(row.bytes.toString("utf8"), dirOf(src.path), writeDir, info.path, toRel);
    if (newRaw === null) continue;
    ops.push({ op: "update", block: blockId, markdown: newRaw, expect: { content_hash: row.raw_hash.toString("hex") } });
    blocks.push(blockId);
    docs.add(src.doc);
  }
  if (ops.length > 0) {
    apply(store, {
      repoId: ctx.repoId,
      ...(ctx.rootPath ? { rootPath: ctx.rootPath } : {}),
      ...(ctx.docStore ? { docStore: ctx.docStore } : {}),
      ...(ctx.omgbaseDir ? { omgbaseDir: ctx.omgbaseDir } : {}),
      ops,
      origin: { actor: ctx.actor ?? "api", reason: `retarget inbound links ${info.path} -> ${toRel}` },
    });
  }
  // Containers whose rewritten child covered them count as rewritten too.
  const rewritten = new Set([...blocks, ...containers]);
  const dangling = inbound.filter((l) => l.block === null || !rewritten.has(l.block));
  return { ...moved, dangling, retargeted: { blocks, docs: [...docs] } };
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
