import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, type ServerContext } from "./server.js";

// stdio transport wiring for `omg mcp` (11 §5.8). Keeps the MCP SDK dependency
// inside core (the CLI stays SDK-free, calling this one helper). The host
// (Claude Code, Cursor, …) owns the process lifetime; this resolves when the
// transport closes (stdin EOF / client disconnect).

export interface ServeStdioHandle {
  /** Resolves when the transport closes. */
  closed: Promise<void>;
  /** Close the server + transport (idempotent). */
  close(): Promise<void>;
}

/**
 * Build the MCP server for `ctx` and connect it to stdio. Returns a handle
 * whose `closed` promise settles when the client disconnects. stdout is the
 * protocol channel — callers MUST NOT write anything else to it.
 */
export async function serveStdio(ctx: ServerContext): Promise<ServeStdioHandle> {
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  let resolveClosed: () => void;
  const closed = new Promise<void>((res) => {
    resolveClosed = res;
  });
  transport.onclose = () => resolveClosed();

  await server.connect(transport);

  return {
    closed,
    async close() {
      await server.close();
    },
  };
}
