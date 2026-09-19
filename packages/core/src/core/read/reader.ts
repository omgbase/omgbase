import type { Store } from "../store/store.js";
import { isValidId } from "../ids.js";
import { encodeCursor, decodeCursor } from "../cursor.js";

// Read-side reconstruction of current-state blocks (02 §3 blocks table).
// Rebuilds the containment forest for a document from parent_block + order_key.

/** One row of the `ls` / docs_list surface: a live document with its block
 *  count and last-commit timestamp. */
export interface DocListRow {
  path: string;
  blocks: number;
  ts: string | null;
}

/** A page of the docs_list surface. Honors the uniform list contract (mcp-api
 *  §1): `truncated` is honest, and when true `cursor` resumes after the last
 *  item returned. */
export interface DocListPage {
  items: DocListRow[];
  truncated: boolean;
  cursor: string | null;
}

export interface DocListOptions {
  /** Simple LIKE match on the path (`*` → any run, ACROSS `/`). */
  pathGlob?: string;
  /** Max rows per page (default DOCS_LIST_DEFAULT_LIMIT). */
  limit?: number;
  /** Resume after a previous page's `cursor`. */
  cursor?: string | null;
  /** Cap the page's estimated size (~4 chars/token); at least one row is always
   *  returned so a paging client makes progress. */
  budgetTokens?: number;
}

export const DOCS_LIST_DEFAULT_LIMIT = 200;

/** Escape a user glob into a LIKE pattern (`*` → `%`; literal `%`/`_` escaped). */
function globToLike(glob: string): string {
  return glob.replace(/[%_\\]/g, "\\$&").replace(/\*/g, "%");
}

/** Live docs of a repo (path, live block count, last-commit ts) whose path
 *  matches `like`, ordered by path, optionally resuming strictly after `after`
 *  and capped at `limit`. The one query behind docs_list and docs_tree. */
function liveDocRows(store: Store, repoId: string, like: string, after: string | null, limit: number | null): DocListRow[] {
  const params: unknown[] = [repoId, like];
  let where = "";
  if (after !== null) {
    where += " AND d.path > ?";
    params.push(after);
  }
  let tail = "";
  if (limit !== null) {
    tail = " LIMIT ?";
    params.push(limit);
  }
  return store.db
    .prepare(
      `SELECT d.path AS path,
              (SELECT count(*) FROM blocks b WHERE b.doc_id = d.doc_id AND b.deleted_commit IS NULL) AS blocks,
              (SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = d.current_rev) AS ts
       FROM docs d
       WHERE d.repo_id = ? AND d.deleted_commit IS NULL AND d.path LIKE ? ESCAPE '\\'${where}
       ORDER BY d.path${tail}`,
    )
    .all(...params) as DocListRow[];
}

// Path-keyset cursors for the path-ordered list surfaces: the shared kernel
// encoding (core/cursor.ts) with a one-part tuple.
function encodePathCursor(path: string): string {
  return encodeCursor([path]);
}
function decodePathCursor(cursor: string): string {
  return decodeCursor(cursor, "docs_list/docs_tree", 1)[0]!;
}

/** Page an already path-ordered row set under a limit + token budget, issuing
 *  a keyset cursor when it stops early. Shared by docs_list and docs_tree. */
function pagePathOrdered<T extends { path: string }>(
  rows: T[],
  limit: number,
  budgetTokens: number | undefined,
  moreBeyond: boolean,
): { items: T[]; truncated: boolean; cursor: string | null } {
  const budget = budgetTokens ?? Infinity;
  const items: T[] = [];
  let tokens = 0;
  let truncated = moreBeyond;
  for (const row of rows) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const cost = Math.ceil(JSON.stringify(row).length / 4);
    if (items.length > 0 && tokens + cost > budget) {
      truncated = true;
      break;
    }
    tokens += cost;
    items.push(row);
  }
  const last = items[items.length - 1];
  return { items, truncated, cursor: truncated && last ? encodePathCursor(last.path) : null };
}

/** List a repo's live documents (path, block count, last-commit ts), ordered by
 *  path, as a page: `{ items, truncated, cursor }`. `pathGlob` is a simple LIKE
 *  match (`*` → `%`). Backs `omg ls` and the `docs_list` MCP tool (one
 *  implementation for both surfaces). For a directory-aware summary use
 *  `docsTree`. */
export function docsList(store: Store, repoId: string, opts: DocListOptions = {}): DocListPage {
  const like = opts.pathGlob ? globToLike(opts.pathGlob) : "%";
  const limit = Math.max(1, Math.floor(opts.limit ?? DOCS_LIST_DEFAULT_LIMIT));
  const after = opts.cursor ? decodePathCursor(opts.cursor) : null;
  // Fetch one past the limit so `truncated` is a fact, not a guess.
  const rows = liveDocRows(store, repoId, like, after, limit + 1);
  const moreBeyond = rows.length > limit;
  return pagePathOrdered(rows.slice(0, limit), limit, opts.budgetTokens, moreBeyond);
}

/** One entry of the docs_tree surface: a live document (`kind: "doc"`) or a
 *  collapsed directory (`kind: "dir"`, path ends in `/`) at the requested
 *  depth. `docs`/`blocks` are totals under the entry (a doc counts 1 doc);
 *  `ts` is the latest last-commit timestamp under it. */
export interface DocTreeEntry {
  path: string;
  kind: "dir" | "doc";
  docs: number;
  blocks: number;
  ts: string | null;
}

export interface DocTreePage {
  /** The normalized directory prefix the tree was taken under (`""` = root;
   *  otherwise ends in `/`). */
  prefix: string;
  depth: number;
  /** Totals over EVERYTHING under `prefix`, regardless of paging. */
  total: { docs: number; blocks: number };
  entries: DocTreeEntry[];
  truncated: boolean;
  cursor: string | null;
}

export interface DocTreeOptions {
  /** Directory to take the tree under (`projects` or `projects/`; leading `/`
   *  tolerated). Omit for the repo root. */
  path?: string;
  /** How many path segments below `prefix` to expand before collapsing
   *  (default 1 = immediate children, like `tree -L 1`). */
  depth?: number;
  limit?: number;
  cursor?: string | null;
  budgetTokens?: number;
}

export const DOCS_TREE_DEFAULT_LIMIT = 200;

/** Normalize a tree prefix: no leading `/`, and either empty or ending in `/`. */
export function normalizeTreePrefix(path: string | undefined): string {
  const trimmed = (path ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed + "/";
}

/** The path-separator-aware orientation read (`tree -L depth` + `du`): every
 *  live doc under `path` is collapsed at `depth` segments into one entry per
 *  directory (with doc/block totals + latest ts) or listed as a doc when it is
 *  shallow enough. Entries are ordered by path; dirs carry a trailing `/`. The
 *  result is paged under the same limit/cursor/budget contract as docsList,
 *  and always carries `total` for the whole prefix so an agent sees the size of
 *  what it is looking at even when the page is cut. Backs the `docs_tree` MCP
 *  tool. */
export function docsTree(store: Store, repoId: string, opts: DocTreeOptions = {}): DocTreePage {
  const prefix = normalizeTreePrefix(opts.path);
  const depth = Math.max(1, Math.floor(opts.depth ?? 1));
  const limit = Math.max(1, Math.floor(opts.limit ?? DOCS_TREE_DEFAULT_LIMIT));
  const like = prefix === "" ? "%" : globToLike(prefix) + "%";
  const rows = liveDocRows(store, repoId, like, null, null);

  const byPath = new Map<string, DocTreeEntry>();
  const total = { docs: 0, blocks: 0 };
  for (const row of rows) {
    total.docs += 1;
    total.blocks += row.blocks;
    const segs = row.path.slice(prefix.length).split("/");
    if (segs.length <= depth) {
      byPath.set(row.path, { path: row.path, kind: "doc", docs: 1, blocks: row.blocks, ts: row.ts });
      continue;
    }
    const dir = prefix + segs.slice(0, depth).join("/") + "/";
    const cur = byPath.get(dir);
    if (cur) {
      cur.docs += 1;
      cur.blocks += row.blocks;
      if (row.ts !== null && (cur.ts === null || row.ts > cur.ts)) cur.ts = row.ts;
    } else {
      byPath.set(dir, { path: dir, kind: "dir", docs: 1, blocks: row.blocks, ts: row.ts });
    }
  }

  let entries = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (opts.cursor) {
    const after = decodePathCursor(opts.cursor);
    entries = entries.filter((e) => e.path > after);
  }
  const { items, truncated, cursor } = pagePathOrdered(entries, limit, opts.budgetTokens, false);
  return { prefix, depth, total, entries: items, truncated, cursor };
}

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
