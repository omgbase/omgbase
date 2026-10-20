import { connectEngine, parseEngineSpec, type EngineSpec, type McpEngineClient } from "@omgbase/sync";
import { isValidId, findDocByRef, type Store } from "@omgbase/core";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike } from "../output.js";

// Remote (`--server`) mode plumbing (ADR-014). When a command runs with the
// global `--server <cmd|url>` flag, it reaches a remote engine over MCP instead
// of the embedded local store: it calls the MCP tool that mirrors its local
// core function and renders the (identically-shaped) result. One connection per
// process, opened lazily on first use and reused across a `shell` session;
// closed via `closeRemote` at the end of a one-shot command or on shell exit.
//
// The flag is an http(s) URL to reach a remote server over Streamable HTTP, or
// otherwise a command to spawn and talk to over stdio. That one rule lives in
// `@omgbase/sync`'s `parseEngineSpec`; `remoteSpec` below is its CLI face, and
// every `--server` consumer goes through it — including `sync`, which hands the
// spec to `runFsMirror` instead of calling tools itself.

let engine: McpEngineClient | null = null;

/** The process's remote engine, connecting (spawning the command or opening the
 *  HTTP transport) on first use. `--repo` is threaded into each tool call by
 *  `remoteCall`. */
async function remoteEngine(cli: Cli): Promise<McpEngineClient> {
  if (engine) return engine;
  engine = await connectEngine(remoteSpec(cli));
  return engine;
}

/** Classify the global `--server` (+ `-H`) flags into an `EngineSpec`: an
 *  http(s) URL → Streamable HTTP with the headers attached; anything else → a
 *  command to spawn over stdio (a URL is never spawned). Usage errors — an empty
 *  value, `-H` with a stdio command — are `CliUsageError` (exit 2). Pure:
 *  nothing is connected or spawned here. */
export function remoteSpec(cli: Cli): EngineSpec {
  const spec = (cli.flags.server ?? "").trim();
  const headers = parseHeaders(cli.flags.headers);
  const isUrl = /^https?:\/\//i.test(spec);
  if (!isUrl && Object.keys(headers).length > 0) throw new CliUsageError("-H/--header only applies to an http(s) --server url");
  if (spec.length === 0) throw new CliUsageError("--server requires a command to spawn (e.g. --server \"omg mcp -C /vault\") or an http(s) URL");
  return parseEngineSpec(spec, headers);
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

/** Whether the remote engine lists `tool` (spec/surface §4 "Profiles": a `--tools minimal` server lists ten). */
export async function remoteHasTool(cli: Cli, tool: string): Promise<boolean> {
  return (await remoteEngine(cli)).hasTool(tool);
}

/** A `#` locator (`path#type[n]`, `#^anchor`): a ref only a server with the sugar tools resolves. */
export function isLocator(ref: string): boolean {
  return ref.includes("#") && !isValidId(ref, "b") && !isValidId(ref, "d");
}

/**
 * The remote sugar call (spec/cli §2.3, 4.2): call `tool` with `toolArgs` when
 * the server lists it — the server resolves refs and pins CAS — else send
 * `apply { effects, reason: <tool> }` with the effects the local builders make
 * from the refs as given (the closure a dry run already uses: an id names its
 * row, anything else a document path). Server-side locator resolution is the
 * one thing a minimal server cannot do, so a `#` locator among `refs` is a
 * usage error there rather than a bogus document path.
 */
export async function remoteSugar<T>(cli: Cli, tool: string, toolArgs: Record<string, unknown>, effects: () => unknown[] | Promise<unknown[]>, refs: string[] = []): Promise<T> {
  if (await remoteHasTool(cli, tool)) return remoteCall<T>(cli, tool, toolArgs);
  const locator = refs.find(isLocator);
  if (locator !== undefined) {
    throw new CliUsageError(
      `${JSON.stringify(locator)} is a locator, and this server does not list ${tool} (a minimal tools profile) — refs are not resolved server-side there; pass a block or document id instead`,
    );
  }
  // The commit reason: the caller's own `reason` argument when the tool takes one, else the tool's name.
  const reason = typeof toolArgs.reason === "string" ? toolArgs.reason : tool;
  return remoteCall<T>(cli, "apply", { effects: await effects(), reason });
}

/** A document ref as the surface's locator (spec/surface §4 "Arguments", 5.0):
 *  a `d_` id is the `_id` argument, anything else the `_path` — the two names a
 *  `docs_*` tool takes (one of them required; the bare `id`/`path` are refused
 *  there as `filter_invalid`). The same pair is a document effect target's
 *  address (`{ kind: "document", _id | _path }`, spec/mutate §11). */
export function docLocator(ref: string): { _id: string } | { _path: string } {
  return isValidId(ref, "d") ? { _id: ref } : { _path: ref };
}

/** The live document a ref names, for a LOCAL verb, or the surface's own
 *  `doc_missing` ("no document with id or path "<ref>"", `data` the locator) —
 *  the same wording the `docs_*` tools give a remote caller (spec/surface §4
 *  "Arguments"), so `omg mv nope.md …` reads alike in both modes. */
export function requireDoc(store: Store, repoId: string, ref: string): string {
  const info = findDocByRef(store, repoId, ref);
  if (!info) throw new EngineErrorLike("doc_missing", `no document with id or path ${JSON.stringify(ref)}`, { data: docLocator(ref) });
  return info.docId;
}

/** The live node a ref names, or the surface's `block_missing` ("no node with id "<ref>""). */
export function requireNode(store: Store, repoId: string, nodeId: string): string {
  const row = store.db.prepare("SELECT 1 FROM nodes WHERE node_id = ? AND repo_id = ?").get(nodeId, repoId);
  if (!row) throw new EngineErrorLike("block_missing", `no node with id ${JSON.stringify(nodeId)}`, { data: { _id: nodeId } });
  return nodeId;
}

/** Close the remote connection if one was opened (idempotent). Called after a
 *  one-shot command and on shell exit. */
export async function closeRemote(): Promise<void> {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.close();
}
