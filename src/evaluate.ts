// The generic in-memory interpreter (tier 1 of the collection-kernel note):
// executes a Query against arbitrary host objects and collections. A "relation"
// is just an expression evaluated against the current row (property navigation);
// consumers (collect/exists/count/first/single), nested ops, order by, lifts, and
// recursive `follow` are all evaluated here — no schema, no pushdown.

import type {
  Query, Where, Expr, OpNode, Subquery, SelectItem, OrderSpec, Follow, RelOp,
} from "./ast.ts";
import { OqxError } from "./errors.ts";

/** A lexical scope: the current row, its enclosing scope, the template bindings,
 * any `^`-lifted values bound into this scope, and (inside `follow`) the walk's
 * recursion-intrinsic metadata. */
interface Scope {
  row: unknown;
  parent: Scope | null;
  bindings: readonly unknown[];
  lifts?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** The shaped result of a top-level query, discriminated by consumer. */
export type OqxResult =
  | { consumer: "collect"; rows: unknown[] }
  | { consumer: "exists"; exists: boolean }
  | { consumer: "count"; count: number }
  | { consumer: "first"; row: unknown | null }
  | { consumer: "single"; row: unknown | null };

const RECUR = new Set(["$depth", "$stop", "$leaf", "$frontier", "$ordinal"]);
const HARD_DEPTH_CAP = 8;

export function runQuery(q: Query, bindings: readonly unknown[], roots: unknown): OqxResult {
  const root: Scope = { row: roots ?? {}, parent: null, bindings };
  let rows = coerceCollection(evalExpr(q.source, root));
  for (const proj of q.from) {
    rows = rows.flatMap((r) => coerceCollection(evalExpr(proj, child(r, root))));
  }

  if (q.follow) return runFollow(q, rows, root);

  // Filter, capturing any ^lifts onto each surviving row's scope.
  const kept: Scope[] = [];
  for (const r of rows) {
    const s: Scope = { row: r, parent: root, bindings, lifts: {} };
    if (!q.where || evalWhere(q.where, s)) kept.push(s);
  }
  sortScopes(kept, q.orderBy);
  return shape(q.consumer, kept, q.select);
}

// ---- follow -----------------------------------------------------------------

function runFollow(q: Query, rows: unknown[], root: Scope): OqxResult {
  const { seed, post } = q.where ? partitionRecur(q.where) : { seed: null, post: null };
  const seeds = seed ? rows.filter((r) => evalWhere(seed, { row: r, parent: root, bindings: root.bindings })) : rows;
  const occ = followWalk(seeds, q.follow!, root);
  let scopes: Scope[] = occ.map((o) => ({ row: o.row, parent: root, bindings: root.bindings, lifts: {}, meta: o.meta }));
  if (post) scopes = scopes.filter((s) => evalWhere(post, s));
  sortScopes(scopes, q.orderBy);
  return shape(q.consumer, scopes, q.select);
}

interface Occurrence { row: unknown; meta: Record<string, unknown>; }

// Breadth-first walk over a type-preserving successor relation. Reached rows are
// deduplicated by identity (the `by` expression, else `.id`, else the object
// itself) — this bounds cycles and keeps the walk finite. Each surviving row
// carries recursion intrinsics ($depth/$stop/$leaf/$frontier) as result metadata.
function followWalk(seedRows: unknown[], follow: Follow, parent: Scope): Occurrence[] {
  const cap = follow.depth ?? HARD_DEPTH_CAP;
  const idOf = (row: unknown): unknown =>
    follow.by ? evalExpr(follow.by, { row, parent, bindings: parent.bindings })
      : (row != null && typeof row === "object" && "id" in row ? (row as Record<string, unknown>).id : row);

  const occ: Occurrence[] = [];
  const seen = new Set<unknown>();
  let frontierQ: { row: unknown; depth: number }[] = seedRows.map((r) => ({ row: r, depth: 1 }));

  while (frontierQ.length > 0) {
    const nextQ: { row: unknown; depth: number }[] = [];
    for (const cur of frontierQ) {
      const key = idOf(cur.row);
      if (seen.has(key)) continue;
      seen.add(key);
      const s: Scope = { row: cur.row, parent, bindings: parent.bindings };
      const raw = coerceCollection(evalExpr(follow.receiver, s));
      const succ = follow.where
        ? raw.filter((x) => truthy(evalExpr(follow.where!, { row: x, parent, bindings: parent.bindings })))
        : raw;
      const atCap = cur.depth >= cap;
      const frontierHit = follow.frontier ? truthy(evalExpr(follow.frontier, s)) : false;
      const isLeaf = succ.length === 0;
      const stop = frontierHit ? "frontier" : atCap ? "depth" : isLeaf ? "leaf" : "continue";
      occ.push({ row: cur.row, meta: { $depth: cur.depth, $stop: stop, $leaf: isLeaf, $frontier: frontierHit } });
      if (!atCap && !frontierHit && !isLeaf) {
        for (const x of succ) nextQ.push({ row: x, depth: cur.depth + 1 });
      }
    }
    frontierQ = nextQ;
  }
  return occ;
}

// Split a follow query's where into seed conjuncts (no recursion intrinsic;
// evaluated on the seed rows) and post conjuncts (referencing $depth/$stop/…;
// filter the walk's result). Only top-level AND conjuncts are partitioned.
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
    default: return false;
  }
}

// ---- consumer shaping -------------------------------------------------------

function shape(consumer: Query["consumer"], scopes: Scope[], select: SelectItem[]): OqxResult {
  switch (consumer) {
    case "exists": return { consumer, exists: scopes.length > 0 };
    case "count": return { consumer, count: scopes.length };
    case "collect": return { consumer, rows: scopes.map((s) => projectRow(select, s)) };
    case "first": return { consumer, row: scopes.length > 0 ? projectRow(select, scopes[0]!) : null };
    case "single":
      if (scopes.length > 1) throw new OqxError(`single { … } matched ${scopes.length} rows; use first { … } for zero-or-one`, "eval");
      return { consumer, row: scopes.length > 0 ? projectRow(select, scopes[0]!) : null };
  }
}

// Build one output record from a select list; an empty select yields the raw row.
function projectRow(select: SelectItem[], scope: Scope): unknown {
  if (select.length === 0) return scope.row;
  const out: Record<string, unknown> = {};
  for (const item of select) {
    out[item.name] = item.kind === "field" ? evalExpr(item.expr, scope) : evalCollectValue(item.op, scope);
  }
  return out;
}

// ---- where evaluation -------------------------------------------------------

function evalWhere(w: Where, scope: Scope): boolean {
  switch (w.kind) {
    case "and": return w.parts.every((p) => evalWhere(p, scope));
    case "or": return w.parts.some((p) => evalWhere(p, scope));
    case "not": return !evalWhere(w.expr, scope);
    case "scalar": return truthy(evalExpr(w.expr, scope));
    case "op": return evalWhereOp(w, scope);
  }
}

function evalWhereOp(op: OpNode, scope: Scope): boolean {
  if (op.sub.follow) throw new OqxError("`follow` is only valid on a select-position collect { … }, not a where op", "eval");
  const matched = matchRows(op, scope);
  if (op.op === "collect") {
    // where-position lift: bind each ^item as a per-row collection one scope out.
    for (const item of op.sub.select) {
      if (item.kind !== "field") continue;
      (scope.lifts ??= {})[item.name] = matched.map((s) => evalExpr(item.expr, s));
    }
    return matched.length > 0;
  }
  if (op.op === "count") return op.countCmp ? compareCount(matched.length, op.countCmp) : matched.length > 0;
  return matched.length > 0; // exists
}

// Resolve a consumer receiver to its child rows, apply body `from` re-projections
// and the sub-where; return the surviving child scopes.
function matchRows(op: OpNode, scope: Scope): Scope[] {
  let rows = coerceCollection(evalExpr(op.receiver, scope));
  for (const proj of op.sub.from) {
    rows = rows.flatMap((r) => coerceCollection(evalExpr(proj, child(r, scope))));
  }
  const out: Scope[] = [];
  for (const r of rows) {
    const s: Scope = { row: r, parent: scope, bindings: scope.bindings, lifts: {} };
    if (!op.sub.where || evalWhere(op.sub.where, s)) out.push(s);
  }
  return out;
}

function compareCount(n: number, cmp: { op: RelOp; value: number }): boolean {
  switch (cmp.op) {
    case "==": return n === cmp.value;
    case "!=": return n !== cmp.value;
    case "<": return n < cmp.value;
    case "<=": return n <= cmp.value;
    case ">": return n > cmp.value;
    case ">=": return n >= cmp.value;
  }
}

// A select-position collect/first/single, optionally recursive via `follow`.
function evalCollectValue(op: OpNode, scope: Scope): unknown {
  const sub = op.sub;
  let scopes: Scope[];
  if (sub.follow) {
    let rows = coerceCollection(evalExpr(op.receiver, scope));
    for (const proj of sub.from) rows = rows.flatMap((r) => coerceCollection(evalExpr(proj, child(r, scope))));
    const seeds = sub.where ? rows.filter((r) => evalWhere(sub.where!, { row: r, parent: scope, bindings: scope.bindings, lifts: {} })) : rows;
    scopes = followWalk(seeds, sub.follow, scope).map((o) => ({ row: o.row, parent: scope, bindings: scope.bindings, meta: o.meta }));
  } else {
    scopes = matchRows(op, scope);
  }
  sortScopes(scopes, sub.orderBy);
  switch (op.op) {
    case "collect": return scopes.map((s) => projectRow(sub.select, s));
    case "first": return scopes.length > 0 ? projectRow(sub.select, scopes[0]!) : null;
    case "single":
      if (scopes.length > 1) throw new OqxError(`single { … } for '${describeReceiver(op.receiver)}' matched ${scopes.length} rows`, "eval");
      return scopes.length > 0 ? projectRow(sub.select, scopes[0]!) : null;
    default: throw new OqxError(`${op.op} { … } is not valid in select position`, "eval");
  }
}

function describeReceiver(e: Expr): string {
  if (e.kind === "ident") return e.name;
  if (e.kind === "member") return `${describeReceiver(e.recv)}.${e.name}`;
  if (e.kind === "binding") return `\${${e.index}}`;
  return "receiver";
}

// ---- ordering ---------------------------------------------------------------

function sortScopes(scopes: Scope[], orderBy: OrderSpec[] | null): void {
  if (!orderBy || orderBy.length === 0) return;
  scopes.sort((a, b) => {
    for (const spec of orderBy) {
      const c = compareForSort(evalExpr(spec.expr, a), evalExpr(spec.expr, b));
      if (c !== 0) return spec.desc ? -c : c;
    }
    return 0;
  });
}

function compareForSort(a: unknown, b: unknown): number {
  const an = a == null, bn = b == null;
  if (an && bn) return 0;
  if (an) return 1; // nulls sort last
  if (bn) return -1;
  if ((a as never) < (b as never)) return -1;
  if ((a as never) > (b as never)) return 1;
  return 0;
}

// ---- scalar expression evaluation -------------------------------------------

function evalExpr(e: Expr, scope: Scope): unknown {
  switch (e.kind) {
    case "lit": return e.value;
    case "binding": return scope.bindings[e.index];
    case "ident": return resolveIdent(e.name, scope);
    case "member": {
      const r = evalExpr(e.recv, scope);
      return r == null ? undefined : (Object(r) as Record<string, unknown>)[e.name];
    }
    case "index": {
      const r = evalExpr(e.recv, scope);
      const i = evalExpr(e.index, scope);
      return r == null ? undefined : (r as Record<string, unknown>)[i as string];
    }
    case "call": return evalCall(e, scope);
    case "unary":
      return e.op === "!" ? !truthy(evalExpr(e.expr, scope)) : -toNumber(evalExpr(e.expr, scope));
    case "binary": return evalBinary(e.op, evalExpr(e.left, scope), evalExpr(e.right, scope));
    case "logical": {
      const l = evalExpr(e.left, scope);
      if (e.op === "&&") return truthy(l) ? evalExpr(e.right, scope) : l;
      return truthy(l) ? l : evalExpr(e.right, scope);
    }
    case "in": return evalIn(evalExpr(e.left, scope), evalExpr(e.right, scope));
  }
}

// A bare identifier resolves against the current row, climbing to enclosing
// scopes if absent — this is the kernel's lexical outer reference. `^`-lifts on a
// scope shadow the row. Recursion intrinsics ($depth/…) resolve from walk meta.
function resolveIdent(name: string, scope: Scope): unknown {
  if (RECUR.has(name)) {
    for (let s: Scope | null = scope; s; s = s.parent) if (s.meta && name in s.meta) return s.meta[name];
    return undefined;
  }
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.lifts && name in s.lifts) return s.lifts[name];
    if (hasProp(s.row, name)) return (s.row as Record<string, unknown>)[name];
  }
  return undefined;
}

function hasProp(row: unknown, name: string): boolean {
  return row != null && typeof row === "object" && name in (row as object);
}

function evalCall(e: Extract<Expr, { kind: "call" }>, scope: Scope): unknown {
  const args = e.args.map((a) => evalExpr(a, scope));
  if (e.recv === null) {
    switch (e.name) {
      case "list": return toList(args[0]);
      case "size": return sizeOf(args[0]);
      case "has": return args[0] != null;
      default: throw new OqxError(`unknown function '${e.name}(…)'`, "eval");
    }
  }
  const recv = evalExpr(e.recv, scope);
  const a0 = args[0];
  switch (e.name) {
    case "contains":
      if (typeof recv === "string") return recv.includes(String(a0));
      if (Array.isArray(recv)) return recv.some((x) => eqValues(x, a0));
      return false;
    case "startsWith": return typeof recv === "string" && recv.startsWith(String(a0));
    case "endsWith": return typeof recv === "string" && recv.endsWith(String(a0));
    case "matches": return recv != null && new RegExp(String(a0)).test(String(recv));
    case "size": return sizeOf(recv);
    case "lower": return String(recv).toLowerCase();
    case "upper": return String(recv).toUpperCase();
    default: throw new OqxError(`unknown method '.${e.name}(…)'`, "eval");
  }
}

function evalBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "==": return eqValues(l, r);
    case "!=": return !eqValues(l, r);
    case "<": case "<=": case ">": case ">=": {
      if (l == null || r == null) return false;
      if (op === "<") return (l as never) < (r as never);
      if (op === "<=") return (l as never) <= (r as never);
      if (op === ">") return (l as never) > (r as never);
      return (l as never) >= (r as never);
    }
    case "+":
      if (typeof l === "string" || typeof r === "string") return String(l) + String(r);
      return toNumber(l) + toNumber(r);
    case "-": return toNumber(l) - toNumber(r);
    case "*": return toNumber(l) * toNumber(r);
    case "/": return toNumber(l) / toNumber(r);
    case "%": return toNumber(l) % toNumber(r);
    default: throw new OqxError(`unsupported operator '${op}'`, "eval");
  }
}

function evalIn(l: unknown, r: unknown): boolean {
  if (r == null) return false;
  if (Array.isArray(r)) return r.some((x) => eqValues(x, l));
  if (typeof r === "string") return r.includes(String(l));
  if (typeof r === "object") return String(l) in (r as object);
  return false;
}

// ---- value helpers ----------------------------------------------------------

function eqValues(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  return x === y;
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function toList(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function") return Array.from(v as Iterable<unknown>);
  return [v];
}

function sizeOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (typeof v === "object") return Object.keys(v).length;
  return 0;
}

/** Normalize a host value into a queryable collection: arrays pass through,
 * non-string iterables are materialized, null/undefined is empty, and any other
 * single value becomes a one-element collection (a to-one relation). */
function coerceCollection(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function") {
    return Array.from(v as Iterable<unknown>);
  }
  return [v];
}

function child(row: unknown, parent: Scope): Scope {
  return { row, parent, bindings: parent.bindings };
}
