// The model seam: the agent loop asks a `Model` for the next assistant message and
// never cares whether Claude or a script answered. `ClaudeModel` drives the Anthropic
// SDK (one request per turn, prompt caching on the stable tools + system prefix);
// `ScriptedModel` replays a task's solution — one tool call per turn, then the
// final text — so the loop, the hooks and the checks are tested against the real
// `omg mcp` without API spend.
import Anthropic from "@anthropic-ai/sdk";
import type { Solution, SolutionStep, TokenUsage } from "./types.ts";

export interface ModelRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export interface Model {
  /** the id reported in the metrics */
  readonly name: string;
  complete(req: ModelRequest): Promise<Anthropic.Message>;
}

export function usageOf(m: Anthropic.Message): TokenUsage {
  return {
    input_tokens: m.usage.input_tokens,
    output_tokens: m.usage.output_tokens,
    cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0,
  };
}

// ---- Claude ---------------------------------------------------------------------------

export interface ClaudeOptions {
  /** default `claude-opus-5` — the current recommendation for agentic tool use */
  model?: string;
  /** `output_config.effort`; default `high` */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** default 16000 (non-streaming; a tool-calling turn is short) */
  maxTokens?: number;
  client?: Anthropic;
}

export const DEFAULT_MODEL = "claude-opus-5";

export class ClaudeModel implements Model {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<ClaudeOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: ClaudeOptions = {}) {
    this.name = opts.model ?? DEFAULT_MODEL;
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? 16000;
    // Credentials from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile).
    this.client = opts.client ?? new Anthropic();
  }

  async complete(req: ModelRequest): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: this.name,
      max_tokens: this.maxTokens,
      // Adaptive thinking (the only on-mode on current models); the thinking blocks
      // ride along in `content` and are echoed back by the loop unchanged.
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      // tools → system → messages is the cache prefix; both are identical for every
      // turn of a run (and every run of a profile), so cache the end of the system block.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools,
      messages: req.messages,
    });
  }
}

// ---- the scripted model ------------------------------------------------------------------

/** Substitute `{ "$result": i, "$get"?: "a.b" }` placeholders with earlier steps' parsed results. */
export function substitute(value: unknown, results: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => substitute(v, results));
  if (typeof value !== "object" || value === null) return value;
  const o = value as Record<string, unknown>;
  if (typeof o.$result === "number") {
    let v = results[o.$result];
    if (v === undefined) throw new Error(`$result ${o.$result} refers to a step that has not run`);
    if (typeof o.$get === "string") for (const k of o.$get.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
    return v;
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, substitute(v, results)]));
}

/** Pull the tool results the loop appended so a later step can reference them. */
function toolResultsOf(messages: Anthropic.MessageParam[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string"
        ? block.content
        : (block.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      try {
        out.push(JSON.parse(text));
      } catch {
        out.push(text);
      }
    }
  }
  return out;
}

const SCRIPT_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function fakeMessage(content: Anthropic.ContentBlock[], stop: Anthropic.StopReason, name: string): Anthropic.Message {
  const m = {
    id: `msg_script_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    model: name,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { ...SCRIPT_USAGE, server_tool_use: null, service_tier: null },
  };
  return m as unknown as Anthropic.Message;
}

export class ScriptedModel implements Model {
  readonly name = "scripted";
  private next = 0;
  /** every step's raw outcome as the loop returned it (for assertions) */
  readonly outcomes: unknown[] = [];
  private readonly solution: Solution;

  constructor(solution: Solution) {
    this.solution = solution;
  }

  get steps(): SolutionStep[] {
    return this.solution.steps;
  }

  complete(req: ModelRequest): Promise<Anthropic.Message> {
    const results = toolResultsOf(req.messages);
    this.outcomes.splice(0, this.outcomes.length, ...results);
    const step = this.solution.steps[this.next];
    if (step === undefined) {
      return Promise.resolve(fakeMessage([{ type: "text", text: this.solution.final_text, citations: null }], "end_turn", this.name));
    }
    this.next += 1;
    const input = substitute(step.args, results) as Record<string, unknown>;
    const block = { type: "tool_use", id: `toolu_script_${this.next}`, name: step.tool, input, caller: { type: "direct" } } as Anthropic.ToolUseBlock;
    return Promise.resolve(fakeMessage([block], "tool_use", this.name));
  }
}
