import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { answerBlock, blockPaths, checkAnswer } from "../src/checks.ts";
import { FS_TOOL_NAMES } from "../src/fs-server.ts";
import { loadTasks, validateTask } from "../src/tasks.ts";
import { ANSWER_BLOCK_SENTENCE, isWriteTool, type AnswerCheck } from "../src/types.ts";
import { corpusDir, DEFAULT_CORPUS } from "../src/workspace.ts";

const VALID = {
  id: "demo",
  prompt: "do a thing",
  checks: [{ kind: "read", path: "/index.md", matches: ["Alchemy"] }],
  solution: { steps: [{ tool: "docs_read", args: { _path: "/index.md" } }], final_text: "done" },
  solution_fs: { steps: [{ tool: "read_file", args: { path: "/index.md" } }], final_text: "done" },
};

describe("tasks/*.json", () => {
  const { tasks, problems } = loadTasks();

  it("every task file validates", () => {
    expect(problems).toEqual([]);
  });

  it("the thirteen editing scenarios and the twelve retrieval tasks are present, one file each, id = file name", () => {
    expect(tasks.map((t) => t.id)).toEqual([
      "aggregate-by-key", "append-under-heading", "backlinks-with-context", "bulk-check-off", "contradiction", "create-then-section", "doc-move", "frontmatter-edit",
      "insert-after-block", "link-retarget", "merge-paragraphs", "noop", "open-tasks-across-corpus", "range-era", "range-window-includes", "rollup-filtered", "rollup",
      "semantic-cross-domain", "semantic-find", "semantic-paraphrase", "semantic-synonym", "split-paragraph", "stale-plan-retry", "timeline-between", "timeline-follow",
    ]);
  });

  it("the retrieval tasks: a corpus each (timeline for the programme ones), an answer check, unchanged_all on the pure reads, requires only on the semantic ones", () => {
    const retrieval = ["range-era", "range-window-includes", "timeline-follow", "timeline-between", "backlinks-with-context", "aggregate-by-key", "open-tasks-across-corpus", "semantic-find", "rollup-filtered", "semantic-synonym", "semantic-paraphrase", "semantic-cross-domain"];
    const timeline = tasks.filter((t) => t.corpus === "timeline").map((t) => t.id);
    expect(timeline).toEqual(["aggregate-by-key", "open-tasks-across-corpus", "range-window-includes", "rollup-filtered", "semantic-cross-domain", "semantic-paraphrase", "semantic-synonym", "timeline-between", "timeline-follow"]);
    for (const id of retrieval) {
      const t = tasks.find((x) => x.id === id)!;
      const answer = t.checks.find((c) => c.kind === "answer") as AnswerCheck | undefined;
      expect(answer).toBeDefined();
      if (id === "aggregate-by-key") {
        // six counts, not a set of paths: must_mention only, no block asked for
        expect(answer!.paths).toBeUndefined();
        expect(answer!.must_mention!.length).toBeGreaterThan(0);
        expect(t.prompt.endsWith(ANSWER_BLOCK_SENTENCE)).toBe(false);
      } else {
        // the block: the prompt asks for it, every expected path is a corpus document, both oracles end with it and pass it strictly
        expect(t.prompt.endsWith(` ${ANSWER_BLOCK_SENTENCE}`)).toBe(true);
        expect(answer!.paths!.length).toBeGreaterThan(0);
        for (const p of answer!.paths!) expect(existsSync(join(corpusDir(t.corpus ?? DEFAULT_CORPUS), p.slice(1)))).toBe(true);
        for (const sol of [t.solution, t.solution_fs]) {
          expect(blockPaths(answerBlock(sol.final_text)!)).toEqual(answer!.paths);
          expect(checkAnswer(answer!, sol.final_text)).toEqual([]);
        }
        expect(checkAnswer(answer!, "")).not.toEqual([]);
      }
      expect(answer!.mode).toBeUndefined();
      if (id === "rollup-filtered") {
        expect(t.unchanged_all).toBeUndefined();
        expect(t.checks.map((c) => c.kind)).toEqual(["read", "answer"]);
      } else {
        expect(t.unchanged_all).toBe(true);
        // a pure retrieval writes nothing in either solution
        expect(t.solution.steps.filter((s) => isWriteTool(s.tool))).toEqual([]);
        expect(t.solution_fs.steps.filter((s) => isWriteTool(s.tool))).toEqual([]);
      }
    }
    expect(tasks.filter((t) => t.requires).map((t) => t.id)).toEqual(["semantic-cross-domain", "semantic-find", "semantic-paraphrase", "semantic-synonym"]);
    for (const t of tasks.filter((t) => t.requires)) expect(t.requires).toEqual(["semantic"]);
    // the ordered ones: a chain, a bounded walk, a by-date rollup
    expect(tasks.filter((t) => t.checks.some((c) => c.kind === "answer" && c.ordered)).map((t) => t.id)).toEqual(["rollup-filtered", "timeline-between", "timeline-follow"]);
    // the editing tasks are untouched: alchemy, no answer check
    for (const t of tasks) if (!retrieval.includes(t.id)) {
      expect(t.corpus).toBeUndefined();
      expect(t.checks.some((c) => c.kind === "answer")).toBe(false);
    }
  });

  it("exactly one task carries the stale-plan hook, and it is the disk edit", () => {
    const hooked = tasks.filter((t) => t.hook);
    expect(hooked.map((t) => t.id)).toEqual(["stale-plan-retry"]);
    expect(hooked[0]!.hook).toMatchObject({ kind: "disk_edit", on: "after_first_plan", path: "timeline/review.md" });
  });

  it("the contradiction and the no-op check an untouched document and the final text", () => {
    for (const id of ["contradiction", "noop"]) {
      const t = tasks.find((x) => x.id === id)!;
      expect(t.checks.map((c) => c.kind).sort()).toEqual(["final_text", "unchanged"]);
    }
  });

  it("every solution ends with a final text and only references earlier steps", () => {
    for (const t of tasks) {
      expect(t.solution.final_text.length).toBeGreaterThan(0);
      expect(t.solution.steps.length).toBeGreaterThan(0);
    }
  });

  it("every task carries an fs solution that uses only the seven file tools; the no-op, the contradiction and the pure retrievals write nothing", () => {
    for (const t of tasks) {
      expect(t.solution_fs.final_text.length).toBeGreaterThan(0);
      expect(t.solution_fs.steps.length).toBeGreaterThan(0);
      for (const step of t.solution_fs.steps) expect(FS_TOOL_NAMES).toContain(step.tool);
      const writes = t.solution_fs.steps.filter((s) => isWriteTool(s.tool)).length;
      if (t.id === "noop" || t.id === "contradiction" || t.unchanged_all) expect(writes).toBe(0);
      else expect(writes).toBeGreaterThan(0);
    }
    // the hook analog: read, a write the hook fires before, a re-read, the corrective edit
    expect(tasks.find((t) => t.id === "stale-plan-retry")!.solution_fs.steps.map((s) => s.tool)).toEqual(["read_file", "edit_file", "read_file", "edit_file"]);
  });
});

describe("validateTask", () => {
  it("accepts a minimal valid task", () => {
    expect(validateTask(VALID, "demo.json")).toEqual([]);
  });

  it("rejects a missing prompt, an unknown check kind, a bad regex, an unknown member", () => {
    expect(validateTask({ ...VALID, prompt: "" }, "x")).toEqual(["x: prompt must be a non-empty string"]);
    expect(validateTask({ ...VALID, checks: [{ kind: "grep" }] }, "x")[0]).toMatch(/kind must be one of/);
    expect(validateTask({ ...VALID, checks: [{ kind: "read", path: "/a.md", matches: ["("] }] }, "x")[0]).toMatch(/does not compile/);
    expect(validateTask({ ...VALID, extra: 1 }, "x")).toEqual(["x: unknown member `extra`"]);
    expect(validateTask({ ...VALID, checks: [{ kind: "query", query: "docs { }" }] }, "x")[0]).toMatch(/needs `hits` and\/or `count`/);
  });

  it("rejects a $result that points forward and a malformed hook", () => {
    const fwd = { ...VALID, solution: { steps: [{ tool: "execute", args: { plan: { $result: 0 } } }], final_text: "x" } };
    expect(validateTask(fwd, "x")).toEqual(["x.solution.steps[0]: $result 0 must refer to an earlier step"]);
    const hook = { ...VALID, hook: { kind: "disk_edit", on: "later", path: "a.md", append: "" } };
    expect(validateTask(hook, "x")).toEqual(["x.hook: hook.on must be \"after_first_plan\"", "x.hook: hook.append must be a non-empty string"]);
  });

  it("rejects a non-object, and a task without an fs solution", () => {
    expect(validateTask(null, "x")).toEqual(["x: a task must be an object"]);
    const { solution_fs: _dropped, ...noFs } = VALID;
    expect(validateTask(noFs, "x")).toEqual(["x.solution_fs: must be an object (steps + final_text)"]);
  });
});
