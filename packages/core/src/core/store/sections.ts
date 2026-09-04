import type { Database } from "better-sqlite3";

// Section-range derivation (02 §4, 01 §3.2). A section runs from a heading
// block to the ordinal before the next peer-or-higher heading, over TOP-LEVEL
// ordinals (headings are top-level leaves in the flat containment tree).
// Rebuilt per document in the commit transaction; dropping it loses nothing.

interface TopBlock {
  block_id: string;
  ordinal: number;
  type: string;
  level: number | null;
}

export function rebuildSections(db: Database, docId: string): void {
  db.prepare("DELETE FROM sections WHERE doc_id = ?").run(docId);

  const tops = db
    .prepare(
      `SELECT block_id, ordinal, type,
              json_extract(attrs, '$.level') AS level
       FROM blocks
       WHERE doc_id = ? AND parent_block IS NULL AND deleted_commit IS NULL
       ORDER BY ordinal`,
    )
    .all(docId) as TopBlock[];

  const maxOrdinal = tops.length > 0 ? tops[tops.length - 1]!.ordinal : -1;
  const headings = tops.filter((t) => t.type === "heading");

  const insert = db.prepare(
    `INSERT INTO sections (heading_block, doc_id, level, first_ordinal, last_ordinal)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const level = h.level ?? 1;
    // last_ordinal = one before the next heading with level <= this one.
    let last = maxOrdinal;
    for (let j = i + 1; j < headings.length; j++) {
      const next = headings[j]!;
      if ((next.level ?? 1) <= level) {
        last = next.ordinal - 1;
        break;
      }
    }
    insert.run(h.block_id, docId, level, h.ordinal, last);
  }
}
