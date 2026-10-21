// `pnpm bench` end to end with the scripted model standing in for Claude: the
// results directory, the report, results.json and one transcript per cell.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { bench, parseBenchArgs } from "../src/bench.ts";
import { ScriptedModel, type Model } from "../src/model.ts";
import type { Task } from "../src/types.ts";

const out = mkdtempSync(join(tmpdir(), "agent-bench-results-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** A model whose every request fails the way the Bedrock SDK fails without AWS credentials. */
function noCredentials(): Model {
  const sso = new Error("Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.");
  return {
    name: "global.anthropic.claude-opus-5",
    complete: () => Promise.reject(new Anthropic.APIConnectionError({ message: "Failed to resolve AWS credentials from the credential provider chain.", cause: sso })),
  };
}

const BASE = { profiles: ["full"], runs: 1, tasks: ["frontmatter-edit", "noop"], model: "scripted", provider: "anthropic" as const, effort: "high" as const, maxTurns: 20, out, dry: false, log: () => {} };

describe("parseBenchArgs", () => {
  it("defaults to both profiles, 3 runs, the recommended model, high effort, 20 turns", () => {
    const o = parseBenchArgs([], {});
    expect(o).toMatchObject({ profiles: ["full", "minimal"], runs: 3, model: "claude-opus-5", provider: "anthropic", effort: "high", maxTurns: 20, dry: false });
    expect("tasks" in o).toBe(false);
  });

  it("picks Bedrock from a Claude Code Bedrock shell, or by flag, and maps the model id", () => {
    expect(parseBenchArgs([], { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work" })).toMatchObject({ provider: "bedrock", model: "global.anthropic.claude-opus-5" });
    expect(parseBenchArgs([], { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
    expect(parseBenchArgs(["--provider", "bedrock", "--model", "claude-sonnet-5"], {})).toMatchObject({ provider: "bedrock", model: "global.anthropic.claude-sonnet-5" });
    expect(parseBenchArgs(["--provider", "bedrock", "--model", "eu.anthropic.claude-opus-5"], {})).toMatchObject({ model: "eu.anthropic.claude-opus-5" });
    expect(parseBenchArgs([], { AGENT_BENCH_PROVIDER: "bedrock", ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ provider: "bedrock" });
    expect(parseBenchArgs(["--provider", "azure"], {})).toMatchObject({ error: expect.stringMatching(/--provider/) });
  });

  it("parses every flag and refuses bad values", () => {
    expect(parseBenchArgs(["--profiles", "minimal", "--runs", "1", "--tasks", "noop,rollup", "--model", "claude-sonnet-5", "--effort", "low", "--max-turns", "5", "--out", "/tmp/x", "--dry"], {}))
      .toMatchObject({ profiles: ["minimal"], runs: 1, tasks: ["noop", "rollup"], model: "claude-sonnet-5", effort: "low", maxTurns: 5, out: "/tmp/x", dry: true });
    expect(parseBenchArgs(["--profiles", "full,minimal,fs"], {})).toMatchObject({ profiles: ["full", "minimal", "fs"] });
    expect(parseBenchArgs(["--embedder", "omgbase-embedder"], {})).toMatchObject({ embedder: "omgbase-embedder" });
    expect("embedder" in parseBenchArgs([], {})).toBe(false);
    expect(parseBenchArgs(["--runs", "0"], {})).toEqual({ error: "--runs must be a positive integer" });
    expect(parseBenchArgs(["--effort", "huge"], {})).toMatchObject({ error: expect.stringMatching(/--effort/) });
    expect(parseBenchArgs(["--bogus"], {})).toMatchObject({ error: expect.stringMatching(/bogus/) });
    expect(parseBenchArgs(["--help"], {})).toEqual({ help: true });
  });
});

describe("bench", () => {
  it("runs the cells with an injected model and writes report.md, results.json and the transcripts", async () => {
    const log: string[] = [];
    const { dir, results, problems } = await bench({
      profiles: ["full"], runs: 1, tasks: ["frontmatter-edit", "noop"], model: "scripted", provider: "anthropic", effort: "high", maxTurns: 20, out, dry: false,
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
    expect(report).toContain("| frontmatter-edit | alchemy | `full` | 1/1 (100%) |");
    expect(report).toContain("| noop | alchemy | `full` | 1/1 (100%) |");
    expect(report).toContain("- embedder: none (tasks that require semantic search are skipped under the omgbase profiles)");
    const json = JSON.parse(readFileSync(join(dir!, "results.json"), "utf8")) as { meta: { model: string }; results: { cost_usd?: number }[] };
    expect(json.meta.model).toBe("scripted");
    expect(json.results).toHaveLength(2);
    expect(json.results[0]).toMatchObject({ corpus: "alchemy" });
    expect(json.results[0]).not.toHaveProperty("cost_usd"); // the scripted model is not priced
    expect(log.some((l) => /pass frontmatter-edit \[full\] #1: 2 turn\(s\), 1 call\(s\), 0 failed, 0 uncached \/ 0 cached \/ 0 out, /.test(l))).toBe(true);
  });

  it("an fs cell: the filesystem tools for the agent, a sweep and an omgbase server for the checks, the baseline named in the report", async () => {
    const own = mkdtempSync(join(tmpdir(), "agent-bench-fs-"));
    const { dir, results, problems } = await bench({
      ...BASE, out: own, profiles: ["fs"], tasks: ["doc-move", "noop"],
      makeModel: (task) => new ScriptedModel(task.solution_fs),
    });
    expect(problems).toEqual([]);
    expect(results.map((r) => [r.task, r.profile, r.passed, r.write_calls, r.plan_before_write])).toEqual([["doc-move", "fs", true, 3, false], ["noop", "fs", true, 0, null]]);
    expect(results[0]!.calls_by_tool).toEqual({ grep: 1, move_file: 1, edit_file: 2 });
    const lines = readFileSync(join(dir!, "transcripts", "doc-move.fs.1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type)).toEqual(["start", "assistant", "tool_call", "tool_result", "assistant", "tool_call", "tool_result", "assistant", "tool_call", "tool_result", "assistant", "tool_call", "tool_result", "assistant", "end", "sync", "check"]);
    expect(lines[0]).toMatchObject({ profile: "fs", tools: ["list_files", "read_file", "write_file", "edit_file", "grep", "move_file", "delete_file"], system: expect.stringMatching(/^You are managing a Markdown knowledge base/) });
    expect(lines.find((l) => l.type === "sync")).toMatchObject({ ingested: ["/index.md", "/practitioners/isaac-newton.md", "/texts/emerald-tablet.md"], deleted: ["/practitioners/newton.md"] });
    const report = readFileSync(join(dir!, "report.md"), "utf8");
    expect(report).toContain("- profiles: `fs` (filesystem baseline, no omgbase)");
    expect(report).toContain("| doc-move | alchemy | `fs` | 1/1 (100%) | 5.0 | 4.0 | 0.0 | 0 / 0 / 0 |  |");
    expect(report).toMatch(/\| doc-move \| alchemy \| `fs` \| .* \| — \|\n/);
    rmSync(own, { recursive: true, force: true });
  });

  it("a task that requires semantic search is skipped under an omgbase profile without --embedder, and runs under fs; a timeline task names its corpus", async () => {
    const own = mkdtempSync(join(tmpdir(), "agent-bench-skip-"));
    const { dir, results, problems } = await bench({
      ...BASE, out: own, profiles: ["full", "fs"], tasks: ["semantic-find", "range-era"],
      makeModel: (task) => new ScriptedModel(task.solution_fs), // under full the semantic cell never asks the model; range-era's fs script greps (refused by full) and still answers right
    });
    expect(problems).toEqual([]);
    expect(results.map((r) => [r.task, r.corpus, r.profile, r.skipped ?? null, r.passed])).toEqual([
      ["semantic-find", "alchemy", "full", "needs --embedder", false],
      ["semantic-find", "alchemy", "fs", null, true],
      ["range-era", "alchemy", "full", null, true],
      ["range-era", "alchemy", "fs", null, true],
    ]);
    expect(results[2]!.failed_by_code).toEqual({ unknown_tool: 1 });
    expect(results[0]).toMatchObject({ turns: 0, tool_calls: 0, final_text: "", check_failures: [] });
    const skip = readFileSync(join(dir!, "transcripts", "semantic-find.full.1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(skip).toEqual([expect.objectContaining({ type: "skip", task: "semantic-find", profile: "full", run: 1, reason: "needs --embedder" })]);
    const report = readFileSync(join(dir!, "report.md"), "utf8");
    expect(report).toContain("- tasks: 2 · corpora: `alchemy` · runs: 4 (1 skipped)");
    expect(report).toContain("| semantic-find | alchemy | `full` | skipped (needs --embedder) | — | — | — | — | — | — | — |");
    expect(report).toContain("| semantic-find | alchemy | `fs` | 1/1 (100%) |");
    expect(report).toContain("| semantic-find | `full` | 1 | skip | 0 | 0 | 0 | needs --embedder |");
    expect(report).toContain("Skipped 1 run(s): semantic-find (needs --embedder)");
    rmSync(own, { recursive: true, force: true });
  });

  it("aborts the whole bench with one message when the very first model request fails on credentials", async () => {
    const own = mkdtempSync(join(tmpdir(), "agent-bench-abort-")); // its own directory: the removal must not touch another bench's stamp
    const log: string[] = [];
    const { dir, results, problems } = await bench({ ...BASE, out: own, provider: "bedrock", makeModel: noCredentials, log: (l) => log.push(l) });
    expect(dir).toBeNull();
    expect(results).toEqual([]);
    expect(problems).toEqual([
      "aborted: the first model request failed on credentials — Failed to resolve AWS credentials from the credential provider chain. (Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.); check AWS_PROFILE / AWS_REGION and run `aws sso login` (the AWS credential chain could not sign the request)",
    ]);
    expect(log.some((l) => /FAIL/.test(l))).toBe(false);
    expect(readdirSync(own)).toEqual([]); // the empty results/<timestamp>/ was taken back
    rmSync(own, { recursive: true, force: true });
  });

  it("names the Anthropic credentials when the provider is the API", async () => {
    const unauthorized: Model = {
      name: "claude-opus-5",
      complete: () => Promise.reject(Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers())),
    };
    const { problems } = await bench({ ...BASE, makeModel: () => unauthorized });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^aborted: the first model request failed on credentials — 401 .*invalid x-api-key.*; check ANTHROPIC_API_KEY or run `ant auth login`$/);
  });

  it("a credential error after the first request, or any other first error, is that run's FAIL and the bench goes on", async () => {
    // cell 1 (frontmatter-edit) answers; cell 2 (noop) loses its credentials
    const later = await bench({ ...BASE, provider: "bedrock", makeModel: (task: Task) => (task.id === "noop" ? noCredentials() : new ScriptedModel(task.solution)) });
    expect(later.problems).toEqual([]);
    expect(later.dir).not.toBeNull();
    expect(later.results.map((r) => [r.task, r.passed, r.error])).toEqual([
      ["frontmatter-edit", true, undefined],
      ["noop", false, "Failed to resolve AWS credentials from the credential provider chain."],
    ]);
    const broken: Model = { name: "x", complete: () => Promise.reject(new Error("boom")) };
    const other = await bench({ ...BASE, tasks: ["noop"], makeModel: () => broken });
    expect(other.problems).toEqual([]);
    expect(other.results.map((r) => [r.passed, r.error, r.check_failures])).toEqual([[false, "boom", ["harness: boom"]]]);
  });

  it("refuses an unknown task id", async () => {
    await expect(bench({ profiles: ["full"], runs: 1, tasks: ["nope"], model: "scripted", provider: "anthropic", effort: "high", maxTurns: 20, out, dry: true, log: () => {} }))
      .rejects.toThrow(/unknown task\(s\): nope/);
    expect(existsSync(join(out, "nope"))).toBe(false);
  });
});
