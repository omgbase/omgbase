import type { Store } from "../core/store/store.js";
import { findDocByRef } from "../core/read/reader.js";
import { isValidId } from "../core/ids.js";

// History surface (06 §3, 07 task 4.4): history_node (block/doc biography),
// diff (block-grain + unified), changes_since (commit digests / change feed).

export interface NodeChange {
  commitId: string;
  seq: number;
  ts: string;
  origin: string;
  kind: string;
  confidence: number | null;
  reason: string | null;
}

/** history_node: a block's biography from block_changes + commits (06 §3). */
export function historyNode(store: Store, blockId: string, opts: { limit?: number } = {}): NodeChange[] {
  const limit = opts.limit ?? 100;
  return store.db
    .prepare(
      `SELECT bc.commit_id AS commitId, c.seq AS seq, c.ts AS ts, c.origin AS origin, bc.kind AS kind,
              d.confidence AS confidence, d.reason AS reason
       FROM block_changes bc
       JOIN commits c ON c.commit_id = bc.commit_id
       LEFT JOIN dispositions d ON d.commit_id = bc.commit_id AND d.block_id = bc.block_id AND d.kind = bc.kind
       WHERE bc.block_id = ?
       ORDER BY c.seq DESC
       LIMIT ?`,
    )
    .all(blockId, limit) as NodeChange[];
}

export interface DiffEntry {
  kind: "added" | "removed" | "changed" | "unchanged";
  blockId: string;
  before?: string;
  after?: string;
}

// Block-grain diff between two revisions of a document: compare block id → raw.
export function diffBlocks(store: Store, docId: string, fromRev: string, toRev: string): DiffEntry[] {
  const at = (rev: string): Map<string, string> => blocksAtRevision(store, docId, rev);
  const before = at(fromRev);
  const after = at(toRev);
  const entries: DiffEntry[] = [];
  for (const [id, raw] of before) {
    if (!after.has(id)) entries.push({ kind: "removed", blockId: id, before: raw });
    else if (after.get(id) !== raw) entries.push({ kind: "changed", blockId: id, before: raw, after: after.get(id)! });
  }
  for (const [id, raw] of after) if (!before.has(id)) entries.push({ kind: "added", blockId: id, after: raw });
  return entries;
}

// Reconstruct the (block id → raw) map for a document at a revision by walking
// its Merkle tree from the revision's root_tree. Recurses into child subtrees so
// the map spans every block (roots + nested), which block-grain diff compares.
// NOTE: the persisted tree-node entry is a six-field canonical tuple (see
// core/hash.ts serializeTreeEntries): [blockId, rawHashHex, childTreeHashHex,
// type, attrs, triviaHashHex]. Diff needs only the first three; whole-document
// byte-faithful reconstruction (which also needs trivia + top-level order) lives
// in core/read/document.ts readDocumentAtRevision.
function blocksAtRevision(store: Store, docId: string, revId: string): Map<string, string> {
  const rev = store.db.prepare("SELECT root_tree FROM revisions WHERE rev_id = ? AND doc_id = ?").get(revId, docId) as { root_tree: Buffer } | undefined;
  const out = new Map<string, string>();
  if (!rev) return out;
  const blob = store.db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const treeNode = store.db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?");
  const walk = (treeHashHex: string): void => {
    const node = treeNode.get(Buffer.from(treeHashHex, "hex")) as { entries: string } | undefined;
    if (!node) return;
    const entries = JSON.parse(node.entries) as [string, string, string | null, string, Record<string, unknown>, string | null][];
    for (const [blockId, rawHashHex, childHashHex] of entries) {
      const raw = (blob.get(Buffer.from(rawHashHex, "hex")) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "";
      out.set(blockId, raw);
      if (childHashHex) walk(childHashHex);
    }
  };
  walk(rev.root_tree.toString("hex"));
  return out;
}

/** Unified textual diff (line-based) between two revisions' rendered files. */
export function diffUnified(store: Store, docId: string, fromRev: string, toRev: string): string {
  const rendered = (rev: string): string => {
    const map = blocksAtRevision(store, docId, rev);
    return [...map.values()].join("\n");
  };
  const a = rendered(fromRev).split("\n");
  const b = rendered(toRev).split("\n");
  // Minimal line diff (not a full Myers; sufficient for digests/preview).
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out.join("\n");
}

export interface CommitDigest {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  /** `contentHash` (hex of the revision's rendered_hash) lets a puller decide
   *  "changed vs echo" without a follow-up docs_read/docs_history (ADR-014 §4.2). */
  revisions: { doc: string; path: string; contentHash: string }[];
}

/** changes_since: commit digests after a cursor (repo commit seq) — the change
 * feed (06 §3). */
export function changesSince(store: Store, repoId: string, opts: { cursor?: number; limit?: number; origin?: string } = {}): { digests: CommitDigest[]; cursor: number; truncated: boolean } {
  const cursor = opts.cursor ?? 0;
  const limit = opts.limit ?? 50;
  const originClause = opts.origin ? "AND origin = ?" : "";
  const params: unknown[] = [repoId, cursor];
  if (opts.origin) params.push(opts.origin);
  params.push(limit + 1);

  const commits = store.db
    .prepare(`SELECT commit_id, seq, ts, origin, actor FROM commits WHERE repo_id = ? AND seq > ? ${originClause} ORDER BY seq LIMIT ?`)
    .all(...params) as { commit_id: string; seq: number; ts: string; origin: string; actor: string | null }[];

  const truncated = commits.length > limit;
  const page = commits.slice(0, limit);

  const digests: CommitDigest[] = page.map((c) => {
    const revs = (store.db.prepare("SELECT r.doc_id AS doc, r.path AS path, r.rendered_hash AS rendered_hash FROM revisions r WHERE r.commit_id = ?").all(c.commit_id) as { doc: string; path: string; rendered_hash: Buffer }[]).map((r) => ({ doc: r.doc, path: r.path, contentHash: r.rendered_hash.toString("hex") }));
    const dispCounts = store.db.prepare("SELECT kind, count(*) n FROM dispositions WHERE commit_id = ? GROUP BY kind").all(c.commit_id) as { kind: string; n: number }[];
    const summary = renderSummary(c.origin, c.actor, revs, dispCounts);
    return { commit: c.commit_id, seq: c.seq, ts: c.ts, origin: c.origin, actor: c.actor, summary, revisions: revs };
  });

  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { digests, cursor: nextCursor, truncated };
}

// ---- doc_history: version-history listing (document-centric) ----------------
// changesSince above is a repo-wide COMMIT feed; docHistory is its per-DOCUMENT
// complement: "list every stored version of the docs under journal/*" and get,
// grouped by document, each doc's ordered revision list. Pairs with
// readDocumentAtRevision (docs_read_at) — feed a returned `rev` into it to
// reconstruct that whole version, or into diffBlocks to compare two revs.

/** One stored version (revision) of a document. */
export interface DocVersion {
  rev: string;
  seq: number;
  commit: string;
  ts: string;
  origin: string;
  actor: string | null;
  /** hex of the revision's rendered_hash — spot no-op vs real change, feed into docs_read_at/diff. */
  contentHash: string;
  /** true when this rev == the doc's current_rev. */
  isCurrent: boolean;
}

/** A matching document with its ordered version history. */
export interface DocVersions {
  docId: string;
  path: string;
  deleted: boolean;
  currentRev: string | null;
  versions: DocVersion[];
}

interface DocRow {
  doc_id: string;
  path: string;
  current_rev: string | null;
  deleted_commit: string | null;
}

/**
 * docHistory: the version history of matching documents, grouped by document.
 *
 * - `doc` (id OR path): list that single document's versions. Resolves via
 *   findDoc for non-deleted docs; falls back to a direct docs lookup (by id or
 *   repo+path) so `includeDeleted` can surface a tombstoned doc's history too.
 * - `pathGlob`: match docs.path with the SAME LIKE conversion as within()
 *   (compileWithin): escape %/_ then map `*`→SQL `%`. So `journal/*` and
 *   `journal/**` both become `journal/%`; `*` matches ACROSS `/` (there is no
 *   distinct single-segment wildcard in this dialect), consistent with within().
 * - By default only NON-deleted docs (deleted_commit IS NULL). includeDeleted:
 *   true also returns tombstoned docs, whose past versions remain valuable for
 *   audit (a deleted journal file's history is intact).
 *
 * Docs are ordered by path (ascending). Versions within a doc are ordered by
 * seq ASCENDING (chronological — reads as a timeline). `limit` (default 50)
 * caps the number of DOCUMENTS returned (not revisions); `truncated` is set
 * when more matching docs existed.
 */
export function docHistory(
  store: Store,
  repoId: string,
  opts: { pathGlob?: string; doc?: string; includeDeleted?: boolean; limit?: number } = {},
): { docs: DocVersions[]; truncated: boolean } {
  const limit = opts.limit ?? 50;
  const includeDeleted = opts.includeDeleted ?? false;

  let docRows: DocRow[];
  if (opts.doc) {
    const row = resolveDocRow(store, repoId, opts.doc, includeDeleted);
    docRows = row ? [row] : [];
  } else if (opts.pathGlob) {
    const deletedClause = includeDeleted ? "" : "AND deleted_commit IS NULL";
    const params: unknown[] = [repoId];
    let pathClause: string;
    if (opts.pathGlob.includes("*")) {
      const like = opts.pathGlob.replace(/[%_]/g, "\\$&").replace(/\*/g, "%");
      pathClause = "path LIKE ? ESCAPE '\\'";
      params.push(like);
    } else {
      pathClause = "path = ?";
      params.push(opts.pathGlob);
    }
    params.push(limit + 1);
    docRows = store.db
      .prepare(`SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ? AND ${pathClause} ${deletedClause} ORDER BY path LIMIT ?`)
      .all(...params) as DocRow[];
  } else {
    throw new Error("docHistory requires one of { doc, pathGlob }");
  }

  const truncated = docRows.length > limit;
  const page = docRows.slice(0, limit);

  const revStmt = store.db.prepare(
    `SELECT r.rev_id AS rev, r.seq AS seq, r.commit_id AS commitId, r.rendered_hash AS rendered_hash,
            c.ts AS ts, c.origin AS origin, c.actor AS actor
     FROM revisions r JOIN commits c ON c.commit_id = r.commit_id
     WHERE r.doc_id = ? ORDER BY r.seq ASC`,
  );

  const docs: DocVersions[] = page.map((d) => {
    const rows = revStmt.all(d.doc_id) as {
      rev: string; seq: number; commitId: string; rendered_hash: Buffer; ts: string; origin: string; actor: string | null;
    }[];
    const versions: DocVersion[] = rows.map((r) => ({
      rev: r.rev,
      seq: r.seq,
      commit: r.commitId,
      ts: r.ts,
      origin: r.origin,
      actor: r.actor,
      contentHash: r.rendered_hash.toString("hex"),
      isCurrent: r.rev === d.current_rev,
    }));
    return { docId: d.doc_id, path: d.path, deleted: d.deleted_commit !== null, currentRev: d.current_rev, versions };
  });

  return { docs, truncated };
}

// Resolve a `doc` ref (id or path) to a docs row. Prefers findDoc (live docs);
// when includeDeleted is set and findDoc misses (a tombstoned doc), falls back
// to a direct lookup that ignores the deleted_commit filter.
function resolveDocRow(store: Store, repoId: string, ref: string, includeDeleted: boolean): DocRow | undefined {
  const info = findDocByRef(store, repoId, ref);
  if (info) {
    return store.db.prepare("SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE doc_id = ?").get(info.docId) as DocRow | undefined;
  }
  if (!includeDeleted) return undefined;
  // findDocByRef filters deleted docs; for includeDeleted, look through the
  // tombstone using the SAME id-or-path dispatch (isValidId, not a "d_" prefix).
  const asId = isValidId(ref, "d");
  const stmt = asId
    ? store.db.prepare("SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE doc_id = ?")
    : store.db.prepare("SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ? AND path = ?");
  return (asId ? stmt.get(ref) : stmt.get(repoId, ref)) as DocRow | undefined;
}

function renderSummary(origin: string, actor: string | null, revs: { path: string }[], disp: { kind: string; n: number }[]): string {
  const paths = revs.map((r) => r.path).join(", ");
  const parts = disp.filter((d) => d.kind !== "same").map((d) => `${d.n} ${d.kind}`);
  const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  if (origin === "api" || origin === "import") return `${origin}(${actor ?? "?"}): ${paths}${detail}`;
  return `observed: ${paths}${detail}`;
}
