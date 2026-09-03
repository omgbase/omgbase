import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import { loadMutDoc } from "./load.js";
import { renderDoc, MutationError, type MutDoc, type MutBlock } from "./tree.js";
import { opInsert, opUpdate, opMove, opRemove, opSplit, opMerge, type To, type Expect } from "./ops.js";

// Changeset application (04 §2, §6). Ops apply in order across documents; later
// ops see earlier effects; minted ids are referenceable via "$n.ids[i]"
// placeholders. Atomic: all ops apply or none (validation throws before any
// file write). dry_run returns rendered diffs without committing.

export type Op =
  | { op: "insert"; doc?: string; to: To; markdown: string }
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: Expect }
  | { op: "move"; blocks: string[]; to: To }
  | { op: "remove"; blocks: string[]; expect?: Record<string, Expect> }
  | { op: "split"; block: string; at: number[]; expect?: Expect }
  | { op: "merge"; blocks: string[]; separator?: string; expect?: Record<string, Expect> };

export interface ApplyRequest {
  repoId: string;
  rootPath: string;
  ops: Op[];
  origin: { actor: string; reason?: string };
  dryRun?: boolean;
}

export interface OpResult {
  ids: string[];
}

export interface ApplyResult {
  results: OpResult[];
  revisions: { doc: string; path: string }[];
  diffs?: Record<string, { before: string; after: string }>;
  committed: boolean;
}

// Resolve "$n.ids[i]" placeholders in a string against prior op results.
function resolvePlaceholder(value: string, results: OpResult[]): string {
  const m = /^\$(\d+)\.ids\[(\d+)\]$/.exec(value);
  if (!m) return value;
  const opIdx = Number(m[1]);
  const idIdx = Number(m[2]);
  const id = results[opIdx]?.ids[idIdx];
  if (!id) throw new MutationError("target_missing", `placeholder ${value} did not resolve`);
  return id;
}

function resolveTo(to: To, results: OpResult[]): To {
  const parent =
    typeof to.parent === "string" ? resolvePlaceholder(to.parent, results) : to.parent;
  let at = to.at;
  if (typeof at === "object") {
    if ("before" in at) at = { before: resolvePlaceholder(at.before, results) };
    else if ("after" in at) at = { after: resolvePlaceholder(at.after, results) };
  }
  return { parent, at };
}

// Which doc a given block id lives in (searches loaded docs; falls back to store).
function docIdForBlock(store: Store, repoId: string, blockId: string): string | null {
  const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { doc_id: string } | undefined;
  return row?.doc_id ?? null;
}

export function apply(store: Store, req: ApplyRequest): ApplyResult {
  const { store: _s } = { store }; void _s;
  // Load all docs that ops touch into memory; apply ops in order.
  const loaded = new Map<string, MutDoc>();
  const before = new Map<string, string>();
  const results: OpResult[] = [];

  const ensureDoc = (docId: string): MutDoc => {
    let d = loaded.get(docId);
    if (!d) {
      const md = loadMutDoc(store.db, docId);
      if (!md) throw new MutationError("doc_missing", `doc ${docId} not found`);
      d = md;
      loaded.set(docId, d);
      before.set(docId, renderDoc(d));
    }
    return d;
  };

  req.ops.forEach((rawOp, i) => {
    switch (rawOp.op) {
      case "insert": {
        const to = resolveTo(rawOp.to, results);
        const docId = rawOp.doc ?? parentDoc(store, req.repoId, to, loaded);
        const d = ensureDoc(docId);
        results.push(opInsert(d, to, rawOp.markdown));
        break;
      }
      case "update": {
        const block = resolvePlaceholder(rawOp.block, results);
        const docId = docIdForBlockLoaded(loaded, block) ?? docIdForBlock(store, req.repoId, block);
        if (!docId) throw new MutationError("block_missing", `block ${block} not found`, { op_index: i });
        results.push(opUpdate(ensureDoc(docId), block, i, rawOp.markdown, rawOp.attrs, rawOp.expect));
        break;
      }
      case "move": {
        const blocks = rawOp.blocks.map((b) => resolvePlaceholder(b, results));
        const to = resolveTo(rawOp.to, results);
        const srcDocId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, req.repoId, blocks[0]!);
        if (!srcDocId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        // {doc:true} with a non-anchor `at` (start/end) means the source doc's
        // top level; otherwise infer the destination doc from the target.
        const topLevelSameDoc = typeof to.parent === "object" && "doc" in to.parent && typeof to.at === "string";
        const dstDocId = topLevelSameDoc ? srcDocId : parentDoc(store, req.repoId, to, loaded);
        if (dstDocId === srcDocId) {
          results.push(opMove(ensureDoc(srcDocId), blocks, to, i));
        } else {
          // Cross-document move (04 §1): extract from source, insert into target.
          results.push(crossDocMove(ensureDoc(srcDocId), ensureDoc(dstDocId), blocks, to, i));
        }
        break;
      }
      case "remove": {
        const blocks = rawOp.blocks.map((b) => resolvePlaceholder(b, results));
        const docId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, req.repoId, blocks[0]!);
        if (!docId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        results.push(opRemove(ensureDoc(docId), blocks, i, rawOp.expect));
        break;
      }
      case "split": {
        const block = resolvePlaceholder(rawOp.block, results);
        const docId = docIdForBlockLoaded(loaded, block) ?? docIdForBlock(store, req.repoId, block);
        if (!docId) throw new MutationError("block_missing", `block ${block} not found`, { op_index: i });
        results.push(opSplit(ensureDoc(docId), block, rawOp.at, i, rawOp.expect));
        break;
      }
      case "merge": {
        const blocks = rawOp.blocks.map((b) => resolvePlaceholder(b, results));
        const docId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, req.repoId, blocks[0]!);
        if (!docId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        results.push(opMerge(ensureDoc(docId), blocks, i, rawOp.separator, rawOp.expect));
        break;
      }
    }
  });

  const revisions: { doc: string; path: string }[] = [];
  const diffs: Record<string, { before: string; after: string }> = {};
  for (const [docId, d] of loaded) {
    diffs[d.path] = { before: before.get(docId) ?? "", after: renderDoc(d) };
    revisions.push({ doc: docId, path: d.path });
  }

  if (req.dryRun) {
    return { results, revisions, diffs, committed: false };
  }

  // Write each touched file with the file-CAS + atomic-write protocol (04 §6),
  // then re-ingest the rendered bytes as an api-origin commit so identity
  // threads (the ops already assigned ids; reconciliation confirms carries).
  const ts = new Date().toISOString();
  for (const [docId, d] of loaded) {
    const rendered = renderDoc(d);
    const abs = join(req.rootPath, d.path);

    // File-CAS: on-disk bytes must equal the revision we computed against.
    const current = store.db.prepare("SELECT file_hash FROM documents WHERE doc_id = ?").get(docId) as { file_hash: Buffer | null } | undefined;
    if (existsSync(abs) && current?.file_hash) {
      const onDisk = sha256(readFileSync(abs, "utf8"));
      if (!onDisk.equals(current.file_hash)) {
        // A human edit landed first: ingest it, then the caller must retry.
        ingestFile(store, req.repoId, d.path, readFileSync(abs, "utf8"), { ts, resolveIds: makeReconcilingResolver(store, req.repoId, { ts }) });
        throw new MutationError("sync_conflict", `file ${d.path} changed on disk; re-ingested — retry`, { retriable: true });
      }
    }

    // Atomic write: temp file → rename.
    const tmp = `${abs}.omgtmp`;
    writeFileSync(tmp, rendered);
    renameSync(tmp, abs);

    // Commit: ingest the rendered bytes (api origin) with reconciliation.
    ingestFile(store, req.repoId, d.path, rendered, { ts, origin: "import", resolveIds: makeReconcilingResolver(store, req.repoId, { ts }) });
  }

  return { results, revisions, committed: true };
}

function docIdForBlockLoaded(loaded: Map<string, MutDoc>, blockId: string): string | null {
  for (const [docId, d] of loaded) {
    if (findInDoc(d, blockId)) return docId;
  }
  return null;
}
function findInDoc(d: MutDoc, blockId: string): boolean {
  const walk = (list: { id: string; children: never[] }[]): boolean =>
    list.some((b) => b.id === blockId || walk(b.children));
  return walk(d.children as never);
}

// Determine the doc for a placement whose target is a block/heading/doc. When
// parent is {doc:true}, infer the doc from the anchor block in `at`.
function parentDoc(store: Store, repoId: string, to: To, loaded: Map<string, MutDoc>): string {
  if (typeof to.parent === "string") {
    return docIdForBlockLoaded(loaded, to.parent) ?? docIdForBlock(store, repoId, to.parent) ?? throwMissing(to.parent);
  }
  if (typeof to.parent === "object" && "heading" in to.parent) {
    return docIdForBlockLoaded(loaded, to.parent.heading) ?? docIdForBlock(store, repoId, to.parent.heading) ?? throwMissing(to.parent.heading);
  }
  // parent: {doc:true} — infer from the anchor block in `at`.
  if (typeof to.at === "object") {
    const anchor = "before" in to.at ? to.at.before : to.at.after;
    return docIdForBlockLoaded(loaded, anchor) ?? docIdForBlock(store, repoId, anchor) ?? throwMissing(anchor);
  }
  throw new MutationError("target_missing", "insert at top-level start/end requires an explicit doc");
}
function throwMissing(id: string): never {
  throw new MutationError("parent_missing", `parent ${id} not found`);
}

// Cross-document move: extract the contiguous run from src, insert into dst.
function crossDocMove(src: MutDoc, dst: MutDoc, blockIds: string[], to: To, opIndex: number): OpResult {
  // Extract from src (must be a contiguous top-level or same-parent run).
  const moving: MutBlock[] = [];
  for (const id of blockIds) {
    const found = locateMut(src, id);
    if (!found) throw new MutationError("block_missing", `block ${id} not found in source doc`, { op_index: opIndex });
    moving.push(found.block);
  }
  // remove from their source lists
  for (const id of blockIds) {
    const f = locateMut(src, id);
    if (f) f.siblings.splice(f.index, 1);
  }
  // Insert into dst at the resolved target.
  const target = resolveDstTarget(dst, to);
  target.siblings.splice(target.index, 0, ...moving);
  return { ids: blockIds };
}

function locateMut(doc: MutDoc, blockId: string): { block: MutBlock; siblings: MutBlock[]; index: number } | null {
  const search = (list: MutBlock[]): { block: MutBlock; siblings: MutBlock[]; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.id === blockId) return { block: list[i]!, siblings: list, index: i };
      const f = search(list[i]!.children);
      if (f) return f;
    }
    return null;
  };
  return search(doc.children);
}

function resolveDstTarget(dst: MutDoc, to: To): { siblings: MutBlock[]; index: number } {
  if (typeof to.parent === "object" && "doc" in to.parent) {
    return { siblings: dst.children, index: resolveAt(dst.children, to.at) };
  }
  if (typeof to.parent === "string") {
    const f = locateMut(dst, to.parent);
    if (!f) throw new MutationError("parent_missing", `parent ${to.parent} not found in dest`);
    return { siblings: f.block.children, index: resolveAt(f.block.children, to.at) };
  }
  // heading/section: insert into top-level list at the anchor.
  return { siblings: dst.children, index: resolveAt(dst.children, to.at) };
}

function resolveAt(siblings: MutBlock[], at: To["at"]): number {
  if (at === "start") return 0;
  if (at === "end") return siblings.length;
  if ("before" in at) { const i = siblings.findIndex((b) => b.id === at.before); if (i < 0) throw new MutationError("target_missing", `anchor ${at.before} not found`); return i; }
  const i = siblings.findIndex((b) => b.id === at.after);
  if (i < 0) throw new MutationError("target_missing", `anchor ${at.after} not found`);
  return i + 1;
}
