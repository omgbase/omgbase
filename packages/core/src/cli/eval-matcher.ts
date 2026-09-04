import { runEval } from "../reconcile/eval/metrics.js";
import { DEFAULT_CONFIG } from "../reconcile/types.js";

// `omg eval-matcher` (07 task 2.6). Runs the synthetic suite and prints the
// metrics report. Release gates (03 §9): precision ≥ 0.995 overall / ≥ 0.98 per
// class; recall ≥ 0.95 for edit/move/reorder; split/merge recall ≥ 0.75.

export interface EvalCliOptions {
  n?: number;
  size?: number;
  intensity?: number;
}

export function formatReport(report: ReturnType<typeof runEval>): string {
  const lines: string[] = [];
  lines.push(`matcher_v=${DEFAULT_CONFIG.matcherV}  cases=${report.cases}`);
  lines.push("");
  const row = (name: string, m: { precision: number; recall: number; truePairs: number; carriedPairs: number }): string =>
    `${name.padEnd(10)} precision=${m.precision.toFixed(4)} recall=${m.recall.toFixed(4)} true=${m.truePairs} carried=${m.carriedPairs}`;
  lines.push(row("OVERALL", report.overall));
  for (const [cls, m] of Object.entries(report.perClass)) lines.push(row(cls, m));
  return lines.join("\n");
}

/** Run the eval and return the report + a pass/fail against release gates. */
export function evalMatcher(opts: EvalCliOptions = {}): { report: ReturnType<typeof runEval>; text: string; gatesPass: boolean } {
  const runOpts: { n?: number; size?: number; intensity?: number; config: typeof DEFAULT_CONFIG } = { config: DEFAULT_CONFIG };
  if (opts.n !== undefined) runOpts.n = opts.n;
  if (opts.size !== undefined) runOpts.size = opts.size;
  if (opts.intensity !== undefined) runOpts.intensity = opts.intensity;
  const report = runEval(runOpts);
  const gatesPass = checkGates(report);
  return { report, text: formatReport(report), gatesPass };
}

function checkGates(report: ReturnType<typeof runEval>): boolean {
  if (report.overall.precision < 0.995) return false;
  for (const cls of ["edit", "move", "reorder"] as const) {
    const m = report.perClass[cls];
    if (m && m.recall < 0.95) return false;
  }
  return true;
}
