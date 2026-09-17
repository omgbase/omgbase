// The in-memory execution engine (tier 1), now parameterized by a DataContext
// (tier 2) so it can drive any data model, and expressed behind an `Engine`
// interface so a pushdown planner (tier 3, planner.ts) is a drop-in alternative.
//
// Optimizations over a naive walk: `exists` short-circuits at the first match;
// `first`/`single` stop early when the result is unordered; `count` never
// materializes rows; and within an `&&` the cheap scalar leaves are evaluated
// before expensive consumer-op leaves (which each drive a nested traversal).

import type {
  Query, Where, Expr, OpNode, SelectItem, OrderSpec, Follow,
} from "./ast.ts";
import type { DataContext } from "./context.ts";
import { DefaultContext } from "./context.ts";
import { OqxError } from "./errors.ts";
import {
  equals, relate, arith, membership, truthy, toNumber, compareForSort, makeRange,
} from "./semantics.ts";

/** The shaped result of a top-level query, discriminated by consumer. */
export type OqxResult =
  | { consumer: "collect"; rows: unknown[] }
  | { consumer: "exists"; exists: boolean }
  | { consumer: "count"; count: number }
  | { consumer: "first"; row: unknown | null }
  | { consumer: "single"; row: unknown | null };

/** A backend that runs a parsed Query with the given positional bindings. */
export interface Engine {
  run(query: Query, bindings: readonly unknown[]): OqxResult;
}

interface Scope {
  row: unknown;
  parent: Scope | null;
  bindings: readonly unknown[];
  lifts?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const RECUR = new Set(["$depth", "$stop", "$leaf", "$frontier", "$ordinal"]);
const HARD_DEPTH_CAP = 8;

export class InMemoryEngine implements Engine {
  private ctx: DataContext;

  constructor(context: DataContext = new DefaultContext()) {
    this.ctx = context;
  }

  run(query: Query, bindings: readonly unknown[] = []): OqxResult {
    const root: Scope = { row: null, parent: null, bindings };
    let rows = this.rowsOf(this.evalExpr(query.source, root));
    for (const proj of query.from) {
      rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, root))));
    }

    if (query.follow) return this.runFollow(query, rows, root);

    // Consumer-directed short-circuits (skipped under `distinct`, which must
    // materialize + dedup by projection before reducing).
    if (!query.distinct && query.consumer === "exists") {
      for (const r of rows) if (this.matches(query.where, r, root)) return { consumer: "exists", exists: true };
      return { consumer: "exists", exists: false };
    }
    if (!query.distinct && query.consumer === "count") {
      let count = 0;
      for (const r of rows) if (this.matches(query.where, r, root)) count++;
      return { consumer: "count", count };
    }

    const cap = !query.orderBy && !query.distinct && query.consumer === "first" ? 1
      : !query.orderBy && !query.distinct && query.consumer === "single" ? 2
      : Infinity;
    let kept: Scope[] = [];
    for (const r of rows) {
      const s: Scope = { row: r, parent: root, bindings, lifts: {} };
      if (!query.where || this.evalWhere(query.where, s)) {
        kept.push(s);
        if (kept.length >= cap) break;
      }
    }
    this.sortScopes(kept, query.orderBy);
    if (query.distinct) kept = this.dedupByProjection(kept, query.select);
    return this.shape(query.consumer, kept, query.select);
  }

  // A where match that needs no lift capture (exists/count fast paths).
  private matches(where: Where | null, row: unknown, parent: Scope): boolean {
    if (!where) return true;
    return this.evalWhere(where, { row, parent, bindings: parent.bindings });
  }

  private rowsOf(v: unknown): unknown[] {
    return Array.from(this.ctx.toRows(v));
  }

  private child(row: unknown, parent: Scope): Scope {
    return { row, parent, bindings: parent.bindings };
  }

  // ---- follow ---------------------------------------------------------------

  private runFollow(query: Query, rows: unknown[], root: Scope): OqxResult {
    const { seed, post } = query.where ? partitionRecur(query.where) : { seed: null, post: null };
    const seeds = seed ? rows.filter((r) => this.matches(seed, r, root)) : rows;
    const occ = this.followWalk(seeds, query.follow!, root);
    let scopes: Scope[] = occ.map((o) => ({ row: o.row, parent: root, bindings: root.bindings, lifts: {}, meta: o.meta }));
    if (post) scopes = scopes.filter((s) => this.evalWhere(post, s));
    this.sortScopes(scopes, query.orderBy);
    if (query.distinct) scopes = this.dedupByProjection(scopes, query.select);
    return this.shape(query.consumer, scopes, query.select);
  }

  // Dedup scopes by their PROJECTED value (`distinct`): keep the first scope per
  // distinct projection, preserving order. An empty projection dedups by row
  // identity (so `count distinct { }` counts distinct rows).
  private dedupByProjection(scopes: Scope[], select: SelectItem[]): Scope[] {
    const seen = new Set<string>();
    const out: Scope[] = [];
    for (const s of scopes) {
      const key = select.length === 0
        ? `i:${String(this.ctx.identity(s.row))}`
        : `p:${stableStringify(this.projectRow(select, s))}`;
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
  //     `ctx.identity(row)`.
  private followWalk(seedRows: unknown[], follow: Follow, parent: Scope): Occurrence[] {
    const cap = follow.depth ?? HARD_DEPTH_CAP;
    const scopeFor = (row: unknown): Scope => ({ row, parent, bindings: parent.bindings });
    const keyOf = (row: unknown): string =>
      String(follow.by ? this.evalExpr(follow.by, scopeFor(row)) : this.ctx.identity(row));
    const succOf = (row: unknown): unknown[] => {
      const raw = this.rowsOf(this.evalExpr(follow.receiver, scopeFor(row)));
      return follow.where ? raw.filter((x) => truthy(this.evalExpr(follow.where!, scopeFor(x)))) : raw;
    };
    const frontierHit = (row: unknown): boolean =>
      follow.frontier ? truthy(this.evalExpr(follow.frontier, scopeFor(row))) : false;

    interface Walked { row: unknown; depth: number; path: string; key: string; stop: string; }
    const walked: Walked[] = [];

    const visit = (row: unknown, depth: number, ancestors: string[]): void => {
      const key = keyOf(row);
      const path = `/${[...ancestors, key].join("/")}/`;
      let stop: string;
      if (ancestors.includes(key)) stop = "cycle";
      else if (frontierHit(row)) stop = "frontier";
      else if (depth >= cap) stop = "depth";
      else {
        const succ = succOf(row);
        if (succ.length === 0) stop = "leaf";
        else {
          walked.push({ row, depth, path, key, stop: "interior" });
          for (const s of succ) visit(s, depth + 1, [...ancestors, key]);
          return;
        }
      }
      walked.push({ row, depth, path, key, stop });
    };
    for (const r of seedRows) visit(r, 1, []);

    let rows = walked;
    if (follow.distinct) {
      // keep the minimal (depth, path) occurrence per identity key.
      const best = new Map<string, Walked>();
      for (const w of rows) {
        const prev = best.get(w.key);
        if (!prev || w.depth < prev.depth || (w.depth === prev.depth && w.path < prev.path)) best.set(w.key, w);
      }
      rows = [...best.values()];
    }
    // $ordinal: a deterministic 1..N rank over (depth, path).
    rows = rows.slice().sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

  private shape(consumer: Query["consumer"], scopes: Scope[], select: SelectItem[]): OqxResult {
    switch (consumer) {
      case "exists": return { consumer, exists: scopes.length > 0 };
      case "count": return { consumer, count: scopes.length };
      case "collect": return { consumer, rows: scopes.map((s) => this.projectRow(select, s)) };
      case "first": return { consumer, row: scopes.length > 0 ? this.projectRow(select, scopes[0]!) : null };
      case "single":
        if (scopes.length > 1) throw new OqxError(`single { … } matched ${scopes.length} rows; use first { … } for zero-or-one`, "eval");
        return { consumer, row: scopes.length > 0 ? this.projectRow(select, scopes[0]!) : null };
    }
  }

  private projectRow(select: SelectItem[], scope: Scope): unknown {
    if (select.length === 0) return scope.row;
    const out: Record<string, unknown> = {};
    for (const item of select) {
      out[item.name] = item.kind === "field" ? this.evalExpr(item.expr, scope) : this.evalCollectValue(item.op, scope);
    }
    return out;
  }

  // ---- where evaluation -----------------------------------------------------

  private evalWhere(w: Where, scope: Scope): boolean {
    switch (w.kind) {
      case "and": {
        // Cheap scalar leaves before expensive consumer ops; `.every` short-circuits.
        for (const p of orderByCost(w.parts)) if (!this.evalWhere(p, scope)) return false;
        return true;
      }
      case "or": return w.parts.some((p) => this.evalWhere(p, scope));
      case "not": return !this.evalWhere(w.expr, scope);
      case "scalar": return truthy(this.evalExpr(w.expr, scope));
      case "op": return this.evalWhereOp(w, scope);
    }
  }

  private evalWhereOp(op: OpNode, scope: Scope): boolean {
    if (op.sub.follow) throw new OqxError("`follow` is only valid on a select-position collect { … }, not a where op", "eval");
    if (op.op === "exists") return this.anyMatch(op, scope);
    if (op.op === "collect") {
      const matched = this.matchRows(op, scope);
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
    if (op.op === "count") {
      let rows = this.matchRows(op, scope);
      if (op.distinct) rows = this.dedupByProjection(rows, op.sub.select);
      const n = rows.length;
      return op.countCmp ? compareCount(n, op.countCmp) : n > 0;
    }
    return this.matchRows(op, scope).length > 0;
  }

  // Short-circuiting existence check over a consumer receiver.
  private anyMatch(op: OpNode, scope: Scope): boolean {
    for (const s of this.iterMatchRows(op, scope)) { void s; return true; }
    return false;
  }

  private *iterMatchRows(op: OpNode, scope: Scope): Generator<Scope> {
    let rows = this.rowsOf(this.evalExpr(op.receiver, scope));
    for (const proj of op.sub.from) rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, scope))));
    for (const r of rows) {
      const s: Scope = { row: r, parent: scope, bindings: scope.bindings, lifts: {} };
      if (!op.sub.where || this.evalWhere(op.sub.where, s)) yield s;
    }
  }

  private matchRows(op: OpNode, scope: Scope): Scope[] {
    return Array.from(this.iterMatchRows(op, scope));
  }

  // A select-position collect/first/single, optionally recursive via `follow`.
  private evalCollectValue(op: OpNode, scope: Scope): unknown {
    const sub = op.sub;
    let scopes: Scope[];
    if (sub.follow) {
      let rows = this.rowsOf(this.evalExpr(op.receiver, scope));
      for (const proj of sub.from) rows = rows.flatMap((r) => this.rowsOf(this.evalExpr(proj, this.child(r, scope))));
      const seeds = sub.where ? rows.filter((r) => this.evalWhere(sub.where!, { row: r, parent: scope, bindings: scope.bindings, lifts: {} })) : rows;
      scopes = this.followWalk(seeds, sub.follow, scope).map((o) => ({ row: o.row, parent: scope, bindings: scope.bindings, meta: o.meta }));
    } else {
      scopes = this.matchRows(op, scope);
    }
    this.sortScopes(scopes, sub.orderBy);
    if (op.distinct) scopes = this.dedupByProjection(scopes, sub.select);
    switch (op.op) {
      case "collect": return scopes.map((s) => this.projectRow(sub.select, s));
      case "first": return scopes.length > 0 ? this.projectRow(sub.select, scopes[0]!) : null;
      case "single":
        if (scopes.length > 1) throw new OqxError(`single { … } for '${describeReceiver(op.receiver)}' matched ${scopes.length} rows`, "eval");
        return scopes.length > 0 ? this.projectRow(sub.select, scopes[0]!) : null;
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
      case "binding": return scope.bindings[e.index];
      case "ident": return this.resolveFrom(e.name, scope);
      case "outer": {
        let s: Scope | null = scope;
        for (let i = 0; i < e.levels && s; i++) s = s.parent;
        return s ? this.resolveFrom(e.name, s) : undefined;
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
      case "unary":
        return e.op === "!" ? !truthy(this.evalExpr(e.expr, scope)) : -toNumber(this.evalExpr(e.expr, scope));
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

  // Resolve a bare name starting at `start` and climbing enclosing scopes: `^`
  // outer references reuse this after skipping the requested number of scopes.
  private resolveFrom(name: string, start: Scope): unknown {
    if (RECUR.has(name)) {
      for (let s: Scope | null = start; s; s = s.parent) if (s.meta && name in s.meta) return s.meta[name];
      return undefined;
    }
    for (let s: Scope | null = start; s; s = s.parent) {
      if (s.lifts && name in s.lifts) return s.lifts[name];
      if (s.parent === null) {
        const v = this.ctx.root(name);
        if (v !== undefined) return v;
      } else if (this.has(s.row, name)) {
        return this.ctx.get(s.row, name);
      }
    }
    return undefined;
  }

  private has(row: unknown, name: string): boolean {
    if (this.ctx.has) return this.ctx.has(row, name);
    return row != null && typeof row === "object" && name in (row as object);
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

// ---- free helpers -----------------------------------------------------------

function isRelOp(op: string): boolean {
  return op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=";
}

// Deterministic stringify for `distinct` dedup keys: object keys are emitted in
// sorted order so two projections that are equal-by-value collide regardless of
// key insertion order. `undefined` normalizes to null (like an absent value).
function stableStringify(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function compareCount(n: number, cmp: { op: string; value: number }): boolean {
  return relate(cmp.op, n, cmp.value);
}

// Order `&&` conjuncts so cheap scalar leaves run before consumer-op leaves.
function orderByCost(parts: Where[]): Where[] {
  return [...parts].sort((a, b) => whereCost(a) - whereCost(b));
}

function whereCost(w: Where): number {
  switch (w.kind) {
    case "op": return 2;
    case "and": case "or": return Math.max(0, ...w.parts.map(whereCost));
    case "not": return whereCost(w.expr);
    case "scalar": return 0;
  }
}

function describeReceiver(e: Expr): string {
  if (e.kind === "ident") return e.name;
  if (e.kind === "member") return `${describeReceiver(e.recv)}.${e.name}`;
  if (e.kind === "binding") return `\${${e.index}}`;
  return "receiver";
}

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
