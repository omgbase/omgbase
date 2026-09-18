import { mintId } from "../core/ids.js";
import { parseTree } from "../core/parse/tree.js";
import { adapterForFormat } from "../format/index.js";
import { MutationError, locate, rawHashHex, parentChildrenHash, markContainerDirty, ownerOf, type MutBlock, type MutDoc } from "./tree.js";

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
    // Hand back the current hash + bytes so the caller can retry immediately
    // (same actionable shape as a hash MISMATCH below) instead of a separate
    // hydration read — an agent may hold fresh ids yet lack the CAS token.
    throw new MutationError("stale_expectation", "expect.content_hash required", {
      op_index: opIndex,
      block: block.id,
      current: { content_hash: rawHashHex(block.raw), markdown: block.raw },
      retriable: true,
    });
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

// Assign known ids onto a freshly-parsed subtree by positional key (parentKey +
// '/' + index), the same convention flatten()/known-ids use. Keys absent from
// the map leave the block's minted id in place (a genuinely new child).
function assignChildIds(children: MutBlock[], childIds: Record<string, string>, parentKey: string): void {
  children.forEach((c, i) => {
    const key = `${parentKey}/${i}`;
    const id = childIds[key];
    if (id) c.id = id;
    if (c.children.length > 0) assignChildIds(c.children, childIds, key);
  });
}

// Wrap a non-list parsed block as a list_item (marker prepended) so it can be
// inserted into a list. The marker is normalized on render (renderItem strips
// and re-applies it, renumbering ordered lists), so `- ` here is just a seed.
function wrapAsItem(b: MutBlock): MutBlock {
  return { id: mintId("b"), type: "list_item", raw: `- ${b.raw}`, trivia: "", attrs: {}, children: [], dirty: true };
}

// Mark a block and its whole subtree clean (dirty=false), so renderDoc emits the
// block's retained raw verbatim rather than rebuilding it from children.
function markSubtreeClean(b: MutBlock): void {
  b.dirty = false;
  for (const c of b.children) markSubtreeClean(c);
}

// ---- the six ops ------------------------------------------------------------

export function opInsert(doc: MutDoc, to: To, markdown: string): { ids: string[] } {
  const { siblings, index } = resolveTarget(doc, to);
  let blocks = parseContentToBlocks(markdown, doc.format);
  // Inserting into a list: the content must land as list ITEMS, not a nested
  // list. Markdown `- x` parses to a `list` wrapping a `list_item`; unwrap it to
  // its items (a bare block is wrapped as one item). Then mark the list dirty so
  // it re-renders from its new items. (04 §1 / lists_insert_item.)
  const container = ownerOf(doc, siblings);
  if (container?.type === "list" && doc.format === "markdown") {
    blocks = blocks.flatMap((b) => (b.type === "list" ? b.children : [wrapAsItem(b)]));
    siblings.splice(index, 0, ...blocks);
    container.dirty = true;
    return { ids: blocks.map((b) => b.id) };
  }
  // Trivia is document tiling rendered independently of a block's raw, so the
  // separators fixed up here set no `dirty` flag — no block content changed.
  // Only the top-level list is rendered from trivia (nested containers are
  // re-emitted from children with single-newline joins, so their trivia is
  // inert); confine separator normalization to that list.
  if (siblings === doc.children) {
    const sep = defaultTrivia(doc.format);
    // Separator BEFORE the run: the block now preceding it must end at a real
    // block boundary, or the two render jammed together — e.g. appending a
    // heading at the end of a section whose last paragraph carried only a
    // single trailing "\n" glued "…text\n## Heading" with no blank line.
    if (index > 0) {
      const prev = siblings[index - 1]!;
      if (!separatesBlocks(prev.trivia, doc.format)) prev.trivia = sep;
    }
    // Separator AFTER the run: a mid-document insert leaves a following block,
    // and the parsed run's last block ends in a lone "\n" — bump it too.
    if (blocks.length > 0 && index < siblings.length) {
      const last = blocks[blocks.length - 1]!;
      if (!separatesBlocks(last.trivia, doc.format)) last.trivia = sep;
    }
  }
  siblings.splice(index, 0, ...blocks);
  return { ids: blocks.map((b) => b.id) };
}

// Does this trailing trivia hold a real block boundary? Markdown block-level
// content needs a blank line between blocks (a lone "\n" renders as a soft
// continuation, jamming an ATX heading onto the previous paragraph); other
// formats only need the separator to be non-empty.
function separatesBlocks(trivia: string, format: string): boolean {
  return format === "markdown" ? trivia.includes("\n\n") : trivia !== "";
}

export function opUpdate(doc: MutDoc, blockId: string, opIndex: number, markdown?: string, attrs?: Record<string, unknown>, expect?: Expect, trivia?: string, childIds?: Record<string, string>): { ids: string[] } {
  const found = locate(doc, blockId);
  if (!found) throw new MutationError("block_missing", `block ${blockId} not found`, { op_index: opIndex, block: blockId });
  // Content CAS is required only for a content edit (`markdown`). Attr- and
  // trivia-only updates change no block content, so they follow the placement
  // convention (no content CAS); a supplied `expect.content_hash` is still
  // honored when present (CAS honesty, README invariant 6). This lets the
  // whole-doc planner set exact trailing trivia after structural ops without
  // juggling post-op content hashes across the changeset.
  if (markdown !== undefined || expect?.content_hash !== undefined) checkContentHash(found.block, expect, opIndex);
  if (markdown !== undefined) {
    if (doc.format === "markdown" && found.block.type === "list_item") {
      // A list item can't be re-parsed as a standalone block (`- x` parses to a
      // list, `x` loses the marker). Unwrap: accept a single-item list (use its
      // item) or a bare block (wrap it), keep this block a list_item, and mark
      // the containing list dirty so it re-renders from its items.
      const parsed = parseContentToBlocks(markdown, doc.format);
      if (parsed.length !== 1) throw new MutationError("type_mismatch", "list-item update must be a single item");
      const only = parsed[0]!;
      if (only.type === "list") {
        if (only.children.length !== 1) throw new MutationError("type_mismatch", "list-item update must yield exactly one item");
        found.block.raw = only.children[0]!.raw;
        found.block.children = only.children[0]!.children;
      } else {
        found.block.raw = `- ${only.raw}`;
        found.block.children = [];
      }
      found.block.dirty = true;
      markContainerDirty(doc, found.siblings);
    } else if (doc.format === "markdown") {
      const parsed = parseContentToBlocks(markdown, doc.format);
      if (parsed.length !== 1) throw new MutationError("type_mismatch", "update content must be a single block");
      const nb = parsed[0]!;
      found.block.raw = nb.raw;
      found.block.type = nb.type;
      found.block.attrs = nb.attrs;
      found.block.children = nb.children;
      // Thread known child identities onto the re-parsed subtree, positionally
      // (mirroring flatten()/known-ids keys, relative to this block's children).
      // A whole-container update (e.g. a list) re-parses its children, minting
      // fresh ids by default; supplying childIds lets the whole-document update
      // planner preserve reconcile-carried identity for the container's items
      // (nested identity) — the commit re-parse threads exactly these ids.
      if (childIds !== undefined && found.block.children.length > 0) {
        assignChildIds(found.block.children, childIds, "");
        // Render the container VERBATIM from its op-supplied raw (the exact
        // target bytes) rather than rebuilding from children — the splice
        // renderer's child rebuild can't reproduce nested/loose list formatting.
        // The children remain (clean) only to carry the threaded ids for the
        // commit re-parse. Marking the subtree clean makes renderDoc emit
        // `found.block.raw` verbatim, so nested containers converge exactly.
        markSubtreeClean(found.block);
      } else {
        found.block.dirty = true;
      }
    } else {
      // Non-markdown: raw swap preserves the block's type and attrs. Fragments
      // like JSON properties aren't valid standalone documents, so re-parsing
      // would corrupt the block kind (e.g. json:property → json:scalar).
      found.block.raw = markdown;
      found.block.children = [];
      found.block.dirty = true;
    }
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
  // Trailing trivia (positional tiling): set verbatim. No content change, no
  // dirty flag — renderDoc emits a top-level block's trivia unconditionally.
  if (trivia !== undefined) found.block.trivia = trivia;
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
  // A move within/into a nested container invalidates that container's cached
  // raw (and the source's) — mark them so they re-render from children. No-op
  // for the top-level list, which renders directly and is healed below.
  markContainerDirty(doc, siblings);
  markContainerDirty(doc, dstSiblings);
  // Heal top-level seams so relocated blocks never render jammed together.
  // Trivia is positional tiling (03 §2.2), not owned by the block: a block that
  // was last in the source list carried a lone "\n" that, once interior, would
  // soft-merge with its new neighbour (two paragraphs → one). Both the source
  // gap and the destination seam are re-tiled. Only the top-level list renders
  // from trivia (nested containers re-emit from children), so confine to it.
  if (siblings === doc.children) healTopLevelSeams(doc.children, doc.format);
  if (dstSiblings === doc.children && dstSiblings !== siblings) healTopLevelSeams(doc.children, doc.format);
  return { ids: blockIds };
}

// Ensure every non-last top-level block ends at a real block boundary. Leaves
// already-separating trivia untouched (idempotent, byte-preserving where the
// document is already well-formed) and never touches the last block's trailing
// trivia (that is the document's trailing bytes). Exact target trivia is the
// planner's job via `update { trivia }`; this only guarantees well-formedness.
function healTopLevelSeams(children: MutBlock[], format: string): void {
  const sep = defaultTrivia(format);
  for (let i = 0; i < children.length - 1; i++) {
    const b = children[i]!;
    if (!separatesBlocks(b.trivia, format)) b.trivia = sep;
  }
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
    // Removing a nested block invalidates its container's cached raw; a container
    // emptied by the removal is itself removed (an empty list would render blank).
    pruneOrDirty(doc, found.siblings);
  }
  return { ids: blockIds, removed };
}

// After removing from `siblings`: if that list is now empty, remove the empty
// container from its own parent (recursing); otherwise mark it dirty so it
// re-renders from its remaining children.
function pruneOrDirty(doc: MutDoc, siblings: MutBlock[]): void {
  const owner = ownerOf(doc, siblings);
  if (!owner) return; // top-level list: renderDoc renders it directly
  if (owner.children.length === 0) {
    const f = locate(doc, owner.id);
    if (f) { f.siblings.splice(f.index, 1); pruneOrDirty(doc, f.siblings); }
  } else {
    owner.dirty = true;
  }
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
