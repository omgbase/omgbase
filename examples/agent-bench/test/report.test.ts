import { describe, expect, it } from "vitest";
import { cellStats, renderReport } from "../src/report.ts";
import type { RunMetrics } from "../src/types.ts";

function run(over: Partial<RunMetrics>): RunMetrics {
  return {
    task: "t", profile: "full", run: 1, model: "m",
    turns: 3, tool_calls: 2, calls_by_tool: { query: 1, apply: 1 }, failed_calls: 0, failed_by_code: {}, plan_calls: 0, execute_calls: 0, write_calls: 1,
    plan_before_write: false, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0,
    wall_ms: 4000, hit_turn_cap: false, hook_fired: false, passed: true, check_failures: [], final_text: "ok", transcript: "transcripts/t.full.1.jsonl",
    ...over,
  };
}

const META = { model: "claude-opus-5", effort: "high", started: "2026-10-13T00:00:00.000Z", finished: "2026-10-13T00:10:00.000Z", profiles: ["full", "minimal"], runs: 2, max_turns: 20, omg_version: "typescript 0.14.0" };

describe("cellStats", () => {
  it("averages a cell and rates plans over the runs that wrote", () => {
    const s = cellStats([
      run({ passed: true, turns: 2, tool_calls: 1, plan_before_write: true }),
      run({ passed: false, turns: 4, tool_calls: 3, failed_calls: 2, plan_before_write: false, hit_turn_cap: true }),
      run({ passed: true, turns: 3, tool_calls: 2, plan_before_write: null }),
    ]);
    expect(s).toMatchObject({ n: 3, passed: 2, turns: 3, calls: 2, failed: 2 / 3, plan_before_write: 0.5, turn_caps: 1, errors: 0 });
    expect(s.pass_rate).toBeCloseTo(2 / 3);
    expect(s.input_tokens).toBe(21000);
    expect(cellStats([]).plan_before_write).toBeNull();
  });
});

describe("renderReport", () => {
  const results = [
    run({ task: "a", profile: "full", run: 1, passed: true }),
    run({ task: "a", profile: "full", run: 2, passed: false, check_failures: ["hit 0.verified = false ≠ true | x"], failed_calls: 1, failed_by_code: { filter_invalid: 1 } }),
    run({ task: "a", profile: "minimal", run: 1, passed: true, plan_calls: 1, plan_before_write: true, calls_by_tool: { plan: 1, execute: 1 } }),
    run({ task: "a", profile: "minimal", run: 2, passed: true, plan_before_write: true, calls_by_tool: { plan: 1, execute: 1 } }),
    run({ task: "b", profile: "full", run: 1, error: "boom", passed: false, check_failures: ["harness: boom"], transcript: "transcripts/b.full.1.jsonl" }),
  ];
  const md = renderReport(results, META);

  it("has the header, the task × profile table, the totals and the run list", () => {
    expect(md).toMatch(/^# agent-bench report/);
    expect(md).toContain("- model: `claude-opus-5` (effort high)");
    expect(md).toContain("| a | `full` | 1/2 (50%) | 3.0 | 2.0 | 0.5 | 21.0k / 100 | 4.0 | 0% |");
    expect(md).toContain("| a | `minimal` | 2/2 (100%) | 3.0 | 2.0 | 0.0 | 21.0k / 100 | 4.0 | 100% |");
    expect(md).toContain("| all | `full` | 1/3 (33%) |");
    expect(md).toContain("| all | `minimal` | 2/2 (100%) |");
    expect(md).toContain("Failed calls by code: `filter_invalid` 1");
    expect(md).toContain("Tool calls: `execute` 2, `plan` 2");
    expect(md).toContain("Harness/API errors in 1 run(s): b#1 — boom");
    expect(md).toContain("| a | `full` | 2 | FAIL | 3 | 2 | 1 | hit 0.verified = false ≠ true \\| x | [transcripts/t.full.1.jsonl](transcripts/t.full.1.jsonl) |");
    expect(md).toContain("[transcripts/b.full.1.jsonl](transcripts/b.full.1.jsonl)");
  });

  it("renders an empty result set without throwing", () => {
    expect(renderReport([], META)).toContain("- tasks: 0 · runs: 0");
  });
});
