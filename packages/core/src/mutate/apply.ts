import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { isValidId } from "../core/ids.js";
import { findDocByRef } from "../core/read/reader.js";
import { loadMutDoc } from "./load.js";
import { renderDoc, markContainerDirty, MutationError, type MutDoc, type MutBlock } from "./tree.js";
import { opInsert, opUpdate, opMove, opRemove, opSplit, opMerge, healTopLevelSeams, checkParentChildrenHash, type To, type Expect } from "./ops.js";
import { withWriterLock } from "../sync/writer-lock.js";
import { resolveDocStore, type DocStore } from "./doc-store.js";
import { commitChangeset, readDocBase, type DocBase, type Effect } from "./commit.js";
import { isContainerBlock } from "../format/index.js";

// Changeset application (04 §2, §6). Ops apply in order across documents; later
// ops see earlier effects; minted ids are referenceable via "$n.ids[i]"
// placeholders. Atomic: all ops apply or none — validation throws before any
// file write, and the commit is one transaction with one `commits` row and a
// revision per touched document, the files materialized after it from the
// recorded intent (spec/mutate §4 step 5, 2.2; `commit.ts`).
// dry_run returns rendered diffs without committing. `planChangeset` is the
// op loop (shared by the dry run and by `docs_move`'s inbound retarget, which
// commits its effects under the move's own commit); `apply` plans, then commits.

export type Op =
  | { op: "insert"; doc?: string; to: To; markdown: string; expect?: Expect }
  | { op: "update"; block: string; markdown?: string; attrs?: Record<string, unknown>; expect?: Expect; trivia?: string; childIds?: Record<string, string> }
  | { op: "move"; blocks: string[]; to: To; doc?: string; expect?: Expect }
  | { op: "remove"; blocks: string[]; expect?: Record<string, Expect> }
  | { op: "split"; block: string; at: number[]; expect?: Expect }
  | { op: "merge"; blocks: string[]; separator?: string; expect?: Record<string, Expect> };

export interface ApplyRequest {
  repoId: string;
  /** Working-tree root for the default filesystem write target. Omit only when
   *  supplying an explicit `docStore` (e.g. a headless NullDocStore). */
  rootPath?: string;
  /** Write target (ADR-014 §5); defaults to a filesystem store at `rootPath`. */
  docStore?: DocStore;
  ops: Op[];
  origin: { actor: string; reason?: string };
  dryRun?: boolean;
  /**
   * Workspace .omgbase/ dir. When set, the file-write + commit phase runs under
   * the cross-process writer lock (11 §3.2). Omitted in single-process/in-memory
   * contexts (tests) where the in-process serialization of Store.write suffices.
   */
  omgbaseDir?: string;
  /**
   * Document-level frontmatter overrides (doc id → new frontmatter raw incl.
   * fences + trailing separator, or null to drop it). Frontmatter is a
   * document-level materialization unit (rendered before the block tree), not a
   * block the six ops address; the whole-document update planner sets it here
   * when the proposed content changes the frontmatter. The doc is force-loaded
   * so a frontmatter-only change still commits.
   */
  setFrontmatter?: { doc: string; raw: string | null }[];
  /**
   * Commit timestamp (RFC 3339 UTC, spec/store §2.4) stamped on every commit this
   * request records — the `api` commits and any `observed` commit a file-CAS
   * conflict ingests. Defaults to now; the spec/mutate fixture runner pins it so
   * the projected `commits.ts` / pool `expires_ts` compare across engines.
   */
  ts?: string;
}

export interface OpResult {
  ids: string[];
}

/** One touched document in an apply result (spec/mutate §4, 2.0): its row
 *  attributes `id`, `path` (the storage form here; the surface roots it) and
 *  `hash` — the hex sha256 of the rendered bytes, i.e. the hash the committed
 *  revision carries (a dry run reports the hash it would carry). The same
 *  three keys a `changes_since` revision carries. */
export interface ApplyRevision {
  id: string;
  path: string;
  hash: string;
}

export interface ApplyResult {
  results: OpResult[];
  revisions: ApplyRevision[];
  diffs?: Record<string, { before: string; after: string }>;
  committed: boolean;
}

// Resolve "$n.ids[i]" placeholders in a string against prior op results.
function resolvePlaceholder(value: string, results: OpResult[]): string {
  const m = /^\$(\d+)\.ids\[(\d+)\]$/.exec(value);
  if (!m) return value;
  const opIdx = Number(m[1]);
  const idIdx = Number(m[2]);
  const id = results[opIdx]?.ids[idIdx];
  if (!id) throw new MutationError("target_missing", `placeholder ${value} did not resolve`);
  return id;
}

// Resolve an insert op's `doc` field, which may be a minted doc id (d_...) or a
// document path — the same id-or-path symmetry the read/graph surfaces expose
// (shared via findDocByRef; see core/read/reader.ts). A valid d_ id passes
// through WITHOUT a store lookup so a doc minted by an earlier op in the SAME
// changeset (not yet committed) still resolves; ensureDoc validates existence.
// A path is resolved via the shared helper; an unresolvable path throws
// doc_missing naming it.
function resolveDocRef(store: Store, repoId: string, ref: string): string {
  if (isValidId(ref, "d")) return ref;
  const info = findDocByRef(store, repoId, ref);
  if (!info) throw new MutationError("doc_missing", `doc ${ref} not found`, { doc: ref });
  return info.docId;
}

// Which doc a given block id lives in (searches loaded docs; falls back to store).
function docIdForBlock(store: Store, repoId: string, blockId: string): string | null {
  const row = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL").get(blockId) as { doc_id: string } | undefined;
  return row?.doc_id ?? null;
}

/** A planned changeset: the op results, the per-document revisions and diffs
 *  the dry run returns, and the effects the commit runs (spec/mutate §4
 *  steps 1–4; `commit.ts` is step 5). Nothing has been written. */
export interface ChangesetPlan {
  results: OpResult[];
  revisions: ApplyRevision[];
  diffs: Record<string, { before: string; after: string }>;
  /** Per loaded document in load order: its `ingest_known`, then (in a
   *  workspace) its `record_stat`. */
  effects: Effect[];
  /** Per loaded document in load order: the row triple it was loaded against
   *  (spec/mutate §4 step 5, 2.2) — what the commit re-validates and what a
   *  frozen plan will carry. Each `ingest_known` effect carries its own as
   *  `base`. */
  preconditions: ({ id: string } & DocBase)[];
}

/** spec/mutate §4 steps 1–4: resolve, load, apply the ops in memory, render. */
export function planChangeset(store: Store, req: Omit<ApplyRequest, "dryRun" | "ts">): ChangesetPlan {
  const planner = new ChangesetPlanner(store, req.repoId, req.omgbaseDir);
  // Document-level frontmatter overrides, before the op loop (so a change with
  // no body ops still loads + commits the doc). Applied to the loaded MutDoc;
  // renderDoc emits frontmatterRaw verbatim and the commit re-ingest re-derives
  // properties/edges from the rendered bytes.
  for (const fm of req.setFrontmatter ?? []) planner.setFrontmatter(fm.doc, fm.raw);
  for (const op of req.ops) planner.push(op);
  return planner.finish();
}

/**
 * The op loop of spec/mutate §4 steps 1–4 as an incremental planner: `push`
 * applies one op to the in-memory trees (loading a document at first touch and
 * remembering its pre-mutation render, live ids and row triple), `finish`
 * renders every loaded document into the `ChangesetPlan`. `planChangeset` is
 * `push` over a whole op list; the effect planner (`plan.ts`, 2.3) pushes an
 * effect's lowered ops one effect at a time so it can read the ids each op
 * minted (`results`) before lowering the next effect, and it sets a document's
 * file head (`setHead`) for a frontmatter effect.
 */
export class ChangesetPlanner {
  /** Per op, in push order: the ids each op reported (`"$n.ids[i]"` placeholders resolve against these). */
  readonly results: OpResult[] = [];
  /** `$new.n` → the id minted for it at execute (spec/mutate §11.7, 3.0): a block of a document
   *  this request creates is named by its symbol in the plan's ops, and resolved here. Empty at
   *  plan time, when the symbols ARE the tree's ids. */
  private readonly aliases = new Map<string, string>();
  private readonly loaded = new Map<string, MutDoc>();
  private readonly before = new Map<string, string>();
  // Block ids present in each doc BEFORE any op — used to label intent
  // dispositions (edited vs inserted) on the known-id commit path.
  private readonly priorIds = new Map<string, Set<string>>();
  // The row triple `(path, current_rev, file_hash)` each document is loaded
  // against — the commit's precondition (spec/mutate §4 step 5, 2.2).
  private readonly bases = new Map<string, DocBase>();

  constructor(private readonly store: Store, private readonly repoId: string, private readonly omgbaseDir?: string) {}

  /** The loaded document (loading it at first touch); unknown or tombstoned → `doc_missing`. */
  ensureDoc(docId: string): MutDoc {
    let d = this.loaded.get(docId);
    if (!d) {
      const base = readDocBase(this.store.db, docId);
      const md = base ? loadMutDoc(this.store.db, docId) : null;
      if (!base || !md) throw new MutationError("doc_missing", `doc ${docId} not found`);
      d = md;
      this.loaded.set(docId, d);
      this.bases.set(docId, base);
      this.before.set(docId, renderDoc(d));
      const ids = this.store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL").all(docId) as { block_id: string }[];
      this.priorIds.set(docId, new Set(ids.map((r) => r.block_id)));
    }
    return d;
  }

  /**
   * spec/mutate §11.3 (3.0): register a document this request CREATES — parsed
   * from its composed bytes under the current minter — as a loaded document
   * with no row behind it: no triple (`baseOf` is undefined, it is absent from
   * `preconditions`), an empty `before` render, no prior ids (every block is
   * `inserted / api`). `symbol` is its document symbol (`$new.n`), the id every
   * later op addresses it by; its commit effect is an `ingest_known` with
   * `base: null`, guarded by `path_taken` instead of the triple.
   */
  adoptNew(symbol: string, doc: MutDoc): void {
    if (this.loaded.has(symbol)) throw new Error(`adoptNew: ${symbol} is already loaded`);
    this.loaded.set(symbol, doc);
    this.before.set(symbol, "");
    this.priorIds.set(symbol, new Set());
  }

  /** Name a minted id for a `$new.n` symbol the plan's ops use (execute's replay). */
  alias(symbol: string, id: string): void {
    this.aliases.set(symbol, id);
  }

  /** An op's string field: an alias (`$new.n` at execute), a kernel placeholder, or the id itself. */
  private resolveId(value: string): string {
    return this.aliases.get(value) ?? resolvePlaceholder(value, this.results);
  }

  private resolveTo(to: To): To {
    const parent = typeof to.parent === "string"
      ? this.resolveId(to.parent)
      : typeof to.parent === "object" && to.parent !== null && "heading" in to.parent
        ? { ...to.parent, heading: this.resolveId(to.parent.heading) }
        : to.parent;
    let at = to.at;
    if (typeof at === "object") {
      if ("before" in at) at = { before: this.resolveId(at.before) };
      else if ("after" in at) at = { after: this.resolveId(at.after) };
    }
    return { parent, at };
  }

  /** A per-block `expect` map re-keyed by the resolved ids (its keys may be placeholders or symbols). */
  private resolveExpectMap(expect: Record<string, Expect> | undefined): Record<string, Expect> | undefined {
    if (!expect) return undefined;
    const out: Record<string, Expect> = {};
    for (const [k, v] of Object.entries(expect)) out[this.resolveId(k)] = v;
    return out;
  }

  /** `insert.doc` / `move.doc`: a document this request created (its symbol) passes through; else `resolveDocRef`. */
  private resolveDocArg(ref: string): string {
    return this.loaded.has(ref) ? ref : resolveDocRef(this.store, this.repoId, ref);
  }

  /** Is the document loaded (touched by an earlier op or head change)? */
  isLoaded(docId: string): boolean {
    return this.loaded.has(docId);
  }

  /** The loaded document's row triple (after `ensureDoc`). */
  baseOf(docId: string): DocBase | undefined {
    return this.bases.get(docId);
  }

  /** Resolve a document reference (an id passes through, a path resolves; else `doc_missing`). */
  resolveDoc(ref: string): string {
    return resolveDocRef(this.store, this.repoId, ref);
  }

  /** Locate a block in the LOADED documents only (an id an earlier op minted included); never loads one. */
  locateLoaded(blockId: string): { docId: string; block: MutBlock; siblings: MutBlock[]; index: number } | null {
    for (const [docId, d] of this.loaded) {
      const f = locateMut(d, blockId);
      if (f) return { docId, ...f };
    }
    return null;
  }

  /** `ApplyRequest.setFrontmatter`'s semantics: replace the frontmatter bytes (incl. fences + separator), leaving the leading trivia. */
  setFrontmatter(docId: string, raw: string | null): void {
    this.ensureDoc(docId).frontmatterRaw = raw;
  }

  /** spec/mutate §11.3 (2.3): replace everything before the first block — the
   *  leading trivia AND the frontmatter — with `raw` (the file head). */
  setHead(docId: string, raw: string): void {
    const d = this.ensureDoc(docId);
    d.leadingTrivia = "";
    d.frontmatterRaw = raw;
  }

  /** Apply one op (spec/mutate §2); `op_index` is its position in `results`. */
  push(rawOp: Op): OpResult {
    const { store, repoId, loaded, results } = this;
    void results;
    const i = results.length;
    const ensureDoc = (docId: string): MutDoc => this.ensureDoc(docId);
    let result: OpResult;
    switch (rawOp.op) {
      case "insert": {
        const to = this.resolveTo(rawOp.to);
        const docId = rawOp.doc !== undefined
          ? this.resolveDocArg(rawOp.doc)
          : parentDoc(store, repoId, to, loaded);
        const d = ensureDoc(docId);
        result = opInsert(d, to, rawOp.markdown, rawOp.expect, i);
        break;
      }
      case "update": {
        const block = this.resolveId(rawOp.block);
        const docId = docIdForBlockLoaded(loaded, block) ?? docIdForBlock(store, repoId, block);
        if (!docId) throw new MutationError("block_missing", `block ${block} not found`, { op_index: i });
        result = opUpdate(ensureDoc(docId), block, i, rawOp.markdown, rawOp.attrs, rawOp.expect, rawOp.trivia, rawOp.childIds);
        break;
      }
      case "move": {
        const blocks = rawOp.blocks.map((b) => this.resolveId(b));
        const to = this.resolveTo(rawOp.to);
        const srcDocId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, repoId, blocks[0]!);
        if (!srcDocId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        // {doc:true} with a non-anchor `at` (start/end) means the top level of
        // `doc` when given (spec/mutate §2.3, 3.0: the destination document of a
        // cross-document move to a top-level start/end), else of the source
        // doc; an anchored `at` infers the destination doc from the anchor.
        const topLevel = typeof to.parent === "object" && "doc" in to.parent && typeof to.at === "string";
        const dstDocId = topLevel ? (rawOp.doc !== undefined ? this.resolveDocArg(rawOp.doc) : srcDocId) : parentDoc(store, repoId, to, loaded);
        if (dstDocId === srcDocId) {
          result = opMove(ensureDoc(srcDocId), blocks, to, i, rawOp.expect);
        } else {
          // Cross-document move (04 §1): extract from source, insert into target.
          result = crossDocMove(ensureDoc(srcDocId), ensureDoc(dstDocId), blocks, to, i, rawOp.expect);
        }
        break;
      }
      case "remove": {
        const blocks = rawOp.blocks.map((b) => this.resolveId(b));
        const docId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, repoId, blocks[0]!);
        if (!docId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        result = opRemove(ensureDoc(docId), blocks, i, this.resolveExpectMap(rawOp.expect));
        break;
      }
      case "split": {
        const block = this.resolveId(rawOp.block);
        const docId = docIdForBlockLoaded(loaded, block) ?? docIdForBlock(store, repoId, block);
        if (!docId) throw new MutationError("block_missing", `block ${block} not found`, { op_index: i });
        result = opSplit(ensureDoc(docId), block, rawOp.at, i, rawOp.expect);
        break;
      }
      case "merge": {
        const blocks = rawOp.blocks.map((b) => this.resolveId(b));
        const docId = docIdForBlockLoaded(loaded, blocks[0]!) ?? docIdForBlock(store, repoId, blocks[0]!);
        if (!docId) throw new MutationError("block_missing", `block ${blocks[0]} not found`, { op_index: i });
        result = opMerge(ensureDoc(docId), blocks, i, rawOp.separator, this.resolveExpectMap(rawOp.expect));
        break;
      }
    }
    results.push(result);
    return result;
  }

  /** Step 4: render every loaded document; the plan's effects, revisions, diffs and preconditions in load order. */
  finish(): ChangesetPlan {
    const revisions: ApplyRevision[] = [];
    const diffs: Record<string, { before: string; after: string }> = {};
    const effects: Effect[] = [];
    const preconditions: ChangesetPlan["preconditions"] = [];
    for (const [docId, d] of this.loaded) {
      const after = renderDoc(d);
      // An adopted document (`adoptNew`) has no triple: it is absent from the
      // preconditions and its ingest is guarded by `path_taken` (`base: null`).
      const base = this.bases.get(docId) ?? null;
      diffs[d.path] = { before: this.before.get(docId) ?? "", after };
      revisions.push({ id: docId, path: d.path, hash: sha256(after).toString("hex") });
      if (base) preconditions.push({ id: docId, ...base });
      effects.push({ kind: "ingest_known", docId, path: d.path, rendered: after, mutDoc: d, priorIds: this.priorIds.get(docId) ?? new Set(), base });
      // Keep the freshness cache warm so this engine write isn't re-hashed by a
      // later sweep (echo suppression already covers correctness; this avoids work).
      if (this.omgbaseDir) effects.push({ kind: "record_stat", path: d.path, bytes: after });
    }
    return { results: this.results, revisions, diffs, effects, preconditions };
  }
}

export function apply(store: Store, req: ApplyRequest): ApplyResult {
  const { results, revisions, diffs, effects } = planChangeset(store, req);

  if (req.dryRun) {
    return { results, revisions, diffs, committed: false };
  }

  // Commit (spec/mutate §4 step 5): one transaction validating every touched
  // document, one `api` commit and a revision per document plus the file
  // intent, then the rendered files materialized — under the cross-process
  // writer lock when a workspace dir is supplied (spec/sync §7); otherwise the
  // Store's in-process serialization suffices.
  const docStore = resolveDocStore(req);
  const ts = req.ts ?? new Date().toISOString();
  const head = { origin: "api" as const, actor: req.origin.actor, reason: req.origin.reason ?? null };
  const targets = { docStore, ...(req.omgbaseDir ? { omgbaseDir: req.omgbaseDir } : {}) };
  const commitPhase = (): void => {
    commitChangeset(store, req.repoId, head, effects, ts, targets);
  };

  if (req.omgbaseDir) withWriterLock(req.omgbaseDir, commitPhase);
  else commitPhase();

  return { results, revisions, committed: true };
}

function docIdForBlockLoaded(loaded: Map<string, MutDoc>, blockId: string): string | null {
  for (const [docId, d] of loaded) {
    if (findInDoc(d, blockId)) return docId;
  }
  return null;
}
function findInDoc(d: MutDoc, blockId: string): boolean {
  const walk = (list: { id: string; children: never[] }[]): boolean =>
    list.some((b) => b.id === blockId || walk(b.children));
  return walk(d.children as never);
}

// Determine the doc for a placement whose target is a block/heading/doc. When
// parent is {doc:true}, infer the doc from the anchor block in `at`.
function parentDoc(store: Store, repoId: string, to: To, loaded: Map<string, MutDoc>): string {
  if (typeof to.parent === "string") {
    return docIdForBlockLoaded(loaded, to.parent) ?? docIdForBlock(store, repoId, to.parent) ?? throwMissing(to.parent);
  }
  if (typeof to.parent === "object" && "heading" in to.parent) {
    return docIdForBlockLoaded(loaded, to.parent.heading) ?? docIdForBlock(store, repoId, to.parent.heading) ?? throwMissing(to.parent.heading);
  }
  // parent: {doc:true} — infer from the anchor block in `at`.
  if (typeof to.at === "object") {
    const anchor = "before" in to.at ? to.at.before : to.at.after;
    return docIdForBlockLoaded(loaded, anchor) ?? docIdForBlock(store, repoId, anchor) ?? throwMissing(anchor);
  }
  throw new MutationError("target_missing", "insert at top-level start/end requires an explicit doc");
}
function throwMissing(id: string): never {
  throw new MutationError("parent_missing", `parent ${id} not found`);
}

// Cross-document move: extract the contiguous run from src, insert into dst.
function crossDocMove(src: MutDoc, dst: MutDoc, blockIds: string[], to: To, opIndex: number, expect?: Expect): OpResult {
  // Extract from src (must be a contiguous top-level or same-parent run).
  const moving: MutBlock[] = [];
  for (const id of blockIds) {
    const found = locateMut(src, id);
    if (!found) throw new MutationError("block_missing", `block ${id} not found in source doc`, { op_index: opIndex });
    moving.push(found.block);
  }
  // §1.1 container rule + §1.2 destination CAS (in `dst`), resolved once before
  // either tree moves so a leaf destination errors with both trees untouched.
  const pre = resolveDstTarget(dst, to, opIndex);
  if (expect?.parent_children_hash !== undefined) checkParentChildrenHash(pre.siblings, expect, opIndex);
  // remove from their source lists (marking each emptied owner dirty)
  for (const id of blockIds) {
    const f = locateMut(src, id);
    if (f) {
      f.siblings.splice(f.index, 1);
      markContainerDirty(src, f.siblings);
    }
  }
  // Insert into dst at the resolved target; the destination owner re-renders.
  const target = resolveDstTarget(dst, to, opIndex);
  target.siblings.splice(target.index, 0, ...moving);
  markContainerDirty(dst, target.siblings);
  // Heal both documents' top-level seams (spec/mutate §2.3): a block that was
  // last in its source carries a lone "\n" that would soft-join it to its new
  // neighbour, and the source's new last block may now be followed by nothing.
  healTopLevelSeams(src.children, src.format);
  healTopLevelSeams(dst.children, dst.format);
  return { ids: blockIds };
}

function locateMut(doc: MutDoc, blockId: string): { block: MutBlock; siblings: MutBlock[]; index: number } | null {
  const search = (list: MutBlock[]): { block: MutBlock; siblings: MutBlock[]; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.id === blockId) return { block: list[i]!, siblings: list, index: i };
      const f = search(list[i]!.children);
      if (f) return f;
    }
    return null;
  };
  return search(doc.children);
}

function resolveDstTarget(dst: MutDoc, to: To, opIndex = 0): { siblings: MutBlock[]; index: number } {
  if (typeof to.parent === "object" && "doc" in to.parent) {
    return { siblings: dst.children, index: resolveAt(dst.children, to.at) };
  }
  if (typeof to.parent === "string") {
    const f = locateMut(dst, to.parent);
    if (!f) throw new MutationError("parent_missing", `parent ${to.parent} not found in dest`);
    // spec/mutate §1.1 (1.2): a leaf destination would be re-rendered from its
    // children and lose its own text — the same rule as the in-document ops.
    if (!isContainerBlock(dst.format, f.block)) {
      throw new MutationError(
        "type_mismatch",
        `${to.parent} is a ${f.block.type}, not a container; place relative to it with at.before/at.after or append to its section`,
        { op_index: opIndex, block: to.parent, type: f.block.type },
      );
    }
    return { siblings: f.block.children, index: resolveAt(f.block.children, to.at) };
  }
  // heading/section: insert into top-level list at the anchor.
  return { siblings: dst.children, index: resolveAt(dst.children, to.at) };
}

function resolveAt(siblings: MutBlock[], at: To["at"]): number {
  if (at === "start") return 0;
  if (at === "end") return siblings.length;
  if ("before" in at) { const i = siblings.findIndex((b) => b.id === at.before); if (i < 0) throw new MutationError("target_missing", `anchor ${at.before} not found`); return i; }
  const i = siblings.findIndex((b) => b.id === at.after);
  if (i < 0) throw new MutationError("target_missing", `anchor ${at.after} not found`);
  return i + 1;
}
