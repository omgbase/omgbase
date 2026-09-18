import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ObserveResult, ObserveDeleteResult } from "@omgbase/core";
import type { EngineClient, ChangesPage, DocBytes } from "./engine-client.js";

// McpEngineClient (ADR-014 §7): reaches the omgbase side over the Model Context
// Protocol. The coordinator is identical against this or the in-process client;
// only the transport differs. v1 connects over stdio by spawning an `omg mcp`
// server; a Streamable-HTTP transport for a truly remote server is additive
// (swap the transport passed to the Client).

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** Wraps a connected MCP SDK Client, calling the engine's sync tools. */
export class McpEngineClient implements EngineClient {
  constructor(private readonly client: Client) {}

  private async callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`tool ${name} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (res.isError) {
      const err = body as { error?: string; message?: string };
      throw new Error(`tool ${name} failed: ${err.error ?? "error"} — ${err.message ?? text.slice(0, 200)}`);
    }
    return body as T;
  }

  observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]> {
    return this.callJson<ObserveResult[]>("observe_many", { files });
  }

  observeDelete(path: string): Promise<ObserveDeleteResult> {
    return this.callJson<ObserveDeleteResult>("observe_delete", { path });
  }

  changesSince(cursor?: number, opts?: { origin?: "api" | "observed" | "import"; limit?: number }): Promise<ChangesPage> {
    return this.callJson<ChangesPage>("changes_since", {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async readDoc(path: string): Promise<DocBytes | null> {
    try {
      const res = await this.callJson<{ content: string }>("docs_read", { path });
      return { content: res.content, contentHash: createHash("sha256").update(res.content, "utf8").digest("hex") };
    } catch {
      // doc_missing (or any read failure) → treat as absent.
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Connect to an omgbase MCP server over stdio by spawning `command args`
 *  (e.g. `omg mcp -C /vault`). Returns a ready EngineClient. */
export async function connectStdioEngine(spec: { command: string; args?: string[]; env?: Record<string, string> }): Promise<McpEngineClient> {
  const client = new Client({ name: "omgbase-sync", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    ...(spec.env ? { env: spec.env } : {}),
  });
  await client.connect(transport);
  return new McpEngineClient(client);
}
