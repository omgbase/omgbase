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
//
// The parsed `Query` is a first-class AST (spec/oqx/AST.md): spans on every
// node, `visit`/`transform` to walk it, `print` to write it back, `toJSON` for
// the shared JSON shape. `where` keeps its surface form; the entry points below
// (`oqx`, `parse` + `run`, `execute`, `runQuery`) apply `resolveAliases` exactly
// once before evaluation — an `Engine` evaluates the query it is given.

import type { Query } from "./ast.ts";
import { parseTemplate, parseString } from "./parser.ts";
import type { Engine, OqxResult } from "./engine.ts";
import { InMemoryEngine } from "./engine.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { resolveAliases } from "./resolve.ts";

export { OqxError } from "./errors.ts";
export type { OqxStage } from "./errors.ts";
export { LANGUAGE_VERSION } from "./version.ts";
export type { OqxResult, Engine, InMemoryEngineOptions, TraceEvent } from "./engine.ts";
export { InMemoryEngine } from "./engine.ts";
export type { BlockPlan, Correlation, Rule, RuleContext, RowIndex } from "./optimize/index.ts";
export {
  DEFAULT_RULES, correlatedEqualityProbe, stableReceiver, invariantBlock, cardinalityOnly,
  optimizeBlock, logicalBlock, HashIndex,
} from "./optimize/index.ts";
export type { DataContext, CallResult, DefaultContextOptions } from "./context.ts";
export { DefaultContext } from "./context.ts";
export type { RegexDialect, RegexFlags } from "./regex.ts";
export { compileRegex } from "./regex.ts";
export type { QueryPlanner, Plan } from "./planner.ts";
export { PlannedEngine } from "./planner.ts";
export { IndexedCollection } from "./adapters/indexed.ts";
export { ROWS_ROOT, partitionPushable, residualQuery, asEquality, isConst, constValue } from "./plan.ts";
export * as semantics from "./semantics.ts";
export type * from "./ast.ts";
export { isExpr } from "./ast.ts";
export { parseTemplate } from "./parser.ts";
export { rawSource, toUtf16, codePointLength } from "./lexer.ts";
export { resolveAliases } from "./resolve.ts";
export type { Clause, VisitContext, Visitor, ChildKey, Stripped } from "./walk.ts";
export { CHILDREN, visit, transform, stripSpans, toJSON } from "./walk.ts";
export type { Template } from "./print.ts";
export { print, printTemplate } from "./print.ts";
export * as build from "./build.ts";

// Compiled-query cache keyed by the template's stable `strings` identity, so the
// same call site parses (and resolves its aliases) once and re-runs with fresh
// bindings.
const templateCache = new WeakMap<TemplateStringsArray, Query>();

/** The OQX tagged template. Returns the query result shaped by its consumer:
 * an array for `collect` (the default), a boolean for `exists` / `none`, a
 * number for `count`, or a single record / null for `first` / `single`. */
export function oqx(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  let query = templateCache.get(strings);
  if (!query) {
    query = resolveAliases(parseTemplate(strings, values.length));
    templateCache.set(strings, query);
  }
  return unwrap(new InMemoryEngine(new DefaultContext()).run(query, values));
}

/** Parse a query string into a reusable AST (spec/oqx/AST.md). */
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
 * `DataContext`, run in-memory), or `roots` (plain-object named roots). The
 * query's `select` aliases are resolved here (`resolveAliases`), once, before
 * the engine sees it. */
export function run(
  query: Query,
  opts: { values?: readonly unknown[]; roots?: Record<string, unknown>; context?: DataContext; engine?: Engine } = {},
): OqxResult {
  const values = opts.values ?? [];
  const resolved = resolveAliases(query);
  if (opts.engine) return opts.engine.run(resolved, values);
  const context = opts.context ?? new DefaultContext(opts.roots ?? {});
  return new InMemoryEngine(context).run(resolved, values);
}

/** Convenience: resolve the query's aliases and run it in-memory over
 * plain-object roots (the default context). */
export function runQuery(query: Query, bindings: readonly unknown[], roots: unknown): OqxResult {
  const ctx = new DefaultContext((roots as Record<string, unknown>) ?? {});
  return new InMemoryEngine(ctx).run(resolveAliases(query), bindings);
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
