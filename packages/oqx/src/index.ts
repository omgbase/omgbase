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
// source text (prepared-statement semantics).
//
// The engine is layered so OQX can be a foundation for other query systems:
//   • tier 1 — `InMemoryEngine` over a `DataContext` (this file's default);
//   • tier 2 — a custom `DataContext` binds any data model (ORM, remote, …);
//   • tier 3 — a `QueryPlanner` pushes work into a store (see `oqx/sqlite`),
//     with `PlannedEngine` finishing the residual in-memory.
// All backends must obey the scalar rules in `./semantics.ts` (the conformance
// suite verifies this).

import type { Query } from "./ast.ts";
import { parseTemplate, parseString } from "./parser.ts";
import type { Engine, OqxResult } from "./engine.ts";
import { InMemoryEngine, runQuery } from "./engine.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";

export { OqxError } from "./errors.ts";
export type { OqxResult, Engine } from "./engine.ts";
export { InMemoryEngine, runQuery } from "./engine.ts";
export type { DataContext, CallResult } from "./context.ts";
export { DefaultContext } from "./context.ts";
export type { QueryPlanner, Plan } from "./planner.ts";
export { PlannedEngine } from "./planner.ts";
export { IndexedCollection } from "./adapters/indexed.ts";
export { ROWS_ROOT, partitionPushable, residualQuery, asEquality, isConst, constValue } from "./plan.ts";
export * as semantics from "./semantics.ts";
export type * from "./ast.ts";

// Compiled-query cache keyed by the template's stable `strings` identity, so the
// same call site parses once and re-runs with fresh bindings.
const templateCache = new WeakMap<TemplateStringsArray, Query>();

/** The OQX tagged template. Returns the query result shaped by its consumer:
 * an array for `collect` (the default), a boolean for `exists` / `none`, a
 * number for `count`, or a single record / null for `first` / `single`. */
export function oqx(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  let query = templateCache.get(strings);
  if (!query) {
    query = parseTemplate(strings, values.length);
    templateCache.set(strings, query);
  }
  return unwrap(runQuery(query, values, undefined));
}

/** Parse a query string into a reusable AST. */
export function parse(source: string): Query {
  return parseString(source);
}

/** Run a string query against a data context of named roots (e.g. `{ people }`,
 * so `from people` resolves), returning the consumer-shaped result. */
export function execute(source: string, roots?: Record<string, unknown>): unknown {
  return unwrap(runQuery(parseString(source), [], roots));
}

/** Run a pre-parsed query with explicit bindings and/or a backend, returning the
 * full discriminated result. Provide `engine` (any `Engine`), or `context` (a
 * `DataContext`, run in-memory), or `roots` (plain-object named roots). */
export function run(
  query: Query,
  opts: { values?: readonly unknown[]; roots?: Record<string, unknown>; context?: DataContext; engine?: Engine } = {},
): OqxResult {
  const values = opts.values ?? [];
  if (opts.engine) return opts.engine.run(query, values);
  const context = opts.context ?? new DefaultContext(opts.roots ?? {});
  return new InMemoryEngine(context).run(query, values);
}

function unwrap(result: OqxResult): unknown {
  switch (result.consumer) {
    case "collect": return result.rows;
    case "exists": return result.exists;
    case "none": return result.none;
    case "count": return result.count;
    case "first": case "single": return result.row;
  }
}

export default oqx;
