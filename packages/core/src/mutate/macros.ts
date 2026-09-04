import type { Store } from "../core/store/store.js";
import type { Op } from "./apply.js";
import type { To } from "./ops.js";

// Server-side macros (04 §3). Each expands deterministically to kernel ops —
// no policy judgment (that belongs in the agent). The expansion is returned so
// callers see the kernel ops that ran. Macros compose within one changeset.

function rawHashOfBlock(store: Store, blockId: string): string | null {
  const row = store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { h: string } | undefined;
  return row?.h ?? null;
}
function rawOfBlock(store: Store, blockId: string): string | null {
  const row = store.db.prepare(
    "SELECT b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.block_id = ? AND bl.deleted_commit IS NULL",
  ).get(blockId) as { bytes: Buffer } | undefined;
  return row?.bytes.toString("utf8") ?? null;
}

/** tasks_complete: update(attrs:{checked:true}) per block. */
export function tasksComplete(store: Store, blocks: string[]): Op[] {
  return blocks.map((block) => {
    const hash = rawHashOfBlock(store, block);
    return { op: "update", block, attrs: { checked: true }, ...(hash ? { expect: { content_hash: hash } } : {}) } as Op;
  });
}

/** sections_append: insert markdown at the end of a heading's section. */
export function sectionsAppend(heading: string, markdown: string): Op[] {
  const to: To = { parent: { heading, scope: "section" }, at: "end" };
  return [{ op: "insert", to, markdown }];
}

/** sections_rename: update the heading block's markdown to a new title. */
export function sectionsRename(store: Store, heading: string, title: string): Op[] {
  const raw = rawOfBlock(store, heading) ?? "";
  const level = (/^(#{1,6})\s/.exec(raw)?.[1] ?? "#").length;
  const hash = rawHashOfBlock(store, heading);
  const markdown = `${"#".repeat(level)} ${title}`;
  return [{ op: "update", block: heading, markdown, ...(hash ? { expect: { content_hash: hash } } : {}) } as Op];
}

/** sections_move: move a heading's whole section range to a new location. */
export function sectionsMove(store: Store, heading: string, to: To): Op[] {
  // The section range is the heading + blocks until the next peer/higher
  // heading. We resolve the contiguous top-level run of ids from the store.
  const docRow = store.db.prepare("SELECT doc_id, ordinal, json_extract(attrs,'$.level') level FROM blocks WHERE block_id = ?").get(heading) as { doc_id: string; ordinal: number; level: number | null } | undefined;
  if (!docRow) return [];
  const level = docRow.level ?? 1;
  const tops = store.db.prepare(
    "SELECT block_id, ordinal, type, json_extract(attrs,'$.level') level FROM blocks WHERE doc_id = ? AND parent_block IS NULL AND deleted_commit IS NULL ORDER BY ordinal",
  ).all(docRow.doc_id) as { block_id: string; ordinal: number; type: string; level: number | null }[];
  const startIdx = tops.findIndex((t) => t.block_id === heading);
  let end = tops.length;
  for (let i = startIdx + 1; i < tops.length; i++) {
    if (tops[i]!.type === "heading" && (tops[i]!.level ?? 1) <= level) { end = i; break; }
  }
  const run = tops.slice(startIdx, end).map((t) => t.block_id);
  return [{ op: "move", blocks: run, to }];
}

/** lists_insert_item: insert a list item at a position relative to a list/item. */
export function listsInsertItem(anchor: string, at: "start" | "end" | { before: string } | { after: string }, markdown: string): Op[] {
  const item = markdown.trimStart().startsWith("- ") ? markdown : `- ${markdown}`;
  return [{ op: "insert", to: { parent: anchor, at }, markdown: item }];
}

export interface RetargetHit {
  block: string;
  oldRaw: string;
  newRaw: string;
}

/** links_retarget: rewrite a link destination substring across affected blocks.
 * Returns kernel update ops (one per affected block) + the hits for dry-run
 * preview. v1 matches the target substring in block raw; Stage 4 will drive
 * this from the edge index for precision. */
export function linksRetarget(store: Store, repoId: string, fromTarget: string, toTarget: string): { ops: Op[]; hits: RetargetHit[] } {
  const rows = store.db.prepare(
    `SELECT bl.block_id, b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash
     WHERE bl.repo_id = ? AND bl.deleted_commit IS NULL AND instr(b.bytes, ?) > 0`,
  ).all(repoId, fromTarget) as { block_id: string; bytes: Buffer }[];

  const ops: Op[] = [];
  const hits: RetargetHit[] = [];
  for (const r of rows) {
    const oldRaw = r.bytes.toString("utf8");
    const newRaw = oldRaw.split(fromTarget).join(toTarget);
    if (newRaw === oldRaw) continue;
    const hash = rawHashOfBlock(store, r.block_id);
    ops.push({ op: "update", block: r.block_id, markdown: newRaw, ...(hash ? { expect: { content_hash: hash } } : {}) } as Op);
    hits.push({ block: r.block_id, oldRaw, newRaw });
  }
  return { ops, hits };
}
