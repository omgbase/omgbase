import type { Database } from "better-sqlite3";

// FTS5 index maintenance (spec/search §1.1). blocks_fts is an external-content
// index over blocks(text); external-content tables need explicit 'delete'
// commands (with the original text) before the underlying row changes, then a
// fresh insert. These run inside the commit transaction (store responsibility)
// so the index never lags the durable store. The query surface lives in
// src/search/.
//
// Only live LEAF rows are indexed (search 1.2): a container's `text` is its
// children's text joined (spec/format §4.1), so indexing it would count every
// word once per enclosing level and skew bm25's statistics. A row is a leaf iff
// no live row of the same document names it as `parent_block`; the test needs
// no re-parse and works at both delete and insert time because a document's
// rows are replaced wholesale on ingest. The invariant every writer keeps:
// the index holds exactly the live-leaf rows of `blocks` as the table stands.

interface FtsRow {
  rowid: number;
  text: string;
}

/**
 * SQL predicate: the `blocks` row aliased `b` is a live leaf. `c.doc_id =
 * b.doc_id` lets the NOT EXISTS use `idx_blocks_doc` (block ids are unique, so
 * it never changes the answer).
 */
export const LIVE_LEAF_SQL =
  "b.deleted_commit IS NULL AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block = b.block_id AND c.deleted_commit IS NULL)";

/**
 * How many rows the FTS index actually holds. `SELECT count(*) FROM blocks_fts`
 * is answered from the external-content table (`blocks`, tombstones included),
 * so the count comes from the index's own `_docsize` shadow table — one row per
 * indexed row. `doctor` compares it to the live leaf count (spec/search §1.1).
 */
export function ftsIndexedRowCount(db: Database): number {
  return (db.prepare("SELECT count(*) c FROM blocks_fts_docsize").get() as { c: number }).c;
}

/** The number of live leaf blocks — the rows the FTS index must hold (spec/search §1.1). */
export function liveLeafCount(db: Database): number {
  return (db.prepare(`SELECT count(*) c FROM blocks b WHERE ${LIVE_LEAF_SQL}`).get() as { c: number }).c;
}

/** Remove a document's live leaf rows from the FTS index (call before deleting
 * or tombstoning blocks). Only live leaves are indexed (see ftsIndexDoc), so the
 * delete must target the SAME set: an already-tombstoned block or a container has
 * no FTS row, and re-issuing a 'delete' for it corrupts the external-content
 * index's statistics. Keeping this symmetric with ftsIndexDoc makes a tombstone
 * followed by a later re-ingest of the same doc id (observed delete → recreate)
 * idempotent. */
export function ftsDeleteDoc(db: Database, docId: string): void {
  const rows = db.prepare(`SELECT b.rowid AS rowid, b.text AS text FROM blocks b WHERE b.doc_id = ? AND ${LIVE_LEAF_SQL}`).all(docId) as FtsRow[];
  const del = db.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?, ?)");
  for (const r of rows) del.run(r.rowid, r.text);
}

/** Index a document's current live leaf rows (call after inserting blocks). */
export function ftsIndexDoc(db: Database, docId: string): void {
  const rows = db
    .prepare(`SELECT b.rowid AS rowid, b.text AS text FROM blocks b WHERE b.doc_id = ? AND ${LIVE_LEAF_SQL}`)
    .all(docId) as FtsRow[];
  const ins = db.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?, ?)");
  for (const r of rows) ins.run(r.rowid, r.text);
}

/**
 * Rebuild the whole index: `'delete-all'`, then every live leaf of every live
 * document. (FTS5's own `'rebuild'` command reads the content table wholesale,
 * containers included, so it is not used.)
 */
export function ftsRebuild(db: Database): void {
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('delete-all')");
  const docIds = (db.prepare("SELECT doc_id FROM docs WHERE deleted_commit IS NULL").all() as { doc_id: string }[]).map((r) => r.doc_id);
  for (const docId of docIds) ftsIndexDoc(db, docId);
}

/**
 * Remove single `blocks` rows (by id) that are about to be deleted out of
 * another document's row set — the cross-document eviction of spec/store §5.4
 * step 8 — keeping the index equal to the table's live leaves. Every row's
 * leaf-ness is decided over the table BEFORE any of them goes (so a list moving
 * with its items is order-independent: the items are leaves and lose their
 * entries, the list never had one), and a live parent that keeps its row but
 * loses its last live child becomes a leaf and gains an entry. The caller owns
 * the DELETE of the rows, which must follow this call.
 */
export function ftsBeforeEvictRows(db: Database, rows: { rowid: number; block_id: string; doc_id: string; parent_block: string | null; text: string; deleted_commit: string | null }[]): void {
  if (rows.length === 0) return;
  const evicted = new Set(rows.map((r) => r.block_id));
  const hasLiveChild = db.prepare("SELECT 1 FROM blocks c WHERE c.doc_id = ? AND c.parent_block = ? AND c.deleted_commit IS NULL LIMIT 1");
  const del = db.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?, ?)");
  const leaves = rows.filter((r) => r.deleted_commit === null && !hasLiveChild.get(r.doc_id, r.block_id));
  for (const r of leaves) del.run(r.rowid, r.text);
  // Parents that stay live but are left childless are leaves from now on.
  const parentRow = db.prepare(
    `SELECT b.rowid AS rowid, b.text AS text FROM blocks b WHERE b.block_id = ? AND b.doc_id = ? AND b.deleted_commit IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block = b.block_id AND c.deleted_commit IS NULL AND c.block_id NOT IN (${rows.map(() => "?").join(",")}))`,
  );
  const ins = db.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?, ?)");
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.deleted_commit !== null || !r.parent_block || evicted.has(r.parent_block) || seen.has(r.parent_block)) continue;
    seen.add(r.parent_block);
    const p = parentRow.get(r.parent_block, r.doc_id, ...rows.map((x) => x.block_id)) as FtsRow | undefined;
    if (p) ins.run(p.rowid, p.text);
  }
}
