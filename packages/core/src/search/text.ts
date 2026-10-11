import type { Store } from "../core/store/store.js";
import { sanitizeFtsQuery } from "./fts-query.js";

// text mode query surface (07 task 1.8). Full-text search over block text via
// FTS5, ranked by bm25. Index maintenance lives in core/store/fts.ts and runs
// in the commit transaction; this module only reads.

// A hit is the block row under the surface's row rule (spec/surface §1.2, 3.0;
// spec/search §1.3): `$id` the block, `doc_id` its document, `$path` the
// document's path (the storage form here; surface-paths.ts roots it).
export interface TextHit {
  $id: string;
  doc_id: string;
  $path: string;
  type: string;
  text: string;
  score: number; // higher is better (negated bm25)
}

export interface TextSearchResult {
  hits: TextHit[];
  truncated: boolean;
}

export function textSearch(
  store: Store,
  repoId: string,
  queryStr: string,
  opts: { limit?: number } = {},
): TextSearchResult {
  const limit = opts.limit ?? 50;
  const match = sanitizeFtsQuery(queryStr);
  if (match === "") return { hits: [], truncated: false };
  const rows = store.db
    .prepare(
      `SELECT b.block_id AS "$id", b.doc_id AS doc_id, d.path AS "$path", b.type AS type,
              b.text AS text, bm25(blocks_fts) AS score
       FROM blocks_fts
       JOIN blocks b ON b.rowid = blocks_fts.rowid
       JOIN docs d ON d.doc_id = b.doc_id
       WHERE blocks_fts MATCH ? AND b.repo_id = ? AND b.deleted_commit IS NULL
       ORDER BY score
       LIMIT ?`,
    )
    .all(match, repoId, limit + 1) as (TextHit & { score: number })[];

  const truncated = rows.length > limit;
  const hits = rows.slice(0, limit).map((r) => ({ ...r, score: -r.score }));
  return { hits, truncated };
}
