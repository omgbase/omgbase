import { mintId } from "../ids.js";
import type { RawBlock } from "../parse/types.js";

// The current-state half of what was the store's writers module through
// Phase 3: the id-assigned block tree the ingest flattens into `blocks`
// (`TreeInputBlock`) and the fresh-mint assignment. The recorder's writers —
// blobs, tree nodes, the commit and revision rows — are the history bundle's
// (`history-writers.ts`, modular-core Phase 4a); nothing here names a history
// table.

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

