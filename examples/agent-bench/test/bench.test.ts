// `pnpm bench` end to end with the scripted model standing in for Claude: the
// results directory, the report, results.json and one transcript per cell.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, parseBenchArgs } from "../src/bench.ts";
import { ScriptedModel } from "../src/model.ts";

const out = mkdtempSync(join(tmpdir(), "agent-bench-results-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("parseBenchArgs", () => {
  it("defaults to both profiles, 3 runs, the recommended model, high effort, 20 turns", () => {
    const o = parseBenchArgs([]);
    expect(o).toMatchObject({ profiles: ["full", "minimal"], runs: 3, model: "claude-opus-5", effort: "high", maxTurns: 20, dry: false });
    expect("tasks" in o).toBe(false);
  });

  it("parses every flag and refuses bad values", () => {
    expect(parseBenchArgs(["--profiles", "minimal", "--runs", "1", "--tasks", "noop,rollup", "--model", "claude-sonnet-5", "--effort", "low", "--max-turns", "5", "--out", "/tmp/x", "--dry"]))
      .toMatchObject({ profiles: ["minimal"], runs: 1, tasks: ["noop", "rollup"], model: "claude-sonnet-5", effort: "low", maxTurns: 5, out: "/tmp/x", dry: true });
    expect(parseBenchArgs(["--runs", "0"])).toEqual({ error: "--runs must be a positive integer" });
    expect(parseBenchArgs(["--effort", "huge"])).toMatchObject({ error: expect.stringMatching(/--effort/) });
    expect(parseBenchArgs(["--bogus"])).toMatchObject({ error: expect.stringMatching(/bogus/) });
    expect(parseBenchArgs(["--help"])).toEqual({ help: true });
  });
});

describe("bench", () => {
  it("runs the cells with an injected model and writes report.md, results.json and the transcripts", async () => {
    const log: string[] = [];
    const { dir, results, problems } = await bench({
      profiles: ["full"], runs: 1, tasks: ["frontmatter-edit", "noop"], model: "scripted", effort: "high", maxTurns: 20, out, dry: false,
      makeModel: (task) => new ScriptedModel(task.solution),
      log: (l) => log.push(l),
    });
    expect(problems).toEqual([]);
    expect(dir).not.toBeNull();
    expect(results.map((r) => [r.task, r.profile, r.run, r.passed])).toEqual([["frontmatter-edit", "full", 1, true], ["noop", "full", 1, true]]);
    expect(readdirSync(dir!).sort()).toEqual(["report.md", "results.json", "transcripts"]);
    expect(readdirSync(join(dir!, "transcripts")).sort()).toEqual(["frontmatter-edit.full.1.jsonl", "noop.full.1.jsonl"]);
    const lines = readFileSync(join(dir!, "transcripts", "frontmatter-edit.full.1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines.map((l) => l.type)).toEqual(["start", "assistant", "tool_call", "tool_result", "assistant", "end", "check"]);
    expect(lines[0]).toMatchObject({ profile: "full", task: "frontmatter-edit", tools: expect.arrayContaining(["apply", "docs_set_meta"]) });
    const report = readFileSync(join(dir!, "report.md"), "utf8");
    expect(report).toContain("| frontmatter-edit | `full` | 1/1 (100%) |");
    expect(report).toContain("| noop | `full` | 1/1 (100%) |");
    const json = JSON.parse(readFileSync(join(dir!, "results.json"), "utf8")) as { meta: { model: string }; results: unknown[] };
    expect(json.meta.model).toBe("scripted");
    expect(json.results).toHaveLength(2);
    expect(log.some((l) => /pass frontmatter-edit \[full\] #1/.test(l))).toBe(true);
  });

  it("refuses an unknown task id", async () => {
    await expect(bench({ profiles: ["full"], runs: 1, tasks: ["nope"], model: "scripted", effort: "high", maxTurns: 20, out, dry: true, log: () => {} }))
      .rejects.toThrow(/unknown task\(s\): nope/);
    expect(existsSync(join(out, "nope"))).toBe(false);
  });
});
