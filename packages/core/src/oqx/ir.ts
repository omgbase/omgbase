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
  /** a root/global relation (`repo.docs`, `repo.nodes`, `repo.blocks`): an
   * UNBOUNDED scan of the whole repository, uncorrelated to the outer row —
   * correlation is expressed explicitly via `^name` outer references in its
   * where. Unlike structural relations it allocates its own document scope, so
   * `correlate` returns no predicate. */
  root?: boolean;
}

// `collect` returns an array; `exists`/`count` are where-position predicates;
// `first`/`single` are select-position zero-or-one / one-to-one lookups that
// return a single record (`single` errors if it matches more than one row).
export type CollectionKind = "collect" | "exists" | "count" | "first" | "single";

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
  /** a nested `follow` making a select-position collect recursive: `where` seeds
   * (via the receiver relation, correlated to the current row), `follow` recurses
   * over a type-preserving relation. Recursion intrinsics are queryable in the
   * collect's `select`. */
  follow?: FollowSpec;
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

/** A top-level query consumer: how the whole outer query's result is shaped.
 * The default (and, before this, only) consumer is `collect` — a hit
 * collection. `count`/`exists` reduce the query to a scalar; `first`/`single`
 * to zero-or-one row (`single` errors if the query matches more than one). They
 * are the SAME consuming operators used on nested collections, applied to the
 * repository at the top level (see the OQX design note; spelled `repo.<op>(…)`).
 * `all` is reserved but not implemented yet. */
export type OqxConsumer = "collect" | "count" | "exists" | "first" | "single";

/** One `order by` term: a scalar VALUE expression (raw CEL, compiled against the
 * query target — a frontmatter field, `$path`, `semantic("…")`, …) and a
 * direction. Ordering is what turns semantic()/bm25 scores into a ranking. */
export interface OrderSpec { source: string; desc: boolean }

/** The recursive `follow` clause (see the OQX traversal-semantics note). A query
 * with a `follow` is closed over its row type `T`: the query `where` selects the
 * SEED rows (level 1); `relation` (type-preserving, childTarget == target) yields
 * each row's successors; `successorWhere` shapes which successors keep
 * participating at every hop (running out → `$stop == "leaf"`); `frontier` cuts a
 * relation that could otherwise continue (→ `$stop == "frontier"`); `maxDepth`
 * bounds the walk (→ `$stop == "depth"`). `distinct` dedups reached rows by
 * identity (default keeps one occurrence per distinct walk path). */
export interface FollowSpec {
  relation: Relation;
  distinct: boolean;
  successorWhere: ScalarPredicate | null;
  frontier: ScalarPredicate | null;
  /** hard-capped at 8. */
  maxDepth: number;
  /** `by <expr>` — identity for cycle detection + `distinct` dedup (a param-free
   * field/intrinsic scalar); absent = the entity id. */
  by: ScalarPredicate | null;
}

/** Top-level OQX query. */
export interface Query {
  kind: "query";
  target: CelTarget;
  where: WhereExpr | null;
  select: SelectItem[];
  /** `order by <expr> [asc|desc], …` — applied to collect/first/single (ignored
   * by count/exists). A custom order disables keyset-cursor pagination. */
  orderBy?: OrderSpec[];
  /** how the outer result is consumed/shaped; defaults to `collect`. */
  consumer: OqxConsumer;
  /** `follow …` — present iff the query is recursive (a bounded WITH RECURSIVE). */
  follow?: FollowSpec;
  /** follow queries only: the top-level `where` conjuncts that reference
   * recursion intrinsics ($depth/$stop/$leaf/$frontier). They filter the walk's
   * RESULT post-walk (compiled against `walked`), separate from `where` (the
   * seed predicate). Absent for non-follow queries. */
  postWhere?: WhereExpr;
}
