// OQX Query IR (slice 2). OQX owns query STRUCTURE (from/where/select, the
// where-clause boolean tree, and receiver-constrained collection ops); scalar
// predicate interiors are captured verbatim and lowered by the existing CEL
// layer (search/cel). See docs plan: OQX → IR + scalar-expression AST → SQL.

import type { Target } from "../search/cel/compile.js";

/** CEL target = SQL row domain. OQX surface names (docs/blocks/nodes) map here. */
export type CelTarget = Target; // "docs" | "blocks" | "nodes"

/** Relational operators usable in a `count(...) <op> <int>` comparison. */
export type CountRelOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** A scalar boolean/value predicate: raw CEL source, compiled against a target. */
export interface ScalarPredicate {
  kind: "scalar";
  /** verbatim CEL source captured by the OQX parser; never re-serialized. */
  source: string;
  /** the CEL target the source compiles against = the enclosing scope's row type. */
  target: CelTarget;
}

/** How a receiver relation correlates a nested scope to the current outer row.
 * `correlate(outer, inner)` builds the join predicate given the SQL aliases the
 * compiler assigned to the outer (enclosing) and inner (nested) scopes. Slice-1
 * relations are single equijoins (`inner.doc_id = outer.doc_id`); section
 * relations use ordinal-range containment. */
export interface Relation {
  /** canonical relation name, e.g. "doc.nodes", "section.blocks". */
  name: string;
  /** row type produced by walking this relation. */
  childTarget: CelTarget;
  /** build the correlation predicate for the assigned outer/inner aliases. */
  correlate: (outer: string, inner: string) => string;
  /** child row always shares the outer row's document (see relations.ts). */
  sameDoc: boolean;
}

export type CollectionKind = "collect" | "exists" | "count";

/** A receiver-constrained nested operation over a structural relation. In
 * where-position a bare op (or `exists`) means "non-empty"; `count` may carry a
 * comparison (`nodes.count(...) >= 2`). In select-position only `collect`. */
export interface CollectionOp {
  kind: "collectionOp";
  op: CollectionKind;
  relation: Relation;
  subquery: NestedQuery;
  /** where-position `count(...) <op> <int>`; absent = truthiness (non-empty). */
  countCmp?: { op: CountRelOp; value: number };
}

/** A nested query: an optional where + (for collect) a projection. Its row type
 * is fixed by the receiver relation's childTarget. */
export interface NestedQuery {
  target: CelTarget;
  where: WhereExpr | null;
  select: SelectItem[];
}

/** The where clause is a boolean tree whose leaves are scalar predicates or
 * collection ops. OQX owns &&/||/!/grouping so that ops (which CEL cannot see)
 * can be composed with scalar predicates; maximal pure-scalar runs are still
 * handed to CEL verbatim as leaves. */
export type WhereExpr =
  | { kind: "and"; parts: WhereExpr[] }
  | { kind: "or"; parts: WhereExpr[] }
  | { kind: "not"; expr: WhereExpr }
  | ScalarPredicate
  | CollectionOp;

/** Projection item: a named scalar value, or a named nested collection. A
 * `lift` field item (`^name: expr`) inside a where-position `collect` binds
 * `name` in the enclosing (parent) scope, one scope out — the collect both
 * filters (non-empty) and captures the per-row `expr` as a collection. */
export type SelectItem =
  | { kind: "field"; name: string; source: string; lift?: boolean }
  | { kind: "collect"; name: string; op: CollectionOp };

/** Top-level OQX query. */
export interface Query {
  kind: "query";
  target: CelTarget;
  where: WhereExpr | null;
  select: SelectItem[];
}
