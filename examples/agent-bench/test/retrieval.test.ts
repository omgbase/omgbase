// One dry run per retrieval task, under `full` and `fs`: the scripted solution
// reaches the answer (or the end state) through the real loop and the real omg,
// the checks pass, and the checks reject an untouched workspace. The semantic tasks
// are the skip path under `full` (no embedder in the test) and a grep walk under
// `fs` (test/semantic-ranking.test.ts runs them under `full` with an embedder, opt-in).
import { describe, expect, it } from "vitest";
import { dryRun, skipReason } from "../src/bench.ts";
import { loadTasks } from "../src/tasks.ts";
import type { Task } from "../src/types.ts";

const { tasks, problems } = loadTasks();
if (problems.length > 0) throw new Error(problems.join("\n"));
const task = (id: string): Task => tasks.find((t) => t.id === id)!;

export const RETRIEVAL_TASKS = ["range-era", "range-window-includes", "timeline-follow", "timeline-between", "backlinks-with-context", "aggregate-by-key", "open-tasks-across-corpus", "semantic-find", "rollup-filtered", "semantic-synonym", "semantic-paraphrase", "semantic-cross-domain"];

describe("the retrieval tasks dry-run green under full and fs", () => {
  for (const id of RETRIEVAL_TASKS) {
    it(id, async () => {
      const log: string[] = [];
      const problems = await dryRun([task(id)], ["full", "fs"], (l) => log.push(l));
      expect(problems).toEqual([]);
      if (task(id).requires?.includes("semantic")) {
        expect(log[0]).toBe(`  skip ${id} [full] solution (needs --embedder)`);
        expect(log[2]).toMatch(new RegExp(`^ {2}ok {3}${id} \\[fs\\] solution: ${task(id).solution_fs.steps.length} step\\(s\\)`));
      } else {
        expect(log.filter((l) => /^ {2}ok {3}/.test(l))).toHaveLength(4);
      }
    }, 120_000);
  }

  it("skipReason: semantic needs --embedder under an omgbase profile, never under fs; a task without requirements never skips", () => {
    const sem = task("semantic-find");
    expect(sem.requires).toEqual(["semantic"]);
    expect(skipReason(sem, "full", undefined)).toBe("needs --embedder");
    expect(skipReason(sem, "minimal", undefined)).toBe("needs --embedder");
    expect(skipReason(sem, "full", "omgbase-embedder")).toBeNull();
    expect(skipReason(sem, "fs", undefined)).toBeNull();
    expect(skipReason(task("range-era"), "full", undefined)).toBeNull();
  });
});
