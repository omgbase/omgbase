import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import type { TreeInputBlock } from "../core/store/writers.js";
import type { IdResolver, DispositionRow, ResolvedEdgeRow } from "../core/ingest.js";
import { mintId } from "../core/ids.js";
import { sha256 } from "../core/hash.js";
import { extractFromBlock, extractFromFrontmatter, resolveRelativePath } from "../graph/extract.js";
import { resolveExternal, resolveDocPath } from "../core/store/edges.js";
import { adapterForPath, type AdapterEdge } from "../format/index.js";
import type { MutBlock, MutDoc } from "./tree.js";

// Known-id resolver for the INTENT path (04 §2, node-editability fix). When
// `apply` commits, it already holds the mutated tree with DETERMINISTIC block
// ids — opUpdate keeps a block's id in place, untouched blocks keep theirs, and
// new blocks carry the id the op minted. Re-ingesting the rendered bytes through
// the probabilistic reconciler would DISCARD those ids and re-derive identity
// from bytes, re-minting on ordinary edits (and cascading to node ids). This
// resolver instead carries the MutDoc's ids onto the re-parsed blocks
// positionally — round-trip law guarantees parse(render(tree)) is structurally
// identical to the op tree — and records intent dispositions (confidence 1.0),
// never a matcher guess. Edge extraction is still real derivation (reused).

/** Flatten a MutDoc body to a positional id list mirroring flatten()'s keys. */
function idByPositionalKey(children: MutBlock[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: MutBlock[], parentKey: string | null): void => {
    list.forEach((b, index) => {
      const key = `${parentKey ?? ""}/${index}`;
      out.set(key, b.id);
      if (b.children.length > 0) walk(b.children, key);
    });
  };
  walk(children, null);
  return out;
}

/** Assign the MutDoc's ids onto the re-parsed tree by positional key; mint only
 *  if a position is unexpectedly absent (should not happen under round-trip). */
function assignFromMut(blocks: RawBlock[], byKey: Map<string, string>): TreeInputBlock[] {
  const walk = (list: RawBlock[], parentKey: string | null): TreeInputBlock[] =>
    list.map((b, index) => {
      const key = `${parentKey ?? ""}/${index}`;
      const blockId = byKey.get(key) ?? mintId("b");
      return { blockId, type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs, children: walk(b.children, key), span: b.span };
    });
  return walk(blocks, null);
}

// Rebuild id-assigned blocks as RawBlock-shaped inputs for adapter edge
// extraction, threading each block's blockId so extractEdges can set src_block.
function collectRawBlocks(blocks: TreeInputBlock[]): RawBlock[] {
  return blocks.map((b) => ({
    type: b.type,
    span: b.span ?? { start: 0, end: 0 },
    raw: b.raw,
    text: "",
    attrs: b.attrs,
    children: collectRawBlocks(b.children),
    trivia: b.trivia,
    anchors: [],
    outLinks: [],
    blockId: b.blockId,
  }));
}

function collectIds(blocks: TreeInputBlock[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeInputBlock[]): void => { for (const b of list) { out.push(b.blockId); walk(b.children); } };
  walk(blocks);
  return out;
}

/**
 * An IdResolver that threads the ops' known ids (from the committed MutDoc)
 * rather than reconciling. `priorIds` is the set of block ids that existed in
 * the doc's previous revision — used only to label dispositions (same/edited vs
 * inserted); it does not affect id assignment.
 */
export function makeKnownIdResolver(
  store: Store,
  repoId: string,
  doc: MutDoc,
  priorIds: Set<string>,
  opts: { path?: string } = {},
): IdResolver {
  const adapter = opts.path ? adapterForPath(opts.path) : undefined;
  // Source directory for `./`/`../` link targets — the same rule the observed
  // (reconciling) ingest applies, so an `apply` re-ingest resolves a relative
  // link to the same node instead of minting a `phantom:../x.md` placeholder.
  const docDir = opts.path ? opts.path.replace(/[^/]*$/, "") : "";
  const byKey = idByPositionalKey(doc.children);

  return (rest: RawBlock[], docId: string | null) => {
    const db = store.db;
    const assigned = assignFromMut(rest, byKey);
    const nowIds = collectIds(assigned);
    const nowSet = new Set(nowIds);

    // Dispositions are INTENT, not inference (confidence 1.0, reason `api`): an
    // id new this commit is `inserted`; a prior id no longer present is
    // `deleted` (pooled, no row); a carried id is classified exactly as
    // spec/reconcile §2 classifies a carry — `same` when its raw bytes, parent
    // and sibling index are those of its live row, else `edited` / `moved` /
    // `edited_moved` — so a block the changeset did not touch is `same` and
    // (spec/store §5.4 step 10, 14.2) never persisted: a one-paragraph edit
    // moves that paragraph's `updated_at`, not its siblings'. Through store
    // 14.1 every carried block was stamped `edited`.
    const prior = docId === null ? new Map<string, PriorRow>() : priorRows(db, docId);
    const dispositions: DispositionRow[] = classifyCarries(assigned, prior, priorIds).map((c) => ({
      blockId: c.id,
      kind: c.kind,
      confidence: 1,
      reason: "api",
      matcherV: null,
      detail: {},
    }));
    const deleted: string[] = [...priorIds].filter((id) => !nowSet.has(id));
    // Ids new to THIS document may already exist elsewhere: a cross-document
    // move carries a block whose source document still holds its row (it
    // commits later in the same changeset) or already pooled it (it committed
    // first). Report them so ingest evicts the foreign row and drops the pool
    // row (spec/store §5.4) — otherwise a live block would sit in the pool, or
    // the destination's INSERT would collide on the block_id key. A freshly
    // minted id matches nothing and the eviction is a no-op.
    const crossDocIds: string[] = nowIds.filter((id) => !priorIds.has(id));

    const extractEdges = (thisDocId: string, metadata: Record<string, unknown>): ResolvedEdgeRow[] => {
      const out: ResolvedEdgeRow[] = [];
      if (adapter?.extractEdges) {
        const raw = collectRawBlocks(assigned);
        for (const e of adapter.extractEdges(raw, metadata)) out.push(resolveAdapterEdge(db, repoId, thisDocId, e, docDir));
      } else {
        const walk = (blocks: TreeInputBlock[]): void => {
          for (const b of blocks) {
            for (const e of extractFromBlock(b.blockId, b.type, b.raw)) out.push(resolveEdge(db, repoId, thisDocId, e, docDir));
            if (b.children.length > 0) walk(b.children);
          }
        };
        walk(assigned);
        for (const e of extractFromFrontmatter(metadata)) out.push(resolveEdge(db, repoId, thisDocId, e, docDir));
      }
      return out;
    };

    return { assigned, dispositions, deleted, crossDocIds, extractEdges };
  };
}

/** A carried block's live row, as spec/reconcile §2's carry classification reads it. */
interface PriorRow {
  parent: string | null;
  ordinal: number;
  rawHashHex: string;
}

function priorRows(db: Database, docId: string): Map<string, PriorRow> {
  const rows = db
    .prepare("SELECT block_id, parent_block, ordinal, raw_hash FROM blocks WHERE doc_id = ? AND deleted_at IS NULL")
    .all(docId) as { block_id: string; parent_block: string | null; ordinal: number; raw_hash: Buffer }[];
  return new Map(rows.map((r) => [r.block_id, { parent: r.parent_block, ordinal: r.ordinal, rawHashHex: r.raw_hash.toString("hex") }]));
}

/**
 * spec/reconcile §2 "Classifying a carry", applied to the api path's known ids:
 * `moved` = the parent or the sibling index differs from the live row,
 * `content_equal` = the raw bytes hash the same; `same` / `moved` / `edited` /
 * `edited_moved` follow. An id with no prior row (new to this document — a
 * mint or a cross-document arrival) is `inserted`. Pre-order over the tree.
 */
export function classifyCarries(blocks: TreeInputBlock[], prior: Map<string, PriorRow>, priorIds: Set<string>): { id: string; kind: string }[] {
  const out: { id: string; kind: string }[] = [];
  const walk = (list: TreeInputBlock[], parent: string | null): void => {
    list.forEach((b, index) => {
      const row = priorIds.has(b.blockId) ? prior.get(b.blockId) : undefined;
      if (!row) {
        out.push({ id: b.blockId, kind: "inserted" });
      } else {
        const moved = row.parent !== parent || row.ordinal !== index;
        const contentEqual = row.rawHashHex === sha256(b.raw).toString("hex");
        out.push({ id: b.blockId, kind: contentEqual ? (moved ? "moved" : "same") : moved ? "edited_moved" : "edited" });
      }
      if (b.children.length > 0) walk(b.children, b.blockId);
    });
  };
  walk(blocks, null);
  return out;
}

// Edge resolution — mirrors reconciling-ingest's resolvers (block-anchor targets
// resolve to the document node in v1; the anchor is preserved on the edge).
function resolveEdge(db: Database, repoId: string, srcDoc: string, e: ReturnType<typeof extractFromBlock>[number], docDir: string): ResolvedEdgeRow {
  let dstNode: string;
  let dstKind = e.dstKind;
  if (e.dstKind === "external") {
    dstNode = resolveExternal(db, repoId, e.target);
  } else if (e.target === "") {
    dstNode = srcDoc;
    dstKind = "document";
  } else {
    dstNode = resolveDocPath(db, repoId, resolveRelativePath(e.target, docDir)).id;
    dstKind = "document";
  }
  return { srcDoc, srcBlock: e.srcBlock, srcField: e.srcField, predicate: e.predicate, dstKind, dstNode, anchor: e.anchor, provenance: e.provenance };
}

function resolveAdapterEdge(db: Database, repoId: string, srcDoc: string, e: AdapterEdge, docDir: string): ResolvedEdgeRow {
  let dstNode: string;
  let dstKind = e.dstKind;
  if (e.dstKind === "external") {
    dstNode = resolveExternal(db, repoId, e.target);
  } else if (e.target === "") {
    dstNode = srcDoc;
    dstKind = "document";
  } else {
    dstNode = resolveDocPath(db, repoId, resolveRelativePath(e.target, docDir)).id;
    dstKind = "document";
  }
  return { srcDoc, srcBlock: e.srcBlock, srcField: e.srcField, predicate: e.predicate, dstKind, dstNode, anchor: e.anchor, provenance: e.provenance };
}
