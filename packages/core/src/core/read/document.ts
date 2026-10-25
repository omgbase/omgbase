import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import { findDoc, findDocByRef, loadDocBlocks, type BlockNode } from "./reader.js";
import { docPropertiesGrouped, type PropertySource } from "../store/properties.js";
import { referencePath } from "../paths.js";
import { requireHistory } from "../capabilities/registry.js";

// Whole-document read (06 §3). The one-shot cold-start read: reconstruct a
// document's full file bytes in a single call, so an agent can "read the guide
// before doing anything" without a docs_outline → blocks_read_many(raw) → join
// round trip. `content` is the reconstructed source (leading trivia + the
// serialized metadata head + each top-level block raw + its trailing trivia) —
// fences, tables, and list markers preserved verbatim, matching blocks_read raw
// fidelity. `metadata` is the document's structured property bag as the ingest
// adapter produced it: for markdown, parsed frontmatter (see docs.metadata
// in ingest.ts); for YAML/JSON, the parsed object; other formats extract per
// their adapter. docsRead is format-neutral — it returns whatever metadata was
// stored and the exact file bytes.
//
// This is a read-side projection over ordered blocks: identity stays
// block-level. Reconstruction stays in core/ (the 07 §0 boundary forbids
// importing the mutate splice renderer). Every separator is STORED, not
// assumed: a block with a NULL trivia genuinely had empty trailing bytes, and
// the frontmatter→body separator is persisted as docs.frontmatter_trivia.
// So leading_trivia + frontmatter_raw + frontmatter_trivia + Σ(raw + trivia)
// round-trips the file byte-for-byte (03 §2.1 coverage invariant). Since store
// 17.0 (D10, M1) every byte comes from the `docs` and `blocks` rows — nothing
// here reads `blobs`, a revision or the delta resolver (spec/store §6.1).

// The wire shape follows the surface's row rule (spec/surface §1.2, 5.0): the
// document's identity and location under the row attributes' own names — `_id`,
// `_path` — and the exact source bytes as `_raw` (the same value the query
// binding's `_raw` reads); `rev`, `ids`, `hashes`, `parents` name roles.
export interface DocsReadResult {
  _id: string;
  /** The reference form (`/a/b.md`, spec/surface §1 "Paths"). */
  _path: string;
  rev: string | null;
  /** Properties grouped by source: { frontmatter, inline, computed }. */
  properties: Record<string, Record<string, unknown>>;
  /** The reconstructed file bytes (spec/store §6.1) — the document's `raw`. */
  _raw: string;
  /** Block ids in document order, for follow-up edits (include_ids). */
  ids?: string[];
  /**
   * Block id → current content hash (raw-bytes hash, hex) for every id in
   * `ids` (include_ids). This is the exact value the raw `apply` kernel wants in
   * an update/split/merge/remove op's `expect.content_hash`, so a single read
   * yields both the stable ids AND the CAS tokens to mutate them — no follow-up
   * blocks_read_many(resolution:"full") hydration round trip.
   */
  hashes?: Record<string, string>;
  /**
   * Block id → parent block id (null = top level) for every id in `ids`
   * (include_ids). `ids` is a flat pre-order walk, so without this a caller
   * cannot tell a top-level block from a nested one (a list from its items)
   * without a second outline read — this makes "the top-level blocks of these
   * sections" a local filter.
   */
  parents?: Record<string, string | null>;
}

export interface DocsReadOptions {
  includeIds?: boolean;
}

interface TopBlockRow {
  raw: string;
  trivia: string | null;
}

/**
 * A live document's CURRENT frontmatter raw (spec/store §3.1 `docs.frontmatter_raw`,
 * 17.0): the fences-included raw the current-state ingest wrote, or `null`
 * when the document has none (or is not live). A plain column read — through
 * 16.x this resolved the head revision's `frontmatter_blob` delta chain
 * (inventory-ts §3.2, the hottest current-state read through history; M1).
 */
export function currentFrontmatterRaw(db: Database, docId: string): string | null {
  const row = db.prepare("SELECT frontmatter_raw FROM docs WHERE doc_id = ? AND deleted_at IS NULL").get(docId) as { frontmatter_raw: string | null } | undefined;
  return row?.frontmatter_raw ?? null;
}

/**
 * Reconstruct a document's full file bytes (spec/store §6.1): the doc row's
 * `leading_trivia`, its `frontmatter_raw` + `frontmatter_trivia` when it has
 * one, then every top-level live block's `raw` + `trivia` in `order_key`
 * order. Every byte comes from the current rows (17.0). Takes a raw Database
 * handle so it can run inside an ingest transaction (the convergence check
 * reloads through this) as well as from a Store.
 */
export function reconstructContent(db: Database, docId: string): string | null {
  const doc = db
    .prepare("SELECT leading_trivia, frontmatter_raw, frontmatter_trivia FROM docs WHERE doc_id = ? AND deleted_at IS NULL")
    .get(docId) as { leading_trivia: string; frontmatter_raw: string | null; frontmatter_trivia: string | null } | undefined;
  if (!doc) return null;

  const out: string[] = [doc.leading_trivia];

  // Emit the frontmatter block followed by its exact stored separator. Ingest
  // always captures frontmatter_trivia whenever a frontmatter block exists, so
  // frontmatter_raw present ⇒ frontmatter_trivia is a real string (possibly
  // ""); the ?? "" is just a type guard.
  if (doc.frontmatter_raw !== null) out.push(doc.frontmatter_raw + (doc.frontmatter_trivia ?? ""));

  // Top-level blocks only: a container's `raw` already contains its nested
  // children verbatim (03 §2.3), so walking roots reconstructs the whole body.
  const rows = db
    .prepare(
      `SELECT raw, trivia FROM blocks
       WHERE doc_id = ? AND parent_block IS NULL AND deleted_at IS NULL
       ORDER BY order_key`,
    )
    .all(docId) as TopBlockRow[];

  for (const r of rows) {
    out.push(r.raw);
    if (r.trivia !== null) out.push(r.trivia);
  }
  return out.join("");
}

/**
 * The surface's `properties` (spec/surface §2, 5.0): the `spec/properties` §5
 * grouped shape with the computed group's keys spelled as the attributes that
 * read them — the store writes the computed rows under `$title`/`$tags`
 * (spec/properties §3.3, unchanged), the surface has no `$` names and its
 * engine names are `_`-prefixed, so `properties.computed` is `{ _title, _tags }`.
 * Authored groups are untouched (bare keys; an authored `$x:` key keeps its
 * sigil, as `_frontmatter.$x` reads it).
 */
export function surfaceProperties(grouped: Record<PropertySource, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const computed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(grouped.computed)) computed[k.startsWith("$") ? `_${k.slice(1)}` : k] = v;
  return { frontmatter: grouped.frontmatter, inline: grouped.inline, computed };
}

/** Read a whole document by id: full file bytes + properties. Null if missing. */
export function docsRead(store: Store, docId: string, opts: DocsReadOptions = {}): DocsReadResult | null {
  const info = findDoc(store, { docId });
  if (!info) return null;
  const content = reconstructContent(store.db, docId);
  if (content === null) return null;

  const result: DocsReadResult = {
    _id: info.docId,
    _path: referencePath(info.path),
    rev: info.currentRev,
    properties: surfaceProperties(docPropertiesGrouped(store.db, docId)),
    _raw: content,
  };
  if (opts.includeIds) {
    const ids: string[] = [];
    const hashes: Record<string, string> = {};
    const parents: Record<string, string | null> = {};
    const collect = (nodes: BlockNode[]): void => {
      for (const n of nodes) {
        ids.push(n.blockId);
        // The block's raw-bytes hash and parent are already loaded on the node,
        // so exposing them costs nothing beyond the id walk.
        hashes[n.blockId] = n.rawHashHex;
        parents[n.blockId] = n.parentBlock;
        collect(n.children);
      }
    };
    collect(loadDocBlocks(store, docId));
    result.ids = ids;
    result.hashes = hashes;
    result.parents = parents;
  }
  return result;
}

// Batch whole-document read (the hydrate half of query→hydrate). The batch
// analog of docsRead: given several doc refs (each an id OR a path, via the
// shared findDocByRef dispatch), it returns `items` (the full reads, identical
// in shape to docsRead) alongside `errors` (per-ref misses). A miss NEVER fails
// the whole call — mirrors nodesGetMany's tolerance of unknown ids, but made
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

    // The budget is checked before the SECOND item onward (spec/surface §2, 1.2):
    // the first item is always emitted even when it alone exceeds the budget —
    // the same "at least one row" contract docs_list/docs_tree keep, so a
    // budgeted client always makes progress. `truncated` stays honest: it is
    // set only when the budget stopped an item that would otherwise have shipped.
    const cost = Math.ceil(JSON.stringify(read).length / 4);
    if (items.length > 0 && tokens + cost > budget) {
      truncated = true;
      break;
    }
    tokens += cost;
    items.push(read);
  }
  return { items, errors, truncated };
}

/**
 * `docs_read { at }` / `docs_read_at` (spec/surface §2, 4.7): the document AS
 * OF a revision. No `properties`: the properties table is current-state only
 * (`spec/properties`), and recomputing the bag from the reconstructed bytes is
 * not yet a one-call affair of the format layer (the inline fields come out of
 * the ingest's node projection) — so the time-travel read carries the bytes
 * and nothing it would have to guess at (through 4.6 `docs_read_at` returned
 * the CURRENT bag flagged `propertiesAreCurrent: true`).
 */
export interface DocsReadAtResult {
  _id: string;
  /** The path as of that revision, in the reference form. */
  _path: string;
  /** The revision travelled to (the argument, echoed for confirmation). */
  rev: string;
  /** The reconstructed file bytes at `rev` — the document's `raw` then. */
  _raw: string;
  /** True when the reconstructed bytes' sha256 matched the revision's stored
   *  rendered_hash — a byte-faithful round-trip. False flags the fidelity gap
   *  described below (doc-level trivia may differ for an old revision). */
  renderedHashMatch: boolean;
}

/**
 * Whole-document TIME-TRAVEL read: the document's full file bytes AS OF a past
 * revision `revId` (spec/store §6.2) — `HistoryRecorder.readAtRevision`, whose
 * default implementation is `graph/history.ts`'s `reconstructAtRevision` (the
 * body that lived here through modular-core Phase 1; its fidelity caveat is
 * documented there). Null when the doc is missing or `revId` is not one of its
 * revisions; `RevisionArchived` when the revision's segment is unavailable.
 * Kept here for the fixture runners and tests that read it from this module;
 * `docs_read { at }`, `docs_diff_unified` and the materializer call the
 * recorder directly.
 */
export function readDocumentAtRevision(store: Store, docId: string, revId: string): DocsReadAtResult | null {
  return requireHistory(store.db).readAtRevision(docId, revId);
}
