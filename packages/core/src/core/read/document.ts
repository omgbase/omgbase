import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import { findDoc } from "./reader.js";
import { docsOutline } from "./outline.js";
import { docPropertiesGrouped } from "../store/properties.js";

// Whole-document read (06 §3). The one-shot cold-start read: reconstruct a
// document's full file bytes in a single call, so an agent can "read the guide
// before doing anything" without a docs_outline → nodes_get_many(raw) → join
// round trip. `content` is the reconstructed source (leading trivia + the
// serialized metadata head + each top-level block raw + its trailing trivia) —
// fences, tables, and list markers preserved verbatim, matching nodes_get raw
// fidelity. `metadata` is the document's structured property bag as the ingest
// adapter produced it: for markdown, parsed frontmatter (see docs.metadata
// in ingest.ts); for YAML/JSON, the parsed object; other formats extract per
// their adapter. docsRead is format-neutral — it returns whatever metadata was
// stored and the exact file bytes.
//
// This is a read-side projection over ordered blocks, not blob storage:
// identity stays block-level. Reconstruction stays in core/ (the 07 §0 boundary
// forbids importing the mutate splice renderer). Every separator is STORED, not
// assumed: a block with no trivia_hash genuinely had empty trailing bytes, and
// the frontmatter→body separator is persisted as docs.frontmatter_trivia.
// So leading_trivia + frontmatter + frontmatter_trivia + Σ(raw + trivia)
// round-trips the file byte-for-byte (03 §2.1 coverage invariant).

export interface DocsReadResult {
  path: string;
  docId: string;
  rev: string | null;
  /** Properties grouped by source: { frontmatter, inline, computed }. */
  properties: Record<string, Record<string, unknown>>;
  content: string;
  ids?: Record<string, string>;
}

export interface DocsReadOptions {
  includeIds?: boolean;
}

interface TopBlockRow {
  raw_hash: Buffer;
  trivia_hash: Buffer | null;
}

function blob(db: Database, hash: Buffer): string {
  const row = db.prepare("SELECT bytes FROM blobs WHERE hash = ?").get(hash) as { bytes: Buffer } | undefined;
  return row ? row.bytes.toString("utf8") : "";
}

/**
 * Reconstruct a document's full file bytes from its ordered top-level blocks.
 * Takes a raw Database handle so it can run inside an ingest transaction (the
 * convergence check reloads through this) as well as from a Store.
 */
export function reconstructContent(db: Database, docId: string): string | null {
  const doc = db
    .prepare("SELECT leading_trivia, frontmatter_trivia, current_rev FROM docs WHERE doc_id = ? AND deleted_commit IS NULL")
    .get(docId) as { leading_trivia: string; frontmatter_trivia: string | null; current_rev: string | null } | undefined;
  if (!doc) return null;

  const out: string[] = [doc.leading_trivia];

  if (doc.current_rev) {
    const rev = db.prepare("SELECT frontmatter_blob FROM revisions WHERE rev_id = ?").get(doc.current_rev) as
      | { frontmatter_blob: Buffer | null }
      | undefined;
    // Emit the frontmatter block followed by its exact stored separator. Ingest
    // always captures frontmatter_trivia whenever a frontmatter block exists, so
    // frontmatter_blob present ⇒ frontmatter_trivia is a real string (possibly
    // ""); the ?? "" is just a type guard.
    if (rev?.frontmatter_blob) out.push(blob(db, rev.frontmatter_blob) + (doc.frontmatter_trivia ?? ""));
  }

  // Top-level blocks only: a container's `raw` already contains its nested
  // children verbatim (03 §2.3), so walking roots reconstructs the whole body.
  const rows = db
    .prepare(
      `SELECT raw_hash, trivia_hash FROM blocks
       WHERE doc_id = ? AND parent_block IS NULL AND deleted_commit IS NULL
       ORDER BY order_key`,
    )
    .all(docId) as TopBlockRow[];

  for (const r of rows) {
    out.push(blob(db, r.raw_hash));
    if (r.trivia_hash) out.push(blob(db, r.trivia_hash));
  }
  return out.join("");
}

/** Read a whole document by id: full file bytes + properties. Null if missing. */
export function docsRead(store: Store, docId: string, opts: DocsReadOptions = {}): DocsReadResult | null {
  const info = findDoc(store, { docId });
  if (!info) return null;
  const content = reconstructContent(store.db, docId);
  if (content === null) return null;

  const result: DocsReadResult = {
    path: info.path,
    docId: info.docId,
    rev: info.currentRev,
    properties: docPropertiesGrouped(store.db, docId),
    content,
  };
  if (opts.includeIds) result.ids = docsOutline(store, docId).ids;
  return result;
}
