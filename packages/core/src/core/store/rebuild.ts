import type { Store } from "./store.js";
import { rebuildSections } from "./sections.js";
import { rebuildDocEdges } from "./edges.js";
import { ftsRebuild } from "./fts.js";

// Rebuild derived tables from durable tables only (02 §6, invariant #8). Every
// table in 02 §4 can be dropped and reconstructed with zero information loss
// (byte-identical for deterministic tables; semantic for FTS/vec). The
// current-state `blocks` table is itself rebuildable from revisions, but v1
// maintains it transactionally, so rebuild here targets the §4 derived tables
// that hang off `blocks`.

export type RebuildTarget = "sections" | "edges" | "fts" | "block_changes" | "all";

/** The commit ids every revision of which is archived (spec/store §7 "Retention", 15.0): a commit with at least one revision and no live one. */
export const ARCHIVED_COMMITS_SQL =
  "SELECT c.commit_id FROM commits c WHERE EXISTS (SELECT 1 FROM revisions r WHERE r.commit_id = c.commit_id) AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.commit_id = c.commit_id AND r.archive IS NULL)";

export function rebuildIndex(store: Store, target: RebuildTarget = "all"): void {
  store.write((db) => {
    const docIds = (db.prepare("SELECT doc_id FROM docs WHERE deleted_at IS NULL").all() as { doc_id: string }[]).map((r) => r.doc_id);

    if (target === "sections" || target === "all") {
      for (const docId of docIds) rebuildSections(db, docId);
    }

    if (target === "edges" || target === "all") {
      // doc_edges is a pure rollup of the open `edges` rows; rebuild per doc.
      for (const docId of docIds) rebuildDocEdges(db, docId);
    }

    if (target === "fts" || target === "all") {
      // spec/search §1.1: 'delete-all', then every live leaf of every live doc
      // (FTS5's 'rebuild' would index the content table wholesale, containers
      // included).
      ftsRebuild(db);
    }

    if (target === "block_changes" || target === "all") {
      // block_changes is a projection of dispositions across commits: rebuild
      // it verbatim from the dispositions table (which is durable) — for every
      // commit that still has dispositions. A wholly archived commit (spec/store
      // §7 "Retention", 15.0: every revision of it carries `archive`) has none;
      // its surviving block_changes rows are each block's earliest, kept for the
      // mint oracle, and are left exactly as they are.
      db.exec(`DELETE FROM block_changes WHERE commit_id NOT IN (${ARCHIVED_COMMITS_SQL})`);
      db.exec(
        "INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) SELECT block_id, commit_id, kind FROM dispositions",
      );
    }
  });
}
