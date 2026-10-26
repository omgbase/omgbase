import type { Database } from "better-sqlite3";
import { sha256 } from "../hash.js";
import { reconstructContent } from "../read/document.js";
import { clearAlert, listActiveAlerts, raiseAlert } from "./alerts.js";

// Legacy bytes (spec/store §3.4 step 17 (16), §5.11, §8 C9; store 17.4 —
// modular-core Phase 5a-ii, finding F1 of the migration qualification). A
// document ingested before the store kept block trivia (schema v6 added
// `blocks.trivia_hash`; v7 `docs.frontmatter_trivia`) has rows whose `raw`s
// are right but whose separators are gone: 16.x `reconstruct` assumed a NULL
// trivia meant empty trailing bytes and read `# H\n\n## T\n` as `# H## T`,
// while the file and `docs.file_hash` were correct. Migration 17 copies the
// rows as they are, so the 17 rows reproduce the same wrong bytes. The store
// records the condition as the `legacy_bytes` alert — raised by the migration
// (both entry points), re-derived by `doctor` and by every sweep while it is
// active — and `omg sync` repairs the rows from the files (`sync/legacy-bytes.ts`).
// No column is spent on it: the alert's detail carries the count and a bounded
// sample of ids, and the condition is re-derived where it is cheap enough.

/** The alert code (a `warning`). */
export const LEGACY_BYTES_ALERT = "legacy_bytes";

/** How many document ids the alert's `detail.sample` carries at most. */
export const LEGACY_BYTES_SAMPLE = 20;

/** The alert's message, byte for byte in both engines. */
export function legacyBytesMessage(docs: number): string {
  return `${docs} document(s) carry bytes the engine cannot reproduce from its rows (imported before block trivia was stored); omg sync repairs them from the files`;
}

export interface UnreproducibleDoc {
  docId: string;
  path: string;
}

/**
 * The fidelity check (spec/store §5.11 "The condition"): every live document
 * of the repository with a `file_hash` whose rows do NOT reproduce it —
 * `sha256(reconstruct(doc)) != file_hash` (§6.1) — in bytewise `path` order.
 * O(the repository's bytes): the migration runs it once, `doctor` on demand,
 * the sweep only while the alert is active.
 */
export function unreproducibleDocs(db: Database, repoId: string): UnreproducibleDoc[] {
  const rows = db
    .prepare("SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND file_hash IS NOT NULL ORDER BY path")
    .all(repoId) as { doc_id: string; path: string; file_hash: Buffer }[];
  const out: UnreproducibleDoc[] = [];
  for (const r of rows) {
    const content = reconstructContent(db, r.doc_id);
    if (content === null) continue;
    if (!sha256(content).equals(r.file_hash)) out.push({ docId: r.doc_id, path: r.path });
  }
  return out;
}

/**
 * The cheap signature of legacy rows (spec/store §3.4 step 17 (16), the
 * on-open entry point): a live top-level block with a NULL `trivia` that has
 * a later top-level sibling in its document, or a live document with a
 * `frontmatter_raw` and no `frontmatter_trivia`. The current ingest never
 * writes either — spec/format §1 rule 4: a block's `raw` never ends in a line
 * ending, so the bytes between two top-level blocks are at least one, and the
 * frontmatter's separator is always stored. A metadata scan of `blocks`, no
 * bytes hashed; when it fires the full check runs.
 */
export function legacyBytesSuspected(db: Database, repoId: string): boolean {
  const block = db
    .prepare(
      `SELECT 1 FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
        WHERE d.repo_id = ? AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND b.parent_block IS NULL AND b.trivia IS NULL
          AND EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block IS NULL AND c.deleted_at IS NULL AND c.order_key > b.order_key)
        LIMIT 1`,
    )
    .get(repoId);
  if (block) return true;
  return !!db.prepare("SELECT 1 FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND frontmatter_raw IS NOT NULL AND frontmatter_trivia IS NULL LIMIT 1").get(repoId);
}

/**
 * Re-derive the condition at `now` and write the channel (spec/store §5.8):
 * some unreproducible document → `legacy_bytes` raised (`warning`, detail
 * `{ docs: <n>, sample: [<the first 20 ids in path order>] }`); none → cleared.
 * `docs` may be supplied by a caller that just computed it. Returns the list.
 */
export function refreshLegacyBytesAlert(db: Database, repoId: string, now: string, docs: UnreproducibleDoc[] = unreproducibleDocs(db, repoId)): UnreproducibleDoc[] {
  if (docs.length > 0) {
    raiseAlert(db, repoId, {
      code: LEGACY_BYTES_ALERT,
      severity: "warning",
      message: legacyBytesMessage(docs.length),
      detail: { docs: docs.length, sample: docs.slice(0, LEGACY_BYTES_SAMPLE).map((d) => d.docId) },
    }, now);
  } else {
    clearAlert(db, repoId, LEGACY_BYTES_ALERT, now);
  }
  return docs;
}

/** Whether the repository's `legacy_bytes` alert is active (the sweep's gate for the repair, spec/sync §4.3 step 5). */
export function legacyBytesActive(db: Database, repoId: string): boolean {
  return listActiveAlerts(db, repoId).some((a) => a.code === LEGACY_BYTES_ALERT);
}
