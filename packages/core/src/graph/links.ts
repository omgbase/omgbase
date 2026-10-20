import type { Store } from "../core/store/store.js";

// Open edges touching a node (11 §5.4 `omg links`; the read side of 05 §1).
// Doc-grain by default via the doc_edges rollup; block-grain reads the open
// edges table directly. Backlinks are the `in` direction.

// Keys follow the surface's row rule (spec/surface §1.2, 3.0): a foreign key
// is an engine field named for what it is (spec/surface §1.2, 5.0) — `_doc_id` the far document (or
// external / phantom node), `_block_id` the source block, `_predicate`; `kind`, `count`, `samples` are roles.
export interface LinkEdge {
  _predicate: string;
  /** the other endpoint (dst for out-edges, src for in-edges): a doc id, an external node id or `phantom:<path>` */
  _doc_id: string;
  kind: string;
  /** how many underlying block-grain edges this doc-grain row rolls up */
  count: number;
  /** sample source block ids (out-edges only) */
  samples?: string[];
  /** block-grain (`blocks: true`): the source block of this edge (null for a frontmatter edge) */
  _block_id?: string | null;
}

export interface LinksResult {
  out: LinkEdge[];
  in: LinkEdge[];
}

export interface LinksOptions {
  direction?: "out" | "in" | "both";
  predicates?: string[];
  /** block-grain instead of the doc_edges rollup */
  blocks?: boolean;
}

/** Open edges touching a document, grouped by direction (11 §5.4). */
export function docLinks(store: Store, docId: string, opts: LinksOptions = {}): LinksResult {
  const dir = opts.direction ?? "both";
  const predFilter = opts.predicates && opts.predicates.length > 0 ? opts.predicates : null;
  const inPred = (p: string): boolean => !predFilter || predFilter.includes(p);

  const out: LinkEdge[] = [];
  const inbound: LinkEdge[] = [];

  if (dir === "out" || dir === "both") {
    if (opts.blocks) {
      const rows = store.db
        .prepare(
          `SELECT predicate, dst_node, dst_kind, src_block FROM edges
           WHERE src_doc = ? AND to_commit IS NULL ORDER BY predicate, dst_node, src_block`,
        )
        .all(docId) as { predicate: string; dst_node: string; dst_kind: string; src_block: string | null }[];
      for (const r of rows) if (inPred(r.predicate)) out.push({ _predicate: r.predicate, _doc_id: r.dst_node, kind: r.dst_kind, count: 1, _block_id: r.src_block });
    } else {
      const rows = store.db
        .prepare(
          `SELECT predicate, dst_node, dst_kind, count, samples FROM doc_edges
           WHERE src_doc = ? ORDER BY predicate, dst_node`,
        )
        .all(docId) as { predicate: string; dst_node: string; dst_kind: string; count: number; samples: string }[];
      for (const r of rows) {
        if (!inPred(r.predicate)) continue;
        out.push({ _predicate: r.predicate, _doc_id: r.dst_node, kind: r.dst_kind, count: r.count, samples: JSON.parse(r.samples) as string[] });
      }
    }
  }

  if (dir === "in" || dir === "both") {
    if (opts.blocks) {
      const rows = store.db
        .prepare(
          `SELECT predicate, src_doc, src_block FROM edges
           WHERE dst_node = ? AND to_commit IS NULL ORDER BY predicate, src_doc, src_block`,
        )
        .all(docId) as { predicate: string; src_doc: string; src_block: string | null }[];
      for (const r of rows) if (inPred(r.predicate)) inbound.push({ _predicate: r.predicate, _doc_id: r.src_doc, kind: "document", count: 1, _block_id: r.src_block });
    } else {
      const rows = store.db
        .prepare(
          `SELECT predicate, src_doc, count(*) AS cnt FROM edges
           WHERE dst_node = ? AND to_commit IS NULL
           GROUP BY predicate, src_doc ORDER BY predicate, src_doc`,
        )
        .all(docId) as { predicate: string; src_doc: string; cnt: number }[];
      for (const r of rows) if (inPred(r.predicate)) inbound.push({ _predicate: r.predicate, _doc_id: r.src_doc, kind: "document", count: r.cnt });
    }
  }

  return { out, in: inbound };
}
