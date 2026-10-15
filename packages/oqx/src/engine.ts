// The in-memory execution engine (tier 1), now parameterized by a DataContext
// (tier 2) so it can drive any data model, and expressed behind an `Engine`
// interface so a pushdown planner (tier 3, planner.ts) is a drop-in alternative.
//
// Optimizations over a naive walk: `exists` short-circuits at the first match;
// `first` stops early when the result is unordered; `count` never materializes
// rows. (`single` always materializes, so its error reports the true row count,
// and `&&` evaluates strictly left to right — evaluation order is observable
// through errors, so the engine never reorders conjuncts.)
//
// Nested blocks run through the optimizer (`./optimize`): each block gets a
// `BlockPlan` the engine only EXECUTES (`access`), degrading to the plain scan
// whenever the planned access path is unavailable at run time. The rules and
// their semantics arguments live in `optimize/rules.ts`; `rules: []` turns the
// optimizer off, which the conformance suite uses to compare both paths.
//
// Name resolution is strictly lexical and LOCAL: a bare identifier is read from
// the current scope only, and an enclosing scope is reached solely through an
// explicit `^name` (exactly one scope out per caret). There is no implicit
// fall-through from an inner scope to an outer one — see `resolveIn`.

import type {
  Query, Where, Expr, OpNode, SelectItem, OrderSpec, Follow, Subquery,
} from "./ast.ts";
import { isRegexOp, REGEX_OPS } from "./ast.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { OqxError } from "./errors.ts";
import {
  relate, arith, membership, truthy, compareForSort, compare, canonicalKey, makeRange, isEntry, isRange, stringForm,
} from "./semantics.ts";
import type { BlockPlan, Correlation, Rule, RowIndex } from "./optimize/index.ts";
import { printTemplate } from "./print.ts";
import { DEFAULT_RULES, HashIndex, intersectPositions, lookupOrder, planFor, residualWithout } from "./optimize/index.ts";

/** The shaped result of a top-level query, discriminated by consumer. A
 * `collect` over a **single** receiver (one object, SEMANTICS §3) is one record
 * or absent rather than a list: `single` is true and `rows` holds at most that
 * one row (`unwrap` yields `rows[0] ?? null`). */
export type OqxResult =
  | { consumer: "collect"; rows: unknown[]; single: boolean }
  | { consumer: "exists"; exists: boolean }
  | { consumer: "none"; none: boolean }
  | { consumer: "count"; count: number }
  | { consumer: "first"; row: unknown | null }
  | { consumer: "single"; row: unknown | null };

/** A backend that runs a parsed Query with the given positional bindings. */
export interface Engine {
  run(query: Query, bindings: readonly unknown[]): OqxResult;
}

// One query scope: the row under evaluation plus the chain of enclosing scopes
// that `^` walks. The root scope (parent === null) is a row too: its row is the
// host's root object (`DataContext.rootObject`, since 0.18 — what `$it` is
// there and `^$it` from a top-level row), while its bare names are the
// context's named roots. `lifts` holds values bound INTO this scope by `^name:`
// items in nested blocks; `meta` holds the scope's intrinsics: recursion
// metadata for a follow occurrence, and `$key` for an entry scope (a row that
// arrived as an `entries()` entry — see `enter`).
interface Scope {
  row: unknown;
  parent: Scope | null;
  bindings: readonly unknown[];
  run: RunState;
  lifts?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /** The row as it arrived, when `row` is its unwrapped form (an entry's value):
   * what the group's `rows` hands back so a re-entered row is the same row. */
  raw?: unknown;
  /** Set on a GROUP scope (SEMANTICS §24): the scope's row is the key record,
   * `rows` the group's rows, and the aggregates reduce `rowScopes`. */
  group?: Group;
}

// One group of a `group by` body: the scopes of its rows (for the aggregates,
// which read each row as the body's `where` did — lifts and walk intrinsics
// included) and the rows themselves (what `rows` yields).
interface Group {
  rowScopes: Scope[];
  rows: unknown[];
}

// State that lives for exactly one `run()` (nothing here outlives it, so data
// that changes between runs is never served stale): the rule set, the receiver
// collections seen — by the receiver VALUE's identity, or by the block when its
// receiver is statically stable (see `access`) — the values of invariant
// blocks, and an optional trace sink.
interface RunState {
  rules: readonly Rule[];
  bindingCount: number;
  collections: WeakMap<object, CollectionState>;
  stableCollections: Map<OpNode, CollectionState>;
  memo: Map<OpNode, unknown>;
  trace?: (event: TraceEvent) => void;
}

// A receiver collection seen during a run: its value (what `toRows` coerces and
// what `indexFor` is asked about), how many times it was reached, its rows once
// materialized, and per local path the index serving it and what the context
// offered (`null`: none could be built / none was offered — the scan serves it).
interface CollectionState {
  value: unknown;
  seen: number;
  rows: Rows | null;
  indexes: Map<string, RowIndex | null>;
  contextIndexes: Map<string, RowIndex | null>;
}

/** What the optimizer did at run time (for tests and diagnostics): an index
 * built (or taken from the context) for a collection and path, a probe that
 * selected a bucket, a context index that answered a probe with rows directly
 * (`lookupRows`: the collection was never materialized), a memoized invariant
 * block reused, a consumer answered from a cardinality, or a probe that fell
 * back to the scan. */
export type TraceEvent =
  | { kind: "index"; path: readonly string[]; rows: number; source: "engine" | "context" }
  | { kind: "probe"; paths: readonly (readonly string[])[]; candidates: number }
  | { kind: "lookup"; path: readonly string[]; candidates: number }
  | { kind: "memo"; op: OpNode }
  | { kind: "cardinality"; count: number }
  | { kind: "fallback"; reason: "unstable" | "index" | "probe-value" | "not-a-collection" };

export interface InMemoryEngineOptions {
  /** The optimizer rules to apply to nested blocks (default `DEFAULT_RULES`);
   * `[]` runs the naive scan everywhere. */
  rules?: readonly Rule[];
  /** Receives a `TraceEvent` for each optimizer action during `run`. */
  trace?: (event: TraceEvent) => void;
}

const RECUR = new Set(["$depth", "$stop", "$leaf", "$frontier", "$ordinal"]);
const KEY = "$key";
const ROWS = "rows";
const HARD_DEPTH_CAP = 8;

// What a scope projects to: the select list plus the `values` mode flag. Both
// `Query` and `Subquery` carry this shape.
type Projection = Pick<Subquery, "select" | "values">;
// The grouping clauses of a body (0.24). Both `Query` and `Subquery` carry them.
type Grouping = Pick<Subquery, "groupBy" | "having">;

// The `$key: expr` item of a projection, if any — the identity the rows it
// yields carry (SEMANTICS §16, since 0.20).
function keyItem(proj: Projection): Extract<SelectItem, { kind: "field" }> | null {
  for (const it of proj.select) if (it.kind === "field" && it.lift === 0 && it.name === KEY) return it;
  return null;
}

// A row with the identity the walk knows it by.
interface Keyed { row: unknown; key: unknown; }

// The rows of a value in row position, and whether the value was a single row
// (one object) rather than a collection — which decides a block's result shape.
interface Rows { rows: unknown[]; single: boolean; }

// An evaluated `limit`/`offset` pair. `limit === null` is unbounded.
interface Bound { offset: number; limit: number | null; }
const UNBOUNDED: Bound = { offset: 0, limit: null };

export class InMemoryEngine implements Engine {
  private ctx: DataContext;
  private rules: readonly Rule[];
  private trace: ((event: TraceEvent) => void) | undefined;

  constructor(context: DataContext = new DefaultContext(), options: InMemoryEngineOptions = {}) {
    this.ctx = context;
    this.rules = options.rules ?? DEFAULT_RULES;
    this.trace = options.trace;
  }

  run(query: Query, bindings: readonly unknown[] = []): OqxResult {
    const run: RunState = {
      rules: this.rules,
      bindingCount: bindings.length,
      collections: new WeakMap(),
      stableCollections: new Map(),
      memo: new Map(),
    };
    if (this.trace) run.trace = this.trace;
    const root: Scope = { row: this.ctx.rootObject?.(), parent: null, bindings, run };
    const src = this.coerceRows(this.evalRaw(query.source, root), query.source);
    const rows = this.reproject(src.rows, query.from, root);
    // One object as the source yields one record (SEMANTICS §3) — unless a
    // `from` re-projection or a walk fans it out.
    const single = src.single && query.from.length === 0 && !query.follow;

    const bound = this.boundOf(query, root);
    if (query.follow) return this.runFollow(query, rows, root, bound);

    // Consumer-directed short-circuits (skipped under `distinct`, which must
    // materialize + dedup by projection before reducing, and under `group by`,
    // whose consumer counts groups). Counting never materializes rows;
    // exists/none stop as soon as the bound is known to be non-empty (the
    // (offset+1)th match — or the first, when unbounded).
    if (!query.distinct && !query.groupBy && (query.consumer === "exists" || query.consumer === "none" || query.consumer === "count")) {
      const need = query.consumer === "count" ? Infinity : bound.offset + 1;
      let n = 0;
      for (const r of rows) {
        if (this.matches(query.where, r, root)) { n++; if (n >= need) break; }
      }
      const m = boundedCount(n, bound);
      if (query.consumer === "count") return { consumer: "count", count: m };
      if (query.consumer === "exists") return { consumer: "exists", exists: m > 0 };
      return { consumer: "none", none: m === 0 };
    }

    // first over an unordered, non-distinct set needs only the rows up to the
    // bound (offset + 1). single materializes everything so its error can
    // report how many rows actually matched.
    const cap = query.consumer === "first" && !query.orderBy && !query.distinct && !query.groupBy
      ? bound.offset + Math.min(1, bound.limit ?? 1)
      : Infinity;
    let kept: Scope[] = [];
    for (const r of rows) {
      const s = this.enter(r, root, { lifts: {} });
      if (!query.where || this.evalWhere(query.where, s)) {
        kept.push(s);
        if (kept.length >= cap) break;
      }
    }
    if (query.groupBy) kept = this.groupScopes(kept, query, root);
    this.applyKey(kept, query);
    this.sortScopes(kept, query.orderBy);
    if (query.distinct) kept = this.dedupByProjection(kept, query);
    kept = sliceBound(kept, bound);
    return this.shape(query.consumer, kept, query, single);
  }

  // Evaluate a block's `limit`/`offset`. The bound is part of the block, so it
  // is read in a row-less scope INSIDE it: a bare name is absent (there is no
  // current item yet), `^name` is the enclosing row — exactly as in the block's
  // body — and literals/bindings are themselves. For a top-level query the
  // scope is the root scope WITHOUT its row (SEMANTICS §18): bare names are
  // still the named roots, but `$it` — reached through a bracket inside the
  // bound — is absent, not the root object. Each must be a non-negative integer.
  private boundOf(b: Pick<Subquery, "limit" | "offset">, enclosing: Scope): Bound {
    if (!b.limit && !b.offset) return UNBOUNDED;
    const scope: Scope = enclosing.parent === null
      ? { row: undefined, parent: null, bindings: enclosing.bindings, run: enclosing.run }
      : rowless(enclosing);
    const read = (e: Expr | null, word: string): number | null => {
      if (!e) return null;
      const v = this.evalExpr(e, scope);
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new OqxError(`${word} must be a non-negative integer (got ${JSON.stringify(v ?? null)})`, "eval");
      }
      return v;
    };
    return { offset: read(b.offset, "offset") ?? 0, limit: read(b.limit, "limit") };
  }

  // A where match that needs no lift capture (exists/count fast paths).
  private matches(where: Where | null, row: unknown, parent: Scope): boolean {
    if (!where) return true;
    return this.evalWhere(where, this.enter(row, parent));
  }

  // The rows of a value in row position (SEMANTICS §3): absent → none; an array
  // (or a host iterable) → its elements, a collection; an object → one row, and
  // the value is SINGLE — a block over it yields one result rather than a list;
  // a scalar (a string, a number, a boolean) or a range → an eval error. A
  // context says which of its objects are single (`isSingle`); without it, any
  // non-iterable object is.
  private coerceRows(v: unknown, what: Expr | null): Rows {
    if (v == null) return { rows: [], single: false };
    if (Array.isArray(v)) return { rows: v, single: false };
    if (typeof v !== "object" || isRange(v)) {
      const kind = isRange(v) ? "a range" : typeof v === "string" ? "a string" : typeof v === "number" ? "a number" : typeof v === "boolean" ? "a boolean" : `a ${typeof v}`;
      const shown = isRange(v) ? "" : ` (${JSON.stringify(v)})`;
      const subject = what ? `\`${describe(what)}\` is` : "the receiver is";
      throw new OqxError(`${subject} ${kind}${shown}, not a collection or an object — rows come from a collection (a list) or one object (a record)`, "eval");
    }
    const rows = Array.from(this.ctx.toRows(v));
    const single = this.ctx.isSingle ? this.ctx.isSingle(v) : !(Symbol.iterator in v);
    return { rows, single };
  }

  private rowsOf(v: unknown, what: Expr | null = null): unknown[] {
    return this.coerceRows(v, what).rows;
  }

  // The host's identity of a row (SEMANTICS §16): an entry is known by its key;
  // any other row by the context's `identityOf`, else by its structural value.
  private hostIdentity(row: unknown): unknown {
    if (isEntry(row)) return row.key;
    if (this.ctx.identityOf) return this.ctx.identityOf(row);
    if (this.ctx.identity) return this.ctx.identity(row);
    return row;
  }

  // The identity a scope's row is known by — `$key`: the identity the walk or a
  // `$key:` projection gave it (`meta`), else the host's.
  private scopeIdentity(scope: Scope): unknown {
    if (scope.meta && Object.hasOwn(scope.meta, KEY)) return scope.meta[KEY];
    if (scope.parent === null && scope.row === undefined) return undefined;
    return this.hostIdentity(scope.row);
  }

  // A projection's `$key: expr` item gives the rows it yields that identity:
  // evaluate it on each kept scope and record it as the scope's `$key`.
  private applyKey(scopes: Scope[], proj: Projection): void {
    const item = keyItem(proj);
    if (!item) return;
    for (const s of scopes) {
      const key = this.evalExpr(item.expr, s);
      s.meta = { ...(s.meta ?? {}), [KEY]: key };
    }
  }

  private child(row: unknown, parent: Scope): Scope {
    return this.enter(row, parent);
  }

  // Make the scope for a row. An `entries()` entry is unwrapped here: the scope's
  // row is the property's VALUE (so `$it` and bare names read it) and the key
  // becomes the `$key` intrinsic in `meta`. Every place a row becomes a scope
  // goes through this, so entries behave the same at the top level, in nested
  // blocks, as `from` re-projections, and as follow seeds.
  private enter(row: unknown, parent: Scope, extra: { lifts?: Record<string, unknown>; meta?: Record<string, unknown> } = {}): Scope {
    const s: Scope = { row, parent, bindings: parent.bindings, run: parent.run };
    if (extra.lifts) s.lifts = extra.lifts;
    if (extra.meta) s.meta = extra.meta;
    if (isEntry(row)) {
      s.raw = row;
      s.row = row.value;
      s.meta = { ...(s.meta ?? {}), [KEY]: row.key };
    }
    return s;
  }

  // ---- grouping (SEMANTICS §24) ----------------------------------------------

  // The kept scopes of a body, one GROUP scope per distinct key tuple, in order
  // of first appearance; then `having` over each group. A group scope sits where
  // the rows did (same parent, same depth): its row is the key record — one
  // property per key, in key order, holding the first row's value — so bare
  // names read the keys, `$it` is the record and `$key` its structural identity;
  // `rows` yields the group's rows and the aggregates reduce their scopes. Key
  // values compare as identities (§16): absent ≡ null, a host row by its id,
  // anything else structurally.
  private groupScopes(scopes: Scope[], body: Grouping, parent: Scope): Scope[] {
    const g = body.groupBy!;
    const groups = new Map<string, Scope>();
    for (const s of scopes) {
      const record: Record<string, unknown> = {};
      const ids: string[] = [];
      for (const k of g.keys) {
        const v = this.evalExpr(k.expr, s);
        record[k.name] = v;
        ids.push(canonicalKey(this.hostIdentity(v)));
      }
      const id = ids.join(" ");
      let gs = groups.get(id);
      if (!gs) {
        gs = { row: record, parent, bindings: parent.bindings, run: parent.run, lifts: {}, group: { rowScopes: [], rows: [] } };
        groups.set(id, gs);
      }
      gs.group!.rowScopes.push(s);
      gs.group!.rows.push(s.raw !== undefined ? s.raw : s.row);
    }
    const out = [...groups.values()];
    return body.having ? out.filter((gs) => this.evalWhere(body.having!, gs)) : out;
  }

  // An aggregate (§24) over the group of the scope it is read in. The argument
  // is read on each row's scope in group order; every value aggregate sees the
  // PRESENT values only (`count()` alone counts rows), `distinct` dedups them by
  // identity (§16), and `any`/`all` test truthiness (absent is false) and stop
  // at the first row that decides, like `||` / `&&`.
  private aggregate(e: Extract<Expr, { kind: "aggregate" }>, scope: Scope): unknown {
    const g = scope.group;
    if (!g) throw new OqxError(`\`${describe(e)}\` is an aggregate and is read on a group — it needs a \`group by\` in its body`, "eval");
    if (e.arg === null) return g.rowScopes.length;
    const arg = e.arg;
    if (e.name === "any") return g.rowScopes.some((s) => truthy(this.evalExpr(arg, s)));
    if (e.name === "all") return g.rowScopes.every((s) => truthy(this.evalExpr(arg, s)));
    let values: unknown[] = [];
    for (const s of g.rowScopes) {
      const v = this.evalExpr(arg, s);
      if (v != null) values.push(v);
    }
    if (e.distinct) {
      const seen = new Set<string>();
      values = values.filter((v) => {
        const k = canonicalKey(this.hostIdentity(v));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    switch (e.name) {
      case "count": return values.length;
      case "collect": return values;
      case "first": return values.length > 0 ? values[0] : undefined;
      case "last": return values.length > 0 ? values[values.length - 1] : undefined;
      case "sum": case "avg": {
        let total = 0;
        for (const v of values) {
          if (typeof v !== "number") {
            throw new OqxError(`cannot ${e.name === "sum" ? "sum" : "average"} \`${describe(arg)}\` over the group: it is ${describeValueKind(v)} — \`${e.name}\` takes numbers`, "eval");
          }
          total += v;
        }
        if (e.name === "sum") return total;
        return values.length === 0 ? undefined : total / values.length;
      }
      case "min": case "max": {
        if (values.length === 0) return undefined;
        let best = values[0];
        for (let i = 1; i < values.length; i++) {
          const c = compare(values[i], best);
          if (c !== undefined && (e.name === "min" ? c < 0 : c > 0)) best = values[i];
        }
        return best;
      }
    }
  }

  // ---- follow ---------------------------------------------------------------

  private runFollow(query: Query, rows: unknown[], root: Scope, bound: Bound): OqxResult {
    const { seed, post } = query.where ? partitionRecur(query.where) : { seed: null, post: null };
    const seeds = seed ? rows.filter((r) => this.matches(seed, r, root)) : rows;
    const occ = this.followWalk(this.keyed(seeds, query, root), query.follow!, query.frontier, root);
    let scopes: Scope[] = occ.map((o) => this.enter(o.row, root, { lifts: {}, meta: o.meta }));
    if (post) scopes = scopes.filter((s) => this.evalWhere(post, s));
    if (query.groupBy) scopes = this.groupScopes(scopes, query, root);
    this.sortScopes(scopes, query.orderBy);
    if (query.distinct) scopes = this.dedupByProjection(scopes, query);
    scopes = sliceBound(scopes, bound);
    return this.shape(query.consumer, scopes, query, false);
  }

  // The seeds of a walk with their identities: the body's `$key: expr` item,
  // read in each seed's scope, else the host's identity (SEMANTICS §20).
  private keyed(rows: unknown[], proj: Projection, parent: Scope): Keyed[] {
    const item = keyItem(proj);
    return rows.map((row) => ({ row, key: item ? this.evalExpr(item.expr, this.enter(row, parent)) : this.hostIdentity(row) }));
  }

  // Dedup scopes by their PROJECTED value (`distinct`): keep the first scope per
  // distinct projection, preserving order. An empty projection dedups by row
  // identity (so `count distinct { }` counts distinct rows). Both keys are
  // structural (`canonicalKey`): absent ≡ null, key order ignored, types kept
  // apart — never a host `String()`.
  private dedupByProjection(scopes: Scope[], proj: Projection): Scope[] {
    const seen = new Set<string>();
    const out: Scope[] = [];
    for (const s of scopes) {
      const key = proj.select.length === 0
        ? `i:${canonicalKey(this.scopeIdentity(s))}`
        : `p:${canonicalKey(this.projectRow(proj, s))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  // A bounded, per-path recursive walk. Each occurrence carries recursion
  // metadata: `$depth` (seed = 1), a categorical `$stop`, a deterministic
  // `$ordinal`, and `$key`, the identity it is known by. Semantics (SEMANTICS §20):
  //   • per-path — a node reached by N distinct paths yields N occurrences
  //     (unless `distinct`, which keeps the minimal (depth, path) per identity);
  //   • cycles are safe — revisiting an identity already on the current path
  //     admits ONE occurrence with `$stop == "cycle"` and does not expand it;
  //   • `$stop` ∈ interior | leaf | frontier | depth | cycle, with precedence
  //     cycle > frontier > depth > leaf > interior; only `interior` rows expand;
  //   • `$leaf` = (stop == leaf); `$frontier` = (stop ∈ {frontier, depth}) — the
  //     "there is unfollowed graph beyond me" signal;
  //   • identity is `$key` (since 0.20): a seed's is the body's `$key:` item or
  //     the host's identity; a successor's is its destination block's `$key:`
  //     item, else the host's identity of the yielded row. Identities compare
  //     structurally (`canonicalKey`); `$ordinal` paths compare component-wise
  //     (`comparePath`), so `10` follows `9`;
  //   • a row's successors are the destinations' rows in source order — a plain
  //     relation read in the row's scope, a destination block evaluated as a
  //     select-position directive in that scope (so `^` inside it is the frontier
  //     row and its `^people` receiver resolves one scope further out), shaped by
  //     the block's items other than `$key` — then unioned by identity within
  //     the step (a recurring identity is kept once, at its first position, and
  //     the destination that reached it first governs the occurrence);
  //   • a destination block's `depth n` (0.20) makes it decline to expand a
  //     frontier row whose `$depth >= n`; a row with no successors some
  //     destination declined is `depth`, with none declined `leaf`; the hard
  //     cap 8 is every destination's ceiling;
  //   • a destination block's `frontier P` marks the occurrences IT reached for
  //     which `P` holds (seeds are reached by none); `P` reads the occurrence's
  //     own scope with `^` the walk's enclosing scope, as the body does;
  //   • the body's own `frontier P` (`seedFrontier`, 0.20) marks the SEEDS for
  //     which `P` holds, read in the seed's scope exactly like the body's `where`.
  private followWalk(seeds: Keyed[], follow: Follow, seedFrontier: Expr | null, parent: Scope): Occurrence[] {
    const frontierScope = (k: Keyed): Scope => this.enter(k.row, parent, { meta: { [KEY]: k.key } });
    const succOf = (k: Keyed, depth: number): { succ: (Keyed & { via: number })[]; declined: boolean } => {
      const rowScope = frontierScope(k);
      const raw: (Keyed & { via: number })[] = [];
      let declined = false;
      follow.destinations.forEach((dest, via) => {
        if (dest.kind === "op") {
          if (dest.sub.depth !== null && depth >= dest.sub.depth) { declined = true; return; }
          for (const x of this.destinationRows(dest, rowScope)) raw.push({ ...x, via });
        } else {
          for (const row of this.rowsOf(this.evalRaw(dest, rowScope), dest)) raw.push({ row, key: this.hostIdentity(row), via });
        }
      });
      const seen = new Set<string>();
      const succ: (Keyed & { via: number })[] = [];
      for (const x of raw) {
        const key = canonicalKey(x.key);
        if (seen.has(key)) continue;
        seen.add(key);
        succ.push(x);
      }
      return { succ, declined };
    };
    const frontierHit = (k: Keyed, via: number | null): boolean => {
      if (via === null) return seedFrontier !== null && truthy(this.evalExpr(seedFrontier, frontierScope(k)));
      const dest = follow.destinations[via]!;
      if (dest.kind !== "op" || !dest.sub.frontier) return false;
      return truthy(this.evalExpr(dest.sub.frontier, frontierScope(k)));
    };

    interface Walked { row: unknown; depth: number; path: unknown[]; id: unknown; key: string; stop: string; }
    const walked: Walked[] = [];

    const visit = (k: Keyed, via: number | null, depth: number, ancestors: string[], ancestorIds: unknown[]): void => {
      const key = canonicalKey(k.key);
      const path = [...ancestorIds, k.key];
      let stop: string;
      if (ancestors.includes(key)) stop = "cycle";
      else if (frontierHit(k, via)) stop = "frontier";
      else if (depth >= HARD_DEPTH_CAP) stop = "depth";
      else {
        const { succ, declined } = succOf(k, depth);
        if (succ.length === 0) stop = declined ? "depth" : "leaf";
        else {
          walked.push({ row: k.row, depth, path, id: k.key, key, stop: "interior" });
          for (const x of succ) visit(x, x.via, depth + 1, [...ancestors, key], path);
          return;
        }
      }
      walked.push({ row: k.row, depth, path, id: k.key, key, stop });
    };
    for (const k of seeds) visit(k, null, 1, [], []);

    let rows = walked;
    if (follow.distinct) {
      // keep the minimal (depth, path) occurrence per identity key.
      const best = new Map<string, Walked>();
      for (const w of rows) {
        const prev = best.get(w.key);
        if (!prev || w.depth < prev.depth || (w.depth === prev.depth && comparePath(w.path, prev.path) < 0)) best.set(w.key, w);
      }
      rows = [...best.values()];
    }
    // $ordinal: a deterministic 1..N rank over (depth, path).
    rows = rows.slice().sort((a, b) => a.depth - b.depth || comparePath(a.path, b.path));
    return rows.map((w, i) => ({
      row: w.row,
      meta: {
        [KEY]: w.id,
        $depth: w.depth,
        $stop: w.stop,
        $leaf: w.stop === "leaf",
        $frontier: w.stop === "frontier" || w.stop === "depth",
        $ordinal: i + 1,
      },
    }));
  }

  // A destination block's successors for one frontier row, each with its
  // identity: the block's rows (its `where`, order, `distinct`, bound and
  // consumer applied — `first`/`single` yield at most one), shaped by its items
  // other than `$key` (the raw rows when none remain), keyed by its `$key:`
  // item read in the row's scope, else by the host's identity of the row yielded.
  private destinationRows(dest: OpNode, rowScope: Scope): Keyed[] {
    const { scopes } = this.evalCollectScopes(dest, rowScope, this.planOf(dest, rowScope), true);
    const key = keyItem(dest.sub);
    const shape: Projection = key ? { select: dest.sub.select.filter((it) => it !== key), values: dest.sub.values } : dest.sub;
    return scopes.map((s) => {
      const row = this.projectRow(shape, s);
      const id = key ? this.evalExpr(key.expr, s) : shape.select.length === 0 ? this.scopeIdentity(s) : this.hostIdentity(row);
      return { row, key: id };
    });
  }

  // ---- consumer shaping -----------------------------------------------------

  // `single` — the receiver was one object: a `collect` yields its one record
  // (or nothing) rather than a one-element list (SEMANTICS §3, §15).
  private shape(consumer: Query["consumer"], scopes: Scope[], proj: Projection, single: boolean): OqxResult {
    switch (consumer) {
      case "exists": return { consumer, exists: scopes.length > 0 };
      case "none": return { consumer, none: scopes.length === 0 };
      case "count": return { consumer, count: scopes.length };
      case "collect": return { consumer, rows: scopes.map((s) => this.projectRow(proj, s)), single };
      case "first": return { consumer, row: scopes.length > 0 ? this.projectRow(proj, scopes[0]!) : null };
      case "single":
        if (scopes.length > 1) throw new OqxError(`single { … } matched ${scopes.length} rows; use first { … } for zero-or-one`, "eval");
        return { consumer, row: scopes.length > 0 ? this.projectRow(proj, scopes[0]!) : null };
    }
  }

  // The per-row result: the raw row (empty projection), the single item's value
  // itself (`values` mode), or a `{ name: value }` record. A range is an
  // evaluation-time value only and never appears in a result.
  private projectRow(proj: Projection, scope: Scope): unknown {
    const { select } = proj;
    if (select.length === 0) return noRange(scope.row);
    if (proj.values) return noRange(this.itemValue(select[0]!, scope));
    const out: Record<string, unknown> = {};
    for (const item of select) out[item.name] = noRange(this.itemValue(item, scope));
    return out;
  }

  private itemValue(item: SelectItem, scope: Scope): unknown {
    return item.kind === "field" ? this.evalExpr(item.expr, scope) : this.evalCollectValue(item.op, scope);
  }

  // ---- where evaluation -----------------------------------------------------

  private evalWhere(w: Where, scope: Scope): boolean {
    switch (w.kind) {
      // Strictly left to right, short-circuiting: `false && f()` never evaluates
      // `f()`, so a query may guard an expensive or failing operand by position.
      case "and": return w.parts.every((p) => this.evalWhere(p, scope));
      case "or": return w.parts.some((p) => this.evalWhere(p, scope));
      case "not": return !this.evalWhere(w.expr, scope);
      case "scalar": return truthy(this.evalExpr(w.expr, scope));
      case "op": return this.evalWhereOp(w, scope);
    }
  }

  private evalWhereOp(op: OpNode, scope: Scope): boolean {
    if (op.sub.follow) throw new OqxError("`follow` is only valid on a select-position collect { … }, not a where op", "eval");
    const plan = this.planOf(op, scope);
    if (!plan.invariant) return this.evalWhereOpPlanned(op, plan, scope);
    return this.memoized(op, scope, () => this.evalWhereOpPlanned(op, plan, scope));
  }

  private evalWhereOpPlanned(op: OpNode, plan: BlockPlan, scope: Scope): boolean {
    const bound = this.boundOf(op.sub, scope);
    if (op.op === "exists" || op.op === "none" || op.op === "count") {
      const acc = this.access(op, plan, scope);
      let n: number;
      if (plan.fromCardinality && acc.where === null) {
        // Nothing left to evaluate per row: the accessed rows ARE the matched
        // rows, and the consumer only needs their count after the bound.
        n = boundedCount(acc.rows.length, bound);
        scope.run.trace?.({ kind: "cardinality", count: n });
      } else if (op.op !== "count" && bound === UNBOUNDED && !op.sub.groupBy) {
        // Unbounded exists/none: stop at the first match (dedup cannot change
        // emptiness). Bounded, or grouped (`having` may empty the groups): the
        // offset/limit decide emptiness, so materialize.
        n = this.anyMatch(op, scope, acc) ? 1 : 0;
      } else n = this.opRows(op, scope, bound, acc).length;
      if (op.op === "count") return op.countCmp ? compareCount(n, op.countCmp) : n > 0;
      return op.op === "exists" ? n > 0 : n === 0;
    }
    if (op.op === "collect") {
      const matched = this.opRows(op, scope, bound);
      for (const item of op.sub.select) {
        if (item.kind !== "field") continue;
        // Bind `item.lift` scopes out: `^` = the collect's own scope, `^^` its
        // parent, etc. Values flatten-append into the target scope, so repeated
        // evaluations (a deeper lift fanning out through intermediate scopes)
        // accumulate into one flat list rather than overwriting.
        let target: Scope = scope;
        for (let i = 1; i < item.lift && target.parent; i++) target = target.parent;
        const lifts = (target.lifts ??= {});
        const prior = Array.isArray(lifts[item.name]) ? (lifts[item.name] as unknown[]) : [];
        lifts[item.name] = prior.concat(matched.map((s) => this.evalExpr(item.expr, s)));
      }
      return matched.length > 0;
    }
    return this.opRows(op, scope, bound).length > 0;
  }

  // The rows a consumer op reduces: matched → grouped → ordered → distinct → bounded.
  private opRows(op: OpNode, scope: Scope, bound: Bound, acc?: Access): Scope[] {
    let scopes = this.matchRows(op, scope, acc);
    if (op.sub.groupBy) scopes = this.groupScopes(scopes, op.sub, scope);
    this.applyKey(scopes, op.sub);
    this.sortScopes(scopes, op.sub.orderBy);
    if (op.distinct) scopes = this.dedupByProjection(scopes, op.sub);
    return sliceBound(scopes, bound);
  }

  // Short-circuiting existence check: over a probe's bucket this stops at the
  // first row that passes the residual, so `exists`/`none` never materialize it.
  private anyMatch(op: OpNode, scope: Scope, acc?: Access): boolean {
    for (const s of this.iterMatchRows(op, scope, acc)) { void s; return true; }
    return false;
  }

  // The block's accessed rows, entered as scopes under `scope`, filtered by the
  // predicate the access left to evaluate.
  private *iterMatchRows(op: OpNode, scope: Scope, acc?: Access): Generator<Scope> {
    const { rows, where } = acc ?? this.access(op, this.planOf(op, scope), scope);
    for (const r of rows) {
      const s = this.enter(r, scope, { lifts: {} });
      if (!where || this.evalWhere(where, s)) yield s;
    }
  }

  private matchRows(op: OpNode, scope: Scope, acc?: Access): Scope[] {
    return Array.from(this.iterMatchRows(op, scope, acc));
  }

  // ---- planned access -------------------------------------------------------
  //
  // The engine EXECUTES a block's `BlockPlan`; the rules and the semantics
  // argument for each live in `./optimize` (rules.ts). `access` is the one path
  // every consumer takes to a block's rows, and whatever the plan asked for
  // that cannot be served at run time degrades to the scan the plan started from.

  private planOf(op: OpNode, scope: Scope): BlockPlan {
    return planFor(op, scopeDepth(scope), { bindingCount: scope.run.bindingCount }, scope.run.rules);
  }

  // An invariant block (rule 2) is evaluated the first time it is reached and
  // its value reused, by reference, for every other enclosing row.
  private memoized<T>(op: OpNode, scope: Scope, compute: () => T): T {
    const memo = scope.run.memo;
    if (memo.has(op)) { scope.run.trace?.({ kind: "memo", op }); return memo.get(op) as T; }
    const value = compute();
    memo.set(op, value);
    return value;
  }

  // A block's rows and the predicate left to evaluate over each. A correlated
  // plan is served, in order of preference, by a context index that yields rows
  // (`lookupRows` — asked on every sight: it costs nothing and the collection
  // is never read), by a probe on the engine's own index (built on the
  // collection's second sight, or at once for a statically stable receiver: a
  // collection seen once is cheaper to scan than to index), else by the scan.
  // A statically stable receiver (rule 1b) is evaluated once per run; any other
  // is keyed by its value's identity, so a fresh array per row is never indexed.
  private access(op: OpNode, plan: BlockPlan, scope: Scope): Access {
    const run = scope.run;
    let state = plan.receiverStable ? run.stableCollections.get(op) : undefined;
    if (!state) {
      const value = this.evalRaw(op.receiver, scope);
      if (plan.receiverStable) run.stableCollections.set(op, (state = newCollection(value)));
      else if (plan.correlated.length === 0) return this.scan(this.coerceRows(value, op.receiver), op, scope);
      else if (value !== null && typeof value === "object") {
        state = run.collections.get(value);
        if (!state) run.collections.set(value, (state = newCollection(value)));
      } else {
        run.trace?.({ kind: "fallback", reason: "not-a-collection" });
        return this.scan(this.coerceRows(value, op.receiver), op, scope);
      }
    }
    state.seen++;
    if (plan.correlated.length > 0) {
      const direct = this.lookupRows(plan, state, scope);
      if (direct) return direct;
      if (state.seen >= 2 || plan.receiverStable) {
        const probed = this.probe(plan, state, scope, op);
        if (probed) return { rows: probed, where: plan.residual, single: false };
      } else run.trace?.({ kind: "fallback", reason: "unstable" });
    }
    return this.scan(this.materialize(state, op), op, scope);
  }

  // The plain scan: the rows, re-projected by `from`, with the whole `where`.
  // A `from` re-projection fans a single receiver out: the block is plural.
  private scan(src: Rows, op: OpNode, scope: Scope): Access {
    return { rows: this.reproject(src.rows, op.sub.from, scope), where: op.sub.where, single: src.single && op.sub.from.length === 0 };
  }

  private reproject(rows: unknown[], from: readonly Expr[], scope: Scope): unknown[] {
    for (const proj of from) rows = rows.flatMap((r) => this.rowsOf(this.evalRaw(proj, this.child(r, scope)), proj));
    return rows;
  }

  private materialize(state: CollectionState, op: OpNode): Rows {
    return (state.rows ??= this.coerceRows(state.value, op.receiver));
  }

  // A probe answered by a context index that yields rows directly, before the
  // collection is materialized: one correlation is probed (`lookupOrder`) and
  // every other conjunct stays in place per selected row (`residualWithout`).
  private lookupRows(plan: BlockPlan, state: CollectionState, scope: Scope): Access | null {
    for (const c of lookupOrder(plan)) {
      const index = this.contextIndex(state, c);
      if (!index?.lookupRows) continue;
      const outer = this.outerValue(c, scope);
      if (!outer) return null;
      const rows = Array.from(index.lookupRows(outer.value));
      scope.run.trace?.({ kind: "lookup", path: c.path, candidates: rows.length });
      return { rows, where: residualWithout(plan, c), single: false };
    }
    return null;
  }

  // The engine's probe: one bucket per correlation, intersected smallest-first;
  // the candidates come back in receiver order. `null` (an index that could
  // not be built, an outer value whose evaluation threw) leaves the scan in charge.
  private probe(plan: BlockPlan, state: CollectionState, scope: Scope, op: OpNode): unknown[] | null {
    const run = scope.run;
    const rows = this.materialize(state, op).rows;
    const buckets: (readonly number[])[] = [];
    for (const c of plan.correlated) {
      const index = this.indexFor(state, c, scope, op);
      if (!index) { run.trace?.({ kind: "fallback", reason: "index" }); return null; }
      const outer = this.outerValue(c, scope);
      if (!outer) return null;
      buckets.push(index.lookup(outer.value));
    }
    buckets.sort((a, b) => a.length - b.length);
    let candidates = buckets[0]!;
    for (let i = 1; i < buckets.length && candidates.length > 0; i++) candidates = intersectPositions(candidates, buckets[i]!);
    run.trace?.({ kind: "probe", paths: plan.correlated.map((c) => c.path), candidates: candidates.length });
    return candidates.map((i) => rows[i]);
  }

  // A correlation's outer side, read once in a row-less scope inside the block
  // (as a bound is); `null` when it threw — the scan then raises it in place.
  private outerValue(c: Correlation, scope: Scope): { value: unknown } | null {
    try { return { value: this.evalExpr(c.outer, rowless(scope)) }; }
    catch { scope.run.trace?.({ kind: "fallback", reason: "probe-value" }); return null; }
  }

  // The context's pre-built index on a correlation's local path, if it offers
  // one (asked once per collection and path; a refusal is cached too).
  private contextIndex(state: CollectionState, c: Correlation): RowIndex | null {
    const key = pathKey(c.path);
    let index = state.contextIndexes.get(key);
    if (index === undefined) state.contextIndexes.set(key, (index = this.ctx.indexFor?.(state.value, c.path) ?? null));
    return index;
  }

  // The index serving a correlation's local path: the context's, else one built
  // here by evaluating the local expression in each row's scope — the same read
  // the scan performs, so the keys are exactly what `==` would compare. A throw
  // while building (a context that rejects a read) leaves the path un-indexed.
  private indexFor(state: CollectionState, c: Correlation, scope: Scope, op: OpNode): RowIndex | null {
    const key = pathKey(c.path);
    const hit = state.indexes.get(key);
    if (hit !== undefined) return hit;
    const rows = this.materialize(state, op).rows;
    let index = this.contextIndex(state, c);
    let source: "context" | "engine" = "context";
    if (!index) {
      source = "engine";
      const built = new HashIndex();
      try {
        for (let i = 0; i < rows.length; i++) built.add(this.evalExpr(c.local, this.enter(rows[i], scope)), i);
        index = built;
      } catch { /* un-indexed: the scan serves this path */ }
    }
    if (index) scope.run.trace?.({ kind: "index", path: c.path, rows: rows.length, source });
    state.indexes.set(key, index);
    return index;
  }

  // A select-position collect/first/single, optionally recursive via `follow`.
  private evalCollectValue(op: OpNode, scope: Scope): unknown {
    const plan = this.planOf(op, scope);
    if (!plan.invariant) return this.evalCollectValuePlanned(op, plan, scope);
    return this.memoized(op, scope, () => this.evalCollectValuePlanned(op, plan, scope));
  }

  private evalCollectValuePlanned(op: OpNode, plan: BlockPlan, scope: Scope): unknown {
    const { scopes, single } = this.evalCollectScopes(op, scope, plan);
    switch (op.op) {
      // Over a single receiver (one object) a `collect` is the record or absent,
      // not a one-element list (SEMANTICS §3).
      case "collect": return single ? (scopes.length > 0 ? this.projectRow(op.sub, scopes[0]!) : undefined) : scopes.map((s) => this.projectRow(op.sub, s));
      // `count { … }` as a value (0.24): the number of rows the block yields.
      case "count": return scopes.length;
      default: return scopes.length > 0 ? this.projectRow(op.sub, scopes[0]!) : null;
    }
  }

  // The rows a select-position directive yields, as scopes, reduced by its
  // consumer (`first`/`single` keep at most one; `single` raises on more), and
  // whether its receiver was a single object. `destination` marks a follow
  // destination block: its `frontier` is the destination's (read by the outer
  // walk), never a seed frontier for a `follow` of its own.
  private evalCollectScopes(op: OpNode, scope: Scope, plan: BlockPlan = this.planOf(op, scope), destination = false): { scopes: Scope[]; single: boolean } {
    const sub = op.sub;
    const bound = this.boundOf(sub, scope);
    let scopes: Scope[];
    let single = false;
    if (sub.follow) {
      // The seeds are the matched rows themselves (`followWalk` enters them); a
      // follow block is never correlated, so `where` here is the whole predicate.
      const { rows, where } = this.access(op, plan, scope);
      const seeds = where ? rows.filter((r) => this.evalWhere(where, this.enter(r, scope, { lifts: {} }))) : rows;
      scopes = this.followWalk(this.keyed(seeds, sub, scope), sub.follow, destination ? null : sub.frontier, scope).map((o) => this.enter(o.row, scope, { meta: o.meta }));
      if (sub.groupBy) scopes = this.groupScopes(scopes, sub, scope);
      this.sortScopes(scopes, sub.orderBy);
      if (op.distinct) scopes = this.dedupByProjection(scopes, sub);
      scopes = sliceBound(scopes, bound);
    } else {
      const acc = this.access(op, plan, scope);
      single = acc.single;
      scopes = this.opRows(op, scope, bound, acc);
    }
    switch (op.op) {
      case "collect": case "count": return { scopes, single };
      case "first": return { scopes: scopes.slice(0, 1), single };
      case "single":
        if (scopes.length > 1) throw new OqxError(`single { … } for '${describeReceiver(op.receiver)}' matched ${scopes.length} rows`, "eval");
        return { scopes, single };
      default: throw new OqxError(`${op.op} { … } is not valid in select position`, "eval");
    }
  }

  // ---- ordering -------------------------------------------------------------

  private sortScopes(scopes: Scope[], orderBy: OrderSpec[] | null): void {
    if (!orderBy || orderBy.length === 0) return;
    scopes.sort((a, b) => {
      for (const spec of orderBy) {
        const av = this.evalExpr(spec.expr, a);
        const bv = this.evalExpr(spec.expr, b);
        // Absent (null/undefined) sorts LAST regardless of direction: `desc`
        // reverses the ordering of PRESENT values only, and must not hoist rows
        // that lack the sort key to the top. (Negating the direction over
        // `compareForSort`'s absent-handling result would flip absent-last to
        // absent-first under `desc` — the bug this guards against.)
        const an = av == null, bn = bv == null;
        if (an && bn) continue;
        if (an) return 1;
        if (bn) return -1;
        const c = compareForSort(av, bv);
        if (c !== 0) return spec.desc ? -c : c;
      }
      return 0;
    });
  }

  // ---- scalar expression evaluation -----------------------------------------

  // An expression as a VALUE: whatever `evalRaw` yields, with a context's lazy
  // stand-in resolved (`DataContext.materialize`), so no operand, argument, key
  // or projected item ever observes a value the context meant as a collection
  // it had not read yet.
  private evalExpr(e: Expr, scope: Scope): unknown {
    const v = this.evalRaw(e, scope);
    return this.ctx.materialize ? this.ctx.materialize(v) : v;
  }

  // An expression as the context handed it out — for ROW POSITION only (the
  // source, a receiver, a `from`, a `follow` destination), where the value goes
  // straight to `toRows` / `indexFor`. Operands inside it are values (`evalExpr`).
  private evalRaw(e: Expr, scope: Scope): unknown {
    switch (e.kind) {
      case "lit": return e.value;
      case "binding":
        if (e.index >= scope.bindings.length) {
          throw new OqxError(`binding \${${e.index}} is out of range: the query references ${e.index + 1} value${e.index === 0 ? "" : "s"} but ${scope.bindings.length} ${scope.bindings.length === 1 ? "was" : "were"} given`, "eval");
        }
        return scope.bindings[e.index];
      case "ident": return this.resolveIn(e.name, scope);
      case "outer": {
        // `^name` reads from EXACTLY `levels` scopes out — the target scope is
        // resolved locally, never climbed further. Past the root it is absent.
        let s: Scope | null = scope;
        for (let i = 0; i < e.levels && s; i++) s = s.parent;
        return s ? this.resolveIn(e.name, s) : undefined;
      }
      case "member": {
        const r = this.evalExpr(e.recv, scope);
        return r == null ? undefined : this.ctx.get(r, e.name);
      }
      case "call": return this.evalCall(e, scope);
      case "unary": {
        const v = this.evalExpr(e.expr, scope);
        if (e.op === "!") return !truthy(v);
        return v == null ? undefined : -(v as number);
      }
      // `x!` — the value, or an eval error naming the expression (and the row's
      // identity when it has a scalar one). Never a filter, never a coercion.
      case "required": {
        const v = this.evalExpr(e.expr, scope);
        if (v == null) throw new OqxError(`\`${describe(e.expr)}!\` is absent${this.rowIdentity(scope)}`, "eval");
        return v;
      }
      // A value-position directive (`jobs first { … }.pay`, the desugared `x[…]`).
      case "op": return this.evalCollectValue(e, scope);
      case "binary": {
        const l = this.evalExpr(e.left, scope);
        const r = this.evalExpr(e.right, scope);
        if (e.op === "is" || e.op === "is not") {
          // Identity (SEMANTICS §5b): the host's identity of each side,
          // compared structurally — the key `distinct` and `follow` use.
          const same = canonicalKey(this.hostIdentity(l)) === canonicalKey(this.hostIdentity(r));
          return e.op === "is" ? same : !same;
        }
        if (isRegexOp(e.op)) {
          // The regex operators (SEMANTICS §11, since 0.22) are sugar over
          // `matches`: `a ~ b` is `a.matches(b)`, `~*` adds the `i` flag, `!~`
          // / `!~*` negate. They go through the same method dispatch as the
          // call would, so a host's `matches` (and its regex dialect) applies.
          const { negated, flags } = REGEX_OPS[e.op];
          const hit = this.callMethod("matches", l, flags === undefined ? [r] : [r, flags]);
          return negated ? !truthy(hit) : hit;
        }
        return isRelOp(e.op) ? relate(e.op, l, r) : arith(e.op, l, r);
      }
      case "logical": {
        const l = this.evalExpr(e.left, scope);
        if (e.op === "&&") return truthy(l) ? this.evalExpr(e.right, scope) : l;
        return truthy(l) ? l : this.evalExpr(e.right, scope);
      }
      case "in": return membership(this.evalExpr(e.left, scope), this.evalExpr(e.right, scope));
      case "range": return makeRange(
        e.lo == null ? null : this.evalExpr(e.lo, scope),
        e.hi == null ? null : this.evalExpr(e.hi, scope),
        e.exclusiveEnd);
      // A tuple (SEMANTICS §3b): the elements in order, concatenated with ONE
      // level of flattening — a collection contributes its items, anything else
      // itself; an absent (`undefined`) element contributes nothing, a `null`
      // one `null`; duplicates are kept.
      case "tuple": {
        const out: unknown[] = [];
        for (const item of e.items) {
          const v = this.evalExpr(item, scope);
          if (v === undefined) continue;
          if (Array.isArray(v)) out.push(...v);
          else if (v !== null && typeof v === "object" && !isEntry(v) && !isRange(v) && Symbol.iterator in v) out.push(...(v as Iterable<unknown>));
          else out.push(v);
        }
        return out;
      }
      // A template literal (SEMANTICS §7b): the text parts verbatim and each
      // interpolated value's string form (§7), concatenated. Every interpolation
      // is evaluated, in order; a list, a record or a range is an eval error (it
      // has no string form the language specifies); an absent value makes the
      // whole literal absent, as `+` does.
      case "template": {
        let out = "";
        let absent = false;
        for (const part of e.parts) {
          if (typeof part === "string") { out += part; continue; }
          const v = this.evalExpr(part, scope);
          if (v == null) { absent = true; continue; }
          if (typeof v === "object") {
            const what = isRange(v) ? "a range" : Array.isArray(v) || Symbol.iterator in v ? "a list" : "a record";
            throw new OqxError(`cannot interpolate \`\${${describe(part)}}\` in a template literal: it is ${what} — only a string, a number, a boolean or an absent value has a string form`, "eval");
          }
          out += stringForm(v)!;
        }
        return absent ? undefined : out;
      }
      // An aggregate (SEMANTICS §24) over the group of the current scope.
      case "aggregate": return this.aggregate(e, scope);
    }
  }

  // Resolve a name against ONE scope — never its ancestors. A scope provides,
  // in order: `$it` (the scope's row itself — the current item, whatever its
  // type, so scalar collections are queryable; at the root the host's root
  // object, since 0.18; `$value`, its pre-0.15 spelling, is an ordinary
  // property name now); `$key` (the property key) when it is an entry scope —
  // see `enter`; the recursion intrinsics (`$depth`, …) when it is a follow
  // occurrence; values lifted into it by `^name:` items; then either the row's
  // own property or, for the root scope, the context's named roots (`root(name)`
  // — never a property of the root object, so a host with lazy roots is
  // unaffected by what its root object holds).
  //
  // The two metadata steps apply only where the scope CARRIES that metadata
  // (SEMANTICS §2, since 0.13). Anywhere else — `$key` on an ordinary row,
  // `$depth` outside a follow or on the plain rows of a nested block inside
  // one — the name is an ordinary property read, so a host whose rows own a
  // `$depth`/`$ordinal` (omgbase's blocks do) exposes it. Where the metadata
  // exists it wins over a same-named row property.
  //
  // A name the scope lacks is simply absent (undefined). It does NOT fall
  // through to an enclosing scope, so a query's meaning never depends on which
  // properties an inner row happens to have: adding a same-named property to an
  // inner row cannot capture an outer reference, and an outer reference is
  // always spelled explicitly as `^name`. Present-but-falsy values (null, false,
  // 0, "") need no special case — there is no "absent, so look outward" rule.
  private resolveIn(name: string, scope: Scope): unknown {
    if (name === "$it") return scope.row;
    // `$key` is the row's identity on every row (SEMANTICS §16, since 0.20).
    if (name === KEY) return this.scopeIdentity(scope);
    // `rows` on a group scope is the group's rows (§24); elsewhere a property.
    if (name === ROWS && scope.group) return scope.group.rows;
    if (RECUR.has(name) && scope.meta && Object.hasOwn(scope.meta, name)) return scope.meta[name];
    if (scope.lifts && Object.hasOwn(scope.lifts, name)) return scope.lifts[name];
    if (scope.parent === null) return this.ctx.root(name);
    return this.ctx.get(scope.row, name);
  }

  // ` on <identity>` for a required-value error when the scope's row has a
  // scalar identity (`$key`: the host's, an entry's key, a `$key:` projection);
  // empty otherwise, and at the root (the root object is not a row of the data).
  private rowIdentity(scope: Scope): string {
    if (scope.parent === null || scope.row == null) return "";
    const id = this.scopeIdentity(scope);
    return typeof id === "string" || typeof id === "number" ? ` on ${JSON.stringify(id)}` : "";
  }

  private evalCall(e: Extract<Expr, { kind: "call" }>, scope: Scope): unknown {
    const args = e.args.map((a) => this.evalExpr(a, scope));
    if (e.recv === null) {
      const r = this.ctx.callFunction?.(e.name, args);
      if (r?.handled) return r.value;
      throw new OqxError(`unknown function '${e.name}(…)'`, "eval");
    }
    const recv = this.evalExpr(e.recv, scope);
    return this.callMethod(e.name, recv, args);
  }

  // `recv.name(args)` on evaluated values — the dispatch a method call and the
  // regex operators share.
  private callMethod(name: string, recv: unknown, args: unknown[]): unknown {
    const r = this.ctx.callMethod?.(name, recv, args);
    if (r?.handled) return r.value;
    throw new OqxError(`unknown method '.${name}(…)'`, "eval");
  }
}

interface Occurrence { row: unknown; meta: Record<string, unknown>; }

// A block's accessed rows, the predicate still to evaluate over each, and
// whether the receiver was a single object (SEMANTICS §3).
interface Access { rows: unknown[]; where: Where | null; single: boolean; }

// ---- free helpers -----------------------------------------------------------

function newCollection(value: unknown): CollectionState {
  return { value, seen: 0, rows: null, indexes: new Map(), contextIndexes: new Map() };
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

// A row-less scope INSIDE a block: a bare name is absent, `^name` is the
// enclosing row — how a block's bound and a probe's outer value are read.
function rowless(enclosing: Scope): Scope {
  return { row: undefined, parent: enclosing, bindings: enclosing.bindings, run: enclosing.run };
}

// How many scopes out the root is (the root itself is 0).
function scopeDepth(scope: Scope): number {
  let d = 0;
  for (let s = scope; s.parent !== null; s = s.parent) d++;
  return d;
}

function isRelOp(op: string): boolean {
  return op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=";
}

// Guard a value bound for a result: a range (`lo..hi`) exists only during
// evaluation. Checks the value itself and, for an array, its elements — deeper
// structure is host data (which cannot hold a range) or a nested block's
// result (already guarded when it was projected).
function noRange(v: unknown): unknown {
  if (isRange(v) || (Array.isArray(v) && v.some(isRange))) {
    throw new OqxError("a range (lo..hi) cannot appear in a result; test membership with `x in lo..hi` instead", "eval");
  }
  return v;
}

// Order two `follow` paths (identity sequences of equal depth) component-wise:
// two numbers numerically, two strings by code point; otherwise numbers precede
// strings precede everything else, and same-kind others order by canonical key.
function comparePath(a: unknown[], b: unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareComponent(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function compareComponent(x: unknown, y: unknown): number {
  const c = compare(x, y);
  if (c !== undefined) return c;
  const rx = componentRank(x), ry = componentRank(y);
  if (rx !== ry) return rx - ry;
  const kx = canonicalKey(x), ky = canonicalKey(y);
  return kx < ky ? -1 : kx > ky ? 1 : 0;
}

function componentRank(v: unknown): number {
  return typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
}

function compareCount(n: number, cmp: { op: string; value: number }): boolean {
  return relate(cmp.op, n, cmp.value);
}

// Apply a bound to an ordered row set / to a match count.
function sliceBound<T>(rows: T[], b: Bound): T[] {
  if (b === UNBOUNDED) return rows;
  return rows.slice(b.offset, b.limit == null ? undefined : b.offset + b.limit);
}
function boundedCount(n: number, b: Bound): number {
  const rest = Math.max(0, n - b.offset);
  return b.limit == null ? rest : Math.min(rest, b.limit);
}

// The canonical text of an expression for an error message; a binding shows as
// its `${n}` marker (the printer refuses to turn a bound value into source).
function describe(e: Expr): string {
  const t = printTemplate(e);
  return t.strings.map((s, i) => (i < t.count ? `${s}\${${t.indices[i]}}` : s)).join("");
}

// The kind of a value, for an aggregate's error: `a string ("abc")`, `a list`, …
function describeValueKind(v: unknown): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return `a ${typeof v} (${JSON.stringify(v)})`;
  if (isRange(v)) return "a range";
  if (Array.isArray(v) || (typeof v === "object" && v !== null && !isEntry(v) && Symbol.iterator in v)) return "a list";
  return "a record";
}

function describeReceiver(e: Expr): string {
  if (e.kind === "ident") return e.name;
  if (e.kind === "member") return `${describeReceiver(e.recv)}.${e.name}`;
  if (e.kind === "binding") return `\${${e.index}}`;
  return "receiver";
}

// Split a follow query's `where` into seed conjuncts (no recursion intrinsic
// mentioned) and post-walk conjuncts. The test is syntactic — a bare `$depth`
// in the body of a follow always names the occurrence's metadata, so no
// property read can be mistaken for it here; without a `follow` this split is
// never consulted and `$depth` is an ordinary predicate over the row.
function partitionRecur(w: Where): { seed: Where | null; post: Where | null } {
  const parts = w.kind === "and" ? w.parts : [w];
  const seed: Where[] = [];
  const post: Where[] = [];
  for (const p of parts) (whereHasRecur(p) ? post : seed).push(p);
  const rebuild = (ps: Where[]): Where | null => (ps.length === 0 ? null : ps.length === 1 ? ps[0]! : { kind: "and", span: [0, 0], parts: ps });
  return { seed: rebuild(seed), post: rebuild(post) };
}

function whereHasRecur(w: Where): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.some(whereHasRecur);
    case "not": return whereHasRecur(w.expr);
    case "scalar": return exprHasRecur(w.expr);
    case "op": return false;
  }
}

function exprHasRecur(e: Expr): boolean {
  switch (e.kind) {
    case "ident": return RECUR.has(e.name);
    case "member": return exprHasRecur(e.recv);
    case "call": return (e.recv ? exprHasRecur(e.recv) : false) || e.args.some(exprHasRecur);
    case "unary": case "required": return exprHasRecur(e.expr);
    case "binary": case "logical": case "in": return exprHasRecur(e.left) || exprHasRecur(e.right);
    case "range": return (e.lo != null && exprHasRecur(e.lo)) || (e.hi != null && exprHasRecur(e.hi));
    case "tuple": return e.items.some(exprHasRecur);
    case "template": return e.parts.some((p) => typeof p !== "string" && exprHasRecur(p));
    case "aggregate": return e.arg !== null && exprHasRecur(e.arg);
    default: return false;
  }
}
