// A hash index over the rows of one collection, keyed under OQX equality
// (SEMANTICS §5) — the only key discipline that makes an index probe return
// exactly the rows a `local == value` scan would keep:
//
//   • absent is one value: `undefined` and `null` share a bucket;
//   • numbers are doubles: `-0` meets `0`; `NaN` equals nothing, so a row whose
//     key is `NaN` is never indexed and a probe for `NaN` finds nothing;
//   • strings, booleans and bigints key by value with a type tag, so `"5"`,
//     `5` and `true` stay apart;
//   • objects, arrays, functions and symbols key by REFERENCE — the reference
//     engine's `===` — never structurally.
//
// Buckets hold row POSITIONS in ascending order, so a probe yields rows in the
// receiver's order (§3 and §13 — a block's rows are the receiver's, in order).

/** A pre-built equality index a `DataContext` may expose for a collection
 * (see `DataContext.indexFor`): `lookup(value)` returns the ascending positions
 * (into `toRows(collection)`) of the rows whose key equals `value` under §5.
 *
 * `lookupRows`, when present, answers the same probe with the ROWS themselves —
 * exactly the rows `lookup(value)` would select, in receiver order — without
 * the engine ever materializing `toRows(collection)`. A store-backed context
 * implements it over its own indexes (one indexed statement per probe); the
 * engine prefers it for a statically stable receiver, so the collection is
 * never read whole. A throw is the query's error (as a `get` that throws is). */
export interface RowIndex {
  lookup(value: unknown): readonly number[];
  lookupRows?(value: unknown): Iterable<unknown>;
}

const NONE: readonly number[] = Object.freeze([]);

/** The engine's own `RowIndex`: `add` every row's key in row order, then probe. */
export class HashIndex implements RowIndex {
  private prim = new Map<string, number[]>();
  private refs = new Map<unknown, number[]>();
  private count = 0;

  /** Record that the row at `position` has key `value`. Positions must be
   * added in ascending order (row order). A `NaN` key is not indexed. */
  add(value: unknown, position: number): void {
    const k = primitiveKey(value);
    if (k === null) return; // NaN: equals nothing
    const map = k === undefined ? this.refs : this.prim;
    const key = k === undefined ? value : k;
    let bucket = map.get(key);
    if (!bucket) map.set(key, (bucket = []));
    bucket.push(position);
    this.count++;
  }

  lookup(value: unknown): readonly number[] {
    const k = primitiveKey(value);
    if (k === null) return NONE;
    return (k === undefined ? this.refs.get(value) : this.prim.get(k)) ?? NONE;
  }

  /** How many rows were indexed (rows with a `NaN` key are not). */
  get size(): number {
    return this.count;
  }
}

/** The tagged bucket key of a primitive, `null` for `NaN` (no key: it equals
 * nothing), `undefined` for a reference-keyed value (object, array, function,
 * symbol — compared by identity). Mirrors `semantics.equals`: `===` after
 * normalizing `undefined` to `null`. */
export function primitiveKey(v: unknown): string | null | undefined {
  switch (typeof v) {
    case "undefined": return "∅"; // absent ≡ absent
    case "object": return v === null ? "∅" : undefined;
    case "number": return Number.isNaN(v) ? null : `n${v}`; // `${-0}` is "0": -0 meets 0
    case "string": return `s${v}`;
    case "boolean": return v ? "t" : "f";
    case "bigint": return `i${v}`;
    default: return undefined; // function, symbol: reference identity
  }
}

/** Intersect two ascending position lists, ascending. */
export function intersectPositions(a: readonly number[], b: readonly number[]): readonly number[] {
  const out: number[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!, y = b[j]!;
    if (x === y) { out.push(x); i++; j++; }
    else if (x < y) i++;
    else j++;
  }
  return out;
}
