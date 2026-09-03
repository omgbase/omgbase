import type { Store } from "../core/store/store.js";

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
// its Merkle tree from the revision's root_tree.
function blocksAtRevision(store: Store, docId: string, revId: string): Map<string, string> {
  const rev = store.db.prepare("SELECT root_tree FROM revisions WHERE rev_id = ? AND doc_id = ?").get(revId, docId) as { root_tree: Buffer } | undefined;
  const out = new Map<string, string>();
  if (!rev) return out;
  const blob = store.db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const treeNode = store.db.prepare("SELECT entries FROM tree_nodes WHERE hash = ?");
  const walk = (treeHashHex: string): void => {
    const node = treeNode.get(Buffer.from(treeHashHex, "hex")) as { entries: string } | undefined;
    if (!node) return;
    const entries = JSON.parse(node.entries) as [string, string, string | null, string, string, string | null][];
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
  revisions: { doc: string; path: string }[];
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
    const revs = store.db.prepare("SELECT r.doc_id AS doc, r.path AS path FROM revisions r WHERE r.commit_id = ?").all(c.commit_id) as { doc: string; path: string }[];
    const dispCounts = store.db.prepare("SELECT kind, count(*) n FROM dispositions WHERE commit_id = ? GROUP BY kind").all(c.commit_id) as { kind: string; n: number }[];
    const summary = renderSummary(c.origin, c.actor, revs, dispCounts);
    return { commit: c.commit_id, seq: c.seq, ts: c.ts, origin: c.origin, actor: c.actor, summary, revisions: revs };
  });

  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { digests, cursor: nextCursor, truncated };
}

function renderSummary(origin: string, actor: string | null, revs: { path: string }[], disp: { kind: string; n: number }[]): string {
  const paths = revs.map((r) => r.path).join(", ");
  const parts = disp.filter((d) => d.kind !== "same").map((d) => `${d.n} ${d.kind}`);
  const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  if (origin === "api" || origin === "import") return `${origin}(${actor ?? "?"}): ${paths}${detail}`;
  return `observed: ${paths}${detail}`;
}
