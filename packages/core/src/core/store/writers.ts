import type { Database } from "better-sqlite3";
import { sha256, serializeTreeEntries, type TreeEntry } from "../hash.js";
import { mintId } from "../ids.js";
import type { RawBlock } from "../parse/types.js";
import type { CommitRecord } from "../capabilities/types.js";
import {
  byteLength, encodeBodyDelta, encodeFrontmatterDelta, entryText, fullNodeText, isCheckpointSeq, type Entry, type ResolvedList, type ResolvedTree,
} from "./delta.js";

// The RECORDER's immutable writers (spec/store §4′, §5.4 step 15 — 17.0):
// blobs, tree nodes, the commit and revision rows (the commit row since 3d is
// the log's copy of the core's feed row — `recordCommit`; the core mints `c`
// and writes `feed`, `core/store/feed.ts`). Since store 17.0 the
// current-state ingest writes a block's bytes on its own row (`blocks.raw`/
// `trivia`, `docs.frontmatter_raw`) and never calls these; `putBlob` is
// reached only through `writeList`/`writeFrontmatterBlob`, i.e. the default
// `HistoryRecorder`'s capture — so with legacy capture on the head's bytes
// are stored twice, as the contracts accept (D10). Blobs and tree nodes are
// content-addressed; INSERT OR IGNORE gives deduplication and structural
// sharing for free (identical subtrees hash identically → no new row). Only
// `assignIds`/`TreeInputBlock` are the current-state parts of this module.

/** A block with a minted/assigned id, ready to encode into the tree. */
export interface TreeInputBlock {
  blockId: string;
  type: string;
  raw: string;
  trivia: string;
  attrs: Record<string, unknown>;
  children: TreeInputBlock[];
  /** The parsed block's source span, when the tree came from a parse — what
   *  `ownText` (spec/properties §3.2) uses to blank a container's children. */
  span?: { start: number; end: number };
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
    span: b.span,
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

/** Content-address a node's text (a `[`-form or a `{"d":…}` delta, spec/store §4.1); returns hex hash. Dedups. */
export function putNodeText(db: Database, text: string): string {
  const hash = sha256(text);
  db.prepare("INSERT OR IGNORE INTO tree_nodes (hash, entries) VALUES (?, ?)").run(hash, text);
  return hash.toString("hex");
}

/** Content-address a tree node's entries (full form); returns hex hash. Dedups. */
export function putTreeNode(db: Database, entries: TreeEntry[]): string {
  return putNodeText(db, serializeTreeEntries(entries));
}

/**
 * The revision context a tree is written in (spec/store §4.4, 16.0): the
 * previous revision's resolved tree (`null` when there is none, or it is
 * archived — then every node is full), and whether this revision is a
 * checkpoint. Without a context `writeBlockTree` writes 15.x full nodes.
 */
export interface TreeWriteContext {
  base: ResolvedTree | null;
  checkpoint: boolean;
}

/** spec/store §4.4: a revision is a checkpoint by cadence, or when it has no live predecessor. */
export function isCheckpointRevision(seq: number, previous: { archive: string | null } | undefined): boolean {
  return isCheckpointSeq(seq) || previous === undefined || previous.archive !== null;
}

/**
 * Encode a list of sibling blocks into Merkle tree nodes bottom-up, writing
 * blobs (raw + trivia) and child nodes. Returns the root node's hex hash.
 * Structural sharing: an unchanged subtree whose base node is self-contained
 * is not re-written (the base's hash is reused); otherwise, in a non-checkpoint
 * revision, a list is written as the smaller of its delta against the same
 * list of the previous revision and its full form (spec/store §4.1, §4.4).
 */
export function writeBlockTree(db: Database, blocks: TreeInputBlock[], ctx?: TreeWriteContext): string {
  const context: TreeWriteContext = ctx ?? { base: null, checkpoint: true };
  return writeList(db, blocks, null, context);
}

function writeList(db: Database, blocks: TreeInputBlock[], parent: string | null, ctx: TreeWriteContext): string {
  const texts: string[] = blocks.map((b) => {
    const rawHashHex = putBlob(db, b.raw);
    const triviaHashHex = b.trivia.length > 0 ? putBlob(db, b.trivia) : null;
    const childTreeHashHex = b.children.length > 0 ? writeList(db, b.children, b.blockId, ctx) : null;
    const entry: Entry = [b.blockId, rawHashHex, childTreeHashHex, b.type, b.attrs, triviaHashHex];
    return entryText(entry);
  });
  const full = fullNodeText(texts);
  const base: ResolvedList | undefined = ctx.base ? (parent === null ? ctx.base.root : ctx.base.byBlock.get(parent)) : undefined;
  // An unchanged list reuses the base's node only when that node is context-free.
  if (base && base.selfContained && sameTexts(base.texts, texts)) return base.hash;
  if (ctx.checkpoint || !base) return putNodeText(db, full);
  const delta = encodeBodyDelta(base.texts, texts);
  return putNodeText(db, byteLength(delta) < byteLength(full) ? delta : full);
}

function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The frontmatter blob of a revision (spec/store §5.4 step 1, 16.0): the raw
 * itself at a checkpoint or when the previous revision had none; else the
 * smaller of the line delta against the previous raw and the raw. Returns the
 * blob's hex hash.
 */
export function writeFrontmatterBlob(db: Database, raw: string, baseRaw: string | null, checkpoint: boolean): string {
  if (checkpoint || baseRaw === null) return putBlob(db, raw);
  const delta = encodeFrontmatterDelta(baseRaw, raw);
  return putBlob(db, byteLength(delta) < byteLength(raw) ? delta : raw);
}

/**
 * The recorder's `commits` row (spec/store §3.1, 17.0 — 3d): the log's copy of
 * a feed row the core appended (`core/store/feed.ts`), under the same
 * `commit_id`, `epoch` and `seq`, plus `ops` — the ADR-003 intent record of an
 * effect-driven api commit, which only the recorder keeps (M5).
 */
export function recordCommit(db: Database, c: CommitRecord): void {
  db.prepare(
    `INSERT INTO commits (commit_id, repo_id, epoch, seq, ts, origin, actor, reason, batch_id, ops)
     VALUES (@commitId, @repoId, @epoch, @seq, @ts, @origin, @actor, @reason, @batchId, @ops)`,
  ).run({ commitId: c.commitId, repoId: c.repoId, epoch: c.epoch, seq: c.seq, ts: c.ts, origin: c.origin, actor: c.actor, reason: c.reason, batchId: c.batchId, ops: c.ops });
}

export interface NewRevisionInput {
  /** The head token the core minted for this transition (spec/store §5.4 step 6, 17.0 D1) — the row's `rev_id`. */
  revId: string;
  docId: string;
  rootTreeHex: string;
  frontmatterBlobHex: string | null;
  renderedHash: Buffer;
  path: string;
  commitId: string;
  /** The per-document seq when the caller computed it already (ingest needs it before the tree is written); `1 + max(seq)` otherwise. */
  seq?: number;
}

/** The previous revision of a document (its greatest seq), or undefined — the base a delta is written against. */
export function previousRevision(db: Database, docId: string): { rev_id: string; seq: number; root_tree: Buffer | null; frontmatter_blob: Buffer | null; archive: string | null } | undefined {
  return db
    .prepare("SELECT rev_id, seq, root_tree, frontmatter_blob, archive FROM revisions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1")
    .get(docId) as { rev_id: string; seq: number; root_tree: Buffer | null; frontmatter_blob: Buffer | null; archive: string | null } | undefined;
}

/** Append a revision under the core's head token; assigns the per-document monotonic seq. */
export function writeRevision(db: Database, input: NewRevisionInput): { revId: string; seq: number } {
  const revId = input.revId;
  const seq = input.seq ?? (db
    .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM revisions WHERE doc_id = ?")
    .get(input.docId) as { seq: number }).seq;
  db.prepare(
    `INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id)
     VALUES (@revId, @docId, @seq, @rootTree, @frontmatterBlob, @renderedHash, @path, @commitId)`,
  ).run({
    revId,
    docId: input.docId,
    seq,
    rootTree: Buffer.from(input.rootTreeHex, "hex"),
    frontmatterBlob: input.frontmatterBlobHex ? Buffer.from(input.frontmatterBlobHex, "hex") : null,
    renderedHash: input.renderedHash,
    path: input.path,
    commitId: input.commitId,
  });
  return { revId, seq };
}
