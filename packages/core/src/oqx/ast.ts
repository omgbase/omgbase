// OQX surface AST — produced by parser.ts, lowered to ir.ts by lower.ts. Scalar
// interiors are held as raw source strings; navigation expressions (source
// projections, consumer receivers, follow receivers) are captured as raw dotted
// tokens and resolved to structural relations against the enclosing scope.
//
// Two design-kernel rules shape the AST (see the OQX syntax-refresh note):
//   1. Dot navigation belongs to the host object model — a receiver/source is a
//      dotted identifier chain, captured verbatim as a string.
//   2. Whitespace query directives (collect/exists/count/first/single) belong to
//      OQX — a consumer is `<navExpr> <directive> { <block> }`, never a method.

import type { CountRelOp, OqxConsumer, OrderSpec } from "./ir.js";

/** A raw scalar predicate substring (valid CEL), captured verbatim. */
export interface SurfaceScalar {
  kind: "scalar";
  source: string;
}

/** A query consumer applied as a postfix directive to a navigation receiver:
 * `<receiver> <op> { <block> }`, optionally followed by a `<op> <int>`
 * comparison (count only, in where position). */
export interface SurfaceOp {
  kind: "op";
  receiver: string; // navExpr: "nodes" | "section.blocks" | "repo.docs" | ...
  op: "collect" | "exists" | "count" | "first" | "single";
  sub: SurfaceSubquery;
  /** `count { … } <op> <int>` in where position. */
  countCmp?: { op: CountRelOp; value: number };
}

/** The where clause boolean tree: leaves are scalar runs or consumer ops,
 * combined by &&/||/! and grouping which OQX owns at this layer. */
export type SurfaceWhere =
  | { kind: "and"; parts: SurfaceWhere[] }
  | { kind: "or"; parts: SurfaceWhere[] }
  | { kind: "not"; expr: SurfaceWhere }
  | SurfaceScalar
  | SurfaceOp;

/** Body of a consumer block: an optional leading `from` source-projection chain
 * (each entry re-projects the current rows through a relation), an optional
 * where, and (for collect) a projection. The block's initial row type is the
 * receiver relation's childTarget; each `from` re-projects it. */
export interface SurfaceSubquery {
  /** `from E` source projections within the block, in order (usually empty). */
  from: string[];
  where: SurfaceWhere | null;
  select: SurfaceSelectItem[];
  /** a nested `follow …` — makes a select-position collect recursive. */
  follow?: SurfaceFollow;
}

export type SurfaceSelectItem =
  | { kind: "field"; name: string; source: string; lift?: boolean }
  | { kind: "collect"; name: string; op: SurfaceOp };

/** The `follow [distinct] <receiver> [{ [where …] [frontier …] [depth n] [by …] }]`
 * clause that makes a query recursive. The receiver is a raw dotted token
 * resolved to a structural relation; the where/frontier/by interiors are raw
 * scalar source (valid CEL), captured verbatim. */
export interface SurfaceFollow {
  /** `follow distinct …` — dedup reached rows by identity (default: per-path). */
  distinct: boolean;
  receiver: string;
  /** follow-local successor predicate: shapes which successors participate. */
  where: string | null;
  /** explicit boundary predicate: cuts a relation that could otherwise continue. */
  frontier: string | null;
  /** `depth <n>` cap (1..8); null = the hard cap. */
  depth: number | null;
  /** `by <expr>` — the identity expression for cycle detection + `distinct`
   * dedup (default: the entity id). A field/intrinsic scalar. */
  by: string | null;
}

export interface SurfaceQuery {
  /** the top-level source chain: `from E` navExprs in order (bare form), OR the
   * consumer receiver followed by any body `from`s (consumer form). The first
   * entry selects the root collection (docs|blocks|nodes / repo.<target>); any
   * further entries re-project it. Never empty. */
  from: string[];
  where: SurfaceWhere | null;
  select: SurfaceSelectItem[];
  /** the top-level consumer shaping the whole result; `collect` for the bare
   * `from …` form, otherwise the directive in the `<receiver> <op> { … }` form. */
  consumer: OqxConsumer;
  /** `order by <expr> [asc|desc], …`, captured verbatim (asc/desc stripped). */
  orderBy?: OrderSpec[];
  /** `follow …` — present iff the query is recursive. */
  follow?: SurfaceFollow;
}
