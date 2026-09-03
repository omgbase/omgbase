import type { Store } from "./store.js";
import { rebuildSections } from "./sections.js";
import { rebuildDocEdges } from "./edges.js";
import { ftsIndexDoc } from "./fts.js";

// Rebuild derived tables from durable tables only (02 §6, invariant #8). Every
// table in 02 §4 can be dropped and reconstructed with zero information loss
// (byte-identical for deterministic tables; semantic for FTS/vec). The
// current-state `blocks` table is itself rebuildable from revisions, but v1
// maintains it transactionally, so rebuild here targets the §4 derived tables
// that hang off `blocks`.

export type RebuildTarget = "sections" | "edges" | "fts" | "block_changes" | "all";

export function rebuildIndex(store: Store, target: RebuildTarget = "all"): void {
  store.write((db) => {
    const docIds = (db.prepare("SELECT doc_id FROM documents WHERE deleted_commit IS NULL").all() as { doc_id: string }[]).map((r) => r.doc_id);

    if (target === "sections" || target === "all") {
      for (const docId of docIds) rebuildSections(db, docId);
    }

    if (target === "edges" || target === "all") {
      // doc_edges is a pure rollup of the open `edges` rows; rebuild per doc.
      for (const docId of docIds) rebuildDocEdges(db, docId);
    }

    if (target === "fts" || target === "all") {
      // Rebuild the external-content FTS index from current block text.
      db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')");
    }

    if (target === "block_changes" || target === "all") {
      // block_changes is a projection of dispositions across commits: rebuild
      // it verbatim from the dispositions table (which is durable).
      db.prepare("DELETE FROM block_changes").run();
      db.exec(
        "INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) SELECT block_id, commit_id, kind FROM dispositions",
      );
    }
  });
  void ftsIndexDoc; // fts rebuild uses the FTS5 'rebuild' command directly
}
