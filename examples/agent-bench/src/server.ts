// The tool-server seam the agent loop drives: something that lists Anthropic tool
// definitions and answers a call with a `CallOutcome`. `OmgServer` (src/mcp.ts) is
// the omgbase MCP server under a catalog profile; `FsServer` (src/fs-server.ts) is
// the in-process filesystem baseline. The loop, the hook and the metrics never
// care which one answered.
import type Anthropic from "@anthropic-ai/sdk";

/** One forwarded call, as the loop records it: `ok` is false on an error envelope or a JSON-RPC error. */
export interface CallOutcome {
  ok: boolean;
  /** the text handed back to the model (the server's JSON text, or the JSON-RPC error message) */
  text: string;
  /** the parsed JSON when the text parses */
  result: unknown;
  /** the envelope's `error` code, `unknown_tool` for a refusal, `rpc_error` for a transport failure */
  error_code?: string;
  ms: number;
}

export interface ToolServer {
  /** the profile this server serves (`full`, `minimal`, `fs`) */
  readonly profile: string;
  /** the tool definitions handed to the model verbatim */
  tools(): Promise<Anthropic.Tool[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}
