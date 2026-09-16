// OQX query AST for the generic kernel. The parser produces this directly and
// the interpreter walks it — there is no separate lowering/IR pass, because a
// "relation" in the generic kernel is just an expression evaluated against the
// current row (property navigation on the host object model), resolved at run
// time rather than against a fixed schema.

/** Query consumers — how a (sub)query's row set is shaped. */
export type Consumer = "collect" | "exists" | "count" | "first" | "single";

/** Comparison operators usable in a `count { … } <op> <int>` test. */
export type RelOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** Scalar value/predicate expression, evaluated against a row scope + bindings. */
export type Expr =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "ident"; name: string } // bare property of the current row (climbs scopes)
  | { kind: "outer"; levels: number; name: string } // `^name` — read `levels` scopes out
  | { kind: "binding"; index: number } // a ${…} interpolated host value
  | { kind: "member"; recv: Expr; name: string } // .prop navigation (no climb)
  | { kind: "index"; recv: Expr; index: Expr } // [expr] navigation
  | { kind: "call"; recv: Expr | null; name: string; args: Expr[] } // fn / method
  | { kind: "unary"; op: "!" | "-"; expr: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr } // arithmetic + comparison
  | { kind: "logical"; op: "&&" | "||"; left: Expr; right: Expr }
  | { kind: "in"; left: Expr; right: Expr };

export interface OrderSpec {
  expr: Expr;
  desc: boolean;
}

/** One projection item: a named scalar/navigation value, or a named nested
 * collection consumer. `lift` marks a `^name` one-scope lift. */
export type SelectItem =
  // `lift` is the number of `^` carets: 0 = an ordinary projection, N = a lift
  // that binds this value N scopes out (see the engine's flatten-append).
  | { kind: "field"; name: string; expr: Expr; lift: number }
  | { kind: "collect"; name: string; op: OpNode };

/** A postfix consumer directive over a receiver collection:
 * `<receiver> <op> { <sub> }`, optionally `count { … } <relop> <int>`. */
export interface OpNode {
  kind: "op";
  receiver: Expr;
  op: Consumer;
  sub: Subquery;
  countCmp?: { op: RelOp; value: number };
  /** `distinct` — dedup the rows this directive consumes by their projected
   * value (the `select`), so `count distinct { … }` counts distinct projections
   * and `collect distinct { … }` yields distinct rows. Empty select ⇒ dedup by
   * row identity. Spellable as `<op> distinct { … }` or `{ select distinct … }`. */
  distinct?: boolean;
}

/** The recursive `follow` clause. */
export interface Follow {
  receiver: Expr; // the type-preserving successor relation (a nav expression)
  distinct: boolean;
  where: Expr | null; // successor predicate: which successors keep participating
  frontier: Expr | null; // boundary predicate: cut a relation that could continue
  depth: number | null; // 1..8 cap; null = the hard cap
  by: Expr | null; // identity expression for cycle detection / dedup
}

/** A nested (sub)query body. */
export interface Subquery {
  from: Expr[]; // body-level `from E` re-projections (flatMap chain)
  where: Where | null;
  select: SelectItem[];
  orderBy: OrderSpec[] | null;
  follow: Follow | null;
}

/** The where-clause boolean tree: OQX owns &&/||/!/grouping so consumer ops
 * (invisible to the scalar evaluator) compose with scalar predicates. */
export type Where =
  | { kind: "and"; parts: Where[] }
  | { kind: "or"; parts: Where[] }
  | { kind: "not"; expr: Where }
  | { kind: "scalar"; expr: Expr }
  | OpNode;

/** A top-level OQX query. */
export interface Query {
  source: Expr; // the root collection (`from <source>` or the directive receiver)
  from: Expr[]; // further top-level `from E` re-projections
  where: Where | null;
  select: SelectItem[];
  orderBy: OrderSpec[] | null;
  consumer: Consumer;
  follow: Follow | null;
  /** `distinct` — dedup the result rows by their projected value (see OpNode). */
  distinct?: boolean;
}
