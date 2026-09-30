import type { Store } from "../core/store/store.js";
import { findDocByRef } from "../core/read/reader.js";
import { readDocumentAtRevision } from "../core/read/document.js";
import { isValidId } from "../core/ids.js";
import { EngineError } from "../mcp/errors.js";

// History surface (06 §3, 07 task 4.4): history_node (block/doc biography),
// diff (block-grain + Myers unified), changes_since (commit digests / change feed).

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

/** A `rev` that names no revision of the document (spec/surface §3: both sides of a diff must exist). The MCP layer maps it to `target_missing` with `{ doc, rev }`. */
export class RevisionNotFound extends Error {
  constructor(public readonly docId: string, public readonly rev: string) {
    super(`no revision ${JSON.stringify(rev)} for document ${docId}`);
    this.name = "RevisionNotFound";
  }
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
// in core/read/document.ts readDocumentAtRevision. This map is NOT a rendering
// of the document: a container's raw already holds its children's text, so
// joining the values would repeat every nested block (spec/surface §9).
function blocksAtRevision(store: Store, docId: string, revId: string): Map<string, string> {
  const rev = store.db.prepare("SELECT root_tree FROM revisions WHERE rev_id = ? AND doc_id = ?").get(revId, docId) as { root_tree: Buffer } | undefined;
  if (!rev) throw new RevisionNotFound(docId, revId);
  const out = new Map<string, string>();
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

/**
 * `diff_unified` (spec/surface §3): a unified diff of the two revisions'
 * **reconstructed file text** — exactly the bytes `docs_read_at` returns for
 * each revision ({@link readDocumentAtRevision}: frontmatter, trivia and
 * top-level order included) — via {@link unifiedDiff}, so hunk line numbers
 * are real file lines. Until 1.4.x this diffed the Merkle-tree walk (every
 * live raw at every depth joined by `\n`), which repeated each nested block
 * after its container's raw and put an appended list item before the list's
 * first item (§9). An unknown revision is {@link RevisionNotFound}.
 */
export function diffUnified(store: Store, docId: string, fromRev: string, toRev: string): string {
  const rendered = (rev: string): string => {
    const at = readDocumentAtRevision(store, docId, rev);
    if (!at) throw new RevisionNotFound(docId, rev);
    return at.content;
  };
  return unifiedDiff(rendered(fromRev), rendered(toRev));
}

/** The `diff_unified` tool's result (spec/surface §3): the resolved revision pair and the diff. */
export interface DocDiffUnified {
  doc: string;
  path: string;
  from: string;
  to: string;
  diff: string;
}

/**
 * `diff_unified` over a resolved document: `to` defaults to the current revision,
 * `from` to the one before it (or the current one again when there is only one:
 * an empty diff). Shared by the MCP tool and `omg diff` so the shape cannot
 * drift. `label` is how the caller named the document, for the error message.
 * A document with no revision at all is `target_missing`; an unknown `rev` is
 * `RevisionNotFound` (→ `target_missing` through `errorBody`).
 */
export function docDiffUnified(store: Store, docId: string, opts: { fromRev?: string; toRev?: string; label?: string } = {}): DocDiffUnified {
  const revs = store.db
    .prepare("SELECT rev_id FROM revisions WHERE doc_id = ? ORDER BY seq DESC LIMIT 2")
    .all(docId) as { rev_id: string }[];
  const to = opts.toRev ?? revs[0]?.rev_id;
  const from = opts.fromRev ?? revs[1]?.rev_id ?? revs[0]?.rev_id;
  if (!to || !from) throw new EngineError("target_missing", `no revisions to diff for ${opts.label ?? docId}`);
  const path = (store.db.prepare("SELECT path FROM docs WHERE doc_id = ?").get(docId) as { path: string } | undefined)?.path ?? "";
  return { doc: docId, path, from, to, diff: diffUnified(store, docId, from, to) };
}

// ---- unified diff (spec/surface §3) ------------------------------------------
// A line-grain unified diff with a deterministic Myers script, so both engines
// (this reference and crates/omgbase-surface/src/history.rs) produce the same
// bytes for the same two texts. Kept pure so it can be pinned by unit tests.

/** How each text becomes lines: `split("\n")` exactly — no trimming, no
 * dropping of a trailing empty element (a raw ending in `\n` yields one) — with
 * a single special case: the empty text has *no* lines (an empty file is zero
 * lines, not one empty line), so a diff from/to nothing is `@@ -0,0 +1,n @@`. */
export function diffLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

const DIFF_CONTEXT = 3;

/** One step of the edit script: `keep` consumes a line from both sides,
 * `delete` one from the old text, `insert` one from the new text. */
export interface EditOp {
  kind: "keep" | "delete" | "insert";
  line: string;
}

/**
 * Myers' O(ND) shortest edit script (forward, with a per-`d` trace for the
 * backtrack). `V[k]` is the furthest x on diagonal `k = x - y` reachable with
 * `d` edits. The canonical tie rule, identical in both engines: at each step
 * take the diagonal from `k+1` (moving down — an insertion of `b[y]`) when
 * `k == -d || (k != d && V[k-1] < V[k+1])`, else from `k-1` (moving right —
 * a deletion of `a[x]`). On a tie (`V[k-1] == V[k+1]`) that is the deletion.
 */
export function myersScript(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // V is indexed by k ∈ [-max-1, max+1]; `off` maps it onto a plain array.
  const off = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  const trace: number[][] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack from (n, m) through the trace, emitting ops newest-first.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "keep", line: a[x]! });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "insert", line: b[prevY]! });
      else ops.push({ kind: "delete", line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

/**
 * The unified diff of two texts (spec/surface §3): hunks of `DIFF_CONTEXT` (3)
 * lines of context; a change group extends to include the next change when
 * fewer than `2 * DIFF_CONTEXT + 1` unchanged lines separate them (the two
 * contexts touch or overlap). Each hunk is `@@ -a,b +c,d @@` (1-based start
 * and length; a length of 1 is written as the start alone; a length of 0 as
 * `a,0` with `a` the line before the insertion point, `0` at the very top)
 * followed by its lines prefixed `-`, `+` or a space with nothing after the
 * sign; hunks joined by `\n`; no file header; identical texts → `""`.
 */
export function unifiedDiff(oldText: string, newText: string): string {
  const ops = myersScript(diffLines(oldText), diffLines(newText));
  // Old/new line counts consumed before each op (0-based positions).
  const oldPos: number[] = new Array(ops.length + 1);
  const newPos: number[] = new Array(ops.length + 1);
  let o = 0;
  let nn = 0;
  for (let i = 0; i < ops.length; i++) {
    oldPos[i] = o;
    newPos[i] = nn;
    if (ops[i]!.kind !== "insert") o++;
    if (ops[i]!.kind !== "delete") nn++;
  }
  oldPos[ops.length] = o;
  newPos[ops.length] = nn;

  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.kind !== "keep") changes.push(i);
  if (changes.length === 0) return "";

  const hunks: string[] = [];
  let g = 0;
  while (g < changes.length) {
    const first = changes[g]!;
    let last = first;
    // Merge rule: the next change joins this hunk iff the unchanged lines
    // between them number at most 2 * DIFF_CONTEXT.
    while (g + 1 < changes.length && changes[g + 1]! - last - 1 <= 2 * DIFF_CONTEXT) {
      g++;
      last = changes[g]!;
    }
    g++;
    const start = Math.max(0, first - DIFF_CONTEXT);
    const end = Math.min(ops.length - 1, last + DIFF_CONTEXT);
    const oldLen = oldPos[end + 1]! - oldPos[start]!;
    const newLen = newPos[end + 1]! - newPos[start]!;
    const range = (pos: number, len: number): string => {
      const startLine = len === 0 ? pos : pos + 1;
      return len === 1 ? `${startLine}` : `${startLine},${len}`;
    };
    const lines = [`@@ -${range(oldPos[start]!, oldLen)} +${range(newPos[start]!, newLen)} @@`];
    for (let i = start; i <= end; i++) {
      const op = ops[i]!;
      lines.push((op.kind === "keep" ? " " : op.kind === "delete" ? "-" : "+") + op.line);
    }
    hunks.push(lines.join("\n"));
  }
  return hunks.join("\n");
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
 * feed (06 §3). `seq` is a dense per-REPO total order, so a cursor is only
 * meaningful against the repo it came from; `head` (the repo's current max seq)
 * lets a caller tell "no new changes" (cursor == head) from "cursor is beyond
 * this repo's feed" (cursor > head — e.g. a cursor from another repo/server),
 * which otherwise both look like an empty page. */
export function changesSince(store: Store, repoId: string, opts: { cursor?: number; limit?: number; origin?: string } = {}): { digests: CommitDigest[]; cursor: number; truncated: boolean; head: number } {
  const cursor = opts.cursor ?? 0;
  const head = (store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM commits WHERE repo_id = ?").get(repoId) as { head: number }).head;
  const limit = opts.limit ?? 50;
  const originClause = opts.origin ? "AND origin = ?" : "";
  const params: unknown[] = [repoId, cursor];
  if (opts.origin) params.push(opts.origin);
  params.push(limit + 1);

  const commits = store.db
    .prepare(`SELECT commit_id, seq, ts, origin, actor, reason FROM commits WHERE repo_id = ? AND seq > ? ${originClause} ORDER BY seq LIMIT ?`)
    .all(...params) as { commit_id: string; seq: number; ts: string; origin: string; actor: string | null; reason: string | null }[];

  const truncated = commits.length > limit;
  const page = commits.slice(0, limit);

  const digests: CommitDigest[] = page.map((c) => {
    const revs = (store.db.prepare("SELECT r.doc_id AS doc, r.path AS path, r.rendered_hash AS rendered_hash FROM revisions r WHERE r.commit_id = ?").all(c.commit_id) as { doc: string; path: string; rendered_hash: Buffer }[]).map((r) => ({ doc: r.doc, path: r.path, contentHash: r.rendered_hash.toString("hex") }));
    const dispCounts = store.db.prepare("SELECT kind, count(*) n FROM dispositions WHERE commit_id = ? GROUP BY kind").all(c.commit_id) as { kind: string; n: number }[];
    // A deletion or a move writes no revision: the tombstone names the commit
    // (`docs.deleted_commit`), a move only its reason (`move <from> -> <to>`).
    const deleted = revs.length === 0
      ? (store.db.prepare("SELECT path FROM docs WHERE deleted_commit = ? ORDER BY path").all(c.commit_id) as { path: string }[]).map((r) => r.path)
      : [];
    const summary = renderSummary(c.origin, c.actor, revs, dispCounts, { deleted, moved: revs.length === 0 ? parseMove(c.reason) : null });
    return { commit: c.commit_id, seq: c.seq, ts: c.ts, origin: c.origin, actor: c.actor, summary, revisions: revs };
  });

  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { digests, cursor: nextCursor, truncated, head };
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

/** The `reason` a document move records (`mutate/docs.ts`): `move <from> -> <to>`. */
function parseMove(reason: string | null): { from: string; to: string } | null {
  const m = reason === null ? null : /^move (.+) -> (.+)$/.exec(reason);
  return m ? { from: m[1]!, to: m[2]! } : null;
}

/**
 * One line per commit: `<origin>[(<actor>)]: <paths> — <n> <kind>, …`. A
 * commit that touched no revision — a document deletion (observed or api) or a
 * move — says so instead: `deleted <path>` / `moved <from> → <to>`
 * (spec/cli §6 `log`; the summary is unpinned by spec/surface).
 */
function renderSummary(
  origin: string,
  actor: string | null,
  revs: { path: string }[],
  disp: { kind: string; n: number }[],
  extra: { deleted: string[]; moved: { from: string; to: string } | null } = { deleted: [], moved: null },
): string {
  let subject = revs.map((r) => r.path).join(", ");
  if (revs.length === 0) {
    if (extra.deleted.length > 0) subject = `deleted ${extra.deleted.join(", ")}`;
    else if (extra.moved) subject = `moved ${extra.moved.from} → ${extra.moved.to}`;
  }
  const parts = disp.filter((d) => d.kind !== "same").map((d) => `${d.n} ${d.kind}`);
  const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  if (origin === "api" || origin === "import") return `${origin}(${actor ?? "?"}): ${subject}${detail}`;
  return `observed: ${subject}${detail}`;
}
