import type { Database } from "better-sqlite3";
import { mintId } from "../ids.js";
import { capabilitiesOf, claimsOf } from "../capabilities/registry.js";

// Open-edge maintenance + doc_edges rollup (spec/graph §3.3–§3.5; store 17.0,
// M6). Runs in the commit transaction. Extraction happens upstream (graph/
// module, invoked by sync/); core only persists the resolved edge set as the
// OPEN rows of `edges` — closing an edge deletes its row — and hands the
// recorder the transition's edge list (the ids opened with their rows, the ids
// closed) so the history bundle can keep the interval record
// (`edge_transitions`, 16.x's `edges` row verbatim). The core writes no
// `from_commit`/`to_commit`. This keeps core/ free of any dependency on graph/.

export interface ResolvedEdge {
  srcDoc: string;
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: "document" | "block" | "external";
  dstNode: string; // resolved node id (document/external/block)
  anchor: string | null;
  provenance: string;
}

/** An open edge as the core wrote it (every `edges` column): what the recorder receives per opened edge (spec/store §5.4 step 15). */
export interface EdgeRow {
  edgeId: string;
  repoId: string;
  srcDoc: string;
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: string;
  dstNode: string;
  anchor: string | null;
  provenance: string;
  viaNode: string | null;
}

/** The transition's edge list (spec/graph §3.3, 17.0): the rows this commit opened and the ids it closed, in write order. */
export interface EdgeTransitions {
  opened: EdgeRow[];
  closed: string[];
}

// Stable key for diffing an edge set against the open rows.
function edgeKey(e: { srcBlock: string | null; srcField: string | null; predicate: string; dstNode: string; anchor: string | null }): string {
  return `${e.srcBlock ?? ""}|${e.srcField ?? ""}|${e.predicate}|${e.dstNode}|${e.anchor ?? ""}`;
}

/**
 * spec/graph §3.3 (17.0): reconcile the extracted edge set for a document
 * against its open rows — insert a row (mint `e`) for every wanted key not
 * open, in wanted order; then walk the open rows in `rowid` order and DELETE
 * every one whose key is not wanted or that duplicates a kept key; unchanged
 * rows are untouched (they keep their `edge_id`). The transition's edge list
 * goes to the recorder (`HistoryRecorder.recordEdgeTransitions`, skipped when
 * the store runs without one). Then recompute the doc_edges rollup for the
 * doc. All within the caller's transaction.
 */
export function maintainEdges(db: Database, repoId: string, srcDoc: string, commitId: string, edges: ResolvedEdge[], ts: string): EdgeTransitions {
  // spec/store §2.1 (17.0): the `e` minted per newly opened edge and the `x`
  // `resolveExternal` minted for its external target are claimed here, in the
  // commit transaction, `minted_at = ts` (an external node that already had
  // its claim adds nothing — the claim is idempotent).
  const claims = claimsOf(db);
  const openRows = db
    .prepare(
      `SELECT edge_id, src_block, src_field, predicate, dst_node, anchor FROM edges
       WHERE src_doc = ? ORDER BY rowid`,
    )
    .all(srcDoc) as { edge_id: string; src_block: string | null; src_field: string | null; predicate: string; dst_node: string; anchor: string | null }[];

  // One open row per key. Two spellings of one target in one block
  // (`../old.md` and `./x/../../old.md`) extract as two descriptors but resolve
  // to the SAME key, so dedupe the wanted set here; and any duplicate open rows
  // already in the table (from earlier versions of this function) are deleted
  // below so they cannot leak past the link they came from.
  const openKeys = new Set<string>();
  for (const r of openRows) openKeys.add(edgeKey({ srcBlock: r.src_block, srcField: r.src_field, predicate: r.predicate, dstNode: r.dst_node, anchor: r.anchor }));

  const wantKeys = new Set<string>();
  const insert = db.prepare(
    `INSERT INTO edges (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const opened: EdgeRow[] = [];
  for (const e of edges) {
    const key = edgeKey(e);
    if (wantKeys.has(key)) continue;
    wantKeys.add(key);
    if (!openKeys.has(key)) {
      const edgeId = mintId("e");
      claims.claim("e", edgeId, repoId, ts);
      if (e.dstKind === "external") claims.claim("x", e.dstNode, repoId, ts);
      insert.run(edgeId, repoId, srcDoc, e.srcBlock, e.srcField, e.predicate, e.dstKind, e.dstNode, e.anchor, e.provenance);
      opened.push({ edgeId, repoId, srcDoc, srcBlock: e.srcBlock, srcField: e.srcField, predicate: e.predicate, dstKind: e.dstKind, dstNode: e.dstNode, anchor: e.anchor, provenance: e.provenance, viaNode: null });
    }
  }
  // Delete every open row whose key is no longer wanted, and all but the first
  // open row of a wanted key.
  const del = db.prepare("DELETE FROM edges WHERE edge_id = ?");
  const kept = new Set<string>();
  const closed: string[] = [];
  for (const r of openRows) {
    const key = edgeKey({ srcBlock: r.src_block, srcField: r.src_field, predicate: r.predicate, dstNode: r.dst_node, anchor: r.anchor });
    if (wantKeys.has(key) && !kept.has(key)) { kept.add(key); continue; }
    del.run(r.edge_id);
    closed.push(r.edge_id);
  }
  const transitions: EdgeTransitions = { opened, closed };
  // spec/store §5.4 step 15 (17.0): the recorder's half — the interval record.
  if (opened.length > 0 || closed.length > 0) capabilitiesOf(db).history?.recordEdgeTransitions(commitId, transitions);

  rebuildDocEdges(db, srcDoc);
  return transitions;
}

/**
 * Rewrite the destination of the open edges at `fromDst` to `toDst` in place
 * (spec/graph §3.5 adoption; a move's re-phantoming, `mutate/commit.ts`) —
 * the rows keep their ids — and tell the recorder so the open transitions
 * follow (`edge_transitions.dst_node` reads as 16.x's `edges` did). Returns the
 * distinct source documents touched (their rollups are the caller's to rebuild).
 * `where` narrows the rows (an extra SQL predicate over `edges`, with params).
 */
export function retargetOpenEdges(db: Database, fromDst: string, toDst: string, where = "", params: unknown[] = []): string[] {
  const rows = db.prepare(`SELECT edge_id, src_doc FROM edges WHERE dst_node = ? ${where} ORDER BY rowid`).all(fromDst, ...params) as { edge_id: string; src_doc: string }[];
  if (rows.length === 0) return [];
  db.prepare(`UPDATE edges SET dst_node = ? WHERE dst_node = ? ${where}`).run(toDst, fromDst, ...params);
  capabilitiesOf(db).history?.retargetEdges(rows.map((r) => r.edge_id), toDst);
  return [...new Set(rows.map((r) => r.src_doc))];
}

// When a document is (re)created at a path, adopt any open phantom edges that
// pointed at that path so backlinks re-point to the real node (spec/graph
// §3.5). Rebuilds the affected source docs' rollups.
export function adoptPhantoms(db: Database, path: string, realDocId: string): void {
  const canonical = path.replace(/^\//, "");
  const affected = retargetOpenEdges(db, `phantom:${canonical}`, realDocId);
  for (const src of affected) rebuildDocEdges(db, src);
}

/** Recompute the doc_edges rollup for one document from its open edges. */
export function rebuildDocEdges(db: Database, srcDoc: string): void {
  db.prepare("DELETE FROM doc_edges WHERE src_doc = ?").run(srcDoc);
  const rows = db
    .prepare(
      `SELECT predicate, dst_node, dst_kind, count(*) AS cnt,
              json_group_array(src_block) AS blocks
       FROM edges WHERE src_doc = ?
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

// Resolve/mint an external node id for a normalized URI. The claim for a
// minted `x` is written by `maintainEdges` with the edge that names it (the
// resolver runs inside the ingest's edge extraction, same transaction).
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
  const doc = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL").get(repoId, canonical) as { doc_id: string } | undefined;
  if (doc) return { id: doc.doc_id, phantom: false };
  // Phantom: a deterministic placeholder keyed by path.
  return { id: `phantom:${canonical}`, phantom: true };
}
