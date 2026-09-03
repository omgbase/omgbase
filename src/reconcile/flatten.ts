import { sha256, normalizeVisibleText } from "../core/hash.js";
import type { MatchBlock } from "./types.js";
import type { TreeInputBlock } from "../core/store/writers.js";

// Flatten a block tree to positional MatchBlocks for reconciliation. Old blocks
// carry their id; new blocks (from a fresh parse) do not. The positional key
// (parentKey + '/' + index) is stable within one tree and used for order/parent
// constraints — it is NOT an identity.

export interface FlatSource {
  blockId?: string;
  type: string;
  raw: string;
  anchors?: string[];
  children: FlatSource[];
}

/** Adapt a parsed RawBlock-ish tree (no ids) to FlatSource. */
export function fromInput(blocks: TreeInputBlock[]): FlatSource[] {
  return blocks.map((b) => ({
    ...(b.blockId ? { blockId: b.blockId } : {}),
    type: b.type,
    raw: b.raw,
    children: fromInput(b.children),
  }));
}

export function flatten(blocks: FlatSource[]): MatchBlock[] {
  const out: MatchBlock[] = [];
  const walk = (list: FlatSource[], parentKey: string | null): void => {
    list.forEach((b, index) => {
      const key = `${parentKey ?? ""}/${index}`;
      const text = normalizeVisibleText(b.raw, b.type);
      const mb: MatchBlock = {
        type: b.type,
        rawHashHex: sha256(b.raw).toString("hex"),
        normHashHex: sha256(text).toString("hex"),
        text,
        anchors: b.anchors ?? [],
        parentKey,
        index,
        key,
      };
      if (b.blockId) mb.blockId = b.blockId;
      out.push(mb);
      if (b.children.length > 0) walk(b.children, key);
    });
  };
  walk(blocks, null);
  return out;
}
