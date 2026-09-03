import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import type { TreeInputBlock } from "../core/store/writers.js";
import type { IdResolver, DispositionRow } from "../core/ingest.js";
import { mintId } from "../core/ids.js";
import { sha256, normalizeVisibleText } from "../core/hash.js";
import { reconcileDocument, type ResurrectionCandidate } from "../reconcile/reconcile.js";
import { flatten, type FlatSource } from "../reconcile/flatten.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "../reconcile/types.js";

// Reconciling id resolver (07 task 2.7). Bridges core/ingest (which owns the
// write) and reconcile/ (which owns identity). Loads the current block tree for
// a doc, reconciles it against the freshly parsed blocks, and assigns carried
// ids to the new tree; returns dispositions + deleted ids to persist. sync/ is
// the only module allowed to depend on both core and reconcile.

interface StoredBlock {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  raw_hash: Buffer;
}

// Rebuild the old tree as positional MatchBlocks straight from stored blocks +
// blob bytes (so text/hashes match what reconcile expects).
function loadOldMatchBlocks(db: Database, docId: string): MatchBlock[] {
  const rows = db
    .prepare(
      `SELECT block_id, parent_block, ordinal, type, raw_hash
       FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL
       ORDER BY parent_block, ordinal`,
    )
    .all(docId) as StoredBlock[];

  // Build positional keys mirroring the flatten() convention. We need parent's
  // key, so process in a way that resolves parents first (top-level then down).
  const byId = new Map<string, StoredBlock>();
  for (const r of rows) byId.set(r.block_id, r);

  // Compute a positional key per block: parentKey + '/' + ordinal.
  const keyOf = new Map<string, string>();
  const parentKeyOf = new Map<string, string | null>();
  const resolveKey = (r: StoredBlock): string => {
    if (keyOf.has(r.block_id)) return keyOf.get(r.block_id)!;
    let parentKey: string | null = null;
    if (r.parent_block && byId.has(r.parent_block)) parentKey = resolveKey(byId.get(r.parent_block)!);
    const key = `${parentKey ?? ""}/${r.ordinal}`;
    keyOf.set(r.block_id, key);
    parentKeyOf.set(r.block_id, parentKey);
    return key;
  };

  const blobBytes = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  return rows.map((r) => {
    const key = resolveKey(r);
    const raw = (blobBytes.get(r.raw_hash) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "";
    const text = normalizeVisibleText(raw, r.type);
    return {
      blockId: r.block_id,
      type: r.type,
      rawHashHex: r.raw_hash.toString("hex"),
      normHashHex: sha256(text).toString("hex"),
      text,
      anchors: [],
      parentKey: parentKeyOf.get(r.block_id) ?? null,
      index: r.ordinal,
      key,
    };
  });
}

function loadPool(db: Database, repoId: string, ts: string): ResurrectionCandidate[] {
  const rows = db
    .prepare("SELECT block_id, raw_hash, norm_hash, type FROM resurrection_pool WHERE repo_id = ? AND expires_ts > ?")
    .all(repoId, ts) as { block_id: string; raw_hash: Buffer; norm_hash: Buffer; type: string }[];
  return rows.map((r) => ({
    blockId: r.block_id,
    rawHashHex: r.raw_hash.toString("hex"),
    normHashHex: r.norm_hash.toString("hex"),
    type: r.type,
  }));
}

// Assign ids from a reconcile assignment (new key → id) onto a fresh
// TreeInputBlock tree, minting for keys the assignment missed.
function assignFromMap(blocks: RawBlock[], assignment: Map<string, string>): TreeInputBlock[] {
  const walk = (list: RawBlock[], parentKey: string | null): TreeInputBlock[] =>
    list.map((b, index) => {
      const key = `${parentKey ?? ""}/${index}`;
      const blockId = assignment.get(key) ?? mintId("b");
      return { blockId, type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs, children: walk(b.children, key) };
    });
  return walk(blocks, null);
}

/** Build an IdResolver bound to this store + repo, reconciling against the
 * document's current revision. */
export function makeReconcilingResolver(
  store: Store,
  repoId: string,
  opts: { ts?: string; config?: ReconcileConfig } = {},
): IdResolver {
  const ts = opts.ts ?? new Date().toISOString();
  const config = opts.config ?? DEFAULT_CONFIG;
  return (rest: RawBlock[], docId: string | null) => {
    const db = store.db;
    const oldBlocks = docId ? loadOldMatchBlocks(db, docId) : [];
    const newBlocks = flatten(rest.map(toFlatSource));
    const pool = docId ? loadPool(db, repoId, ts) : [];

    const result = reconcileDocument(oldBlocks, newBlocks, { config, pool });

    const assigned = assignFromMap(rest, result.assignment);
    const dispositions: DispositionRow[] = result.dispositions.map((d) => ({
      blockId: d.blockId,
      kind: d.kind,
      confidence: d.confidence,
      reason: d.reason,
      matcherV: d.matcherV,
      detail: d.detail,
    }));
    return { assigned, dispositions, deleted: result.deleted, consumedPool: result.consumedPool };
  };
}

function toFlatSource(b: RawBlock): FlatSource {
  return { type: b.type, raw: b.raw, children: b.children.map(toFlatSource) };
}
