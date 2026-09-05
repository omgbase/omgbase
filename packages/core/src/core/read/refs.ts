import type { Store } from "../store/store.js";
import { prefixOf } from "../ids.js";
import { findDoc } from "./reader.js";

// Node-reference resolution shared by the CLI and any client that accepts the
// same argument forms the API accepts (11 §2.3): a bare id (b_…, d_…) or a
// document path. Full locators with in-doc anchors (path#Heading/p[2]) are a
// superset resolved via `resolve`; this helper covers the id/path base cases
// every read command needs.

export interface ResolvedRef {
  kind: "block" | "document";
  docId: string;
  blockId?: string;
}

/**
 * Resolve a node reference within a repo. Accepts:
 *   - a block id (prefix "b")        → { block, docId, blockId }
 *   - a document id (prefix "d")     → { document, docId }
 *   - a repo-relative document path  → { document, docId }
 * Returns null when nothing matches.
 */
export function resolveRef(store: Store, repoId: string, ref: string): ResolvedRef | null {
  const prefix = prefixOf(ref);
  if (prefix === "b") {
    const row = store.db
      .prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
      .get(ref) as { doc_id: string } | undefined;
    if (!row) return null;
    return { kind: "block", docId: row.doc_id, blockId: ref };
  }
  if (prefix === "d") {
    const info = findDoc(store, { docId: ref });
    return info ? { kind: "document", docId: info.docId } : null;
  }
  // Otherwise treat it as a document path.
  const info = findDoc(store, { repoId, path: ref });
  return info ? { kind: "document", docId: info.docId } : null;
}
