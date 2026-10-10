// Generic traversal over the AST (spec/oqx/AST.md §5): `visit` (enter/leave with
// a path, the enclosing clause and the scope depth), `transform` (rebuild a
// query with every expression mapped), `stripSpans`, `toJSON`. All three walks
// are driven by ONE child-key table per node kind — `CHILDREN` — so a future
// field is added in one place and every tool sees it.

import type { AstKind, AstNode, Expr, Query, QueryJson, Subquery } from "./ast.ts";
import { isExpr } from "./ast.ts";
import { LANGUAGE_VERSION } from "./version.ts";

/** The clause a node sits in, for `visit`/`transform` contexts. `source` is the
 * root collection (`from <source>` or the directive receiver); `from` the further
 * re-projections; `follow` the `Follow` node itself and `follow.*` its parts.
 * The root node has no clause (`null`). */
export type Clause =
  | "source" | "from" | "where" | "select" | "orderBy" | "limit" | "offset"
  | "follow" | "follow.destination" | "follow.where" | "follow.frontier" | "follow.by";

/** Where a visited node sits. `depth` is the scope depth at which the node is
 * evaluated (0 = the root scope: a top-level `source`, `limit`, `offset`; 1 =
 * a top-level row: its `where`, `select`, `order by`, `from` re-projections and
 * `follow`; a block's rows are one deeper than the block's receiver; a follow
 * `where` is one deeper than the frontier row it tests successors of). */
export interface VisitContext {
  /** The ancestors of the node, root first (empty for the root). */
  readonly path: readonly AstNode[];
  readonly clause: Clause | null;
  readonly depth: number;
}

export interface Visitor {
  /** Called before a node's children; return `false` to skip the subtree
   * (`leave` is still called for the node). */
  enter?(node: AstNode, ctx: VisitContext): boolean | void;
  /** Called after a node's children. */
  leave?(node: AstNode, ctx: VisitContext): void;
}

/** One child slot of a node kind: the property, the clause it opens (inherited
 * from the parent when absent) and how much deeper its scope is. */
export interface ChildKey {
  readonly key: string;
  readonly clause?: Clause;
  readonly depth?: number;
}

/** The child-key table: every node kind's children, in canonical source order.
 * A slot's value is a node, an array of nodes, or `null`. */
export const CHILDREN: { readonly [K in AstKind]: readonly ChildKey[] } = {
  query: [
    { key: "select", clause: "select", depth: 1 },
    { key: "source", clause: "source" },
    { key: "from", clause: "from", depth: 1 },
    { key: "where", clause: "where", depth: 1 },
    { key: "follow", clause: "follow", depth: 1 },
    { key: "orderBy", clause: "orderBy", depth: 1 },
    { key: "limit", clause: "limit" },
    { key: "offset", clause: "offset" },
  ],
  subquery: [
    { key: "select", clause: "select" },
    { key: "from", clause: "from" },
    { key: "where", clause: "where" },
    { key: "follow", clause: "follow" },
    { key: "orderBy", clause: "orderBy" },
    { key: "limit", clause: "limit" },
    { key: "offset", clause: "offset" },
  ],
  op: [{ key: "receiver" }, { key: "sub", depth: 1 }],
  follow: [
    { key: "destinations", clause: "follow.destination" },
    { key: "where", clause: "follow.where", depth: 1 },
    { key: "frontier", clause: "follow.frontier" },
    { key: "by", clause: "follow.by" },
  ],
  order: [{ key: "expr" }],
  field: [{ key: "expr" }],
  collect: [{ key: "op" }],
  and: [{ key: "parts" }],
  or: [{ key: "parts" }],
  not: [{ key: "expr" }],
  scalar: [{ key: "expr" }],
  lit: [],
  ident: [],
  outer: [],
  binding: [],
  member: [{ key: "recv" }],
  call: [{ key: "recv" }, { key: "args" }],
  unary: [{ key: "expr" }],
  binary: [{ key: "left" }, { key: "right" }],
  logical: [{ key: "left" }, { key: "right" }],
  in: [{ key: "left" }, { key: "right" }],
  range: [{ key: "lo" }, { key: "hi" }],
};

type Slot = AstNode | AstNode[] | null;

function slot(node: AstNode, key: string): Slot {
  return (node as unknown as Record<string, Slot>)[key] ?? null;
}

/** Walk a tree depth-first in canonical source order. */
export function visit(root: AstNode, visitor: Visitor): void {
  const path: AstNode[] = [];
  const go = (node: AstNode, clause: Clause | null, depth: number): void => {
    const ctx: VisitContext = { path: path.slice(), clause, depth };
    const descend = visitor.enter?.(node, ctx) !== false;
    if (descend) {
      path.push(node);
      for (const child of CHILDREN[node.kind]) {
        const v = slot(node, child.key);
        if (v === null) continue;
        const c = child.clause ?? clause;
        const d = depth + (child.depth ?? 0);
        if (Array.isArray(v)) for (const x of v) go(x, c, d);
        else go(v, c, d);
      }
      path.pop();
    }
    visitor.leave?.(node, ctx);
  };
  go(root, null, 0);
}

/** Rebuild a query (or block body) with every expression mapped through `f`,
 * children first (so `f` sees an expression whose operands are already mapped).
 * Nodes `f` returns unchanged, and every ancestor whose children did not change,
 * are kept by reference — spans and identity of untouched nodes survive. */
export function transform<T extends Query | Subquery>(root: T, f: (expr: Expr, ctx: VisitContext) => Expr): T {
  const path: AstNode[] = [];
  const go = (node: AstNode, clause: Clause | null, depth: number): AstNode => {
    const ctx: VisitContext = { path: path.slice(), clause, depth };
    path.push(node);
    let out: AstNode = node;
    for (const child of CHILDREN[node.kind]) {
      const v = slot(node, child.key);
      if (v === null) continue;
      const c = child.clause ?? clause;
      const d = depth + (child.depth ?? 0);
      let next: Slot;
      if (Array.isArray(v)) {
        let changed = false;
        const mapped = v.map((x) => { const y = go(x, c, d); if (y !== x) changed = true; return y; });
        next = changed ? mapped : v;
      } else next = go(v, c, d);
      if (next !== v) out = { ...out, [child.key]: next } as AstNode;
    }
    path.pop();
    return isExpr(out) ? f(out, ctx) : out;
  };
  return go(root, null, 0) as T;
}

/** The tree with every `span` removed, for shape comparisons (the fixtures and
 * the round-trip law compare stripped trees). A deep copy of plain data. */
export type Stripped<T> =
  T extends readonly (infer U)[] ? Stripped<U>[]
  : T extends object ? { [K in keyof T as K extends "span" ? never : K]: Stripped<T[K]> }
  : T;

export function stripSpans<T>(node: T): Stripped<T> {
  if (Array.isArray(node)) return node.map(stripSpans) as Stripped<T>;
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "span") continue;
      out[k] = stripSpans(v);
    }
    return out as Stripped<T>;
  }
  return node as Stripped<T>;
}

/** The query as the JSON document both implementations exchange: the tree
 * (already plain data) stamped with the language version it was produced under
 * (`{ "oqx": "0.16", "kind": "query", … }`). */
export function toJSON(query: Query): QueryJson {
  return { oqx: LANGUAGE_VERSION, ...query };
}
