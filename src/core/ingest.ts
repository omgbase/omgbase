import { Store } from "./store/store.js";
import { parseTree } from "./parse/tree.js";
import { render } from "./parse/render.js";
import { assignIds, writeBlockTree, putBlob, newCommit, writeRevision, type TreeInputBlock } from "./store/writers.js";
import { sha256, normalizeVisibleText } from "./hash.js";
import { mintId } from "./ids.js";
import { keyBetween } from "./order-key.js";
import { ftsDeleteDoc, ftsIndexDoc } from "./store/fts.js";
import { rebuildSections } from "./store/sections.js";
import { parse as parseYaml } from "yaml";
import type { RawBlock } from "./parse/types.js";

// Ingest path (07 task 1.4): parse → assign ids → commit. By default every
// ingest re-mints (no identity threading). A caller (sync/) may supply an
// IdResolver that carries ids from the previous revision via reconciliation and
// returns dispositions to persist. Convergence invariant checked:
// file_hash == rendered_hash.

// A disposition row to persist (mirrors 02 §3 dispositions; kept structural so
// core does not depend on the reconcile module's types).
export interface DispositionRow {
  blockId: string;
  kind: string;
  confidence: number | null;
  reason: string | null;
  matcherV: string | null;
  detail: Record<string, unknown>;
}

// Given the parsed content blocks (frontmatter stripped) and the existing
// doc id (null if new), return an id-assigned tree plus dispositions + deleted
// old ids. Default resolver mints fresh ids (re-mint path).
export type IdResolver = (
  rest: RawBlock[],
  docId: string | null,
) => { assigned: TreeInputBlock[]; dispositions: DispositionRow[]; deleted: string[]; consumedPool?: string[] };

export interface IngestResult {
  docId: string;
  commitId: string;
  revId: string;
  blockCount: number;
  /** convergence: sha256(file bytes) === revision.rendered_hash */
  converged: boolean;
}

function extractFrontmatter(blocks: RawBlock[]): { fmBlock: RawBlock | null; rest: RawBlock[] } {
  if (blocks.length > 0 && blocks[0]!.type === "frontmatter") {
    return { fmBlock: blocks[0]!, rest: blocks.slice(1) };
  }
  return { fmBlock: null, rest: blocks };
}

// Parse a frontmatter block's raw (incl. --- fences) into a JSON-safe object.
// Malformed YAML yields {} — frontmatter is queryable metadata, not load-bearing.
function parseFrontmatter(fmBlock: RawBlock | null): Record<string, unknown> {
  if (!fmBlock) return {};
  const body = fmBlock.raw.replace(/^---\r?\n/, "").replace(/\r?\n?---\s*$/, "");
  try {
    const parsed = parseYaml(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Flatten the id-assigned tree into current-state block rows (02 §3 blocks).
interface BlockRow {
  blockId: string;
  parentBlock: string | null;
  orderKey: string;
  ordinal: number;
  depth: number;
  ancestorPath: string;
  type: string;
  attrs: string;
  text: string;
  rawHash: Buffer;
  normHash: Buffer;
}

function flatten(
  blocks: TreeInputBlock[],
  parent: string | null,
  depth: number,
  ancestorPath: string,
  out: BlockRow[],
): void {
  let prevKey: string | null = null;
  blocks.forEach((b, ordinal) => {
    const orderKey = keyBetween(prevKey, null);
    prevKey = orderKey;
    // Visible text drives query/FTS/outline; norm_hash drives reconciliation
    // phase 2 and strips markers per 02 §5.2.
    const visible = normalizeVisibleText(b.raw, b.type);
    out.push({
      blockId: b.blockId,
      parentBlock: parent,
      orderKey,
      ordinal,
      depth,
      ancestorPath,
      type: b.type,
      attrs: JSON.stringify(b.attrs),
      text: visible,
      rawHash: sha256(b.raw),
      normHash: sha256(visible),
    });
    if (b.children.length > 0) {
      flatten(b.children, b.blockId, depth + 1, `${ancestorPath}${b.blockId}/`, out);
    }
  });
}

/** Ingest a single file's content into the store as one observed commit. */
export function ingestFile(
  store: Store,
  repoId: string,
  path: string,
  content: string,
  opts: { ts?: string; origin?: "observed" | "import"; resolveIds?: IdResolver } = {},
): IngestResult {
  const ts = opts.ts ?? new Date().toISOString();
  const origin = opts.origin ?? "observed";

  return store.write((db): IngestResult => {
    const tree = parseTree(content);
    const { fmBlock, rest } = extractFrontmatter(tree.children);

    // Frontmatter is stored as a blob + parsed JSON view on the document, not a block.
    const fmBlobHex = fmBlock ? putBlob(db, fmBlock.raw) : null;
    const frontmatterJson = JSON.stringify(parseFrontmatter(fmBlock));

    // Upsert the document row (refresh frontmatter JSON view each ingest).
    let doc = db.prepare("SELECT doc_id FROM documents WHERE repo_id = ? AND path = ?").get(repoId, path) as
      | { doc_id: string }
      | undefined;
    const docId = doc?.doc_id ?? mintId("d");
    const isNew = !doc;
    if (!doc) {
      db.prepare(
        "INSERT INTO documents (doc_id, repo_id, path, frontmatter) VALUES (?, ?, ?, ?)",
      ).run(docId, repoId, path, frontmatterJson);
      doc = { doc_id: docId };
    } else {
      db.prepare("UPDATE documents SET frontmatter = ? WHERE doc_id = ?").run(frontmatterJson, docId);
    }

    // Assign block ids: reconciling resolver (carry from prior revision) if
    // supplied, else fresh mint. New docs always mint.
    const resolved = opts.resolveIds && !isNew
      ? opts.resolveIds(rest, docId)
      : { assigned: assignIds(rest), dispositions: [] as DispositionRow[], deleted: [] as string[] };
    const assigned = resolved.assigned;
    const rootTreeHex = writeBlockTree(db, assigned);

    const commit = newCommit(db, { repoId, ts, origin });
    const renderedHash = sha256(content);
    const rev = writeRevision(db, {
      docId,
      rootTreeHex,
      frontmatterBlobHex: fmBlobHex,
      renderedHash,
      path,
      commitId: commit.commitId,
    });

    // Snapshot deleted blocks into the resurrection pool BEFORE dropping the
    // doc's rows (the ingest rebuilds current-state blocks wholesale).
    if (resolved.deleted.length > 0) {
      const expires = new Date(Date.parse(ts) + 30 * 24 * 3600 * 1000).toISOString();
      const pool = db.prepare(
        `INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts)
         SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, ?, ? FROM blocks WHERE block_id = ? AND doc_id = ?`,
      );
      for (const id of resolved.deleted) pool.run(commit.commitId, expires, id, docId);
    }

    // Refresh current-state blocks (clear + repopulate with carried/minted ids).
    // FTS is external-content: delete old index rows before dropping blocks.
    ftsDeleteDoc(db, docId);
    db.prepare("DELETE FROM blocks WHERE doc_id = ?").run(docId);
    const rows: BlockRow[] = [];
    flatten(assigned, null, 0, "/", rows);
    const insert = db.prepare(
      `INSERT INTO blocks
         (block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth,
          ancestor_path, type, attrs, text, raw_hash, norm_hash, created_commit)
       VALUES
         (@blockId, @repoId, @docId, @parentBlock, @orderKey, @ordinal, @depth,
          @ancestorPath, @type, @attrs, @text, @rawHash, @normHash, @createdCommit)`,
    );
    for (const r of rows) {
      insert.run({ ...r, repoId, docId, createdCommit: commit.commitId });
    }
    ftsIndexDoc(db, docId);
    rebuildSections(db, docId);

    // Persist dispositions + block-history projection. With a resolver, use the
    // real reconciliation dispositions; otherwise record every block as inserted.
    const dispositions: DispositionRow[] =
      resolved.dispositions.length > 0 || opts.resolveIds
        ? resolved.dispositions
        : rows.map((r) => ({ blockId: r.blockId, kind: "inserted", confidence: null, reason: null, matcherV: null, detail: {} }));

    const insDisp = db.prepare(
      `INSERT OR IGNORE INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const bc = db.prepare("INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) VALUES (?, ?, ?)");
    for (const d of dispositions) {
      insDisp.run(commit.commitId, d.blockId, d.kind, d.confidence, d.reason, d.matcherV, JSON.stringify(d.detail));
      bc.run(d.blockId, commit.commitId, d.kind);
    }

    // Consumed pool rows (resurrected) are removed.
    for (const id of resolved.consumedPool ?? []) {
      db.prepare("DELETE FROM resurrection_pool WHERE block_id = ?").run(id);
    }

    // Update document current pointers + convergence hash.
    const fileHash = sha256(content);
    db.prepare("UPDATE documents SET current_rev = ?, file_hash = ? WHERE doc_id = ?").run(
      rev.revId,
      fileHash,
      docId,
    );

    // Convergence check (01 §2): file bytes vs rendered revision.
    const converged = fileHash.equals(renderedHash) && render(tree) === content;

    return {
      docId,
      commitId: commit.commitId,
      revId: rev.revId,
      blockCount: rows.length,
      converged,
    };
  });
}
