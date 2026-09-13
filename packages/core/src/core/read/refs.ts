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

// Node ids are content-hash derived (`n_` + 12 hex chars, see core/store/nodes),
// not the 7-char minted scheme prefixOf recognizes — match them explicitly.
const NODE_ID_RE = /^n_[0-9a-f]{12}$/;

/**
 * Resolve a node reference within a repo. Accepts:
 *   - a block id (prefix "b")        → { block, docId, blockId }
 *   - a document id (prefix "d")     → { document, docId }
 *   - a projected node id ("n_…")    → its block, or its doc when block-less
 *   - a repo-relative document path  → { document, docId }
 * Returns null when nothing matches.
 */
export function resolveRef(store: Store, repoId: string, ref: string): ResolvedRef | null {
  // A projected-node id (e.g. an OQX `from nodes` hit) dereferences to the block
  // it was projected from — so a node hit is a first-class argument to the same
  // read/write commands a block id is. Block-less nodes (or nodes whose block is
  // no longer live) fall back to their document.
  if (NODE_ID_RE.test(ref)) {
    const node = store.db
      .prepare("SELECT doc_id, block_id FROM nodes WHERE node_id = ?")
      .get(ref) as { doc_id: string; block_id: string | null } | undefined;
    if (!node) return null;
    if (node.block_id) {
      const live = store.db
        .prepare("SELECT 1 FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
        .get(node.block_id);
      if (live) return { kind: "block", docId: node.doc_id, blockId: node.block_id };
    }
    return { kind: "document", docId: node.doc_id };
  }

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
