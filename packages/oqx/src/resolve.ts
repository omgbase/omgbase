// Select-alias resolution (SEMANTICS §14). `where` may reference the same body's
// `select` aliases; the parser keeps the surface form (so the tree can be
// printed back and reflected on) and only VALIDATES the references, and this
// module performs the substitution — a pure rewrite the entry points (`run`,
// `execute`, `oqx`, `runQuery`) apply once before evaluation, so the engine and
// any pushdown planner see an ordinary `where` over row fields. Rules:
//   • an alias shadows a same-named row field inside `where`;
//   • an alias's own name inside its own expression is the row field
//     (`name: name.upper()` is not recursive), but a chain of aliases that
//     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//   • an alias whose value is a `collect`/`first`/`single { … }` block may
//     stand alone as a where leaf (a collection in predicate position means
//     non-empty) but not appear inside an expression;
//   • nested blocks (consumer bodies, follow blocks) are their own scopes and
//     are not rewritten against this body's select — each body rewrites
//     against its own.
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

/** Resolve every `where` of a query (its own and every nested block's) against
 * the `select` of the same body. Pure: returns a new tree sharing every node
 * the rewrite did not touch. Throws an `OqxError` (stage `parse`) for an alias
 * cycle or a block alias used inside an expression — the same conditions the
 * parser rejects, so a parsed query never throws here. */
export function resolveAliases<T extends Query | Subquery>(node: T): T {
  return resolveBody(node, failPlain);
}

function resolveBody<T extends Query | Subquery>(node: T, fail: Fail): T {
  const where = node.where === null ? null : resolveWhere(node.select, node.where, fail);
  const where2 = where === null ? null : resolveNestedWhere(where, fail);
  const select = mapSame(node.select, (it) => resolveItem(it, fail));
  const follow = node.follow === null ? null : resolveFollow(node.follow, fail);
  if (where2 === node.where && select === node.select && follow === node.follow) return node;
  return { ...node, where: where2, select, follow };
}

function resolveItem(it: SelectItem, fail: Fail): SelectItem {
  if (it.kind !== "collect") return it;
  const op = resolveOp(it.op, fail);
  return op === it.op ? it : { ...it, op };
}

function resolveOp(op: OpNode, fail: Fail): OpNode {
  const sub = resolveBody(op.sub, fail);
  return sub === op.sub ? op : { ...op, sub };
}

function resolveFollow(f: Follow, fail: Fail): Follow {
  const destinations = mapSame(f.destinations, (d: FollowDestination) => (d.kind === "op" ? resolveOp(d, fail) : d));
  return destinations === f.destinations ? f : { ...f, destinations };
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select.
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
    case "scalar": return w;
    case "op": return resolveOp(w, fail);
  }
}

/** Resolve one body's `where` against its `select` (this body only; nested
 * blocks are left as they are). Exported for the parser's validation pass. */
export function resolveWhere(select: readonly SelectItem[], where: Where, fail: Fail = failPlain): Where {
  if (select.length === 0) return where;
  const aliases = new Map<string, SelectItem>();
  for (const it of select) {
    if (it.kind === "collect") aliases.set(it.name, it);
    else if (it.lift === 0 && it.name !== "") aliases.set(it.name, it);
  }
  if (aliases.size === 0) return where;
  const resolving: string[] = [];
  const subst = (e: Expr): Expr => {
    switch (e.kind) {
      case "ident": {
        const a = aliases.get(e.name);
        if (!a) return e;
        if (resolving[resolving.length - 1] === e.name) return e; // its own name inside its own expression: the row field
        if (resolving.includes(e.name)) {
          const cycle = [...resolving.slice(resolving.indexOf(e.name)), e.name].join(" → ");
          fail(`select aliases form a cycle: ${cycle} — an alias used in \`where\` cannot depend on itself`);
        }
        if (a.kind === "collect") {
          fail(`select alias '${e.name}' is a ${a.op.op} { … } block — in \`where\` it can only stand alone as a non-empty test, not inside an expression`);
        }
        resolving.push(e.name);
        const out = subst(a.expr);
        resolving.pop();
        return out;
      }
      case "member": { const recv = subst(e.recv); return recv === e.recv ? e : { ...e, recv }; }
      case "call": {
        const recv = e.recv ? subst(e.recv) : null;
        const args = mapSame(e.args, subst);
        return recv === e.recv && args === e.args ? e : { ...e, recv, args };
      }
      case "unary": { const expr = subst(e.expr); return expr === e.expr ? e : { ...e, expr }; }
      case "binary": case "logical": case "in": {
        const left = subst(e.left);
        const right = subst(e.right);
        return left === e.left && right === e.right ? e : { ...e, left, right };
      }
      case "range": {
        const lo = e.lo ? subst(e.lo) : null;
        const hi = e.hi ? subst(e.hi) : null;
        return lo === e.lo && hi === e.hi ? e : { ...e, lo, hi };
      }
      default: return e; // lit, binding, outer (`^name` reads an enclosing row, never an alias)
    }
  };
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
function mapSame<T>(xs: T[], f: (x: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < xs.length; i++) {
    const y = f(xs[i]!);
    if (y !== xs[i]) {
      out ??= xs.slice();
      out[i] = y;
    }
  }
  return out ?? xs;
}
