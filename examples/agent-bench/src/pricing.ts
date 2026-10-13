// What a run costs, at list price. One table keyed by the bare Anthropic model id
// (`claude-opus-5`), with the four per-MTok rates the usage counters map onto:
// uncached input, cache read (0.1× input), cache write (1.25× input, the default
// 5-minute TTL), output. A model the table does not know prints a blank cost —
// never a guess. Pure: no SDK import.
import type { TokenUsage } from "./types.ts";

/** US dollars per million tokens. */
export interface Pricing {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

/**
 * Anthropic API list prices (per MTok), 2026-10: Opus 5 $5 / $25, Sonnet 5 $2 / $10,
 * cache reads at a tenth and 5-minute cache writes at 1.25× of input. Amazon Bedrock
 * bills on its own schedule; the report's `$` is always at these list prices.
 */
export const PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-5": { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 },
  "claude-sonnet-5": { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 },
};

/** Drop a Claude Code `[1m]`-style annotation from a model id. */
export function stripAnnotation(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

/**
 * The bare Anthropic id of a model however it was addressed: a Bedrock inference
 * profile (`global.anthropic.claude-opus-5`, `us.anthropic.…`, `eu.anthropic.…`)
 * loses its region prefix, a `[1m]` annotation is dropped, a bare id is itself.
 */
export function bareModelId(id: string): string {
  return stripAnnotation(id).replace(/^[a-z-]+\.anthropic\./, "");
}

export function pricingFor(model: string): Pricing | undefined {
  return PRICING[bareModelId(model)];
}

/** Dollars for one run's (or one request's) usage at the given rates. */
export function costOf(usage: TokenUsage, p: Pricing): number {
  return (
    usage.input_tokens * p.input +
    usage.cache_read_input_tokens * p.cache_read +
    usage.cache_creation_input_tokens * p.cache_write +
    usage.output_tokens * p.output
  ) / 1_000_000;
}

/** Dollars for a run under the model it names; undefined when the model is not priced. */
export function runCost(usage: TokenUsage & { model: string }): number | undefined {
  const p = pricingFor(usage.model);
  return p === undefined ? undefined : costOf(usage, p);
}

/** `$0.283` under ten dollars, `$11.03` from there — three significant places either way. */
export function fmtDollars(n: number): string {
  return `$${n.toFixed(n < 10 ? 3 : 2)}`;
}
