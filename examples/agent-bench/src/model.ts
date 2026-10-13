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

/**
 * Where the model is served from. `anthropic` is the Anthropic API (`ANTHROPIC_API_KEY`
 * or an `ant auth login` profile); `bedrock` is Amazon Bedrock through
 * `@anthropic-ai/bedrock-sdk`, which signs with the default AWS credential chain
 * (`AWS_PROFILE` / SSO, `AWS_REGION`) — the same setup Claude Code uses when
 * `CLAUDE_CODE_USE_BEDROCK=1`.
 */
export type Provider = "anthropic" | "bedrock";

export const PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "bedrock"]);

export const DEFAULT_MODEL = "claude-opus-5";
/** the Bedrock inference profile of the same model (cross-region) */
export const DEFAULT_BEDROCK_MODEL = "global.anthropic.claude-opus-5";

type Env = Record<string, string | undefined>;

/**
 * The provider when none is named: `AGENT_BENCH_PROVIDER` if set; else Bedrock when the
 * shell is already set up for it (`CLAUDE_CODE_USE_BEDROCK`) and no Anthropic key is
 * present; else the Anthropic API.
 */
export function resolveProvider(explicit: string | undefined, env: Env = process.env): Provider | { error: string } {
  const named = explicit ?? env.AGENT_BENCH_PROVIDER;
  if (named !== undefined && named !== "") {
    if (!PROVIDERS.has(named)) return { error: `--provider must be one of ${[...PROVIDERS].join("|")} (got "${named}")` };
    return named as Provider;
  }
  const bedrockShell = env.CLAUDE_CODE_USE_BEDROCK !== undefined && env.CLAUDE_CODE_USE_BEDROCK !== "" && env.CLAUDE_CODE_USE_BEDROCK !== "0";
  return bedrockShell && !env.ANTHROPIC_API_KEY ? "bedrock" : "anthropic";
}

/**
 * The model id to send. On Bedrock a bare Anthropic id (`claude-opus-5`) becomes the
 * cross-region inference profile `global.anthropic.claude-opus-5`; an id that already
 * carries a region prefix (`eu.anthropic.…`, `us.anthropic.…`, `global.anthropic.…`) is
 * passed through, minus a Claude Code `[1m]`-style annotation.
 */
export function modelIdFor(provider: Provider, model: string | undefined): string {
  if (provider === "anthropic") return model ?? DEFAULT_MODEL;
  if (model === undefined) return DEFAULT_BEDROCK_MODEL;
  const clean = model.replace(/\[[^\]]*\]$/, "");
  return /^[a-z-]+\.anthropic\./.test(clean) ? clean : `global.anthropic.${clean}`;
}

/** the part of a client the model uses — `Anthropic` and `AnthropicBedrock` both have it */
export type MessagesClient = { messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> } };

/** Build the client for a provider. Bedrock is imported lazily so an Anthropic-API run never loads the AWS stack. */
export async function createClient(provider: Provider, env: Env = process.env): Promise<MessagesClient> {
  if (provider === "bedrock") {
    const { default: AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    return new AnthropicBedrock(region ? { awsRegion: region } : {}) as unknown as MessagesClient;
  }
  return new Anthropic();
}

export interface ClaudeOptions {
  /** default `claude-opus-5` — the current recommendation for agentic tool use (the Bedrock id when `provider` is bedrock) */
  model?: string;
  provider?: Provider;
  /** `output_config.effort`; default `high` */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** default 16000 (non-streaming; a tool-calling turn is short) */
  maxTokens?: number;
  /** the client; built from `provider` on first use when absent */
  client?: MessagesClient;
}

export class ClaudeModel implements Model {
  readonly name: string;
  readonly provider: Provider;
  private client: MessagesClient | undefined;
  private readonly effort: NonNullable<ClaudeOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: ClaudeOptions = {}) {
    this.provider = opts.provider ?? "anthropic";
    this.name = modelIdFor(this.provider, opts.model);
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? 16000;
    this.client = opts.client;
  }

  async complete(req: ModelRequest): Promise<Anthropic.Message> {
    this.client ??= await createClient(this.provider);
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
