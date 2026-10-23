// History through the `revisions` target (spec/surface §1.1–§1.2, 4.7; the 5.0
// spelling): one row per stored revision of every document, deleted documents
// included — `{ _id (= _rev), _path (as of the revision), _rev, _seq, _doc_id,
// _commit, _ts, _origin, _actor, _reason, _hash, _is_current }` (every name
// engine-provided, so `_`-prefixed; a revision carries no authored data), `_doc`
// reaching the document's CURRENT row (absent for a deleted one). A document's
// chronology:
//
//   revisions { select _rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id where _doc_id == "<id>" order by _seq desc }
//
// by `_doc_id` rather than `_path` because a move re-paths only the current
// revision (the earlier ones keep the old path) — by path, a moved document
// would lose its past. The body as of a revision is `docs_read { _id, at: rev }`
// (document.ts). Deleted documents:
//
//   revisions { select … where _doc == null order by _ts desc, _seq desc }
//
// — listable, but NOT readable: `docs_read { at }` needs a live document
// (doc_missing otherwise), so the list says so instead of pretending.

import { type Caller } from "./mcp-client.ts";
import { hitId, hitPath, rooted } from "./paths.ts";
import { queryAll, runQuery } from "./query.ts";

export interface RevisionRow {
  /** The revision id (`r_…`). */
  rev: string;
  /** The document's path as of the revision (rooted). */
  path: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  reason: string | null;
  hash: string;
  isCurrent: boolean;
  docId: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export const REVISION_FIELDS = "_rev, _seq, _ts, _origin, _actor, _reason, _hash, _is_current, _doc_id";

export function revisionsQuery(docId: string): string {
  return `revisions { select ${REVISION_FIELDS} where _doc_id == ${JSON.stringify(docId)} order by _seq desc }`;
}

/** The same chronology by the document's current path (for a document known by path only). */
export function revisionsByPathQuery(path: string): string {
  return `revisions { select ${REVISION_FIELDS} where _doc._path == ${JSON.stringify(rooted(path))} order by _seq desc }`;
}

export function deletedRevisionsQuery(): string {
  return `revisions { select ${REVISION_FIELDS} where _doc == null order by _ts desc, _seq desc }`;
}

export function revisionOf(hit: Record<string, unknown>): RevisionRow | null {
  const id = hitId(hit);
  const path = hitPath(hit);
  if (id === null || path === null) return null;
  return {
    rev: str(hit._rev) || id,
    path: rooted(path),
    seq: num(hit._seq),
    ts: str(hit._ts),
    origin: str(hit._origin),
    actor: strOrNull(hit._actor),
    reason: strOrNull(hit._reason),
    hash: str(hit._hash),
    isCurrent: hit._is_current === true,
    docId: strOrNull(hit._doc_id),
  };
}

export function revisionsOf(hits: readonly Record<string, unknown>[]): RevisionRow[] {
  return hits.map(revisionOf).filter((r): r is RevisionRow => r !== null);
}

/** A document's revisions, newest first (the query orders them; a custom order
 * has no cursor, so the top page — up to `limit` — is what there is). */
export async function fetchRevisions(caller: Caller, docId: string, repo: string | null, limit = 200): Promise<RevisionRow[]> {
  const r = await runQuery(caller, revisionsQuery(docId), { repo, limit });
  return revisionsOf(r.hits);
}

export interface DeletedDoc {
  docId: string;
  /** The path of its latest revision. */
  path: string;
  revisions: RevisionRow[];
}

/** The deleted documents' revisions grouped by document (the query's order kept: newest first). */
export function groupDeleted(rows: readonly RevisionRow[]): DeletedDoc[] {
  const byDoc = new Map<string, DeletedDoc>();
  for (const r of rows) {
    const key = r.docId ?? r.path;
    const d = byDoc.get(key);
    if (d) d.revisions.push(r);
    else byDoc.set(key, { docId: r.docId ?? "", path: r.path, revisions: [r] });
  }
  return [...byDoc.values()];
}

export async function fetchDeleted(caller: Caller, repo: string | null, limit = 500): Promise<DeletedDoc[]> {
  const r = await runQuery(caller, deletedRevisionsQuery(), { repo, limit });
  return groupDeleted(revisionsOf(r.hits));
}

/** The previous revision of `rev` in a newest-first list (what a diff of `rev` is against); null for the first. */
export function previousOf(rows: readonly RevisionRow[], rev: string): RevisionRow | null {
  const i = rows.findIndex((r) => r.rev === rev);
  if (i < 0) return null;
  return rows[i + 1] ?? null;
}

/** Who made a revision, once: `origin · actor`, the origin alone without an actor, the actor alone when it carries the origin. */
export function byline(r: Pick<RevisionRow, "origin" | "actor">): string {
  if (!r.actor) return r.origin;
  if (r.actor === r.origin || r.actor.startsWith(`${r.origin}:`)) return r.actor;
  return `${r.origin} · ${r.actor}`;
}

/** Why `queryAll` is not used above: a custom `order by` returns the top page
 * only (no cursor). This fetches every revision of a document when there may be
 * more than a page: the default keyset order (by path, then rev id) with the
 * client sorting by `_seq`. */
export async function fetchAllRevisions(caller: Caller, docId: string, repo: string | null): Promise<RevisionRow[]> {
  const hits = await queryAll(caller, `revisions { select ${REVISION_FIELDS} where _doc_id == ${JSON.stringify(docId)} }`, repo);
  return revisionsOf(hits).sort((a, b) => b.seq - a.seq);
}
