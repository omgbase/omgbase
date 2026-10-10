// Builders for AST nodes a tool constructs itself (spec/oqx/AST.md §7). Every
// node they make carries the empty span `[0, 0]` — "not from source" — and the
// materialized defaults (`distinct: false`, `limit: null`, …), so a hand-built
// tree has the same shape as a parsed one and prints with `print`.

import type {
  BinaryOp, Consumer, CountCmp, Expr, Follow, FollowDestination, LogicalOp, OpNode, OrderSpec, Query, SelectItem, Span,
  Subquery, UnaryOp, Where,
} from "./ast.ts";

/** A fresh empty span (never shared: spans are mutable tuples). */
export const span = (): Span => [0, 0];

export const lit = (value: string | number | boolean | null): Expr => ({ kind: "lit", span: span(), value });
export const ident = (name: string): Expr => ({ kind: "ident", span: span(), name });
export const outer = (levels: number, name: string): Expr => ({ kind: "outer", span: span(), levels, name });
export const binding = (index: number): Expr => ({ kind: "binding", span: span(), index });
export const member = (recv: Expr, name: string): Expr => ({ kind: "member", span: span(), recv, name });
/** `a.b.c` from a dotted path. */
export const path = (first: string, ...rest: string[]): Expr => rest.reduce<Expr>((e, n) => member(e, n), ident(first));
export const call = (recv: Expr | null, name: string, args: Expr[] = []): Expr => ({ kind: "call", span: span(), recv, name, args });
export const unary = (op: UnaryOp, expr: Expr): Expr => ({ kind: "unary", span: span(), op, expr });
export const binary = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: "binary", span: span(), op, left, right });
export const logical = (op: LogicalOp, left: Expr, right: Expr): Expr => ({ kind: "logical", span: span(), op, left, right });
export const inOp = (left: Expr, right: Expr): Expr => ({ kind: "in", span: span(), left, right });
export const range = (lo: Expr | null, hi: Expr | null, exclusiveEnd = false): Expr => ({ kind: "range", span: span(), lo, hi, exclusiveEnd });

export const scalar = (expr: Expr): Where => ({ kind: "scalar", span: span(), expr });
export const and = (parts: Where[]): Where => ({ kind: "and", span: span(), parts });
export const or = (parts: Where[]): Where => ({ kind: "or", span: span(), parts });
export const not = (expr: Where): Where => ({ kind: "not", span: span(), expr });

export const field = (name: string, expr: Expr, lift = 0): SelectItem => ({ kind: "field", span: span(), name, expr, lift });
export const collect = (name: string, op: OpNode): SelectItem => ({ kind: "collect", span: span(), name, op });
export const order = (expr: Expr, desc = false): OrderSpec => ({ kind: "order", span: span(), expr, desc });

/** A block body; every clause defaults to empty/absent. */
export function subquery(parts: Partial<Omit<Subquery, "kind" | "span">> = {}): Subquery {
  return {
    kind: "subquery", span: span(),
    from: [], where: null, select: [], orderBy: null, follow: null, values: false, limit: null, offset: null,
    ...parts,
  };
}

/** `<receiver> <op> [distinct] { sub } [<relop> N]`. */
export function op(
  receiver: Expr, consumer: Consumer, sub: Subquery = subquery(),
  opts: { distinct?: boolean; countCmp?: CountCmp | null } = {},
): OpNode {
  return { kind: "op", span: span(), receiver, op: consumer, sub, countCmp: opts.countCmp ?? null, distinct: opts.distinct ?? false };
}

export function follow(
  destinations: FollowDestination[],
  opts: Partial<Omit<Follow, "kind" | "span" | "destinations">> = {},
): Follow {
  return { kind: "follow", span: span(), destinations, distinct: false, where: null, frontier: null, depth: null, by: null, ...opts };
}

/** A top-level query over `source`; every other clause defaults to empty/absent
 * and the consumer to `collect`. */
export function query(source: Expr, parts: Partial<Omit<Query, "kind" | "span" | "source">> = {}): Query {
  return {
    kind: "query", span: span(), source,
    from: [], where: null, select: [], orderBy: null, consumer: "collect", follow: null,
    distinct: false, values: false, limit: null, offset: null,
    ...parts,
  };
}
