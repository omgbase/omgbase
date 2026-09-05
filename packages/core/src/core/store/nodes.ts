import type { Database } from "better-sqlite3";
import { hashHex } from "../hash.js";
import type { ProjectedNode } from "../../format/adapter.js";

function mintNodeId(docId: string, blockId: string, kind: string, ordinal: number): string {
  return "n_" + hashHex(`${docId}|${blockId}|${kind}|${ordinal}`).slice(0, 12);
}

export function deleteDocNodes(db: Database, docId: string): void {
  const rows = db.prepare("SELECT rowid, name, value FROM nodes WHERE doc_id = ?").all(docId) as { rowid: number; name: string | null; value: string | null }[];
  for (const r of rows) {
    db.prepare("INSERT INTO nodes_fts(nodes_fts, rowid, name, value) VALUES('delete', ?, ?, ?)").run(
      r.rowid, r.name ?? "", r.value ?? "",
    );
  }
  db.prepare("DELETE FROM nodes WHERE doc_id = ?").run(docId);
}

export function writeDocNodes(
  db: Database,
  repoId: string,
  docId: string,
  projected: ProjectedNode[],
): number {
  deleteDocNodes(db, docId);

  const insert = db.prepare(
    `INSERT INTO nodes (node_id, repo_id, doc_id, block_id, kind, name, value, span_start, span_end, attrs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ftsInsert = db.prepare("INSERT INTO nodes_fts(rowid, name, value) VALUES(?, ?, ?)");

  const kindCounters = new Map<string, number>();
  for (const p of projected) {
    const key = p.kind + "|" + (p.blockId ?? "");
    const ordinal = kindCounters.get(key) ?? 0;
    kindCounters.set(key, ordinal + 1);

    const nodeId = mintNodeId(docId, p.blockId ?? "", p.kind, ordinal);
    const name = p.name ?? null;
    const value = p.value ?? null;

    insert.run(
      nodeId, repoId, docId, p.blockId ?? null, p.kind,
      name, value,
      p.spanStart ?? null, p.spanEnd ?? null,
      JSON.stringify(p.attrs ?? {}),
    );

    const lastRowid = db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number };
    ftsInsert.run(lastRowid.r, name ?? "", value ?? "");
  }

  return projected.length;
}
