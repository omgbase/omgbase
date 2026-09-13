// OQX for JavaScript — a generic object-query language.
//
// The primary API is a tagged template:
//
//   const employees = oqx`
//     name, id, title
//     from ${people}
//     where jobs exists { employer == ${company} && !end_date }
//   `;
//
// Interpolations cross the host/OQX boundary as typed VALUE bindings, never as
// source text (prepared-statement semantics): a `${…}` source resolves to the
// collection queried; a `${…}` in a predicate is an ordinary host value.
//
// For string queries with named roots (a data context) use `execute`:
//
//   execute("name from people where age >= 18", { people });

import type { Query } from "./ast.ts";
import { parseTemplate, parseString } from "./parser.ts";
import { runQuery, type OqxResult } from "./evaluate.ts";

export { OqxError } from "./errors.ts";
export type { OqxResult } from "./evaluate.ts";
export type * from "./ast.ts";

// Compiled-query cache keyed by the template's stable `strings` identity, so the
// same call site parses once and re-runs with fresh bindings (the host-bindings
// note's caching rule).
const templateCache = new WeakMap<TemplateStringsArray, Query>();

/** The OQX tagged template. Returns the query result shaped by its consumer:
 * an array for `collect` (the default), a boolean for `exists`, a number for
 * `count`, or a single record / null for `first` / `single`. */
export function oqx(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  let query = templateCache.get(strings);
  if (!query) {
    query = parseTemplate(strings, values.length);
    templateCache.set(strings, query);
  }
  return unwrap(runQuery(query, values, undefined));
}

/** Parse a query (string or tagged-template fragments) into a reusable AST. */
export function parse(source: string): Query {
  return parseString(source);
}

/** Run a string query against a data context of named roots (e.g. `{ people }`,
 * so `from people` resolves), returning the consumer-shaped result. */
export function execute(source: string, roots?: Record<string, unknown>): unknown {
  return unwrap(runQuery(parseString(source), [], roots));
}

/** Run a pre-parsed query with explicit bindings and/or named roots, returning
 * the full discriminated result (the consumer and its value). */
export function run(query: Query, opts: { values?: readonly unknown[]; roots?: Record<string, unknown> } = {}): OqxResult {
  return runQuery(query, opts.values ?? [], opts.roots);
}

function unwrap(result: OqxResult): unknown {
  switch (result.consumer) {
    case "collect": return result.rows;
    case "exists": return result.exists;
    case "count": return result.count;
    case "first": case "single": return result.row;
  }
}

export default oqx;
