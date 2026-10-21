// pnpm bench rescore <results-dir>: score a STORED run again under the tasks'
// current definitions, without a workspace. Only the checks that need nothing but
// the final text are re-run — `answer` and `final_text` — against each run's stored
// `final_text`; the checks that needed the workspace (`read`, `query`, `unchanged`,
// `unchanged_all`) are kept as recorded in `check_failures`. A run passes iff no
// workspace failure remains and the text checks pass. A run that never produced a
// final text (a harness error, a skipped cell) is kept as it was.
//
// A run recorded before the retrieval prompts carried the `answer` block sentence
// (`meta.answer_block !== true`) is scored with the `answer` check in lenient mode:
// every expected path somewhere in the text, in either path form, extra paths not
// penalized, order on first occurrences. A run since then is scored strictly, as
// the bench scores it.
//
// Writes results.rescored.json and report.rescored.md NEXT TO the originals; the
// originals are never touched. The report's header says it is a rescore, in which
// mode, and which verdicts changed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkAnswer, checkFinalText, isTextOnly, isTextOnlyFailure } from "./checks.ts";
import { renderReport, type ReportMeta, type RescoreMeta } from "./report.ts";
import { loadTasks } from "./tasks.ts";
import type { RunMetrics, Task } from "./types.ts";

export interface StoredResults {
  meta: ReportMeta;
  results: RunMetrics[];
}

export interface RescoreOutcome {
  meta: ReportMeta;
  results: RunMetrics[];
  /** the runs whose verdict changed, `task [profile] #run: FAIL → pass` */
  changed: string[];
  /** the runs kept untouched (no final text: a harness error or a skip) */
  kept: number;
}

/** The mode the `answer` checks run in for a stored run: strict once the prompts carried the block sentence, lenient before. */
export function answerModeFor(meta: ReportMeta): "strict" | "lenient" {
  return meta.answer_block === true ? "strict" : "lenient";
}

/** One run, rescored: the workspace failures kept, the text checks re-run. */
export function rescoreRun(run: RunMetrics, task: Task | undefined, mode: "strict" | "lenient"): RunMetrics {
  if (run.skipped !== undefined || run.error !== undefined && run.final_text === "") return run;
  if (!task) return { ...run, passed: false, check_failures: [...run.check_failures.filter((f) => !isTextOnlyFailure(f)), `rescore: task ${run.task} is no longer defined in tasks/`] };
  const kept = run.check_failures.filter((f) => !isTextOnlyFailure(f));
  const fresh: string[] = [];
  for (const c of task.checks) {
    if (!isTextOnly(c)) continue;
    fresh.push(...(c.kind === "answer" ? checkAnswer(c, run.final_text, mode) : checkFinalText(c, run.final_text)));
  }
  const check_failures = [...kept, ...fresh];
  return { ...run, passed: check_failures.length === 0, check_failures };
}

/** The whole stored run under the given tasks (pure; the CLI reads and writes around it). */
export function rescore(stored: StoredResults, tasks: Task[], source: string, now = new Date()): RescoreOutcome {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const mode = answerModeFor(stored.meta);
  const changed: string[] = [];
  let kept = 0;
  const results = stored.results.map((run) => {
    const after = rescoreRun(run, byId.get(run.task), mode);
    if (after === run && run.skipped === undefined) kept += 1;
    if (after.passed !== run.passed) changed.push(`${run.task} [${run.profile}] #${run.run}: ${run.passed ? "pass" : "FAIL"} → ${after.passed ? "pass" : "FAIL"}`);
    return after;
  });
  const rescoreMeta: RescoreMeta = { at: now.toISOString(), source, answer_mode: mode, changed, kept };
  return { meta: { ...stored.meta, rescore: rescoreMeta }, results, changed, kept };
}

/** Read results/<stamp>/results.json, rescore, write the two `.rescored.*` files beside it. Returns the lines to print. */
export function rescoreDir(dir: string, tasks: Task[], now = new Date()): string[] {
  const source = join(dir, "results.json");
  if (!existsSync(source)) throw new Error(`no results.json in ${dir}`);
  const stored = JSON.parse(readFileSync(source, "utf8")) as StoredResults;
  const out = rescore(stored, tasks, "results.json", now);
  writeFileSync(join(dir, "results.rescored.json"), JSON.stringify({ meta: out.meta, results: out.results }, null, 2) + "\n");
  writeFileSync(join(dir, "report.rescored.md"), renderReport(out.results, out.meta));
  const live = out.results.filter((r) => r.skipped === undefined);
  const lines = [
    `rescored ${live.length} run(s) from ${source} (answer checks in ${out.meta.rescore!.answer_mode} mode): ${live.filter((r) => r.passed).length} pass, ${live.filter((r) => !r.passed).length} FAIL; ${out.changed.length} verdict(s) changed, ${out.kept} run(s) kept as recorded`,
    ...out.changed.map((c) => `  ${c}`),
    `wrote ${join(dir, "results.rescored.json")} and ${join(dir, "report.rescored.md")}`,
  ];
  return lines;
}

export async function rescoreMain(argv: string[]): Promise<void> {
  const dir = argv[0];
  if (!dir || argv.length !== 1 || dir.startsWith("-")) {
    console.error("usage: pnpm bench rescore <results-dir>");
    process.exit(2);
  }
  const { tasks, problems } = loadTasks();
  if (problems.length > 0) {
    console.error(`task file problems:\n${problems.map((p) => `  ! ${p}`).join("\n")}`);
    process.exit(1);
  }
  for (const line of rescoreDir(resolve(dir), tasks)) console.error(line);
}
