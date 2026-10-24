// A scripted MCP server for the tests: answers tool calls from a table, records
// every call, and — like `omg mcp --tools minimal` — refuses any tool outside
// the ten with the profile's `unknown tool` error (so a feature that strayed
// off the minimal profile fails loudly in the suite, not at a user's gateway).
// No network, no @omgbase/core.

import { OmgError, type Caller } from "../src/lib/mcp-client.ts";
import { MINIMAL_TOOLS } from "../src/lib/tools.ts";

export interface Call { name: string; args: Record<string, unknown> }

export type Handler = (args: Record<string, unknown>, call: number) => unknown;

export class ScriptedCaller implements Caller {
  calls: Call[] = [];
  constructor(readonly handlers: Record<string, Handler>, readonly tools: readonly string[] = MINIMAL_TOOLS) {}

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, args });
    if (!this.tools.includes(name)) throw new OmgError("unknown_tool", `the server does not list the tool \`${name}\` (its tools profile hides it)`, { data: { tool: name }, tool: name });
    const h = this.handlers[name];
    if (!h) throw new Error(`scripted server: no handler for ${name}`);
    const r = h(args, this.calls.filter((c) => c.name === name).length - 1);
    if (r instanceof OmgError) throw r;
    return r as T;
  }

  /** The tool names called so far, in order. */
  names(): string[] {
    return this.calls.map((c) => c.name);
  }

  /** The arguments of the n-th call of a tool. */
  argsOf(name: string, n = 0): Record<string, unknown> | undefined {
    return this.calls.filter((c) => c.name === name)[n]?.args;
  }
}

/** A query result page as the server spells it. */
export function page(hits: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { hits, truncated: false, cursor: null, consumer: "collect", ...extra };
}
