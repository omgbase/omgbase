import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VERSION, type ObserveResult, type ObserveDeleteResult, type SurfaceObserveResult } from "@omgbase/core";
import type { EngineClient, ChangesPage, DocBytes } from "./engine-client.js";

// McpEngineClient (ADR-014 §7): reaches the omgbase side over the Model Context
// Protocol. The coordinator is identical against this or the in-process client;
// only the transport differs. `connectStdioEngine` spawns an `omg mcp` server
// and talks over its stdin/stdout; `connectHttpEngine` reaches a truly remote
// server over Streamable HTTP. Both hand a connected Client to the same wrapper.
// `parseEngineSpec` + `connectEngine` encode the ONE rule for a `--server`
// value (shared by `omg --server` and `omgbase-sync --server`): an http(s) URL
// is reached over Streamable HTTP; anything else is a command to spawn.

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** Wraps a connected MCP SDK Client, calling the engine's sync tools. */
export class McpEngineClient implements EngineClient {
  private tools: Set<string> | null = null;

  constructor(private readonly client: Client) {}

  /**
   * The tool names the server lists (`tools/list`), fetched once per
   * connection — `connectEngine` does it on connect, so a caller may ask
   * `hasTool` synchronously afterwards. A server may serve a catalog PROFILE
   * (spec/surface §4 "Profiles", 4.3: `omg mcp --tools minimal` lists ten
   * tools); the CLI's `--server` verbs ask before calling a sugar tool and fall
   * back to `apply { effects }` when it is not listed (spec/cli §2.3, 4.2).
   */
  async listTools(): Promise<ReadonlySet<string>> {
    if (this.tools) return this.tools;
    const res = await this.client.listTools();
    this.tools = new Set(res.tools.map((t) => t.name));
    return this.tools;
  }

  /** Whether the server lists `name` — after `listTools()` ran (it has, for a client `connectEngine` returned); `true` while unknown, so a never-listed client behaves as before. */
  hasTool(name: string): boolean {
    return this.tools === null ? true : this.tools.has(name);
  }

  /** Call any MCP tool and return its parsed JSON result. Throws on a tool
   *  error (the message carries the engine error code) or non-JSON output. The
   *  general-purpose call the CLI's `--server` mode uses for arbitrary tools. */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
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

  // The wire spells a document's identity `_id`/`_path` (spec/surface §1.2,
  // 5.0: an underscore-prefixed name is an engine field); the engine-client
  // contract keeps the library's `docId`/`path` (spec/store's observe
  // outcome), so the two are mapped back here. The `observe*` ARGUMENTS keep
  // `path` and `files[].path`: a file event's path is a role, not a row
  // attribute (§4 "Arguments").
  async observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]> {
    const out = await this.callTool<SurfaceObserveResult<ObserveResult>[]>("observe_many", { files });
    return out.map(fromWireObserve);
  }

  async observeDelete(path: string): Promise<ObserveDeleteResult> {
    return fromWireObserve(await this.callTool<SurfaceObserveResult<ObserveDeleteResult>>("observe_delete", { path }));
  }

  changesSince(cursor?: number, opts?: { origin?: "api" | "observed" | "import"; limit?: number }): Promise<ChangesPage> {
    return this.callTool<ChangesPage>("changes_since", {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async readDoc(path: string): Promise<DocBytes | null> {
    try {
      // `docs_read { _path }` — the argument addresses the row's `_path`
      // (5.0; a bare `path` is refused, no tolerance) — and `_raw` is the
      // document's reconstructed bytes.
      const res = await this.callTool<{ _raw: string }>("docs_read", { _path: path });
      return { content: res._raw, contentHash: createHash("sha256").update(res._raw, "utf8").digest("hex") };
    } catch {
      // doc_missing (or any read failure) → treat as absent.
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** A wire observe outcome (`{ _id, _path, … }`, spec/surface §3, 5.0) as the library's `{ docId, path, … }`. */
export function fromWireObserve<T extends { docId: string | null; path: string }>(w: SurfaceObserveResult<T>): T {
  const { _id, _path, ...rest } = w;
  return { docId: _id, path: _path, ...rest } as unknown as T;
}

/** Connect to an omgbase MCP server over stdio by spawning `command args`
 *  (e.g. `omg mcp -C /vault`). Returns a ready EngineClient. */
export async function connectStdioEngine(spec: { command: string; args?: string[]; env?: Record<string, string> }): Promise<McpEngineClient> {
  const client = new Client({ name: "omgbase-sync", version: VERSION });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    ...(spec.env ? { env: spec.env } : {}),
  });
  await client.connect(transport);
  return listed(new McpEngineClient(client));
}

/** The one `tools/list` of a connection (see `McpEngineClient.listTools`), so `hasTool` answers synchronously. */
async function listed(engine: McpEngineClient): Promise<McpEngineClient> {
  await engine.listTools();
  return engine;
}

/** Connect to an omgbase MCP server over Streamable HTTP at `url`. The full URL
 *  (including any base path) is used verbatim, so a secret-prefixed endpoint
 *  like `https://host/k/<secret>/mcp` authenticates by the path alone. Extra
 *  `headers` are sent on every request (for hosts that need auth beyond the
 *  path). Returns a ready EngineClient. */
export async function connectHttpEngine(spec: { url: string; headers?: Record<string, string> }): Promise<McpEngineClient> {
  const client = new Client({ name: "omgbase-sync", version: VERSION });
  // The transport's `sessionId` getter is `string | undefined`, which trips the
  // Transport interface's optional `sessionId?: string` under
  // exactOptionalPropertyTypes; the value is only ever read by the SDK.
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    ...(spec.headers && Object.keys(spec.headers).length > 0 ? { requestInit: { headers: spec.headers } } : {}),
  }) as Transport;
  await client.connect(transport);
  return listed(new McpEngineClient(client));
}

/** Where a `--server` value points: an http(s) endpoint (Streamable HTTP, with
 *  optional extra request headers) or a command to spawn and speak stdio to. */
export type EngineSpec =
  | { kind: "http"; url: string; headers?: Record<string, string> }
  | { kind: "stdio"; command: string; args: string[] };

const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Classify a raw `--server` value. The rule, shared by every `--server` consumer:
 * a value starting with `http://` or `https://` is an HTTP endpoint (used
 * verbatim, including any secret base path; `headers` ride along); anything
 * else is split on whitespace and spawned as a stdio MCP server command (e.g.
 * `"omg mcp -C /vault"`). A URL is therefore never spawned. Throws on an empty
 * value, or on headers given for a stdio command (they have nowhere to go).
 */
export function parseEngineSpec(raw: string, headers?: Record<string, string>): EngineSpec {
  const spec = raw.trim();
  const hasHeaders = headers !== undefined && Object.keys(headers).length > 0;
  if (HTTP_URL_RE.test(spec)) return { kind: "http", url: spec, ...(hasHeaders ? { headers } : {}) };
  if (hasHeaders) throw new Error("extra headers only apply to an http(s) server url, not a command to spawn");
  const argv = spec.split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error('server spec is empty — expected a command to spawn (e.g. "omg mcp -C /vault") or an http(s) URL');
  return { kind: "stdio", command: argv[0]!, args: argv.slice(1) };
}

/** Connect to the engine an `EngineSpec` names, over the transport its kind
 *  selects. The single dispatch point behind `omg --server` and `runFsMirror`. */
export function connectEngine(spec: EngineSpec): Promise<McpEngineClient> {
  return spec.kind === "http"
    ? connectHttpEngine({ url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) })
    : connectStdioEngine({ command: spec.command, args: spec.args });
}
