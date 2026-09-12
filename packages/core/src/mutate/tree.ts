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
  format: string;
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

/** The block that owns `children` (by reference identity), or null at top level. */
export function ownerOf(doc: MutDoc, children: MutBlock[]): MutBlock | null {
  if (children === doc.children) return null;
  let found: MutBlock | null = null;
  const walk = (list: MutBlock[]): void => {
    for (const b of list) {
      if (b.children === children) { found = b; return; }
      walk(b.children);
    }
  };
  walk(doc.children);
  return found;
}

/**
 * A container's raw is the authoritative render source (03 §2.2), so a
 * structural change to its children (insert/remove/move) must invalidate the
 * container's cached raw. Mark the owning container dirty so renderBlock
 * reconstructs it from the mutated children rather than emitting the now-stale
 * raw verbatim; ancestors see it via hasDirtyDescendant and reconstruct in turn.
 * Top-level siblings (doc.children) need no marking — renderDoc renders each
 * top-level block directly.
 */
export function markContainerDirty(doc: MutDoc, children: MutBlock[]): void {
  const owner = ownerOf(doc, children);
  if (owner) owner.dirty = true;
}

// Render the doc by splice (03 §2.2): leading trivia, optional frontmatter, then
// each top-level block + trivia. A block whose subtree contains no dirty node
// emits its retained raw verbatim. When a descendant is dirty, the block is
// re-rendered from its children (indented to their container) so nested edits
// — e.g. a task checkbox toggle inside a list — surface without disturbing
// untouched siblings.
export function renderDoc(doc: MutDoc): string {
  const out: string[] = [doc.leadingTrivia];
  if (doc.frontmatterRaw !== null) out.push(doc.frontmatterRaw);
  for (const b of doc.children) {
    out.push(renderBlock(b, 0));
    out.push(b.trivia);
  }
  return out.join("");
}

function hasDirtyDescendant(b: MutBlock): boolean {
  if (b.dirty) return true;
  return b.children.some(hasDirtyDescendant);
}

// Render one block. Leaf or fully-clean subtree ⇒ retained raw. Otherwise
// reconstruct from children (a container with a dirty descendant).
function renderBlock(b: MutBlock, depth: number): string {
  if (b.children.length === 0 || !hasDirtyDescendant(b)) return b.raw;
  // A list is reconstructed from its items: each item's raw already carries its
  // own marker + nested content (correctly indented), so we re-mark (ordered
  // lists renumber after a reorder/insert) and join with the list's own
  // tight/loose separator. This matches the canonical renderer, which treats a
  // top-level block's raw as the authoritative source for its whole subtree.
  if (b.type === "list") return renderList(b);
  // Other containers (blockquote/table, or a list_item outside a list): fall
  // back to the child-indent rebuild. Lists are the common mutable container.
  const indent = "  ".repeat(depth);
  return b.children.map((c) => indent + renderBlock(c, depth + 1).replace(/\n/g, "\n" + indent)).join("\n");
}

const MARKER_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/;

// Reconstruct a markdown list from its (possibly reordered / edited / added /
// removed) items. Item raws are self-contained (marker + text + nested); we
// only re-derive the leading marker so an ordered list renumbers correctly.
function renderList(list: MutBlock): string {
  const ordered = Boolean(list.attrs.ordered);
  const start = typeof list.attrs.start === "number" ? list.attrs.start : 1;
  const sep = list.raw.includes("\n\n") ? "\n\n" : "\n";
  return list.children.map((item, i) => renderItem(item, ordered ? `${start + i}. ` : "- ")).join(sep);
}

// Render one list item under the given marker. A retained item (no strictly
// deeper change) keeps its raw, only re-marking the first line so ordered
// numbers follow the current position. An item with a dirty descendant is
// rebuilt from its child blocks, marker on the first line and continuations
// indented by the marker width.
function renderItem(item: MutBlock, marker: string): string {
  if (item.children.some(hasDirtyDescendant)) {
    const body = item.children.map((c) => (c.type === "list" ? renderList(c) : renderBlock(c, 0))).join("\n");
    return applyMarker(body, marker);
  }
  return applyMarker(stripMarker(item.raw), marker);
}

// Remove a leading list marker + its indentation from the first line, and the
// same indent width from continuation lines, yielding the marker-free body.
function stripMarker(raw: string): string {
  const lines = raw.split("\n");
  const m = MARKER_RE.exec(lines[0] ?? "");
  if (!m) return raw;
  const width = m[0].length;
  return lines
    .map((ln, i) => (i === 0 ? ln.slice(width) : ln.slice(0, width).trim() === "" ? ln.slice(width) : ln))
    .join("\n");
}

// Prepend a marker to a marker-free body: marker on the first line, the rest
// indented by the marker width so nested content stays under the item.
function applyMarker(body: string, marker: string): string {
  const pad = " ".repeat(marker.length);
  return body.split("\n").map((ln, i) => (i === 0 ? marker + ln : ln.length ? pad + ln : ln)).join("\n");
}

/** Ordered ids of a parent's direct children (for parent_children_hash CAS). */
export function childIds(list: MutBlock[]): string[] {
  return list.map((b) => b.id);
}

export function parentChildrenHash(list: MutBlock[]): string {
  return sha256(childIds(list).join(",")).toString("hex");
}
