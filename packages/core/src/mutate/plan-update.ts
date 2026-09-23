import type { Store } from "../core/store/store.js";
import type { RawBlock } from "../core/parse/types.js";
import { sha256 } from "../core/hash.js";
import { parseTree } from "../core/parse/tree.js";
import { adapterForPath } from "../format/index.js";
import { findDocByRef } from "../core/read/reader.js";
import { reconcileDocument } from "../reconcile/reconcile.js";
import { flatten, type FlatSource } from "../reconcile/flatten.js";
import { DEFAULT_CONFIG, type ReconcileConfig } from "../reconcile/types.js";
import { loadOldMatchBlocks } from "../sync/reconciling-ingest.js";
import { loadMutDoc } from "./load.js";
import { renderDoc, MutationError } from "./tree.js";
import { apply, type ApplyResult, type Op } from "./apply.js";
import { lowerTopLevel, lowerReplace, type LowerResult } from "./lower.js";
import { summarizeOps, opsetKernelOps, type Opset, type PlanOp } from "./opset.js";

// Whole-document update planner (the note's plan_update): reconcile a proposed
// complete document representation against the current stable block tree and
// emit an executable, inspectable opset. Deterministic up to minted-id values
// for a given (repo state, content, matcher version). The planner is
// self-verifying: it simulates each candidate lowering (dry-run apply) and only
// marks the opset `converges` when replaying its ops reproduces the proposed
// bytes exactly — degrading identity (never content), which mirrors the
// architecture's "false continuity is worse than lost continuity" and "identity
// carries continuity, never truth".

export interface PlanUpdateOptions {
  config?: ReconcileConfig;
}

function toFlatSource(b: RawBlock): FlatSource {
  return { type: b.type, raw: b.raw, children: b.children.map(toFlatSource) };
}

function extractFrontmatter(blocks: RawBlock[]): { fmBlock: RawBlock | null; rest: RawBlock[] } {
  if (blocks.length > 0 && blocks[0]!.type === "frontmatter") return { fmBlock: blocks[0]!, rest: blocks.slice(1) };
  return { fmBlock: null, rest: blocks };
}

/**
 * Plan a whole-document update. `docRef` is a doc id or repo-relative path;
 * `content` is the proposed complete document. Throws doc_missing if the
 * document does not exist (a create is docsCreate's job). Never writes.
 */
export function planUpdate(store: Store, repoId: string, rootPath: string, docRef: string, content: string, opts: PlanUpdateOptions = {}): Opset {
  const config = opts.config ?? DEFAULT_CONFIG;
  const info = findDocByRef(store, repoId, docRef);
  if (!info) throw new MutationError("doc_missing", `doc ${docRef} not found`, { doc: docRef });
  const docId = info.docId;
  const path = info.path;

  const oldDoc = loadMutDoc(store.db, docId);
  if (!oldDoc) throw new MutationError("doc_missing", `doc ${docRef} not found`, { doc: docRef });

  // Base state the plan is pinned to. baseContentHash is the current rendered
  // bytes (== docs.file_hash at quiescence); a stale plan is rejected at apply.
  const currentContent = renderDoc(oldDoc);
  const baseContentHash = sha256(currentContent).toString("hex");

  // Parse the proposed content with the doc's format adapter.
  const adapter = adapterForPath(path);
  const tree = adapter ? adapter.parse(content) : parseTree(content);
  const { fmBlock, rest } = extractFrontmatter(tree.children);

  // Reconcile the proposed body against the current tree (no resurrection pool:
  // the op path mints new ids for new structure rather than reusing tombstones).
  const oldMatch = loadOldMatchBlocks(store.db, docId);
  const newMatch = flatten(rest.map(toFlatSource));
  const result = reconcileDocument(oldMatch, newMatch, { config });

  // Frontmatter is a document-level unit outside the six block ops. loadMutDoc
  // builds frontmatterRaw as `bytes + separator`; mirror that for the target.
  const targetFm = fmBlock ? fmBlock.raw + fmBlock.trivia : null;
  const fmChanged = targetFm !== oldDoc.frontmatterRaw;
  const setFrontmatter = fmChanged ? [{ doc: docId, raw: targetFm }] : undefined;

  const diagnostics: string[] = [];

  // Try lowerings in order of decreasing identity preservation; take the first
  // that reproduces the proposed content exactly.
  let chosen: LowerResult | null = null;
  let converges = false;
  const t2 = lowerTopLevel(oldDoc, rest, assignmentOf(result), dispositionsOf(result));
  const v2 = verify(store, repoId, rootPath, path, opsOf(t2), setFrontmatter, content, currentContent);
  if (v2.ok) {
    chosen = t2; converges = true;
  } else {
    diagnostics.push(`top-level lowering did not reproduce the proposed content byte-for-byte (${describeDivergence(v2, tree.children, content)}); falling back to full replace`);
    const t3 = lowerReplace(oldDoc, content);
    const v3 = verify(store, repoId, rootPath, path, opsOf(t3), setFrontmatter, content, currentContent);
    if (v3.ok) {
      chosen = t3; converges = true;
      diagnostics.push("full-replace plan converges (block identity not preserved)");
    } else {
      // Neither converged: return the identity-preserving plan but flag it. apply
      // refuses a non-convergent plan (loud failure), so no wrong bytes land.
      chosen = t2;
      diagnostics.push(`no lowering reproduced the proposed content exactly (full replace: ${describeDivergence(v3, tree.children, content)}); plan will not apply — inspect and re-plan`);
    }
  }

  const ops = chosen.ops;
  const summary = summarizeOps(ops, { preserved: chosen.preserved, ambiguous: chosen.ambiguous });

  return {
    version: 1,
    kind: "doc_update",
    target: { doc: docId, path },
    precondition: { doc: docId, path, baseRevision: info.currentRev, baseContentHash },
    matcherV: config.matcherV,
    ops,
    ...(fmChanged ? { frontmatter: { raw: targetFm } } : {}),
    summary,
    converges,
    diagnostics,
  };
}

function assignmentOf(r: { assignment: Map<string, string> }): Map<string, string> { return r.assignment; }
function dispositionsOf(r: { dispositions: { blockId: string; kind: string; confidence: number | null; reason: string | null; detail: Record<string, unknown> }[] }): { blockId: string; kind: string; confidence: number | null; reason: string | null; detail?: Record<string, unknown> }[] {
  return r.dispositions;
}
function opsOf(l: LowerResult): Op[] { return l.ops.map((p: PlanOp) => p.op); }

type Verified = { ok: true } | { ok: false; actual: string | null; error: string | null };

// Simulate a candidate op list and check the rendered result equals the exact
// proposed content. An invalid script throws in apply → treated as non-convergent.
function verify(store: Store, repoId: string, rootPath: string, path: string, ops: Op[], setFrontmatter: { doc: string; raw: string | null }[] | undefined, expected: string, currentContent: string): Verified {
  try {
    const res = apply(store, { repoId, rootPath, ops, origin: { actor: "plan:verify" }, dryRun: true, ...(setFrontmatter ? { setFrontmatter } : {}) });
    // A doc untouched by any op (e.g. an empty plan) is absent from diffs; its
    // effective result is the unchanged current content.
    const after = res.diffs?.[path]?.after ?? currentContent;
    return after === expected ? { ok: true } : { ok: false, actual: after, error: null };
  } catch (e) {
    return { ok: false, actual: null, error: e instanceof Error ? `${(e as MutationError).code ?? "error"}: ${e.message}` : String(e) };
  }
}

// Name the failure precisely: the first differing byte offset and the proposed
// top-level block (index + type) whose span covers it, so a caller learns WHICH
// construct failed to round-trip rather than just "no lowering converged".
function describeDivergence(v: Verified, proposed: RawBlock[], expected: string): string {
  if (v.ok) return "converged";
  if (v.actual === null) return `simulation threw ${v.error}`;
  const actual = v.actual;
  let off = 0;
  const n = Math.min(actual.length, expected.length);
  while (off < n && actual.charCodeAt(off) === expected.charCodeAt(off)) off++;
  const idx = proposed.findIndex((b) => off >= b.span.start && off < b.span.end + b.trivia.length);
  const where = idx >= 0 ? `proposed block #${idx} (${proposed[idx]!.type}, bytes ${proposed[idx]!.span.start}-${proposed[idx]!.span.end})` : off >= expected.length ? "past the end of the proposed content" : "leading trivia";
  const snippet = (s: string): string => JSON.stringify(s.slice(off, off + 24));
  return `first divergence at byte ${off} in ${where}: expected ${snippet(expected)}, rendered ${snippet(actual)}`;
}

// ---- applying an opset ------------------------------------------------------

export interface ApplyOpsetRequest {
  repoId: string;
  rootPath: string;
  opset: Opset;
  origin: { actor: string; reason?: string };
  dryRun?: boolean;
  omgbaseDir?: string;
}

/**
 * Apply an opset through the kernel write path. Validates the plan's
 * preconditions against current state first (a stale plan fails, carrying
 * current truth, rather than silently reinterpreting) and refuses a plan that
 * did not verify byte-convergent.
 */
export function applyOpset(store: Store, req: ApplyOpsetRequest): ApplyResult {
  const { opset } = req;
  if (!opset.converges) {
    const why = opset.diagnostics.length > 0 ? ` — ${opset.diagnostics[opset.diagnostics.length - 1]}` : "";
    throw new MutationError("plan_not_convergent", `opset does not reproduce the proposed content; re-plan${why}`, { diagnostics: opset.diagnostics });
  }
  // Precondition: the document must still be at the revision/content the plan
  // was computed against.
  const row = store.db.prepare("SELECT current_rev, lower(hex(file_hash)) fh FROM docs WHERE doc_id = ? AND deleted_commit IS NULL").get(opset.precondition.doc) as { current_rev: string | null; fh: string | null } | undefined;
  if (!row) throw new MutationError("doc_missing", `doc ${opset.precondition.doc} not found`, { doc: opset.precondition.doc });
  const stale = (opset.precondition.baseRevision !== null && row.current_rev !== opset.precondition.baseRevision) || (row.fh !== null && row.fh !== opset.precondition.baseContentHash);
  if (stale) {
    throw new MutationError("stale_plan", "document changed since the plan was computed; re-plan", {
      doc: opset.precondition.doc,
      expected_revision: opset.precondition.baseRevision,
      current: { revision: row.current_rev, content_hash: row.fh },
      retriable: true,
    });
  }

  return apply(store, {
    repoId: req.repoId,
    rootPath: req.rootPath,
    ops: opsetKernelOps(opset),
    origin: req.origin,
    ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
    ...(req.omgbaseDir !== undefined ? { omgbaseDir: req.omgbaseDir } : {}),
    ...(opset.frontmatter ? { setFrontmatter: [{ doc: opset.precondition.doc, raw: opset.frontmatter.raw }] } : {}),
  });
}

// ---- convenience: docs.update = plan + apply --------------------------------

export interface DocsUpdateContext {
  repoId: string;
  rootPath: string;
  omgbaseDir?: string;
  actor?: string;
}

export interface DocsUpdateResult {
  opset: Opset;
  /** null on dry_run (plan only) */
  result: ApplyResult | null;
}

/**
 * Whole-document update convenience: plan then apply. `dryRun` returns the
 * opset without executing (the note's docs.update(..., dry_run=true)).
 */
export function docsUpdate(store: Store, ctx: DocsUpdateContext, docRef: string, content: string, opts: { dryRun?: boolean; config?: ReconcileConfig; reason?: string } = {}): DocsUpdateResult {
  const opset = planUpdate(store, ctx.repoId, ctx.rootPath, docRef, content, opts.config ? { config: opts.config } : {});
  if (opts.dryRun) return { opset, result: null };
  const result = applyOpset(store, {
    repoId: ctx.repoId,
    rootPath: ctx.rootPath,
    opset,
    origin: { actor: ctx.actor ?? "agent:update", ...(opts.reason !== undefined ? { reason: opts.reason } : {}) },
    ...(ctx.omgbaseDir !== undefined ? { omgbaseDir: ctx.omgbaseDir } : {}),
  });
  return { opset, result };
}
