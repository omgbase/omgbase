// Select-alias resolution (SEMANTICS §14). `where` may reference the same body's
// `select` aliases, and since 0.17 a `select` item may reference the items to
// its left; the parser keeps the surface form (so the tree can be printed back
// and reflected on) and only VALIDATES the references, and this module performs
// the substitution — a pure rewrite the entry points (`run`, `execute`, `oqx`,
// `runQuery`) apply once before evaluation, so the engine and any pushdown
// planner see an ordinary `where` and `select` over row fields. Rules:
//   • an alias shadows a same-named row field inside `where` and in the items
//     after it;
//   • an alias's own name inside its own expression is the row field
//     (`name: name.upper()` is not recursive), but a chain of aliases that
//     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//   • a `select` item may name only the items to its LEFT; a reference to an
//     item to its right is an error (it is a cycle when that item refers back);
//   • an alias whose value is a `collect`/`first`/`single { … }` block may
//     stand alone as a where leaf (a collection in predicate position means
//     non-empty) but not appear inside a `where` expression; in a later `select`
//     item it inlines as a value-position directive (`boss.name`);
//   • nested blocks (consumer bodies, follow blocks, bracket lookups) are their
//     own scopes and are not rewritten against this body's select — each body
//     rewrites against its own.
//
// Resolution is NOT idempotent (`name: name.upper() … where name` resolves to
// `name.upper()`, whose `name` would be substituted again), so it must run
// exactly once: the entry points do it, `Engine.run` evaluates the query as
// given. Untouched nodes are returned by reference, so a cached query keeps the
// identity of every block the rewrite did not reach.

import type { Expr, Follow, FollowDestination, OpNode, Query, SelectItem, Subquery, Where } from "./ast.ts";
import { OqxError } from "./errors.ts";

/** How a resolution failure is reported: the parser raises its positioned parse
 * error, the standalone entry point a plain one. */
export type Fail = (message: string) => never;

const failPlain: Fail = (message) => {
  throw new OqxError(message, "parse");
};

/** Resolve every `where` and `select` of a query (its own and every nested
 * block's) against the `select` of the same body. Pure: returns a new tree
 * sharing every node the rewrite did not touch. Throws an `OqxError` (stage
 * `parse`) for an alias cycle, a forward reference, or a block alias used
 * inside a `where` expression — the same conditions the parser rejects, so a
 * parsed query never throws here. */
export function resolveAliases<T extends Query | Subquery>(node: T): T {
  return resolveBody(node, failPlain);
}

function resolveBody<T extends Query | Subquery>(node: T, fail: Fail): T {
  // `where` is validated and substituted against the raw select first: its
  // cycle report follows the where's own path (`c → a → b → c`), as pinned.
  const where = node.where === null ? null : resolveWhere(node.select, node.where, fail);
  const where2 = where === null ? null : resolveNestedWhere(where, fail);
  const select = resolveSelect(node.select, fail);
  const follow = node.follow === null ? null : resolveFollow(node.follow, fail);
  const from = mapSame(node.from, (e) => resolveExpr(e, fail));
  const orderBy = node.orderBy === null ? null : mapSame(node.orderBy, (o) => {
    const expr = resolveExpr(o.expr, fail);
    return expr === o.expr ? o : { ...o, expr };
  });
  const limit = node.limit === null ? null : resolveExpr(node.limit, fail);
  const offset = node.offset === null ? null : resolveExpr(node.offset, fail);
  const source = node.kind === "query" ? resolveExpr(node.source, fail) : null;
  const same = where2 === node.where && select === node.select && follow === node.follow && from === node.from
    && orderBy === node.orderBy && limit === node.limit && offset === node.offset
    && (node.kind !== "query" || source === node.source);
  if (same) return node;
  const out = { ...node, where: where2, select, follow, from, orderBy, limit, offset };
  if (node.kind === "query") (out as Query).source = source!;
  return out;
}

function resolveOp(op: OpNode, fail: Fail): OpNode {
  const receiver = resolveExpr(op.receiver, fail);
  const sub = resolveBody(op.sub, fail);
  return sub === op.sub && receiver === op.receiver ? op : { ...op, receiver, sub };
}

function resolveFollow(f: Follow, fail: Fail): Follow {
  const destinations = mapSame(f.destinations, (d: FollowDestination) => (d.kind === "op" ? resolveOp(d, fail) : resolveExpr(d, fail)));
  const where = f.where === null ? null : resolveExpr(f.where, fail);
  const frontier = f.frontier === null ? null : resolveExpr(f.frontier, fail);
  const by = f.by === null ? null : resolveExpr(f.by, fail);
  if (destinations === f.destinations && where === f.where && frontier === f.frontier && by === f.by) return f;
  return { ...f, destinations, where, frontier, by };
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select (a scalar leaf may hold a value-position directive).
function resolveNestedWhere(w: Where, fail: Fail): Where {
  switch (w.kind) {
    case "and": case "or": {
      const parts = mapSame(w.parts, (p) => resolveNestedWhere(p, fail));
      return parts === w.parts ? w : { ...w, parts };
    }
    case "not": {
      const expr = resolveNestedWhere(w.expr, fail);
      return expr === w.expr ? w : { ...w, expr };
    }
    case "scalar": {
      const expr = resolveExpr(w.expr, fail);
      return expr === w.expr ? w : { ...w, expr };
    }
    case "op": return resolveOp(w, fail);
  }
}

/** Resolve the nested blocks (value-position directives) inside an expression,
 * each against its own select; the expression's own idents are left alone. */
function resolveExpr(e: Expr, fail: Fail): Expr {
  return mapExpr(e, (x) => (x.kind === "op" ? resolveOp(x, fail) : null));
}

/** Rebuild `e` bottom-up, letting `f` replace a node (return `null` to keep it;
 * a replaced node's children are not visited — `f` owns them). Untouched nodes
 * are returned by reference. */
function mapExpr(e: Expr, f: (e: Expr) => Expr | null): Expr {
  const hit = f(e);
  if (hit !== null) return hit;
  const go = (x: Expr): Expr => mapExpr(x, f);
  switch (e.kind) {
    case "member": { const recv = go(e.recv); return recv === e.recv ? e : { ...e, recv }; }
    case "call": {
      const recv = e.recv ? go(e.recv) : null;
      const args = mapSame(e.args, go);
      return recv === e.recv && args === e.args ? e : { ...e, recv, args };
    }
    case "unary": case "required": { const expr = go(e.expr); return expr === e.expr ? e : { ...e, expr }; }
    case "binary": case "logical": case "in": {
      const left = go(e.left);
      const right = go(e.right);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "range": {
      const lo = e.lo ? go(e.lo) : null;
      const hi = e.hi ? go(e.hi) : null;
      return lo === e.lo && hi === e.hi ? e : { ...e, lo, hi };
    }
    case "op": { // the receiver is read in this scope; the block is its own scope
      const receiver = go(e.receiver);
      return receiver === e.receiver ? e : { ...e, receiver };
    }
    default: return e; // lit, ident, binding, outer
  }
}

// An item other items may name: a `collect` item, or a named non-lift field.
function aliasName(it: SelectItem): string | null {
  if (it.kind === "collect") return it.name === "" ? null : it.name;
  return it.lift === 0 && it.name !== "" ? it.name : null;
}

// The alias names an item's own expression (the receiver, for a block) mentions
// as bare identifiers, excluding its own name (the row field).
function aliasRefs(it: SelectItem, index: ReadonlyMap<string, number>): string[] {
  const own = aliasName(it);
  const out: string[] = [];
  const visit = (e: Expr): void => {
    mapExpr(e, (x) => {
      if (x.kind === "ident" && x.name !== own && index.has(x.name) && !out.includes(x.name)) out.push(x.name);
      return null;
    });
  };
  visit(it.kind === "collect" ? it.op.receiver : it.expr);
  return out;
}

/** Resolve one body's `select` items left to right (this body only; each item's
 * nested blocks are resolved against their own select). An item's bare
 * identifier that names an item to its left is replaced by that item's resolved
 * value — a block alias inlines as a value-position directive — and the item's
 * own name is the row field. A reference to an item to its right fails: as a
 * cycle when that item refers back, else as a forward reference. Exported for
 * the parser's validation pass. */
export function resolveSelect(select: readonly SelectItem[], fail: Fail = failPlain): SelectItem[] {
  const index = new Map<string, number>();
  select.forEach((it, i) => { const n = aliasName(it); if (n !== null) index.set(n, i); });
  if (index.size === 0) {
    return mapSame(select as SelectItem[], (it) => resolveItemBlocks(it, fail));
  }
  const resolved = new Map<string, Expr>();
  let out: SelectItem[] | null = null;
  for (let i = 0; i < select.length; i++) {
    const it = select[i]!;
    const own = aliasName(it);
    const subst = (e: Expr): Expr => mapExpr(e, (x) => {
      if (x.kind !== "ident") return null;
      if (x.name === own) return x;
      const r = resolved.get(x.name);
      if (r) return r;
      const j = index.get(x.name);
      if (j === undefined || j <= i) return null;
      const back = own === null ? null : cyclePath(select, index, j, own);
      if (back) fail(`select aliases form a cycle: ${[own, ...back].join(" → ")} — an alias cannot depend on itself`);
      fail(`select alias '${x.name}' is used before it is defined — a select item may reference only the items to its left`);
    });
    let r: SelectItem;
    if (it.kind === "collect") {
      const receiver = subst(it.op.receiver);
      const op = resolveOp(receiver === it.op.receiver ? it.op : { ...it.op, receiver }, fail);
      r = op === it.op ? it : { ...it, op };
      if (own !== null) resolved.set(own, op);
    } else {
      const expr = resolveExpr(subst(it.expr), fail);
      r = expr === it.expr ? it : expr.kind === "op"
        ? { kind: "collect", span: it.span, name: it.name, op: expr }
        : { ...it, expr };
      if (own !== null) resolved.set(own, expr);
    }
    if (r !== it) { out ??= select.slice(); out[i] = r; }
  }
  return out ?? (select as SelectItem[]);
}

// The nested blocks of an item, resolved against their own select.
function resolveItemBlocks(it: SelectItem, fail: Fail): SelectItem {
  if (it.kind === "collect") {
    const op = resolveOp(it.op, fail);
    return op === it.op ? it : { ...it, op };
  }
  const expr = resolveExpr(it.expr, fail);
  return expr === it.expr ? it : { ...it, expr };
}

// The alias path from item `from` back to the alias `to`, if the raw reference
// graph has one (`[b, a]` for `a: b, b: a` from `b` back to `a`).
function cyclePath(select: readonly SelectItem[], index: ReadonlyMap<string, number>, from: number, to: string): string[] | null {
  const seen = new Set<number>();
  const go = (i: number, path: string[]): string[] | null => {
    if (seen.has(i)) return null;
    seen.add(i);
    const it = select[i]!;
    const name = aliasName(it)!;
    for (const ref of aliasRefs(it, index)) {
      if (ref === to) return [...path, name, to];
      const hit = go(index.get(ref)!, [...path, name]);
      if (hit) return hit;
    }
    return null;
  };
  return go(from, []);
}

/** Resolve one body's `where` against its `select` (this body only; nested
 * blocks are left as they are). Exported for the parser's validation pass. */
export function resolveWhere(select: readonly SelectItem[], where: Where, fail: Fail = failPlain): Where {
  if (select.length === 0) return where;
  const aliases = new Map<string, SelectItem>();
  for (const it of select) {
    const n = aliasName(it);
    if (n !== null) aliases.set(n, it);
  }
  if (aliases.size === 0) return where;
  const resolving: string[] = [];
  const subst = (e: Expr): Expr => mapExpr(e, (x) => {
    if (x.kind !== "ident") return null;
    const a = aliases.get(x.name);
    if (!a) return null;
    if (resolving[resolving.length - 1] === x.name) return x; // its own name inside its own expression: the row field
    if (resolving.includes(x.name)) {
      const cycle = [...resolving.slice(resolving.indexOf(x.name)), x.name].join(" → ");
      fail(`select aliases form a cycle: ${cycle} — an alias used in \`where\` cannot depend on itself`);
    }
    if (a.kind === "collect") {
      fail(`select alias '${x.name}' is a ${a.op.op} { … } block — in \`where\` it can only stand alone as a non-empty test, not inside an expression`);
    }
    resolving.push(x.name);
    const out = subst(a.expr);
    resolving.pop();
    return out;
  });
  const walk = (w: Where): Where => {
    switch (w.kind) {
      case "and": case "or": { const parts = mapSame(w.parts, walk); return parts === w.parts ? w : { ...w, parts }; }
      case "not": { const expr = walk(w.expr); return expr === w.expr ? w : { ...w, expr }; }
      case "scalar": {
        if (w.expr.kind === "ident") {
          const a = aliases.get(w.expr.name);
          if (a?.kind === "collect") return a.op; // a collection in predicate position: non-empty
        }
        const expr = subst(w.expr);
        return expr === w.expr ? w : { ...w, expr };
      }
      case "op": { // the receiver is read in this scope; the block is its own scope
        const receiver = subst(w.receiver);
        return receiver === w.receiver ? w : { ...w, receiver };
      }
    }
  };
  return walk(where);
}

// `map` that returns the input array itself when no element changed.
function mapSame<T>(xs: readonly T[], f: (x: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < xs.length; i++) {
    const y = f(xs[i]!);
    if (y !== xs[i]) {
      out ??= xs.slice();
      out[i] = y;
    }
  }
  return out ?? (xs as T[]);
}
