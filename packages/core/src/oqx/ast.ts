// OQX surface AST (slice 1) — produced by parser.ts, lowered to ir.ts by
// lower.ts. Scalar interiors are held as raw source strings; receivers as raw
// tokens (resolved to structural relations against the enclosing target).

export type SurfaceTarget = "docs" | "blocks" | "nodes";

/** A raw scalar predicate substring (valid CEL), captured verbatim. */
export interface SurfaceScalar {
  kind: "scalar";
  source: string;
}

/** A receiver-constrained collection op: `<receiver>.<op>( <subquery> )`. */
export interface SurfaceOp {
  kind: "op";
  receiver: string; // "nodes" | "blocks" | ...
  op: "collect" | "exists" | "count";
  sub: SurfaceSubquery;
}

export type SurfaceTerm = SurfaceScalar | SurfaceOp;

/** Body of a nested collection op: optional where + (for collect) projection.
 * Its row type is implied by the receiver relation, so no explicit `from`. */
export interface SurfaceSubquery {
  where: SurfaceTerm[];
  select: SurfaceSelectItem[];
}

export type SurfaceSelectItem =
  | { kind: "field"; name: string; source: string }
  | { kind: "collect"; name: string; op: SurfaceOp };

export interface SurfaceQuery {
  from: SurfaceTarget;
  where: SurfaceTerm[];
  select: SurfaceSelectItem[];
}
