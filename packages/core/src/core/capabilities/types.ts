import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import type { IdPrefix } from "../ids.js";
import type { DispositionRow } from "../ingest.js";
import type { TreeInputBlock } from "../store/writers.js";
import type { EdgeTransitions } from "../store/edges.js";
import type { DocsReadAtResult } from "../read/document.js";
import type { DiffEntry, DocDiffUnified, DocHistoryResult, NodeChange } from "../../graph/history.js";
import type { EvaluateOptions, RetentionPlan, RetentionPolicy } from "../store/retention.js";
import type { ArchiveListing, AttachResult, ExportOptions, ExportResult } from "../store/archive.js";
import type { BlockContextInput, BlockContextResolver } from "../../semantic/tasks.js";
import type { EmbeddingWorker } from "../../semantic/embeddings.js";
import type { DocVectorHit, VectorHit } from "../../semantic/vector.js";
import type { DrainResult, SemanticIndexIdentity } from "../../semantic/indexer.js";

// The capability seams of the modular-core program, Phase 1
// (docs/modular-core/README.md §5 "Dependency-direction check", §6 "Phase 2
// opener"). Three interfaces wrap what the engine does with HISTORY (the
// recorder), with VECTORS (the semantic provider) and with IDENTITY CLAIMS
// (the mint oracle), each with ONE default implementation that is exactly
// today's code moved behind it (`history.ts`, `semantic.ts`, `claims.ts` in
// this directory). The core calls the interface — `capabilitiesOf(db)` in
// `registry.ts` — never the concrete module; the composition layer (`Store`
// through `Workspace`, `mcp/server.ts`, `index.ts`, the CLI) names the
// implementations. Phase 1 changes no behaviour, no schema and no fixture:
// every method here is a pass-through, and the dependency-direction check
// (`dependency-direction.test.ts`, the eslint rule in `eslint.config.js`) is
// what the phase delivers.
//
// This directory is the one place under `core/` allowed to import the
// concrete history/semantic modules (`graph/history.ts`, `core/store/
// {archive,retention,delta}.ts`, `semantic/**` — Phase 2 moved the semantic
// bundle out of `search/`, which keeps the lexical FTS parts).

/**
 * What the recorder receives for one accepted transition of a document
 * (spec/store §5.4 step 15, 17.0): the head token the CORE minted (D1), the
 * id-assigned body tree (the structural identities), the frontmatter raw, the
 * accepted content's hash, the path the revision carries and the commit it
 * hangs off. The before-head (the previous captured revision: its seq, tree
 * and frontmatter as the delta base, the checkpoint rule) is the recorder's
 * OWN state; the core numbers and hashes the head without reading it (M1).
 */
export interface RevisionTransition {
  docId: string;
  /** The head token the core minted for this transition (spec/store §5.4 step 6, 17.0 D1): the recorder's `revisions.rev_id`. */
  head: string;
  /** The path as of this revision — immutable (17.0 D11: a `docs_move` is a new transition at the new path, with the unchanged tree). */
  path: string;
  /** The `commits` row the revision hangs off (`newCommit`). */
  commitId: string;
  /** The id-assigned body blocks (frontmatter stripped), as the ingest flattens them into `blocks`. */
  blocks: TreeInputBlock[];
  /** The frontmatter block's raw (fences included), or null when the document has none. */
  frontmatterRaw: string | null;
  /** sha256 of the accepted content — `revisions.rendered_hash`, and `docs.file_hash` (I1). */
  renderedHash: Buffer;
}

/** A captured transition's row: the head token it was captured under (= `RevisionTransition.head`) and the recorder's per-document seq. */
export interface CapturedRevision {
  revId: string;
  seq: number;
}

/**
 * A `revisions` row as the query binding reads it (spec/surface §1.1/§1.2 —
 * `oqx-js/context.ts`): the `revisions` × `commits` columns the `revisions`
 * root and the `_revisions` relation expose, `is_current` (= the revision is
 * its document's `head`) and `archived` as SQLite booleans (0/1).
 */
export interface RevisionQueryRow {
  rev_id: string;
  doc_id: string;
  seq: number;
  rendered_hash: Buffer;
  path: string;
  commit_id: string;
  ts: string;
  origin: string;
  actor: string | null;
  reason: string | null;
  is_current: number;
  archived: number;
}

/**
 * The commit the core hands the recorder (spec/store §5.4 step 15, 17.0 —
 * the feed row's twin): the `c` id the core minted and wrote on `feed`, the
 * repository's epoch and the feed's `seq`, the row's provenance, the batch
 * (D4) and the ADR-003 intent record (`ops`, M5 — the recorder's column, never
 * the feed's).
 */
export interface CommitRecord {
  commitId: string;
  repoId: string;
  epoch: string;
  seq: number;
  ts: string;
  origin: "api" | "observed" | "import" | "projection";
  actor: string | null;
  reason: string | null;
  batchId: string;
  ops: string | null;
}

/**
 * The history recorder (plan §3 "capture"): the write half every write entry
 * point calls per committed transition and the read half the surface exposes
 * (`docs_read { at }`, `docs_diff*`, `docs_history`, `blocks_history`,
 * `changes_since`), plus the retention/archive and GC-mark entry points. One
 * instance per store, bound to its connection — the capture methods run
 * inside the caller's transaction on that connection.
 */
/** `HistoryRecorder.purge`'s outcome (spec/store §7.6): the rows removed per table, the recorder's holds released (claims left with no holder deleted), whether the bundle's tables were dropped. */
export interface HistoryPurgeOutcome {
  purged: Record<"commits" | "revisions" | "blobs" | "tree_nodes" | "dispositions" | "block_changes" | "edge_transitions" | "archives", number>;
  claims_released: number;
  tables_dropped: boolean;
}

/**
 * The READ half of history (modular-core Phase 6a; spec/surface §3): what the
 * surface's history tools, the `revisions` query root and `doctor` ask of
 * whatever holds a repository's history. The native recorder implements it
 * over its own tables (`HistoryRecorder extends HistoryReader`); an
 * alternative provider — the git history provider of `@omgbase/git-adapter`,
 * spec/store §5.12 — implements it over its own storage and attaches NO
 * recorder (a `provider: git` repository is captured asynchronously by a
 * checkpoint worker, never inside the commit transaction). The core reaches a
 * repository's reader through `historyReaderFor(db, repoId)`
 * (`core/store/manifest.ts`), which picks by the manifest row's `config.provider`.
 */
export interface HistoryReader {
  /** `docs_read { at }` / `docs_read_at`: spec/store §6.2 reconstruct at a revision (segment-aware); null when the token names no retained version of the document. */
  readAtRevision(docId: string, revId: string): DocsReadAtResult | null;
  /** `blocks_history`: a block's biography from `block_changes` × `commits` × `dispositions`. A provider without block lineage throws `capability_unavailable { history, unsupported }`. */
  blocksHistory(blockId: string, opts?: { limit?: number }): NodeChange[];
  /** `docs_diff`: block-grain diff between two revisions (`unsupported` on a provider without block identities). */
  diffBlocks(docId: string, fromRev: string, toRev: string): DiffEntry[];
  /** `docs_diff_unified`'s text: the unified diff of two revisions' reconstructed bytes. */
  diffUnified(docId: string, fromRev: string, toRev: string): string;
  /** `docs_diff_unified` over a resolved document (defaults: previous → current). */
  docDiffUnified(docId: string, opts?: { fromRev?: string; toRev?: string; label?: string }): DocDiffUnified;
  /** `docs_history`: the versions per document — the current head always listed with `retained` (resolution 11, Phase 4b), the repository's coverage on the result. */
  docsHistory(repoId: string, opts?: { pathGlob?: string; doc?: string; includeDeleted?: boolean; limit?: number }): DocHistoryResult;
  /** The disposition counts of a captured commit for a `changes_since` digest's summary — `null` when this history holds none for it. */
  dispositionCounts(commitId: string): { kind: string; n: number }[] | null;
  /** The `revisions` query root (spec/surface §1.1, 4.7): every retained version of the repository's documents as the binding's rows, by (`path`, `rev_id`). */
  revisionRows(repoId: string): RevisionQueryRow[];
  /** The `_revisions` relation of a document (spec/surface §1.2): its retained versions by `seq`. */
  docRevisionRows(docId: string): RevisionQueryRow[];
  /** Does this history hold a version under this token? (`docs_read { at }` tells a retained version from an unknown token by this.) */
  hasRevision(revId: string): boolean;
  /** `doctor`'s "capture complete" (spec/cli §6): the live documents whose head was minted at or after `since` and has no retained version. */
  uncapturedHeads(repoId: string, since: string): number;
}

export interface HistoryRecorder extends HistoryReader {
  // ---- capture: the write half (spec/store §5.4 step 15; §5.6) ----

  /** Step 15 (17.0, 3d): the `commits` row of a feed row the core appended — the same `commit_id`, `epoch` and `seq` (`core/store/feed.ts` `appendFeedRow`); sets the recorder's hold on the commit's claim. */
  recordCommit(commit: CommitRecord): void;
  /** Step 15 (17.0): the Merkle tree (full or delta over the recorder's OWN previous captured revision), the frontmatter blob, the `revisions` row under the core's head token — one accepted transition, content, structure or path (D11: a `docs_move` hands the unchanged tree at the new path). */
  captureRevision(transition: RevisionTransition): CapturedRevision;
  /** Step 15: the reconciliation evidence — every non-`same` verdict into `dispositions` and `block_changes` (inventory-ts §2.1 row 467–488). */
  recordDispositions(commitId: string, dispositions: readonly DispositionRow[]): void;
  /** Step 15 (17.0, 3e — M6; spec/graph §3.3): the transition's edge list — one `edge_transitions` row per opened edge (`from_commit` = this commit, `to_commit` NULL), `to_commit` = this commit on every closed one; sets the recorder's hold on the opened ids. */
  recordEdgeTransitions(commitId: string, transitions: EdgeTransitions): void;
  /** The core rewrote these open edges' destination in place (spec/graph §3.5 adoption, a move's re-phantoming): the open transition rows follow, so the interval record reads as 16.x's `edges` did. */
  retargetEdges(edgeIds: readonly string[], dstNode: string): void;

  // (No current-state read goes THROUGH history any more: M1 retired
  // `currentFrontmatterRaw`/`movePath` in 3a; M4 retired `renderedHash`/
  // `priorRenderedHash` in 3c — the pending row carries `prior_hash` and the
  // materializer renders from the current rows.)

  // ---- the surface's reads: `HistoryReader` (spec/surface §3) ----

  /** A captured revision's frontmatter raw, resolved through the recorder's own delta chain (spec/store §6.2 "Resolving"); null when it has none or the row is unknown. Migration 17's backfill reads it once per live head (§3.4 step 17). The recorder's alone: a provider has no delta chain. */
  frontmatterAtRevision(revId: string): string | null;

  // ---- the capture lifecycle (spec/store §5.9, Phase 4a) ----

  /**
   * `history enable`'s baseline (phase-1-contracts §1.14): under `commit` — a
   * feed row the core already appended (`origin = 'import'`, `reason =
   * 'history enabled'`) — the `commits` row, a checkpoint `revisions` row for
   * every live document whose head has none (`rev_id = docs.head`, the current
   * tree and frontmatter, `seq = 1 + its greatest captured seq`), the
   * recorder's hold on every live doc, head and block id, and the edge
   * interval record reconciled with the open edges (a dangling open transition
   * closed at this commit, an edge without one opened at it). Returns the
   * revisions written.
   */
  baseline(commit: CommitRecord): { revisions: number };

  /**
   * `history purge`'s recorder half (spec/store §7.6, Phase 4b): the
   * repository's history rows — every commit, or those with `ts < before` —
   * removed except — while `protectHeads` (the core's word that capture is on
   * for the repository) — a live head's revision and its commit, the retained
   * revisions whose base went re-checkpointed first, the interval record
   * trimmed to the cut, the segments nothing names detached, the unreachable
   * bodies swept; then the recorder's hold released on every claim no history
   * row names (a claim with no holder deleted); then, when `dropIfEmpty` (the
   * core's word that no repository is enabled) and every history table is
   * empty, the bundle's tables dropped. Runs in the caller's transaction; the
   * manifest is the core's.
   */
  purge(repoId: string, before: string | null, opts: { dropIfEmpty: boolean; protectHeads: boolean }): HistoryPurgeOutcome;

  // ---- maintenance: the GC mark, retention, archives (spec/store §7) ----

  /** The mark: every tree node and blob a live revision reaches (M7 roots the core's half on current state in Phase 3). */
  markReachable(): { trees: Set<string>; blobs: Set<string> };
  /** `omg gc`'s recorder half (spec/store §7): the sweep of unreachable bodies and of a 14.1 store's `same` rows; `dry` counts and deletes nothing. Runs in the caller's transaction. */
  collect(dry: boolean): { blobsSwept: number; treeNodesSwept: number; sameDispositionsSwept: number };
  /** `rebuild-index`'s recorder half (spec/store §7): `block_changes` re-derived from `dispositions`. Runs in the caller's transaction. */
  rebuildProjections(): void;
  /** The `same` rows a 14.1 store persisted (the size report's `same_dispositions`). */
  sameDispositionCount(): number;
  /** The repo's effective retention policy (`history.retention` settings). */
  retentionPolicy(repoId: string, override?: unknown): RetentionPolicy;
  /** The retention plan: what the squash would archive (spec/store §7.1). */
  evaluateRetention(repoId: string, opts?: EvaluateOptions): RetentionPlan;
  /** `omg history export`: write a segment and squash. */
  exportHistory(repoId: string, opts: ExportOptions): ExportResult;
  /** `omg history attach`. */
  attachArchive(repoId: string, target: string): AttachResult;
  /** `omg history detach`. */
  detachArchive(repoId: string, ref: string): string | null;
  /** `omg history list`. */
  listArchives(repoId: string, opts?: { dest?: string }): ArchiveListing[];
  /** The size report's archived line: revisions archived, segments, bytes. */
  archivedSummary(): { revisions: number; segments: number; bytes: number };
}

/** A resolved query embedding for a `semantic("phrase")` call: the query vector as a bound BLOB plus the model whose stored vectors it is compared to. */
export interface SemanticVec { vec: Buffer; model: string }

/** The block row attributes a `semantic()` score is a function of (spec/search §2.2, §3): its document, path, ordinal and type give the context, `raw_hash` the content key. */
export interface SemanticBlockRow { doc_id: string; path: string; ordinal: number; type: string; raw_hash: Buffer }

/**
 * The per-query scorer `semantic("phrase")` binds to (`oqx-js/context.ts`):
 * one instance per query, holding the context resolver (one scan of titles and
 * sections) across the rows it scores. A row with no vector under the query's
 * model — stale context, never embedded, below the floor — scores `null`
 * (absent), never 0.
 */
export interface SemanticScorer {
  block(row: SemanticBlockRow, query: SemanticVec): number | null;
  doc(docId: string, query: SemanticVec): number | null;
}

export interface SemanticDrainOptions {
  batchSize?: number;
  onProgress?: (p: { phase: "blocks" | "docs"; embedded: number; total: number }) => void;
  /** Force the full rescan with the prune (`omg embed drain --prune`), whatever the watermark says. */
  rescan?: boolean;
}

/**
 * How current the index is (spec/search §2.6 as restated by Phase 2): the feed
 * sequence the indexer has processed against the repository's head, and the
 * identity (model, dims, chunking version) the vectors were produced under.
 * `fresh` is `processed_seq >= head` under a matching identity; null when no
 * watermark or no feed exists.
 */
export interface SemanticFreshness {
  processed_seq: number | null;
  head: number | null;
  identity: SemanticIndexIdentity | null;
  fresh: boolean | null;
}

/**
 * The semantic provider (README §6 "Phase 2 opener"; Phase 2 moves EVERYTHING
 * that touches a vector behind it): the vector cache's reads (`blockVector`,
 * `docVector`), the per-query scorer, the `provider_unavailable` gate
 * (`available`), the drain — bootstrap / catch-up / rescan over the feed
 * watermark — and its halves, the brute-force searches, the size advice. The
 * one cross-dependency — the doc-embedding task's read of the current head —
 * stays inside the implementation (`semantic/tasks.ts`). One instance per
 * store; constructing it is what registers the `cosine` SQL function.
 */
export interface SemanticProvider {
  /** The per-query/per-drain context resolver (spec/search §2.2): one scan of titles and sections, then a chain walk per block. */
  blockContexts(scope: { repoId: string } | { docId: string }): BlockContextResolver;
  /** A block's vector: the `embeddings` row keyed by its CURRENT `(content_hash = raw_hash, ctx_hash, model)`, or null when stale/missing. */
  blockVector(rawHash: Buffer, ctx: string, model: string): Buffer | null;
  /** A document's vector: the `doc_embeddings` row for `(doc_id, model)`, or null. */
  docVector(docId: string, model: string): Buffer | null;
  /** The scorer one query binds `semantic("…")` to (spec/surface §1.3): cosine of the row's current vector against the query's. */
  scorer(repoId: string): SemanticScorer;
  /** The gate (spec/surface §4, 3.0): has anything in the repository been embedded under `model`? */
  available(repoId: string, model: string): boolean;
  /** The drain (spec/search §2.6; Phase 2): bootstrap from a consistent snapshot when there is no watermark, catch up from it, rescan + prune on an expired cursor or an identity change; writes the watermark last. */
  drain(worker: EmbeddingWorker, repoId: string, opts?: SemanticDrainOptions): Promise<DrainResult>;
  /** The drain's block half alone (the fixture runner's `drain` step, spec/search §7): every stale embeddable block of the repo through the worker. */
  embed(worker: EmbeddingWorker, repoId: string, opts?: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void }): Promise<{ embedded: number; cached: number }>;
  /** The drain's document half alone. */
  embedDocs(worker: EmbeddingWorker, repoId: string, opts?: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void }): Promise<{ embedded: number; cached: number; pooled: number }>;
  /** Delete every cached vector another model produced. */
  pruneForeign(worker: EmbeddingWorker): { blocks: number; docs: number };
  /** The watermark against the feed head: how far behind the index is (`version`/`omg embed status`). */
  freshness(repoId: string, identity?: SemanticIndexIdentity): SemanticFreshness;
  /** The embedding queue depth without a provider process (spec/search §2.3; `omg status`'s `embedQueue`). */
  staleCount(repoId: string, model?: string): number;
  /** Brute-force cosine over the live embeddable blocks' vectors (spec/search §3). */
  vectorSearch(repoId: string, model: string, queryVec: Float32Array, opts?: { limit?: number }): VectorHit[];
  /** Brute-force cosine over the document vectors. */
  docVectorSearch(repoId: string, model: string, queryVec: Float32Array, opts?: { limit?: number }): DocVectorHit[];
  /** The size report's vector advice (spec/store §7.5 — one `search` category, two owners): the lines about `embeddings`/`doc_embeddings`, given their bytes and the database's. */
  sizeAdvice(vectorBytes: number, totalBytes: number): string[];
}

/**
 * Identity claims (spec/store §2.1, 17.0 — M3/D5): the `id_claims` table the
 * core writes at every row-carrying mint and the oracle `mintId` asks before
 * issuing an id. `holders` is a bitmask — bit 0 the core, bit 1 the recorder
 * (`IdClaims`, `core/capabilities/claims.ts`). The core's writers call `claim`
 * in the transaction that writes the row; the recorder calls `hold` when its
 * capture first names an id; `gc` calls `prune` (spec/store §7.3).
 */
export interface IdentityClaims {
  /** Record that the core issued `id` under `prefix` for `repoId` (null = workspace-scoped) at `mintedAt` — idempotent. */
  claim(prefix: IdPrefix, id: string, repoId: string | null, mintedAt: string): void;
  /** Set the recorder's hold (bit 1) on every id named; an id with no claim row is left alone. */
  hold(ids: Iterable<string>): void;
  /** Is `id` in use under `prefix` — spec/store §2.1 "Uniqueness at mint": one probe on `id_claims` for a core-minted prefix, the table probe for `c`/`s`/`cp`. */
  isClaimed(prefix: IdPrefix, id: string): boolean;
  /** The claims prune (spec/store §7.3) at the clock `now`; returns the holds released. */
  prune(now: string): number;
  /** `count(*)` of `id_claims` (the size report's `id_claims` line). */
  count(): number;
}

/**
 * The configuration an alternative history provider's manifest row carries
 * (spec/store §3.1 `capabilities.config`, §5.12 — Phase 6a). The git provider's:
 * `{ provider: "git", git_dir, branch, cadence, ids_ref, remote }` — `git_dir`
 * relative to the workspace root, `cadence` `"every"` (one git commit per feed
 * row) or `{ debounce_ms }` (the rows pending when the worker runs fold into one
 * commit), `ids_ref` the RESERVED per-document id-map ref (nothing is written to
 * it in 6a), `remote` null in 6a (6b wires it). A native row's config is `{}`:
 * `provider` absent reads `"native"`.
 */
export interface HistoryProviderConfig {
  provider: string;
  [key: string]: unknown;
}

/** `history checkpoint`'s receipt (spec/store §5.12, spec/cli §6): the git commits written, the feed span they cover, the branch tip, whether the run was a rescan. */
export interface HistoryCheckpointResult {
  committed: number;
  from_seq: number;
  to_seq: number;
  tip: string | null;
  rescanned: boolean;
}

/** Can the provider run on this host? (`git` on PATH for the git provider.) */
export type HistoryProviderAvailability = { ok: true; detail: string } | { ok: false; reason: string };

/**
 * An alternative history provider (modular-core Phase 6a — "one alternative
 * strategy through the documented contract"): what the composition layer
 * attaches for a history that is NOT the recorder's tables. The core knows it
 * by name — the manifest row's `config.provider` — and reaches it through
 * `Capabilities.providers`; it imports nothing of the implementation
 * (`@omgbase/git-adapter`). A `provider: <name>` repository has no recorder
 * (`captureFor` is null — its commits write the feed alone) and reads through
 * `reader(repoId, config)`; capture is the provider's own asynchronous worker
 * (`checkpoint`), run by `omg history checkpoint` and by the freshness sweep.
 */
export interface HistoryProvider {
  /** The provider's name — the manifest row's `config.provider`. */
  readonly name: string;
  /** Is the provider usable here? Not ok → `capability_unavailable { history, unavailable }` on every read, the `history_provider_unavailable` alert; WRITES CONTINUE (the worker simply cannot run). */
  available(): HistoryProviderAvailability;
  /** The read half for a repository whose manifest names this provider, over the row's `config`. */
  reader(repoId: string, config: HistoryProviderConfig): HistoryReader;
  /**
   * `history enable --provider <name>` (spec/store §5.12): initialise the
   * provider's storage and write its BASELINE — the full current tree under the
   * baseline feed row the core appended (`commit`) — returning the `config` the
   * manifest row stores and the baseline's receipt. Runs inside the core's
   * enable transaction (the manifest row is written after it returns).
   */
  enable(repoId: string, commit: CommitRecord, opts: Record<string, unknown>): { config: HistoryProviderConfig; baseline: { revisions: number; tip: string | null } };
  /** `history purge` on a repository of this provider: delete its storage and its cursor (spec/store §7.6, §5.12). */
  purge(repoId: string, config: HistoryProviderConfig): { removed: boolean; path: string };
  /** The checkpoint worker, once: read the feed from the cursor and write the provider's commits (spec/store §5.12). */
  checkpoint(repoId: string, config: HistoryProviderConfig, opts?: { now?: string }): HistoryCheckpointResult;
  /** Release process resources (the store is closing). */
  close?(): void;
}

/**
 * The capabilities a store runs with — the MODULES the composition carries.
 * `history`/`semantic` are `null` when the module is absent (D3's
 * `unavailable`). Since Phase 4a the recorder's presence says nothing about
 * CAPTURE: whether a commit on a repository is captured is the repository's
 * manifest row (`core/store/manifest.ts` `captureFor` — the recorder iff the
 * module is here AND the row is `enabled` AND the row's provider is native), and a
 * repository whose row is `enabled` with `writer_requires` refuses a writer
 * whose composition lacks the module its provider needs (`requireWriter`).
 * `providers` (Phase 6a) are the alternative history providers the composition
 * layer attached, by name — `{}` when none.
 */
export interface Capabilities {
  history: HistoryRecorder | null;
  semantic: SemanticProvider | null;
  claims: IdentityClaims;
  providers: Record<string, HistoryProvider>;
}

/** How the composition layer names the implementations: a factory the `Store` calls on itself once its connection is open. */
export type CapabilitiesFactory = (store: Store) => Capabilities;

export type { BlockContextInput, BlockContextResolver, Database, DrainResult, SemanticIndexIdentity };
