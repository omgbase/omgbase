import { Store } from "./store/store.js";
import { parseTree } from "./parse/tree.js";
import { render } from "./parse/render.js";
import { reconstructContent } from "./read/document.js";
import { assignIds, type TreeInputBlock } from "./store/writers.js";
import { requireHistory, claimsOf } from "./capabilities/registry.js";
import { appendFeedEntry, appendFeedRow, feedRowOf } from "./store/feed.js";
import { sha256, childQuoteDepth, visibleText } from "./hash.js";
import { mintId } from "./ids.js";
import { keyBetween } from "./order-key.js";
import { ftsBeforeEvictRows, ftsDeleteDoc, ftsIndexDoc } from "./store/fts.js";
import { rebuildSections } from "./store/sections.js";
import { writeDocNodes, projectSectionNodes, toByteSpans } from "./store/nodes.js";
import { flattenFrontmatter, flattenComputed, writeDocProperties, type PropertyRow } from "./store/properties.js";
import { maintainEdges, adoptPhantoms } from "./store/edges.js";
import { parse as parseYaml } from "yaml";
import type { RawBlock, BlockTree } from "./parse/types.js";
import type { Database } from "better-sqlite3";
import { adapterForPath } from "../format/index.js";

// Ingest path (07 task 1.4): parse → assign ids → commit. By default every
// ingest re-mints (no identity threading). A caller (sync/) may supply an
// IdResolver that carries ids from the previous revision via reconciliation and
// returns dispositions to persist. Since store 17.0 (modular-core Phase 3a) the
// current state is self-contained: the core mints the head token (`docs.head`,
// D1), writes the frontmatter raw on the doc row and every block's bytes on its
// row (D10), stamps `created_at`/`updated_at` (D6), and hands the accepted
// transition to the recorder (`HistoryRecorder.captureRevision`), which keeps
// its own history tables. Convergence invariant checked: `reconstruct(doc) ==
// source` from the rows alone.

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

/** spec/store §5.4 step 10 (14.2): which verdicts the store persists — every kind but `same`. */
export function persistsDisposition(kind: string): boolean {
  return kind !== "same";
}

// A resolved edge to persist (05 §2). Kept structural so core does not depend
// on the graph module's extractor.
export interface ResolvedEdgeRow {
  srcDoc: string;
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: "document" | "block" | "external";
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
  /** Ids carried INTO this document from another one in the same checkpoint
   * (cross-document moves, reconciliation-spec §8). The other doc may still hold
   * a `blocks` row for them (it commits later in the batch, or was tombstoned);
   * ingest evicts those rows so the id can be re-homed regardless of order. */
  crossDocIds?: string[];
  extractEdges?: (docId: string, frontmatter: Record<string, unknown>) => ResolvedEdgeRow[];
};

/** The parse step of ingest, exported so a batch caller can parse + reconcile
 * every document of a checkpoint BEFORE committing any (the cross-document
 * phase needs all per-doc results first) and hand the tree back via
 * `opts.parsed`. Frontmatter is split off: `rest` is what the IdResolver sees. */
export function parseForIngest(path: string, content: string): { tree: BlockTree; fmBlock: RawBlock | null; rest: RawBlock[] } {
  const adapter = adapterForPath(path);
  const tree: BlockTree = adapter ? adapter.parse(content) : parseTree(content);
  return { tree, ...extractFrontmatter(tree.children) };
}

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

// Parse a frontmatter block's raw (incl. --- fences) into a JSON-safe object:
// the YAML text is the raw minus its first line (the opening `---`) and its last
// line (the closing `---`, with any trailing whitespace); `\n` or `\r\n` endings
// (spec/properties §3.1). Malformed YAML, or a document that is not a mapping,
// yields {} — frontmatter is queryable metadata, not load-bearing.
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
  /** The block's raw source, stored inline (spec/store §3.1 `blocks.raw`, 17.0 D10). */
  raw: string;
  rawHash: Buffer;
  normHash: Buffer;
  /** The trailing trivia, NULL when empty (`blocks.trivia`). */
  trivia: string | null;
  triviaHash: Buffer | null;
}

// `quoteDepth` is the number of blockquote ancestors — the §4.1 text rule needs
// it (spec/format), and containers derive text from their children.
function flatten(
  blocks: TreeInputBlock[],
  parent: string | null,
  depth: number,
  ancestorPath: string,
  out: BlockRow[],
  quoteDepth = 0,
): void {
  let prevKey: string | null = null;
  blocks.forEach((b, ordinal) => {
    const orderKey = keyBetween(prevKey, null);
    prevKey = orderKey;
    const visible = visibleText(b, quoteDepth);
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
      raw: b.raw,
      rawHash: sha256(b.raw),
      normHash: sha256(visible),
      trivia: b.trivia.length > 0 ? b.trivia : null,
      triviaHash: b.trivia.length > 0 ? sha256(b.trivia) : null,
    });
    if (b.children.length > 0) {
      flatten(b.children, b.blockId, depth + 1, `${ancestorPath}${b.blockId}/`, out, childQuoteDepth(b.type, quoteDepth));
    }
  });
}

/** The options of `ingestFile` — one observed/api/import commit of one file. */
export interface IngestFileOptions {
  ts?: string;
  /** Commit provenance. `observed` = a file edit picked up by sync; `api` = an intent write (apply/docs_*), which should also carry `actor`/`reason`; `import` = bulk ingest with no retro history. */
  origin?: "observed" | "import" | "api";
  actor?: string | null;
  reason?: string | null;
  resolveIds?: IdResolver;
  format?: string;
  /** A tree already parsed from `content` (via `parseForIngest`) — skips the
   * re-parse. The caller guarantees it is the parse of these exact bytes. */
  parsed?: BlockTree;
  /** The document's `conflicted` flag (git conflict markers in the bytes),
   * written in the same statement as the current-revision pointers so the
   * flag and the revision it describes land in one transaction (spec/store
   * §5.4 step 14). Absent ⇒ the column is left untouched — the observe path
   * sets it on every commit; api writes never touch it. */
  conflicted?: boolean;
  /** The observed batch this commit belongs to (spec/store §5.4 step 5, D4):
   * the first committing member's commit id; absent ⇒ a batch of one
   * (`batch_id = commit_id`). */
  batchId?: string | null;
}

/** The options of `ingestInto`: the commit the revision hangs off is the
 * caller's (spec/store §5.4 step 5 ran already), and `ts` is that commit's
 * timestamp (the pool expiry is computed from it). */
export interface IngestIntoOptions {
  ts: string;
  /** The feed row (`appendFeedRow`) this ingest writes its entry, block rows, properties and edges under — the recorder's `commits` row shares the id. */
  commitId: string;
  resolveIds?: IdResolver | undefined;
  format?: string | undefined;
  parsed?: BlockTree | undefined;
  conflicted?: boolean | undefined;
  /** The path the document was at before this commit when the commit also
   * moves it (a `docs_move` whose moved document is rewritten by the same
   * request, spec/mutate §6): the feed entry is then `moved` with this
   * `from_path` (D11) rather than `changed`. */
  movedFrom?: string | undefined;
}

/**
 * Ingest a single file's content into the store as ONE commit of its own:
 * mint the commit row, then `ingestInto` it, in one transaction. The
 * observe path (`sync/observe.ts`, attach, recovery, the driver) commits one
 * member per call this way; the api path (`mutate/commit.ts`) instead opens
 * one transaction and one commit for a whole request and calls `ingestInto`
 * per document (spec/store §5.4 "The api path", spec/mutate §4 step 5).
 */
export function ingestFile(
  store: Store,
  repoId: string,
  path: string,
  content: string,
  opts: IngestFileOptions = {},
): IngestResult {
  const ts = opts.ts ?? new Date().toISOString();
  const origin = opts.origin ?? "observed";
  return store.write((db): IngestResult => {
    // spec/store §5.4 step 5: the feed row (the core's; the recorder's `commits`
    // row is written under the same id inside `appendFeedRow`).
    const commit = appendFeedRow(db, { repoId, ts, origin, actor: opts.actor ?? null, reason: opts.reason ?? null, batchId: opts.batchId ?? null });
    return ingestInto(db, repoId, path, content, {
      ts,
      commitId: commit.commitId,
      resolveIds: opts.resolveIds,
      format: opts.format,
      parsed: opts.parsed,
      conflicted: opts.conflicted,
    });
  });
}

/**
 * spec/store §5.4 steps 1–3 and 6–15 for one document under an EXISTING
 * feed row, inside the caller's transaction (`db` is the connection the
 * caller's `store.write` handed it; nothing here opens one). The head token
 * is minted here (step 6) and the document's feed entry written (step 5's
 * entry: `created` for an inserted or revived row, `moved` when the commit
 * also moved it, else `changed`); the pool snapshot, the properties and the
 * edge intervals name `commitId`; the captured revision and the dispositions
 * are the recorder's (step 15).
 */
export function ingestInto(
  db: Database,
  repoId: string,
  path: string,
  content: string,
  opts: IngestIntoOptions,
): IngestResult {
  const { ts, commitId } = opts;
  const adapter = adapterForPath(path);
  const format = opts.format ?? adapter?.format ?? "markdown";
  const tree: BlockTree = opts.parsed ?? (adapter ? adapter.parse(content) : parseTree(content));
  const { fmBlock, rest } = extractFrontmatter(tree.children);

  // The exact separator bytes between the frontmatter block and the first body
  // block (the frontmatter block's trailing trivia). Persisted so the body
  // reconstructs byte-for-byte instead of assuming a canonical blank line.
  // NULL when there is no frontmatter.
  const fmTrivia = fmBlock ? fmBlock.trivia : null;

  // Document property bag — the document's AUTHORED MAPPING. For a `yaml` or
  // `json` document it is the whole document's top-level mapping, from the
  // adapter's `extractMetadata` (spec/properties §3.4, 1.2: null for a
  // non-mapping root, a syntax error or an empty file; a YAML stream's first
  // document only); for Markdown — whose adapter has no `extractMetadata` — the
  // YAML of the `frontmatter` block and nothing else (§3.1: a document whose
  // first block is not `frontmatter` has no frontmatter rows, whatever else its
  // bytes resemble). Either way it is flattened into the properties table below
  // under source=frontmatter — the same source, because it is the same thing
  // (§3.4: "frontmatter" names the document's authored mapping) — and drives
  // frontmatter edge extraction.
  const metadata = adapter?.extractMetadata
    ? (adapter.extractMetadata(content) ?? {})
    : parseFrontmatter(fmBlock);

  // spec/store §5.4 step 1 (17.0): the frontmatter raw is a current value on
  // the doc row — fences included, never a delta (the recorder keeps its own
  // delta-encoded copy, step 15).
  const fmRaw = fmBlock ? fmBlock.raw : null;

  // Upsert the document row (step 2).
  let doc = db.prepare("SELECT doc_id, deleted_at FROM docs WHERE repo_id = ? AND path = ?").get(repoId, path) as
    | { doc_id: string; deleted_at: string | null }
    | undefined;
  const docId = doc?.doc_id ?? mintId("d");
  const isNew = !doc;
  // spec/store §2.1 (17.0): every id the core mints is claimed in the
  // transaction that writes the row carrying it — the claim is the writer's,
  // written after the minter yielded (`minted_at = ts`).
  const claims = claimsOf(db);
  let revived = false;
  if (!doc) {
    claims.claim("d", docId, repoId, ts);
    // `created_at` is the identity's birth (D6); `updated_at` moves with the head (step 12).
    db.prepare(
      "INSERT INTO docs (doc_id, repo_id, path, format, leading_trivia, frontmatter_raw, frontmatter_trivia, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(docId, repoId, path, format, tree.leadingTrivia, fmRaw, fmTrivia, ts, ts);
    doc = { doc_id: docId, deleted_at: null };
    // Adopt phantom edges that pointed at this path so backlinks re-point.
    adoptPhantoms(db, path, docId);
  } else {
    // A tombstoned row still owns the path's identity (spec/store §5.6
    // "Re-creation"): bytes observed again at the path revive it — the row is
    // live again, so reads that filter `deleted_at IS NULL` see it and the
    // next identical observation echo-gates instead of re-ingesting. A revival
    // keeps `created_at` (D6).
    revived = doc.deleted_at !== null;
    db.prepare("UPDATE docs SET format = ?, leading_trivia = ?, frontmatter_raw = ?, frontmatter_trivia = ?, deleted_at = NULL WHERE doc_id = ?").run(format, tree.leadingTrivia, fmRaw, fmTrivia, docId);
    // spec/graph §3.5: adoption happens whenever a row BECOMES live, so a
    // revived tombstone also collects the phantom edges minted at its path
    // while it was gone (§8 "Fixed — a revived document adopted no phantoms").
    if (revived) adoptPhantoms(db, path, docId);
  }

  // Assign block ids via the resolver when supplied (it reconciles against
  // the prior revision — for a new doc that's an empty old tree, so all blocks
  // mint — and also drives edge extraction). Without a resolver, fresh-mint.
  const resolved = opts.resolveIds
    ? opts.resolveIds(rest, isNew ? null : docId)
    : { assigned: assignIds(rest), dispositions: [] as DispositionRow[], deleted: [] as string[] };
  const assigned = resolved.assigned;

  // spec/store §5.4 step 6 (17.0, D1): the HEAD TOKEN is the core's — minted
  // here, at the point the recorder's `writeRevision` minted it through 16.x,
  // so the mint order (`b` in pass 1, `d`, `c`, `r`, `x`, `e`) and every
  // fixture id hold. The core numbers and hashes nothing against a previous
  // revision (M1): the recorder is handed the accepted transition (step 15)
  // and writes its `revisions` row under this token, its tree and frontmatter
  // deltas against its OWN previous captured revision. Legacy capture stays
  // on for every repository through Phase 3, so `revisions.rev_id == head`.
  const history = requireHistory(db);
  const renderedHash = sha256(content);
  const head = mintId("r");
  claims.claim("r", head, repoId, ts);
  // spec/store §5.4 step 5 (17.0, 3d): the document's feed entry, under the
  // commit's feed row — written now that the token exists, in this transaction.
  const feedRow = feedRowOf(db, commitId);
  const entryKind = opts.movedFrom !== undefined && opts.movedFrom !== path ? "moved" : isNew || revived ? "created" : "changed";
  appendFeedEntry(db, { repoId, epoch: feedRow.epoch, seq: feedRow.seq, docId, path, head, hash: renderedHash, kind: entryKind, fromPath: entryKind === "moved" ? opts.movedFrom! : null });
  history.captureRevision({
    docId,
    head,
    path,
    commitId,
    blocks: assigned,
    frontmatterRaw: fmRaw,
    renderedHash,
  });

  // The timestamps the new rows carry forward (D6, step 9): the doc's previous
  // live rows (a carried block keeps `created_at`, and `updated_at` too when
  // its verdict is `same`), the pool rows about to be consumed (a resurrected
  // block keeps its birth), and the foreign rows about to be evicted (a
  // cross-document move keeps it too). Read BEFORE anything below deletes them.
  const previous = new Map<string, { created_at: string; updated_at: string }>();
  for (const r of db.prepare("SELECT block_id, created_at, updated_at FROM blocks WHERE doc_id = ? AND deleted_at IS NULL").all(docId) as { block_id: string; created_at: string; updated_at: string }[]) {
    previous.set(r.block_id, r);
  }
  const pooledBirth = new Map<string, string>();
  if ((resolved.consumedPool ?? []).length > 0) {
    const poolRow = db.prepare("SELECT created_at FROM resurrection_pool WHERE block_id = ?");
    for (const id of resolved.consumedPool!) {
      const r = poolRow.get(id) as { created_at: string } | undefined;
      if (r) pooledBirth.set(id, r.created_at);
    }
  }

  // Snapshot deleted blocks into the resurrection pool BEFORE dropping the
  // doc's rows (the ingest rebuilds current-state blocks wholesale). The pool
  // row carries the block's `created_at` so a resurrection restores it (D6).
  // The deleted ids keep their claims (§2.1): nothing here releases one.
  if (resolved.deleted.length > 0) {
    const expires = new Date(Date.parse(ts) + 30 * 24 * 3600 * 1000).toISOString();
    const pool = db.prepare(
      `INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts)
       SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, ?, ? FROM blocks WHERE block_id = ? AND doc_id = ?`,
    );
    // `deleted_at = ts` and `expires_ts = deleted_at + 30 days` (I6, 17.0): the
    // pool row's expiry is anchored on its own timestamp, not on a commit.
    for (const id of resolved.deleted) pool.run(ts, expires, id, docId);
  }

  // Ids arriving from ANOTHER document — a cross-document move whose source
  // commits later in this checkpoint (or was tombstoned in it), or a
  // resurrection out of a tombstoned doc whose rows still sit in `blocks` —
  // must not collide on the block_id primary key. Evict the foreign row (and
  // its FTS entry when live) and drop any pool row: the id is live here now.
  const incoming = [...(resolved.crossDocIds ?? []), ...(resolved.consumedPool ?? [])];
  const foreignBirth = incoming.length > 0 ? evictForeignBlockRows(db, docId, incoming) : new Map<string, string>();

  // The verdict per block decides its timestamps (spec/store §5.4 step 9,
  // 17.0): `created_at` is carried for a carry (`same`, `edited`, `moved`,
  // `edited_moved` — the previous live row's), restored for `resurrected`
  // (the pool row's), kept across a cross-document move (the evicted row's),
  // and `ts` for `inserted` and the lineage kinds (a new identity is born
  // now); `updated_at` is the previous row's only under `same` (14.2's rule:
  // a block is updated when IT changes), else `ts`.
  const verdicts = new Map<string, Set<string>>();
  for (const d of resolved.dispositions) {
    let kinds = verdicts.get(d.blockId);
    if (!kinds) verdicts.set(d.blockId, (kinds = new Set()));
    kinds.add(d.kind);
  }
  const stamps = (blockId: string): { createdAt: string; updatedAt: string } => {
    const kinds = verdicts.get(blockId);
    const prev = previous.get(blockId);
    if (kinds?.has("resurrected")) return { createdAt: pooledBirth.get(blockId) ?? foreignBirth.get(blockId) ?? ts, updatedAt: ts };
    const foreign = foreignBirth.get(blockId);
    if (foreign !== undefined && !prev) return { createdAt: foreign, updatedAt: ts };
    if (prev) return { createdAt: prev.created_at, updatedAt: kinds !== undefined && kinds.size === 1 && kinds.has("same") ? prev.updated_at : ts };
    return { createdAt: ts, updatedAt: ts };
  };

  // Refresh current-state blocks (clear + repopulate with carried/minted ids),
  // every row carrying its own bytes (step 9; D10). FTS is external-content:
  // delete old index rows before dropping blocks.
  ftsDeleteDoc(db, docId);
  db.prepare("DELETE FROM blocks WHERE doc_id = ?").run(docId);
  const rows: BlockRow[] = [];
  flatten(assigned, null, 0, "/", rows);
  const insert = db.prepare(
    `INSERT INTO blocks
       (block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth,
        ancestor_path, type, attrs, text, raw, raw_hash, norm_hash, trivia, trivia_hash, created_at, updated_at)
     VALUES
       (@blockId, @repoId, @docId, @parentBlock, @orderKey, @ordinal, @depth,
        @ancestorPath, @type, @attrs, @text, @raw, @rawHash, @normHash, @trivia, @triviaHash, @createdAt, @updatedAt)`,
  );
  for (const r of rows) {
    insert.run({ ...r, repoId, docId, ...stamps(r.blockId) });
    // spec/store §2.1 / §5.4 step 9 (17.0): a block id that was neither a
    // live row of this doc, nor pooled, nor evicted from another doc was
    // minted for this commit — claim it now, in this transaction. (Idempotent:
    // an id that came from any of the three already has its claim.)
    if (!previous.has(r.blockId) && !pooledBirth.has(r.blockId) && !foreignBirth.has(r.blockId)) claims.claim("b", r.blockId, repoId, ts);
  }
  ftsIndexDoc(db, docId);
  rebuildSections(db, docId);

  // Node projection: adapter-provided semantic features from parsed blocks,
  // plus engine-derived `md:section` nodes from the (just-rebuilt) sections
  // table. Written together in one pass (writeDocNodes clears + repopulates).
  const propertyRows: PropertyRow[] = [];
  const sectionNodes = projectSectionNodes(db, docId);
  if (adapter?.projectNodes) {
    // Zip assigned block ids onto the parsed blocks so projectNodes can anchor
    // each node to its own block (the parsed RawBlocks are pre-identity).
    const rawBlocks = zipAssignedIds(rest, assigned);
    const projected = adapter.projectNodes(rawBlocks);
    // Keep only nodes anchored to a real assigned block id.
    const idSet = collectBlockIds(assigned);
    const withIds = projected.map((n) => ({
      ...n,
      blockId: n.blockId && idSet.has(n.blockId) ? n.blockId : "",
    }));
    // Adapters record spans as string indices; the store keeps byte offsets
    // into the block's UTF-8 raw (spec/graph §2.3), so convert here — the one
    // place that has both the nodes and the raws they index.
    const rawById = collectRaws(assigned);
    const byteSpanned = toByteSpans(withIds, (id) => rawById.get(id));
    writeDocNodes(db, repoId, docId, [...byteSpanned, ...sectionNodes]);

    // Inline properties (key:: value) → property rows (source=inline). The
    // authored shape within the inline source drives `card`: a key that occurs
    // exactly once in the document is `scalar` (so `element == "fire"` can
    // match a lone `element:: fire`); a key that repeats is `list`. Repeats
    // accumulate as ord-indexed rows in document order (block ordinal, then
    // in-block position — the order withIds already carries). Effective bare-
    // key cardinality (a frontmatter+inline collision) is decided at query
    // time by the single-value gate on scalar comparisons (see compile.ts),
    // not here — each source stays honest to its own authored shape.
    const inlineFields = withIds.filter((n) => n.kind === "md:inline_field" && n.name);
    const inlineCounts = new Map<string, number>();
    for (const n of inlineFields) inlineCounts.set(n.name!, (inlineCounts.get(n.name!) ?? 0) + 1);
    const inlineOrd = new Map<string, number>();
    for (const n of inlineFields) {
      const ord = inlineOrd.get(n.name!) ?? 0;
      inlineOrd.set(n.name!, ord + 1);
      propertyRows.push({
        source: "inline",
        blockId: n.blockId || null,
        key: n.name!,
        card: (inlineCounts.get(n.name!) ?? 0) > 1 ? "list" : "scalar",
        ord,
        ...typedInlineValue(n.value),
      });
    }
  } else if (sectionNodes.length > 0) {
    // No adapter node projection, but the document still has sections.
    writeDocNodes(db, repoId, docId, sectionNodes);
  }

  // Frontmatter → property rows (source=frontmatter). Flatten nested maps to
  // dotted keys, arrays to ord-indexed list rows, scalars to a scalar row.
  for (const r of flattenFrontmatter(metadata)) {
    propertyRows.push({ source: "frontmatter", blockId: null, ...r });
  }

  // Computed → property rows (source=computed). Engine-derived $-intrinsics
  // ($title, $tags) from the adapter; never claim authored keys. Only the
  // Markdown adapter computes (spec/properties §3.3): a `yaml`/`json` document
  // has no body prose to derive a heading or a hashtag from, and its authored
  // `title`/`tags` are reached as any other key of its mapping (§3.4), so it
  // yields no computed rows.
  if (adapter?.computeProperties) {
    const computed = adapter.computeProperties(rest, metadata);
    for (const r of flattenComputed(computed)) {
      propertyRows.push({ source: "computed", blockId: null, ...r });
    }
  }

  writeDocProperties(db, repoId, docId, propertyRows);

  // Edge extraction + open-edge maintenance (spec/graph §3.3; store 17.0, M6),
  // if the resolver supplies an extractor. Runs in this commit transaction; the
  // transition's edge list goes to the recorder inside `maintainEdges`.
  if (resolved.extractEdges) {
    const extracted = resolved.extractEdges(docId, metadata);
    maintainEdges(db, repoId, docId, commitId, extracted, ts);
  }

  // Persist dispositions + block-history projection. With a resolver, use the
  // real reconciliation dispositions; otherwise record every block as inserted.
  const dispositions: DispositionRow[] =
    resolved.dispositions.length > 0 || opts.resolveIds
      ? resolved.dispositions
      : rows.map((r) => ({ blockId: r.blockId, kind: "inserted", confidence: null, reason: null, matcherV: null, detail: {} }));

  // spec/store §5.4 step 15: the reconciliation evidence is the recorder's
  // (`HistoryRecorder.recordDispositions` — every non-`same` verdict, 14.2).
  history.recordDispositions(commitId, dispositions);

  // Consumed pool rows (resurrected) are removed.
  for (const id of resolved.consumedPool ?? []) {
    db.prepare("DELETE FROM resurrection_pool WHERE block_id = ?").run(id);
  }

  // Step 12: the head, the convergence hash and `updated_at` (the document's
  // own last change moves with its head, D6) — plus the conflicted flag when
  // the caller is the observe path. One statement, one transaction.
  const fileHash = sha256(content);
  if (opts.conflicted === undefined) {
    db.prepare("UPDATE docs SET head = ?, file_hash = ?, updated_at = ? WHERE doc_id = ?").run(head, fileHash, ts, docId);
  } else {
    db.prepare("UPDATE docs SET head = ?, file_hash = ?, updated_at = ?, conflicted = ? WHERE doc_id = ?").run(head, fileHash, ts, opts.conflicted ? 1 : 0, docId);
  }

  // Convergence check (step 13): file bytes vs the rows. Two independent
  // round-trips must both reproduce the source exactly:
  //   1. the freshly-parsed in-memory tree (validates the parser), and
  //   2. a reload from the rows just written (validates that the inline block
  //      bytes + trivia + frontmatter raw + separator tile the source — the
  //      fidelity a plain read or an `apply` write actually depends on; since
  //      17.0 nothing here reads a history table).
  const renderFn = adapter?.render ?? render;
  const converged =
    fileHash.equals(renderedHash) &&
    renderFn(tree) === content &&
    reconstructContent(db, docId) === content;

  return {
    docId,
    commitId: commitId,
    revId: head,
    blockCount: rows.length,
    converged,
  };
}

// Remove another document's `blocks` row for each id in `ids` (a cross-doc move
// or a resurrection re-homes the id into `docId`). A live foreign LEAF row still
// has an FTS entry (external-content index: delete with the original text); a
// tombstoned row or a container does not (spec/search §1.1) — ftsBeforeEvictRows
// decides leaf-ness over the table before any row goes and re-indexes a parent
// left childless. The source document, if it commits later in the same
// checkpoint, rewrites its rows wholesale and never lists a carried id as
// deleted, so nothing there depends on the evicted row. Returns each evicted
// row's `created_at`, which the carried-in row inherits (D6).
function evictForeignBlockRows(db: Database, docId: string, ids: string[]): Map<string, string> {
  const sel = db.prepare("SELECT rowid, block_id, doc_id, parent_block, text, deleted_at, created_at FROM blocks WHERE block_id = ? AND doc_id != ?");
  const del = db.prepare("DELETE FROM blocks WHERE block_id = ? AND doc_id != ?");
  const unpool = db.prepare("DELETE FROM resurrection_pool WHERE block_id = ?");
  const rows: (Parameters<typeof ftsBeforeEvictRows>[1][number] & { created_at: string })[] = [];
  for (const id of ids) {
    const row = sel.get(id, docId) as (typeof rows)[number] | undefined;
    if (row) rows.push(row);
  }
  ftsBeforeEvictRows(db, rows);
  const birth = new Map<string, string>();
  for (const r of rows) {
    birth.set(r.block_id, r.created_at);
    del.run(r.block_id, docId);
  }
  for (const id of ids) unpool.run(id);
  return birth;
}

// Zip assigned block ids onto the parsed RawBlocks for node projection. The
// parsed `rest` and `assigned` trees are the same blocks in the same order and
// nesting (assigned is a 1:1 id-carrying projection of rest), so we walk them in
// lockstep and stamp each RawBlock's blockId. Returns fresh RawBlocks (originals
// untouched — blockId is a projection-only field).
function zipAssignedIds(parsed: RawBlock[], assigned: TreeInputBlock[]): RawBlock[] {
  return parsed.map((b, i) => {
    const a = assigned[i];
    return {
      ...b,
      ...(a ? { blockId: a.blockId } : {}),
      children: a ? zipAssignedIds(b.children, a.children) : b.children,
    };
  });
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

function collectRaws(blocks: TreeInputBlock[]): Map<string, string> {
  const raws = new Map<string, string>();
  const walk = (list: TreeInputBlock[]): void => {
    for (const b of list) {
      raws.set(b.blockId, b.raw);
      if (b.children.length > 0) walk(b.children);
    }
  };
  walk(blocks);
  return raws;
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
