import type { Store } from "../core/store/store.js";
import type { Op } from "./apply.js";
import type { To } from "./ops.js";
import { adapterForFormat } from "../format/registry.js";
import { MutationError } from "./tree.js";
import { globClause } from "../graph/link-health.js";
import { rewriteLinkDestinations, splitDestination } from "../graph/link-destinations.js";

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

/**
 * docs_append: insert markdown at the END of a whole document — the
 * document-root peer of sections_append (which appends within a heading's
 * section). ADDITIVE, not a whole-body replace: it parses `markdown` into new
 * blocks and inserts them as fresh top-level blocks after the document's
 * existing ones, so every existing block keeps its stable `b_` id. Expands to a
 * single insert op targeting the document top level (`{ doc: true }`, `at:
 * "end"`) with an explicit `doc` — the kernel then threads the new blocks in
 * without touching any prior block. The doc must already exist; resolving the
 * ref is the caller's job (a missing doc is doc_missing — creation belongs to
 * docs_create, never here).
 */
export function docsAppend(docId: string, markdown: string): Op[] {
  const to: To = { parent: { doc: true }, at: "end" };
  return [{ op: "insert", doc: docId, to, markdown }];
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
  /** repo-relative path of the block's document */
  path: string;
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

/** links_retarget: the single-pair form of linksRepair (delegates). */
export function linksRetarget(store: Store, repoId: string, fromTarget: string, toTarget: string, opts: LinkRepairOptions = {}): LinkRepairPlan {
  return linksRepair(store, repoId, [{ from: fromTarget, to: toTarget }], opts);
}

/** A single from→to link-destination rewrite. */
export interface LinkRepair {
  from: string;
  to: string;
}

export interface LinkRepairOptions {
  /** scope the SOURCE docs by a path glob (`journal/*`), mirroring linksStale. */
  pathGlob?: string;
}

/** Per-pair tally: how many link destinations `from` matched (across all hits). */
export interface LinkRepairCount extends LinkRepair {
  hits: number;
}

export interface LinkRepairPlan {
  /** kernel update ops, one per rewritten TOP-MOST block */
  ops: Op[];
  /** the rewritten blocks (dry-run preview) */
  hits: RetargetHit[];
  /** each input pair with its destination-match count (0 = nothing to fix) */
  pairs: LinkRepairCount[];
}

const stripSlash = (s: string): string => s.replace(/^\//, "");

// Does destination `dest` (as authored) name the same link target as `from`?
// Whole-destination match first (lets `from` carry its own #fragment), then the
// path part alone (the fragment rides along). Both sides compare with the
// leading `/` dropped, so `from` may be given either as authored (`/b.md`) or as
// links_stale reports `target` (`b.md`). Returns the fragment to re-append.
function destinationMatch(dest: string, from: string): { fragment: string } | null {
  if (stripSlash(dest) === stripSlash(from)) return { fragment: "" };
  const { path, fragment } = splitDestination(dest);
  if (fragment !== "" && stripSlash(path) === stripSlash(from)) return { fragment };
  return null;
}

/**
 * links_repair: bulk stale-link repair. Given a batch of {from,to} destination
 * rewrites, produce the kernel update ops plus the hits for dry-run preview.
 * Repairs compose within ONE changeset so an agent can fix many dangling
 * targets (surfaced by linksStale) at once.
 *
 * Scope: this rewrites LINK DESTINATIONS, not substrings. A destination is
 * rewritten only when `from` is the WHOLE destination of a Markdown link /
 * image, a wikilink, or a bare-path inline field (`key:: /path`) — ignoring the
 * leading `/`, and allowing a trailing `#heading`/`^ref` fragment which is
 * re-appended. Prose mentions, inline code, and `code_fence` blocks are never
 * touched, and a `from` that is merely a suffix/prefix of a longer path does
 * not match it. Each destination takes the FIRST matching pair (no chaining).
 * Frontmatter links are not blocks and are out of reach here (use docs_set_meta).
 *
 * Coalescing: a block hit by several pairs gets a single update op (one CAS pin
 * per block). Hits collapse to their TOP-MOST block: a list and its list items
 * both carry the same bytes, and updating the container re-parses (re-mints)
 * its children, so a second op on the child would fail block_missing and sink
 * the whole changeset. Mirrors opRemove's top-most collapse. No FS/network I/O.
 */
export function linksRepair(store: Store, repoId: string, repairs: LinkRepair[], opts: LinkRepairOptions = {}): LinkRepairPlan {
  const pairs: LinkRepairCount[] = repairs.map((r) => ({ from: r.from, to: r.to, hits: 0 }));
  const effective = pairs.filter((r) => stripSlash(r.from) !== "" && r.from !== r.to);
  if (effective.length === 0) return { ops: [], hits: [], pairs };

  // Candidate blocks: live, not a code fence, whose bytes contain the slash-less
  // form of some `from` (a cheap prefilter; the destination scan below decides).
  const params: unknown[] = [];
  let globSql = "";
  if (opts.pathGlob) {
    const { clause, param } = globClause("d.path", opts.pathGlob);
    globSql = `AND ${clause}`;
    params.push(param);
  }
  const stmt = store.db.prepare(
    `SELECT bl.block_id, bl.parent_block, d.path, b.bytes
     FROM blocks bl
     JOIN blobs b ON b.hash = bl.raw_hash
     JOIN docs d ON d.doc_id = bl.doc_id
     WHERE bl.repo_id = ? AND bl.deleted_commit IS NULL AND d.deleted_commit IS NULL
       AND bl.type != 'code_fence' AND instr(b.bytes, ?) > 0 ${globSql}`,
  );
  const candidates = new Map<string, { parent: string | null; path: string; raw: string }>();
  for (const key of new Set(effective.map((r) => stripSlash(r.from)))) {
    const rows = stmt.all(repoId, key, ...params) as { block_id: string; parent_block: string | null; path: string; bytes: Buffer }[];
    for (const row of rows) {
      if (!candidates.has(row.block_id)) candidates.set(row.block_id, { parent: row.parent_block, path: row.path, raw: row.bytes.toString("utf8") });
    }
  }

  // Rewrite each candidate's destinations; keep the blocks that changed.
  const changed = new Map<string, { parent: string | null; path: string; oldRaw: string; newRaw: string; tally: number[] }>();
  for (const [blockId, c] of candidates) {
    const tally = effective.map(() => 0);
    const newRaw = rewriteLinkDestinations(c.raw, (dest) => {
      for (let i = 0; i < effective.length; i++) {
        const m = destinationMatch(dest, effective[i]!.from);
        if (m) { tally[i]!++; return effective[i]!.to + m.fragment; }
      }
      return null;
    });
    if (newRaw !== c.raw) changed.set(blockId, { parent: c.parent, path: c.path, oldRaw: c.raw, newRaw, tally });
  }

  // Collapse to top-most blocks: drop a hit whose ancestor is also a hit.
  const parentOf = store.db.prepare("SELECT parent_block FROM blocks WHERE block_id = ? AND deleted_commit IS NULL");
  const hasChangedAncestor = (parent: string | null): boolean => {
    for (let p = parent; p !== null;) {
      if (changed.has(p)) return true;
      p = (parentOf.get(p) as { parent_block: string | null } | undefined)?.parent_block ?? null;
    }
    return false;
  };

  const ops: Op[] = [];
  const hits: RetargetHit[] = [];
  for (const [blockId, c] of changed) {
    if (hasChangedAncestor(c.parent)) continue;
    c.tally.forEach((n, i) => { effective[i]!.hits += n; });
    const hash = rawHashOfBlock(store, blockId);
    ops.push({ op: "update", block: blockId, markdown: c.newRaw, ...(hash ? { expect: { content_hash: hash } } : {}) } as Op);
    hits.push({ block: blockId, path: c.path, oldRaw: c.oldRaw, newRaw: c.newRaw });
  }
  return { ops, hits, pairs };
}
