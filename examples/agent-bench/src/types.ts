// The harness's own vocabulary: tasks and their checks (tasks/*.json), the
// scripted "solution" a task carries for the dry run and the tests, the
// per-run metrics and the transcript events. Everything the Anthropic SDK
// already types (messages, tools, usage) is used from the SDK, not redefined.

/** A catalog profile name as passed to `omg mcp --tools <profile>`. Kept open so a new profile needs no code change. */
export type Profile = string;

/** The tools of the `full` catalog that only read (plus `plan`, which writes nothing). Everything else is a write. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "docs_outline", "docs_read", "docs_read_many", "blocks_read", "nodes_block_read", "blocks_read_many",
  "docs_tree", "docs_list", "query_syntax", "query", "graph", "blocks_search", "blocks_resolve",
  "plan", "links_stale", "blocks_history", "docs_diff", "docs_diff_unified", "docs_read_at", "docs_history",
  "changes_since", "repos_status", "sync_status", "repos", "version",
]);

export function isWriteTool(name: string): boolean {
  return !READ_TOOLS.has(name);
}

// ---- checks ----------------------------------------------------------------------

/**
 * `query`: run the OQX `query` through the `query` tool. With `hits`, the result must
 * have exactly that many hits, in order, and hit i must carry every key of `hits[i]`
 * with a deep-equal value (the envelope keys `_id`/`_path` are ignored unless named).
 * With `count`, the result's `count` must equal it (use a `… count { … }` query).
 * Queries speak surface 5.0: an engine attribute is `_`-prefixed (`_path`, `_kind`,
 * `_type`), an authored frontmatter key or `attrs` key is bare (`verified`, `checked`).
 */
export interface QueryCheck {
  kind: "query";
  query: string;
  hits?: Record<string, unknown>[];
  count?: number;
}

/** `read`: `docs_read { _path }` → the `_raw` bytes must equal `equals` and/or match every `matches` regex and none of `not_matches` (JavaScript regexes, flags "s"). (The check's own `path` member is the harness's role name, not the tool argument.) */
export interface ReadCheck {
  kind: "read";
  path: string;
  equals?: string;
  matches?: string[];
  not_matches?: string[];
}

/** `unchanged`: the document's bytes equal the fixture file and no `api`-origin commit touched it (the no-op and the contradiction). */
export interface UnchangedCheck {
  kind: "unchanged";
  path: string;
}

/** `final_text`: the model's last assistant text must match the regex (flags "is"). */
export interface FinalTextCheck {
  kind: "final_text";
  matches: string;
}

export type Check = QueryCheck | ReadCheck | UnchangedCheck | FinalTextCheck;

// ---- hooks ------------------------------------------------------------------------

/**
 * The stale-plan hook: append `append` to the workspace file at `path` (repo-relative)
 * once, right after the model's first `plan` call returns — or, when the model never
 * plans and goes straight to a write, right before that first write call — so the
 * document moves on disk between the model's preview and its commit.
 */
export interface DiskEditHook {
  kind: "disk_edit";
  on: "after_first_plan";
  /** also fire before the first write when no `plan` preceded it (default true) */
  also_before_first_write?: boolean;
  path: string;
  append: string;
}

export type Hook = DiskEditHook;

// ---- the scripted solution ---------------------------------------------------------

/**
 * One scripted tool call. Any value inside `args` may be `{ "$result": i }` (the
 * parsed result of step i) or `{ "$result": i, "$get": "a.b" }` (a member of it —
 * a hit's id is `hits.0._id`, surface 5.0). `expect_error` names the error code
 * the step is expected to fail with.
 */
export interface SolutionStep {
  tool: string;
  args: Record<string, unknown>;
  expect_error?: string;
}

export interface Solution {
  steps: SolutionStep[];
  /** the final assistant text the scripted model ends with */
  final_text: string;
}

// ---- tasks -----------------------------------------------------------------------------

export interface Task {
  id: string;
  /** what the model is asked to do — identical across profiles */
  prompt: string;
  /** every check must pass */
  checks: Check[];
  hook?: Hook;
  /** the oracle: a scripted call sequence that reaches the end state (dry run + tests) */
  solution: Solution;
  /** the end state equals the fresh workspace, so the negative control is skipped (the no-op) */
  trivial_on_fresh?: boolean;
  notes?: string;
}

// ---- metrics -----------------------------------------------------------------------------

/** The four usage counters, kept apart because they bill apart: uncached input (1×), cache reads (0.1×), cache writes (1.25×), output. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface RunMetrics extends TokenUsage {
  task: string;
  profile: Profile;
  run: number;
  model: string;
  /** model requests (assistant turns) */
  turns: number;
  tool_calls: number;
  calls_by_tool: Record<string, number>;
  /** calls whose result was an error envelope or a JSON-RPC error */
  failed_calls: number;
  failed_by_code: Record<string, number>;
  plan_calls: number;
  execute_calls: number;
  write_calls: number;
  /** did a `plan` precede the first write? null when nothing was written */
  plan_before_write: boolean | null;
  /** the run's cost in US dollars at list price (`src/pricing.ts`); absent for a model the table does not price */
  cost_usd?: number;
  wall_ms: number;
  hit_turn_cap: boolean;
  hook_fired: boolean;
  passed: boolean;
  check_failures: string[];
  final_text: string;
  /** the transcript file, relative to the results directory */
  transcript: string;
  error?: string;
}

// ---- transcript events ---------------------------------------------------------------------

export type TranscriptEvent =
  | { type: "start"; t: string; task: string; profile: Profile; run: number; model: string; system: string; prompt: string; tools: string[] }
  | { type: "assistant"; t: string; turn: number; stop_reason: string | null; content: unknown; usage: TokenUsage; model?: string }
  | { type: "tool_call"; t: string; turn: number; id: string; tool: string; args: unknown }
  | { type: "tool_result"; t: string; turn: number; id: string; tool: string; ok: boolean; error_code?: string; ms: number; result: unknown }
  | { type: "hook"; t: string; turn: number; hook: Hook; when: "after_plan" | "before_write" }
  | { type: "end"; t: string; turns: number; hit_turn_cap: boolean; final_text: string }
  | { type: "check"; t: string; passed: boolean; failures: string[] }
  | { type: "error"; t: string; message: string };
