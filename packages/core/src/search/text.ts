import type { Store } from "../core/store/store.js";
import { sanitizeFtsQuery } from "./fts-query.js";

// text mode query surface (07 task 1.8). Full-text search over block text via
// FTS5, ranked by bm25. Index maintenance lives in core/store/fts.ts and runs
// in the commit transaction; this module only reads.

export interface TextHit {
  blockId: string;
  docId: string;
  path: string;
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
      `SELECT b.block_id AS blockId, b.doc_id AS docId, d.path AS path, b.type AS type,
              b.text AS text, bm25(blocks_fts) AS score
       FROM blocks_fts
       JOIN blocks b ON b.rowid = blocks_fts.rowid
       JOIN documents d ON d.doc_id = b.doc_id
       WHERE blocks_fts MATCH ? AND b.repo_id = ? AND b.deleted_commit IS NULL
       ORDER BY score
       LIMIT ?`,
    )
    .all(match, repoId, limit + 1) as (TextHit & { score: number })[];

  const truncated = rows.length > limit;
  const hits = rows.slice(0, limit).map((r) => ({ ...r, score: -r.score }));
  return { hits, truncated };
}
