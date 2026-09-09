import { Store } from "./store/store.js";
import { parseTree } from "./parse/tree.js";
import { render } from "./parse/render.js";
import { reconstructContent } from "./read/document.js";
import { assignIds, writeBlockTree, putBlob, newCommit, writeRevision, type TreeInputBlock } from "./store/writers.js";
import { sha256, normalizeVisibleText } from "./hash.js";
import { mintId } from "./ids.js";
import { keyBetween } from "./order-key.js";
import { ftsDeleteDoc, ftsIndexDoc } from "./store/fts.js";
import { rebuildSections } from "./store/sections.js";
import { writeDocNodes } from "./store/nodes.js";
import { flattenFrontmatter, flattenComputed, writeDocProperties, type PropertyRow } from "./store/properties.js";
import { maintainEdges, adoptPhantoms } from "./store/edges.js";
import { parse as parseYaml } from "yaml";
import type { RawBlock, BlockTree } from "./parse/types.js";
import { adapterForPath } from "../format/index.js";

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

// A resolved edge to persist (05 §2). Kept structural so core does not depend
// on the graph module's extractor.
export interface ResolvedEdgeRow {
  srcDoc: string;
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: "document" | "block" | "external" | "collection";
  dstNode: string;
  anchor: string | null;
  provenance: string;
}

// Given the parsed content blocks (frontmatter stripped) and the existing
// doc id (null if new), return an id-assigned tree plus dispositions + deleted
// old ids. Default resolver mints fresh ids (re-mint path). Optionally returns
// extractEdges: a callback run after ids are assigned + doc id is known, so the
// caller (sync/) can produce resolved edges for this revision.
export type IdResolver = (
  rest: RawBlock[],
  docId: string | null,
) => {
  assigned: TreeInputBlock[];
  dispositions: DispositionRow[];
  deleted: string[];
  consumedPool?: string[];
  extractEdges?: (docId: string, frontmatter: Record<string, unknown>) => ResolvedEdgeRow[];
};

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
  triviaHash: Buffer | null;
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
      triviaHash: b.trivia.length > 0 ? sha256(b.trivia) : null,
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
  opts: { ts?: string; origin?: "observed" | "import"; resolveIds?: IdResolver; format?: string } = {},
): IngestResult {
  const ts = opts.ts ?? new Date().toISOString();
  const origin = opts.origin ?? "observed";
  const adapter = adapterForPath(path);
  const format = opts.format ?? adapter?.format ?? "markdown";

  return store.write((db): IngestResult => {
    const tree: BlockTree = adapter ? adapter.parse(content) : parseTree(content);
    const { fmBlock, rest } = extractFrontmatter(tree.children);

    // Frontmatter blob (markdown-specific) preserved for revision history.
    const fmBlobHex = fmBlock ? putBlob(db, fmBlock.raw) : null;
    // The exact separator bytes between the frontmatter block and the first body
    // block (the frontmatter block's trailing trivia). Persisted so the body
    // reconstructs byte-for-byte instead of assuming a canonical blank line.
    // NULL when there is no frontmatter.
    const fmTrivia = fmBlock ? fmBlock.trivia : null;

    // Document property bag: adapter-provided for non-markdown formats,
    // frontmatter-parsed for markdown. Flattened into the properties table
    // below (source=frontmatter); also drives frontmatter edge extraction.
    const metadata = (adapter?.extractMetadata)
      ? (adapter.extractMetadata(content) ?? parseFrontmatter(fmBlock))
      : parseFrontmatter(fmBlock);

    // Upsert the document row.
    let doc = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ?").get(repoId, path) as
      | { doc_id: string }
      | undefined;
    const docId = doc?.doc_id ?? mintId("d");
    const isNew = !doc;
    if (!doc) {
      db.prepare(
        "INSERT INTO docs (doc_id, repo_id, path, format, leading_trivia, frontmatter_trivia) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(docId, repoId, path, format, tree.leadingTrivia, fmTrivia);
      doc = { doc_id: docId };
      // Adopt phantom edges that pointed at this path so backlinks re-point.
      adoptPhantoms(db, path, docId);
    } else {
      db.prepare("UPDATE docs SET format = ?, leading_trivia = ?, frontmatter_trivia = ? WHERE doc_id = ?").run(format, tree.leadingTrivia, fmTrivia, docId);
    }

    // Assign block ids via the resolver when supplied (it reconciles against
    // the prior revision — for a new doc that's an empty old tree, so all blocks
    // mint — and also drives edge extraction). Without a resolver, fresh-mint.
    const resolved = opts.resolveIds
      ? opts.resolveIds(rest, isNew ? null : docId)
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
          ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit)
       VALUES
         (@blockId, @repoId, @docId, @parentBlock, @orderKey, @ordinal, @depth,
          @ancestorPath, @type, @attrs, @text, @rawHash, @normHash, @triviaHash, @createdCommit)`,
    );
    for (const r of rows) {
      insert.run({ ...r, repoId, docId, createdCommit: commit.commitId });
    }
    ftsIndexDoc(db, docId);
    rebuildSections(db, docId);

    // Node projection: adapter-provided semantic features from parsed blocks.
    const propertyRows: PropertyRow[] = [];
    if (adapter?.projectNodes) {
      const rawBlocks = rest.map(toProjectionInput);
      const projected = adapter.projectNodes(rawBlocks);
      // Rewrite blockIds to real assigned ids; discard unmappable placeholders.
      const idSet = collectBlockIds(assigned);
      const withIds = projected.map((n) => ({
        ...n,
        blockId: n.blockId && idSet.has(n.blockId) ? n.blockId : "",
      }));
      writeDocNodes(db, repoId, docId, withIds);

      // Inline properties (key:: value) → property rows (source=inline). Repeats
      // of the same key accumulate; each occurrence is a card='list' row in
      // document order (block ordinal drives ordering downstream).
      const inlineOrd = new Map<string, number>();
      for (const n of withIds) {
        if (n.kind !== "md:inline_field" || !n.name) continue;
        const ord = inlineOrd.get(n.name) ?? 0;
        inlineOrd.set(n.name, ord + 1);
        propertyRows.push({
          source: "inline",
          blockId: n.blockId || null,
          key: n.name,
          card: "list",
          ord,
          ...typedInlineValue(n.value),
        });
      }
    }

    // Frontmatter → property rows (source=frontmatter). Flatten nested maps to
    // dotted keys, arrays to ord-indexed list rows, scalars to a scalar row.
    for (const r of flattenFrontmatter(metadata)) {
      propertyRows.push({ source: "frontmatter", blockId: null, ...r });
    }

    // Computed → property rows (source=computed). Engine-derived $-intrinsics
    // ($title, $tags) from the adapter; never claim authored keys.
    if (adapter?.computeProperties) {
      const computed = adapter.computeProperties(rest, metadata);
      for (const r of flattenComputed(computed)) {
        propertyRows.push({ source: "computed", blockId: null, ...r });
      }
    }

    writeDocProperties(db, repoId, docId, commit.commitId, propertyRows);

    // Edge extraction + interval maintenance (05 §2), if the resolver supplies
    // an extractor. Runs in this commit transaction.
    if (resolved.extractEdges) {
      const extracted = resolved.extractEdges(docId, metadata);
      maintainEdges(db, repoId, docId, commit.commitId, extracted);
    }

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
    db.prepare("UPDATE docs SET current_rev = ?, file_hash = ? WHERE doc_id = ?").run(
      rev.revId,
      fileHash,
      docId,
    );

    // Convergence check (01 §2): file bytes vs rendered revision. Two independent
    // round-trips must both reproduce the source exactly:
    //   1. the freshly-parsed in-memory tree (validates the parser), and
    //   2. a reload from storage (validates that persisted blocks + trivia +
    //      frontmatter separator tile the source — the fidelity a plain read or
    //      an `apply` write actually depends on). Rendering only the in-memory
    //      tree hid store→reload separator loss; reconstructContent closes that.
    const renderFn = adapter?.render ?? render;
    const converged =
      fileHash.equals(renderedHash) &&
      renderFn(tree) === content &&
      reconstructContent(db, docId) === content;

    return {
      docId,
      commitId: commit.commitId,
      revId: rev.revId,
      blockCount: rows.length,
      converged,
    };
  });
}

function toProjectionInput(b: RawBlock): RawBlock {
  return b;
}

// Inline field values arrive as captured strings; coerce to a typed column so
// numeric/bool inline props (priority:: 3) compare like their frontmatter kin.
// A value that isn't cleanly numeric/bool stays a string.
function typedInlineValue(raw: string | undefined): Pick<PropertyRow, "valText" | "valNum" | "valBool" | "valJson" | "type"> {
  const v = (raw ?? "").trim();
  if (v === "true" || v === "false") return { valText: null, valNum: null, valBool: v === "true" ? 1 : 0, valJson: null, type: "bool" };
  if (v !== "" && Number.isFinite(Number(v))) return { valText: null, valNum: Number(v), valBool: null, valJson: null, type: "number" };
  return { valText: v, valNum: null, valBool: null, valJson: null, type: "string" };
}

function collectBlockIds(blocks: TreeInputBlock[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: TreeInputBlock[]): void => {
    for (const b of list) {
      ids.add(b.blockId);
      if (b.children.length > 0) walk(b.children);
    }
  };
  walk(blocks);
  return ids;
}
