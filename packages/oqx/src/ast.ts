// The OQX AST — a first-class, language-level contract (spec/oqx/AST.md, since
// language 0.16). The parser produces it, the interpreter walks it, and tools
// reflect on it without re-parsing: every node carries `kind` and `span`, every
// optional field is materialized (`null` / `false`), and the in-memory objects
// ARE the JSON shape both implementations serialize (plain data, no parent
// pointers, no methods). There is no separate lowering/IR pass: a "relation" is
// just an expression evaluated against the current row.
//
// `where` keeps its surface form: a `select` alias referenced in `where` stays a
// bare identifier here; `resolveAliases` (resolve.ts) performs the substitution
// before evaluation. Nodes built by a tool rather than the parser carry the
// empty span `[0, 0]` (see `build.ts`).

/** A half-open source range `[start, end)` in Unicode code points over the raw
 * source (`rawSource` for a template, where a binding occupies its `${n}`
 * marker). The empty span `[0, 0]` marks a node that did not come from source. */
export type Span = [start: number, end: number];

/** Query consumers — how a (sub)query's row set is shaped. `none` is the
 * zero-cardinality complement of `exists` (true iff the block yields no rows). */
export type Consumer = "collect" | "exists" | "none" | "count" | "first" | "single";

/** Comparison operators usable in a `count { … } <op> <int>` test. */
export type RelOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** The identity operators (SEMANTICS §5b, since 0.17). */
export type IdentityOp = "is" | "is not";

/** The operator of a `binary` expression: a comparison, an identity test, or arithmetic. */
export type BinaryOp = RelOp | IdentityOp | "+" | "-" | "*" | "/" | "%";

/** The operator of a `unary` expression. */
export type UnaryOp = "!" | "-";

/** The operator of a `logical` expression. */
export type LogicalOp = "&&" | "||";

/** Scalar value/predicate expression, evaluated against a row scope + bindings. */
export type Expr =
  | { kind: "lit"; span: Span; value: string | number | boolean | null }
  | { kind: "ident"; span: Span; name: string } // bare property of the CURRENT row/scope only (never climbs); `$it` is the row itself
  | { kind: "outer"; span: Span; levels: number; name: string } // `^name` — read from exactly `levels` scopes out (also what `N^name` parses to, since 0.18)
  | { kind: "binding"; span: Span; index: number } // a ${…} interpolated host value
  | { kind: "member"; span: Span; recv: Expr; name: string } // .prop navigation on the value to its left
  | { kind: "call"; span: Span; recv: Expr | null; name: string; args: Expr[] } // fn / method
  | { kind: "unary"; span: Span; op: UnaryOp; expr: Expr }
  // `x!` — the value of `expr`, or an eval error when it is absent (since 0.17).
  | { kind: "required"; span: Span; expr: Expr }
  | { kind: "binary"; span: Span; op: BinaryOp; left: Expr; right: Expr } // arithmetic + comparison + identity
  | { kind: "logical"; span: Span; op: LogicalOp; left: Expr; right: Expr }
  | { kind: "in"; span: Span; left: Expr; right: Expr }
  // A Ruby-style range value. `lo`/`hi` are null for the open-ended forms
  // (`..5` / `5..`); `exclusiveEnd` distinguishes `1...5` from `1..5`. Evaluates
  // to a runtime range value (see semantics.makeRange); primarily the RHS of `in`.
  | { kind: "range"; span: Span; lo: Expr | null; hi: Expr | null; exclusiveEnd: boolean }
  // A value-position directive (since 0.17): `recv first { … }.pay`, and what a
  // bracket lookup `x[…]` desugars to. `isExpr` is false for it — an op is an
  // expression only by position; discriminate on `kind === "op"`.
  | OpNode;

/** One `order by` term. */
export interface OrderSpec {
  kind: "order";
  span: Span;
  expr: Expr;
  desc: boolean;
}

/** One projection item: a named scalar/navigation value, or a named nested
 * collection consumer. `lift` marks a `^name` lift. */
export type SelectItem =
  // `lift` is the number of `^` carets: 0 = an ordinary projection, N = a lift
  // that binds this value N scopes out (see the engine's flatten-append). `name`
  // is `""` for an unaliased non-navigation item, which the parser only admits
  // under `values`.
  | { kind: "field"; span: Span; name: string; expr: Expr; lift: number }
  | { kind: "collect"; span: Span; name: string; op: OpNode };

/** The `count { … } <op> <int>` test attached to an `OpNode` — an attribute of
 * the directive, not a node of its own. */
export interface CountCmp {
  op: RelOp;
  value: number;
}

/** A postfix consumer directive over a receiver collection:
 * `<receiver> <op> { <sub> }`, optionally `count { … } <relop> <int>`. */
export interface OpNode {
  kind: "op";
  span: Span;
  receiver: Expr;
  op: Consumer;
  sub: Subquery;
  countCmp: CountCmp | null;
  /** `distinct` — dedup the rows this directive consumes by their projected
   * value (the `select`), so `count distinct { … }` counts distinct projections
   * and `collect distinct { … }` yields distinct rows. Empty select ⇒ dedup by
   * row identity. Spellable as `<op> distinct { … }` or `{ select distinct … }`. */
  distinct: boolean;
}

/** One `follow` destination: a relation of the current row (an `Expr` receiver), or a
 * destination block — a select-position directive (`collect`/`first`/`single`) re-evaluated
 * per frontier row, inside which `^` is that row. Discriminate on `kind === "op"`. */
export type FollowDestination = Expr | OpNode;

/** The recursive `follow` clause. */
export interface Follow {
  kind: "follow";
  span: Span;
  destinations: FollowDestination[]; // ≥ 1, in source order; the walk is their union
  distinct: boolean;
  where: Expr | null; // successor predicate: which successors keep participating
  frontier: Expr | null; // boundary predicate: cut a relation that could continue
  depth: number | null; // 1..8 cap; null = the hard cap
  by: Expr | null; // identity expression for cycle detection / dedup
}

/** A nested (sub)query body — the `{ … }` of a directive. */
export interface Subquery {
  kind: "subquery";
  span: Span;
  from: Expr[]; // body-level `from E` re-projections (flatMap chain)
  where: Where | null;
  select: SelectItem[];
  orderBy: OrderSpec[] | null;
  follow: Follow | null;
  /** `values` — scalar projection mode: the (single) projected expression is the
   * row's result itself rather than being wrapped in a `{ name: value }` record,
   * so `name values` yields `["Bob", …]` and `$it values` yields the rows. */
  values: boolean;
  /** `limit N` / `offset N` — bound the row set AFTER where/order/distinct and
   * BEFORE the consumer reduces it, so `count { … limit 5 }` is at most 5 and
   * `first { … offset 1 }` is the second row. Each is a value expression
   * (a literal, a `${…}` binding, or an outer reference) read as part of the
   * block — `^n` is the enclosing row's field, as everywhere inside `{ … }` —
   * and must yield a non-negative integer. */
  limit: Expr | null;
  offset: Expr | null;
}

/** The where-clause boolean tree: OQX owns &&/||/!/grouping so consumer ops
 * (invisible to the scalar evaluator) compose with scalar predicates. */
export type Where =
  | { kind: "and"; span: Span; parts: Where[] }
  | { kind: "or"; span: Span; parts: Where[] }
  | { kind: "not"; span: Span; expr: Where }
  | { kind: "scalar"; span: Span; expr: Expr }
  | OpNode;

/** A top-level OQX query. */
export interface Query {
  kind: "query";
  span: Span;
  source: Expr; // the root collection (`from <source>` or the directive receiver)
  from: Expr[]; // further top-level `from E` re-projections
  where: Where | null;
  select: SelectItem[];
  orderBy: OrderSpec[] | null;
  consumer: Consumer;
  follow: Follow | null;
  /** `distinct` — dedup the result rows by their projected value (see OpNode). */
  distinct: boolean;
  /** `values` — scalar projection mode (see Subquery). */
  values: boolean;
  /** `limit N` / `offset N` (see Subquery); evaluated at the root scope. */
  limit: Expr | null;
  offset: Expr | null;
}

/** Every node of the tree. `AstNode["kind"]` is the closed set of node kinds. */
export type AstNode = Query | Subquery | OpNode | Follow | OrderSpec | SelectItem | Where | Expr;

/** The closed set of node kinds. */
export type AstKind = AstNode["kind"];

/** The expression kinds (`Expr["kind"]`), for `isExpr`. */
const EXPR_KINDS: ReadonlySet<string> = new Set([
  "lit", "ident", "outer", "binding", "member", "call", "unary", "required", "binary", "logical", "in", "range",
]);

/** Whether a node is a scalar `Expr` (an `op` in expression position is not: it
 * is an expression only by position, see AST.md §1). */
export function isExpr(node: AstNode): node is Expr {
  return EXPR_KINDS.has(node.kind);
}

/** The parsed query's JSON form (`toJSON`): the tree with the language version
 * it was produced under. */
export type QueryJson = Query & { oqx: string };
