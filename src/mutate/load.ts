import type { Database } from "better-sqlite3";
import type { MutBlock, MutDoc } from "./tree.js";

// Load a document from the store into a MutDoc (04 §6 step 3a needs the current
// tree). Reconstructs blocks with raw bytes from blobs + trailing trivia from
// the tree-node entries is not tracked per-block yet in the current-state table,
// so trivia is defaulted to "\n\n" between blocks — sufficient for the mutation
// path whose rendered output is re-ingested (convergence self-heals spacing).

interface Row {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  attrs: string;
  raw_hash: Buffer;
}

export function loadMutDoc(db: Database, docId: string): MutDoc | null {
  const doc = db.prepare("SELECT doc_id, path, current_rev FROM documents WHERE doc_id = ? AND deleted_commit IS NULL").get(docId) as
    | { doc_id: string; path: string; current_rev: string | null }
    | undefined;
  if (!doc) return null;

  const rows = db
    .prepare(
      `SELECT block_id, parent_block, ordinal, type, attrs, raw_hash
       FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL
       ORDER BY parent_block, ordinal`,
    )
    .all(docId) as Row[];

  const blob = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const nodes = new Map<string, MutBlock>();
  for (const r of rows) {
    const raw = (blob.get(r.raw_hash) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "";
    nodes.set(r.block_id, {
      id: r.block_id,
      type: r.type,
      raw,
      trivia: "\n\n",
      attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      children: [],
    });
  }

  const roots: MutBlock[] = [];
  // rows are ordered by (parent_block, ordinal); build children in order.
  const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  for (const r of ordered) {
    const node = nodes.get(r.block_id)!;
    if (r.parent_block && nodes.has(r.parent_block)) nodes.get(r.parent_block)!.children.push(node);
  }
  // roots preserve ordinal order
  for (const r of ordered) {
    if (!r.parent_block || !nodes.has(r.parent_block)) roots.push(nodes.get(r.block_id)!);
  }

  // Load frontmatter raw from the revision's frontmatter_blob.
  let frontmatterRaw: string | null = null;
  if (doc.current_rev) {
    const rev = db.prepare("SELECT frontmatter_blob FROM revisions WHERE rev_id = ?").get(doc.current_rev) as { frontmatter_blob: Buffer | null } | undefined;
    if (rev?.frontmatter_blob) {
      const fm = blob.get(rev.frontmatter_blob) as { bytes: Buffer } | undefined;
      if (fm) frontmatterRaw = fm.bytes.toString("utf8") + "\n\n";
    }
  }

  return { docId: doc.doc_id, path: doc.path, leadingTrivia: "", frontmatterRaw, children: roots };
}
