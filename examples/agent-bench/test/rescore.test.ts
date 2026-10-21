// `pnpm bench rescore <dir>`: a stored run scored again under the tasks' current
// text-only checks — the workspace failures kept, the answer/final_text failures
// dropped and re-derived, lenient when the run predates the block sentence — written
// beside the originals, which are never touched.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerModeFor, rescore, rescoreDir, rescoreRun, type StoredResults } from "../src/rescore.ts";
import type { ReportMeta } from "../src/report.ts";
import { loadTasks } from "../src/tasks.ts";
import type { RunMetrics, Task } from "../src/types.ts";

const { tasks, problems } = loadTasks();
if (problems.length > 0) throw new Error(problems.join("\n"));
const task = (id: string): Task => tasks.find((t) => t.id === id)!;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(over: Partial<RunMetrics> & { task: string; profile: string }): RunMetrics {
  return {
    corpus: "alchemy", run: 1, model: "m", turns: 3, tool_calls: 2, calls_by_tool: {}, failed_calls: 0, failed_by_code: {}, plan_calls: 0, execute_calls: 0, write_calls: 0,
    plan_before_write: null, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, wall_ms: 1, hit_turn_cap: false, hook_fired: false,
    passed: false, check_failures: [], final_text: "", transcript: `transcripts/${over.task}.${over.profile}.1.jsonl`,
    ...over,
  };
}

const META: ReportMeta = { model: "global.anthropic.claude-opus-5", provider: "bedrock", effort: "high", started: "2026-10-21T02:33:11.065Z", finished: "2026-10-21T03:57:00.896Z", profiles: ["full", "fs"], runs: 1, max_turns: 20, embedder: "node packages/embedder/dist/src/bin.js" };

// the stored run: the old check's false failures, a real workspace failure, a harness error, a skip, a legitimately failing final_text, a passing editing task
const legacyText = "| Jabir ibn Hayyan | `practitioners/jabir-ibn-hayyan.md` | 800 |\n| Paracelsus | `practitioners/paracelsus.md` | 1530 |\nMaria Prophetissa (250) and Newton (1680) fall outside.";
const STORED: StoredResults = {
  meta: META,
  results: [
    run({ task: "range-era", profile: "fs", final_text: legacyText, check_failures: ['answer does not mention "/practitioners/jabir-ibn-hayyan.md"', 'answer mentions the decoy "maria"', `answer was: ${legacyText}`] }),
    run({ task: "rollup-filtered", profile: "full", corpus: "timeline", final_text: "Appended /projects/cirrus/dome-slit-alignment.md, /projects/aurora/bench-alignment.md and /projects/aurora/integration-with-dome.md; excluded Mara Lind's open-day.", check_failures: ['answer mentions the decoy "open-day"', "answer was: …"] }),
    run({ task: "rollup-filtered", profile: "fs", corpus: "timeline", final_text: "Appended /projects/cirrus/dome-slit-alignment.md, /projects/aurora/bench-alignment.md and /projects/aurora/integration-with-dome.md.", check_failures: ["/index.md: does not match /the day the status flipped…/", 'answer mentions the decoy "open-day"', "answer was: …"] }),
    run({ task: "semantic-find", profile: "full", error: "Unexpected end of JSON input", check_failures: ["harness: Unexpected end of JSON input"] }),
    run({ task: "semantic-find", profile: "minimal", skipped: "needs --embedder", turns: 0 }),
    run({ task: "noop", profile: "full", final_text: "I changed the layer to 1 as asked.", check_failures: ["final text does not match /no change|already|nothing to (do|change)|unchanged/: I changed the layer to 1 as asked."] }),
    run({ task: "frontmatter-edit", profile: "full", passed: true, final_text: "done", write_calls: 1, plan_before_write: true }),
    run({ task: "retired-task", profile: "full", passed: true, final_text: "x" }),
  ],
};

describe("rescore", () => {
  it("a run predates the block when meta.answer_block is not true", () => {
    expect(answerModeFor(META)).toBe("lenient");
    expect(answerModeFor({ ...META, answer_block: true })).toBe("strict");
    expect(answerModeFor({ ...META, answer_block: false })).toBe("lenient");
  });

  it("re-runs the text-only checks over the stored final text, keeps the workspace failures, leaves a harness error and a skip alone", () => {
    const out = rescore(STORED, tasks, "results.json", new Date("2026-10-21T12:00:00Z"));
    const by = (t: string, p: string) => out.results.find((r) => r.task === t && r.profile === p)!;
    // the old check's false failures go; lenient: must_mention (the names) carries range-era
    expect(by("range-era", "fs")).toMatchObject({ passed: true, check_failures: [] });
    // rollup-filtered has no must_mention: the three paths anywhere in the text, in order; the decoy in the prose is free
    expect(by("rollup-filtered", "full")).toMatchObject({ passed: true, check_failures: [] });
    // the `read` failure was the workspace's and stays; the run still fails
    expect(by("rollup-filtered", "fs")).toMatchObject({ passed: false, check_failures: ["/index.md: does not match /the day the status flipped…/"] });
    // a harness error with no final text, and a skipped cell, are kept verbatim
    expect(by("semantic-find", "full")).toBe(STORED.results[3]);
    expect(by("semantic-find", "minimal")).toBe(STORED.results[4]);
    // final_text is re-run too (and still fails here)
    expect(by("noop", "full")).toMatchObject({ passed: false, check_failures: [expect.stringMatching(/^final text does not match/)] });
    // a passing editing task stays passing (no text-only check of its own)
    expect(by("frontmatter-edit", "full")).toMatchObject({ passed: true, check_failures: [] });
    // a task no longer in tasks/ cannot be rescored
    expect(by("retired-task", "full")).toMatchObject({ passed: false, check_failures: ["rescore: task retired-task is no longer defined in tasks/"] });
    expect(out.changed).toEqual(["range-era [fs] #1: FAIL → pass", "rollup-filtered [full] #1: FAIL → pass", "retired-task [full] #1: pass → FAIL"]);
    expect(out.kept).toBe(1);
    expect(out.meta.rescore).toEqual({ at: "2026-10-21T12:00:00.000Z", source: "results.json", answer_mode: "lenient", changed: out.changed, kept: 1 });
    expect(out.meta.answer_block).toBeUndefined(); // the stored meta is carried, not rewritten
  });

  it("strict for a run recorded with the block sentence: the same legacy prose now fails for want of a block", () => {
    const strict = rescore({ ...STORED, meta: { ...META, answer_block: true } }, tasks, "results.json");
    expect(strict.meta.rescore!.answer_mode).toBe("strict");
    expect(strict.results.find((r) => r.task === "range-era")!.check_failures[0]).toMatch(/^answer: no ```answer block/);
    const blocked = rescoreRun(run({ task: "range-era", profile: "full", final_text: `${legacyText}\n\n\`\`\`answer\n/practitioners/jabir-ibn-hayyan.md\n/practitioners/paracelsus.md\n\`\`\`` }), task("range-era"), "strict");
    expect(blocked).toMatchObject({ passed: true, check_failures: [] });
  });

  it("writes results.rescored.json and report.rescored.md beside the originals, which it never touches", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bench-rescore-"));
    dirs.push(dir);
    const original = JSON.stringify(STORED, null, 2) + "\n";
    writeFileSync(join(dir, "results.json"), original);
    writeFileSync(join(dir, "report.md"), "# the original report\n");
    const before = statSync(join(dir, "report.md")).mtimeMs;
    const lines = rescoreDir(dir, tasks, new Date("2026-10-21T12:00:00Z"));
    expect(lines[0]).toBe(`rescored 7 run(s) from ${join(dir, "results.json")} (answer checks in lenient mode): 3 pass, 4 FAIL; 3 verdict(s) changed, 1 run(s) kept as recorded`);
    expect(lines.slice(1, 4)).toEqual(["  range-era [fs] #1: FAIL → pass", "  rollup-filtered [full] #1: FAIL → pass", "  retired-task [full] #1: pass → FAIL"]);
    expect(readdirSync(dir).sort()).toEqual(["report.md", "report.rescored.md", "results.json", "results.rescored.json"]);
    expect(readFileSync(join(dir, "results.json"), "utf8")).toBe(original);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# the original report\n");
    expect(statSync(join(dir, "report.md")).mtimeMs).toBe(before);
    const json = JSON.parse(readFileSync(join(dir, "results.rescored.json"), "utf8")) as StoredResults;
    expect(json.meta.rescore).toMatchObject({ source: "results.json", answer_mode: "lenient", kept: 1 });
    expect(json.results.find((r) => r.task === "range-era")).toMatchObject({ passed: true });
    const report = readFileSync(join(dir, "report.rescored.md"), "utf8");
    expect(report).toContain("- **rescored** 2026-10-21T12:00:00.000Z from `results.json` under the tasks' CURRENT checks: the text-only checks (`answer`, `final_text`) re-run over each run's stored final text — `answer` in lenient mode (the run predates the `answer` block sentence");
    expect(report).toContain("Verdicts changed: range-era [fs] #1: FAIL → pass; rollup-filtered [full] #1: FAIL → pass; retired-task [full] #1: pass → FAIL");
    expect(report).toContain("| range-era | alchemy | `fs` | 1/1 (100%) |");
    expect(report).toContain("| rollup-filtered | timeline | `fs` | 0/1 (0%) |");
    expect(() => rescoreDir(join(dir, "nope"), tasks)).toThrow(/no results.json/);
  });
});
