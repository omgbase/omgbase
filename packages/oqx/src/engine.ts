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
// Nested blocks additionally run through the optimizer (`./optimize`): each
// block gets a `BlockPlan` — a correlated equality (`id == ^customer_id`)
// becomes a hash probe on the receiver, a block that reads nothing from the
// enclosing rows is evaluated once per run, an `exists`/`count` with nothing
// left to check per row is answered from a cardinality. Every rule carries a
// proof that it is unobservable (same rows, lifts and errors); `rules: []`
// turns the optimizer off, which the conformance suite uses to compare both
// paths over every spec fixture.
//
// Name resolution is strictly lexical and LOCAL: a bare identifier is read from
// the current scope only, and an enclosing scope is reached solely through an
// explicit `^name` (exactly one scope out per caret). There is no implicit
// fall-through from an inner scope to an outer one — see `resolveIn`.

import type {
  Query, Where, Expr, OpNode, SelectItem, OrderSpec, Follow, Subquery,
} from "./ast.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { OqxError } from "./errors.ts";
import {
  relate, arith, membership, truthy, compareForSort, compare, canonicalKey, makeRange, isEntry, isRange,
} from "./semantics.ts";
import type { BlockPlan, Correlation, Rule, RowIndex } from "./optimize/index.ts";
import { DEFAULT_RULES, HashIndex, conjunction, conjuncts, intersectPositions, planFor } from "./optimize/index.ts";

/** The shaped result of a top-level query, discriminated by consumer. */
export type OqxResult =
  | { consumer: "collect"; rows: unknown[] }
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
// that `^` walks. The root scope (parent === null) has no row; its names are the
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
}

// State that lives for exactly one `run()`: the optimizer's rule set, the
// per-collection materialized rows and indexes, the memoized values of
// invariant blocks, and an optional trace sink. Nothing here outlives the run,
// so data that changes between runs is never served stale.
interface RunState {
  rules: readonly Rule[];
  bindingCount: number;
  /** Collections keyed by the receiver VALUE's identity (a per-row receiver
   * that evaluates to a fresh array each time is never found twice). */
  collections: WeakMap<object, CollectionState>;
  /** Collections keyed by the block whose receiver is statically stable
   * (reads only the root scope / bindings), evaluated once per run — and, with
   * a correlation to probe, materialized only when no context index answers
   * the probe with rows directly. */
  stableCollections: Map<OpNode, CollectionState>;
  /** Values of invariant blocks, by block. */
  memo: Map<OpNode, { value: unknown }>;
  trace?: (event: TraceEvent) => void;
}

// A receiver collection seen during a run: how many times it was probed, its
// rows once materialized, and its indexes by local path (`null` marks a path
// whose index could not be built — the scan serves it).
interface CollectionState {
  /** The receiver's value (what `toRows` coerced and what `indexFor` is asked about). */
  value: unknown;
  seen: number;
  rows: unknown[] | null;
  /** The index serving each local path (`null`: none could be built). */
  indexes: Map<string, RowIndex | null>;
  /** What the context answered for each path (`null`: it offered none). */
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
const HARD_DEPTH_CAP = 8;

// What a scope projects to: the select list plus the `values` mode flag. Both
// `Query` and `Subquery` carry this shape.
type Projection = Pick<Subquery, "select" | "values">;

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
    const root: Scope = { row: null, parent: null, bindings, run };
    let rows = this.rowsOf(this.evalExpr(query.source, root));
    for (const proj of query.from) {
      rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, root))));
    }

    const bound = this.boundOf(query, root);
    if (query.follow) return this.runFollow(query, rows, root, bound);

    // Consumer-directed short-circuits (skipped under `distinct`, which must
    // materialize + dedup by projection before reducing). Counting never
    // materializes rows; exists/none stop as soon as the bound is known to be
    // non-empty (the (offset+1)th match — or the first, when unbounded).
    if (!query.distinct && (query.consumer === "exists" || query.consumer === "none" || query.consumer === "count")) {
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
    const cap = query.consumer === "first" && !query.orderBy && !query.distinct
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
    this.sortScopes(kept, query.orderBy);
    if (query.distinct) kept = this.dedupByProjection(kept, query);
    kept = sliceBound(kept, bound);
    return this.shape(query.consumer, kept, query);
  }

  // Evaluate a block's `limit`/`offset`. The bound is part of the block, so it
  // is read in a row-less scope INSIDE it: a bare name is absent (there is no
  // current item yet), `^name` is the enclosing row — exactly as in the block's
  // body — and literals/bindings are themselves. For a top-level query `scope`
  // is the root. Each must be a non-negative integer.
  private boundOf(b: Pick<Subquery, "limit" | "offset">, enclosing: Scope): Bound {
    if (!b.limit && !b.offset) return UNBOUNDED;
    const scope: Scope = enclosing.parent === null ? enclosing : rowless(enclosing);
    const read = (e: Expr | undefined, word: string): number | null => {
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

  private rowsOf(v: unknown): unknown[] {
    return Array.from(this.ctx.toRows(v));
  }

  private child(row: unknown, parent: Scope): Scope {
    return this.enter(row, parent);
  }

  // Make the scope for a row. An `entries()` entry is unwrapped here: the scope's
  // row is the property's VALUE (so `$value` and bare names read it) and the key
  // becomes the `$key` intrinsic in `meta`. Every place a row becomes a scope
  // goes through this, so entries behave the same at the top level, in nested
  // blocks, as `from` re-projections, and as follow seeds.
  private enter(row: unknown, parent: Scope, extra: { lifts?: Record<string, unknown>; meta?: Record<string, unknown> } = {}): Scope {
    const s: Scope = { row, parent, bindings: parent.bindings, run: parent.run };
    if (extra.lifts) s.lifts = extra.lifts;
    if (extra.meta) s.meta = extra.meta;
    if (isEntry(row)) {
      s.row = row.value;
      s.meta = { ...(s.meta ?? {}), [KEY]: row.key };
    }
    return s;
  }

  // ---- follow ---------------------------------------------------------------

  private runFollow(query: Query, rows: unknown[], root: Scope, bound: Bound): OqxResult {
    const { seed, post } = query.where ? partitionRecur(query.where) : { seed: null, post: null };
    const seeds = seed ? rows.filter((r) => this.matches(seed, r, root)) : rows;
    const occ = this.followWalk(seeds, query.follow!, root);
    let scopes: Scope[] = occ.map((o) => this.enter(o.row, root, { lifts: {}, meta: o.meta }));
    if (post) scopes = scopes.filter((s) => this.evalWhere(post, s));
    this.sortScopes(scopes, query.orderBy);
    if (query.distinct) scopes = this.dedupByProjection(scopes, query);
    scopes = sliceBound(scopes, bound);
    return this.shape(query.consumer, scopes, query);
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
        ? `i:${canonicalKey(this.ctx.identity(s.row))}`
        : `p:${canonicalKey(this.projectRow(proj, s))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  // A bounded, per-path recursive walk. Each occurrence carries recursion
  // metadata: `$depth` (seed = 1), a categorical `$stop`, and a deterministic
  // `$ordinal`. Semantics:
  //   • per-path — a node reached by N distinct paths yields N occurrences
  //     (unless `distinct`, which keeps the minimal (depth, path) per identity);
  //   • cycles are safe — revisiting a key already on the current path admits ONE
  //     occurrence with `$stop == "cycle"` and does not expand it (no runaway);
  //   • `$stop` ∈ interior | leaf | frontier | depth | cycle, with precedence
  //     cycle > frontier > depth > leaf > interior; only `interior` rows expand;
  //   • `$leaf` = (stop == leaf); `$frontier` = (stop ∈ {frontier, depth}) — the
  //     "there is unfollowed graph beyond me" signal;
  //   • identity for cycle detection + `distinct` is `by <expr>` when given, else
  //     `ctx.identity(row)` (an entry's identity is its value's); identities are
  //     compared structurally via `canonicalKey`, and `$ordinal` paths compare
  //     component-wise (`comparePath`), so `10` follows `9`;
  //   • a row's successors are the destinations' rows in source order — a plain
  //     relation read in the row's scope, a destination block evaluated as a
  //     select-position directive in that scope (so `^` inside it is the frontier
  //     row and its `^people` receiver resolves one scope further out) — filtered
  //     by the follow `where`, then unioned by identity within the step (a
  //     recurring identity is kept once, at its first position);
  //   • the follow `where` reads the candidate's scope hung off the FRONTIER
  //     row's scope: a bare name is the candidate's, `^name` the row being
  //     expanded, `^^name` the walk's enclosing scope. `frontier` and `by` read
  //     the occurrence's own scope with `^` the enclosing scope, as the body does.
  private followWalk(seedRows: unknown[], follow: Follow, parent: Scope): Occurrence[] {
    const cap = follow.depth ?? HARD_DEPTH_CAP;
    const scopeFor = (row: unknown): Scope => this.enter(row, parent);
    const identityOf = (row: unknown): unknown =>
      follow.by ? this.evalExpr(follow.by, scopeFor(row)) : this.ctx.identity(isEntry(row) ? row.value : row);
    const succOf = (row: unknown): unknown[] => {
      const rowScope = scopeFor(row);
      const raw: unknown[] = [];
      for (const dest of follow.destinations) {
        const v = dest.kind === "op" ? this.evalCollectValue(dest, rowScope) : this.evalExpr(dest, rowScope);
        raw.push(...this.rowsOf(v));
      }
      const kept = follow.where ? raw.filter((x) => truthy(this.evalExpr(follow.where!, this.enter(x, rowScope)))) : raw;
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const x of kept) {
        const key = canonicalKey(identityOf(x));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x);
      }
      return out;
    };
    const frontierHit = (row: unknown): boolean =>
      follow.frontier ? truthy(this.evalExpr(follow.frontier, scopeFor(row))) : false;

    interface Walked { row: unknown; depth: number; path: unknown[]; key: string; stop: string; }
    const walked: Walked[] = [];

    const visit = (row: unknown, depth: number, ancestors: string[], ancestorIds: unknown[]): void => {
      const id = identityOf(row);
      const key = canonicalKey(id);
      const path = [...ancestorIds, id];
      let stop: string;
      if (ancestors.includes(key)) stop = "cycle";
      else if (frontierHit(row)) stop = "frontier";
      else if (depth >= cap) stop = "depth";
      else {
        const succ = succOf(row);
        if (succ.length === 0) stop = "leaf";
        else {
          walked.push({ row, depth, path, key, stop: "interior" });
          for (const s of succ) visit(s, depth + 1, [...ancestors, key], path);
          return;
        }
      }
      walked.push({ row, depth, path, key, stop });
    };
    for (const r of seedRows) visit(r, 1, [], []);

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
        $depth: w.depth,
        $stop: w.stop,
        $leaf: w.stop === "leaf",
        $frontier: w.stop === "frontier" || w.stop === "depth",
        $ordinal: i + 1,
      },
    }));
  }

  // ---- consumer shaping -----------------------------------------------------

  private shape(consumer: Query["consumer"], scopes: Scope[], proj: Projection): OqxResult {
    switch (consumer) {
      case "exists": return { consumer, exists: scopes.length > 0 };
      case "none": return { consumer, none: scopes.length === 0 };
      case "count": return { consumer, count: scopes.length };
      case "collect": return { consumer, rows: scopes.map((s) => this.projectRow(proj, s)) };
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
    if (plan.invariant) {
      const hit = scope.run.memo.get(op);
      if (hit) { scope.run.trace?.({ kind: "memo", op }); return hit.value as boolean; }
      const value = this.evalWhereOpPlanned(op, plan, scope);
      scope.run.memo.set(op, { value });
      return value;
    }
    return this.evalWhereOpPlanned(op, plan, scope);
  }

  private evalWhereOpPlanned(op: OpNode, plan: BlockPlan, scope: Scope): boolean {
    const bound = this.boundOf(op.sub, scope);
    if (op.op === "exists" || op.op === "none" || op.op === "count") {
      const acc = this.access(op, plan, scope);
      if (plan.fromCardinality && acc.where === null) {
        // Nothing left to evaluate per row: the accessed rows ARE the matched
        // rows, and the consumer only needs their count after the bound.
        const n = boundedCount(acc.rows.length, bound);
        scope.run.trace?.({ kind: "cardinality", count: n });
        if (op.op === "count") return op.countCmp ? compareCount(n, op.countCmp) : n > 0;
        return op.op === "exists" ? n > 0 : n === 0;
      }
      if (op.op === "count") {
        const n = this.opRows(op, scope, bound, acc).length;
        return op.countCmp ? compareCount(n, op.countCmp) : n > 0;
      }
      // Unbounded: stop at the first match (dedup cannot change emptiness).
      // Bounded: the offset/limit decide emptiness, so materialize the set.
      const any = bound === UNBOUNDED ? this.anyMatch(op, scope, acc) : this.opRows(op, scope, bound, acc).length > 0;
      return op.op === "exists" ? any : !any;
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

  // The rows a consumer op reduces: matched → ordered → distinct → bounded.
  private opRows(op: OpNode, scope: Scope, bound: Bound, acc?: Access): Scope[] {
    let scopes = this.matchRows(op, scope, acc);
    this.sortScopes(scopes, op.sub.orderBy);
    if (op.distinct) scopes = this.dedupByProjection(scopes, op.sub);
    return sliceBound(scopes, bound);
  }

  // Short-circuiting existence check over a consumer receiver. Over a probe's
  // bucket this stops at the first bucket row that passes the residual — the
  // semi-join (`exists`) / anti-join (`none`) never materializes the bucket.
  private anyMatch(op: OpNode, scope: Scope, acc?: Access): boolean {
    for (const s of this.iterMatchRows(op, scope, acc)) { void s; return true; }
    return false;
  }

  // The block's candidate rows (per its plan's access path), entered as scopes
  // under `scope`, filtered by the predicate the access left to evaluate.
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

  private planOf(op: OpNode, scope: Scope): BlockPlan {
    return planFor(op, scopeDepth(scope), { bindingCount: scope.run.bindingCount }, scope.run.rules);
  }

  // How a block reaches its rows. With correlated equalities the plan asks for
  // a probe: the receiver's collection is looked up (by block when the receiver
  // is statically stable, else by the receiver value's identity), indexed on
  // each local path the second time it is probed, and the buckets for the outer
  // values — evaluated once, in a row-less scope inside the block, exactly as a
  // bound is — are intersected smallest-first. The rows come back in receiver
  // order with the residual predicate. A statically stable receiver is
  // evaluated once per run whether or not anything is correlated (its value is
  // the same for every enclosing row), and when a context index answers a
  // probe with rows directly (`RowIndex.lookupRows`) its collection is never
  // materialized at all. Whenever the probe is not available (first sight of a
  // collection, a receiver that is not a collection, an index or probe value
  // whose evaluation threw) the result is the plain scan: the receiver's rows,
  // re-projected by `from`, with the whole `where`.
  private access(op: OpNode, plan: BlockPlan, scope: Scope): Access {
    const run = scope.run;
    let recv: unknown;
    let state: CollectionState | null = null;
    if (plan.receiverStable) {
      state = run.stableCollections.get(op) ?? null;
      if (!state) {
        recv = this.evalExpr(op.receiver, scope);
        run.stableCollections.set(op, (state = { value: recv, seen: 0, rows: null, indexes: new Map(), contextIndexes: new Map() }));
      }
    } else {
      recv = this.evalExpr(op.receiver, scope);
      if (plan.correlated.length > 0) {
        if (recv !== null && typeof recv === "object") {
          state = run.collections.get(recv) ?? null;
          if (!state) run.collections.set(recv, (state = { value: recv, seen: 0, rows: null, indexes: new Map(), contextIndexes: new Map() }));
        } else run.trace?.({ kind: "fallback", reason: "not-a-collection" });
      }
    }
    if (state) {
      state.seen++;
      if (plan.correlated.length > 0) {
        // Index on the second sight: a collection probed once is cheaper to scan
        // than to index, and a receiver that yields a fresh value per enclosing
        // row (never seen twice) must not pay for indexes it will never reuse.
        if (state.seen >= 2 || plan.receiverStable) {
          const direct = this.lookupRows(plan, state, scope);
          if (direct) return direct;
          if (state.rows === null) state.rows = this.rowsOf(state.value);
          const probed = this.probe(plan, state, scope);
          if (probed) return { rows: probed, where: plan.residual };
        } else run.trace?.({ kind: "fallback", reason: "unstable" });
        if (state.rows !== null) return { rows: state.rows, where: op.sub.where }; // `from` is empty when anything is correlated
      }
      if (plan.receiverStable) {
        if (state.rows === null) state.rows = this.rowsOf(state.value);
        let rows = state.rows;
        for (const proj of op.sub.from) rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, scope))));
        return { rows, where: op.sub.where };
      }
    }
    let rows = this.rowsOf(recv);
    for (const proj of op.sub.from) rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, scope))));
    return { rows, where: op.sub.where };
  }

  // A probe answered by a context index that yields rows directly, before the
  // collection is materialized. One correlation is probed — the first whose
  // outer side varies with the enclosing row (a `^` reference rather than a
  // literal), else the first offered — and every other conjunct, the remaining
  // equalities included, is evaluated per selected row in its original place:
  // a kept equality is true by construction for the rows it would have
  // selected and, being two reads, can neither raise nor bind, so the residual
  // keeps the scan's strict left-to-right order and outcome.
  private lookupRows(plan: BlockPlan, state: CollectionState, scope: Scope): Access | null {
    const run = scope.run;
    let chosen: { c: Correlation; index: RowIndex } | null = null;
    for (const c of plan.correlated) {
      const index = this.contextIndex(state, c);
      if (!index?.lookupRows) continue;
      if (!chosen || (chosen.c.outer.kind === "lit" && c.outer.kind !== "lit")) chosen = { c, index };
    }
    if (!chosen) return null;
    let value: unknown;
    try { value = this.evalExpr(chosen.c.outer, rowless(scope)); }
    catch { run.trace?.({ kind: "fallback", reason: "probe-value" }); return null; }
    const rows = Array.from(chosen.index.lookupRows!(value));
    run.trace?.({ kind: "lookup", path: chosen.c.path, candidates: rows.length });
    const residual = plan.where ? conjunction(conjuncts(plan.where).filter((_, i) => i !== chosen!.c.index)) : null;
    return { rows, where: residual };
  }

  private probe(plan: BlockPlan, state: CollectionState, scope: Scope): unknown[] | null {
    const run = scope.run;
    const rows = state.rows!;
    const probeScope = rowless(scope);
    const buckets: (readonly number[])[] = [];
    for (const c of plan.correlated) {
      const index = this.indexFor(state, rows, c, scope);
      if (!index) { run.trace?.({ kind: "fallback", reason: "index" }); return null; }
      let value: unknown;
      try { value = this.evalExpr(c.outer, probeScope); }
      catch { run.trace?.({ kind: "fallback", reason: "probe-value" }); return null; }
      buckets.push(index.lookup(value));
    }
    buckets.sort((a, b) => a.length - b.length);
    let candidates = buckets[0]!;
    for (let i = 1; i < buckets.length && candidates.length > 0; i++) candidates = intersectPositions(candidates, buckets[i]!);
    run.trace?.({ kind: "probe", paths: plan.correlated.map((c) => c.path), candidates: candidates.length });
    return candidates.map((i) => rows[i]);
  }

  // The context's pre-built index of the collection on a correlation's local
  // path, if it offers one (asked once per collection and path; a refusal is
  // cached too, so `indexFor` goes on to build the engine's own).
  private contextIndex(state: CollectionState, c: Correlation): RowIndex | null {
    const key = JSON.stringify(c.path);
    const hit = state.contextIndexes.get(key);
    if (hit !== undefined) return hit;
    const index = this.ctx.indexFor?.(state.value, c.path) ?? null;
    state.contextIndexes.set(key, index);
    return index;
  }

  // The index of `rows` on a correlation's local path: the context's pre-built
  // one when it offers it, else built here by evaluating the local expression
  // in each row's scope — the same evaluation the scan performs — so the keys
  // are exactly what `==` would compare. A throw while building (a context that
  // rejects a read) leaves the path un-indexed and the scan in charge.
  private indexFor(state: CollectionState, rows: unknown[], c: Correlation, scope: Scope): RowIndex | null {
    const key = JSON.stringify(c.path);
    const hit = state.indexes.get(key);
    if (hit !== undefined) return hit;
    let index: RowIndex | null = this.contextIndex(state, c);
    if (index) scope.run.trace?.({ kind: "index", path: c.path, rows: rows.length, source: "context" });
    else {
      const built = new HashIndex();
      try {
        for (let i = 0; i < rows.length; i++) built.add(this.evalExpr(c.local, this.enter(rows[i], scope)), i);
        index = built;
        scope.run.trace?.({ kind: "index", path: c.path, rows: rows.length, source: "engine" });
      } catch {
        index = null;
      }
    }
    state.indexes.set(key, index);
    return index;
  }

  // A select-position collect/first/single, optionally recursive via `follow`.
  private evalCollectValue(op: OpNode, scope: Scope): unknown {
    const plan = this.planOf(op, scope);
    if (plan.invariant) {
      const hit = scope.run.memo.get(op);
      if (hit) { scope.run.trace?.({ kind: "memo", op }); return hit.value; }
      const value = this.evalCollectValuePlanned(op, scope);
      scope.run.memo.set(op, { value });
      return value;
    }
    return this.evalCollectValuePlanned(op, scope);
  }

  private evalCollectValuePlanned(op: OpNode, scope: Scope): unknown {
    const sub = op.sub;
    const bound = this.boundOf(sub, scope);
    let scopes: Scope[];
    if (sub.follow) {
      let rows = this.rowsOf(this.evalExpr(op.receiver, scope));
      for (const proj of sub.from) rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, scope))));
      const seeds = sub.where ? rows.filter((r) => this.evalWhere(sub.where!, this.enter(r, scope, { lifts: {} }))) : rows;
      scopes = this.followWalk(seeds, sub.follow, scope).map((o) => this.enter(o.row, scope, { meta: o.meta }));
      this.sortScopes(scopes, sub.orderBy);
      if (op.distinct) scopes = this.dedupByProjection(scopes, sub);
      scopes = sliceBound(scopes, bound);
    } else {
      scopes = this.opRows(op, scope, bound);
    }
    switch (op.op) {
      case "collect": return scopes.map((s) => this.projectRow(sub, s));
      case "first": return scopes.length > 0 ? this.projectRow(sub, scopes[0]!) : null;
      case "single":
        if (scopes.length > 1) throw new OqxError(`single { … } for '${describeReceiver(op.receiver)}' matched ${scopes.length} rows`, "eval");
        return scopes.length > 0 ? this.projectRow(sub, scopes[0]!) : null;
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

  private evalExpr(e: Expr, scope: Scope): unknown {
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
      case "index": {
        const r = this.evalExpr(e.recv, scope);
        const i = this.evalExpr(e.index, scope);
        return r == null ? undefined : this.ctx.get(r, String(i));
      }
      case "call": return this.evalCall(e, scope);
      case "unary": {
        const v = this.evalExpr(e.expr, scope);
        if (e.op === "!") return !truthy(v);
        return v == null ? undefined : -(v as number);
      }
      case "binary": {
        const l = this.evalExpr(e.left, scope);
        const r = this.evalExpr(e.right, scope);
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
    }
  }

  // Resolve a name against ONE scope — never its ancestors. A scope provides,
  // in order: `$value` (the scope's row itself — the current item, whatever its
  // type, so scalar collections are queryable; absent at the root, which has no
  // row); `$key` (the property key) when it is an entry scope — see `enter`;
  // the recursion intrinsics (`$depth`, …) when it is a follow occurrence;
  // values lifted into it by `^name:` items; then either the row's own property
  // or, for the root scope (no row), the context's named roots.
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
    if (name === "$value") return scope.parent === null ? undefined : scope.row;
    if ((name === KEY || RECUR.has(name)) && scope.meta && Object.hasOwn(scope.meta, name)) return scope.meta[name];
    if (scope.lifts && Object.hasOwn(scope.lifts, name)) return scope.lifts[name];
    if (scope.parent === null) return this.ctx.root(name);
    return this.ctx.get(scope.row, name);
  }

  private evalCall(e: Extract<Expr, { kind: "call" }>, scope: Scope): unknown {
    const args = e.args.map((a) => this.evalExpr(a, scope));
    if (e.recv === null) {
      const r = this.ctx.callFunction?.(e.name, args);
      if (r?.handled) return r.value;
      throw new OqxError(`unknown function '${e.name}(…)'`, "eval");
    }
    const recv = this.evalExpr(e.recv, scope);
    const r = this.ctx.callMethod?.(e.name, recv, args);
    if (r?.handled) return r.value;
    throw new OqxError(`unknown method '.${e.name}(…)'`, "eval");
  }
}

interface Occurrence { row: unknown; meta: Record<string, unknown>; }

// A block's accessed rows and the predicate still to evaluate over each.
interface Access { rows: unknown[]; where: Where | null; }

// ---- free helpers -----------------------------------------------------------

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
  const rebuild = (ps: Where[]): Where | null => (ps.length === 0 ? null : ps.length === 1 ? ps[0]! : { kind: "and", parts: ps });
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
    case "index": return exprHasRecur(e.recv) || exprHasRecur(e.index);
    case "call": return (e.recv ? exprHasRecur(e.recv) : false) || e.args.some(exprHasRecur);
    case "unary": return exprHasRecur(e.expr);
    case "binary": case "logical": case "in": return exprHasRecur(e.left) || exprHasRecur(e.right);
    case "range": return (e.lo != null && exprHasRecur(e.lo)) || (e.hi != null && exprHasRecur(e.hi));
    default: return false;
  }
}

/** Convenience: run a query with plain-object roots (the default context). */
export function runQuery(query: Query, bindings: readonly unknown[], roots: unknown): OqxResult {
  const ctx = new DefaultContext((roots as Record<string, unknown>) ?? {});
  return new InMemoryEngine(ctx).run(query, bindings);
}
