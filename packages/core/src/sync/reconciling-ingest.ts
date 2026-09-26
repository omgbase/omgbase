import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import type { RawBlock, BlockTree } from "../core/parse/types.js";
import type { TreeInputBlock } from "../core/store/writers.js";
import { parseForIngest, type IdResolver, type DispositionRow, type ResolvedEdgeRow } from "../core/ingest.js";
import { mintId } from "../core/ids.js";
import { extractFromBlock, extractFromFrontmatter, resolveRelativePath } from "../graph/extract.js";
import { resolveExternal, resolveDocPath } from "../core/store/edges.js";
import { sha256, childQuoteDepth, visibleText, type VisibleTextBlock } from "../core/hash.js";
import { reconcileDocument, type ResurrectionCandidate, type DocReconcileResult } from "../reconcile/reconcile.js";
import { flatten, type FlatSource } from "../reconcile/flatten.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "../reconcile/types.js";
import { adapterForPath, type AdapterEdge } from "../format/index.js";

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
// blob bytes (so text/hashes match what reconcile expects). Exported so the
// whole-document update planner (mutate/plan-update.ts) reconciles against the
// same old-tree representation the observation path uses.
export function loadOldMatchBlocks(db: Database, docId: string): MatchBlock[] {
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

  // `text` follows spec/format §4.1, which needs the tree: containers compose
  // from their children and nested raws lose up to <blockquote-depth> `> `
  // prefixes. Rebuild the shape (children by parent, in ordinal order) and
  // compute text top-down with the same helper ingest used to store it.
  const blobBytes = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
  const rawOf = new Map<string, string>();
  for (const r of rows) {
    rawOf.set(r.block_id, (blobBytes.get(r.raw_hash) as { bytes: Buffer } | undefined)?.bytes.toString("utf8") ?? "");
  }
  const childrenOf = new Map<string | null, StoredBlock[]>();
  for (const r of rows) {
    const parent = r.parent_block && byId.has(r.parent_block) ? r.parent_block : null;
    let list = childrenOf.get(parent);
    if (!list) childrenOf.set(parent, (list = []));
    list.push(r);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  const toTree = (r: StoredBlock): VisibleTextBlock => ({
    type: r.type,
    raw: rawOf.get(r.block_id) ?? "",
    children: (childrenOf.get(r.block_id) ?? []).map(toTree),
  });
  const textOf = new Map<string, string>();
  const walk = (list: StoredBlock[], quoteDepth: number): void => {
    for (const r of list) {
      textOf.set(r.block_id, visibleText(toTree(r), quoteDepth));
      walk(childrenOf.get(r.block_id) ?? [], childQuoteDepth(r.type, quoteDepth));
    }
  };
  walk(childrenOf.get(null) ?? [], 0);

  return rows.map((r) => {
    const key = resolveKey(r);
    const text = textOf.get(r.block_id) ?? "";
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

/** The live resurrection pool for a repo (rows not yet expired at `ts`). A batch
 * caller loads it ONCE per checkpoint and threads a shared consumed-set through
 * `prepareReconcile`, so two documents reconciled before either commits cannot
 * both resurrect the same pooled id. */
export function loadPool(db: Database, repoId: string, ts: string): ResurrectionCandidate[] {
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

/** One document parsed + reconciled but NOT committed: the first pass of a
 * checkpoint (reconciliation-spec §8). The cross-document phase reads
 * `oldBlocks`/`newBlocks`/`result` across every prepared doc, rewrites `result`
 * in place (`applyCrossDocMatches`) and records the ids it carried in; the
 * second pass commits by handing this to `makeReconcilingResolver({ prepared })`
 * + `ingestFile({ parsed: tree })`. */
export interface PreparedReconcile {
  path: string;
  content: string;
  /** the doc row at `path` (live or tombstoned), or null when the path is new —
   * exactly the docId ingestFile will pass the resolver. */
  docId: string | null;
  tree: BlockTree;
  oldBlocks: MatchBlock[];
  newBlocks: MatchBlock[];
  result: DocReconcileResult;
  /** ids carried into this document by the cross-doc phase (filled by it). */
  crossDocIds: string[];
}

/**
 * Pass 1 of an observed ingest: parse `content`, load the document's current
 * tree, and reconcile — without writing. `pool`/`consumed` let a batch share one
 * pool snapshot: candidates already in `consumed` are hidden from this document,
 * and the ids this document resurrects are added to it.
 */
export function prepareReconcile(
  store: Store,
  repoId: string,
  path: string,
  content: string,
  opts: { ts?: string; config?: ReconcileConfig; pool?: ResurrectionCandidate[]; consumed?: Set<string> } = {},
): PreparedReconcile {
  const db = store.db;
  const ts = opts.ts ?? new Date().toISOString();
  const config = opts.config ?? DEFAULT_CONFIG;
  // Same lookup ingestFile does (a tombstoned row still owns the path's identity).
  const doc = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ?").get(repoId, path) as { doc_id: string } | undefined;
  const docId = doc?.doc_id ?? null;
  const { tree, rest } = parseForIngest(path, content);
  const oldBlocks = docId ? loadOldMatchBlocks(db, docId) : [];
  const newBlocks = flatten(rest.map(toFlatSource));
  let pool: ResurrectionCandidate[] = [];
  if (docId) {
    pool = opts.pool ?? loadPool(db, repoId, ts);
    if (opts.consumed) pool = pool.filter((c) => !opts.consumed!.has(c.blockId));
  }
  const result = reconcileDocument(oldBlocks, newBlocks, { config, pool });
  if (opts.consumed) for (const id of result.consumedPool) opts.consumed.add(id);
  return { path, content, docId, tree, oldBlocks, newBlocks, result, crossDocIds: [] };
}

/** Build an IdResolver bound to this store + repo, reconciling against the
 * document's current revision. With `prepared` (from `prepareReconcile`, after
 * the cross-doc phase) the resolver skips the reconcile and applies that result. */
export function makeReconcilingResolver(
  store: Store,
  repoId: string,
  opts: { ts?: string; config?: ReconcileConfig; path?: string; prepared?: PreparedReconcile } = {},
): IdResolver {
  const ts = opts.ts ?? new Date().toISOString();
  const config = opts.config ?? DEFAULT_CONFIG;
  const adapter = opts.path ? adapterForPath(opts.path) : undefined;
  const docDir = opts.path ? opts.path.replace(/[^/]*$/, "") : "";
  return (rest: RawBlock[], docId: string | null) => {
    const db = store.db;
    let result: DocReconcileResult;
    let crossDocIds: string[] = [];
    if (opts.prepared) {
      result = opts.prepared.result;
      crossDocIds = opts.prepared.crossDocIds;
    } else {
      const oldBlocks = docId ? loadOldMatchBlocks(db, docId) : [];
      const newBlocks = flatten(rest.map(toFlatSource));
      const pool = docId ? loadPool(db, repoId, ts) : [];
      result = reconcileDocument(oldBlocks, newBlocks, { config, pool });
    }

    const assigned = assignFromMap(rest, result.assignment);
    const dispositions: DispositionRow[] = result.dispositions.map((d) => ({
      blockId: d.blockId,
      kind: d.kind,
      confidence: d.confidence,
      reason: d.reason,
      matcherV: d.matcherV,
      detail: d.detail,
    }));

    // Edge extraction: adapter-aware. For formats with extractEdges(), use the
    // adapter; otherwise fall back to markdown's per-block link scanner.
    const extractEdges = (thisDocId: string, metadata: Record<string, unknown>): ResolvedEdgeRow[] => {
      const out: ResolvedEdgeRow[] = [];

      if (adapter?.extractEdges) {
        const rawBlocks = collectRawBlocks(assigned);
        const adapterEdges = adapter.extractEdges(rawBlocks, metadata);
        for (const e of adapterEdges) {
          out.push(resolveAdapterEdge(db, repoId, thisDocId, e, docDir));
        }
      } else {
        // Markdown fallback: per-block link scanning + frontmatter relations.
        const walk = (blocks: TreeInputBlock[]): void => {
          for (const b of blocks) {
            for (const e of extractFromBlock(b.blockId, b.type, b.raw)) {
              out.push(resolveEdge(db, repoId, thisDocId, e));
            }
            if (b.children.length > 0) walk(b.children);
          }
        };
        walk(assigned);
        for (const e of extractFromFrontmatter(metadata)) out.push(resolveEdge(db, repoId, thisDocId, e));
      }

      return out;
    };

    return { assigned, dispositions, deleted: result.deleted, consumedPool: result.consumedPool, crossDocIds, extractEdges };
  };
}

// Resolve an extracted edge's target to a node id (external mint, doc path or
// phantom). Block-anchor targets resolve to a document node in v1 (block-ref
// resolution requires the anchor index; the anchor is preserved on the edge).
function resolveEdge(db: Database, repoId: string, srcDoc: string, e: ReturnType<typeof extractFromBlock>[number]): ResolvedEdgeRow {
  let dstNode: string;
  let dstKind = e.dstKind;
  if (e.dstKind === "external") {
    dstNode = resolveExternal(db, repoId, e.target);
  } else if (e.target === "") {
    // pure fragment (#H / ^ref) → self document
    dstNode = srcDoc;
    dstKind = "document";
  } else {
    const resolved = resolveDocPath(db, repoId, e.target);
    dstNode = resolved.id;
    dstKind = "document";
  }
  return {
    srcDoc,
    srcBlock: e.srcBlock,
    srcField: e.srcField,
    predicate: e.predicate,
    dstKind,
    dstNode,
    anchor: e.anchor,
    provenance: e.provenance,
  };
}

// resolveRelativePath (./foo, ../bar against the source doc's directory) lives
// in graph/extract.ts so docs_move's inbound-link scan resolves identically.

// Resolve an adapter-produced edge to a ResolvedEdgeRow. Same resolution
// logic as resolveEdge but accepts the AdapterEdge shape, with relative path
// resolution against the source document's directory.
function resolveAdapterEdge(db: Database, repoId: string, srcDoc: string, e: AdapterEdge, docDir: string): ResolvedEdgeRow {
  let dstNode: string;
  let dstKind = e.dstKind;
  if (e.dstKind === "external") {
    dstNode = resolveExternal(db, repoId, e.target);
  } else if (e.target === "") {
    dstNode = srcDoc;
    dstKind = "document";
  } else {
    const resolved = resolveDocPath(db, repoId, resolveRelativePath(e.target, docDir));
    dstNode = resolved.id;
    dstKind = "document";
  }
  return {
    srcDoc,
    srcBlock: e.srcBlock,
    srcField: e.srcField,
    predicate: e.predicate,
    dstKind,
    dstNode,
    anchor: e.anchor,
    provenance: e.provenance,
  };
}

// Collect RawBlock-shaped objects from the id-assigned tree for adapter edge extraction.
function collectRawBlocks(blocks: TreeInputBlock[]): RawBlock[] {
  return blocks.map((b) => ({
    type: b.type,
    span: { start: 0, end: 0 },
    raw: b.raw,
    text: "",
    attrs: b.attrs,
    children: collectRawBlocks(b.children),
    trivia: b.trivia,
    anchors: [],
    outLinks: [],
    blockId: b.blockId, // thread the assigned id so extractEdges can set src_block
  }));
}

function toFlatSource(b: RawBlock): FlatSource {
  return { type: b.type, raw: b.raw, children: b.children.map(toFlatSource) };
}
