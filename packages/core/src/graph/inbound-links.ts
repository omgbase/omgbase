import type { Store } from "../core/store/store.js";
import { extractFromBlock, maskCode, resolveRelativePath } from "./extract.js";

// Inbound-link discovery + destination-aware link rewriting. Used by docs_move
// (mutate/docs.ts) to (a) report which source blocks will dangle once a
// document leaves its path and (b) optionally rewrite those links to the new
// path. The OPEN edge index says WHICH blocks link to the doc (no repo scan);
// the block raw says HOW each link is written (so the rewrite is a destination
// rewrite, not a substring replace — a code span mentioning the old path, or a
// different doc whose path merely contains it, is left alone).
//
// Path resolution mirrors sync/reconciling-ingest.ts resolveAdapterEdge exactly:
// `./` and `../` destinations resolve against the source doc's directory, any
// other destination is root-relative, one leading `/` is stripped. A link
// "resolves to" a doc path when that canonical form equals the doc's path.

export interface InboundLink {
  /** source document id */
  doc: string;
  /** source document repo-relative path */
  path: string;
  /** source block id; null for a frontmatter-level edge */
  block: string | null;
  /** the link's destination path as written (e.g. "/old.md", "../old.md", "old.md") */
  target: string;
  /** #heading / ^ref fragment, if any */
  anchor: string | null;
  /** frontmatter key or inline-field key for typed edges */
  field?: string;
}

function canonical(path: string): string {
  return path.replace(/^\/+/, "");
}

function dirOf(path: string): string {
  return path.replace(/[^/]*$/, "");
}

/** Does a destination written in a doc under `srcDir` resolve to `docPath`? */
function resolvesTo(dest: string, srcDir: string, docPath: string): boolean {
  if (dest === "" || /^[a-z][a-z0-9+.-]*:/i.test(dest)) return false;
  return canonical(resolveRelativePath(dest, srcDir)) === docPath;
}

/**
 * Every link occurrence in the repo whose destination resolves to `docPath`,
 * found via the open edges that point at `docId`. Block-level edges are
 * re-scanned from the block raw so `target`/`anchor` are as written (and so a
 * self-doc pure-fragment link `#H`, which also has dst_node == docId, is NOT
 * reported — it does not depend on the path). Frontmatter edges are reported
 * with `block: null`, `target: docPath`, and their `field`.
 */
export function inboundLinksTo(store: Store, repoId: string, docId: string, docPath: string): InboundLink[] {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT e.src_doc AS srcDoc, d.path AS srcPath, e.src_block AS srcBlock, e.src_field AS srcField
       FROM edges e JOIN docs d ON d.doc_id = e.src_doc
       WHERE e.repo_id = ? AND e.dst_node = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL
       ORDER BY d.path, e.src_block`,
    )
    .all(repoId, docId) as { srcDoc: string; srcPath: string; srcBlock: string | null; srcField: string | null }[];

  const out: InboundLink[] = [];
  const seenBlocks = new Set<string>();
  for (const r of rows) {
    if (r.srcBlock === null) {
      out.push({ doc: r.srcDoc, path: r.srcPath, block: null, target: docPath, anchor: null, ...(r.srcField ? { field: r.srcField } : {}) });
      continue;
    }
    if (seenBlocks.has(r.srcBlock)) continue;
    seenBlocks.add(r.srcBlock);
    const blk = store.db
      .prepare("SELECT bl.type, b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.block_id = ? AND bl.deleted_commit IS NULL")
      .get(r.srcBlock) as { type: string; bytes: Buffer } | undefined;
    if (!blk) continue;
    const srcDir = dirOf(r.srcPath);
    for (const e of extractFromBlock(r.srcBlock, blk.type, blk.bytes.toString("utf8"))) {
      if (e.dstKind === "external" || !resolvesTo(e.target, srcDir, docPath)) continue;
      out.push({
        doc: r.srcDoc,
        path: r.srcPath,
        block: r.srcBlock,
        target: e.target,
        anchor: e.anchor,
        ...(e.srcField ? { field: e.srcField } : {}),
      });
    }
  }
  return out;
}

// Relative path from directory `fromDir` ("a/b/" or "") to file `to`.
function relativePath(fromDir: string, to: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const target = to.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < target.length && from[i] === target[i]) i++;
  const ups = from.length - i;
  const rest = target.slice(i).join("/");
  return ups === 0 ? `./${rest}` : `${"../".repeat(ups)}${rest}`;
}

// Rewrite one destination (path + optional fragment) if its path resolves to
// `fromPath`, keeping the author's style: absolute stays absolute, `./`/`../`
// stays relative (recomputed from `writeDir`), bare root-relative stays bare.
function rewriteDest(dest: string, matchDir: string, writeDir: string, fromPath: string, toPath: string): string | null {
  const hashIdx = dest.indexOf("#");
  const caretIdx = dest.indexOf("^");
  let cut = dest.length;
  if (caretIdx >= 0 && (hashIdx < 0 || caretIdx < hashIdx)) cut = caretIdx;
  else if (hashIdx >= 0) cut = hashIdx;
  const pathPart = dest.slice(0, cut);
  const fragment = dest.slice(cut);
  if (!resolvesTo(pathPart, matchDir, fromPath)) return null;
  let newPath: string;
  if (pathPart.startsWith("/")) newPath = "/" + toPath;
  else if (pathPart.startsWith("./") || pathPart.startsWith("../")) newPath = relativePath(writeDir, toPath);
  else newPath = toPath;
  return newPath + fragment;
}

// Destination-bearing syntaxes, with the destination isolated in group 2 so we
// can splice it in place. Scanned over the code-MASKED raw (positions carry
// over 1:1 to the original), so links inside code are never touched.
const MD_LINK_DEST = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const WIKILINK_DEST = /(!?\[\[)([^\]]+)(\]\])/g;
const INLINE_FIELD_PATH = /((?:^|\s)[a-z][a-z0-9_]*::\s*)(\/[^\s]+)/gi;

/**
 * Rewrite every link destination in `raw` that resolves (relative to `matchDir`,
 * the source doc's directory at extraction time) to `fromPath` so it points at
 * `toPath`, writing relative forms against `writeDir` (the source doc's current
 * directory — differs from `matchDir` only for links inside the moved doc
 * itself). Anchors, link text, titles, and code spans are preserved. Returns
 * null when nothing changed.
 */
export function retargetLinksInRaw(raw: string, matchDir: string, writeDir: string, fromPath: string, toPath: string): string | null {
  const masked = maskCode(raw);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const re of [MD_LINK_DEST, WIKILINK_DEST, INLINE_FIELD_PATH]) {
    for (const m of masked.matchAll(re)) {
      const dest = m[2]!;
      const replaced = rewriteDest(dest, matchDir, writeDir, fromPath, toPath);
      if (replaced === null) continue;
      const start = (m.index ?? 0) + m[1]!.length;
      edits.push({ start, end: start + dest.length, text: replaced });
    }
  }
  if (edits.length === 0) return null;
  edits.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out === raw ? null : out;
}
