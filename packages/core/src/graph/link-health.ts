import type { Store } from "../core/store/store.js";
import { canonicalLinkPath, docDirOf, splitDestination } from "./link-destinations.js";

// Stale-link maintenance (the read side). mrplex has links_stale (detect) +
// links_repair (bulk fix); omgbase had only links_retarget (a targeted rename).
// This module answers "which links in this repo point at nothing?" by scanning
// the OPEN edge index — no filesystem or network I/O. The edge index is the
// authority: links are already extracted into `edges`, so we never re-parse
// markdown here.
//
// HOW A DANGLING INTERNAL LINK IS REPRESENTED (see core/store/edges.ts):
// resolveDocPath mints `dst_node = "phantom:" + canonicalPath` when no live doc
// has the link's target path. adoptPhantoms rewrites that phantom id to the real
// doc id when a doc is later (re)created at the path. So an OPEN edge whose
// dst_node begins with `phantom:` is a link to a path with no live doc — the
// PRIMARY staleness signal. All internal document/block(^ref) links funnel
// through resolveDocPath (sync/reconciling-ingest.ts resolveEdge forces
// dst_kind='document'), so there is no distinct raw block-ref node kind to check
// — a cross-doc `path^ref` becomes a document phantom carrying its `anchor`.
//
// EXTERNAL LINKS (dst_kind='external', http(s) URLs normalized via normalizeUri)
// can rot too, but verifying reachability needs network I/O, which must NOT
// happen in the engine. So external links are "unverifiable", not "stale": we
// COUNT them (never mark them broken). Callers that want reachability checks do
// that out of band.
//
// BROKEN ANCHORS (a `#heading` / `^ref` into a doc that DOES exist but lacks the
// anchor) are a subtler class: v1 does NOT verify anchors (see docs). Only the
// phantom-target case (dangling_doc) is reported.

export type StaleReason = "dangling_doc" | "dangling_block" | "broken_anchor";

export interface StaleLink {
  /** source document id */
  srcDoc: string;
  /** source document repo-relative path */
  srcPath: string;
  /** source block id (null for frontmatter-level edges) */
  srcBlock: string | null;
  predicate: string;
  provenance: string;
  dstKind: string;
  /** canonical target PATH (phantom prefix stripped, no leading `/`), e.g. "guides/old.md" */
  target: string;
  /** the destination exactly as authored in the source block, e.g. "/guides/old.md#Setup"
   * — paste-ready as `links_repair.from`. null when it can't be recovered (frontmatter
   * edges have no block; a projected node no longer matches). */
  authored: string | null;
  anchor: string | null;
  reason: StaleReason;
}

export interface LinkHealth {
  /** dangling internal links, ordered by srcPath then target */
  stale: StaleLink[];
  /** open external (http(s)) edges — unverifiable, not counted as stale */
  externalCount: number;
  /** total open edges scanned (after src-doc glob scoping) */
  totalOpenEdges: number;
  /** true when `stale` was capped by `limit` */
  truncated: boolean;
}

export interface LinkHealthOptions {
  /** scope the SOURCE docs by a path glob (`journal/*`); `*` maps to SQL `%`. */
  pathGlob?: string;
  /** cap the number of stale links returned (default 500). */
  limit?: number;
}

// Convert a path glob to a SQL LIKE clause + param, mirroring compileWithin
// (search/cel/compile.ts) and docHistory (graph/history.ts): escape %/_ then
// map `*`→`%`. A glob without `*` is an exact-path match.
export function globClause(column: string, glob: string): { clause: string; param: string } {
  if (glob.includes("*")) {
    const like = glob.replace(/[%_]/g, "\\$&").replace(/\*/g, "%");
    return { clause: `${column} LIKE ? ESCAPE '\\'`, param: like };
  }
  return { clause: `${column} = ?`, param: glob };
}

/**
 * linksStale: scan open edges repo-wide and return the dangling internal ones,
 * plus a count of unverifiable external links. Read-only; pure DB read over the
 * edge index (no FS/network).
 *
 * Dangling detection: an open edge whose `dst_node LIKE 'phantom:%'` points at a
 * path with no live doc. `target` is the path with the `phantom:` prefix
 * stripped so callers see `guides/old.md`, not the internal id.
 *
 * Scoping: `pathGlob` filters the SOURCE docs (joined edges.src_doc → docs).
 * Edges whose src_doc is tombstoned (docs.deleted_commit IS NOT NULL) are
 * skipped — a deleted doc's dangling links are not actionable.
 */
export function linksStale(store: Store, repoId: string, opts: LinkHealthOptions = {}): LinkHealth {
  const limit = opts.limit ?? 500;

  const params: unknown[] = [repoId];
  let globSql = "";
  if (opts.pathGlob) {
    const { clause, param } = globClause("d.path", opts.pathGlob);
    globSql = `AND ${clause}`;
    params.push(param);
  }

  // Total open edges (scoped) and external count in one pass over the join.
  const totals = store.db
    .prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN e.dst_kind = 'external' THEN 1 ELSE 0 END) AS external
       FROM edges e
       JOIN docs d ON d.doc_id = e.src_doc
       WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL ${globSql}`,
    )
    .get(...params) as { total: number; external: number | null };

  // Dangling internal links: open, source not tombstoned, dst is a phantom.
  const rows = store.db
    .prepare(
      `SELECT e.src_doc AS srcDoc, d.path AS srcPath, e.src_block AS srcBlock,
              e.predicate AS predicate, e.provenance AS provenance, e.dst_kind AS dstKind,
              e.dst_node AS dstNode, e.anchor AS anchor
       FROM edges e
       JOIN docs d ON d.doc_id = e.src_doc
       WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL
         AND e.dst_node LIKE 'phantom:%' ${globSql}
       ORDER BY d.path, e.dst_node, e.src_block
       LIMIT ?`,
    )
    .all(...params, limit + 1) as {
    srcDoc: string; srcPath: string; srcBlock: string | null; predicate: string;
    provenance: string; dstKind: string; dstNode: string; anchor: string | null;
  }[];

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  // Recover the destination AS AUTHORED from the block's projected link nodes:
  // the edge index keeps only the canonical target, but md:link / md:wikilink /
  // md:inline_field nodes carry the exact destination text. Pick the node whose
  // canonical (path, fragment) equals this edge's (target, anchor).
  const nodeStmt = store.db.prepare(
    "SELECT kind, value FROM nodes WHERE block_id = ? AND kind IN ('md:link','md:wikilink','md:inline_field') AND value IS NOT NULL",
  );
  const authoredFor = (srcBlock: string | null, srcPath: string, target: string, anchor: string | null): string | null => {
    if (srcBlock === null) return null;
    const docDir = docDirOf(srcPath);
    for (const n of nodeStmt.all(srcBlock) as { kind: string; value: string }[]) {
      let dest = n.value;
      if (n.kind === "md:inline_field") {
        const wl = /^\[\[([^\]]+)\]\]$/.exec(dest);
        if (wl) dest = wl[1]!;
        else if (!dest.startsWith("/")) continue;
      }
      if (n.kind === "md:wikilink") dest = dest.split("|")[0]!;
      const { path, fragment } = splitDestination(dest);
      if (canonicalLinkPath(path, docDir) !== target) continue;
      if ((fragment === "" ? null : fragment.slice(1)) !== anchor) continue;
      return dest;
    }
    return null;
  };

  const stale: StaleLink[] = page.map((r) => {
    // Strip the "phantom:" prefix to expose the canonical path.
    const target = r.dstNode.slice("phantom:".length);
    return {
      srcDoc: r.srcDoc,
      srcPath: r.srcPath,
      srcBlock: r.srcBlock,
      predicate: r.predicate,
      provenance: r.provenance,
      dstKind: r.dstKind,
      target,
      authored: authoredFor(r.srcBlock, r.srcPath, target, r.anchor),
      anchor: r.anchor,
      // All phantom targets are dangling DOCUMENTS in this data model (cross-doc
      // block refs collapse to document phantoms carrying an anchor). We tag rows
      // that also carry an anchor as such, but the miss is still a missing doc.
      reason: "dangling_doc",
    };
  });

  return {
    stale,
    externalCount: totals.external ?? 0,
    totalOpenEdges: totals.total,
    truncated,
  };
}
