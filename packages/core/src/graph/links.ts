import type { Store } from "../core/store/store.js";

// Open edges touching a node (11 §5.4 `omg links`; the read side of 05 §1).
// Doc-grain by default via the doc_edges rollup; block-grain reads the open
// edges table directly. Backlinks are the `in` direction.

export interface LinkEdge {
  predicate: string;
  /** the other endpoint (dst for out-edges, src for in-edges) */
  node: string;
  kind: string;
  /** how many underlying block-grain edges this doc-grain row rolls up */
  count: number;
  /** sample source block ids (out-edges only) */
  samples?: string[];
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
          `SELECT predicate, dst_node, dst_kind FROM edges
           WHERE src_doc = ? AND to_commit IS NULL ORDER BY predicate, dst_node`,
        )
        .all(docId) as { predicate: string; dst_node: string; dst_kind: string }[];
      for (const r of rows) if (inPred(r.predicate)) out.push({ predicate: r.predicate, node: r.dst_node, kind: r.dst_kind, count: 1 });
    } else {
      const rows = store.db
        .prepare(
          `SELECT predicate, dst_node, dst_kind, count, samples FROM doc_edges
           WHERE src_doc = ? ORDER BY predicate, dst_node`,
        )
        .all(docId) as { predicate: string; dst_node: string; dst_kind: string; count: number; samples: string }[];
      for (const r of rows) {
        if (!inPred(r.predicate)) continue;
        out.push({ predicate: r.predicate, node: r.dst_node, kind: r.dst_kind, count: r.count, samples: JSON.parse(r.samples) as string[] });
      }
    }
  }

  if (dir === "in" || dir === "both") {
    const rows = store.db
      .prepare(
        `SELECT predicate, src_doc, count(*) AS cnt FROM edges
         WHERE dst_node = ? AND to_commit IS NULL
         GROUP BY predicate, src_doc ORDER BY predicate, src_doc`,
      )
      .all(docId) as { predicate: string; src_doc: string; cnt: number }[];
    for (const r of rows) if (inPred(r.predicate)) inbound.push({ predicate: r.predicate, node: r.src_doc, kind: "document", count: r.cnt });
  }

  return { out, in: inbound };
}
