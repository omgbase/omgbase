import type { Store } from "./store.js";
import { rebuildSections } from "./sections.js";
import { rebuildDocEdges } from "./edges.js";
import { ftsRebuild } from "./fts.js";
import { captureFor } from "./manifest.js";

// Rebuild derived tables from durable tables only (02 §6, invariant #8). Every
// table in 02 §4 can be dropped and reconstructed with zero information loss
// (byte-identical for deterministic tables; semantic for FTS/vec). The
// current-state `blocks` table is itself rebuildable from revisions, but v1
// maintains it transactionally, so rebuild here targets the §4 derived tables
// that hang off `blocks`.

export type RebuildTarget = "sections" | "edges" | "fts" | "block_changes" | "all";

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
      // The recorder's projection (`HistoryRecorder.rebuildProjections`:
      // block_changes re-derived from dispositions, spec/store §7) — when the
      // store carries the module and the bundle's tables exist (Phase 4a).
      captureFor(db, null)?.rebuildProjections();
    }
  });
}
