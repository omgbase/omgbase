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
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { OqxError } from "./errors.ts";
import {
  relate, arith, membership, truthy, compareForSort, compare, canonicalKey, makeRange, isEntry, isRange,
} from "./semantics.ts";
import type { BlockPlan, Correlation, Rule, RowIndex } from "./optimize/index.ts";
import { DEFAULT_RULES, HashIndex, intersectPositions, lookupOrder, planFor, residualWithout } from "./optimize/index.ts";

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
  rows: unknown[] | null;
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
    const rows = this.reproject(this.rowsOf(this.evalRaw(query.source, root)), query.from, root);

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
        const v = dest.kind === "op" ? this.evalCollectValue(dest, rowScope) : this.evalRaw(dest, rowScope);
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
      } else if (op.op !== "count" && bound === UNBOUNDED) {
        // Unbounded exists/none: stop at the first match (dedup cannot change
        // emptiness). Bounded: the offset/limit decide emptiness, so materialize.
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

  // The rows a consumer op reduces: matched → ordered → distinct → bounded.
  private opRows(op: OpNode, scope: Scope, bound: Bound, acc?: Access): Scope[] {
    let scopes = this.matchRows(op, scope, acc);
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
      else if (plan.correlated.length === 0) return this.scan(this.rowsOf(value), op, scope);
      else if (value !== null && typeof value === "object") {
        state = run.collections.get(value);
        if (!state) run.collections.set(value, (state = newCollection(value)));
      } else {
        run.trace?.({ kind: "fallback", reason: "not-a-collection" });
        return this.scan(this.rowsOf(value), op, scope);
      }
    }
    state.seen++;
    if (plan.correlated.length > 0) {
      const direct = this.lookupRows(plan, state, scope);
      if (direct) return direct;
      if (state.seen >= 2 || plan.receiverStable) {
        const probed = this.probe(plan, state, scope);
        if (probed) return { rows: probed, where: plan.residual };
      } else run.trace?.({ kind: "fallback", reason: "unstable" });
    }
    return this.scan(this.materialize(state), op, scope);
  }

  // The plain scan: the rows, re-projected by `from`, with the whole `where`.
  private scan(rows: unknown[], op: OpNode, scope: Scope): Access {
    return { rows: this.reproject(rows, op.sub.from, scope), where: op.sub.where };
  }

  private reproject(rows: unknown[], from: readonly Expr[], scope: Scope): unknown[] {
    for (const proj of from) rows = rows.flatMap((r) => this.rowsOf(this.evalRaw(proj, this.child(r, scope))));
    return rows;
  }

  private materialize(state: CollectionState): unknown[] {
    return (state.rows ??= this.rowsOf(state.value));
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
      return { rows, where: residualWithout(plan, c) };
    }
    return null;
  }

  // The engine's probe: one bucket per correlation, intersected smallest-first;
  // the candidates come back in receiver order. `null` (an index that could
  // not be built, an outer value whose evaluation threw) leaves the scan in charge.
  private probe(plan: BlockPlan, state: CollectionState, scope: Scope): unknown[] | null {
    const run = scope.run;
    const rows = this.materialize(state);
    const buckets: (readonly number[])[] = [];
    for (const c of plan.correlated) {
      const index = this.indexFor(state, c, scope);
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
  private indexFor(state: CollectionState, c: Correlation, scope: Scope): RowIndex | null {
    const key = pathKey(c.path);
    const hit = state.indexes.get(key);
    if (hit !== undefined) return hit;
    const rows = this.materialize(state);
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
    const sub = op.sub;
    const bound = this.boundOf(sub, scope);
    let scopes: Scope[];
    if (sub.follow) {
      // The seeds are the matched rows themselves (`followWalk` enters them); a
      // follow block is never correlated, so `where` here is the whole predicate.
      const { rows, where } = this.access(op, plan, scope);
      const seeds = where ? rows.filter((r) => this.evalWhere(where, this.enter(r, scope, { lifts: {} }))) : rows;
      scopes = this.followWalk(seeds, sub.follow, scope).map((o) => this.enter(o.row, scope, { meta: o.meta }));
      this.sortScopes(scopes, sub.orderBy);
      if (op.distinct) scopes = this.dedupByProjection(scopes, sub);
      scopes = sliceBound(scopes, bound);
    } else {
      scopes = this.opRows(op, scope, bound, this.access(op, plan, scope));
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
