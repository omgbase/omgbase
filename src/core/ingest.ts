import { Store } from "./store/store.js";
import { parseTree } from "./parse/tree.js";
import { render } from "./parse/render.js";
import { assignIds, writeBlockTree, putBlob, newCommit, writeRevision, type TreeInputBlock } from "./store/writers.js";
import { sha256, normalizeVisibleText } from "./hash.js";
import { mintId } from "./ids.js";
import { keyBetween } from "./order-key.js";
import { ftsDeleteDoc, ftsIndexDoc } from "./store/fts.js";
import type { RawBlock } from "./parse/types.js";

// Ingest path (07 task 1.4): parse → mint → commit. Stage 1 re-mints every
// ingest (no identity threading yet — explicitly temporary, replaced in Stage 2
// by reconciliation). Convergence invariant checked: file_hash == rendered_hash.

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
  opts: { ts?: string; origin?: "observed" | "import" } = {},
): IngestResult {
  const ts = opts.ts ?? new Date().toISOString();
  const origin = opts.origin ?? "observed";

  return store.write((db): IngestResult => {
    const tree = parseTree(content);
    const { fmBlock, rest } = extractFrontmatter(tree.children);

    // Frontmatter is stored as a blob + parsed JSON view on the document, not a block.
    const fmBlobHex = fmBlock ? putBlob(db, fmBlock.raw) : null;

    const assigned = assignIds(rest);
    const rootTreeHex = writeBlockTree(db, assigned);

    // Upsert the document row.
    let doc = db.prepare("SELECT doc_id FROM documents WHERE repo_id = ? AND path = ?").get(repoId, path) as
      | { doc_id: string }
      | undefined;
    const docId = doc?.doc_id ?? mintId("d");
    if (!doc) {
      db.prepare(
        "INSERT INTO documents (doc_id, repo_id, path, frontmatter) VALUES (?, ?, ?, ?)",
      ).run(docId, repoId, path, "{}");
      doc = { doc_id: docId };
    }

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

    // Refresh current-state blocks (Stage 1 re-mint: clear + repopulate).
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
