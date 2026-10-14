// The `query` tool's result (spec/surface §1.4) and the one paging helper every
// list in the demo shares: `OqxResult { hits, truncated, cursor, consumer,
// count?, exists?, none?, values?, hints? }` — `hints` (4.6, §1.5) the
// unknown-name advice, present only when non-empty, the LAST member.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";

export interface QueryResult {
  hits: Record<string, unknown>[];
  truncated: boolean;
  cursor: string | null;
  consumer: string;
  count?: number;
  exists?: boolean;
  none?: boolean;
  values?: unknown[];
  hints?: string[];
}

export function queryResultOf(wire: Wire): QueryResult {
  const out: QueryResult = {
    hits: Array.isArray(wire.hits) ? (wire.hits as Record<string, unknown>[]) : [],
    truncated: wire.truncated === true,
    cursor: typeof wire.cursor === "string" ? wire.cursor : null,
    consumer: typeof wire.consumer === "string" ? wire.consumer : "collect",
  };
  if (typeof wire.count === "number") out.count = wire.count;
  if (typeof wire.exists === "boolean") out.exists = wire.exists;
  if (typeof wire.none === "boolean") out.none = wire.none;
  if (Array.isArray(wire.values)) out.values = wire.values;
  if (Array.isArray(wire.hints)) out.hints = (wire.hints as unknown[]).filter((h): h is string => typeof h === "string");
  return out;
}

export interface QueryOptions {
  repo?: string | null;
  limit?: number;
  cursor?: string | null;
}

/** The `query` tool's arguments for a page. */
export function queryArgs(query: string, opts: QueryOptions = {}): Record<string, unknown> {
  return {
    query,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
    ...repoArg(opts.repo),
  };
}

export async function runQuery(caller: Caller, query: string, opts: QueryOptions = {}): Promise<QueryResult> {
  return queryResultOf(await caller.call<Wire>("query", queryArgs(query, opts)));
}

/** Every hit, following the keyset cursor (bounded by `max` rows; a query with
 * its own `order by` has no cursor — its top page is all there is). */
export async function queryAll(caller: Caller, query: string, repo: string | null = null, max = 2000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page: QueryResult = await runQuery(caller, query, { repo, limit: Math.min(500, max - out.length), cursor });
    out.push(...page.hits);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor && out.length < max);
  return out;
}
