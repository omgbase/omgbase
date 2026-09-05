import { mintId } from "../core/ids.js";
import { parseTree } from "../core/parse/tree.js";
import { adapterForFormat } from "../format/index.js";
import { MutationError, locate, rawHashHex, parentChildrenHash, type MutBlock, type MutDoc } from "./tree.js";

// Kernel ops (04 §1). Six operations over a MutDoc. Ops mutate the tree in
// place and return minted ids where relevant. Placement addressing per §1.1.

export type At = "start" | "end" | { before: string } | { after: string };
export interface To {
  parent: string | { doc: true } | { heading: string; scope: "section" };
  at: At;
}

export interface Expect {
  content_hash?: string;
  parent_children_hash?: string;
}

function defaultTrivia(format: string): string {
  if (format === "json") return ",\n";
  if (format === "yaml") return "\n";
  return "\n\n";
}

// Parse op-supplied content into MutBlocks (dirty; ids minted). Uses the
// format's adapter when available; falls back to markdown.
function parseContentToBlocks(content: string, format: string): MutBlock[] {
  const adapter = adapterForFormat(format);
  const normalized = content.endsWith("\n") ? content : content + "\n";
  const tree = adapter ? adapter.parse(normalized) : parseTree(normalized);
  const trivia = defaultTrivia(format);
  const toMut = (b: { type: string; raw: string; trivia: string; attrs: Record<string, unknown>; children: unknown[] }): MutBlock => ({
    id: mintId("b"),
    type: b.type,
    raw: b.raw,
    trivia: b.trivia || trivia,
    attrs: b.attrs,
    children: (b.children as typeof b[]).map(toMut),
    dirty: true,
  });
  return tree.children.filter((b) => b.type !== "frontmatter").map(toMut as never);
}

// Resolve a To into a target sibling list + insertion index.
function resolveTarget(doc: MutDoc, to: To): { siblings: MutBlock[]; index: number } {
  let siblings: MutBlock[];
  if (to.parent === null || (typeof to.parent === "object" && "doc" in to.parent)) {
    siblings = doc.children;
  } else if (typeof to.parent === "object" && "heading" in to.parent) {
    // scope:section — resolve the section's range at top level: insert before
    // the next peer/higher heading (04 §1.1). Section blocks live at top level.
    return resolveSection(doc, to.parent.heading, to.at);
  } else {
    const found = locate(doc, to.parent as string);
    if (!found) throw new MutationError("parent_missing", `parent ${String(to.parent)} not found`);
    siblings = found.block.children;
  }
  return { siblings, index: resolveIndex(siblings, to.at) };
}

function resolveIndex(siblings: MutBlock[], at: At): number {
  if (at === "start") return 0;
  if (at === "end") return siblings.length;
  if ("before" in at) {
    const i = siblings.findIndex((b) => b.id === at.before);
    if (i < 0) throw new MutationError("target_missing", `anchor ${at.before} not found`);
    return i;
  }
  const i = siblings.findIndex((b) => b.id === at.after);
  if (i < 0) throw new MutationError("target_missing", `anchor ${at.after} not found`);
  return i + 1;
}

// A section runs from its heading to the block before the next heading of equal
// or higher level. Blocks are top-level (flat containment, 01 §3.2).
function resolveSection(doc: MutDoc, headingId: string, at: At): { siblings: MutBlock[]; index: number } {
  const hIdx = doc.children.findIndex((b) => b.id === headingId);
  if (hIdx < 0) throw new MutationError("target_missing", `heading ${headingId} not found`);
  const level = Number(doc.children[hIdx]!.attrs.level ?? 1);
  let end = doc.children.length;
  for (let i = hIdx + 1; i < doc.children.length; i++) {
    const b = doc.children[i]!;
    if (b.type === "heading" && Number(b.attrs.level ?? 1) <= level) { end = i; break; }
  }
  if (at === "end") return { siblings: doc.children, index: end };
  if (at === "start") return { siblings: doc.children, index: hIdx + 1 };
  return { siblings: doc.children, index: resolveIndex(doc.children, at) };
}

function checkContentHash(block: MutBlock, expect: Expect | undefined, opIndex: number): void {
  if (!expect?.content_hash) {
    throw new MutationError("stale_expectation", "expect.content_hash required", { op_index: opIndex, block: block.id });
  }
  const current = rawHashHex(block.raw);
  if (current !== expect.content_hash) {
    throw new MutationError("stale_expectation", "content hash mismatch", {
      op_index: opIndex,
      block: block.id,
      expected_content_hash: expect.content_hash,
      current: { content_hash: current, markdown: block.raw },
      retriable: true,
    });
  }
}

// ---- the six ops ------------------------------------------------------------

export function opInsert(doc: MutDoc, to: To, markdown: string): { ids: string[] } {
  const { siblings, index } = resolveTarget(doc, to);
  const blocks = parseContentToBlocks(markdown, doc.format);
  siblings.splice(index, 0, ...blocks);
  return { ids: blocks.map((b) => b.id) };
}

export function opUpdate(doc: MutDoc, blockId: string, opIndex: number, markdown?: string, attrs?: Record<string, unknown>, expect?: Expect): { ids: string[] } {
  const found = locate(doc, blockId);
  if (!found) throw new MutationError("block_missing", `block ${blockId} not found`, { op_index: opIndex, block: blockId });
  checkContentHash(found.block, expect, opIndex);
  if (markdown !== undefined) {
    const parsed = parseContentToBlocks(markdown, doc.format);
    const normalized = markdown.endsWith("\n") ? markdown : markdown + "\n";
    if (parsed.length === 1 && parsed[0]!.raw.trim() === normalized.trim()) {
      // Content parsed cleanly into exactly one block — use the parsed structure.
      const nb = parsed[0]!;
      found.block.raw = nb.raw;
      found.block.type = nb.type;
      found.block.attrs = nb.attrs;
      found.block.children = nb.children;
    } else if (doc.format === "markdown") {
      if (parsed.length !== 1) throw new MutationError("type_mismatch", "update content must be a single block");
      const nb = parsed[0]!;
      found.block.raw = nb.raw;
      found.block.type = nb.type;
      found.block.attrs = nb.attrs;
      found.block.children = nb.children;
    } else {
      // Non-markdown fragment that didn't parse as a standalone doc:
      // raw content swap without re-parsing.
      found.block.raw = markdown;
      found.block.children = [];
    }
    found.block.dirty = true;
  }
  if (attrs) {
    found.block.attrs = { ...found.block.attrs, ...attrs };
    // attr-only edits (e.g. task checkbox) re-render the marker: mark dirty and
    // rewrite the raw checkbox if present.
    if ("checked" in attrs && (found.block.type === "task" || found.block.type === "list_item")) {
      found.block.raw = found.block.raw.replace(/\[[ xX]\]/, attrs.checked ? "[x]" : "[ ]");
      found.block.type = "task";
      found.block.dirty = true;
    }
  }
  return { ids: [blockId] };
}

export function opMove(doc: MutDoc, blockIds: string[], to: To, opIndex: number): { ids: string[] } {
  if (blockIds.length === 0) throw new MutationError("not_contiguous", "move requires ≥1 block");
  // Locate all; assert contiguous siblings.
  const located = blockIds.map((id) => {
    const f = locate(doc, id);
    if (!f) throw new MutationError("block_missing", `block ${id} not found`, { op_index: opIndex, block: id });
    return f;
  });
  const siblings = located[0]!.siblings;
  const indices = located.map((l) => l.index).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (located[i]!.siblings !== siblings || indices[i]! !== indices[i - 1]! + 1) {
      throw new MutationError("not_contiguous", "move blocks must be a contiguous sibling run", { op_index: opIndex });
    }
  }
  // cycle_move: target parent must not be inside the moved subtree.
  const movedIds = new Set<string>();
  const collect = (b: MutBlock): void => { movedIds.add(b.id); b.children.forEach(collect); };
  located.forEach((l) => collect(l.block));
  if (typeof to.parent === "string" && movedIds.has(to.parent)) {
    throw new MutationError("cycle_move", "target is inside the moved subtree", { op_index: opIndex });
  }

  // Extract (preserve order) then re-insert at the target.
  const moving = located.map((l) => l.block);
  for (const m of moving) {
    const idx = siblings.indexOf(m);
    if (idx >= 0) siblings.splice(idx, 1);
  }
  const { siblings: dstSiblings, index } = resolveTarget(doc, to);
  dstSiblings.splice(index, 0, ...moving);
  return { ids: blockIds };
}

export function opRemove(doc: MutDoc, blockIds: string[], opIndex: number, expectPer?: Record<string, Expect>): { ids: string[]; removed: string[] } {
  const removed: string[] = [];
  for (const id of blockIds) {
    const found = locate(doc, id);
    if (!found) throw new MutationError("block_missing", `block ${id} not found`, { op_index: opIndex, block: id });
    if (expectPer?.[id]) checkContentHash(found.block, expectPer[id], opIndex);
    const collect = (b: MutBlock): void => { removed.push(b.id); b.children.forEach(collect); };
    collect(found.block);
    found.siblings.splice(found.index, 1);
  }
  return { ids: blockIds, removed };
}

export function opSplit(doc: MutDoc, blockId: string, at: number[], opIndex: number, expect?: Expect): { ids: string[] } {
  const found = locate(doc, blockId);
  if (!found) throw new MutationError("block_missing", `block ${blockId} not found`, { op_index: opIndex, block: blockId });
  checkContentHash(found.block, expect, opIndex);
  const raw = found.block.raw;
  const cuts = [0, ...at, raw.length].sort((a, b) => a - b);
  const pieces: string[] = [];
  for (let i = 1; i < cuts.length; i++) pieces.push(raw.slice(cuts[i - 1]!, cuts[i]!));
  const nonEmpty = pieces.filter((p) => p.trim().length > 0);
  if (nonEmpty.length < 2) throw new MutationError("type_mismatch", "split must yield ≥2 non-empty fragments");

  // First fragment carries the id (authored intent, 04 §1); rest minted.
  found.block.raw = nonEmpty[0]!;
  found.block.dirty = true;
  const newBlocks: MutBlock[] = nonEmpty.slice(1).map((p) => ({
    id: mintId("b"), type: found.block.type, raw: p, trivia: "\n\n", attrs: { ...found.block.attrs }, children: [], dirty: true,
  }));
  found.siblings.splice(found.index + 1, 0, ...newBlocks);
  return { ids: [blockId, ...newBlocks.map((b) => b.id)] };
}

export function opMerge(doc: MutDoc, blockIds: string[], opIndex: number, separator = " ", expectPer?: Record<string, Expect>): { ids: string[]; mergedInto: string[] } {
  if (blockIds.length < 2) throw new MutationError("not_contiguous", "merge requires ≥2 blocks");
  const located = blockIds.map((id) => {
    const f = locate(doc, id);
    if (!f) throw new MutationError("block_missing", `block ${id} not found`, { op_index: opIndex, block: id });
    return f;
  });
  const siblings = located[0]!.siblings;
  const type = located[0]!.block.type;
  const indices = located.map((l) => l.index).sort((a, b) => a - b);
  for (let i = 0; i < located.length; i++) {
    if (located[i]!.siblings !== siblings) throw new MutationError("not_contiguous", "merge blocks must share a parent", { op_index: opIndex });
    if (located[i]!.block.type !== type) throw new MutationError("type_mismatch", "merge blocks must share a type", { op_index: opIndex });
    if (expectPer?.[blockIds[i]!]) checkContentHash(located[i]!.block, expectPer[blockIds[i]!], opIndex);
  }
  for (let i = 1; i < indices.length; i++) if (indices[i]! !== indices[i - 1]! + 1) throw new MutationError("not_contiguous", "merge blocks must be contiguous", { op_index: opIndex });

  const ordered = indices.map((i) => siblings[i]!);
  const first = ordered[0]!;
  first.raw = ordered.map((b) => b.raw).join(separator);
  first.dirty = true;
  const mergedInto = ordered.slice(1).map((b) => b.id);
  // remove the others (highest index first)
  for (let i = indices.length - 1; i >= 1; i--) siblings.splice(indices[i]!, 1);
  return { ids: [first.id], mergedInto };
}

export function checkParentChildrenHash(doc: MutDoc, parentId: string | null, expected: string, opIndex: number): void {
  const list = parentId ? locate(doc, parentId)?.block.children ?? doc.children : doc.children;
  const current = parentChildrenHash(list);
  if (current !== expected) {
    throw new MutationError("stale_expectation", "parent_children_hash mismatch", { op_index: opIndex, current: { parent_children_hash: current }, retriable: true });
  }
}
