// The tier-3 seam: a QueryPlanner delegates a query (or part of one) to an
// underlying store or query system, returning the rows it produced plus a
// RESIDUAL query for whatever it could not push down. `PlannedEngine` wires this
// to the in-memory engine: it hands the query to the planner, then finishes the
// residual over the produced rows — so a planner may be as partial as it likes
// and correctness is always preserved by the in-memory fallback.

import type { Query } from "./ast.ts";
import type { Engine, OqxResult } from "./engine.ts";
import { InMemoryEngine } from "./engine.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { ROWS_ROOT } from "./plan.ts";

export interface Plan {
  /** The rows the backend produced (already reduced by whatever it pushed). */
  rows(): Iterable<unknown>;
  /** The query to finish in-memory over `rows()`; its source is the rows root. */
  residual: Query;
  /** Optional context for evaluating the residual (to navigate relations of the
   * produced rows). Defaults to plain-object access over `rows()`. */
  context?: DataContext;
}

export interface QueryPlanner {
  /** Plan a query, or return null to decline it entirely (full in-memory fallback). */
  plan(query: Query, params: readonly unknown[]): Plan | null;
}

/** Runs a planner, finishing the residual on the in-memory engine. */
export class PlannedEngine implements Engine {
  private planner: QueryPlanner;
  private fallback: DataContext;

  constructor(planner: QueryPlanner, fallback: DataContext = new DefaultContext()) {
    this.planner = planner;
    this.fallback = fallback;
  }

  run(query: Query, bindings: readonly unknown[] = []): OqxResult {
    const plan = this.planner.plan(query, bindings);
    if (!plan) return new InMemoryEngine(this.fallback).run(query, bindings);
    const produced = Array.from(plan.rows());
    const ctx = plan.context ?? new DefaultContext({ [ROWS_ROOT]: produced });
    return new InMemoryEngine(ctx).run(plan.residual, bindings);
  }
}
