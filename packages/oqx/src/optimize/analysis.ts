// Static (syntactic) analyses the rules rest on. Each answers one question
// about an AST fragment without evaluating anything:
//
//   • which scopes does it READ (`readsScopeIn`) — by depth, since a bare name
//     reads the current scope and `^name` reads exactly `levels` scopes out
//     (SEMANTICS §2), so an expression evaluated at a known depth reads a
//     known set of depths;
//   • can evaluating it RAISE (`raiseFree`) — the eval errors SEMANTICS §23
//     enumerates: a call (unknown name, bad regex, wrong receiver), `single`
//     over several rows, an invalid `limit`/`offset`, `follow` in a where op, a
//     range in a result, a binding out of range. Property reads are total
//     (navigating from absent is absent); a `DataContext.get` that throws is
//     outside this model and is caught at the points the engine relies on it
//     (index construction, probe-value evaluation), where it degrades to a scan;
//   • does it have SIDE EFFECTS on scopes (`hasLifts`) — a `^name:` item binds a
//     value into an enclosing scope (§19), observable by later conjuncts.

import type { Expr, Follow, OpNode, SelectItem, Subquery, Where } from "../ast.ts";
import type { RuleContext } from "./ir.ts";

// ---- scope reads --------------------------------------------------------------

/** Does `e`, evaluated in a scope at depth `at` (root = 0), read any scope whose
 * depth lies in `[1, upTo]`? Reads of the root (named roots, depth 0) and of
 * scopes deeper than `upTo` (the fragment's own rows) do not count. */
export function exprReadsScopeIn(e: Expr, at: number, upTo: number): boolean {
  switch (e.kind) {
    case "lit": case "binding": return false;
    case "ident": return at >= 1 && at <= upTo;
    case "outer": { const d = at - e.levels; return d >= 1 && d <= upTo; }
    case "member": return exprReadsScopeIn(e.recv, at, upTo);
    case "index": return exprReadsScopeIn(e.recv, at, upTo) || exprReadsScopeIn(e.index, at, upTo);
    case "call": return (e.recv !== null && exprReadsScopeIn(e.recv, at, upTo)) || e.args.some((a) => exprReadsScopeIn(a, at, upTo));
    case "unary": return exprReadsScopeIn(e.expr, at, upTo);
    case "binary": case "logical": case "in": return exprReadsScopeIn(e.left, at, upTo) || exprReadsScopeIn(e.right, at, upTo);
    case "range": return (e.lo !== null && exprReadsScopeIn(e.lo, at, upTo)) || (e.hi !== null && exprReadsScopeIn(e.hi, at, upTo));
  }
}

export function whereReadsScopeIn(w: Where, at: number, upTo: number): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.some((p) => whereReadsScopeIn(p, at, upTo));
    case "not": return whereReadsScopeIn(w.expr, at, upTo);
    case "scalar": return exprReadsScopeIn(w.expr, at, upTo);
    case "op": return opReadsScopeIn(w, at, upTo);
  }
}

/** A directive evaluated in a scope at depth `at`: its receiver is read there;
 * its rows are scopes at `at + 1`. */
export function opReadsScopeIn(op: OpNode, at: number, upTo: number): boolean {
  return exprReadsScopeIn(op.receiver, at, upTo) || subReadsScopeIn(op.sub, at + 1, upTo);
}

/** A block body whose rows are scopes at depth `at`. `from` re-projections,
 * `where`, `select`, `order by` and the bound are read in the row scope (the
 * bound in a row-less scope at the same depth); `follow` walks occurrences at
 * `at`, with its successor `where` one deeper (§20). */
function subReadsScopeIn(sub: Subquery, at: number, upTo: number): boolean {
  if (sub.from.some((e) => exprReadsScopeIn(e, at, upTo))) return true;
  if (sub.where && whereReadsScopeIn(sub.where, at, upTo)) return true;
  if (sub.select.some((item) => itemReadsScopeIn(item, at, upTo))) return true;
  if (sub.orderBy?.some((o) => exprReadsScopeIn(o.expr, at, upTo))) return true;
  if (sub.limit && exprReadsScopeIn(sub.limit, at, upTo)) return true;
  if (sub.offset && exprReadsScopeIn(sub.offset, at, upTo)) return true;
  return sub.follow !== null && followReadsScopeIn(sub.follow, at, upTo);
}

function itemReadsScopeIn(item: SelectItem, at: number, upTo: number): boolean {
  return item.kind === "field" ? exprReadsScopeIn(item.expr, at, upTo) : opReadsScopeIn(item.op, at, upTo);
}

function followReadsScopeIn(f: Follow, at: number, upTo: number): boolean {
  for (const d of f.destinations) {
    if (d.kind === "op" ? opReadsScopeIn(d, at, upTo) : exprReadsScopeIn(d, at, upTo)) return true;
  }
  if (f.where && exprReadsScopeIn(f.where, at + 1, upTo)) return true;
  if (f.frontier && exprReadsScopeIn(f.frontier, at, upTo)) return true;
  return f.by !== null && exprReadsScopeIn(f.by, at, upTo);
}

/** Does `e` read the scope it is evaluated in (a bare identifier anywhere)? */
export function exprReadsCurrentScope(e: Expr): boolean {
  return exprReadsScopeIn(e, 1, 1);
}

// ---- raise freedom ------------------------------------------------------------

/** Can evaluating `e` raise? Calls can (unknown function/method, regex errors,
 * a context's own failures); a binding at or past the run's count does; nothing
 * else in a scalar expression can (§23). */
export function exprRaiseFree(e: Expr, ctx: RuleContext): boolean {
  switch (e.kind) {
    case "lit": case "ident": case "outer": return true;
    case "binding": return e.index < ctx.bindingCount;
    case "call": return false;
    case "member": return exprRaiseFree(e.recv, ctx);
    case "index": return exprRaiseFree(e.recv, ctx) && exprRaiseFree(e.index, ctx);
    case "unary": return exprRaiseFree(e.expr, ctx);
    case "binary": case "logical": case "in": return exprRaiseFree(e.left, ctx) && exprRaiseFree(e.right, ctx);
    case "range": return (e.lo === null || exprRaiseFree(e.lo, ctx)) && (e.hi === null || exprRaiseFree(e.hi, ctx));
  }
}

/** Can evaluating `w` raise, or bind a lift? A where tree is raise-free when
 * its scalars are and its directives are raise-free (`opRaiseFree`). */
export function whereRaiseFree(w: Where, ctx: RuleContext): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.every((p) => whereRaiseFree(p, ctx));
    case "not": return whereRaiseFree(w.expr, ctx);
    case "scalar": return exprRaiseFree(w.expr, ctx);
    case "op": return opRaiseFree(w, ctx);
  }
}

/** A where-position directive that can neither raise nor bind: `exists`,
 * `none` or `count` (never `single`, which raises on several rows; `collect`
 * binds lifts; `first`/`single` project), without `follow` (raises in where
 * position), without a bound (an invalid value raises), without `distinct`
 * (dedup projects, and a projected range raises), whose receiver, `from`,
 * `where` and `order by` (evaluated by `count`) are raise-free and which lifts
 * nothing anywhere. */
export function opRaiseFree(op: OpNode, ctx: RuleContext): boolean {
  if (op.op !== "exists" && op.op !== "none" && op.op !== "count") return false;
  const sub = op.sub;
  if (sub.follow || sub.limit || sub.offset || op.distinct) return false;
  if (!exprRaiseFree(op.receiver, ctx)) return false;
  if (!sub.from.every((e) => exprRaiseFree(e, ctx))) return false;
  if (sub.where && !whereRaiseFree(sub.where, ctx)) return false;
  if (sub.orderBy && !sub.orderBy.every((o) => exprRaiseFree(o.expr, ctx))) return false;
  return !opHasLifts(op);
}

// ---- lifts --------------------------------------------------------------------

/** Does any `^name:` item occur anywhere inside the directive (its own select,
 * or any nested block's)? */
export function opHasLifts(op: OpNode): boolean {
  return subHasLifts(op.sub);
}

function subHasLifts(sub: Subquery): boolean {
  if (sub.select.some((item) => (item.kind === "field" ? item.lift > 0 : opHasLifts(item.op)))) return true;
  if (sub.where && whereHasLifts(sub.where)) return true;
  if (sub.follow?.destinations.some((d) => d.kind === "op" && opHasLifts(d))) return true;
  return false;
}

/** Does any `^name:` item occur inside a directive of this where tree? */
export function whereHasLifts(w: Where): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.some(whereHasLifts);
    case "not": return whereHasLifts(w.expr);
    case "scalar": return false;
    case "op": return opHasLifts(w);
  }
}

// ---- local paths --------------------------------------------------------------

/** The property path a bare identifier or member chain reads off the current
 * row — `customer_id` → `["customer_id"]`, `meta.id` → `["meta", "id"]`,
 * `$value` → `[]`, `$value.x` → `["x"]` — or `null` when `e` is not such a
 * chain or starts from a scope intrinsic (`$key`, `$depth`, …, whose value is
 * scope metadata rather than a row property). */
export function localPath(e: Expr): readonly string[] | null {
  if (e.kind === "ident") {
    if (e.name === "$value") return [];
    return e.name.startsWith("$") ? null : [e.name];
  }
  if (e.kind === "member") {
    const head = localPath(e.recv);
    return head === null ? null : [...head, e.name];
  }
  return null;
}
