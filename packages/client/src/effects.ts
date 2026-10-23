// The Effect vocabulary of `plan` / `execute` / `apply` (spec/mutate §11; the
// `effectSchema` description in packages/core/src/mcp/server.ts is the wire
// truth) as typed builders. Every builder returns exactly the object the server
// reads — no renaming, no defaults the server would not apply — so an effect
// built here can be logged, diffed and handed to `apply` unchanged.
//
// Targets are spelled in the explicit object form (`{ kind: "document", _path }`
// rather than a bare path) so a reader of a log never has to guess what a
// string meant; the server accepts both.

/** A document by its id or its path (either form, `/a/b.md` or `a/b.md`). */
export type DocumentTarget = { kind: "document"; _id: string } | { kind: "document"; _path: string };
export type BlockTarget = { kind: "block"; _id: string };
export type NodeTarget = { kind: "node"; _id: string };
/** A heading's section: the heading block's id. */
export type SectionTarget = { kind: "section"; heading_id: string };
/** `$new.<n>`: an identity an earlier effect of the same request creates. */
export type NewSymbol = `$new.${number}`;

/** What an effect may point at: the explicit forms, a `$new.n`, or (as the server
 * also accepts) a bare document path or a bare block/node id. */
export type Target = DocumentTarget | BlockTarget | NodeTarget | SectionTarget | NewSymbol | string;

/** A place among a parent's children. */
export type At = "start" | "end" | { before: string } | { after: string };

/** The guards of a single-target effect: the kernel's two CAS fields plus the
 * document's revision at plan time. A failed guard is `stale_expectation` (a
 * hash) or `stale_plan` (a revision). */
export interface Expect {
  content_hash?: string;
  parent_children_hash?: string;
  revision?: string;
}

/** Per-block guards of `remove`/`merge` over several blocks, keyed by block id. */
export type ExpectMap = Record<string, { content_hash?: string; parent_children_hash?: string }>;

export type Effect =
  | { op: "create"; path: string; markdown: string; frontmatter?: Record<string, unknown> }
  | { op: "insert"; into: Target; at?: At; markdown: string; expect?: Expect }
  | { op: "set"; target: Target; field: string; value: unknown; expect?: Expect }
  | { op: "unset"; target: Target; field: string; expect?: Expect }
  | { op: "move"; target: Target; to: string; retarget_inbound?: boolean }
  | { op: "move"; targets: Target[]; into: Target; at?: At; expect?: Expect }
  | { op: "remove"; target: Target }
  | { op: "remove"; targets: Target[]; expect?: ExpectMap }
  | { op: "split"; target: Target; at: number[]; expect?: Expect }
  | { op: "merge"; targets: Target[]; separator?: string; expect?: ExpectMap }
  | { op: "retarget"; repairs: { from: string; to: string }[]; path_glob?: string };

export const EFFECT_OPS = ["create", "insert", "set", "unset", "move", "remove", "split", "merge", "retarget"] as const;
export type EffectOp = (typeof EFFECT_OPS)[number];

// ---- targets ------------------------------------------------------------------

/** How a caller may name a document: a path string, `{ _id }`, `{ _path }`, or an explicit target. */
export type DocRef = string | { _id: string } | { _path: string } | DocumentTarget;

/** `{ kind: "document", _id }` or `{ kind: "document", _path }` — exactly one locator. */
export function documentTarget(ref: DocRef): DocumentTarget {
  if (typeof ref === "string") return { kind: "document", _path: ref };
  if ("kind" in ref) return ref;
  return "_id" in ref ? { kind: "document", _id: ref._id } : { kind: "document", _path: ref._path };
}

export function blockTarget(id: string): BlockTarget {
  return { kind: "block", _id: id };
}

export function nodeTarget(id: string): NodeTarget {
  return { kind: "node", _id: id };
}

export function sectionTarget(headingId: string): SectionTarget {
  return { kind: "section", heading_id: headingId };
}

/** The `$new.<n>` symbol of the n-th identity this request creates. */
export function newSymbol(n: number): NewSymbol {
  return `$new.${n}`;
}

// ---- guards -------------------------------------------------------------------

export interface BlockGuard {
  /** The block's current `_hash` (docs_read include_ids → `hashes[id]`): the write fails `stale_expectation` when it moved. */
  contentHash?: string;
}

export interface DocumentGuard {
  /** The document's `rev` at read time: the write fails `stale_plan` when the document moved on. */
  revision?: string;
}

export interface ParentGuard {
  /** sha256-hex of the destination parent's current direct child ids joined by `,`. */
  parentChildrenHash?: string;
}

function blockExpect(g: BlockGuard | undefined): { expect: Expect } | Record<string, never> {
  return g?.contentHash !== undefined ? { expect: { content_hash: g.contentHash } } : {};
}

function documentExpect(g: DocumentGuard | undefined): { expect: Expect } | Record<string, never> {
  return g?.revision !== undefined ? { expect: { revision: g.revision } } : {};
}

// ---- block effects --------------------------------------------------------------

/** The two attributes a block's `set` may address beside its markdown. */
export type BlockAttr = "checked";

/** `set _attrs.<attr>` on a block (a task's checkbox: `setBlockAttr(id, "checked", true, { contentHash })`). */
export function setBlockAttr(blockId: string, attr: BlockAttr, value: unknown, guard?: BlockGuard): Effect {
  return { op: "set", target: blockTarget(blockId), field: `_attrs.${attr}`, value, ...blockExpect(guard) };
}

/** Replace a block's source: `set markdown`. */
export function setBlockMarkdown(blockId: string, markdown: string, guard?: BlockGuard): Effect {
  return { op: "set", target: blockTarget(blockId), field: "markdown", value: markdown, ...blockExpect(guard) };
}

/** Parse `markdown` into new blocks under `into` (a document = its top level; a
 * block = its children; a section = the heading's range) at `at`. */
export function insertMarkdown(into: DocRef | BlockTarget | SectionTarget | NewSymbol, at: At, markdown: string, guard?: ParentGuard): Effect {
  const target: Target = typeof into === "object" && "kind" in into ? into : typeof into === "string" && /^\$new\.\d+$/.test(into) ? into : documentTarget(into as DocRef);
  return { op: "insert", into: target, at, markdown, ...(guard?.parentChildrenHash !== undefined ? { expect: { parent_children_hash: guard.parentChildrenHash } } : {}) };
}

/** Remove blocks; `expect` keyed by block id pins each one's hash. */
export function removeBlocks(blockIds: string[], expect?: ExpectMap): Effect {
  return { op: "remove", targets: blockIds.map(blockTarget), ...(expect !== undefined ? { expect } : {}) };
}

/** Move blocks under a new parent at `at` (the parent guard is the destination's). */
export function moveBlocks(blockIds: string[], into: DocRef | BlockTarget | SectionTarget, at: At, guard?: ParentGuard): Effect {
  const target: Target = typeof into === "object" && "kind" in into ? into : documentTarget(into);
  return { op: "move", targets: blockIds.map(blockTarget), into: target, at, ...(guard?.parentChildrenHash !== undefined ? { expect: { parent_children_hash: guard.parentChildrenHash } } : {}) };
}

// ---- document effects -----------------------------------------------------------

/** `set _frontmatter.<key>` on a document. */
export function setFrontmatter(doc: DocRef, key: string, value: unknown, guard?: DocumentGuard): Effect {
  return { op: "set", target: documentTarget(doc), field: `_frontmatter.${key}`, value, ...documentExpect(guard) };
}

/** `unset _frontmatter.<key>` on a document. */
export function unsetFrontmatter(doc: DocRef, key: string, guard?: DocumentGuard): Effect {
  return { op: "unset", target: documentTarget(doc), field: `_frontmatter.${key}`, ...documentExpect(guard) };
}

/** Replace a document's whole body (`set content`, the whole-document planner). */
export function setContent(doc: DocRef, content: string, guard?: DocumentGuard): Effect {
  return { op: "set", target: documentTarget(doc), field: "content", value: content, ...documentExpect(guard) };
}

/** Create a document at `path` (no live document and no file may exist there). */
export function createDocument(path: string, markdown: string, frontmatter?: Record<string, unknown>): Effect {
  return { op: "create", path, markdown, ...(frontmatter !== undefined ? { frontmatter } : {}) };
}

/** Move (rename) a document to `to`; `retargetInbound` rewrites the links that pointed at it. */
export function moveDocument(doc: DocRef, to: string, opts: { retargetInbound?: boolean } = {}): Effect {
  return { op: "move", target: documentTarget(doc), to, ...(opts.retargetInbound !== undefined ? { retarget_inbound: opts.retargetInbound } : {}) };
}

/** Delete a document. */
export function removeDocument(doc: DocRef): Effect {
  return { op: "remove", target: documentTarget(doc) };
}
