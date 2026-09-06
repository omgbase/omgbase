import type { Database } from "better-sqlite3";
import type { MutBlock, MutDoc } from "./tree.js";

// Load a document from the store into a MutDoc. Reads block raw and trivia
// from the blobs table, and leading_trivia from the document row. No disk
// access needed — everything is in the database.

interface Row {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  attrs: string;
  raw_hash: Buffer;
  trivia_hash: Buffer | null;
}

export function loadMutDoc(db: Database, docId: string): MutDoc | null {
  const doc = db.prepare("SELECT doc_id, path, format, leading_trivia, frontmatter_trivia, current_rev FROM documents WHERE doc_id = ? AND deleted_commit IS NULL").get(docId) as
    | { doc_id: string; path: string; format: string; leading_trivia: string; frontmatter_trivia: string | null; current_rev: string | null }
    | undefined;
  if (!doc) return null;

  const rows = db
    .prepare(
      `SELECT block_id, parent_block, ordinal, type, attrs, raw_hash, trivia_hash
       FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL
       ORDER BY parent_block, ordinal`,
    )
    .all(docId) as Row[];

  const blob = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const nodes = new Map<string, MutBlock>();
  for (const r of rows) {
    const raw = (blob.get(r.raw_hash) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "";
    // A NULL trivia_hash means the block's trailing trivia was genuinely empty
    // (e.g. the last block of a file with no trailing newline). Emit "" — never
    // a fabricated separator, which would corrupt the file on the next write.
    // Freshly-inserted blocks carry their own explicit trivia from the op layer,
    // so they are unaffected by this.
    let trivia = "";
    if (r.trivia_hash) {
      const tb = blob.get(r.trivia_hash) as { bytes: Buffer } | undefined;
      if (tb) trivia = tb.bytes.toString("utf8");
    }
    nodes.set(r.block_id, {
      id: r.block_id,
      type: r.type,
      raw,
      trivia,
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

  let frontmatterRaw: string | null = null;
  if (doc.current_rev) {
    const rev = db.prepare("SELECT frontmatter_blob FROM revisions WHERE rev_id = ?").get(doc.current_rev) as { frontmatter_blob: Buffer | null } | undefined;
    if (rev?.frontmatter_blob) {
      const fm = blob.get(rev.frontmatter_blob) as { bytes: Buffer } | undefined;
      // Append the exact stored separator (documents.frontmatter_trivia) so the
      // write path round-trips byte-for-byte. Ingest always captures it when a
      // frontmatter block exists, so the ?? "" is just a type guard.
      if (fm) frontmatterRaw = fm.bytes.toString("utf8") + (doc.frontmatter_trivia ?? "");
    }
  }

  return {
    docId: doc.doc_id,
    path: doc.path,
    format: doc.format,
    leadingTrivia: doc.leading_trivia,
    frontmatterRaw,
    children: roots,
  };
}
