import type { Store } from "../store/store.js";
import { loadDocBlocks, blockRaw, type BlockNode } from "./reader.js";

// Resolution ladder (06 §1.4): skeleton | outline | text | raw | full.

export type Resolution = "skeleton" | "outline" | "text" | "raw" | "full";

export interface GetNode {
  id: string;
  type: string;
  label?: string;
  text?: string;
  raw?: string;
  /** The block's raw_hash (hex) — the value update/split expect as content_hash. */
  content_hash?: string;
  attrs?: Record<string, unknown>;
  placement?: { parent: string | null; ordinal: number; depth: number };
  children?: GetNode[];
}

function firstWords(text: string, n: number): string {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + "…";
}

function project(store: Store, node: BlockNode, resolution: Resolution, includeChildren: boolean): GetNode {
  const out: GetNode = { id: node.blockId, type: node.type };
  switch (resolution) {
    case "skeleton":
      out.label = node.type === "heading" ? node.text : node.type;
      break;
    case "outline":
      out.label = firstWords(node.text, 10);
      break;
    case "text":
      out.text = node.text;
      break;
    case "raw":
      out.raw = blockRaw(store, node.rawHashHex);
      out.content_hash = node.rawHashHex;
      break;
    case "full":
      out.raw = blockRaw(store, node.rawHashHex);
      out.content_hash = node.rawHashHex;
      out.text = node.text;
      out.attrs = node.attrs;
      out.placement = { parent: node.parentBlock, ordinal: node.ordinal, depth: node.depth };
      break;
  }
  if (includeChildren && node.children.length > 0) {
    out.children = node.children.map((c) => project(store, c, resolution, true));
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
      .prepare(`SELECT block_id, doc_id FROM blocks WHERE deleted_commit IS NULL AND block_id IN (${capped.map(() => "?").join(",")})`)
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
    const cost = Math.ceil(JSON.stringify(projected).length / 4);
    if (tokens + cost > budget) {
      truncated = true;
      break;
    }
    tokens += cost;
    nodes.push(projected);
  }
  return { nodes, truncated, unresolved };
}
