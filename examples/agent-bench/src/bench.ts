#!/usr/bin/env node
// pnpm bench [--profiles full,minimal] [--runs 3] [--tasks a,b] [--model <id>]
//            [--effort high] [--max-turns 20] [--out results] [--dry]
//
// Every (task, profile, run) cell: a fresh alchemy workspace, one `omg mcp`
// server under the profile, the agent loop, the checks, a JSONL transcript.
// Writes results/<timestamp>/{report.md,results.json,transcripts/*.jsonl}.
//
// --dry: no model. Each task's scripted solution is replayed through the same
// loop (so the hook fires too) against a fresh workspace and its checks must
// pass; then the checks run against an untouched workspace and must FAIL
// (unless the task says `trivial_on_fresh`), proving each check discriminates.
import { parseArgs } from "node:util";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, DEFAULT_MAX_TURNS, SYSTEM_PROMPT } from "./agent.ts";
import { runChecks } from "./checks.ts";
import { OmgServer } from "./mcp.ts";
import { ClaudeModel, DEFAULT_MODEL, ScriptedModel, type Model } from "./model.ts";
import { renderReport, type ReportMeta } from "./report.ts";
import { loadTasks } from "./tasks.ts";
import type { Profile, RunMetrics, Task, TranscriptEvent } from "./types.ts";
import { createWorkspace, PACKAGE_ROOT } from "./workspace.ts";

export interface BenchOptions {
  profiles: Profile[];
  runs: number;
  tasks?: string[];
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  out: string;
  dry: boolean;
  /** build the model (tests inject a scripted one) */
  makeModel?: (task: Task) => Model;
  log?: (line: string) => void;
}

export const USAGE = `usage: pnpm bench [--profiles full,minimal] [--runs 3] [--tasks id,id] [--model ${DEFAULT_MODEL}]
                  [--effort low|medium|high|xhigh|max] [--max-turns ${DEFAULT_MAX_TURNS}] [--out results] [--dry]
  --dry   validate tasks and prove every check: replay each task's scripted solution against a
          fresh workspace (checks must pass), then run the checks on an untouched one (must fail)`;

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function parseBenchArgs(argv: string[]): BenchOptions | { help: true } | { error: string } {
  let v: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values: v } = parseArgs({
      args: argv,
      options: {
        profiles: { type: "string", default: "full,minimal" },
        runs: { type: "string", default: "3" },
        tasks: { type: "string" },
        model: { type: "string", default: DEFAULT_MODEL },
        effort: { type: "string", default: "high" },
        "max-turns": { type: "string", default: String(DEFAULT_MAX_TURNS) },
        out: { type: "string", default: join(PACKAGE_ROOT, "results") },
        dry: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (v.help) return { help: true };
  const runs = Number(v.runs);
  const maxTurns = Number(v["max-turns"]);
  if (!Number.isInteger(runs) || runs < 1) return { error: "--runs must be a positive integer" };
  if (!Number.isInteger(maxTurns) || maxTurns < 1) return { error: "--max-turns must be a positive integer" };
  if (!EFFORTS.has(v.effort as string)) return { error: `--effort must be one of ${[...EFFORTS].join("|")}` };
  const profiles = (v.profiles as string).split(",").map((s) => s.trim()).filter(Boolean);
  if (profiles.length === 0) return { error: "--profiles must name at least one profile" };
  return {
    profiles,
    runs,
    ...(v.tasks ? { tasks: (v.tasks as string).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    model: v.model as string,
    effort: v.effort as BenchOptions["effort"],
    maxTurns,
    out: v.out as string,
    dry: Boolean(v.dry),
  };
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

function selectTasks(all: Task[], ids: string[] | undefined): Task[] {
  if (!ids) return all;
  const byId = new Map(all.map((t) => [t.id, t]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`unknown task(s): ${missing.join(", ")} (have ${all.map((t) => t.id).join(", ")})`);
  return ids.map((id) => byId.get(id)!);
}

/** One cell: fresh workspace → server → loop → checks. Never throws; a failure is recorded in `error`. */
export async function runCell(args: {
  task: Task;
  profile: Profile;
  run: number;
  model: Model;
  maxTurns: number;
  transcriptPath: string;
  transcriptRel: string;
}): Promise<RunMetrics> {
  const { task, profile, run, model, maxTurns, transcriptPath, transcriptRel } = args;
  writeFileSync(transcriptPath, "");
  const onEvent = (e: TranscriptEvent) => appendFileSync(transcriptPath, JSON.stringify(e) + "\n");
  const base: RunMetrics = {
    task: task.id, profile, run, model: model.name,
    turns: 0, tool_calls: 0, calls_by_tool: {}, failed_calls: 0, failed_by_code: {}, plan_calls: 0, execute_calls: 0, write_calls: 0,
    plan_before_write: null, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    wall_ms: 0, hit_turn_cap: false, hook_fired: false, passed: false, check_failures: [], final_text: "", transcript: transcriptRel,
  };
  const workspace = createWorkspace();
  let server: OmgServer | null = null;
  try {
    server = await OmgServer.spawn({ workspace, profile });
    const tools = await server.tools();
    onEvent({ type: "start", t: new Date().toISOString(), task: task.id, profile, run, model: model.name, system: SYSTEM_PROMPT, prompt: task.prompt, tools: tools.map((t) => t.name) });
    const loop = await runAgent({ task, model, server, workspace, tools, maxTurns, onEvent });
    const failures = await runChecks(task, { server, finalText: loop.metrics.final_text });
    onEvent({ type: "check", t: new Date().toISOString(), passed: failures.length === 0, failures });
    return { ...base, ...loop.metrics, passed: failures.length === 0, check_failures: failures };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onEvent({ type: "error", t: new Date().toISOString(), message });
    return { ...base, error: message, check_failures: [`harness: ${message}`] };
  } finally {
    await server?.close();
    workspace.cleanup();
  }
}

/** The dry run (see the file comment). Returns the problems found (empty = green). */
export async function dryRun(tasks: Task[], profiles: Profile[], log: (l: string) => void): Promise<string[]> {
  const problems: string[] = [];
  for (const profile of profiles) {
    for (const task of tasks) {
      // positive: the solution reaches the end state
      {
        const workspace = createWorkspace();
        const server = await OmgServer.spawn({ workspace, profile });
        try {
          const tools = await server.tools();
          const model = new ScriptedModel(task.solution);
          const events: TranscriptEvent[] = [];
          const loop = await runAgent({ task, model, server, workspace, tools, maxTurns: task.solution.steps.length + 1, onEvent: (e) => events.push(e) });
          // every step's outcome vs its expectation
          const results = events.filter((e): e is Extract<TranscriptEvent, { type: "tool_result" }> => e.type === "tool_result");
          task.solution.steps.forEach((step, i) => {
            const r = results[i];
            if (!r) return void problems.push(`${task.id} [${profile}]: solution step ${i} (${step.tool}) never ran`);
            if (step.expect_error) {
              if (r.ok || r.error_code !== step.expect_error) problems.push(`${task.id} [${profile}]: step ${i} (${step.tool}) expected error ${step.expect_error}, got ${r.ok ? "ok" : r.error_code}`);
            } else if (!r.ok) {
              problems.push(`${task.id} [${profile}]: step ${i} (${step.tool}) failed: ${JSON.stringify(r.result).slice(0, 300)}`);
            }
          });
          if (task.hook && !loop.metrics.hook_fired) problems.push(`${task.id} [${profile}]: the hook never fired`);
          const failures = await runChecks(task, { server, finalText: loop.metrics.final_text });
          for (const f of failures) problems.push(`${task.id} [${profile}]: after the solution, check failed: ${f}`);
          log(`  ${failures.length === 0 ? "ok  " : "FAIL"} ${task.id} [${profile}] solution: ${task.solution.steps.length} step(s), ${loop.metrics.failed_calls} expected failure(s)`);
        } finally {
          await server.close();
          workspace.cleanup();
        }
      }
      // negative: the checks reject the untouched workspace
      if (!task.trivial_on_fresh) {
        const workspace = createWorkspace();
        const server = await OmgServer.spawn({ workspace, profile });
        try {
          const failures = await runChecks(task, { server, finalText: "" });
          if (failures.length === 0) problems.push(`${task.id} [${profile}]: the checks pass on an untouched workspace — they do not discriminate`);
          log(`  ${failures.length > 0 ? "ok  " : "FAIL"} ${task.id} [${profile}] negative control: ${failures.length} failing check(s) on a fresh workspace`);
        } finally {
          await server.close();
          workspace.cleanup();
        }
      } else {
        log(`  skip ${task.id} [${profile}] negative control (trivial_on_fresh)`);
      }
    }
  }
  return problems;
}

export async function bench(opts: BenchOptions): Promise<{ dir: string | null; results: RunMetrics[]; problems: string[] }> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const loaded = loadTasks();
  if (loaded.problems.length > 0) return { dir: null, results: [], problems: loaded.problems.map((p) => `task file: ${p}`) };
  const tasks = selectTasks(loaded.tasks, opts.tasks);
  log(`${tasks.length} task(s), profiles ${opts.profiles.join(", ")}`);

  if (opts.dry) {
    log("dry run: validating solutions and checks (no model)");
    const problems = await dryRun(tasks, opts.profiles, log);
    return { dir: null, results: [], problems };
  }

  const started = new Date();
  const dir = join(opts.out, stamp(started));
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const results: RunMetrics[] = [];
  const makeModel = opts.makeModel ?? (() => new ClaudeModel({ model: opts.model, effort: opts.effort }));
  let omgVersion: string | undefined;
  for (const task of tasks) {
    for (const profile of opts.profiles) {
      for (let run = 1; run <= opts.runs; run++) {
        const rel = join("transcripts", `${task.id}.${profile}.${run}.jsonl`);
        const metrics = await runCell({ task, profile, run, model: makeModel(task), maxTurns: opts.maxTurns, transcriptPath: join(dir, rel), transcriptRel: rel });
        results.push(metrics);
        log(`  ${metrics.passed ? "pass" : "FAIL"} ${task.id} [${profile}] #${run}: ${metrics.turns} turn(s), ${metrics.tool_calls} call(s), ${metrics.failed_calls} failed, ${metrics.input_tokens + metrics.cache_read_input_tokens + metrics.cache_creation_input_tokens} in / ${metrics.output_tokens} out, ${(metrics.wall_ms / 1000).toFixed(1)} s${metrics.error ? ` — ${metrics.error}` : ""}`);
        // keep the report current after every cell, so an interrupted run still has one
        if (omgVersion === undefined) omgVersion = await readOmgVersion();
        const meta: ReportMeta = { model: opts.model, effort: opts.effort, started: started.toISOString(), finished: new Date().toISOString(), profiles: opts.profiles, runs: opts.runs, max_turns: opts.maxTurns, ...(omgVersion ? { omg_version: omgVersion } : {}) };
        writeFileSync(join(dir, "results.json"), JSON.stringify({ meta, results }, null, 2) + "\n");
        writeFileSync(join(dir, "report.md"), renderReport(results, meta));
      }
    }
  }
  log(`report: ${join(dir, "report.md")}`);
  return { dir, results, problems: [] };
}

async function readOmgVersion(): Promise<string | undefined> {
  const workspace = createWorkspace();
  let server: OmgServer | null = null;
  try {
    server = await OmgServer.spawn({ workspace, profile: "full" });
    const r = await server.call("version", {});
    if (!r.ok) return undefined;
    const v = r.result as { engine: string; version: string; commit: string | null; specs: { surface: string } };
    return `${v.engine} ${v.version} (commit ${v.commit ?? "unknown"}, surface ${v.specs.surface})`;
  } catch {
    return undefined;
  } finally {
    await server?.close();
    workspace.cleanup();
  }
}

async function main(): Promise<void> {
  const parsed = parseBenchArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (!parsed.dry && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("note: ANTHROPIC_API_KEY is not set — the SDK will fall back to an `ant auth login` profile if one exists");
  }
  const { problems } = await bench(parsed);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ! ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (parsed.dry) console.error("\ndry run green: every solution reaches its end state and every check discriminates");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
