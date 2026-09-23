import type { Database } from "better-sqlite3";
import { mintId } from "../ids.js";

// Edge interval maintenance + doc_edges rollup (05 §2, §1). Runs in the commit
// transaction. Extraction happens upstream (graph/ module, invoked by sync/);
// core only persists the resolved edge set and maintains validity intervals.
// This keeps core/ free of any dependency on graph/.

export interface ResolvedEdge {
  srcDoc: string;
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: "document" | "block" | "external" | "collection";
  dstNode: string; // resolved node id (document/external/block/collection)
  anchor: string | null;
  provenance: string;
}

// Stable key for diffing an edge set against currently-open rows.
function edgeKey(e: { srcBlock: string | null; srcField: string | null; predicate: string; dstNode: string; anchor: string | null }): string {
  return `${e.srcBlock ?? ""}|${e.srcField ?? ""}|${e.predicate}|${e.dstNode}|${e.anchor ?? ""}`;
}

/**
 * Reconcile the extracted edge set for a document against its currently-open
 * rows: close rows no longer present (to_commit = this), open rows that are new
 * (from_commit = this), leave unchanged rows untouched. Then recompute the
 * doc_edges rollup for the doc. All within the caller's transaction.
 */
export function maintainEdges(db: Database, repoId: string, srcDoc: string, commitId: string, edges: ResolvedEdge[]): void {
  const openRows = db
    .prepare(
      `SELECT edge_id, src_block, src_field, predicate, dst_node, anchor FROM edges
       WHERE src_doc = ? AND to_commit IS NULL`,
    )
    .all(srcDoc) as { edge_id: string; src_block: string | null; src_field: string | null; predicate: string; dst_node: string; anchor: string | null }[];

  // One open row per key. Two spellings of one target in one block
  // (`../old.md` and `./x/../../old.md`) extract as two descriptors but resolve
  // to the SAME key, so dedupe the wanted set here; and any duplicate open rows
  // already in the table (from earlier versions of this function) are closed
  // below so they cannot leak past the link they came from.
  const openKeys = new Set<string>();
  for (const r of openRows) openKeys.add(edgeKey({ srcBlock: r.src_block, srcField: r.src_field, predicate: r.predicate, dstNode: r.dst_node, anchor: r.anchor }));

  const wantKeys = new Set<string>();
  const insert = db.prepare(
    `INSERT INTO edges (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, from_commit, to_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const e of edges) {
    const key = edgeKey(e);
    if (wantKeys.has(key)) continue;
    wantKeys.add(key);
    if (!openKeys.has(key)) {
      insert.run(mintId("e"), repoId, srcDoc, e.srcBlock, e.srcField, e.predicate, e.dstKind, e.dstNode, e.anchor, e.provenance, commitId);
    }
  }
  // Close every open row whose key is no longer wanted, and all but the first
  // open row of a wanted key.
  const close = db.prepare("UPDATE edges SET to_commit = ? WHERE edge_id = ?");
  const kept = new Set<string>();
  for (const r of openRows) {
    const key = edgeKey({ srcBlock: r.src_block, srcField: r.src_field, predicate: r.predicate, dstNode: r.dst_node, anchor: r.anchor });
    if (wantKeys.has(key) && !kept.has(key)) { kept.add(key); continue; }
    close.run(commitId, r.edge_id);
  }

  rebuildDocEdges(db, srcDoc);
}

// When a document is (re)created at a path, adopt any open phantom edges that
// pointed at that path so backlinks re-point to the real node (05 §2). Rebuilds
// the affected source docs' rollups.
export function adoptPhantoms(db: Database, path: string, realDocId: string): void {
  const canonical = path.replace(/^\//, "");
  const phantom = `phantom:${canonical}`;
  const affected = db.prepare("SELECT DISTINCT src_doc FROM edges WHERE dst_node = ? AND to_commit IS NULL").all(phantom) as { src_doc: string }[];
  if (affected.length === 0) return;
  db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL").run(realDocId, phantom);
  for (const a of affected) rebuildDocEdges(db, a.src_doc);
}

/** Recompute the doc_edges rollup for one document from its open edges. */
export function rebuildDocEdges(db: Database, srcDoc: string): void {
  db.prepare("DELETE FROM doc_edges WHERE src_doc = ?").run(srcDoc);
  const rows = db
    .prepare(
      `SELECT predicate, dst_node, dst_kind, count(*) AS cnt,
              json_group_array(src_block) AS blocks
       FROM edges WHERE src_doc = ? AND to_commit IS NULL
       GROUP BY predicate, dst_node, dst_kind`,
    )
    .all(srcDoc) as { predicate: string; dst_node: string; dst_kind: string; cnt: number; blocks: string }[];
  const insert = db.prepare(
    "INSERT INTO doc_edges (src_doc, predicate, dst_node, dst_kind, count, samples) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    const blocks = (JSON.parse(r.blocks) as (string | null)[]).filter((b): b is string => b !== null).slice(0, 3);
    insert.run(srcDoc, r.predicate, r.dst_node, r.dst_kind, r.cnt, JSON.stringify(blocks));
  }
}

// Resolve/mint an external node id for a normalized URI.
export function resolveExternal(db: Database, repoId: string, uri: string): string {
  const existing = db.prepare("SELECT node_id FROM external_nodes WHERE repo_id = ? AND uri = ?").get(repoId, uri) as { node_id: string } | undefined;
  if (existing) return existing.node_id;
  const id = mintId("x");
  db.prepare("INSERT INTO external_nodes (node_id, repo_id, uri) VALUES (?, ?, ?)").run(id, repoId, uri);
  return id;
}

// Resolve a repo-relative path to a document id, minting a phantom placeholder
// if absent (05 §2) so backlinks appear the moment the target is created. The
// phantom id is derived from the path so it is stable and re-resolves when the
// real doc is ingested (the doc keeps its own minted id; edges point at the
// path-keyed node, joined by path at query time).
export function resolveDocPath(db: Database, repoId: string, path: string): { id: string; phantom: boolean } {
  const canonical = path.replace(/^\//, "");
  const doc = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL").get(repoId, canonical) as { doc_id: string } | undefined;
  if (doc) return { id: doc.doc_id, phantom: false };
  // Phantom: a deterministic placeholder keyed by path.
  return { id: `phantom:${canonical}`, phantom: true };
}
