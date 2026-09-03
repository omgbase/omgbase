import type { BlockTree, RawBlock } from "./types.js";

// Splice renderer — 03 §2.2. Untouched blocks emit their retained raw bytes
// verbatim; only dirty blocks (op-supplied markdown) are serialized. The
// renderer MUST NOT re-serialize untouched content from an AST (README
// invariant #1 — remark-stringify is banned by lint).

export function render(tree: BlockTree): string {
  const out: string[] = [tree.leadingTrivia];
  for (const block of tree.children) {
    out.push(block.dirty ? serializeNew(block) : block.raw);
    out.push(block.trivia);
  }
  return out.join("");
}

// Minimal normalization only (03 §2.2): the op supplies the block's markdown as
// `raw`; we do not reformat it. Separation between siblings is owned by trivia,
// so serialization here is the identity on the supplied text. (Container-aware
// indentation and blank-line insertion arrive with the mutation kernel.)
export function serializeNew(block: RawBlock): string {
  return block.raw;
}
