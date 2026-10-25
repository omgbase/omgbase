import type { Database } from "better-sqlite3";
import type { MutBlock, MutDoc } from "./tree.js";

// Load a document from the store into a MutDoc. Reads every block's raw and
// trivia from its own row and the frontmatter raw, leading_trivia and
// separator from the document row (store 17.0, D10/M1 — through 16.x the
// bytes came from `blobs` and the frontmatter from the head revision's delta
// chain). No disk access needed — everything is in the current rows.

interface Row {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  attrs: string;
  raw: string;
  trivia: string | null;
}

export function loadMutDoc(db: Database, docId: string): MutDoc | null {
  const doc = db.prepare("SELECT doc_id, path, format, leading_trivia, frontmatter_raw, frontmatter_trivia FROM docs WHERE doc_id = ? AND deleted_at IS NULL").get(docId) as
    | { doc_id: string; path: string; format: string; leading_trivia: string; frontmatter_raw: string | null; frontmatter_trivia: string | null }
    | undefined;
  if (!doc) return null;

  const rows = db
    .prepare(
      `SELECT block_id, parent_block, ordinal, type, attrs, raw, trivia
       FROM blocks WHERE doc_id = ? AND deleted_at IS NULL
       ORDER BY parent_block, ordinal`,
    )
    .all(docId) as Row[];

  const nodes = new Map<string, MutBlock>();
  for (const r of rows) {
    // A NULL trivia means the block's trailing trivia was genuinely empty (e.g.
    // the last block of a file with no trailing newline). Emit "" — never a
    // fabricated separator, which would corrupt the file on the next write.
    // Freshly-inserted blocks carry their own explicit trivia from the op layer,
    // so they are unaffected by this.
    nodes.set(r.block_id, {
      id: r.block_id,
      type: r.type,
      raw: r.raw,
      trivia: r.trivia ?? "",
      attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      children: [],
    });
  }

  const roots: MutBlock[] = [];
  const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  for (const r of ordered) {
    const node = nodes.get(r.block_id)!;
    if (r.parent_block && nodes.has(r.parent_block)) nodes.get(r.parent_block)!.children.push(node);
  }
  for (const r of ordered) {
    if (!r.parent_block || !nodes.has(r.parent_block)) roots.push(nodes.get(r.block_id)!);
  }

  // The current frontmatter raw with its exact stored separator
  // (docs.frontmatter_trivia) appended, so the write path round-trips
  // byte-for-byte. Ingest always captures the separator when a frontmatter
  // block exists, so the ?? "" is just a type guard.
  const frontmatterRaw = doc.frontmatter_raw === null ? null : doc.frontmatter_raw + (doc.frontmatter_trivia ?? "");

  return {
    docId: doc.doc_id,
    path: doc.path,
    format: doc.format,
    leadingTrivia: doc.leading_trivia,
    frontmatterRaw,
    children: roots,
  };
}
