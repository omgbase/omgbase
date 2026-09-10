import type { Store } from "../core/store/store.js";
import type { Op } from "./apply.js";
import type { To } from "./ops.js";
import { adapterForFormat } from "../format/registry.js";
import { MutationError } from "./tree.js";

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

/** node_set: surgically set one editable property of a node (node-editability).
 * Resolves the node → its block + owning doc's format adapter, runs the adapter's
 * registered editor for (kind, prop) against the block's current raw + the node's
 * span, and returns a single kernel `update` op (markdown or attrs) with a CAS
 * pin. The node stays a read-only projection; the write goes through the block.
 * Throws node_not_editable when no editor is registered for (kind, prop). */
export function nodeSet(store: Store, nodeId: string, prop: string, value: string): Op[] {
  const node = store.db.prepare(
    `SELECT n.kind, n.name, n.value, n.attrs, n.span_start, n.span_end, n.block_id,
            d.format AS format
     FROM nodes n JOIN docs d ON d.doc_id = n.doc_id
     WHERE n.node_id = ?`,
  ).get(nodeId) as
    | { kind: string; name: string | null; value: string | null; attrs: string; span_start: number | null; span_end: number | null; block_id: string | null; format: string }
    | undefined;
  if (!node) throw new MutationError("block_missing", `node ${nodeId} not found`, {});
  if (!node.block_id) throw new MutationError("node_not_editable", `node ${nodeId} is not anchored to a block`, {});

  const adapter = adapterForFormat(node.format);
  const editor = adapter?.nodeEditors?.[node.kind]?.[prop];
  if (!editor) {
    throw new MutationError("node_not_editable", `no editor for ${node.kind}.${prop}`, {
      kind: node.kind, prop, editable: editablePropsFor(node.format, node.kind),
    });
  }

  const blockRaw = rawOfBlock(store, node.block_id);
  if (blockRaw === null) throw new MutationError("block_missing", `block ${node.block_id} not found`, {});
  const hash = rawHashOfBlock(store, node.block_id);

  const result = editor(
    {
      blockRaw,
      span: node.span_start !== null && node.span_end !== null ? { start: node.span_start, end: node.span_end } : null,
      node: {
        kind: node.kind,
        ...(node.name !== null ? { name: node.name } : {}),
        ...(node.value !== null ? { value: node.value } : {}),
        attrs: JSON.parse(node.attrs || "{}") as Record<string, unknown>,
      },
    },
    value,
  );

  const expect = hash ? { expect: { content_hash: hash } } : {};
  if ("markdown" in result) {
    return [{ op: "update", block: node.block_id, markdown: result.markdown, ...expect } as Op];
  }
  return [{ op: "update", block: node.block_id, attrs: result.attrs, ...expect } as Op];
}

/** The editable property names registered for a (format, kind), for discovery. */
export function editablePropsFor(format: string, kind: string): string[] {
  const editors = adapterForFormat(format)?.nodeEditors?.[kind];
  return editors ? Object.keys(editors) : [];
}

/** links_retarget: rewrite a link destination substring across affected blocks.
 * Returns kernel update ops (one per affected block) + the hits for dry-run
 * preview. v1 matches the target substring in block raw; Stage 4 will drive
 * this from the edge index for precision. */
export function linksRetarget(store: Store, repoId: string, fromTarget: string, toTarget: string): { ops: Op[]; hits: RetargetHit[] } {
  return linksRepair(store, repoId, [{ from: fromTarget, to: toTarget }]);
}

/** A single from→to link-destination rewrite. */
export interface LinkRepair {
  from: string;
  to: string;
}

/**
 * links_repair: bulk stale-link repair. The multi-pair generalization of
 * links_retarget — given a batch of {from,to} destination rewrites, produce the
 * kernel update ops (one per affected block, coalesced across pairs) plus the
 * hits for dry-run preview. Repairs compose within ONE changeset so an agent can
 * fix many dangling targets (surfaced by linksStale) at once.
 *
 * Op generation reuses the same substring rewrite as the single-pair case (they
 * share this function; linksRetarget delegates here) — a block hit by more than
 * one pair accumulates all rewrites into a single update op, keeping the
 * content-hash CAS pin valid (one op per block, not per pair). No FS/network I/O.
 */
export function linksRepair(store: Store, repoId: string, repairs: LinkRepair[]): { ops: Op[]; hits: RetargetHit[] } {
  const effective = repairs.filter((r) => r.from !== "" && r.from !== r.to);
  if (effective.length === 0) return { ops: [], hits: [] };

  // Collect candidate blocks once per distinct `from` substring.
  const byBlock = new Map<string, string>(); // block_id → current best raw (bytes)
  const stmt = store.db.prepare(
    `SELECT bl.block_id, b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash
     WHERE bl.repo_id = ? AND bl.deleted_commit IS NULL AND instr(b.bytes, ?) > 0`,
  );
  for (const r of effective) {
    const rows = stmt.all(repoId, r.from) as { block_id: string; bytes: Buffer }[];
    for (const row of rows) if (!byBlock.has(row.block_id)) byBlock.set(row.block_id, row.bytes.toString("utf8"));
  }

  const ops: Op[] = [];
  const hits: RetargetHit[] = [];
  for (const [blockId, oldRaw] of byBlock) {
    // Apply every pair's substring rewrite in sequence to this block's raw.
    let newRaw = oldRaw;
    for (const r of effective) newRaw = newRaw.split(r.from).join(r.to);
    if (newRaw === oldRaw) continue;
    const hash = rawHashOfBlock(store, blockId);
    ops.push({ op: "update", block: blockId, markdown: newRaw, ...(hash ? { expect: { content_hash: hash } } : {}) } as Op);
    hits.push({ block: blockId, oldRaw, newRaw });
  }
  return { ops, hits };
}
