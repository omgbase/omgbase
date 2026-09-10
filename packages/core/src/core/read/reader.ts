import type { Store } from "../store/store.js";
import { isValidId } from "../ids.js";

// Read-side reconstruction of current-state blocks (02 §3 blocks table).
// Rebuilds the containment forest for a document from parent_block + order_key.

export interface BlockNode {
  blockId: string;
  docId: string;
  parentBlock: string | null;
  ordinal: number;
  depth: number;
  type: string;
  attrs: Record<string, unknown>;
  text: string;
  rawHashHex: string;
  children: BlockNode[];
}

interface BlockRow {
  block_id: string;
  doc_id: string;
  parent_block: string | null;
  order_key: string;
  ordinal: number;
  depth: number;
  type: string;
  attrs: string;
  text: string;
  raw_hash: Buffer;
}

function toNode(r: BlockRow): BlockNode {
  return {
    blockId: r.block_id,
    docId: r.doc_id,
    parentBlock: r.parent_block,
    ordinal: r.ordinal,
    depth: r.depth,
    type: r.type,
    attrs: JSON.parse(r.attrs) as Record<string, unknown>,
    text: r.text,
    rawHashHex: r.raw_hash.toString("hex"),
    children: [],
  };
}

/** Load a document's live blocks as a containment forest, ordered. */
export function loadDocBlocks(store: Store, docId: string): BlockNode[] {
  const rows = store.db
    .prepare(
      `SELECT block_id, doc_id, parent_block, order_key, ordinal, depth, type, attrs, text, raw_hash
       FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL
       ORDER BY parent_block, order_key`,
    )
    .all(docId) as BlockRow[];

  const byId = new Map<string, BlockNode>();
  for (const r of rows) byId.set(r.block_id, toNode(r));

  const roots: BlockNode[] = [];
  // Preserve order_key ordering by iterating rows (already sorted).
  for (const r of rows) {
    const node = byId.get(r.block_id)!;
    if (r.parent_block && byId.has(r.parent_block)) {
      byId.get(r.parent_block)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Retrieve the raw source bytes for a block by its raw_hash. */
export function blockRaw(store: Store, rawHashHex: string): string {
  const row = store.db.prepare("SELECT bytes FROM blobs WHERE hash = ?").get(Buffer.from(rawHashHex, "hex")) as
    | { bytes: Buffer }
    | undefined;
  return row ? row.bytes.toString("utf8") : "";
}

export interface DocInfo {
  docId: string;
  repoId: string;
  path: string;
  format: string;
  currentRev: string | null;
}

export function findDoc(store: Store, ref: { docId?: string; repoId?: string; path?: string }): DocInfo | null {
  let row: Record<string, unknown> | undefined;
  if (ref.docId) {
    row = store.db.prepare("SELECT doc_id, repo_id, path, format, current_rev FROM docs WHERE doc_id = ? AND deleted_commit IS NULL").get(ref.docId) as Record<string, unknown> | undefined;
  } else if (ref.repoId && ref.path) {
    row = store.db.prepare("SELECT doc_id, repo_id, path, format, current_rev FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL").get(ref.repoId, ref.path) as Record<string, unknown> | undefined;
  }
  if (!row) return null;
  return {
    docId: row.doc_id as string,
    repoId: row.repo_id as string,
    path: row.path as string,
    format: (row.format as string) ?? "markdown",
    currentRev: (row.current_rev as string | null) ?? null,
  };
}

/**
 * Resolve a single `doc` ref that may be EITHER a minted document id (`d_…`) OR
 * a repo-relative path — the id-or-path symmetry every doc-ref surface expects
 * (docs_read/outline/read_at, diff, apply's insert.doc, graph seeds, docHistory).
 * This is the ONE dispatch those call sites route through so the "path in the
 * doc field" trap can't recur per-tool.
 *
 * A `d_`-shaped id is looked up by id ONLY — if it doesn't exist we return null
 * (the caller fails loud) rather than falling through to a path lookup that
 * would also miss and confusingly report a path-not-found for a d_ value.
 * Anything else is treated as a path. Returns null when unresolvable; callers
 * throw a clear doc_missing/target_missing so an unresolvable ref is never a
 * silent empty result.
 */
export function findDocByRef(store: Store, repoId: string, ref: string): DocInfo | null {
  if (isValidId(ref, "d")) return findDoc(store, { docId: ref });
  return findDoc(store, { repoId, path: ref });
}
