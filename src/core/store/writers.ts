import type { Database } from "better-sqlite3";
import { sha256, serializeTreeEntries, type TreeEntry } from "../hash.js";
import { mintId } from "../ids.js";
import type { RawBlock } from "../parse/types.js";

// Immutable store writers (02 §3-4, 01 §4). Blobs and tree nodes are
// content-addressed; INSERT OR IGNORE gives deduplication and structural
// sharing for free (identical subtrees hash identically → no new row).

/** A block with a minted/assigned id, ready to encode into the tree. */
export interface TreeInputBlock {
  blockId: string;
  type: string;
  raw: string;
  trivia: string;
  attrs: Record<string, unknown>;
  children: TreeInputBlock[];
}

/** Assign fresh minted ids to a parsed block tree (Stage-1 re-mint path). */
export function assignIds(blocks: RawBlock[]): TreeInputBlock[] {
  return blocks.map((b) => ({
    blockId: mintId("b"),
    type: b.type,
    raw: b.raw,
    trivia: b.trivia,
    attrs: b.attrs,
    children: assignIds(b.children),
  }));
}

/** Content-address raw text into blobs; returns hex hash. Dedups. */
export function putBlob(db: Database, text: string): string {
  const bytes = Buffer.from(text, "utf8");
  const hash = sha256(bytes);
  db.prepare("INSERT OR IGNORE INTO blobs (hash, bytes, size) VALUES (?, ?, ?)").run(
    hash,
    bytes,
    bytes.length,
  );
  return hash.toString("hex");
}

/** Content-address a tree node's entries; returns hex hash. Dedups. */
export function putTreeNode(db: Database, entries: TreeEntry[]): string {
  const serialized = serializeTreeEntries(entries);
  const hash = sha256(serialized);
  db.prepare("INSERT OR IGNORE INTO tree_nodes (hash, entries) VALUES (?, ?)").run(
    hash,
    serialized,
  );
  return hash.toString("hex");
}

/**
 * Encode a list of sibling blocks into a Merkle tree node bottom-up, writing
 * blobs (raw + trivia) and child tree nodes. Returns the node's hex hash.
 * Structural sharing: unchanged subtrees produce identical hashes and are not
 * re-inserted.
 */
export function writeBlockTree(db: Database, blocks: TreeInputBlock[]): string {
  const entries: TreeEntry[] = blocks.map((b) => {
    const rawHashHex = putBlob(db, b.raw);
    const triviaHashHex = b.trivia.length > 0 ? putBlob(db, b.trivia) : null;
    const childTreeHashHex = b.children.length > 0 ? writeBlockTree(db, b.children) : null;
    return {
      blockId: b.blockId,
      rawHashHex,
      childTreeHashHex,
      type: b.type,
      attrs: b.attrs,
      triviaHashHex,
    };
  });
  return putTreeNode(db, entries);
}

export interface NewCommitInput {
  repoId: string;
  ts: string;
  origin: "api" | "observed" | "import" | "projection";
  actor?: string | null;
  reason?: string | null;
  checkpointId?: string | null;
  ops?: string | null;
}

/** Append a commit; assigns the per-repo total-order seq. */
export function newCommit(db: Database, input: NewCommitInput): { commitId: string; seq: number } {
  const commitId = mintId("c");
  const row = db
    .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM commits WHERE repo_id = ?")
    .get(input.repoId) as { seq: number };
  db.prepare(
    `INSERT INTO commits (commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops)
     VALUES (@commitId, @repoId, @seq, @ts, @origin, @actor, @reason, @checkpointId, @ops)`,
  ).run({
    commitId,
    repoId: input.repoId,
    seq: row.seq,
    ts: input.ts,
    origin: input.origin,
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    checkpointId: input.checkpointId ?? null,
    ops: input.ops ?? null,
  });
  return { commitId, seq: row.seq };
}

export interface NewRevisionInput {
  docId: string;
  rootTreeHex: string;
  frontmatterBlobHex: string | null;
  renderedHash: Buffer;
  path: string;
  commitId: string;
}

/** Append a revision; assigns the per-document monotonic seq. */
export function writeRevision(db: Database, input: NewRevisionInput): { revId: string; seq: number } {
  const revId = mintId("r");
  const row = db
    .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM revisions WHERE doc_id = ?")
    .get(input.docId) as { seq: number };
  db.prepare(
    `INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id)
     VALUES (@revId, @docId, @seq, @rootTree, @frontmatterBlob, @renderedHash, @path, @commitId)`,
  ).run({
    revId,
    docId: input.docId,
    seq: row.seq,
    rootTree: Buffer.from(input.rootTreeHex, "hex"),
    frontmatterBlob: input.frontmatterBlobHex ? Buffer.from(input.frontmatterBlobHex, "hex") : null,
    renderedHash: input.renderedHash,
    path: input.path,
    commitId: input.commitId,
  });
  return { revId, seq: row.seq };
}
