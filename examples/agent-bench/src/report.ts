// results/<timestamp>/report.md from the run metrics: one table task × profile
// (corpus, pass rate, mean turns, mean calls, mean failed calls, mean tokens split by
// how they bill, mean cost at list price, mean wall time, plan-before-write rate), a
// per-profile totals table (per corpus when the run spans more than one), the
// failed-call codes and the tool-call histogram per profile, and the run list with
// its transcripts. A skipped cell (a task whose requirement the profile lacks) shows
// `skipped (<reason>)` in the pass column and counts in no mean. Pure: metrics in,
// Markdown out.
import { fmtDollars, runCost } from "./pricing.ts";
import { isFsProfile, type Profile, type RunMetrics } from "./types.ts";

export interface ReportMeta {
  model: string;
  /** anthropic | bedrock */
  provider?: string;
  started: string;
  finished: string;
  profiles: Profile[];
  runs: number;
  max_turns: number;
  effort?: string;
  omg_version?: string;
  /** the embedding provider the bench ran with (`--embedder`), when any */
  embedder?: string;
  /** true for a run whose retrieval prompts carried the `answer` block sentence (every run since the block check) — `pnpm bench rescore` scores an older run leniently */
  answer_block?: boolean;
  /** set on a `results.rescored.json`: how this report was derived from the stored one */
  rescore?: RescoreMeta;
}

export interface RescoreMeta {
  /** when the rescore ran */
  at: string;
  /** the results file it read */
  source: string;
  /** the mode the `answer` checks ran in — lenient when the run predates the block sentence */
  answer_mode: "strict" | "lenient";
  /** the runs whose verdict changed: `task [profile] #run: FAIL → pass` */
  changed: string[];
  /** the runs that were kept as they were because they never produced a final text (a harness error, a skip) */
  kept: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number, digits = 1): string {
  return Number.isInteger(n) && digits === 0 ? String(n) : n.toFixed(digits);
}

function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : fmt(n, 0);
}

export interface CellStats {
  n: number;
  passed: number;
  pass_rate: number;
  turns: number;
  calls: number;
  failed: number;
  /** every input token: uncached + cache reads + cache writes */
  input_tokens: number;
  /** input tokens billed at full price */
  uncached_tokens: number;
  /** cache reads + cache writes */
  cached_tokens: number;
  cache_read: number;
  cache_write: number;
  output_tokens: number;
  /** mean dollars per run at list price; null when a run's model is not priced */
  cost: number | null;
  wall_s: number;
  /** share of runs that wrote something after a plan, over runs that wrote */
  plan_before_write: number | null;
  turn_caps: number;
  errors: number;
}

/** The runs that actually ran (a skipped cell is neither a pass nor a failure and enters no mean). */
export function ran(rows: RunMetrics[]): RunMetrics[] {
  return rows.filter((r) => r.skipped === undefined);
}

export function cellStats(rows: RunMetrics[]): CellStats {
  const wrote = rows.filter((r) => r.plan_before_write !== null);
  return {
    n: rows.length,
    passed: rows.filter((r) => r.passed).length,
    pass_rate: rows.length === 0 ? 0 : rows.filter((r) => r.passed).length / rows.length,
    turns: mean(rows.map((r) => r.turns)),
    calls: mean(rows.map((r) => r.tool_calls)),
    failed: mean(rows.map((r) => r.failed_calls)),
    input_tokens: mean(rows.map((r) => r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens)),
    uncached_tokens: mean(rows.map((r) => r.input_tokens)),
    cached_tokens: mean(rows.map((r) => r.cache_read_input_tokens + r.cache_creation_input_tokens)),
    cache_read: mean(rows.map((r) => r.cache_read_input_tokens)),
    cache_write: mean(rows.map((r) => r.cache_creation_input_tokens)),
    output_tokens: mean(rows.map((r) => r.output_tokens)),
    cost: meanCost(rows),
    wall_s: mean(rows.map((r) => r.wall_ms / 1000)),
    plan_before_write: wrote.length === 0 ? null : wrote.filter((r) => r.plan_before_write).length / wrote.length,
    turn_caps: rows.filter((r) => r.hit_turn_cap).length,
    errors: rows.filter((r) => r.error !== undefined).length,
  };
}

/** The mean of the runs' list-price costs; null as soon as one run's model is unpriced (a partial mean would mislead). */
function meanCost(rows: RunMetrics[]): number | null {
  if (rows.length === 0) return null;
  const costs = rows.map((r) => runCost(r));
  return costs.every((c): c is number => c !== undefined) ? mean(costs) : null;
}

/** One table row; `plan→write` is `—` when no run wrote, and always under `fs` (it has no plan tool). */
function statsRow(label: string, s: CellStats, profile: Profile): string {
  const pbw = s.plan_before_write === null || isFsProfile(profile) ? "—" : `${Math.round(s.plan_before_write * 100)}%`;
  const cost = s.cost === null ? "" : fmtDollars(s.cost);
  return `| ${label} | ${s.passed}/${s.n} (${Math.round(s.pass_rate * 100)}%) | ${fmt(s.turns)} | ${fmt(s.calls)} | ${fmt(s.failed)} | ${tokens(s.uncached_tokens)} / ${tokens(s.cached_tokens)} / ${tokens(s.output_tokens)} | ${cost} | ${fmt(s.wall_s)} | ${pbw} |`;
}

/** A cell's row: the stats of the runs that ran, or `skipped (<reason>)` when none did. */
function cellRow(label: string, rows: RunMetrics[], profile: Profile): string {
  const live = ran(rows);
  if (live.length === 0 && rows.length > 0) return `| ${label} | skipped (${rows[0]!.skipped}) | — | — | — | — | — | — | — |`;
  return statsRow(label, cellStats(live), profile);
}

const COLUMNS = "| pass | turns | calls | failed | uncached / cached / out | $ / run | wall s | plan→write |";
const RULE = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const HEADER = `| task | corpus | profile ${COLUMNS}\n| --- | --- | --- ${RULE}`;
const TOTALS_HEADER = `| | corpus | profile ${COLUMNS}\n| --- | --- | --- ${RULE}`;

/** `\`full\`, \`minimal\` (omgbase MCP), \`fs\` (filesystem baseline)` — which profiles are omgbase and which the bare-files control. */
export function describeProfiles(profiles: Profile[]): string {
  const code = (ps: Profile[]) => ps.map((p) => `\`${p}\``).join(", ");
  const omg = profiles.filter((p) => !isFsProfile(p));
  const fs = profiles.filter(isFsProfile);
  const parts: string[] = [];
  if (omg.length > 0) parts.push(`${code(omg)} (omgbase MCP)`);
  if (fs.length > 0) parts.push(`${code(fs)} (filesystem baseline, no omgbase)`);
  return parts.join(", ");
}

function histogram(rows: RunMetrics[], pick: (r: RunMetrics) => Record<string, number>): [string, number][] {
  const acc: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(pick(r))) acc[k] = (acc[k] ?? 0) + v;
  return Object.entries(acc).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function renderReport(results: RunMetrics[], meta: ReportMeta): string {
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  const corpora = [...new Set(results.map((r) => r.corpus))].sort();
  const profiles = meta.profiles.length > 0 ? meta.profiles : [...new Set(results.map((r) => r.profile))];
  const skipped = results.filter((r) => r.skipped !== undefined);
  const out: string[] = [];
  out.push("# agent-bench report", "");
  out.push(`- model: \`${meta.model}\`${meta.provider ? ` via ${meta.provider}` : ""}${meta.effort ? ` (effort ${meta.effort})` : ""}`);
  out.push(`- profiles: ${describeProfiles(profiles)} · runs per cell: ${meta.runs} · turn cap: ${meta.max_turns}`);
  out.push(`- tasks: ${tasks.length} · corpora: ${corpora.map((c) => `\`${c}\``).join(", ") || "—"} · runs: ${results.length}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}`);
  if (meta.omg_version) out.push(`- omg: ${meta.omg_version}`);
  out.push(`- embedder: ${meta.embedder ? `\`${meta.embedder}\`` : "none (tasks that require semantic search are skipped under the omgbase profiles)"}`);
  out.push(`- started ${meta.started} · finished ${meta.finished}`);
  if (meta.rescore) {
    const r = meta.rescore;
    out.push(`- **rescored** ${r.at} from \`${r.source}\` under the tasks' CURRENT checks: the text-only checks (\`answer\`, \`final_text\`) re-run over each run's stored final text — \`answer\` in ${r.answer_mode} mode${r.answer_mode === "lenient" ? " (the run predates the `answer` block sentence: a check with `must_mention` is judged by it alone, a check without one by every expected path anywhere in the text in either form; extra paths are not penalized)" : ""} — the workspace checks (\`read\`, \`query\`, \`unchanged\`, \`unchanged_all\`) kept as recorded; ${r.kept} run(s) with no final text kept as they were. Verdicts changed: ${r.changed.length === 0 ? "none" : r.changed.join("; ")}`);
  }
  const live = ran(results);
  const perRun = meanCost(live);
  if (perRun !== null) out.push(`- cost: ${fmtDollars(perRun * live.length)} for ${live.length} run(s) at Anthropic list price (\`src/pricing.ts\`)`);
  out.push("");
  out.push("Tokens are means per run: `uncached` input bills at full price, `cached` (cache reads + cache writes) at a tenth and 1.25× of it, `out` is output; `$ / run` is the mean cost at Anthropic list price (`src/pricing.ts`; blank for a model the table does not price — a Bedrock bill differs). `plan→write` is the share of runs that wrote something whose first write was preceded by a `plan` (— when no run wrote, and under `fs`, which has no plan tool). A `skipped` cell did not run: the task requires a capability the profile lacks (`needs --embedder`); it is neither a pass nor a failure and enters no mean.", "");

  out.push("## Task × profile", "", HEADER);
  for (const task of tasks) {
    for (const profile of profiles) {
      const rows = results.filter((r) => r.task === task && r.profile === profile);
      if (rows.length === 0) continue;
      out.push(cellRow(`${task} | ${rows[0]!.corpus} | \`${profile}\``, rows, profile));
    }
  }
  out.push("");

  out.push("## Totals per profile", "", TOTALS_HEADER);
  for (const profile of profiles) {
    const rows = ran(results.filter((r) => r.profile === profile));
    if (rows.length === 0) continue;
    if (corpora.length > 1) {
      for (const corpus of corpora) {
        const sub = rows.filter((r) => r.corpus === corpus);
        if (sub.length > 0) out.push(statsRow(`all | ${corpus} | \`${profile}\``, cellStats(sub), profile));
      }
    }
    out.push(statsRow(`all | ${corpora.length > 1 ? "all" : corpora[0] ?? "—"} | \`${profile}\``, cellStats(rows), profile));
  }
  out.push("");

  for (const profile of profiles) {
    const all = results.filter((r) => r.profile === profile);
    const rows = ran(all);
    if (all.length === 0) continue;
    out.push(`## \`${profile}\`${isFsProfile(profile) ? " (filesystem baseline)" : " (omgbase)"}`, "");
    const failed = histogram(rows, (r) => r.failed_by_code);
    out.push(`Failed calls by code: ${failed.length === 0 ? "none" : failed.map(([k, v]) => `\`${k}\` ${v}`).join(", ")}`, "");
    const calls = histogram(rows, (r) => r.calls_by_tool);
    out.push(`Tool calls: ${calls.length === 0 ? "none" : calls.map(([k, v]) => `\`${k}\` ${v}`).join(", ")}`, "");
    const caps = rows.filter((r) => r.hit_turn_cap).length;
    const errors = rows.filter((r) => r.error !== undefined);
    const skips = all.filter((r) => r.skipped !== undefined);
    if (caps > 0) out.push(`Turn cap hit in ${caps} run(s).`, "");
    if (errors.length > 0) out.push(`Harness/API errors in ${errors.length} run(s): ${errors.map((r) => `${r.task}#${r.run} — ${r.error}`).join("; ")}`, "");
    if (skips.length > 0) out.push(`Skipped ${skips.length} run(s): ${[...new Set(skips.map((r) => `${r.task} (${r.skipped})`))].join("; ")}`, "");
  }

  out.push("## Runs", "", "| task | profile | run | pass | turns | calls | failed | failures | transcript |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of [...results].sort((a, b) => a.task.localeCompare(b.task) || a.profile.localeCompare(b.profile) || a.run - b.run)) {
    const failures = r.check_failures.map((f) => f.replace(/\|/g, "\\|").replace(/\n/g, " ")).join("; ");
    const verdict = r.skipped !== undefined ? "skip" : r.passed ? "pass" : "FAIL";
    const why = r.skipped !== undefined ? r.skipped : failures || (r.error ? `error: ${r.error}` : "");
    out.push(`| ${r.task} | \`${r.profile}\` | ${r.run} | ${verdict} | ${r.turns} | ${r.tool_calls} | ${r.failed_calls} | ${why} | [${r.transcript}](${r.transcript}) |`);
  }
  out.push("");
  return out.join("\n");
}
