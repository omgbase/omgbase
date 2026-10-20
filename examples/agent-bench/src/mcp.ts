// The MCP side: spawn `omg mcp -C <workspace> --no-watch [--tools <profile>]` as a
// stdio server, connect with the official client, hand `tools/list` to the model
// verbatim (name, description, input schema) and forward every tool call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { CallOutcome, ToolServer } from "./server.ts";
import type { Profile } from "./types.ts";
import { OMG, type Workspace } from "./workspace.ts";

export type { CallOutcome } from "./server.ts";

export interface SpawnOptions {
  workspace: Workspace;
  profile: Profile;
  /** the omg entry (`.js`, run with the current node) — default the monorepo build */
  omg?: string;
}

export class OmgServer implements ToolServer {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  readonly profile: Profile;
  /** what the server wrote to stderr (the `[mcp] …` lines), for diagnostics */
  readonly stderr: string[];

  private constructor(client: Client, transport: StdioClientTransport, profile: Profile, stderr: string[]) {
    this.client = client;
    this.transport = transport;
    this.profile = profile;
    this.stderr = stderr;
  }

  static async spawn({ workspace, profile, omg = OMG }: SpawnOptions): Promise<OmgServer> {
    const args = [omg, "mcp", "-C", workspace.dir, "--no-watch"];
    if (profile !== "full") args.push("--tools", profile);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env: Object.fromEntries(Object.entries(workspace.env).filter((e): e is [string, string] => typeof e[1] === "string")),
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const client = new Client({ name: "agent-bench", version: "0.0.0" });
    await client.connect(transport);
    return new OmgServer(client, transport, profile, stderr);
  }

  /** `tools/list` as Anthropic tool definitions, verbatim. */
  async tools(): Promise<Anthropic.Tool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const started = performance.now();
    try {
      const r = await this.client.callTool({ name, arguments: args });
      const ms = performance.now() - started;
      const content = (r.content ?? []) as { type: string; text?: string }[];
      const text = content.map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c))).join("\n");
      let result: unknown = text;
      try {
        result = JSON.parse(text);
      } catch {
        // not JSON (never, for omg) — hand the text through
      }
      if (r.isError) {
        const code = typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error
          : "tool_error";
        return { ok: false, text, result, error_code: code, ms };
      }
      return { ok: true, text, result, ms };
    } catch (e) {
      const ms = performance.now() - started;
      const message = e instanceof Error ? e.message : String(e);
      // A profile hides a tool as JSON-RPC -32602 "unknown tool <name>" (spec/surface §4 Profiles).
      const code = /unknown tool/.test(message) ? "unknown_tool" : "rpc_error";
      return { ok: false, text: message, result: { error: code, message }, error_code: code, ms };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.transport.close();
    }
  }
}
