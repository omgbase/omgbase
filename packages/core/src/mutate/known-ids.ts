import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import type { TreeInputBlock } from "../core/store/writers.js";
import type { IdResolver, DispositionRow, ResolvedEdgeRow } from "../core/ingest.js";
import { mintId } from "../core/ids.js";
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
      return { blockId, type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs, children: walk(b.children, key) };
    });
  return walk(blocks, null);
}

// Rebuild id-assigned blocks as RawBlock-shaped inputs for adapter edge
// extraction, threading each block's blockId so extractEdges can set src_block.
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

    // Dispositions are INTENT, not inference: a carried id that existed before is
    // `same`/`edited` (confidence 1.0); an id new this commit is `inserted`; a
    // prior id no longer present is `deleted`.
    const dispositions: DispositionRow[] = nowIds.map((id) => ({
      blockId: id,
      kind: priorIds.has(id) ? "edited" : "inserted",
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

    void docId;
    return { assigned, dispositions, deleted, crossDocIds, extractEdges };
  };
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
