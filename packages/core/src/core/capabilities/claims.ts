import type { Database, Statement } from "better-sqlite3";
import type { IdPrefix } from "../ids.js";
import type { IdentityClaims } from "./types.js";

// spec/store §2.1 "Uniqueness at mint": the table(s) and id column a minted
// id of each prefix must not already name a row of. A block id lives on in
// history after its `blocks` row is gone, hence `block_changes` and
// `resurrection_pool`; a head token (17.0, D1) is in use while a `docs` row
// names it as `head` or a captured revision as `rev_id`. `col` and `v` have no
// table and no check. (Moved from
// `core/store/store.ts` unchanged — inventory-ts §2.2 row `ID_TABLES`/`idInUse`,
// §3.5; M3/D5 replace the union with an `id_claims` table in Phase 3.)
export const ID_TABLES: Partial<Record<IdPrefix, readonly (readonly [table: string, column: string])[]>> = {
  d: [["docs", "doc_id"]],
  b: [["blocks", "block_id"], ["block_changes", "block_id"], ["resurrection_pool", "block_id"]],
  c: [["commits", "commit_id"]],
  r: [["revisions", "rev_id"], ["docs", "head"]],
  x: [["external_nodes", "node_id"]],
  e: [["edges", "edge_id"]],
  cp: [["checkpoints", "id"]],
  rp: [["repos", "repo_id"]],
  src: [["sources", "source_id"]],
  s: [["archives", "segment_id"]],
};

/**
 * The default `IdentityClaims`: the row an id lands in is its claim, so
 * `isClaimed` is today's `Store.idInUse` — `SELECT 1 FROM <table> WHERE <id
 * col> = ?` per table of the prefix, statements prepared once per prefix —
 * and `claim` records nothing (the ingest/commit writes the row).
 */
export class TableUnionClaims implements IdentityClaims {
  private readonly stmts = new Map<IdPrefix, Statement[]>();

  constructor(private readonly db: Database) {}

  claim(_prefix: IdPrefix, _id: string): void {
    // The row is the claim (spec/store §2.1). Phase 3 (M3): `INSERT INTO id_claims`.
  }

  isClaimed(prefix: IdPrefix, id: string): boolean {
    if (!this.db.open) return false;
    let stmts = this.stmts.get(prefix);
    if (!stmts) {
      stmts = (ID_TABLES[prefix] ?? []).map(([table, column]) =>
        this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`),
      );
      this.stmts.set(prefix, stmts);
    }
    for (const stmt of stmts) if (stmt.get(id) !== undefined) return true;
    return false;
  }
}
