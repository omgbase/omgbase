import { sha256 } from "../core/hash.js";

// Mutable document tree for the kernel. Blocks carry id + raw bytes + trivia so
// the tree can be re-rendered by splice (03 §2.2) after ops. This is the
// working representation an apply() builds, mutates, and renders.

export interface MutBlock {
  id: string;
  type: string;
  raw: string;
  trivia: string; // trailing inter-block trivia (top-level tiling)
  attrs: Record<string, unknown>;
  children: MutBlock[];
  /** true if raw was supplied by an op (serialize as-is; 03 §2.2) */
  dirty?: boolean;
}

export interface MutDoc {
  docId: string;
  path: string;
  leadingTrivia: string;
  frontmatterRaw: string | null; // incl. fences; rendered verbatim before blocks
  children: MutBlock[];
}

export class MutationError extends Error {
  code: string;
  data: Record<string, unknown>;
  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Find a block by id anywhere in the doc; returns the block + its parent list. */
export function locate(doc: MutDoc, blockId: string): { block: MutBlock; siblings: MutBlock[]; index: number } | null {
  const search = (list: MutBlock[]): { block: MutBlock; siblings: MutBlock[]; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.id === blockId) return { block: b, siblings: list, index: i };
      const found = search(b.children);
      if (found) return found;
    }
    return null;
  };
  return search(doc.children);
}

export function rawHashHex(raw: string): string {
  return sha256(raw).toString("hex");
}

// Render the doc by splice (03 §2.2): leading trivia, optional frontmatter, then
// each block's raw (verbatim or dirty) + trivia. Container children are rendered
// inside their parent's raw only when the parent is dirty; otherwise the
// parent's retained raw already contains them (top-level tiling, Stage-0 model).
export function renderDoc(doc: MutDoc): string {
  const out: string[] = [doc.leadingTrivia];
  if (doc.frontmatterRaw !== null) out.push(doc.frontmatterRaw);
  for (const b of doc.children) {
    out.push(b.raw);
    out.push(b.trivia);
  }
  return out.join("");
}

/** Ordered ids of a parent's direct children (for parent_children_hash CAS). */
export function childIds(list: MutBlock[]): string[] {
  return list.map((b) => b.id);
}

export function parentChildrenHash(list: MutBlock[]): string {
  return sha256(childIds(list).join(",")).toString("hex");
}
