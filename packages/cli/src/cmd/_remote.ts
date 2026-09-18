import { connectStdioEngine, type McpEngineClient } from "@omgbase/sync";
import type { Cli } from "../context.js";
import { CliUsageError } from "../output.js";

// Remote (`--server`) mode plumbing (ADR-014). When a command runs with the
// global `--server <cmd>` flag, it reaches a remote engine over MCP instead of
// the embedded local store: it calls the MCP tool that mirrors its local core
// function and renders the (identically-shaped) result. One connection per
// process, spawned lazily on first use and reused across a `shell` session;
// closed via `closeRemote` at the end of a one-shot command or on shell exit.

let engine: McpEngineClient | null = null;

/** The process's remote engine, connecting (spawning the `--server` command) on
 *  first use. `--repo` is threaded into each tool call by `remoteCall`. */
async function remoteEngine(cli: Cli): Promise<McpEngineClient> {
  if (engine) return engine;
  const argv = (cli.flags.server ?? "").split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new CliUsageError("--server requires a command to spawn (e.g. --server \"omg mcp -C /vault\")");
  engine = await connectStdioEngine({ command: argv[0]!, args: argv.slice(1) });
  return engine;
}

/** Call an MCP tool on the remote engine, threading the global `--repo` slug.
 *  Returns the tool's parsed JSON result (same shape the local core fn returns,
 *  so the command's existing renderer works unchanged). */
export async function remoteCall<T>(cli: Cli, tool: string, args: Record<string, unknown>): Promise<T> {
  const eng = await remoteEngine(cli);
  return eng.callTool<T>(tool, { ...args, ...(cli.flags.repo ? { repo: cli.flags.repo } : {}) });
}

/** Close the remote connection if one was opened (idempotent). Called after a
 *  one-shot command and on shell exit. */
export async function closeRemote(): Promise<void> {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.close();
}
