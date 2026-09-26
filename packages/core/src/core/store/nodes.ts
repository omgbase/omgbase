import type { Database } from "better-sqlite3";
import { hashHex } from "../hash.js";
import type { ProjectedNode } from "../../format/adapter.js";
import { codeUnitSpanToBytes } from "../utf8.js";

function mintNodeId(docId: string, blockId: string, kind: string, ordinal: number): string {
  return "n_" + hashHex(`${docId}|${blockId}|${kind}|${ordinal}`).slice(0, 12);
}

// Project `md:section` nodes from the derived `sections` table (02 §4). A
// section node surfaces the outline latent in `sections`: it is anchored to the
// heading block (a real `b_` id — so unlike adapter-projected nodes it carries a
// valid block_id), names the heading text, and carries the section's TOP-LEVEL
// ordinal range + level in attrs. Range containment over these attrs is what
// OQX's `section.blocks` / `section.subsections` / `block.section` relations
// correlate on. Derived/rebuildable; not a new source of truth. Non-markdown
// formats have no heading blocks, so `sections` is empty and this returns [].
export function projectSectionNodes(db: Database, docId: string): ProjectedNode[] {
  const rows = db
    .prepare(
      `SELECT s.heading_block AS heading_block, s.level AS level,
              s.first_ordinal AS first_ordinal, s.last_ordinal AS last_ordinal,
              hb.text AS text
       FROM sections s
       JOIN blocks hb ON hb.block_id = s.heading_block AND hb.doc_id = s.doc_id
       WHERE s.doc_id = ? AND hb.deleted_commit IS NULL
       ORDER BY s.first_ordinal`,
    )
    .all(docId) as { heading_block: string; level: number; first_ordinal: number; last_ordinal: number; text: string }[];
  return rows.map((r) => ({
    kind: "md:section",
    name: r.text,
    blockId: r.heading_block,
    attrs: { level: r.level, first_ordinal: r.first_ordinal, last_ordinal: r.last_ordinal },
  }));
}

/**
 * Convert adapter-projected spans (JavaScript string indices — UTF-16 code
 * units, spec/graph §2.3) to byte offsets into the block's UTF-8 `raw`, which is
 * what the `nodes` table stores (spec/graph §8 "Fixed"). `rawOf` returns the raw
 * of a block by id; a node whose block raw is unknown keeps no span rather than a
 * wrong one. Nodes without a span (sections) pass through untouched.
 */
export function toByteSpans(projected: ProjectedNode[], rawOf: (blockId: string) => string | undefined): ProjectedNode[] {
  return projected.map((p) => {
    if (p.spanStart === undefined || p.spanEnd === undefined) return p;
    const raw = rawOf(p.blockId);
    if (raw === undefined) return { ...p, spanStart: undefined, spanEnd: undefined };
    const { start, end } = codeUnitSpanToBytes(raw, p.spanStart, p.spanEnd);
    return { ...p, spanStart: start, spanEnd: end };
  });
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

/**
 * Replace a document's `nodes` rows (and their FTS rows) with `projected`, in
 * order; `node_id` is the spec/graph §2.3 hash over (doc, block, kind, ordinal).
 * Spans are stored as given — callers convert to bytes first (`toByteSpans`).
 */
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

    const validBlockId = p.blockId?.startsWith("b_") ? p.blockId : null;
    const nodeId = mintNodeId(docId, validBlockId ?? "", p.kind, ordinal);
    const name = p.name ?? null;
    const value = p.value ?? null;

    insert.run(
      nodeId, repoId, docId, validBlockId, p.kind,
      name, value,
      p.spanStart ?? null, p.spanEnd ?? null,
      JSON.stringify(p.attrs ?? {}),
    );

    const lastRowid = db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number };
    ftsInsert.run(lastRowid.r, name ?? "", value ?? "");
  }

  return projected.length;
}
