// The tier-2 seam: a DataContext binds OQX's query semantics to a concrete data
// model. The engine never touches host objects directly — it asks the context to
// resolve named roots, read properties/relations, coerce a relation result into
// rows, compute identity (for `follow` dedup), and optionally supply custom
// scalar functions/methods. This is what lets the same query semantics run over
// plain objects, a lazy ORM graph, or a remote API without changing the engine.
//
// (Performant execution over a real store is the tier-3 seam — see planner.ts —
// which pushes work into the store instead of driving it row-by-row here.)

import { coerceCollection, regexMatches, BUILTIN_FUNCTIONS, BUILTIN_METHODS } from "./semantics.ts";
import type { RegexDialect } from "./regex.ts";
import type { RowIndex } from "./optimize/hash-index.ts";

// An array's only properties are its integer indices, spelled canonically
// (`"0"`, `"12"`; never `"01"`, `"length"`, or a method name).
function isIndexKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key);
}

/** Result of a context-provided function/method call: `handled: false` tells the
 * engine to fall back to the builtin table (or error if none). */
export interface CallResult {
  handled: boolean;
  value?: unknown;
}

export interface DataContext {
  /** Resolve a named root collection (the `from <name>` / directive receiver). */
  root(name: string): unknown;
  /** The root scope's row — the host's root object: what `$it` is at the root
   * scope and `^$it` from a top-level row (SEMANTICS §2, since 0.18), so
   * `^$it.people` navigates it through `get` and `entries(^$it)` enumerates it.
   * Bare names at the root still resolve through `root(name)`, so a host with
   * lazy roots is unaffected. Optional: a context without it (or returning
   * `undefined`) has no root row — `$it` at the root is absent, the pre-0.18
   * behavior. `DefaultContext` returns its roots record. */
  rootObject?(): unknown;
  /** Read a property/relation off a row: a bare identifier (`field`), a
   * `.field` segment, or a `^field` outer reference all come through here, each
   * against exactly the row of the scope it names. An absent property is
   * `undefined`; the engine never looks elsewhere for it. A context may throw
   * (an `OqxError` with stage `"eval"`, or any error) to reject a read — a
   * reserved name, a failed store read — and the throw is the query's error. */
  get(row: unknown, key: string): unknown;
  /** Coerce a relation/source value into rows (may be lazy). */
  toRows(value: unknown): Iterable<unknown>;
  /** Optional: a value this context handed out as a stand-in for a collection
   * it has not read yet (a lazy table handle), resolved to what it stands for.
   * The engine calls it on every value it is about to observe AS A VALUE — an
   * operand of `==`/`in`/arithmetic, a function or method argument, a projected
   * item, an `order by` or `distinct` key, a `where` scalar, a lift — and never
   * on a value it reads in ROW POSITION (the query source, a block receiver, a
   * body-level `from`, a `follow` destination), which reaches `toRows` and
   * `indexFor` as handed out, so a store-backed context can answer a probe on
   * the handle without reading the table and still never lets the stand-in be
   * seen by the language. Absent = identity; a context whose handle already
   * behaves as the collection (a `Proxy` over an array) needs none. */
  materialize?(value: unknown): unknown;
  /** Identity of a row for `follow` cycle detection / dedup. */
  identity(row: unknown): unknown;
  /** Optional custom free function; return `{ handled: false }` to defer. */
  callFunction?(name: string, args: unknown[]): CallResult;
  /** Optional custom method; return `{ handled: false }` to defer. */
  callMethod?(name: string, recv: unknown, args: unknown[]): CallResult;
  /** The regex dialect `matches()` compiles against. `"oqx"` (the default when
   * absent) is the portable baseline the spec tests; `"native"` hands the
   * pattern to the host `RegExp` unvalidated — implementation-defined, not
   * portable. Note the engine dispatches `matches` through `callMethod`, so
   * this is read by the context's own `matches` (`DefaultContext` does;
   * `regexMatches(recv, args, dialect)` is the helper). `BUILTIN_METHODS.matches`
   * is always the baseline. */
  readonly regexDialect?: RegexDialect;
  /** Optional: a pre-built equality index over `collection` (a value this
   * context served as a root or relation) on the property path `path`
   * (`["customer_id"]`, `["meta", "id"]`; `[]` keys by the row itself). The
   * engine asks before building its own hash index for a correlated equality
   * in a nested block (`where id == ^customer_id`); return `undefined` to let
   * it build one. `lookup(value)` must return the ascending positions, into
   * `toRows(collection)` in order, of the rows whose value at `path` equals
   * `value` under OQX equality (SEMANTICS §5: absent ≡ null, `-0` ≡ `0`, `NaN`
   * matches nothing, objects by reference). `IndexedCollection.context()`
   * implements it over its indexes. */
  indexFor?(collection: unknown, path: readonly string[]): RowIndex | undefined;
}

export interface DefaultContextOptions {
  /** See `DataContext.regexDialect`. Default `"oqx"`. */
  regexDialect?: RegexDialect;
}

/** The default context: ordinary JavaScript objects. Named roots come from a
 * plain `{ name: collection }` map, which is also the root object (`^$it` from
 * a top-level row); properties are OWN keys only (an array exposes only its
 * integer indices, a primitive has none); identity is `.id` when present, else
 * the row itself (the engine keys it structurally). */
export class DefaultContext implements DataContext {
  private roots: Record<string, unknown>;
  readonly regexDialect: RegexDialect;

  constructor(roots: Record<string, unknown> = {}, options: DefaultContextOptions = {}) {
    this.roots = roots;
    this.regexDialect = options.regexDialect ?? "oqx";
  }

  root(name: string): unknown {
    return Object.hasOwn(this.roots, name) ? this.roots[name] : undefined;
  }

  rootObject(): unknown {
    return this.roots;
  }

  get(row: unknown, key: string): unknown {
    if (row == null || typeof row !== "object") return undefined;
    if (Array.isArray(row)) return isIndexKey(key) ? row[Number(key)] : undefined;
    return Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;
  }

  toRows(value: unknown): Iterable<unknown> {
    return coerceCollection(value);
  }

  identity(row: unknown): unknown {
    if (row != null && typeof row === "object" && "id" in row) return (row as Record<string, unknown>).id;
    return row;
  }

  callFunction(name: string, args: unknown[]): CallResult {
    const fn = Object.hasOwn(BUILTIN_FUNCTIONS, name) ? BUILTIN_FUNCTIONS[name] : undefined;
    return fn ? { handled: true, value: fn(args) } : { handled: false };
  }

  callMethod(name: string, recv: unknown, args: unknown[]): CallResult {
    if (name === "matches") return { handled: true, value: regexMatches(recv, args, this.regexDialect) };
    const fn = Object.hasOwn(BUILTIN_METHODS, name) ? BUILTIN_METHODS[name] : undefined;
    return fn ? { handled: true, value: fn(recv, args) } : { handled: false };
  }
}
