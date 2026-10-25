import type { Store } from "../core/store/store.js";
import { capabilitiesOf } from "../core/capabilities/registry.js";
import type { EmbeddingProvider, EmbeddingWorker } from "./embeddings.js";
import { buildEmbedTasks, buildDocEmbedTasks } from "./tasks.js";

// The semantic indexer (modular-core Phase 2, README §6; spec/search §2.6
// restated): the drain as a FEED CONSUMER with an explicit watermark. Today's
// drain already follows commits — every pass walked every live block and let
// the cache decide — but it never recorded how far it had got, so nothing could
// say whether the index was current, a model switch left dead vectors behind
// until someone ran `--prune`, and a vector could be written for content that
// had moved on while the provider was answering (the worker's guard, Phase 2).
//
// The watermark is a row of the semantic bundle's bookkeeping: `sync_state
// (repo_id, source_id = '$semantic', path = '')` — an engine-written row under
// a source id no adapter can own (ids are minted `src_…`), so a settings
// rewrite never touches it, `sources.remove` never deletes it and the sync
// layer, which reads `sync_state` only per attachment, never sees it. No DDL
// changes in this phase (the split is the store 17 major). `revision` holds
// the INDEX IDENTITY `{ model, dims, chunking }` the vectors were produced
// under; `cursor` holds `{ processed_seq }`, the feed sequence (today the
// recorder's commit seq, `changes_since`'s `head`) the index is current to.
//
// One drain pass:
//   1. read the feed head FIRST (the consistent snapshot: everything the pass
//      embeds is at least as new as `head`, so recording `head` can only under-
//      claim) and the watermark;
//   2. choose the mode — `bootstrap` (no watermark), `catch-up` (watermark under
//      the same identity, at or behind the head), `rescan` (an identity change,
//      a cursor past the head — a rebuilt or foreign feed, D7's expired cursor —
//      no feed at all, or an explicit `--prune`/`rescan`);
//   3. the block pass over EVERY live embeddable block — a cache hit costs one
//      probe, and only this pass catches a context change the feed does not
//      name (a move rewrites the path in every block's context prefix);
//   4. the document pass — in `catch-up` only the documents the feed names
//      since the watermark plus those whose blocks were just (re)embedded, so a
//      quiet repository reconstructs nothing; otherwise every live document;
//   5. the cleanup — a tombstoned document's vectors always (S1: every
//      `doc_embeddings.doc_id` is a live doc); in `bootstrap`/`rescan` also
//      every vector of the current model whose content hash names no live
//      block, and on an identity change every vector of the old identity;
//   6. write the watermark — only after every half succeeded, so a provider
//      failure leaves it where it was and the next pass resumes from there.
//
// Known gap, by design: a moved document whose blocks are ALL below the embed
// floor has a stale document vector until the next rescan (its path is in the
// doc header; the feed does not name the moved doc, D11 fixes that in Phase 3).

/** The chunking rule the vectors were produced under (spec/search §2.1–§2.4: leaf blocks over the 24-token floor, the context prefix, the document header). Bump when any of them changes. */
export const CHUNKING_VERSION = 1;

/** What the index was built with — a change to any member invalidates every vector of the repository. */
export interface SemanticIndexIdentity { model: string; dims: number; chunking: number }

export interface SemanticWatermark {
  processed_seq: number;
  identity: SemanticIndexIdentity;
}

export type DrainMode = "bootstrap" | "catch-up" | "rescan";

export interface DrainResult {
  mode: DrainMode;
  embedded: number;
  cached: number;
  stale: number;
  docEmbedded: number;
  docCached: number;
  pooled: number;
  docStale: number;
  pruned: { blocks: number; docs: number };
  /** The watermark written (the head read at the start), or null when the repository has no feed. */
  processed_seq: number | null;
  head: number | null;
}

export interface DrainOptions {
  batchSize?: number;
  onProgress?: (p: { phase: "blocks" | "docs"; embedded: number; total: number }) => void;
  /** Force `rescan` (with its prune), whatever the watermark says. */
  rescan?: boolean;
}

/** The sentinel source id of the watermark row — never a minted `src_…` id. */
export const WATERMARK_SOURCE = "$semantic";

export function indexIdentity(provider: EmbeddingProvider): SemanticIndexIdentity {
  return { model: provider.model, dims: provider.dim, chunking: CHUNKING_VERSION };
}

export function sameIdentity(a: SemanticIndexIdentity, b: SemanticIndexIdentity): boolean {
  return a.model === b.model && a.dims === b.dims && a.chunking === b.chunking;
}

export function readWatermark(store: Store, repoId: string): SemanticWatermark | null {
  const row = store.db
    .prepare("SELECT revision, cursor FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''")
    .get(repoId, WATERMARK_SOURCE) as { revision: string | null; cursor: string | null } | undefined;
  if (!row?.revision || !row.cursor) return null;
  try {
    const identity = JSON.parse(row.revision) as Partial<SemanticIndexIdentity>;
    const cursor = JSON.parse(row.cursor) as { processed_seq?: unknown };
    if (typeof identity.model !== "string" || typeof identity.dims !== "number" || typeof identity.chunking !== "number") return null;
    if (typeof cursor.processed_seq !== "number") return null;
    return { processed_seq: cursor.processed_seq, identity: { model: identity.model, dims: identity.dims, chunking: identity.chunking } };
  } catch {
    return null;
  }
}

export function writeWatermark(store: Store, repoId: string, wm: SemanticWatermark): void {
  store.db
    .prepare(
      `INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?, ?, '', ?, ?)
       ON CONFLICT(repo_id, source_id, path) DO UPDATE SET revision = excluded.revision, cursor = excluded.cursor`,
    )
    .run(repoId, WATERMARK_SOURCE, JSON.stringify(wm.identity), JSON.stringify({ processed_seq: wm.processed_seq }));
}

export function clearWatermark(store: Store, repoId: string): void {
  store.db.prepare("DELETE FROM sync_state WHERE repo_id = ? AND source_id = ? AND path = ''").run(repoId, WATERMARK_SOURCE);
}

/** The feed head — the recorder's commit seq (`changes_since`), through the capability; null when the store runs without the recorder. */
export function feedHead(store: Store, repoId: string): number | null {
  const history = capabilitiesOf(store.db).history;
  if (!history) return null;
  return history.changesSince(repoId, { cursor: 0, limit: 1 }).head;
}

/** The documents the feed names after `cursor` (their revisions' ids), paged to the head. */
function docsChangedSince(store: Store, repoId: string, cursor: number): Set<string> {
  const history = capabilitiesOf(store.db).history;
  const out = new Set<string>();
  if (!history) return out;
  let at = cursor;
  for (;;) {
    const page = history.changesSince(repoId, { cursor: at, limit: 500 });
    for (const d of page.digests) for (const r of d.revisions) out.add(r._id);
    if (!page.truncated || page.cursor === at) break;
    at = page.cursor;
  }
  return out;
}

/** Decide the pass's mode from the watermark, the head and the identity. */
export function drainMode(wm: SemanticWatermark | null, head: number | null, identity: SemanticIndexIdentity, force?: boolean): DrainMode {
  if (force) return "rescan";
  if (!wm) return "bootstrap";
  if (!sameIdentity(wm.identity, identity)) return "rescan";
  if (head === null) return "rescan";
  if (wm.processed_seq > head) return "rescan";
  return "catch-up";
}

/**
 * One drain pass of `repoId` through `worker` (its provider gives the
 * identity). Throws what the worker throws — a provider failure — with the
 * watermark untouched.
 */
export async function drainRepo(store: Store, repoId: string, worker: EmbeddingWorker, provider: EmbeddingProvider, opts: DrainOptions = {}): Promise<DrainResult> {
  const head = feedHead(store, repoId);
  const wm = readWatermark(store, repoId);
  const identity = indexIdentity(provider);
  const mode = drainMode(wm, head, identity, opts.rescan);

  // An identity change invalidates: another model's vectors are foreign (the
  // prune), the same model under other dims or chunking is this model's own
  // dead weight — gone before anything is re-embedded under the new identity.
  let pruned = { blocks: 0, docs: 0 };
  if (wm && !sameIdentity(wm.identity, identity)) {
    const old = wm.identity;
    pruned = store.write((db) => ({
      blocks: db.prepare("DELETE FROM embeddings WHERE model = ?").run(old.model).changes,
      docs: db.prepare("DELETE FROM doc_embeddings WHERE model = ?").run(old.model).changes,
    }));
  }

  const progress = (phase: "blocks" | "docs") => (p: { embedded: number; total: number }) => opts.onProgress?.({ phase, ...p });
  const batch = opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {};

  // Blocks first: the pooled doc fallback reuses block vectors, so a large doc
  // can pool from vectors cached in the same pass.
  const blocks = await worker.process(buildEmbedTasks(store, repoId), { ...batch, onProgress: progress("blocks") });

  const scope = mode === "catch-up"
    ? { docIds: [...new Set([...docsChangedSince(store, repoId, wm!.processed_seq), ...blocks.docIds])] }
    : {};
  const docs = await worker.processDocs(buildDocEmbedTasks(store, repoId, scope), { ...batch, onProgress: progress("docs") });

  // Cleanup (S1). Every pass drops a tombstoned document's vectors; a full pass
  // also drops this model's block vectors whose content no live block carries.
  const cleanup = store.write((db) => {
    const d = db.prepare("DELETE FROM doc_embeddings WHERE model = ? AND doc_id IN (SELECT doc_id FROM docs WHERE deleted_at IS NOT NULL)").run(identity.model).changes;
    const b = mode === "catch-up"
      ? 0
      : db.prepare("DELETE FROM embeddings WHERE model = ? AND content_hash NOT IN (SELECT raw_hash FROM blocks WHERE deleted_at IS NULL)").run(identity.model).changes;
    return { blocks: b, docs: d };
  });
  pruned = { blocks: pruned.blocks + cleanup.blocks, docs: pruned.docs + cleanup.docs };

  const processed = head ?? 0;
  writeWatermark(store, repoId, { processed_seq: processed, identity });

  return {
    mode,
    embedded: blocks.embedded, cached: blocks.cached, stale: blocks.stale,
    docEmbedded: docs.embedded, docCached: docs.cached, pooled: docs.pooled, docStale: docs.stale,
    pruned,
    processed_seq: head === null ? null : processed,
    head,
  };
}

/** How current the index is: the watermark against the head (the `version`/`omg embed status` report). */
export function freshness(store: Store, repoId: string, identity?: SemanticIndexIdentity): { processed_seq: number | null; head: number | null; identity: SemanticIndexIdentity | null; fresh: boolean | null } {
  const wm = readWatermark(store, repoId);
  const head = feedHead(store, repoId);
  if (!wm || head === null) return { processed_seq: wm?.processed_seq ?? null, head, identity: wm?.identity ?? null, fresh: null };
  const identityOk = identity ? sameIdentity(wm.identity, identity) : true;
  return { processed_seq: wm.processed_seq, head, identity: wm.identity, fresh: identityOk && wm.processed_seq >= head };
}
