// The SQL shape of a root scan, shared by the tier-3 planner (planner.ts) and
// the store-backed indexes (store-index.ts): one FROM clause per target, the
// columns a produced row carries (the target's own columns plus the owning
// document's path as `__path`, exactly what the context's root scans select),
// the default `(path, id)` order and the live-row/repo guards. Any statement
// that produces rows the engine will treat as a target's rows must come from
// here, so a planned or probed row is indistinguishable from a scanned one.

import type { Target } from "./translate.js";

export const ALIAS: Record<Target, { self: string; doc: string }> = {
  docs: { self: "d", doc: "d" },
  blocks: { self: "b", doc: "d" },
  nodes: { self: "n", doc: "d" },
  edges: { self: "e", doc: "d" },
};

export const FROM: Record<Target, string> = {
  docs: "docs d",
  blocks: "blocks b JOIN docs d ON d.doc_id = b.doc_id",
  nodes: "nodes n JOIN docs d ON d.doc_id = n.doc_id",
  edges: "edges e JOIN docs d ON d.doc_id = e.src_doc",
};

/** Row columns + the owning-doc path as `__path` (matches the context roots so
 * produced rows are indistinguishable from a full scan's). */
export const COLS: Record<Target, string> = {
  docs: "d.*",
  blocks: "b.*, d.path AS __path",
  nodes: "n.*, d.path AS __path",
  edges: "e.*, d.path AS __path",
};

/** The joined targets driven FROM the document: the same rows and columns as
 * `FROM`, with the loop order fixed by `CROSS JOIN` so a predicate on the
 * document (`d.path = ?`) is the outer search and the target's rows are
 * reached through their `doc_id` / `src_doc` index. `guardsByDoc` goes with it. */
export const FROM_BY_DOC: Record<Exclude<Target, "docs">, string> = {
  blocks: "docs d CROSS JOIN blocks b ON b.doc_id = d.doc_id",
  nodes: "docs d CROSS JOIN nodes n ON n.doc_id = d.doc_id",
  edges: "docs d CROSS JOIN edges e ON e.src_doc = d.doc_id",
};

export const ORDER: Record<Target, string> = {
  docs: "d.path, d.doc_id",
  blocks: "d.path, b.block_id",
  nodes: "d.path, n.node_id",
  edges: "d.path, e.edge_id",
};

/** The live-row and repository guards of a target scan. */
export function guards(target: Target, repoId: string): { sql: string; params: unknown[] } {
  switch (target) {
    case "docs": return { sql: "d.repo_id = ? AND d.deleted_commit IS NULL", params: [repoId] };
    case "blocks": return { sql: "b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId] };
    case "nodes": return { sql: "n.repo_id = ? AND d.deleted_commit IS NULL", params: [repoId] };
    case "edges": return { sql: "e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId] };
  }
}

/** `guards` for a `FROM_BY_DOC` statement: the same tests, with the document's
 * repo first and the target's repo term behind SQLite's unary `+` so it stays a
 * filter and never selects a `(repo_id, …)` index over the `doc_id` one. */
export function guardsByDoc(target: Exclude<Target, "docs">, repoId: string): { sql: string; params: unknown[] } {
  switch (target) {
    case "blocks": return { sql: "d.repo_id = ? AND +b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId, repoId] };
    case "nodes": return { sql: "d.repo_id = ? AND +n.repo_id = ? AND d.deleted_commit IS NULL", params: [repoId, repoId] };
    case "edges": return { sql: "d.repo_id = ? AND +e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId, repoId] };
  }
}
