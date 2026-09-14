import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import { findDoc, findDocByRef, loadDocBlocks, type BlockNode } from "./reader.js";
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

// Batch whole-document read (the hydrate half of query→hydrate). The batch
// analog of docsRead: given several doc refs (each an id OR a path, via the
// shared findDocByRef dispatch), it returns `items` (the full reads, identical
// in shape to docsRead) alongside `errors` (per-ref misses). A miss NEVER fails
// the whole call — mirrors nodes_getMany's tolerance of unknown ids, but made
// explicit as an errors array so a caller can tell which refs didn't resolve.
// Duplicate refs collapse first-seen (a repeated ref yields one item). Capped
// at MANY_DOCS_CAP refs per call (matching nodesGetMany's 100), with the same
// budget-token truncation and `truncated` flag.

/** Max doc refs honored per docsReadMany call (matches nodesGetMany's cap). */
export const MANY_DOCS_CAP = 100;

export interface DocsReadManyError {
  /** The original ref (id or path) that failed to resolve. */
  ref: string;
  /** Stable error code — currently always doc_not_found (unresolvable ref). */
  error: "doc_not_found";
}

export interface DocsReadManyResult {
  /** Full reads, one per resolved (deduped) ref, same shape as docsRead. */
  items: DocsReadResult[];
  /** Per-ref misses; present but empty when every ref resolved. */
  errors: DocsReadManyError[];
  /** True when refs exceeded the cap or the token budget cut the batch short. */
  truncated: boolean;
}

/**
 * Read many whole documents by ref (id or path) in one call. Found docs land in
 * `items` (each a full docsRead projection); unresolvable refs land in `errors`
 * without failing the call. Duplicate refs collapse first-seen. The raw list is
 * capped at MANY_DOCS_CAP (excess ⇒ truncated); an optional token budget stops
 * the batch early (also ⇒ truncated).
 */
export function docsReadMany(
  store: Store,
  repoId: string,
  refs: string[],
  opts: { includeIds?: boolean; budgetTokens?: number } = {},
): DocsReadManyResult {
  const capped = refs.slice(0, MANY_DOCS_CAP);
  let truncated = refs.length > MANY_DOCS_CAP;
  const budget = opts.budgetTokens ?? Infinity;
  const readOpts: DocsReadOptions = opts.includeIds ? { includeIds: true } : {};

  const items: DocsReadResult[] = [];
  const errors: DocsReadManyError[] = [];
  const seen = new Set<string>();
  let tokens = 0;

  for (const ref of capped) {
    // First-seen wins: a repeated ref (same literal string) is collapsed.
    if (seen.has(ref)) continue;
    seen.add(ref);

    const info = findDocByRef(store, repoId, ref);
    // Unresolvable ref (or a d_-shaped id with no doc) → a per-ref miss, never
    // a thrown error. reconstructContent returning null is the same miss.
    const read = info ? docsRead(store, info.docId, readOpts) : null;
    if (!read) {
      errors.push({ ref, error: "doc_not_found" });
      continue;
    }

    const cost = Math.ceil(JSON.stringify(read).length / 4);
    if (tokens + cost > budget) {
      truncated = true;
      break;
    }
    tokens += cost;
    items.push(read);
  }
  return { items, errors, truncated };
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
   * current-state only (properties-table), so historical property values are
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
