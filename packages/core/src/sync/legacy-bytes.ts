import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import { parseForIngest } from "../core/ingest.js";
import { sha256 } from "../core/hash.js";
import { reconstructContent } from "../core/read/document.js";

// The legacy-bytes REPAIR (spec/store §5.11 "The repair"; spec/sync §4.3 step
// 5; store 17.4 / sync 4.4 — modular-core Phase 5a-ii, finding F1). A document
// the `legacy_bytes` alert names has the right `raw`s and the wrong (missing)
// separators (`core/store/legacy-bytes.ts`). When its file is present and
// `sha256(file) == docs.file_hash` — the bytes the store already agrees with
// (I1) — the sweep rewrites the SEPARATOR columns from the file's parse and
// nothing else: `blocks.trivia`/`trivia_hash` per block, `docs.leading_trivia`
// and `frontmatter_trivia`. Every block keeps its id (the parse must have the
// stored tree's exact shape, types and `raw`s — identical texts map to the same
// ids positionally, no matcher involved), the head stays (content, structure,
// path and liveness did not change — D1), no feed row, no revision, no change
// to `updated_at`: the recorder's captured head stays the 16.x capture (legacy
// fidelity — `docs_read { at: <head> }` renders the legacy bytes with
// `renderedHashMatch: false`, as it did through 16.x).

/** Why a named document was not repaired by this sweep (spec/sync §4.3 step 5). */
export type LegacyRepairOutcome =
  /** the separators were rewritten; `sha256(reconstruct) == file_hash` holds again */
  | "repaired"
  /** the parse of the file does not have the rows' shape, types, `raw`s or frontmatter raw — not a pure separator loss; the document stays listed */
  | "structure_differs"
  /** the rewrite did not make the rows reproduce the file (rolled back); the document stays listed */
  | "not_reproduced";

interface StoredRow {
  block_id: string;
  parent_block: string | null;
  ordinal: number;
  type: string;
  raw: string;
}

/**
 * Pair every stored block with the parsed block at the same position, or null
 * when the trees differ in shape, type or `raw` anywhere.
 */
function pairPositionally(rows: StoredRow[], parsed: RawBlock[]): { blockId: string; block: RawBlock }[] | null {
  const children = new Map<string | null, StoredRow[]>();
  for (const r of rows) {
    let list = children.get(r.parent_block);
    if (!list) children.set(r.parent_block, (list = []));
    list.push(r);
  }
  for (const list of children.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  const out: { blockId: string; block: RawBlock }[] = [];
  const walk = (parent: string | null, blocks: RawBlock[]): boolean => {
    const stored = children.get(parent) ?? [];
    if (stored.length !== blocks.length) return false;
    for (let i = 0; i < blocks.length; i++) {
      const s = stored[i]!;
      const b = blocks[i]!;
      if (s.type !== b.type || s.raw !== b.raw) return false;
      out.push({ blockId: s.block_id, block: b });
      if (!walk(s.block_id, b.children)) return false;
    }
    return true;
  };
  if (!walk(null, parsed)) return null;
  return out.length === rows.length ? out : null;
}

/**
 * Repair one legacy document from `content` — the file's bytes, which the
 * caller has checked hash to the document's `file_hash`. One transaction (a
 * savepoint inside a caller's); a rewrite that does not make the rows
 * reproduce the file is rolled back. Writes no feed row, no head, no
 * timestamp.
 */
export function repairLegacyBytes(store: Store, docId: string, path: string, content: string): LegacyRepairOutcome {
  class NotReproduced extends Error {}
  try {
    return store.write((db): LegacyRepairOutcome => {
      const doc = db
        .prepare("SELECT leading_trivia, frontmatter_raw, frontmatter_trivia FROM docs WHERE doc_id = ? AND deleted_at IS NULL")
        .get(docId) as { leading_trivia: string; frontmatter_raw: string | null; frontmatter_trivia: string | null } | undefined;
      if (!doc) return "structure_differs";
      const { tree, fmBlock, rest } = parseForIngest(path, content);
      if ((fmBlock?.raw ?? null) !== doc.frontmatter_raw) return "structure_differs";
      const rows = db
        .prepare("SELECT block_id, parent_block, ordinal, type, raw FROM blocks WHERE doc_id = ? AND deleted_at IS NULL")
        .all(docId) as StoredRow[];
      const pairs = pairPositionally(rows, rest);
      if (pairs === null) return "structure_differs";
      rewriteSeparators(db, docId, tree.leadingTrivia, fmBlock ? fmBlock.trivia : null, pairs);
      const after = reconstructContent(db, docId);
      if (after === null || !sha256(after).equals(sha256(content))) throw new NotReproduced();
      return "repaired";
    });
  } catch (e) {
    if (e instanceof NotReproduced) return "not_reproduced";
    throw e;
  }
}

/** The separator columns, and nothing else: `leading_trivia`, `frontmatter_trivia`, every block's `trivia`/`trivia_hash` (NULL when empty — spec/store §8 C2). */
function rewriteSeparators(db: Database, docId: string, leadingTrivia: string, frontmatterTrivia: string | null, pairs: { blockId: string; block: RawBlock }[]): void {
  db.prepare("UPDATE docs SET leading_trivia = ?, frontmatter_trivia = ? WHERE doc_id = ?").run(leadingTrivia, frontmatterTrivia, docId);
  const upd = db.prepare("UPDATE blocks SET trivia = ?, trivia_hash = ? WHERE block_id = ? AND doc_id = ?");
  for (const { blockId, block } of pairs) {
    const trivia = block.trivia.length > 0 ? block.trivia : null;
    upd.run(trivia, trivia === null ? null : sha256(trivia), blockId, docId);
  }
}
