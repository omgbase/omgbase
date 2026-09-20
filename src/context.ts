// The tier-2 seam: a DataContext binds OQX's query semantics to a concrete data
// model. The engine never touches host objects directly — it asks the context to
// resolve named roots, read properties/relations, coerce a relation result into
// rows, compute identity (for `follow` dedup), and optionally supply custom
// scalar functions/methods. This is what lets the same query semantics run over
// plain objects, a lazy ORM graph, or a remote API without changing the engine.
//
// (Performant execution over a real store is the tier-3 seam — see planner.ts —
// which pushes work into the store instead of driving it row-by-row here.)

import { coerceCollection, BUILTIN_FUNCTIONS, BUILTIN_METHODS } from "./semantics.ts";

/** Result of a context-provided function/method call: `handled: false` tells the
 * engine to fall back to the builtin table (or error if none). */
export interface CallResult {
  handled: boolean;
  value?: unknown;
}

export interface DataContext {
  /** Resolve a named root collection (the `from <name>` / directive receiver). */
  root(name: string): unknown;
  /** Read a property/relation off a row: a bare identifier (`field`), a
   * `.field` segment, or a `^field` outer reference all come through here, each
   * against exactly the row of the scope it names. An absent property is
   * `undefined`; the engine never looks elsewhere for it. */
  get(row: unknown, key: string): unknown;
  /** Coerce a relation/source value into rows (may be lazy). */
  toRows(value: unknown): Iterable<unknown>;
  /** Identity of a row for `follow` cycle detection / dedup. */
  identity(row: unknown): unknown;
  /** Optional custom free function; return `{ handled: false }` to defer. */
  callFunction?(name: string, args: unknown[]): CallResult;
  /** Optional custom method; return `{ handled: false }` to defer. */
  callMethod?(name: string, recv: unknown, args: unknown[]): CallResult;
}

/** The default context: ordinary JavaScript objects. Named roots come from a
 * plain `{ name: collection }` map; properties are own/inherited keys; identity
 * is `.id` when present, else the object itself (reference identity). */
export class DefaultContext implements DataContext {
  private roots: Record<string, unknown>;

  constructor(roots: Record<string, unknown> = {}) {
    this.roots = roots;
  }

  root(name: string): unknown {
    return this.roots[name];
  }

  get(row: unknown, key: string): unknown {
    if (row == null) return undefined;
    return (Object(row) as Record<string, unknown>)[key];
  }

  toRows(value: unknown): Iterable<unknown> {
    return coerceCollection(value);
  }

  identity(row: unknown): unknown {
    if (row != null && typeof row === "object" && "id" in row) return (row as Record<string, unknown>).id;
    return row;
  }

  callFunction(name: string, args: unknown[]): CallResult {
    const fn = BUILTIN_FUNCTIONS[name];
    return fn ? { handled: true, value: fn(args) } : { handled: false };
  }

  callMethod(name: string, recv: unknown, args: unknown[]): CallResult {
    const fn = BUILTIN_METHODS[name];
    return fn ? { handled: true, value: fn(recv, args) } : { handled: false };
  }
}
