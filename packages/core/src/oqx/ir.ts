// OQX Query IR (slice 1). OQX owns query STRUCTURE (from/where/select + receiver-
// constrained collection ops); scalar predicate interiors are captured verbatim
// and lowered by the existing CEL layer (search/cel). See docs plan: OQX → IR +
// scalar-expression AST → SQL.

import type { Target } from "../search/cel/compile.js";

/** CEL target = SQL row domain. OQX surface names (docs/blocks/nodes) map here. */
export type CelTarget = Target; // "docs" | "blocks" | "nodes"

/** A scalar boolean/value predicate: raw CEL source, compiled against a target. */
export interface ScalarPredicate {
  kind: "scalar";
  /** verbatim CEL source captured by the OQX parser; never re-serialized. */
  source: string;
  /** the CEL target the source compiles against = the enclosing scope's row type. */
  target: CelTarget;
}

/** How a receiver relation correlates a nested scope to the current outer row. */
export interface Relation {
  /** canonical relation name, e.g. "doc.nodes". */
  name: string;
  /** row type produced by walking this relation. */
  childTarget: CelTarget;
  /** inner table + join columns for the correlated subquery. */
  innerCol: string; // column on the child row
  outerCol: string; // column on the outer row
  /** child row always shares the outer row's document (see relations.ts). */
  sameDoc: boolean;
}

export type CollectionKind = "collect" | "exists" | "count";

/** A receiver-constrained nested operation over a structural relation. */
export interface CollectionOp {
  kind: "collectionOp";
  op: CollectionKind;
  relation: Relation;
  subquery: NestedQuery;
}

/** A nested query: an optional where + (for collect) a projection. Its row type
 * is fixed by the receiver relation's childTarget. */
export interface NestedQuery {
  target: CelTarget;
  where: WhereTerm[];
  select: SelectItem[];
}

/** A where term is a scalar predicate OR a collection op (in where position a
 * collection op means "non-empty", per the narrow truthiness rule). */
export type WhereTerm = ScalarPredicate | CollectionOp;

/** Projection item: a named scalar value, or a named nested collection. */
export type SelectItem =
  | { kind: "field"; name: string; source: string }
  | { kind: "collect"; name: string; op: CollectionOp };

/** Top-level OQX query. */
export interface Query {
  kind: "query";
  target: CelTarget;
  where: WhereTerm[];
  select: SelectItem[];
}
