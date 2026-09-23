// An in-memory optimizing planner: it hash-indexes a named root collection on
// chosen fields and, for a query whose where-clause contains equality predicates
// on those fields, answers from the index (candidate intersection) instead of a
// full scan. Everything it can't turn into an index probe is left as a residual
// query the in-memory engine finishes over the candidate rows.
//
// This is the smallest honest demonstration of plan optimization: same answers
// as a naive scan, far fewer rows examined, and partial-pushdown correctness via
// the residual.

import type { Query } from "../ast.ts";
import type { Plan, QueryPlanner } from "../planner.ts";
import { partitionPushable, residualQuery, asEquality, constValue } from "../plan.ts";

export class IndexedCollection implements QueryPlanner {
  private name: string;
  private rows: readonly unknown[];
  private indexes = new Map<string, Map<unknown, unknown[]>>();

  /** Index `rows` (exposed as root `name`) on each field in `indexFields`. */
  constructor(name: string, rows: readonly unknown[], indexFields: readonly string[]) {
    this.name = name;
    this.rows = rows;
    for (const field of indexFields) {
      const idx = new Map<unknown, unknown[]>();
      for (const row of rows) {
        const key = (row as Record<string, unknown>)?.[field];
        let bucket = idx.get(key);
        if (!bucket) idx.set(key, (bucket = []));
        bucket.push(row);
      }
      this.indexes.set(field, idx);
    }
  }

  plan(query: Query, params: readonly unknown[]): Plan | null {
    if (query.source.kind !== "ident" || query.source.name !== this.name) return null;
    if (query.from.length > 0 || query.follow) return null;

    const { pushed, residual } = partitionPushable(query.where, (e) => {
      const eq = asEquality(e);
      return eq != null && this.indexes.has(eq.field);
    });
    if (pushed.length === 0) return null; // no index probe available — let the scan handle it

    // Intersect the candidate sets from each indexed equality (smallest first).
    let candidate: unknown[] | null = null;
    for (const e of pushed) {
      const eq = asEquality(e)!;
      const bucket = this.indexes.get(eq.field)!.get(constValue(eq.value, params)) ?? [];
      candidate = candidate === null ? bucket.slice() : intersect(candidate, bucket);
    }
    const rows = candidate ?? [];
    return { rows: () => rows, residual: residualQuery(query, residual) };
  }
}

function intersect(a: unknown[], b: unknown[]): unknown[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}
