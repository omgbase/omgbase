import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import { findDoc, loadDocBlocks, type BlockNode } from "./reader.js";
import { docPropertiesGrouped } from "../store/properties.js";
import { sha256 } from "../hash.js";

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
  /** Block ids in document order, for follow-up edits (include_ids). */
  ids?: string[];
}

export interface DocsReadOptions {
  includeIds?: boolean;
}

interface TopBlockRow {
  raw_hash: Buffer;
  trivia_hash: Buffer | null;
}

// A revision's root tree node is a JSON array of six-field canonical tuples
// (see core/hash.ts serializeTreeEntries):
//   [blockId, rawHashHex, childTreeHashHex, type, attrs, triviaHashHex]
// We read the top-level entries in array order and keep raw + trivia hashes;
// child subtrees are NOT walked (a container block's `raw` already contains its
// children verbatim — the same reason reconstructContent walks only roots).
type TreeEntryTuple = [string, string, string | null, string, Record<string, unknown>, string | null];

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
  if (opts.includeIds) {
    const ids: string[] = [];
    const collect = (nodes: BlockNode[]): void => {
      for (const n of nodes) {
        ids.push(n.blockId);
        collect(n.children);
      }
    };
    collect(loadDocBlocks(store, docId));
    result.ids = ids;
  }
  return result;
}

export interface DocsReadAtResult {
  path: string;
  docId: string;
  /** The revision travelled to (the argument, echoed for confirmation). */
  rev: string;
  content: string;
  /** True when the reconstructed bytes' sha256 matched the revision's stored
   *  rendered_hash — a byte-faithful round-trip. False flags the fidelity gap
   *  described below (doc-level trivia may differ for an old revision). */
  renderedHashMatch: boolean;
  /**
   * Properties as they are CURRENTLY (not at `rev`): the properties table is
   * current-state only (12-properties-table), so historical property values are
   * not recoverable. Included as best-effort context, flagged by
   * `propertiesAreCurrent: true`.
   */
  properties: Record<string, Record<string, unknown>>;
  propertiesAreCurrent: true;
}

/**
 * Whole-document TIME-TRAVEL read: reconstruct a document's full file bytes AS
 * OF a past revision `revId`, using the SAME assembly order as
 * `reconstructContent` — leading_trivia + frontmatter (from THAT revision's
 * frontmatter_blob) + frontmatter_trivia + Σ(top-level block raw + its trivia)
 * IN ORDER — but sourced from the revision's Merkle `root_tree` instead of the
 * live `blocks` table. Returns null when the doc is missing, or when `revId`
 * does not name a revision of this document (so the caller can raise a clean
 * not-found error).
 *
 * FIDELITY CAVEAT: `leading_trivia` and `frontmatter_trivia` are stored ONLY on
 * the current `docs` row, NOT per-revision (see schema.ts — the `docs` row is
 * document-level current state). So for the CURRENT revision they are exact and
 * `renderedHashMatch` is true; for a PAST revision they may be wrong if the
 * document's leading/frontmatter trivia changed since — in practice these rarely
 * change, so we use the current doc-row values as a documented best-effort. The
 * block bytes themselves ARE per-revision and always faithful. `renderedHashMatch`
 * is the honest signal: true ⇒ the reconstruction is byte-for-byte the file at
 * that revision; false ⇒ it differs only by those doc-level trivia bytes (block
 * content still reconstructs correctly).
 */
export function readDocumentAtRevision(store: Store, docId: string, revId: string): DocsReadAtResult | null {
  const db = store.db;
  const doc = db
    .prepare("SELECT path, leading_trivia, frontmatter_trivia FROM docs WHERE doc_id = ? AND deleted_commit IS NULL")
    .get(docId) as { path: string; leading_trivia: string; frontmatter_trivia: string | null } | undefined;
  if (!doc) return null;

  const rev = db.prepare("SELECT root_tree, frontmatter_blob, rendered_hash, path FROM revisions WHERE rev_id = ? AND doc_id = ?").get(revId, docId) as
    | { root_tree: Buffer; frontmatter_blob: Buffer | null; rendered_hash: Buffer; path: string }
    | undefined;
  if (!rev) return null;

  const out: string[] = [doc.leading_trivia];

  // Frontmatter blob for THIS revision (per-revision), then the doc-level
  // separator (best-effort — see fidelity caveat).
  if (rev.frontmatter_blob) out.push(blob(db, rev.frontmatter_blob) + (doc.frontmatter_trivia ?? ""));

  // Top-level blocks in tree order, from THIS revision's Merkle root tree node.
  // A container's raw already holds its children verbatim, so we deliberately do
  // NOT recurse into childTreeHashHex (mirrors reconstructContent's
  // parent_block IS NULL walk). An absent tree node yields empty body bytes.
  const node = db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?").get(rev.root_tree) as { entries: string } | undefined;
  if (node) {
    const entries = JSON.parse(node.entries) as TreeEntryTuple[];
    for (const [, rawHashHex, , , , triviaHashHex] of entries) {
      out.push(blob(db, Buffer.from(rawHashHex, "hex")));
      if (triviaHashHex) out.push(blob(db, Buffer.from(triviaHashHex, "hex")));
    }
  }

  const content = out.join("");
  const renderedHashMatch = sha256(content).equals(rev.rendered_hash);

  return {
    // The revision records the path as of that revision (docs may be moved).
    path: rev.path,
    docId,
    rev: revId,
    content,
    renderedHashMatch,
    properties: docPropertiesGrouped(db, docId),
    propertiesAreCurrent: true,
  };
}
