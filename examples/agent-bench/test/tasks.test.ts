import { describe, expect, it } from "vitest";
import { loadTasks, validateTask } from "../src/tasks.ts";

const VALID = {
  id: "demo",
  prompt: "do a thing",
  checks: [{ kind: "read", path: "/index.md", matches: ["Alchemy"] }],
  solution: { steps: [{ tool: "docs_read", args: { _path: "/index.md" } }], final_text: "done" },
};

describe("tasks/*.json", () => {
  const { tasks, problems } = loadTasks();

  it("every task file validates", () => {
    expect(problems).toEqual([]);
  });

  it("the thirteen scenarios of the brief are present, one file each, id = file name", () => {
    expect(tasks.map((t) => t.id)).toEqual([
      "append-under-heading", "bulk-check-off", "contradiction", "create-then-section", "doc-move", "frontmatter-edit",
      "insert-after-block", "link-retarget", "merge-paragraphs", "noop", "rollup", "split-paragraph", "stale-plan-retry",
    ]);
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
    expect(validateTask({ ...VALID, checks: [{ kind: "query", query: "from docs" }] }, "x")[0]).toMatch(/needs `hits` and\/or `count`/);
  });

  it("rejects a $result that points forward and a malformed hook", () => {
    const fwd = { ...VALID, solution: { steps: [{ tool: "execute", args: { plan: { $result: 0 } } }], final_text: "x" } };
    expect(validateTask(fwd, "x")).toEqual(["x.solution.steps[0]: $result 0 must refer to an earlier step"]);
    const hook = { ...VALID, hook: { kind: "disk_edit", on: "later", path: "a.md", append: "" } };
    expect(validateTask(hook, "x")).toEqual(["x.hook: hook.on must be \"after_first_plan\"", "x.hook: hook.append must be a non-empty string"]);
  });

  it("rejects a non-object", () => {
    expect(validateTask(null, "x")).toEqual(["x: a task must be an object"]);
  });
});
