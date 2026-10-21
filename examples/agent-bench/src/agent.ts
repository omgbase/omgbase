// The agent loop: task prompt + the profile's fixed system prompt → the model; every
// `tool_use` is forwarded to the tool server (the omg MCP server, or the filesystem
// baseline) and its result handed back; stop when the model answers without a tool
// call or the turn cap is hit. The loop records every event into a transcript and
// the per-run metrics; the task's hook (the stale-plan disk edit) is applied here,
// between the model and the server.
import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync } from "node:fs";
import type { Model } from "./model.ts";
import { usageOf } from "./model.ts";
import type { ToolServer } from "./server.ts";
import { isFsProfile, isWriteTool, type Hook, type Profile, type RunMetrics, type Task, type TokenUsage, type TranscriptEvent } from "./types.ts";
import type { Workspace } from "./workspace.ts";

/** Minimal and identical across the omgbase profiles (the brief's wording). */
export const SYSTEM_PROMPT =
  "You are operating an omgbase knowledge base through MCP tools. Complete the task; prefer previewing with plan before committing writes you cannot undo.";

/** The `fs` analog: the same instruction with the medium named — a vault of Markdown files and filesystem tools. */
export const FS_SYSTEM_PROMPT =
  "You are managing a Markdown knowledge base (an Obsidian-style vault of `.md` files with YAML frontmatter and `[[wikilinks]]`/relative links) through filesystem tools. Complete the task; read before you write, and change nothing beyond what the task asks.";

/** The two prompts differ only in naming the medium. */
export function systemPromptFor(profile: Profile): string {
  return isFsProfile(profile) ? FS_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

export const DEFAULT_MAX_TURNS = 20;

export interface RunOptions {
  task: Task;
  model: Model;
  server: ToolServer;
  workspace: Workspace;
  tools: Anthropic.Tool[];
  /** the system prompt; default the one for the server's profile (`systemPromptFor`) */
  system?: string;
  maxTurns?: number;
  /** receives every transcript event (the bench appends them to a JSONL file) */
  onEvent?: (e: TranscriptEvent) => void;
}

export type LoopMetrics = Omit<RunMetrics, "task" | "corpus" | "profile" | "run" | "model" | "skipped" | "passed" | "check_failures" | "transcript">;

export interface LoopResult {
  metrics: LoopMetrics;
  messages: Anthropic.MessageParam[];
}

function now(): string {
  return new Date().toISOString();
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
}

/** Apply a task hook's edit to the workspace. */
export function applyHook(hook: Hook, workspace: Workspace): void {
  appendFileSync(workspace.file(hook.path), hook.append);
}

export async function runAgent(opts: RunOptions): Promise<LoopResult> {
  const { task, model, server, workspace, tools } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const system = opts.system ?? systemPromptFor(server.profile);
  const emit = (e: TranscriptEvent) => opts.onEvent?.(e);
  const started = performance.now();

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task.prompt }];
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const calls_by_tool: Record<string, number> = {};
  const failed_by_code: Record<string, number> = {};
  let tool_calls = 0;
  let failed_calls = 0;
  let plan_calls = 0;
  let execute_calls = 0;
  let write_calls = 0;
  let plan_before_write: boolean | null = null;
  let hook_fired = false;
  let turns = 0;
  let hit_turn_cap = false;
  let final_text = "";

  const fireHook = (turn: number, when: "after_plan" | "before_write") => {
    if (!task.hook || hook_fired) return;
    hook_fired = true;
    applyHook(task.hook, workspace);
    emit({ type: "hook", t: now(), turn, hook: task.hook, when });
  };

  for (;;) {
    if (turns >= maxTurns) {
      hit_turn_cap = true;
      break;
    }
    turns += 1;
    const turn = turns;
    const response = await model.complete({ system, tools, messages });
    const u = usageOf(response);
    for (const k of Object.keys(usage) as (keyof TokenUsage)[]) usage[k] += u[k];
    emit({ type: "assistant", t: now(), turn, stop_reason: response.stop_reason, content: response.content, usage: u, model: response.model });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue; // a server-side pause: resend to resume
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      final_text = textOf(response.content);
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const args = (tu.input ?? {}) as Record<string, unknown>;
      emit({ type: "tool_call", t: now(), turn, id: tu.id, tool: tu.name, args });
      const write = isWriteTool(tu.name);
      if (write) {
        if (plan_before_write === null) plan_before_write = plan_calls > 0;
        if (task.hook?.also_before_first_write !== false && plan_calls === 0) fireHook(turn, "before_write");
      }
      const outcome = await server.call(tu.name, args);
      tool_calls += 1;
      calls_by_tool[tu.name] = (calls_by_tool[tu.name] ?? 0) + 1;
      if (tu.name === "plan") plan_calls += 1;
      if (tu.name === "execute") execute_calls += 1;
      if (write) write_calls += 1;
      if (!outcome.ok) {
        failed_calls += 1;
        const code = outcome.error_code ?? "tool_error";
        failed_by_code[code] = (failed_by_code[code] ?? 0) + 1;
      }
      emit({ type: "tool_result", t: now(), turn, id: tu.id, tool: tu.name, ok: outcome.ok, ...(outcome.error_code ? { error_code: outcome.error_code } : {}), ms: Math.round(outcome.ms), result: outcome.result });
      if (tu.name === "plan" && outcome.ok) fireHook(turn, "after_plan");
      results.push({ type: "tool_result", tool_use_id: tu.id, content: outcome.text, ...(outcome.ok ? {} : { is_error: true }) });
    }
    // All of a turn's results go back in ONE user message (parallel tool use stays intact).
    messages.push({ role: "user", content: results });
  }

  emit({ type: "end", t: now(), turns, hit_turn_cap, final_text });
  return {
    metrics: {
      ...usage,
      turns,
      tool_calls,
      calls_by_tool,
      failed_calls,
      failed_by_code,
      plan_calls,
      execute_calls,
      write_calls,
      plan_before_write,
      wall_ms: Math.round(performance.now() - started),
      hit_turn_cap,
      hook_fired,
      final_text,
    },
    messages,
  };
}
