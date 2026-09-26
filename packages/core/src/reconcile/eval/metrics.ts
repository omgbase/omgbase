import { reconcileDocument } from "../reconcile.js";
import { DEFAULT_CONFIG, type ReconcileConfig } from "../types.js";
import {
  generateCase, generateStructuredCase,
  type EditClass, type GeneratedCase, type StructuredEditClass, type StructuredOpts,
} from "./generator.js";

// Matcher metrics (03 §9). Identity precision = carried pairs that are true
// pairs; recall = true pairs carried. Computed overall and per edit class.
// Classes key by the NEW block's positional key (any depth: `/2/1/1/0` is as
// good a key as `/2`), so nested blocks in structured mode bucket like any other.

export interface ClassMetrics {
  /** new blocks of this class (carried or minted in truth) */
  newBlocks: number;
  truePairs: number;
  carriedPairs: number;
  correctCarries: number;
  precision: number; // correct / carried
  recall: number; // correct / true
}

export interface EvalReport {
  cases: number;
  mode: EvalMode;
  overall: ClassMetrics;
  perClass: Record<string, ClassMetrics>;
  /** old ids the truth deletes, and how many of them the matcher carried anyway */
  deleted: { expected: number; wronglyCarried: number };
  /** the effective config the suite ran under */
  config: ReconcileConfig;
}

export type EvalMode = "flat" | "structured";

type Agg = { newBlocks: number; truePairs: number; carriedPairs: number; correctCarries: number };
function blank(): Agg {
  return { newBlocks: 0, truePairs: 0, carriedPairs: 0, correctCarries: 0 };
}
function add(into: Agg, from: Agg): void {
  into.newBlocks += from.newBlocks;
  into.truePairs += from.truePairs;
  into.carriedPairs += from.carriedPairs;
  into.correctCarries += from.correctCarries;
}

export function evaluateCase(c: GeneratedCase, config?: ReconcileConfig): {
  overall: Agg;
  perClass: Map<string, Agg>;
  deleted: { expected: number; wronglyCarried: number };
} {
  const res = reconcileDocument(c.old, c.neu, config ? { config } : {});
  const overall = blank();
  const perClass = new Map<string, Agg>();
  const bucket = (cls: string): Agg => perClass.get(cls) ?? perClass.set(cls, blank()).get(cls)!;
  // Flat mode leaves untouched blocks unclassified and they count as "edit"
  // (kept: the release gates were tuned against that bucketing).
  const classOf = (key: string): string => c.truth.classOf.get(key) ?? "edit";

  for (const b of c.neu) {
    overall.newBlocks++;
    bucket(classOf(b.key)).newBlocks++;
  }

  // True pairs: ground-truth carries.
  for (const [key, oldId] of c.truth.carries) {
    overall.truePairs++;
    bucket(classOf(key)).truePairs++;
    if (res.assignment.get(key) === oldId) {
      overall.correctCarries++;
      bucket(classOf(key)).correctCarries++;
    }
  }

  // Carried pairs: assignments where the matcher reused an OLD id (not minted).
  const oldIds = new Set(c.old.map((b) => b.blockId!));
  const carriedOld = new Set<string>();
  for (const [key, id] of res.assignment) {
    if (oldIds.has(id)) {
      overall.carriedPairs++;
      bucket(classOf(key)).carriedPairs++;
      carriedOld.add(id);
    }
  }
  let wronglyCarried = 0;
  for (const id of c.truth.deleted) if (carriedOld.has(id)) wronglyCarried++;
  return { overall, perClass, deleted: { expected: c.truth.deleted.size, wronglyCarried } };
}

function finalize(agg: Agg): ClassMetrics {
  return {
    ...agg,
    precision: agg.carriedPairs === 0 ? 1 : agg.correctCarries / agg.carriedPairs,
    recall: agg.truePairs === 0 ? 1 : agg.correctCarries / agg.truePairs,
  };
}

export interface RunEvalOptions {
  n?: number;
  /** flat: top-level paragraphs per doc (12); structured: top-level blocks per doc (10) */
  size?: number;
  intensity?: number;
  /** structured mode only: words per list item (absent ⇒ 2–6 per item) */
  itemWords?: number;
  /** "flat" (default; the release-gate suite) or "structured" (lists of short items) */
  mode?: EvalMode;
  /** full config; defaults to DEFAULT_CONFIG */
  config?: ReconcileConfig;
  /** fields to override on top of `config` (e.g. `{ contextSimFloor: 0.3 }`) */
  configOverrides?: Partial<ReconcileConfig>;
}

/** Run the synthetic suite over `n` seeded cases and produce the report. */
export function runEval(opts: RunEvalOptions = {}): EvalReport {
  const n = opts.n ?? 200;
  const mode: EvalMode = opts.mode ?? "flat";
  const config: ReconcileConfig = { ...(opts.config ?? DEFAULT_CONFIG), ...(opts.configOverrides ?? {}) };
  const overall = blank();
  const perClass = new Map<string, Agg>();
  const deleted = { expected: 0, wronglyCarried: 0 };

  for (let seed = 1; seed <= n; seed++) {
    let c: GeneratedCase;
    if (mode === "structured") {
      const genOpts: StructuredOpts = {};
      if (opts.size !== undefined) genOpts.size = opts.size;
      if (opts.intensity !== undefined) genOpts.intensity = opts.intensity;
      if (opts.itemWords !== undefined) genOpts.itemWords = opts.itemWords;
      c = generateStructuredCase(seed, genOpts);
    } else {
      const genOpts: { size?: number; intensity?: number } = {};
      if (opts.size !== undefined) genOpts.size = opts.size;
      if (opts.intensity !== undefined) genOpts.intensity = opts.intensity;
      c = generateCase(seed, genOpts);
    }
    const r = evaluateCase(c, config);
    add(overall, r.overall);
    for (const [cls, agg] of r.perClass) add(perClass.get(cls) ?? perClass.set(cls, blank()).get(cls)!, agg);
    deleted.expected += r.deleted.expected;
    deleted.wronglyCarried += r.deleted.wronglyCarried;
  }

  const perClassOut: Record<string, ClassMetrics> = {};
  for (const [cls, agg] of perClass) perClassOut[cls] = finalize(agg);

  return { cases: n, mode, overall: finalize(overall), perClass: perClassOut, deleted, config };
}

export type { EditClass, StructuredEditClass };
