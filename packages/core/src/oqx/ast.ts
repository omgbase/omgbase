// OQX surface AST (slice 2) — produced by parser.ts, lowered to ir.ts by
// lower.ts. Scalar interiors are held as raw source strings; receivers as raw
// tokens (resolved to structural relations against the enclosing target).

import type { CountRelOp, OqxConsumer } from "./ir.js";

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
}

export type SurfaceSelectItem =
  | { kind: "field"; name: string; source: string; lift?: boolean }
  | { kind: "collect"; name: string; op: SurfaceOp };

export interface SurfaceQuery {
  from: SurfaceTarget;
  where: SurfaceWhere | null;
  select: SurfaceSelectItem[];
  /** an explicit top-level consumer wrapping the query (`repo.count(from …)`);
   * absent in the bare `from …` form, which lowers to the default `collect`. */
  consumer?: OqxConsumer;
}
