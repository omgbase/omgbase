import type { Database } from "better-sqlite3";

// FTS5 index maintenance (07 task 1.8). blocks_fts is an external-content index
// over blocks(text); external-content tables need explicit 'delete' commands
// (with the original text) before the underlying row changes, then a fresh
// insert. These run inside the commit transaction (store responsibility) so the
// index never lags the durable store. The query surface lives in src/search/.

interface FtsRow {
  rowid: number;
  text: string;
}

/** Remove a document's block rows from the FTS index (call before deleting blocks). */
export function ftsDeleteDoc(db: Database, docId: string): void {
  const rows = db.prepare("SELECT rowid, text FROM blocks WHERE doc_id = ?").all(docId) as FtsRow[];
  const del = db.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?, ?)");
  for (const r of rows) del.run(r.rowid, r.text);
}

/** Index a document's current block rows (call after inserting blocks). */
export function ftsIndexDoc(db: Database, docId: string): void {
  const rows = db
    .prepare("SELECT rowid, text FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL")
    .all(docId) as FtsRow[];
  const ins = db.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?, ?)");
  for (const r of rows) ins.run(r.rowid, r.text);
}
