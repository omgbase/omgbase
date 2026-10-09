// An in-memory optimizing planner: it hash-indexes a named root collection on
// chosen fields and, for a query whose where-clause contains equality
// predicates on those fields, answers from the index (candidate intersection)
// instead of a full scan. Everything it can't turn into an index probe is left
// as a residual query the in-memory engine finishes over the candidate rows.
//
// This is the smallest honest demonstration of plan optimization: same answers
// as a naive scan, far fewer rows examined, and partial-pushdown correctness via
// the residual.
//
// The same indexes serve the engine's correlated probes: `context()` is a
// `DataContext` that resolves the root and answers `indexFor(collection, path)`
// from them, so a nested `^emp first { where id == ^manager_id }` probes the
// pre-built index instead of building one per run. The planner's own plans
// carry that context too, so a residual's nested blocks still see every root.
//
// Buckets are keyed under OQX equality (`HashIndex`): absent ≡ null, `-0` ≡ `0`,
// `NaN` matches nothing, objects by reference — exactly what `==` compares, so
// a probe returns the rows the scan would keep (a plain `Map` would keep `null`
// and `undefined` apart and match `NaN` to itself).

import type { Query } from "../ast.ts";
import type { DataContext } from "../context.ts";
import { DefaultContext } from "../context.ts";
import type { Plan, QueryPlanner } from "../planner.ts";
import { partitionPushable, residualQuery, asEquality, constValue, ROWS_ROOT } from "../plan.ts";
import type { RowIndex } from "../optimize/hash-index.ts";
import { HashIndex, intersectPositions } from "../optimize/hash-index.ts";

export class IndexedCollection implements QueryPlanner {
  private name: string;
  private rows: readonly unknown[];
  private indexes = new Map<string, HashIndex>();

  /** Index `rows` (exposed as root `name`) on each field in `indexFields`. A
   * field is read as the engine reads a bare identifier (own property; array
   * element for an integer-spelled name); a row without it keys as absent. */
  constructor(name: string, rows: readonly unknown[], indexFields: readonly string[]) {
    this.name = name;
    this.rows = rows;
    const read = new DefaultContext();
    for (const field of indexFields) {
      const idx = new HashIndex();
      rows.forEach((row, i) => idx.add(read.get(row, field), i));
      this.indexes.set(field, idx);
    }
  }

  /** The pre-built index for `collection` on `path` when `collection` is this
   * collection's rows and `path` is one indexed field — the `DataContext.indexFor`
   * seam, which `context()` wires up. */
  indexFor(collection: unknown, path: readonly string[]): RowIndex | undefined {
    if (collection !== this.rows || path.length !== 1) return undefined;
    return this.indexes.get(path[0]!);
  }

  /** A `DataContext` over plain objects that serves this collection as the
   * root `name` (plus `extraRoots`) and exposes the indexes through
   * `indexFor`, so the engine's correlated probes reuse them. */
  context(extraRoots: Record<string, unknown> = {}): DataContext {
    return new IndexedContext(this, { ...extraRoots, [this.name]: this.rows });
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
    const buckets = pushed.map((e) => {
      const eq = asEquality(e)!;
      return this.indexes.get(eq.field)!.lookup(constValue(eq.value, params));
    }).sort((a, b) => a.length - b.length);
    let candidate = buckets[0]!;
    for (let i = 1; i < buckets.length && candidate.length > 0; i++) candidate = intersectPositions(candidate, buckets[i]!);
    const rows = candidate.map((i) => this.rows[i]);
    return { rows: () => rows, residual: residualQuery(query, residual), context: this.context({ [ROWS_ROOT]: rows }) };
  }
}

class IndexedContext extends DefaultContext {
  private owner: IndexedCollection;

  constructor(owner: IndexedCollection, roots: Record<string, unknown>) {
    super(roots);
    this.owner = owner;
  }

  indexFor(collection: unknown, path: readonly string[]): RowIndex | undefined {
    return this.owner.indexFor(collection, path);
  }
}
