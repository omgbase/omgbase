import { reconcileDocument } from "../reconcile.js";
import type { ReconcileConfig } from "../types.js";
import { generateCase, type EditClass, type GeneratedCase } from "./generator.js";

// Matcher metrics (03 §9). Identity precision = carried pairs that are true
// pairs; recall = true pairs carried. Computed overall and per edit class.

export interface ClassMetrics {
  truePairs: number;
  carriedPairs: number;
  correctCarries: number;
  precision: number; // correct / carried
  recall: number; // correct / true
}

export interface EvalReport {
  cases: number;
  overall: ClassMetrics;
  perClass: Record<string, ClassMetrics>;
  config: ReconcileConfig;
}

function blank(): { truePairs: number; carriedPairs: number; correctCarries: number } {
  return { truePairs: 0, carriedPairs: 0, correctCarries: 0 };
}

export function evaluateCase(c: GeneratedCase, config?: ReconcileConfig): {
  overall: ReturnType<typeof blank>;
  perClass: Map<string, ReturnType<typeof blank>>;
} {
  const res = reconcileDocument(c.old, c.neu, config ? { config } : {});
  const overall = blank();
  const perClass = new Map<string, ReturnType<typeof blank>>();
  const bucket = (cls: string): ReturnType<typeof blank> => perClass.get(cls) ?? perClass.set(cls, blank()).get(cls)!;

  // True pairs: ground-truth carries.
  for (const [key, oldId] of c.truth.carries) {
    overall.truePairs++;
    const cls = c.truth.classOf.get(key) ?? "edit";
    bucket(cls).truePairs++;
    const got = res.assignment.get(key);
    if (got === oldId) {
      overall.correctCarries++;
      bucket(cls).correctCarries++;
    }
  }

  // Carried pairs: assignments where the matcher reused an OLD id (not minted).
  const oldIds = new Set(c.old.map((b) => b.blockId!));
  const truthByKey = c.truth.carries;
  for (const [key, id] of res.assignment) {
    if (oldIds.has(id)) {
      overall.carriedPairs++;
      const cls = c.truth.classOf.get(key) ?? "edit";
      bucket(cls).carriedPairs++;
      // correctness already tallied above when it matches truth; recount for
      // precision denominators handled via correctCarries computed there.
      void truthByKey;
    }
  }
  return { overall, perClass };
}

function finalize(agg: ReturnType<typeof blank>): ClassMetrics {
  return {
    ...agg,
    precision: agg.carriedPairs === 0 ? 1 : agg.correctCarries / agg.carriedPairs,
    recall: agg.truePairs === 0 ? 1 : agg.correctCarries / agg.truePairs,
  };
}

/** Run the synthetic suite over `n` seeded cases and produce the report. */
export function runEval(opts: { n?: number; size?: number; intensity?: number; config?: ReconcileConfig } = {}): EvalReport {
  const n = opts.n ?? 200;
  const overall = blank();
  const perClass = new Map<string, ReturnType<typeof blank>>();

  for (let seed = 1; seed <= n; seed++) {
    const genOpts: { size?: number; intensity?: number } = {};
    if (opts.size !== undefined) genOpts.size = opts.size;
    if (opts.intensity !== undefined) genOpts.intensity = opts.intensity;
    const c = generateCase(seed, genOpts);
    const r = evaluateCase(c, opts.config);
    overall.truePairs += r.overall.truePairs;
    overall.carriedPairs += r.overall.carriedPairs;
    overall.correctCarries += r.overall.correctCarries;
    for (const [cls, agg] of r.perClass) {
      const b = perClass.get(cls) ?? perClass.set(cls, blank()).get(cls)!;
      b.truePairs += agg.truePairs;
      b.carriedPairs += agg.carriedPairs;
      b.correctCarries += agg.correctCarries;
    }
  }

  const perClassOut: Record<string, ClassMetrics> = {};
  for (const [cls, agg] of perClass) perClassOut[cls] = finalize(agg);

  // config echo: default when not provided
  const cfg = opts.config ?? (undefined as unknown as ReconcileConfig);
  return { cases: n, overall: finalize(overall), perClass: perClassOut, config: cfg };
}

export type { EditClass };
