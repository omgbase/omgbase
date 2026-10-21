import { describe, expect, it } from "vitest";
import { cellStats, describeProfiles, renderReport } from "../src/report.ts";
import type { RunMetrics } from "../src/types.ts";

function run(over: Partial<RunMetrics>): RunMetrics {
  return {
    task: "t", corpus: "alchemy", profile: "full", run: 1, model: "m",
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
    expect(s).toMatchObject({ input_tokens: 21000, uncached_tokens: 1000, cached_tokens: 20000, cache_read: 20000, cache_write: 0, output_tokens: 100 });
    expect(s.cost).toBeNull(); // model "m" is not priced
    expect(cellStats([]).plan_before_write).toBeNull();
    expect(cellStats([]).cost).toBeNull();
  });

  it("prices a cell from each run's model, splitting reads from writes, and refuses a partial mean", () => {
    const priced = run({ model: "global.anthropic.claude-opus-5", input_tokens: 28_314, cache_read_input_tokens: 5_690, cache_creation_input_tokens: 1_000, output_tokens: 632 });
    const s = cellStats([priced, priced]);
    expect(s).toMatchObject({ uncached_tokens: 28_314, cached_tokens: 6_690, cache_read: 5_690, cache_write: 1_000 });
    expect(s.cost).toBeCloseTo((28_314 * 5 + 5_690 * 0.5 + 1_000 * 6.25 + 632 * 25) / 1e6, 9);
    expect(cellStats([priced, run({ model: "scripted" })]).cost).toBeNull();
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
    expect(md).toContain("| task | corpus | profile | pass | turns | calls | failed | uncached / cached / out | $ / run | wall s | plan→write |");
    expect(md).toContain("| a | alchemy | `full` | 1/2 (50%) | 3.0 | 2.0 | 0.5 | 1000 / 20.0k / 100 |  | 4.0 | 0% |");
    expect(md).toContain("| a | alchemy | `minimal` | 2/2 (100%) | 3.0 | 2.0 | 0.0 | 1000 / 20.0k / 100 |  | 4.0 | 100% |");
    expect(md).toContain("| all | alchemy | `full` | 1/3 (33%) |");
    expect(md).toContain("| all | alchemy | `minimal` | 2/2 (100%) |");
    expect(md).toContain("- tasks: 2 · corpora: `alchemy` · runs: 5\n");
    expect(md).not.toContain("- cost:"); // an unpriced model prints no cost anywhere
    expect(md).toContain("Failed calls by code: `filter_invalid` 1");
    expect(md).toContain("Tool calls: `execute` 2, `plan` 2");
    expect(md).toContain("Harness/API errors in 1 run(s): b#1 — boom");
    expect(md).toContain("| a | `full` | 2 | FAIL | 3 | 2 | 1 | hit 0.verified = false ≠ true \\| x | [transcripts/t.full.1.jsonl](transcripts/t.full.1.jsonl) |");
    expect(md).toContain("[transcripts/b.full.1.jsonl](transcripts/b.full.1.jsonl)");
  });

  it("prices every row and the header when the model is in the table — at list price, however the model was addressed", () => {
    const opus = { model: "global.anthropic.claude-opus-5", input_tokens: 28_314, cache_read_input_tokens: 5_690, cache_creation_input_tokens: 0, output_tokens: 632 };
    const priced = renderReport([
      run({ ...opus, task: "a", profile: "full", run: 1 }),
      run({ ...opus, task: "a", profile: "full", run: 2 }),
      run({ ...opus, task: "a", profile: "minimal", run: 1, input_tokens: 1_000, cache_read_input_tokens: 90_000 }),
    ], { ...META, model: "global.anthropic.claude-opus-5", provider: "bedrock", profiles: ["full", "minimal"] });
    expect(priced).toContain("- model: `global.anthropic.claude-opus-5` via bedrock (effort high)");
    // 2 × $0.160215 + $0.065800
    expect(priced).toContain("- cost: $0.386 for 3 run(s) at Anthropic list price (`src/pricing.ts`)");
    expect(priced).toContain("| a | alchemy | `full` | 2/2 (100%) | 3.0 | 2.0 | 0.0 | 28.3k / 5690 / 632 | $0.160 | 4.0 | 0% |");
    expect(priced).toContain("| a | alchemy | `minimal` | 1/1 (100%) | 3.0 | 2.0 | 0.0 | 1000 / 90.0k / 632 | $0.066 | 4.0 | 0% |");
    expect(priced).toContain("| all | alchemy | `full` | 2/2 (100%) | 3.0 | 2.0 | 0.0 | 28.3k / 5690 / 632 | $0.160 | 4.0 | 0% |");
  });

  it("names the omgbase profiles and the filesystem baseline apart; plan→write is — under fs", () => {
    expect(describeProfiles(["full", "minimal", "fs"])).toBe("`full`, `minimal` (omgbase MCP), `fs` (filesystem baseline, no omgbase)");
    expect(describeProfiles(["full", "minimal"])).toBe("`full`, `minimal` (omgbase MCP)");
    expect(describeProfiles(["fs"])).toBe("`fs` (filesystem baseline, no omgbase)");
    const three = renderReport([
      ...results,
      run({ task: "a", profile: "fs", run: 1, passed: true, plan_before_write: false, calls_by_tool: { read_file: 2, edit_file: 1 } }),
    ], { ...META, profiles: ["full", "minimal", "fs"] });
    expect(three).toContain("- profiles: `full`, `minimal` (omgbase MCP), `fs` (filesystem baseline, no omgbase) · runs per cell: 2 · turn cap: 20");
    expect(three).toContain("| a | alchemy | `fs` | 1/1 (100%) | 3.0 | 2.0 | 0.0 | 1000 / 20.0k / 100 |  | 4.0 | — |");
    expect(three).toContain("| all | alchemy | `fs` | 1/1 (100%) |");
    expect(three).toContain("## `fs` (filesystem baseline)\n\nFailed calls by code: none\n\nTool calls: `read_file` 2, `edit_file` 1");
    expect(three).toContain("## `full` (omgbase)");
    expect(md).toContain("| a | alchemy | `full` | 1/2 (50%) | 3.0 | 2.0 | 0.5 | 1000 / 20.0k / 100 |  | 4.0 | 0% |"); // unchanged for omgbase
  });

  it("a skipped cell: `skipped (<reason>)` in the pass column, `skip` in the run list, out of every mean and total; per-corpus totals when the run spans two corpora", () => {
    const rows = [
      run({ task: "semantic-find", profile: "full", run: 1, skipped: "needs --embedder", passed: false, turns: 0, tool_calls: 0, calls_by_tool: {}, input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, wall_ms: 0, plan_before_write: null, final_text: "", transcript: "transcripts/semantic-find.full.1.jsonl" }),
      run({ task: "semantic-find", profile: "fs", run: 1, passed: true, calls_by_tool: { grep: 1, read_file: 1 }, transcript: "transcripts/semantic-find.fs.1.jsonl" }),
      run({ task: "timeline-follow", corpus: "timeline", profile: "full", run: 1, passed: true, turns: 4, tool_calls: 2, calls_by_tool: { query: 2 }, write_calls: 0, plan_before_write: null }),
      run({ task: "timeline-follow", corpus: "timeline", profile: "fs", run: 1, passed: false, check_failures: ["answer does not mention \"Aurora closeout\""], turns: 5, tool_calls: 3, calls_by_tool: { grep: 3 }, write_calls: 0, plan_before_write: null }),
    ];
    const md = renderReport(rows, { ...META, profiles: ["full", "fs"] });
    expect(md).toContain("- tasks: 2 · corpora: `alchemy`, `timeline` · runs: 4 (1 skipped)");
    expect(md).toContain("- embedder: none (tasks that require semantic search are skipped under the omgbase profiles)");
    expect(md).toContain("| semantic-find | alchemy | `full` | skipped (needs --embedder) | — | — | — | — | — | — | — |");
    expect(md).toContain("| semantic-find | alchemy | `fs` | 1/1 (100%) | 3.0 | 2.0 | 0.0 | 1000 / 20.0k / 100 |  | 4.0 | — |");
    expect(md).toContain("| timeline-follow | timeline | `full` | 1/1 (100%) | 4.0 | 2.0 | 0.0 |");
    // totals: the skipped run is not a run of `full`; per corpus, then all
    expect(md).toContain("| | corpus | profile | pass |");
    expect(md).toContain("| all | timeline | `full` | 1/1 (100%) | 4.0 | 2.0 |");
    expect(md).toContain("| all | all | `full` | 1/1 (100%) | 4.0 | 2.0 |");
    expect(md).toContain("| all | alchemy | `fs` | 1/1 (100%) |");
    expect(md).toContain("| all | timeline | `fs` | 0/1 (0%) |");
    expect(md).toContain("| all | all | `fs` | 1/2 (50%) |");
    expect(md).not.toContain("| all | alchemy | `full` |");
    expect(md).toContain("## `full` (omgbase)\n\nFailed calls by code: none\n\nTool calls: `query` 2\n\nSkipped 1 run(s): semantic-find (needs --embedder)");
    expect(md).toContain("| semantic-find | `full` | 1 | skip | 0 | 0 | 0 | needs --embedder | [transcripts/semantic-find.full.1.jsonl](transcripts/semantic-find.full.1.jsonl) |");
    expect(md).toContain("| timeline-follow | `fs` | 1 | FAIL | 5 | 3 | 0 | answer does not mention \"Aurora closeout\" |");
    const withEmbedder = renderReport(rows.slice(1), { ...META, profiles: ["full", "fs"], embedder: "omgbase-embedder" });
    expect(withEmbedder).toContain("- embedder: `omgbase-embedder`");
    expect(withEmbedder).not.toContain("skipped (");
    expect(withEmbedder).not.toContain("Skipped ");
  });

  it("renders an empty result set without throwing", () => {
    expect(renderReport([], META)).toContain("- tasks: 0 · corpora: — · runs: 0");
  });
});
