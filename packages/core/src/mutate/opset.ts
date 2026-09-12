import type { Op } from "./apply.js";

// Update opset (whole-document reconciliation plan). A planner reconciles a
// proposed complete document representation against the current stable block
// tree and emits an *opset*: an explicit, serializable, inspectable plan whose
// mutations are the existing six kernel ops, annotated with the identity
// consequence of each (disposition, confidence, reason) as planning metadata —
// the kernel op semantics are unchanged. The opset carries preconditions tying
// it to the state it was planned against; applying a stale plan fails rather
// than silently reinterpreting it. `apply(opset)` replays the ops through the
// single kernel write path.

export type OpsetKind = "doc_update";

/**
 * The identity consequence of one planned op, in the reconciler's vocabulary
 * (03 §4). Kept as a string so mutate/ carries no runtime dependency on
 * reconcile/; the values mirror reconcile/types.ts DispositionKind plus the
 * synthetic `retiled` for a trailing-trivia-only fixup the planner emits to
 * reproduce the proposed bytes exactly.
 */
export type PlanDisposition =
  | "same" | "edited" | "moved" | "edited_moved" | "inserted" | "deleted"
  | "split_from" | "merged_into" | "copied_from" | "resurrected" | "bulk_rewrite"
  | "retiled";

/** State the opset was planned against; applying against different state fails. */
export interface OpsetPrecondition {
  /** doc id the plan targets */
  doc: string;
  path: string;
  /** the document's current revision id at plan time (null for a doc with no committed revision yet) */
  baseRevision: string | null;
  /** sha256 hex of the document's current rendered bytes (docs.file_hash) at plan time */
  baseContentHash: string;
}

/** One kernel op plus the identity consequence the planner attributes to it. */
export interface PlanOp {
  /** the executable kernel op (unchanged semantics) */
  op: Op;
  /** identity disposition this op realizes (planning metadata) */
  disposition: PlanDisposition;
  /**
   * subject block ids for human/agent inspection: the carried id(s) an
   * update/move/remove acts on, the survivor for merge, the origin for split.
   * Empty for an insert of genuinely new structure (its id is minted at apply).
   */
  blocks: string[];
  confidence: number | null;
  reason: string | null;
  detail?: Record<string, unknown>;
}

/** Identity accounting over the reconciliation (for dry-run summaries). */
export interface OpsetSummary {
  /** blocks carried with unchanged content and position */
  preserved: number;
  updated: number;
  moved: number;
  created: number;
  removed: number;
  split: number;
  merged: number;
  /** low-confidence carries / recorded near-misses the matcher flagged */
  ambiguous: number;
}

export interface Opset {
  version: 1;
  kind: OpsetKind;
  target: { doc: string; path: string };
  precondition: OpsetPrecondition;
  /** matcher version that produced the identity decisions (reproducibility) */
  matcherV: string;
  /** the planned ops, each annotated with its identity consequence */
  ops: PlanOp[];
  /**
   * Document-level frontmatter change, when the proposed content changes it.
   * `raw` is the new frontmatter incl. fences + trailing separator (null drops
   * it). Frontmatter is a materialization unit, not a block op; apply sets it
   * via ApplyRequest.setFrontmatter.
   */
  frontmatter?: { raw: string | null };
  summary: OpsetSummary;
  /**
   * Verified by the planner: replaying `ops` from the base state renders to
   * exactly the proposed content. When false, `apply(opset)` refuses (a plan
   * that cannot reproduce the intended bytes is never applied silently); the
   * caller inspects `diagnostics` and re-plans or edits.
   */
  converges: boolean;
  diagnostics: string[];
}

/** The bare kernel ops, in order — what `apply` actually replays. */
export function opsetKernelOps(opset: Opset): Op[] {
  return opset.ops.map((p) => p.op);
}

/** Compute the summary from the planned ops + carried/ambiguous counts. */
export function summarizeOps(
  ops: PlanOp[],
  counts: { preserved: number; ambiguous: number },
): OpsetSummary {
  const s: OpsetSummary = {
    preserved: counts.preserved,
    updated: 0, moved: 0, created: 0, removed: 0, split: 0, merged: 0,
    ambiguous: counts.ambiguous,
  };
  for (const p of ops) {
    switch (p.disposition) {
      case "edited": s.updated++; break;
      case "moved": s.moved++; break;
      case "edited_moved": s.updated++; s.moved++; break;
      case "inserted": case "copied_from": case "resurrected": s.created++; break;
      case "deleted": s.removed++; break;
      case "split_from": s.split++; break;
      case "merged_into": s.merged++; break;
      // "retiled"/"same"/"bulk_rewrite" carry no summary bucket of their own.
    }
  }
  return s;
}

/** Serialize an opset to a stable JSON string (ops are plain JSON). */
export function serializeOpset(opset: Opset): string {
  return JSON.stringify(opset);
}

/** Parse a serialized opset, validating the version tag. */
export function parseOpset(text: string): Opset {
  const o = JSON.parse(text) as Opset;
  if (o.version !== 1 || o.kind !== "doc_update") {
    throw new Error(`unrecognized opset (version ${String((o as { version?: unknown }).version)})`);
  }
  return o;
}

// A short human-/agent-readable rendering that makes identity consequences
// obvious (04-mutation §, the note's example). One line per op + a summary.
const VERB: Record<PlanDisposition, string> = {
  same: "KEEP  ", edited: "UPDATE", moved: "MOVE  ", edited_moved: "UPDATE",
  inserted: "INSERT", deleted: "REMOVE", split_from: "SPLIT ", merged_into: "MERGE ",
  copied_from: "COPY  ", resurrected: "RESURR", bulk_rewrite: "REWRITE", retiled: "RETILE",
};

export function renderOpsetPlan(opset: Opset): string {
  const lines: string[] = [];
  for (const p of opset.ops) {
    const subject = p.blocks[0] ?? "(new)";
    const conf = p.confidence !== null ? ` ~${p.confidence.toFixed(2)}` : "";
    const why = p.reason ? ` [${p.reason}]` : "";
    lines.push(`${VERB[p.disposition]} ${subject.padEnd(9)} ${p.disposition}${conf}${why}`);
  }
  const s = opset.summary;
  lines.push("");
  lines.push(
    `preserved: ${s.preserved}  updated: ${s.updated}  moved: ${s.moved}  ` +
    `created: ${s.created}  removed: ${s.removed}  split: ${s.split}  ` +
    `merged: ${s.merged}  ambiguous: ${s.ambiguous}`,
  );
  if (!opset.converges) lines.push(`WARNING: plan does not reproduce the proposed content exactly — will not apply.`);
  return lines.join("\n");
}
