import type { Store } from "@omgbase/core";
import { canonicalConfigJson } from "@omgbase/core";
import type { GitRepo, GitIdentity } from "./git.js";
import { parseMessage, renderMessage, type CommitTrailers } from "./trailers.js";
import type { GitHistoryConfig } from "./config.js";

// The identity record (spec/store §5.12 "The identity record", 17.6 — the
// design's option 3, second half): beside the content branch — a plain notes
// repository a customer can clone — the worker keeps a PARALLEL commit chain on
// `refs/omgbase/ids` (`config.ids_ref`) whose tree holds one blob per live
// document at `.omgbase/ids/<doc_id>`: canonical JSON
// `{ doc, head, blocks: [{ id, parent, ordinal, hash }] }` — the document's id
// and head token, its blocks in pre-order with their ids, parent ids (null at
// the top level), sibling ordinals and `raw_hash` (hex). Each ids commit
// carries the same `omgbase-seq` trailer as the checkpoint it belongs to and
// `omgbase-content: <content commit sha>` naming the content tip at that
// moment; its tree is the previous ids tree plus the touched documents' blobs
// (a deleted document's blob removed). Push and fetch carry the ref, so a
// clone of BOTH refs recovers content and identities; restoration from it is
// 6c. The chain is written AFTER the content ref moved (its own CAS), and
// catches up on resume: an ids tip whose `omgbase-seq` is behind the content
// tip's re-stages every live document once.

export const IDS_PREFIX = ".omgbase/ids/";

export interface IdsBlock {
  id: string;
  parent: string | null;
  ordinal: number;
  hash: string;
}

export interface IdsRecord {
  doc: string;
  head: string;
  blocks: IdsBlock[];
}

/** The id map of a live document from the rows, or null for a deleted/unknown one. */
export function idsRecord(store: Store, docId: string): IdsRecord | null {
  const doc = store.db.prepare("SELECT head, deleted_at FROM docs WHERE doc_id = ?").get(docId) as { head: string | null; deleted_at: string | null } | undefined;
  if (!doc || doc.deleted_at !== null || doc.head === null) return null;
  const rows = store.db
    .prepare("SELECT block_id, parent_block, ordinal, raw_hash FROM blocks WHERE doc_id = ? AND deleted_at IS NULL ORDER BY order_key")
    .all(docId) as { block_id: string; parent_block: string | null; ordinal: number; raw_hash: Buffer }[];
  return { doc: docId, head: doc.head, blocks: rows.map((r) => ({ id: r.block_id, parent: r.parent_block, ordinal: r.ordinal, hash: r.raw_hash.toString("hex") })) };
}

/** The blob's bytes: canonical JSON (keys sorted bytewise at every level, as the manifest's `config`) and a final newline. */
export function idsBlobText(record: IdsRecord): string {
  return `${canonicalConfigJson(record)}\n`;
}

export const idsPath = (docId: string): string => `${IDS_PREFIX}${docId}`;

/** The ids tip's `omgbase-seq` position, or null without a tip or with a foreign one. */
export function idsPosition(git: GitRepo, config: GitHistoryConfig): { tip: string; epoch: string; seq: number } | null {
  const tip = git.ref(config.ids_ref);
  if (tip === null) return null;
  const t = parseMessage(git.message(tip));
  return t ? { tip, epoch: t.epoch, seq: t.to } : null;
}

export interface IdsSyncInput {
  store: Store;
  repoId: string;
  git: GitRepo;
  config: GitHistoryConfig;
  identity: GitIdentity;
  /** the documents a checkpoint touched (deleted ones included — their blob leaves the tree); null = every live document (a catch-up or a snapshot) */
  docs: string[] | null;
  epoch: string;
  from: number;
  to: number;
  ts: string;
  /** the content commit this ids commit belongs to */
  content: string;
  actor: string | null;
}

/**
 * Write one ids commit for a checkpoint when the ids tree changed; returns the
 * ids tip (unchanged when nothing moved). Never fails the checkpoint that
 * called it beyond a thrown git error: the content ref already moved.
 */
export function syncIds(input: IdsSyncInput): string | null {
  const { store, git, config } = input;
  const parent = git.ref(config.ids_ref);
  const baseTree = parent === null ? null : git.treeOf(parent);
  const live = new Set((store.db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL").all(input.repoId) as { doc_id: string }[]).map((r) => r.doc_id));
  const existing = baseTree === null ? new Map<string, string>() : git.treeEntries(baseTree);
  const docs = input.docs ?? [...live];
  const adds: { path: string; blob: string }[] = [];
  const removes: string[] = [];
  for (const docId of [...new Set(docs)].sort()) {
    const path = idsPath(docId);
    const record = live.has(docId) ? idsRecord(store, docId) : null;
    if (record === null) {
      if (existing.has(path)) removes.push(path);
      continue;
    }
    const blob = git.writeBlob(idsBlobText(record));
    if (existing.get(path) !== blob) adds.push({ path, blob });
  }
  if (input.docs === null) for (const path of existing.keys()) if (path.startsWith(IDS_PREFIX) && !live.has(path.slice(IDS_PREFIX.length))) removes.push(path);
  if (adds.length === 0 && removes.length === 0) return parent;
  const tree = git.buildTree(baseTree, adds, removes);
  if (baseTree !== null && tree === baseTree) return parent;
  const trailers: CommitTrailers = { epoch: input.epoch, from: input.from, to: input.to, ts: input.ts, commits: [], origin: null, actor: input.actor, plan: null, docs: [], rescan: null, merge: null, content: input.content };
  const subject = `ids: ${adds.length + removes.length} document(s)`;
  const sha = git.commitTree(tree, parent, renderMessage(subject, trailers), { author: { name: input.actor ?? input.identity.name, email: input.identity.email }, committer: input.identity, ts: input.ts });
  git.updateRefRaw(config.ids_ref, sha, parent);
  return sha;
}
