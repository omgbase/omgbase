#!/usr/bin/env node
// pnpm bench [--profiles full,minimal,fs] [--runs 3] [--tasks a,b] [--model <id>]
//            [--effort high] [--max-turns 20] [--out results] [--embedder <cmd|url>] [--dry]
//
// Every (task, profile, run) cell: a fresh workspace from the task's corpus
// (alchemy or timeline), one tool server under the profile — `omg mcp` for
// `full`/`minimal`, the in-process filesystem baseline for `fs` — the agent loop,
// the checks, a JSONL transcript. The checks always run through omgbase: under `fs`
// the workspace is swept (`omg sync`) and a `full` server spawned for them, so every
// profile is judged by the same oracle.
// Writes results/<timestamp>/{report.md,results.json,transcripts/*.jsonl}.
//
// A task that `requires` a capability the profile lacks (`semantic` without
// `--embedder`, under an omgbase profile) is SKIPPED: one row per cell with
// `skipped: "needs --embedder"`, neither passed nor failed, and a one-line
// transcript. With `--embedder <cmd|url>` the workspace of such a task is built
// with `omg init --embedder <cmd>` and drained (`omg embed drain`) before the loop.
//
// --dry: no model. Each task's scripted solution for the profile (`solution`, or
// `solution_fs` under `fs`) is replayed through the same loop (so the hook fires
// too) against a fresh workspace and its checks must pass; then the checks run
// against an untouched workspace and must FAIL (unless the task says
// `trivial_on_fresh`), proving each check discriminates.
//
// The very first model request of a bench is its credential probe: when it fails
// with an authentication/credential error (no AWS credentials, an expired SSO
// token, a rejected API key) the whole bench aborts with that one message and
// exit 1 instead of writing one FAIL per cell. A later failure is the run's own.
import { parseArgs } from "node:util";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, DEFAULT_MAX_TURNS, systemPromptFor } from "./agent.ts";
import { runChecks } from "./checks.ts";
import { FsServer } from "./fs-server.ts";
import { OmgServer } from "./mcp.ts";
import { ClaudeModel, DEFAULT_MODEL, ScriptedModel, isCredentialError, modelIdFor, resolveProvider, type Model, type ModelRequest, type Provider } from "./model.ts";
import { fmtDollars, runCost } from "./pricing.ts";
import { renderReport, type ReportMeta } from "./report.ts";
import type { ToolServer } from "./server.ts";
import { loadTasks } from "./tasks.ts";
import { isFsProfile, type Profile, type RunMetrics, type Solution, type Task, type TranscriptEvent } from "./types.ts";
import { createWorkspace, embedWorkspace, syncWorkspace, DEFAULT_CORPUS, PACKAGE_ROOT, type Workspace } from "./workspace.ts";

export interface BenchOptions {
  profiles: Profile[];
  runs: number;
  tasks?: string[];
  model: string;
  provider: Provider;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  out: string;
  dry: boolean;
  /** an embedding provider (`omg init --embedder <cmd|url>`) for the tasks that `requires: ["semantic"]`; without it they are skipped under the omgbase profiles */
  embedder?: string;
  /** build the model (tests inject a scripted one) */
  makeModel?: (task: Task) => Model;
  log?: (line: string) => void;
}

export const USAGE = `usage: pnpm bench [--profiles full,minimal,fs] [--runs 3] [--tasks id,id] [--model ${DEFAULT_MODEL}]
                  [--provider anthropic|bedrock] [--effort low|medium|high|xhigh|max] [--max-turns ${DEFAULT_MAX_TURNS}]
                  [--out results] [--embedder <cmd|url>] [--dry]
  --profiles  omgbase catalog profiles (full, minimal — \`omg mcp --tools\`) and/or fs, the filesystem baseline:
          generic file tools over the same vault, no omgbase; default full,minimal
  --provider  anthropic (ANTHROPIC_API_KEY) or bedrock (the AWS credential chain: AWS_PROFILE/SSO, AWS_REGION);
          default bedrock when CLAUDE_CODE_USE_BEDROCK is set and no ANTHROPIC_API_KEY is, else anthropic
          (AGENT_BENCH_PROVIDER overrides). On bedrock a bare model id maps to global.anthropic.<id>
  --embedder  an embedding provider for the tasks that require semantic search (\`omgbase-embedder\`, or
          \`node ../../packages/embedder/dist/src/bin.js\`, or an http(s) URL): their workspaces are built
          with \`omg init --embedder\` and drained before the loop. Without it those tasks are reported as
          skipped under full/minimal (fs runs them with grep — that is the comparison)
  --dry   validate tasks and prove every check: replay each task's scripted solution against a
          fresh workspace (checks must pass), then run the checks on an untouched one (must fail)`;

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function parseBenchArgs(argv: string[], env: Record<string, string | undefined> = process.env): BenchOptions | { help: true } | { error: string } {
  let v: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values: v } = parseArgs({
      args: argv,
      options: {
        profiles: { type: "string", default: "full,minimal" },
        runs: { type: "string", default: "3" },
        tasks: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        effort: { type: "string", default: "high" },
        "max-turns": { type: "string", default: String(DEFAULT_MAX_TURNS) },
        out: { type: "string", default: join(PACKAGE_ROOT, "results") },
        embedder: { type: "string" },
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
  const provider = resolveProvider(v.provider as string | undefined, env);
  if (typeof provider !== "string") return provider;
  return {
    profiles,
    runs,
    ...(v.tasks ? { tasks: (v.tasks as string).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
    model: modelIdFor(provider, v.model as string | undefined),
    provider,
    effort: v.effort as BenchOptions["effort"],
    maxTurns,
    out: v.out as string,
    ...(v.embedder ? { embedder: v.embedder as string } : {}),
    dry: Boolean(v.dry),
  };
}

/**
 * Why a cell cannot run under a profile, or null when it can: a task that `requires`
 * `semantic` needs an embedding provider under an omgbase profile (`--embedder`);
 * the `fs` profile never needs one — grep IS its semantic search.
 */
export function skipReason(task: Task, profile: Profile, embedder: string | undefined): string | null {
  if (isFsProfile(profile)) return null;
  for (const r of task.requires ?? []) {
    if (r === "semantic" && !embedder) return "needs --embedder";
  }
  return null;
}

/** The workspace for a cell: the task's corpus; with the embedder (and drained) only when the task needs one under this profile. */
export function workspaceFor(task: Task, profile: Profile, embedder: string | undefined): Workspace {
  const needsEmbedder = embedder !== undefined && !isFsProfile(profile) && (task.requires ?? []).includes("semantic");
  const ws = createWorkspace({ corpus: task.corpus ?? DEFAULT_CORPUS, ...(needsEmbedder && embedder !== undefined ? { embedder } : {}) });
  if (needsEmbedder) {
    try {
      embedWorkspace(ws);
    } catch (e) {
      ws.cleanup();
      throw e;
    }
  }
  return ws;
}

/** Thrown through `runCell` when the bench's first model request fails on credentials; `bench` turns it into the one message. */
export class CredentialsAbort extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CredentialsAbort";
  }
}

/** What to try, per provider, when the first request is refused for credentials. */
export function credentialHint(provider: Provider): string {
  return provider === "bedrock"
    ? "check AWS_PROFILE / AWS_REGION and run `aws sso login` (the AWS credential chain could not sign the request)"
    : "check ANTHROPIC_API_KEY or run `ant auth login`";
}

/**
 * Wraps the models of one bench so its very first request is the credential probe:
 * a credential error there becomes a `CredentialsAbort`; any other error, and every
 * error after the first request, passes through untouched.
 */
export class FirstRequestGuard {
  private requests = 0;
  private readonly provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  wrap(model: Model): Model {
    const complete = async (req: ModelRequest) => {
      const first = this.requests === 0;
      this.requests += 1;
      try {
        return await model.complete(req);
      } catch (e) {
        if (first && isCredentialError(e)) {
          const message = e instanceof Error ? e.message : String(e);
          const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
          throw new CredentialsAbort(`the first model request failed on credentials — ${message}${cause}; ${credentialHint(this.provider)}`, e);
        }
        throw e;
      }
    };
    return { name: model.name, complete };
  }
}

/** The scripted oracle for a profile: `solution_fs` under `fs`, `solution` (the omgbase tools) otherwise. */
export function solutionFor(task: Task, profile: Profile): Solution {
  return isFsProfile(profile) ? task.solution_fs : task.solution;
}

/** The server the agent talks to: the filesystem baseline, or `omg mcp` under the catalog profile. */
export async function openAgentServer(workspace: Workspace, profile: Profile): Promise<ToolServer> {
  return isFsProfile(profile) ? new FsServer(workspace) : OmgServer.spawn({ workspace, profile });
}

/**
 * The omg server the checks run through. Under an omgbase profile it is the agent's
 * own server. Under `fs` the store has not seen the agent's disk writes (the agent
 * never went through omgbase and `--no-watch` sweeps nothing), so the workspace is
 * swept first — `omg sync`, spec/sync §4.3: new files ingested, edited files
 * re-ingested, vanished paths tombstoned — and a `full` server spawned over it.
 */
export async function openCheckServer(workspace: Workspace, profile: Profile, agent: ToolServer, onEvent?: (e: TranscriptEvent) => void): Promise<OmgServer> {
  if (!isFsProfile(profile)) return agent as OmgServer;
  const sweep = syncWorkspace(workspace);
  onEvent?.({ type: "sync", t: new Date().toISOString(), scanned: sweep.scanned, ingested: sweep.ingested, deleted: sweep.deleted, conflicted: sweep.conflicted });
  return OmgServer.spawn({ workspace, profile: "full" });
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

/** One cell: fresh workspace → server → loop → checks. Never throws — a failure is recorded in `error` — except a `CredentialsAbort`, which is the bench's to handle. */
export async function runCell(args: {
  task: Task;
  profile: Profile;
  run: number;
  model: Model;
  maxTurns: number;
  transcriptPath: string;
  transcriptRel: string;
  embedder?: string;
}): Promise<RunMetrics> {
  const { task, profile, run, model, maxTurns, transcriptPath, transcriptRel } = args;
  writeFileSync(transcriptPath, "");
  const onEvent = (e: TranscriptEvent) => appendFileSync(transcriptPath, JSON.stringify(e) + "\n");
  const base: RunMetrics = {
    task: task.id, corpus: task.corpus ?? DEFAULT_CORPUS, profile, run, model: model.name,
    turns: 0, tool_calls: 0, calls_by_tool: {}, failed_calls: 0, failed_by_code: {}, plan_calls: 0, execute_calls: 0, write_calls: 0,
    plan_before_write: null, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    wall_ms: 0, hit_turn_cap: false, hook_fired: false, passed: false, check_failures: [], final_text: "", transcript: transcriptRel,
  };
  const skip = skipReason(task, profile, args.embedder);
  if (skip !== null) {
    onEvent({ type: "skip", t: new Date().toISOString(), task: task.id, profile, run, reason: skip });
    return { ...base, skipped: skip };
  }
  let workspace: Workspace;
  try {
    workspace = workspaceFor(task, profile, args.embedder);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onEvent({ type: "error", t: new Date().toISOString(), message });
    return { ...base, error: message, check_failures: [`harness: ${message}`] };
  }
  let server: ToolServer | null = null;
  let checker: OmgServer | null = null;
  try {
    server = await openAgentServer(workspace, profile);
    const tools = await server.tools();
    const system = systemPromptFor(profile);
    onEvent({ type: "start", t: new Date().toISOString(), task: task.id, profile, run, model: model.name, system, prompt: task.prompt, tools: tools.map((t) => t.name) });
    const loop = await runAgent({ task, model, server, workspace, tools, system, maxTurns, onEvent });
    checker = await openCheckServer(workspace, profile, server, onEvent);
    const failures = await runChecks(task, { server: checker, finalText: loop.metrics.final_text, workspace });
    onEvent({ type: "check", t: new Date().toISOString(), passed: failures.length === 0, failures });
    const metrics: RunMetrics = { ...base, ...loop.metrics, passed: failures.length === 0, check_failures: failures };
    const cost = runCost(metrics);
    return cost === undefined ? metrics : { ...metrics, cost_usd: cost };
  } catch (e) {
    if (e instanceof CredentialsAbort) throw e;
    const message = e instanceof Error ? e.message : String(e);
    onEvent({ type: "error", t: new Date().toISOString(), message });
    return { ...base, error: message, check_failures: [`harness: ${message}`] };
  } finally {
    if (checker && checker !== server) await checker.close();
    await server?.close();
    workspace.cleanup();
  }
}

/** The dry run (see the file comment). Returns the problems found (empty = green). */
export async function dryRun(tasks: Task[], profiles: Profile[], log: (l: string) => void, embedder?: string): Promise<string[]> {
  const problems: string[] = [];
  for (const profile of profiles) {
    for (const task of tasks) {
      // positive: the profile's solution reaches the end state
      const skip = skipReason(task, profile, embedder);
      if (skip !== null) {
        log(`  skip ${task.id} [${profile}] solution (${skip})`);
      } else {
        const solution = solutionFor(task, profile);
        const workspace = workspaceFor(task, profile, embedder);
        const server = await openAgentServer(workspace, profile);
        let checker: OmgServer | null = null;
        try {
          const tools = await server.tools();
          const model = new ScriptedModel(solution);
          const events: TranscriptEvent[] = [];
          const loop = await runAgent({ task, model, server, workspace, tools, maxTurns: solution.steps.length + 1, onEvent: (e) => events.push(e) });
          // every step's outcome vs its expectation
          const results = events.filter((e): e is Extract<TranscriptEvent, { type: "tool_result" }> => e.type === "tool_result");
          solution.steps.forEach((step, i) => {
            const r = results[i];
            if (!r) return void problems.push(`${task.id} [${profile}]: solution step ${i} (${step.tool}) never ran`);
            if (step.expect_error) {
              if (r.ok || r.error_code !== step.expect_error) problems.push(`${task.id} [${profile}]: step ${i} (${step.tool}) expected error ${step.expect_error}, got ${r.ok ? "ok" : r.error_code}`);
            } else if (!r.ok) {
              problems.push(`${task.id} [${profile}]: step ${i} (${step.tool}) failed: ${JSON.stringify(r.result).slice(0, 300)}`);
            }
          });
          if (task.hook && !loop.metrics.hook_fired) problems.push(`${task.id} [${profile}]: the hook never fired`);
          checker = await openCheckServer(workspace, profile, server, (e) => events.push(e));
          const failures = await runChecks(task, { server: checker, finalText: loop.metrics.final_text, workspace });
          for (const f of failures) problems.push(`${task.id} [${profile}]: after the solution, check failed: ${f}`);
          const sync = events.find((e): e is Extract<TranscriptEvent, { type: "sync" }> => e.type === "sync");
          const swept = sync ? `, swept +${sync.ingested.length} -${sync.deleted.length}` : "";
          log(`  ${failures.length === 0 ? "ok  " : "FAIL"} ${task.id} [${profile}] solution: ${solution.steps.length} step(s), ${loop.metrics.failed_calls} expected failure(s)${swept}`);
        } finally {
          if (checker && checker !== server) await checker.close();
          await server.close();
          workspace.cleanup();
        }
      }
      // negative: the checks reject the untouched workspace (through omgbase, whatever the profile)
      if (!task.trivial_on_fresh) {
        const workspace = createWorkspace({ corpus: task.corpus ?? DEFAULT_CORPUS });
        const server = await OmgServer.spawn({ workspace, profile: isFsProfile(profile) ? "full" : profile });
        try {
          const failures = await runChecks(task, { server, finalText: "", workspace });
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
    log(`dry run: validating solutions and checks (no model${opts.embedder ? `; embedder ${opts.embedder}` : ""})`);
    const problems = await dryRun(tasks, opts.profiles, log, opts.embedder);
    return { dir: null, results: [], problems };
  }

  const started = new Date();
  const dir = join(opts.out, stamp(started));
  const fresh = !existsSync(dir);
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  const results: RunMetrics[] = [];
  const makeModel = opts.makeModel ?? (() => new ClaudeModel({ model: opts.model, provider: opts.provider, effort: opts.effort }));
  const guard = new FirstRequestGuard(opts.provider);
  let omgVersion: string | undefined;
  for (const task of tasks) {
    for (const profile of opts.profiles) {
      for (let run = 1; run <= opts.runs; run++) {
        const rel = join("transcripts", `${task.id}.${profile}.${run}.jsonl`);
        let metrics: RunMetrics;
        try {
          metrics = await runCell({ task, profile, run, model: guard.wrap(makeModel(task)), maxTurns: opts.maxTurns, transcriptPath: join(dir, rel), transcriptRel: rel, ...(opts.embedder ? { embedder: opts.embedder } : {}) });
        } catch (e) {
          if (!(e instanceof CredentialsAbort)) throw e;
          // nothing was measured: no report, no results — take the directory back if this bench made it
          if (fresh) rmSync(dir, { recursive: true, force: true });
          return { dir: null, results: [], problems: [`aborted: ${e.message}`] };
        }
        results.push(metrics);
        if (metrics.skipped) {
          log(`  skip ${task.id} [${profile}] #${run}: ${metrics.skipped}`);
        } else {
          const cost = metrics.cost_usd === undefined ? "" : `, ${fmtDollars(metrics.cost_usd)}`;
          log(`  ${metrics.passed ? "pass" : "FAIL"} ${task.id} [${profile}] #${run}: ${metrics.turns} turn(s), ${metrics.tool_calls} call(s), ${metrics.failed_calls} failed, ${metrics.input_tokens} uncached / ${metrics.cache_read_input_tokens + metrics.cache_creation_input_tokens} cached / ${metrics.output_tokens} out${cost}, ${(metrics.wall_ms / 1000).toFixed(1)} s${metrics.error ? ` — ${metrics.error}` : ""}`);
        }
        // keep the report current after every cell, so an interrupted run still has one
        if (omgVersion === undefined) omgVersion = await readOmgVersion();
        const meta: ReportMeta = { model: opts.model, provider: opts.provider, effort: opts.effort, started: started.toISOString(), finished: new Date().toISOString(), profiles: opts.profiles, runs: opts.runs, max_turns: opts.maxTurns, ...(omgVersion ? { omg_version: omgVersion } : {}), ...(opts.embedder ? { embedder: opts.embedder } : {}) };
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
  if (!parsed.dry && parsed.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
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
