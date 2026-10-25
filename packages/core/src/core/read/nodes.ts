import type { Store } from "../store/store.js";
import { loadDocBlocks, blockRaw, type BlockNode } from "./reader.js";

// Resolution ladder (06 §1.4): skeleton | outline | text | raw | full.

export type Resolution = "skeleton" | "outline" | "text" | "raw" | "full";

// The wire shape follows the surface's row rule (spec/surface §1.2, 5.0): the
// block's identity `_id`, its source bytes `_raw` and their hash `_hash` under
// the row attributes' own names; `_type`, `_text`, `_attrs`, `_ordinal`, `_depth` are
// the block's columns, `_children` its relation and `parent_id` (a role) its parent's foreign key (the former
// `placement` object flattened onto the row).
export interface GetNode {
  _id: string;
  _type: string;
  label?: string;
  _text?: string;
  /** The block's raw source bytes (`raw` / `full` resolutions). */
  _raw?: string;
  /** The block's raw_hash (hex) — the value update/split expect as `expect.content_hash`. */
  _hash?: string;
  _attrs?: Record<string, unknown>;
  _ordinal?: number;
  _depth?: number;
  /** The parent block's id, null at the top level (`full`). */
  parent_id?: string | null;
  _children?: GetNode[];
}

function firstWords(text: string, n: number): string {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…";
}

function project(store: Store, node: BlockNode, resolution: Resolution, includeChildren: boolean): GetNode {
  const out: GetNode = { _id: node.blockId, _type: node.type };
  switch (resolution) {
    case "skeleton":
      out.label = node.type === "heading" ? node.text : node.type;
      break;
    case "outline":
      out.label = firstWords(node.text, 10);
      break;
    case "text":
      out._text = node.text;
      break;
    case "raw":
      out._raw = blockRaw(store, node.blockId);
      out._hash = node.rawHashHex;
      break;
    case "full":
      out._raw = blockRaw(store, node.blockId);
      out._hash = node.rawHashHex;
      out._text = node.text;
      out._attrs = node.attrs;
      out._ordinal = node.ordinal;
      out._depth = node.depth;
      out.parent_id = node.parentBlock;
      break;
  }
  if (includeChildren && node.children.length > 0) {
    out._children = node.children.map((c) => project(store, c, resolution, true));
  }
  return out;
}

function findBlock(roots: BlockNode[], blockId: string): BlockNode | null {
  for (const n of roots) {
    if (n.blockId === blockId) return n;
    const found = findBlock(n.children, blockId);
    if (found) return found;
  }
  return null;
}

export interface NodesGetOptions {
  resolution?: Resolution;
  include?: ("children" | "ancestors")[];
}

/** Fetch a single block subtree at a resolution. Returns null if missing. */
export function nodesGet(store: Store, docId: string, blockId: string, opts: NodesGetOptions = {}): GetNode | null {
  const roots = loadDocBlocks(store, docId);
  const node = findBlock(roots, blockId);
  if (!node) return null;
  const includeChildren = opts.include?.includes("children") ?? true;
  return project(store, node, opts.resolution ?? "full", includeChildren);
}

export interface NodesGetManyResult {
  nodes: GetNode[];
  truncated: boolean;
  /**
   * Requested ids (within the first 100) that name NO live block — or, when a
   * `docId` scope is given, no live block in THAT document. Ids dropped by the
   * 100-id cap or the token budget are NOT listed here; they are reported by
   * `truncated` instead. Never silently dropped.
   */
  unresolved: string[];
}

/**
 * Fetch up to 100 blocks by id, with budget truncation (06 §3). Block ids are
 * globally unique, so `docId` is an optional SCOPE, not a requirement: with
 * `null` each id is resolved to its owning document (`blocks.doc_id`), the ids
 * are grouped by doc, each doc's forest is loaded once, and the nodes come back
 * in request order. With a `docId`, ids from other documents count as
 * `unresolved` (the caller asked for that doc's blocks).
 */
export function nodesGetMany(
  store: Store,
  docId: string | null,
  blockIds: string[],
  opts: { resolution?: Resolution; budgetTokens?: number } = {},
): NodesGetManyResult {
  const capped = blockIds.slice(0, 100);
  const budget = opts.budgetTokens ?? Infinity;
  const resolution = opts.resolution ?? "text";

  // id → owning doc for every requested id that is a live block (one query).
  const owner = new Map<string, string>();
  if (capped.length > 0) {
    const rows = store.db
      .prepare(`SELECT block_id, doc_id FROM blocks WHERE deleted_at IS NULL AND block_id IN (${capped.map(() => "?").join(",")})`)
      .all(...capped) as { block_id: string; doc_id: string }[];
    for (const r of rows) if (docId === null || r.doc_id === docId) owner.set(r.block_id, r.doc_id);
  }

  // Load each involved document's forest once.
  const forests = new Map<string, BlockNode[]>();
  for (const d of new Set(owner.values())) forests.set(d, loadDocBlocks(store, d));

  const nodes: GetNode[] = [];
  const unresolved: string[] = [];
  let tokens = 0;
  let truncated = blockIds.length > 100;

  for (const id of capped) {
    const d = owner.get(id);
    const node = d ? findBlock(forests.get(d)!, id) : null;
    if (!node) {
      unresolved.push(id);
      continue;
    }
    const projected = project(store, node, resolution, false);
    // At least one resolved node is always returned (spec/surface §2, 1.2): the
    // budget is checked before the second node onward, as docsReadMany does, so
    // a first node that alone exceeds it still ships and `truncated` only says
    // that more remained.
    const cost = Math.ceil(JSON.stringify(projected).length / 4);
    if (nodes.length > 0 && tokens + cost > budget) {
      truncated = true;
      break;
    }
    tokens += cost;
    nodes.push(projected);
  }
  return { nodes, truncated, unresolved };
}
