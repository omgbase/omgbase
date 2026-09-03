import type { BlockTree } from "./types.js";
import { parseBlocks } from "./parse.js";

// Trivia attachment (03 §2.3): inter-block bytes attach to the PRECEDING block
// (trailing-attach). Bytes before the first block are document-leading trivia.
//
// As-built scope: trivia is tiled at the top level, which is what the splice
// renderer (03 §2.2) walks. `leadingTrivia + Σ(block.raw + block.trivia)`
// reconstructs the source byte-for-byte. Nested children retain their `raw`
// (a substring of the parent's raw) for structure/identity; splicing *inside* a
// container is deferred to the mutation stage and does not affect round-trip.

export function parseTree(source: string): BlockTree {
  const children = parseBlocks(source);

  const leadingTrivia = children.length === 0 ? source : source.slice(0, children[0]!.span.start);

  for (let i = 0; i < children.length; i++) {
    const block = children[i]!;
    const next = children[i + 1];
    const triviaEnd = next ? next.span.start : source.length;
    block.trivia = source.slice(block.span.end, triviaEnd);
  }

  return { source, leadingTrivia, children };
}

/**
 * Coverage assertion (03 §2.1 invariant #2): every byte of the source is owned
 * by exactly one top-level block's raw or trivia — no gaps, no overlaps.
 * Returns true iff the tree tiles the source exactly.
 */
export function assertFullCoverage(tree: BlockTree): boolean {
  let cursor = 0;
  if (tree.leadingTrivia !== tree.source.slice(0, tree.leadingTrivia.length)) return false;
  cursor = tree.leadingTrivia.length;

  for (const block of tree.children) {
    if (block.span.start !== cursor) return false; // gap or overlap
    if (block.raw !== tree.source.slice(block.span.start, block.span.end)) return false;
    cursor = block.span.end;
    if (block.trivia !== tree.source.slice(cursor, cursor + block.trivia.length)) return false;
    cursor += block.trivia.length;
  }

  return cursor === tree.source.length;
}
