import { connectStdioEngine, connectHttpEngine, type McpEngineClient } from "@omgbase/sync";
import type { Cli } from "../context.js";
import { CliUsageError } from "../output.js";

// Remote (`--server`) mode plumbing (ADR-014). When a command runs with the
// global `--server <cmd|url>` flag, it reaches a remote engine over MCP instead
// of the embedded local store: it calls the MCP tool that mirrors its local
// core function and renders the (identically-shaped) result. One connection per
// process, opened lazily on first use and reused across a `shell` session;
// closed via `closeRemote` at the end of a one-shot command or on shell exit.
//
// The flag is an http(s) URL to reach a remote server over Streamable HTTP, or
// otherwise a command to spawn and talk to over stdio.

let engine: McpEngineClient | null = null;

/** The process's remote engine, connecting (spawning the command or opening the
 *  HTTP transport) on first use. `--repo` is threaded into each tool call by
 *  `remoteCall`. */
async function remoteEngine(cli: Cli): Promise<McpEngineClient> {
  if (engine) return engine;
  const spec = (cli.flags.server ?? "").trim();
  if (/^https?:\/\//i.test(spec)) {
    const headers = parseHeaders(cli.flags.headers);
    engine = await connectHttpEngine({ url: spec, ...(Object.keys(headers).length > 0 ? { headers } : {}) });
    return engine;
  }
  if (cli.flags.headers?.length) throw new CliUsageError("-H/--header only applies to an http(s) --server url");
  const argv = spec.split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new CliUsageError("--server requires a command to spawn (e.g. --server \"omg mcp -C /vault\") or an http(s) URL");
  engine = await connectStdioEngine({ command: argv[0]!, args: argv.slice(1) });
  return engine;
}

/** Parse repeatable `-H "Name: value"` flags into a header map. Splits on the
 *  first colon; later values win for a repeated name. */
function parseHeaders(raw: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of raw ?? []) {
    const i = h.indexOf(":");
    if (i < 1) throw new CliUsageError(`invalid header ${JSON.stringify(h)} — expected "Name: value"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return headers;
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
