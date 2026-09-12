// OQX surface AST (slice 2) — produced by parser.ts, lowered to ir.ts by
// lower.ts. Scalar interiors are held as raw source strings; receivers as raw
// tokens (resolved to structural relations against the enclosing target).

import type { CountRelOp, OqxConsumer, OrderSpec } from "./ir.js";

export type SurfaceTarget = "docs" | "blocks" | "nodes";

/** A raw scalar predicate substring (valid CEL), captured verbatim. */
export interface SurfaceScalar {
  kind: "scalar";
  source: string;
}

/** A receiver-constrained collection op: `<receiver>.<op>( <subquery> )`,
 * optionally followed by a `<op> <int>` comparison (count only). */
export interface SurfaceOp {
  kind: "op";
  receiver: string; // "nodes" | "blocks" | "section" | "repo.docs" | ...
  op: "collect" | "exists" | "count" | "first" | "single";
  sub: SurfaceSubquery;
  /** `count(...) <op> <int>` in where position. */
  countCmp?: { op: CountRelOp; value: number };
}

/** The where clause boolean tree: leaves are scalar runs or collection ops,
 * combined by &&/||/! and grouping which OQX owns at this layer. */
export type SurfaceWhere =
  | { kind: "and"; parts: SurfaceWhere[] }
  | { kind: "or"; parts: SurfaceWhere[] }
  | { kind: "not"; expr: SurfaceWhere }
  | SurfaceScalar
  | SurfaceOp;

/** Body of a nested collection op: optional where + (for collect) projection.
 * Its row type is implied by the receiver relation, so no explicit `from`. */
export interface SurfaceSubquery {
  where: SurfaceWhere | null;
  select: SurfaceSelectItem[];
  /** a nested `follow …` — makes a select-position collect recursive (its `where`
   * seeds from the receiver relation, correlated to the current row; `follow`
   * then recurses). Only valid on a select-position `collect`. */
  follow?: SurfaceFollow;
}

export type SurfaceSelectItem =
  | { kind: "field"; name: string; source: string; lift?: boolean }
  | { kind: "collect"; name: string; op: SurfaceOp };

/** The `follow [distinct] <receiver> [where …] [frontier …] [depth n]` clause
 * that makes a query recursive. `where`/`frontier` interiors are raw scalar
 * source (valid CEL), captured verbatim like every other scalar; the receiver
 * is a raw token resolved to a structural relation against the query target. */
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
  from: SurfaceTarget;
  where: SurfaceWhere | null;
  select: SurfaceSelectItem[];
  /** an explicit top-level consumer wrapping the query (`repo.count(from …)`);
   * absent in the bare `from …` form, which lowers to the default `collect`. */
  consumer?: OqxConsumer;
  /** `order by <expr> [asc|desc], …`, captured verbatim (asc/desc stripped). */
  orderBy?: OrderSpec[];
  /** `follow …` — present iff the query is recursive. */
  follow?: SurfaceFollow;
}
